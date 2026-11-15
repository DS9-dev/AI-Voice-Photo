'use strict';
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { ConversationOrchestrator } = require('../../core/conversation/orchestrator');
const { ConversationStateMachine } = require('../../core/state/stateMachine');
const { SessionHistory } = require('../../core/session/sessionHistory');
const { MetricsStore } = require('../../core/metrics/turnMetrics');
const { EventLog } = require('../../core/util/eventLog');
const { normalizeConfig } = require('../../core/config/configStore');

const DEFAULTS = require(path.join('..', '..', 'config', 'default.json'));

class StubStt extends EventEmitter {
  constructor() { super(); this.gate = []; }
  setListening(v) { this.gate.push(v); return true; }
  get listening() { return this.gate.length ? this.gate[this.gate.length - 1] : false; }
}

class StubTts extends EventEmitter {
  constructor() { super(); this.spoken = []; this.ended = []; this.stops = 0; this.available = true; }
  speak(chunk) { this.spoken.push(chunk); return this.available; }
  endTurn(id) { this.ended.push(id); return this.available; }
  stop() { this.stops += 1; return true; }
}

/** LLM whose stream is driven step by step from the test. */
class StubLlm {
  constructor() { this.calls = []; }
  async checkConnectivity() { return { ok: true, models: [], selectedModel: 'stub-model' }; }
  streamChat(req) {
    const call = { req, text: '', reasoning: '', aborted: false };
    call.promise = new Promise((resolve, reject) => { call.resolve = resolve; call.reject = reject; });
    call.token = (t) => { call.text += t; req.onContent(t); };
    call.reason = (t) => { call.reasoning += t; req.onReasoning(t); };
    call.finish = (extra = {}) => call.resolve({
      model: req.model,
      text: call.text.trim(),
      reasoningText: call.reasoning,
      finishReason: 'stop',
      usage: { promptTokens: 20, completionTokens: 10, reasoningTokens: null, approximate: false },
      timings: { tRequest: 100, tHeaders: 110, tFirstToken: 150, tFirstContent: 150, tDone: 400 },
      notes: [],
      ...extra,
    });
    call.fail = (message) => call.reject(new Error(message));
    if (req.signal) req.signal.addEventListener('abort', () => { call.aborted = true; call.reject(new Error('LLM request aborted')); });
    this.calls.push(call);
    return call.promise;
  }
  get last() { return this.calls[this.calls.length - 1]; }
}

/** Orchestrator over stubs. */
function makeOrchestrator(configPatch = {}, { random } = {}) {
  let cfg = normalizeConfig(configPatch, DEFAULTS);
  const stt = new StubStt();
  const tts = new StubTts();
  const llm = new StubLlm();
  const history = new SessionHistory({ maxTurns: cfg.session.historyTurns });
  const sm = new ConversationStateMachine();
  const metricsStore = new MetricsStore();
  const log = new EventLog();
  const o = new ConversationOrchestrator({ llm, stt, tts, getConfig: () => cfg, history, stateMachine: sm, metricsStore, log, ...(random ? { random } : {}) });
  o.setLlmModel('stub-model');
  const events = { messages: [], turns: [], rejected: [], problems: [], stt: [], states: [] };
  o.on('message', (m) => events.messages.push(m));
  o.on('turn', (t) => events.turns.push(t));
  o.on('rejected', (r) => events.rejected.push(r));
  o.on('problem', (p) => events.problems.push(p));
  o.on('stt', (s) => events.stt.push(s));
  o.on('state', (s) => events.states.push(s));
  const transitions = [];
  sm.on('transition', (r) => transitions.push(`${r.from}>${r.to}`));
  return { o, stt, tts, llm, history, sm, metricsStore, log, events, transitions, setConfig: (patch) => { cfg = normalizeConfig(patch, cfg); } };
}

let utteranceSeq = 0;
/** Simulate microphone -> VAD -> STT events for one utterance. */
function say(stt, text, { t0 = 10000, speechMs = 1500 } = {}) {
  const utteranceId = ++utteranceSeq;
  stt.emit('speechStart', { utteranceId, tSpeechStart: t0 });
  stt.emit('speechEnd', { utteranceId, tSpeechStart: t0, tSpeechEnd: t0 + speechMs, tVadEndDetected: t0 + speechMs + 600, speechMs });
  stt.emit('final', { utteranceId, text, tSttStart: t0 + speechMs + 601, tSttFinal: t0 + speechMs + 750, sttMs: 149, audioMs: speechMs, model: 'stub', device: 'cpu' });
  return utteranceId;
}

/** Simulate the TTS side finishing playback of everything queued for a turn. */
function playAll(tts, turnId, { t0 = 20000 } = {}) {
  const chunks = tts.spoken.filter((c) => c.turnId === turnId);
  chunks.forEach((c, i) => {
    tts.emit('synthDone', { turnId, seq: c.seq, tSynthDone: t0 + i * 100, synthMs: 80, audioMs: 900 });
    tts.emit('playbackStart', { turnId, seq: c.seq, tPlaybackStart: t0 + 20 + i * 1000, approximate: true, outputLatencyMs: 20 });
  });
  tts.emit('drained', { turnId, tPlaybackEnd: t0 + 20 + chunks.length * 1000, chunks: chunks.length, aborted: false });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

module.exports = { makeOrchestrator, say, playAll, tick, StubStt, StubTts, StubLlm, DEFAULTS };
