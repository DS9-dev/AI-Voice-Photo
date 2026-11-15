'use strict';

/**
 * Per-turn latency bookkeeping.
 *
 * All timestamps are wall-clock milliseconds on the Core clock. Timestamps
 * that originate in the voice service are converted to the Core clock using
 * the offset measured at service start (see VoiceServiceClient).
 *
 * TIMESTAMPS
 *   tSubmit            typed text accepted by Core (text-input turns only)
 *   tSpeechStart       first audio frame classified as speech by the VAD
 *   tSpeechEnd         end of the last speech frame, i.e. when the user
 *                      actually stopped talking as estimated by the VAD
 *   tVadEndDetected    moment the VAD declared end-of-speech (after the
 *                      configured silence window had elapsed)
 *   tSttFinal          final transcript available
 *   tLlmRequest        HTTP request sent to the LLM
 *   tLlmFirstToken     first streamed token of any kind (reasoning or content)
 *   tLlmFirstContent   first streamed speakable content token
 *   tLlmDone           LLM stream finished
 *   tTtsTextReady      first text chunk handed to TTS
 *   tTtsFirstAudio     first synthesized chunk fully generated (playable)
 *   tPlaybackStart     first sample of the answer reaches the audio device
 *                      (callback time + reported output latency; approximate)
 *   tPlaybackEnd       last sample of the answer has been played
 */
const METRIC_DEFINITIONS = Object.freeze([
  { key: 'speechDurationMs', label: 'Speech duration', def: 'tSpeechEnd − tSpeechStart. Length of the user utterance as segmented by the VAD.' },
  { key: 'vadEndDelayMs', label: 'VAD end-of-speech delay', def: 'tVadEndDetected − tSpeechEnd. Silence the VAD waited before declaring the utterance finished (≈ configured min silence).' },
  { key: 'sttFinalizeMs', label: 'STT finalization', def: 'tSttFinal − tVadEndDetected. Queueing plus Whisper inference for the whole utterance.' },
  { key: 'speechEndToSttFinalMs', label: 'Speech end → STT final', def: 'tSttFinal − tSpeechEnd. VAD delay + STT finalization.' },
  { key: 'llmTtftMs', label: 'LLM TTFT', def: 'tLlmFirstToken − tLlmRequest. Request sent → first streamed token of any kind (includes prompt processing).' },
  { key: 'llmFirstContentMs', label: 'LLM time to first content', def: 'tLlmFirstContent − tLlmRequest. Differs from TTFT only if the model emits reasoning first.' },
  { key: 'sttFinalToLlmFirstTokenMs', label: 'STT final → LLM first token', def: 'tLlmFirstContent − tSttFinal. Uses the first speakable content token.' },
  { key: 'speechEndToLlmFirstTokenMs', label: 'Speech end → LLM first token', def: 'tLlmFirstContent − tSpeechEnd.' },
  { key: 'llmTotalMs', label: 'LLM total generation', def: 'tLlmDone − tLlmRequest.' },
  { key: 'llmTokensPerSec', label: 'LLM tokens/sec', def: 'completion tokens ÷ (tLlmDone − tLlmFirstToken). Token count comes from the server usage block; if the server does not report it, streamed chunks are counted and the value is marked approximate.' },
  { key: 'ttsFirstAudioMs', label: 'TTS time-to-first-audio', def: 'tTtsFirstAudio − tTtsTextReady. First text chunk accepted by TTS → that chunk fully synthesized and playable.' },
  { key: 'ttsSynthTotalMs', label: 'TTS total synthesis', def: 'Sum of synthesis time over all chunks of the answer (measured inside the TTS worker).' },
  { key: 'playbackStartDelayMs', label: 'Audio playback start delay', def: 'tPlaybackStart − tTtsFirstAudio. Synthesized audio ready → first sample at the audio device.' },
  { key: 'perceivedLatencyMs', label: 'Perceived response latency', def: 'Voice turns: tPlaybackStart − tSpeechEnd (user stops speaking → first audible companion audio). Typed turns: tPlaybackStart − tSubmit.' },
  { key: 'turnDurationMs', label: 'Complete turn duration', def: 'tPlaybackEnd − tSpeechStart (voice) or tPlaybackEnd − tSubmit (typed). For LLM-only turns the end point is tLlmDone.' },
]);

const DERIVED_KEYS = METRIC_DEFINITIONS.map((m) => m.key);

function diff(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
}

/** Pure function: timestamps + counters -> derived intervals. */
function deriveIntervals(ts, counters = {}) {
  const origin = Number.isFinite(ts.tSpeechEnd) ? ts.tSpeechEnd : ts.tSubmit;
  const turnStart = Number.isFinite(ts.tSpeechStart) ? ts.tSpeechStart : ts.tSubmit;
  const turnEnd = Number.isFinite(ts.tPlaybackEnd) ? ts.tPlaybackEnd
    : (Number.isFinite(ts.tLlmDone) ? ts.tLlmDone : ts.tSttFinal);

  let tokensPerSec = null;
  const genMs = diff(ts.tLlmDone, ts.tLlmFirstToken);
  if (Number.isFinite(counters.llmCompletionTokens) && counters.llmCompletionTokens > 0 && genMs !== null && genMs > 0) {
    tokensPerSec = counters.llmCompletionTokens / (genMs / 1000);
  }

  return {
    speechDurationMs: diff(ts.tSpeechEnd, ts.tSpeechStart),
    vadEndDelayMs: diff(ts.tVadEndDetected, ts.tSpeechEnd),
    sttFinalizeMs: diff(ts.tSttFinal, ts.tVadEndDetected),
    speechEndToSttFinalMs: diff(ts.tSttFinal, ts.tSpeechEnd),
    llmTtftMs: diff(ts.tLlmFirstToken, ts.tLlmRequest),
    llmFirstContentMs: diff(ts.tLlmFirstContent, ts.tLlmRequest),
    sttFinalToLlmFirstTokenMs: diff(ts.tLlmFirstContent, ts.tSttFinal),
    speechEndToLlmFirstTokenMs: diff(ts.tLlmFirstContent, ts.tSpeechEnd),
    llmTotalMs: diff(ts.tLlmDone, ts.tLlmRequest),
    llmTokensPerSec: tokensPerSec,
    ttsFirstAudioMs: diff(ts.tTtsFirstAudio, ts.tTtsTextReady),
    ttsSynthTotalMs: Number.isFinite(counters.ttsSynthMs) ? counters.ttsSynthMs : null,
    playbackStartDelayMs: diff(ts.tPlaybackStart, ts.tTtsFirstAudio),
    perceivedLatencyMs: diff(ts.tPlaybackStart, origin),
    turnDurationMs: diff(turnEnd, turnStart),
  };
}

class TurnMetrics {
  constructor({ turnId, mode, input }) {
    this.turnId = turnId;
    this.mode = mode;   // full | text_llm_tts | llm_only | tts_only | stt_only
    this.input = input; // voice | text
    this.timestamps = {};
    this.counters = {};
    this.notes = [];
    this.outcome = 'in_progress';
  }

  /** Record a timestamp; the first value wins unless `overwrite` is set. */
  mark(name, t, { overwrite = false } = {}) {
    if (!Number.isFinite(t)) return;
    if (!overwrite && Number.isFinite(this.timestamps[name])) return;
    this.timestamps[name] = t;
  }

  set(name, value) { this.counters[name] = value; }

  add(name, value) {
    if (!Number.isFinite(value)) return;
    this.counters[name] = (this.counters[name] || 0) + value;
  }

  note(text) { if (!this.notes.includes(text)) this.notes.push(text); }

  finalize(outcome = 'ok') {
    this.outcome = outcome;
    return this.toJSON();
  }

  toJSON() {
    return {
      turnId: this.turnId,
      mode: this.mode,
      input: this.input,
      outcome: this.outcome,
      timestamps: { ...this.timestamps },
      counters: { ...this.counters },
      derived: deriveIntervals(this.timestamps, this.counters),
      notes: this.notes.slice(),
    };
  }
}

/** Bounded store of finalized turns. */
class MetricsStore {
  constructor({ capacity = 200 } = {}) {
    this.capacity = capacity;
    this.turns = [];
  }

  add(turn) {
    this.turns.push(turn);
    if (this.turns.length > this.capacity) this.turns.shift();
  }

  list() { return this.turns.slice(); }
  clear() { this.turns = []; }
}

module.exports = { TurnMetrics, MetricsStore, deriveIntervals, METRIC_DEFINITIONS, DERIVED_KEYS };
