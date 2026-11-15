'use strict';
/**
 * Speech through the avatar engine (core/speech/speechOutput.js + core/avatar).
 * A fake engine stands in for the future photo-animation engine.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SpeechOutput } = require('../../core/speech/speechOutput');
const { NullAvatarEngine } = require('../../core/avatar/avatarEngine');
const { assertProvider } = require('../../core/providers/interfaces');

/** The voice-service TTS provider as SpeechOutput uses it. */
class FakeLocalTts extends EventEmitter {
  constructor() { super(); this.name = 'fake'; this.spoken = []; this.synthesized = []; this.ended = []; this.stops = 0; }
  speak(req) { this.spoken.push(req); return true; }
  synthesize(req) { this.synthesized.push(req); return true; }
  endTurn(turnId) { this.ended.push(turnId); return true; }
  stop() { this.stops += 1; return true; }
  canReturnAudio() { return true; }
}

class FakeEngine extends NullAvatarEngine {
  constructor() { super(); this.name = 'fake-engine'; this.played = []; this.stopped = []; this.mode = null; }
  speechBlocker() { return null; }
  setSpeechMode(on) { this.mode = on; return true; }
  playSpeech(chunk) { this.played.push(chunk); return true; }
  stopSpeech(turnId, reason) { this.stopped.push({ turnId, reason }); }
}

function setup({ output = 'avatar', engine = new FakeEngine() } = {}) {
  const local = new FakeLocalTts();
  const cfg = { tts: { output } };
  const speech = new SpeechOutput({ local, avatar: engine, getConfig: () => cfg });
  const events = [];
  for (const e of ['playbackStart', 'drained', 'failed']) speech.on(e, (x) => events.push({ e, ...x }));
  return { local, engine, speech, events, cfg };
}

const wav = Buffer.alloc(64);

test('the null engine satisfies the AvatarEngine contract and never takes speech', () => {
  const engine = assertProvider('AvatarEngine', new NullAvatarEngine());
  assert.equal(engine.info().state, 'not_configured');
  assert.match(engine.speechBlocker(), /no photo-animation engine/);
});

test('output avatar with the null engine: the answer is heard locally, as before', () => {
  const { local, speech } = setup({ engine: new NullAvatarEngine() });
  speech.speak({ turnId: 't1', seq: 0, text: 'Привет.' });
  assert.equal(local.spoken.length, 1);
  assert.equal(local.synthesized.length, 0);
  assert.equal(speech.info().effective, 'local');
  assert.match(speech.info().blocker, /no photo-animation engine/);
});

test('output avatar: chunks go to the engine; drained only after the engine reports the real end', async () => {
  const { local, engine, speech, events } = setup();
  speech.syncAudioMode();
  assert.equal(engine.mode, true);
  speech.speak({ turnId: 't1', seq: 0, text: 'Первое.' });
  speech.speak({ turnId: 't1', seq: 1, text: 'Второе.' });
  assert.equal(local.synthesized.length, 2, 'synthesized, not played locally');
  assert.equal(local.spoken.length, 0);
  for (const seq of [0, 1]) {
    local.emit('synthDone', { turnId: 't1', seq, audioMs: 500 });
    local.emit('audio', { turnId: 't1', seq, wav, sampleRate: 48000, audioMs: 500 });
  }
  assert.deepEqual(engine.played.map((c) => c.seq), [0, 1]);
  speech.endTurn('t1');
  engine.emit('speechStarted', { turnId: 't1', seq: 0, tailMs: 0 });
  assert.equal(events.find((x) => x.e === 'playbackStart').output, 'avatar');
  engine.emit('speechEnded', { turnId: 't1', seq: 0, reason: 'completed', playedMs: 500 });
  assert.equal(events.some((x) => x.e === 'drained'), false, 'the second chunk is still playing');
  engine.emit('speechStarted', { turnId: 't1', seq: 1 });
  engine.emit('speechEnded', { turnId: 't1', seq: 1, reason: 'completed', playedMs: 500, tailMs: 0 });
  await new Promise((r) => setTimeout(r, 5));
  const drained = events.find((x) => x.e === 'drained');
  assert.ok(drained, 'drained after the last chunk ended');
  assert.equal(drained.output, 'avatar');
  assert.equal(drained.chunks, 2);
});

test('Stop: the engine is told to stop the answer; late chunks are dropped', () => {
  const { local, engine, speech } = setup();
  speech.speak({ turnId: 't1', seq: 0, text: 'Первое.' });
  speech.stop();
  assert.deepEqual(engine.stopped, [{ turnId: 't1', reason: 'stop' }]);
  local.emit('audio', { turnId: 't1', seq: 0, wav, sampleRate: 48000, audioMs: 500 });
  assert.equal(engine.played.length, 0);
  assert.equal(speech.info().dropped, 1);
});

test('the engine failing a chunk ends the answer with an error', () => {
  const { local, engine, speech, events } = setup();
  speech.speak({ turnId: 't1', seq: 0, text: 'Первое.' });
  local.emit('audio', { turnId: 't1', seq: 0, wav, sampleRate: 48000, audioMs: 500 });
  engine.emit('speechEnded', { turnId: 't1', seq: 0, reason: 'failed', detail: 'renderer crashed' });
  const failed = events.find((x) => x.e === 'failed');
  assert.match(failed.message, /avatar engine could not play a speech chunk \(renderer crashed\)/);
  assert.equal(failed.reason, 'avatar_speech');
});
