'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TurnMetrics, MetricsStore, deriveIntervals, METRIC_DEFINITIONS, DERIVED_KEYS } = require('../../core/metrics/turnMetrics');
const { median, summarize, summarizeTurns } = require('../../core/metrics/stats');

const VOICE = {
  tSpeechStart: 1000, tSpeechEnd: 3000, tVadEndDetected: 3600, tSttFinal: 3750,
  tLlmRequest: 3755, tLlmFirstToken: 3955, tLlmFirstContent: 3955, tLlmDone: 4955,
  tTtsTextReady: 4300, tTtsFirstAudio: 4420, tPlaybackStart: 4450, tPlaybackEnd: 8000,
};

test('every derived interval is computed from the documented timestamps', () => {
  const d = deriveIntervals(VOICE, { llmCompletionTokens: 50, ttsSynthMs: 300 });
  assert.equal(d.speechDurationMs, 2000);
  assert.equal(d.vadEndDelayMs, 600);
  assert.equal(d.sttFinalizeMs, 150);
  assert.equal(d.speechEndToSttFinalMs, 750);
  assert.equal(d.llmTtftMs, 200);
  assert.equal(d.llmFirstContentMs, 200);
  assert.equal(d.sttFinalToLlmFirstTokenMs, 205);
  assert.equal(d.speechEndToLlmFirstTokenMs, 955);
  assert.equal(d.llmTotalMs, 1200);
  assert.equal(d.llmTokensPerSec, 50);          // 50 tokens over 1.0 s after the first token
  assert.equal(d.ttsFirstAudioMs, 120);
  assert.equal(d.ttsSynthTotalMs, 300);
  assert.equal(d.playbackStartDelayMs, 30);
  assert.equal(d.perceivedLatencyMs, 1450);     // speech end -> first audible audio
  assert.equal(d.turnDurationMs, 7000);         // speech start -> playback end
});

test('perceived latency is measured from speech end, not from STT completion', () => {
  const d = deriveIntervals(VOICE);
  assert.equal(d.perceivedLatencyMs, VOICE.tPlaybackStart - VOICE.tSpeechEnd);
  assert.notEqual(d.perceivedLatencyMs, VOICE.tPlaybackStart - VOICE.tSttFinal);
});

test('typed turns are measured from submission', () => {
  const d = deriveIntervals({ tSubmit: 100, tLlmRequest: 101, tLlmFirstToken: 301, tLlmFirstContent: 301, tLlmDone: 901, tTtsTextReady: 500, tTtsFirstAudio: 600, tPlaybackStart: 620, tPlaybackEnd: 2000 });
  assert.equal(d.perceivedLatencyMs, 520);
  assert.equal(d.turnDurationMs, 1900);
  assert.equal(d.speechDurationMs, null);
  assert.equal(d.sttFinalizeMs, null);
});

test('reasoning before the answer shows up as TTFT < time to first content', () => {
  const d = deriveIntervals({ ...VOICE, tLlmFirstToken: 3855, tLlmFirstContent: 4655 });
  assert.equal(d.llmTtftMs, 100);
  assert.equal(d.llmFirstContentMs, 900);
});

test('missing timestamps give null, never a made-up number', () => {
  const d = deriveIntervals({ tSubmit: 5 });
  for (const key of DERIVED_KEYS) assert.equal(d[key], null, key);
});

test('LLM-only turn ends at LLM completion', () => {
  const d = deriveIntervals({ tSubmit: 0, tLlmRequest: 1, tLlmFirstToken: 100, tLlmDone: 500 });
  assert.equal(d.turnDurationMs, 500);
  assert.equal(d.perceivedLatencyMs, null);
});

test('TurnMetrics keeps the first mark and accumulates counters', () => {
  const m = new TurnMetrics({ turnId: 't1', mode: 'full', input: 'voice' });
  m.mark('tPlaybackStart', 10);
  m.mark('tPlaybackStart', 99);
  m.mark('tBad', NaN);
  m.add('ttsSynthMs', 40);
  m.add('ttsSynthMs', 60);
  m.note('x'); m.note('x');
  const out = m.finalize('ok');
  assert.equal(out.timestamps.tPlaybackStart, 10);
  assert.equal('tBad' in out.timestamps, false);
  assert.equal(out.counters.ttsSynthMs, 100);
  assert.deepEqual(out.notes, ['x']);
  assert.equal(out.outcome, 'ok');
});

test('every derived key has a written definition', () => {
  const d = deriveIntervals(VOICE, {});
  assert.deepEqual(Object.keys(d).sort(), DERIVED_KEYS.slice().sort());
  for (const def of METRIC_DEFINITIONS) assert.ok(def.def.length > 20, def.key);
});

test('median / min / max', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.deepEqual(summarize([10, null, 30, undefined, 20]), { n: 3, median: 20, min: 10, max: 30 });
  assert.deepEqual(summarize([]), { n: 0, median: null, min: null, max: null });
});

test('summaries include slow turns rather than hiding them', () => {
  const turns = [100, 120, 5000].map((v) => ({ derived: { perceivedLatencyMs: v } }));
  const s = summarizeTurns(turns, ['perceivedLatencyMs']);
  assert.deepEqual(s.perceivedLatencyMs, { n: 3, median: 120, min: 100, max: 5000 });
});

test('metrics store is bounded', () => {
  const s = new MetricsStore({ capacity: 3 });
  for (let i = 0; i < 5; i++) s.add({ turnId: i });
  assert.deepEqual(s.list().map((t) => t.turnId), [2, 3, 4]);
});
