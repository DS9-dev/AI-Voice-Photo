'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { VoiceServiceClient, normalizeEvent } = require('../../core/providers/voiceServiceClient');

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake_voice_service.js');

function makeClient(env = {}, extra = {}) {
  return new VoiceServiceClient({ command: process.execPath, args: [FAKE], env, helloTimeoutMs: 3000, ...extra });
}

function once(emitter, name, predicate = () => true, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeoutMs);
    const handler = (e) => { if (predicate(e)) { clearTimeout(timer); emitter.off(name, handler); resolve(e); } };
    emitter.on(name, handler);
  });
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('normalizeEvent shifts t_* timestamps and camel-cases keys', () => {
  const ev = normalizeEvent({ event: 'speech_end', utterance_id: 3, t_speech_end: 1000.5, speech_ms: 800, info: { output_latency_ms: 12 } }, 0.5);
  assert.deepEqual(ev, { event: 'speech_end', utteranceId: 3, tSpeechEnd: 1000, speechMs: 800, info: { outputLatencyMs: 12 } });
});

test('start: hello, clock sync, init, component statuses become ready', async () => {
  const client = makeClient();
  const sttReady = once(client, 'status', (s) => s.component === 'stt' && s.state === 'ready');
  const hello = await client.start({ stt: {}, tts: {} });
  try {
    assert.equal(hello.protocol, 1);
    assert.ok(hello.pid > 0);
    assert.ok(Number.isFinite(client.clockOffsetMs));
    assert.ok(client.clockRttMs >= 0 && client.clockRttMs < 1000);
    await sttReady;
    for (const c of ['mic', 'vad', 'stt', 'tts', 'output']) assert.equal(client.statuses[c].state, 'ready', c);
    assert.deepEqual(client.statuses.tts.info.voices, ['xenia', 'kseniya', 'baya', 'aidar', 'eugene']);
  } finally { await client.stop(); }
});

test('clock offset between the two processes is measured and removed', async () => {
  const client = makeClient({ FAKE_CLOCK_SKEW_MS: '5000' });
  await client.start({});
  try {
    assert.ok(Math.abs(client.clockOffsetMs - 5000) < 100, `offset ${client.clockOffsetMs}`);
    const listening = once(client, 'listening');
    client.send({ cmd: 'set_listening', enabled: true });
    const ev = await listening;
    const core = performance.timeOrigin + performance.now();
    assert.ok(Math.abs(ev.t - core) < 250, 'service timestamp was moved onto the core clock');
  } finally { await client.stop(); }
});

test('request/reply correlation and error replies', async () => {
  const client = makeClient();
  await client.start({});
  try {
    const devices = await client.request({ cmd: 'list_devices' });
    assert.equal(devices.inputs[0].name, 'Fake Microphone');
    assert.equal(devices.inputs[0].isDefault, true);
    await assert.rejects(client.request({ cmd: 'no_such_command' }), /unknown command/);
  } finally { await client.stop(); }
});

test('a failing component is reported without affecting the others', async () => {
  const client = makeClient({ FAKE_FAIL: 'stt' });
  const sttError = once(client, 'status', (s) => s.component === 'stt' && s.state === 'error');
  await client.start({});
  try {
    const s = await sttError;
    assert.match(s.detail, /fake stt failure/);
    assert.equal(client.statuses.tts.state, 'ready');
  } finally { await client.stop(); }
});

test('graceful stop leaves no child process behind', async () => {
  const client = makeClient();
  const hello = await client.start({});
  const exit = once(client, 'exit');
  await client.stop();
  const info = await exit;
  assert.equal(info.expected, true);
  assert.equal(client.running, false);
  assert.equal(isAlive(hello.pid), false);
  assert.equal(client.statuses.stt.state, 'stopped');
  assert.equal(client.send({ cmd: 'set_listening', enabled: true }), false);
});

test('unexpected exit turns every component status into an error', async () => {
  const client = makeClient();
  await client.start({});
  const exit = once(client, 'exit');
  const pending = client.request({ cmd: '_sim_crash' });
  const info = await exit;
  assert.equal(info.expected, false);
  await assert.rejects(pending, /exited/);
  for (const c of ['mic', 'vad', 'stt', 'tts', 'output']) {
    assert.equal(client.statuses[c].state, 'error');
    assert.match(client.statuses[c].detail, /exited unexpectedly/);
  }
});

test('missing executable is a visible error, not a crash', async () => {
  const client = new VoiceServiceClient({ command: path.join(__dirname, 'no-such-python.exe'), args: [], helloTimeoutMs: 2000 });
  await assert.rejects(client.start({}), /Cannot start voice service|exited during startup/);
  assert.equal(client.statuses.stt.state, 'error');
  assert.equal(client.running, false);
});

test('a service that never says hello times out and is stopped', async () => {
  const client = makeClient({ FAKE_NO_HELLO: '1' }, { helloTimeoutMs: 300 });
  await assert.rejects(client.start({}), /did not start within/);
  assert.equal(client.running, false);
  assert.match(client.statuses.mic.detail, /did not start within/);
});

test('protocol version mismatch is rejected', async () => {
  const client = makeClient({ FAKE_PROTOCOL: '99' });
  await assert.rejects(client.start({}), /protocol 99/);
  assert.equal(client.running, false);
});

test('the client can be restarted after a stop', async () => {
  const client = makeClient();
  const first = await client.start({});
  await client.stop();
  const second = await client.start({});
  try {
    assert.notEqual(first.pid, second.pid);
    assert.equal(client.running, true);
  } finally { await client.stop(); }
});
