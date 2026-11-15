'use strict';
/** AVP-04: DittoAvatarEngine maps the avatar service protocol onto the AvatarEngine contract. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DittoAvatarEngine } = require('../../core/avatar/dittoEngine');
const { assertProvider } = require('../../core/providers/interfaces');

class FakeClient extends EventEmitter {
  constructor() { super(); this.sent = []; this.running = true; }
  send(cmd) { this.sent.push(cmd); return true; }
  request(cmd) { this.sent.push(cmd); return Promise.resolve({ renderFps: 27 }); }
  async start() { return { pid: 1, python: '3.10' }; }
  async stop() { this.running = false; }
}

const cfg = { avatar: { pythonPath: '', maxSize: 1024 }, audio: { outputDevice: 'Speakers', hostApi: 'auto' }, tts: { sampleRate: 48000 } };

function make() {
  const client = new FakeClient();
  const engine = new DittoAvatarEngine({ rootDir: process.cwd(), getConfig: () => cfg, client });
  return { client, engine };
}

test('fulfils the AvatarEngine contract', () => {
  const { engine } = make();
  assertProvider('AvatarEngine', engine);
  assert.equal(engine.info().engine, 'ditto');
});

test('speech is refused until the service animates a photo, then accepted', () => {
  const { client, engine } = make();
  assert.match(engine.speechBlocker(), /not ready/);
  client.emit('status', { component: 'avatar', state: 'ready', detail: 'No photo selected', info: { animating: false } });
  assert.match(engine.speechBlocker(), /no photo/);
  const states = [];
  engine.on('connected', () => states.push('connected'));
  client.emit('status', { component: 'avatar', state: 'ready', detail: '', info: { animating: true, streamUrl: 'http://127.0.0.1:5555/stream.mjpg' } });
  assert.equal(engine.speechBlocker(), null);
  assert.equal(engine.info().streamUrl, 'http://127.0.0.1:5555/stream.mjpg');
});

test('playSpeech / stopSpeech / setPhoto become service commands; WAV travels as base64', () => {
  const { client, engine } = make();
  const wav = Buffer.from([1, 2, 3, 4]);
  engine.playSpeech({ turnId: 't1', seq: 0, sampleRate: 48000, audioMs: 10, wav });
  engine.stopSpeech('t1', 'stop');
  engine.setPhoto('C:/photo.png');
  assert.deepEqual(client.sent[0], { cmd: 'play', turn_id: 't1', seq: 0, wav_b64: wav.toString('base64') });
  assert.deepEqual(client.sent[1], { cmd: 'stop', turn_id: 't1', reason: 'stop' });
  assert.deepEqual(client.sent[2], { cmd: 'set_photo', path: 'C:/photo.png' });
});

test('service events become speechStarted / speechEnded / level; an unexpected exit disconnects', () => {
  const { client, engine } = make();
  const got = [];
  for (const e of ['speechStarted', 'speechEnded', 'level', 'disconnected']) engine.on(e, (x) => got.push([e, x]));
  client.emit('speech_started', { turnId: 't1', seq: 0, tailMs: 30, delayMs: 1400 });
  client.emit('speech_ended', { turnId: 't1', seq: 0, reason: 'completed', playedMs: 2000, tailMs: 30 });
  client.emit('level', { level: 0.5 });
  client.emit('exit', { expected: false, detail: 'exit code 1' });
  assert.deepEqual(got.map((g) => g[0]), ['speechStarted', 'speechEnded', 'level', 'disconnected']);
  assert.equal(got[1][1].reason, 'completed');
  assert.equal(got[2][1], 0.5);
  assert.equal(engine.info().state, 'error');
});
