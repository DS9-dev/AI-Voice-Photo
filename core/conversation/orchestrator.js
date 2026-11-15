'use strict';
const { EventEmitter } = require('node:events');
const { nowMs } = require('../util/clock');
const { States } = require('../state/stateMachine');
const { buildMessages } = require('./prompt');
const { turnHintFor, withTurnHint } = require('./turnHints');
const { StreamingSentenceSplitter, splitSentences } = require('./sentenceSplitter');
const { TurnMetrics } = require('../metrics/turnMetrics');
const { MIC_MODES } = require('../config/configStore');
const { resolveLanguageProfile } = require('../language/languages');

const ROUTES = ['llm_tts', 'llm_only', 'tts_only'];
const TRANSCRIBE_WATCHDOG_MS = 30000;

/**
 * Conversation Core: drives LISTENING -> THINKING -> SPEAKING -> LISTENING
 * over the three provider boundaries. Knows nothing about Electron.
 *
 * Emits:
 *   'state'          snapshot()                      whenever anything in it changes
 *   'message'        {id, role, text, turnId, source, route}
 *   'assistantDelta' {turnId, text}                  streamed answer text
 *   'stt'            {utteranceId, text, accepted, reason, sttMs}
 *   'turn'           finalized TurnMetrics JSON
 *   'rejected'       {source, reason, text}
 *   'problem'        {source, message}
 *   'sessionCleared' {sessionId}
 */
class ConversationOrchestrator extends EventEmitter {
  constructor({ llm, stt, tts, getConfig, getLanguage, history, stateMachine, metricsStore, log, clock = nowMs, random = Math.random }) {
    super();
    this.random = random; // the length draw of the per-turn notes (tests pass a fixed one)
    this.llm = llm;
    this.stt = stt;
    this.tts = tts;
    this.getConfig = getConfig;
    // () => {profile, runtime}: the conversation-language profile derived from
    // the single language setting, plus what the providers report as loaded
    this.getLanguage = getLanguage || (() => ({ profile: resolveLanguageProfile(getConfig()), runtime: {} }));
    this.history = history;
    this.sm = stateMachine;
    this.metricsStore = metricsStore;
    this.log = log;
    this.clock = clock;

    this.micMode = 'off';
    this.hearing = false;
    this.transcribing = false;
    this.llmModel = '';
    this.current = null;
    this.lastRequest = null;
    this.lastLlmDiag = null;
    this.rejectedInputs = 0;
    this._turnSeq = 0;
    this._previewSeq = 0;
    this._msgSeq = 0;
    this._listeningSent = false;
    this._pendingVoice = null;
    this._watchdog = null;
    this._transcribeWatchdog = null;

    this.sm.on('transition', (rec) => {
      this.log.info('state', `${rec.from} -> ${rec.to}${rec.reason ? ` (${rec.reason})` : ''}`);
    });

    stt.on('speechStart', (e) => this._onSpeechStart(e));
    stt.on('speechEnd', (e) => this._onSpeechEnd(e));
    stt.on('final', (e) => this._onSttFinal(e));
    stt.on('discarded', (e) => this._onSttDiscarded(e));
    tts.on('synthDone', (e) => this._onSynthDone(e));
    tts.on('playbackStart', (e) => this._onPlaybackStart(e));
    tts.on('drained', (e) => this._onDrained(e));
    tts.on('failed', (e) => this._onTtsFailed(e));
  }

  get state() { return this.sm.state; }

  snapshot() {
    return {
      state: this.sm.state,
      hearing: this.hearing,
      transcribing: this.transcribing,
      micMode: this.micMode,
      turnId: this.current ? this.current.id : null,
      sessionId: this.history.sessionId,
      historyTurns: this.history.length,
      maxHistoryTurns: this.history.maxTurns,
      rejectedInputs: this.rejectedInputs,
    };
  }

  _emitState() { this.emit('state', this.snapshot()); }

  setLlmModel(id) { this.llmModel = id || ''; }

  setMicMode(mode) {
    if (!MIC_MODES.includes(mode)) throw new Error(`Unknown mic mode ${mode}`);
    if (mode === this.micMode) return;
    this.micMode = mode;
    this.log.info('mic', `Microphone mode: ${mode}`);
    if (mode === 'off') { this.hearing = false; }
    this._syncListening();
    this._emitState();
  }

  /** Call after the voice service (re)starts or dies: its gate is closed again. */
  resetVoiceLink(reason) {
    this._listeningSent = false;
    this.hearing = false;
    this._setTranscribing(false);
    this._pendingVoice = null;
    if (reason && this.current && this.current.route !== 'llm_only') {
      this._fail(this.current, reason);
    }
    this._syncListening();
    this._emitState();
  }

  // ---------------------------------------------------------------- input --

  /** Typed-text input. route: llm_tts (default) | llm_only | tts_only */
  submitText(text, route = 'llm_tts') {
    const clean = String(text ?? '').trim();
    if (!ROUTES.includes(route)) return this._reject('text', `unknown route ${route}`, clean);
    if (!clean) return this._reject('text', 'empty input', clean);
    if (!this.sm.canAcceptInput()) return this._reject('text', `busy (${this.sm.state})`, clean);
    if (this.transcribing) return this._reject('text', 'busy (transcribing voice input)', clean);
    const seed = { tSubmit: this.clock() };
    const turn = this._startTurn({ input: 'text', text: clean, route, seed });
    return { accepted: true, turnId: turn.id };
  }

  /**
   * Voice preview (VC-M1.2): speak a fixed sentence in a given voice through
   * the real TTS provider and audio output. It is not a conversation turn: no
   * LLM, no chat message, no session history, no turn metrics. The state
   * machine is used as for the typed-text → TTS bypass, so the microphone is
   * gated while the sample plays and Stop works.
   *
   * Resolves (never rejects) when playback ends:
   *   {ok: true, voice, synthMs, audioMs} | {ok: false, voice, error, stopped?}
   */
  previewVoice({ text, voice }) {
    const sample = String(text ?? '').trim();
    const busy = !this.sm.canAcceptInput() ? `busy (${this.sm.state})`
      : this.transcribing ? 'busy (transcribing voice input)'
        : this.hearing ? 'busy (hearing speech)' : null;
    if (!sample) return Promise.resolve({ ok: false, voice, error: 'Nothing to speak' });
    if (busy) return Promise.resolve({ ok: false, voice, busy: true, error: `Voice preview is not possible now: ${busy}` });
    return new Promise((resolve) => {
      const id = `preview${++this._previewSeq}`;
      const turn = {
        id, route: 'tts_only', input: 'preview', mode: 'voice_preview', preview: true, voice,
        metrics: new TurnMetrics({ turnId: id, mode: 'voice_preview', input: 'preview' }),
        userText: sample, assistantText: '', abort: new AbortController(),
        seq: 0, chunksSent: 0, finished: false, sessionId: this.history.sessionId,
        previewResult: { synthMs: 0, audioMs: 0, voice: null }, resolvePreview: resolve,
      };
      this.current = turn;
      this.log.info('preview', `Voice preview ${id} started (voice ${voice})`);
      this.sm.transition(States.SPEAKING, 'voice preview');
      this._syncListening(true);
      this._emitState();
      for (const s of splitSentences(sample)) this._speakChunk(turn, s);
      if (!turn.finished) this._endTts(turn);
    });
  }

  /**
   * Forget an utterance that is still being transcribed: its transcript, when
   * it arrives, is ignored instead of starting a turn. Used when the active
   * character changes, so that words spoken to the previous character do not
   * open the new character's conversation.
   */
  dropPendingVoice(reason = 'dropped') {
    if (!this._pendingVoice && !this.transcribing) return false;
    this.log.info('stt', `Utterance in transcription dropped (${reason})`);
    this._pendingVoice = null;
    this._setTranscribing(false);
    this._syncListening();
    this._emitState();
    return true;
  }

  clearSession() {
    this.stop('session cleared');
    this.history.clear();
    this.lastRequest = null;
    this.log.info('session', `Session cleared (new session #${this.history.sessionId})`);
    this.emit('sessionCleared', { sessionId: this.history.sessionId });
    this._emitState();
  }

  /** Manual stop: abort generation and playback, return to LISTENING. */
  stop(reason = 'manual stop') {
    const turn = this.current;
    if (!turn) return false;
    turn.abort.abort();
    this.tts.stop();
    this._finish(turn, 'stopped', reason);
    return true;
  }

  _reject(source, reason, text) {
    this.rejectedInputs += 1;
    this.log.warn('input', `Input rejected: ${reason}`, { source });
    this.emit('rejected', { source, reason, text });
    this._emitState();
    return { accepted: false, reason };
  }

  // ------------------------------------------------------------ voice in --

  /**
   * Tell the STT provider whether microphone input may start an utterance.
   * `force` re-sends the command even if it matches the last one sent; used
   * at the start of every turn so the gate is closed explicitly.
   */
  _syncListening(force = false) {
    const want = this.sm.state === States.LISTENING && this.micMode !== 'off' && !this.transcribing;
    if (!want) this.hearing = false;
    if (!force && want === this._listeningSent) return;
    this._listeningSent = want;
    this.stt.setListening(want);
  }

  _setTranscribing(on) {
    this.transcribing = on;
    clearTimeout(this._transcribeWatchdog);
    this._transcribeWatchdog = null;
    if (on) {
      this._transcribeWatchdog = setTimeout(() => {
        this.log.error('stt', 'No transcript received for the last utterance; resuming listening');
        this.emit('problem', { source: 'stt', message: 'Transcription timed out' });
        this._pendingVoice = null;
        this._setTranscribing(false);
        this._syncListening();
        this._emitState();
      }, TRANSCRIBE_WATCHDOG_MS);
      if (this._transcribeWatchdog.unref) this._transcribeWatchdog.unref();
    }
  }

  _voiceInputExpected() {
    return this.sm.state === States.LISTENING && this.micMode !== 'off';
  }

  _onSpeechStart() {
    if (!this._voiceInputExpected()) return;
    this.hearing = true;
    this._emitState();
  }

  _onSpeechEnd(e) {
    this.hearing = false;
    // the service closes its own gate after every utterance until told otherwise
    this._listeningSent = false;
    if (!this._voiceInputExpected()) {
      this._reject('voice', `utterance ignored (${this.sm.state}, mic ${this.micMode})`, '');
      this._syncListening();
      return;
    }
    this._pendingVoice = {
      utteranceId: e.utteranceId,
      tSpeechStart: e.tSpeechStart,
      tSpeechEnd: e.tSpeechEnd,
      tVadEndDetected: e.tVadEndDetected,
    };
    this._setTranscribing(true);
    this._emitState();
  }

  _onSttFinal(e) {
    const seed = this._pendingVoice && this._pendingVoice.utteranceId === e.utteranceId ? this._pendingVoice : null;
    this._pendingVoice = null;
    this._setTranscribing(false);
    const text = String(e.text ?? '').trim();

    if (!seed || !text) {
      this.emit('stt', { utteranceId: e.utteranceId, text, accepted: false, reason: seed ? 'empty transcript' : 'unexpected transcript', sttMs: e.sttMs });
      if (!seed) this._reject('voice', 'transcript without a pending utterance', text);
      this._syncListening();
      this._emitState();
      return;
    }
    seed.tSttFinal = e.tSttFinal;
    const sttInfo = { sttMs: e.sttMs, audioMs: e.audioMs, sttModel: e.model, sttDevice: e.device, sttLanguage: e.language };

    if (this.micMode === 'stt_only') {
      // Bypass A: microphone -> VAD -> STT only.
      const turnId = `t${++this._turnSeq}`;
      const metrics = new TurnMetrics({ turnId, mode: 'stt_only', input: 'voice' });
      for (const [k, v] of Object.entries(seed)) if (k.startsWith('t')) metrics.mark(k, v);
      for (const [k, v] of Object.entries(sttInfo)) metrics.set(k, v);
      this._recordLanguage(metrics, e.language);
      this.emit('stt', { utteranceId: e.utteranceId, text, accepted: true, reason: 'stt-only', sttMs: e.sttMs });
      this._message({ role: 'user', text, turnId, source: 'voice', route: 'stt_only' });
      const final = metrics.finalize('ok');
      this.metricsStore.add(final);
      this.emit('turn', final);
      this._syncListening();
      this._emitState();
      return;
    }

    if (this.micMode !== 'full' || !this.sm.canAcceptInput()) {
      this.emit('stt', { utteranceId: e.utteranceId, text, accepted: false, reason: 'not accepting voice input', sttMs: e.sttMs });
      this._reject('voice', `transcript ignored (${this.sm.state}, mic ${this.micMode})`, text);
      this._syncListening();
      return;
    }

    this.emit('stt', { utteranceId: e.utteranceId, text, accepted: true, reason: 'conversation', sttMs: e.sttMs });
    this._startTurn({ input: 'voice', text, route: 'llm_tts', seed, sttInfo });
  }

  _onSttDiscarded(e) {
    // stage 'vad': too short to be speech, the service keeps listening.
    // stage 'stt': the utterance ended (gate already closed in _onSpeechEnd).
    this.hearing = false;
    this._pendingVoice = null;
    this._setTranscribing(false);
    this.log.info('stt', `Utterance discarded (${e.stage}): ${e.reason}`);
    this.emit('stt', { utteranceId: e.utteranceId, text: e.text || '', accepted: false, reason: e.reason, sttMs: e.sttMs });
    this._syncListening();
    this._emitState();
  }

  // ---------------------------------------------------------------- turn --

  /**
   * Language actually in effect for a turn, per stage, for Diagnostics.
   * Recorded as metadata only; never added to the LLM conversation.
   */
  _recordLanguage(metrics, sttReported) {
    const { profile, runtime = {} } = this.getLanguage();
    const rec = {
      conversation: profile.code,
      stt: sttReported || runtime.stt || profile.stt.language,
      llmInstruction: profile.llm.language,
      tts: runtime.tts || profile.tts.language,
      ttsVoice: runtime.ttsVoice || profile.tts.voice,
    };
    rec.coherent = rec.stt === rec.conversation && rec.llmInstruction === rec.conversation && rec.tts === rec.conversation;
    metrics.set('language', rec);
    if (!rec.coherent) {
      metrics.note(`Language mismatch: conversation ${rec.conversation}, STT ${rec.stt}, LLM instruction ${rec.llmInstruction}, TTS ${rec.tts}.`);
      this.log.warn('language', `Language mismatch on turn ${metrics.turnId}: conversation ${rec.conversation}, STT ${rec.stt}, LLM ${rec.llmInstruction}, TTS ${rec.tts}`);
    }
    return rec;
  }

  _message({ role, text, turnId, source, route }) {
    const msg = { id: `m${++this._msgSeq}`, role, text, turnId, source, route, t: this.clock() };
    this.emit('message', msg);
    return msg;
  }

  _startTurn({ input, text, route, seed, sttInfo }) {
    const id = `t${++this._turnSeq}`;
    const mode = input === 'voice' ? 'full'
      : { llm_tts: 'text_llm_tts', llm_only: 'llm_only', tts_only: 'tts_only' }[route];
    const metrics = new TurnMetrics({ turnId: id, mode, input });
    for (const [k, v] of Object.entries(seed || {})) if (k.startsWith('t')) metrics.mark(k, v);
    for (const [k, v] of Object.entries(sttInfo || {})) metrics.set(k, v);
    this._recordLanguage(metrics, sttInfo && sttInfo.sttLanguage);

    const turn = {
      id, route, input, mode, metrics,
      userText: text,
      assistantText: '',
      abort: new AbortController(),
      seq: 0,
      chunksSent: 0,
      finished: false,
      sessionId: this.history.sessionId,
    };
    this.current = turn;
    this.log.info('turn', `Turn ${id} started (${mode})`);
    this._message({ role: 'user', text, turnId: id, source: input, route });

    if (route === 'tts_only') {
      // Bypass C: typed text -> TTS -> speakers. No LLM, no history.
      this.sm.transition(States.SPEAKING, 'tts-only bypass');
      this._syncListening(true);
      this._emitState();
      for (const s of splitSentences(text)) this._speakChunk(turn, s);
      if (!turn.finished) this._endTts(turn);
      return turn;
    }

    this.sm.transition(States.THINKING, input === 'voice' ? 'utterance accepted' : 'typed text accepted');
    this._syncListening(true);
    this._emitState();
    this._runLlm(turn).catch((err) => {
      if (!turn.finished) this._fail(turn, `Unexpected error: ${err.message}`);
    });
    return turn;
  }

  async _runLlm(turn) {
    const cfg = this.getConfig();
    if (!this.llmModel) {
      this._fail(turn, 'LLM is not ready: no model available from LM Studio');
      return;
    }
    // A per-turn note may ride on the current user message of THIS request only
    // (core/conversation/turnHints.js). The history, the transcript and the
    // turn keep the user's own words.
    const profileLlm = this.getLanguage().profile.llm;
    const hint = turnHintFor({ userText: turn.userText, llm: profileLlm, conversation: cfg.conversation, random: this.random() });
    const messages = buildMessages({
      systemPrompt: profileLlm.systemPrompt,
      historyMessages: this.history.getMessages(),
      userText: withTurnHint(turn.userText, hint.note),
    });
    this.lastRequest = { turnId: turn.id, model: this.llmModel, messages };
    if (hint.applied.length) turn.metrics.set('turnHints', hint.applied.join(' '));
    turn.metrics.set('persona', this.getLanguage().profile.llm.personaIsDefault ? 'default' : 'custom');
    // which character profile answered (metadata for Diagnostics; never sent to the LLM)
    const character = this.getLanguage().profile.character;
    if (character) turn.metrics.set('character', character.id);

    const speak = turn.route === 'llm_tts';
    const streaming = Boolean(cfg.tts.sentenceStreaming);
    const splitter = new StreamingSentenceSplitter();
    let reasoningChars = 0;
    let result;
    try {
      result = await this.llm.streamChat({
        model: this.llmModel,
        messages,
        signal: turn.abort.signal,
        onContent: (piece) => {
          if (turn.finished) return;
          turn.assistantText += piece;
          this.emit('assistantDelta', { turnId: turn.id, text: piece });
          if (speak && streaming) {
            for (const s of splitter.push(piece)) this._speakChunk(turn, s);
          }
        },
        onReasoning: (piece) => { reasoningChars += piece.length; },
      });
    } catch (err) {
      this._recordLlmDiag(turn, err.diag, err.outcome || 'request_failed', err.message);
      if (!turn.finished) this._fail(turn, `LLM error: ${err.message}`);
      return;
    }
    this._recordLlmDiag(turn, result.diag, result.outcome || (result.text ? 'ok' : 'empty'), result.diagnosis || '');
    if (turn.finished) return;

    const m = turn.metrics;
    m.mark('tLlmRequest', result.timings.tRequest);
    m.mark('tLlmFirstToken', result.timings.tFirstToken);
    m.mark('tLlmFirstContent', result.timings.tFirstContent);
    m.mark('tLlmDone', result.timings.tDone);
    m.set('llmModel', result.model);
    m.set('llmCompletionTokens', result.usage.completionTokens);
    m.set('llmPromptTokens', result.usage.promptTokens);
    m.set('llmTokensApproximate', result.usage.approximate);
    m.set('llmFinishReason', result.finishReason);
    m.set('llmReasoningChars', reasoningChars);
    if (result.usage.reasoningTokens !== null) m.set('llmReasoningTokens', result.usage.reasoningTokens);
    m.set('historyTurnsSent', (messages.length - 1 - (messages[0].role === 'system' ? 1 : 0)) / 2);
    for (const n of result.notes) m.note(n);
    if (result.usage.approximate) m.note('Token count approximated from streamed chunks (server sent no usage block).');
    if (reasoningChars > 0) {
      m.note('Model produced reasoning before answering; this adds latency. Thinking could not be switched off for this model through the API.');
      this.log.warn('llm', `Model emitted ${reasoningChars} chars of reasoning before the answer (thinking mode is on)`);
    }
    if (result.finishReason === 'length') m.note('Answer hit the max_tokens limit and may be cut off.');

    const finalText = result.text;
    if (!finalText) {
      // reasoning_only | empty | parser_failure: say which, never just "no answer"
      this._fail(turn, result.diagnosis || (reasoningChars > 0
        ? 'LLM returned reasoning but no answer'
        : 'LLM returned an empty answer'));
      return;
    }
    turn.assistantText = finalText;
    this._message({ role: 'assistant', text: finalText, turnId: turn.id, source: 'llm', route: turn.route });
    if (turn.sessionId === this.history.sessionId) this.history.addTurn(turn.userText, finalText);

    if (!speak) {
      // Bypass B: typed text -> LLM only.
      this._finish(turn, 'ok', 'LLM-only answer complete');
      return;
    }
    const rest = streaming ? splitter.flush() : splitSentences(finalText);
    for (const s of rest) this._speakChunk(turn, s);
    if (turn.finished) return;
    if (turn.chunksSent === 0) {
      this._fail(turn, 'Nothing to speak in the LLM answer');
      return;
    }
    this._endTts(turn);
  }

  /**
   * Keep what was sent to the LLM and what came back (shape and counts only:
   * no message text, no reasoning text) with the turn and for Diagnostics.
   */
  _recordLlmDiag(turn, diag, outcome, message) {
    const m = turn.metrics;
    m.set('llmOutcome', outcome);
    const rec = { turnId: turn.id, outcome, message: message || '', ...(diag || {}) };
    this.lastLlmDiag = rec;
    if (diag) {
      m.set('llmThinkingControl', diag.thinkingControl);
      m.set('llmAttempts', diag.attempts.length);
      const sse = diag.sse || {};
      const keys = Object.entries(sse.deltaKeys || {}).map(([k, n]) => `${k}×${n}`).join(' ') || 'none';
      const line = `Turn ${turn.id} LLM: ${outcome}; HTTP ${diag.httpStatus ?? '—'}; thinking control ${diag.thinkingControl}`
        + ` (${diag.attempts.map((a) => `${a.strategy}:${a.result}`).join(' → ')}); ${sse.events ?? 0} events, delta fields ${keys};`
        + ` finish ${diag.finishReason ?? '—'}; ${diag.contentChars} answer chars, ${diag.reasoningChars} reasoning chars`;
      if (outcome === 'ok') this.log.info('llm', line); else this.log.error('llm', line);
    }
    this.emit('llmDiag', rec);
  }

  _speakChunk(turn, text) {
    if (turn.finished) return;
    if (turn.chunksSent === 0) {
      turn.metrics.mark('tTtsTextReady', this.clock());
      if (this.sm.state === States.THINKING) {
        this.sm.transition(States.SPEAKING, 'first text chunk sent to TTS');
        this._emitState();
      }
      this._armWatchdog(turn);
    }
    const seq = turn.seq++;
    // a conversation turn speaks in the configured voice (the active character's);
    // only a voice preview names the voice for this one request
    const ok = this.tts.speak(turn.voice ? { turnId: turn.id, seq, text, voice: turn.voice } : { turnId: turn.id, seq, text });
    turn.chunksSent += 1;
    if (!ok) this._fail(turn, 'TTS is not available (voice service not running)');
  }

  _endTts(turn) {
    turn.metrics.set('ttsChunks', turn.chunksSent);
    if (!this.tts.endTurn(turn.id)) this._fail(turn, 'TTS is not available (voice service not running)');
  }

  _armWatchdog(turn) {
    clearTimeout(this._watchdog);
    const ms = this.getConfig().conversation.speakingWatchdogMs;
    this._watchdog = setTimeout(() => {
      if (this.current === turn && !turn.finished) {
        this._fail(turn, `TTS did not report playback completion within ${ms} ms`);
      }
    }, ms);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  _onSynthDone(e) {
    const turn = this.current;
    if (!turn || e.turnId !== turn.id) return;
    if (turn.preview) {
      turn.previewResult.synthMs += Number(e.synthMs) || 0;
      turn.previewResult.audioMs += Number(e.audioMs) || 0;
      if (e.voice) turn.previewResult.voice = e.voice;
    } else if (e.voice) {
      // the voice the TTS engine actually used for this turn; it replaces the
      // value noted when the turn started, which may predate a voice change
      turn.metrics.set('ttsVoice', e.voice);
      const language = turn.metrics.counters.language;
      if (language) language.ttsVoice = e.voice;
    }
    turn.metrics.mark('tTtsFirstAudio', e.tSynthDone);
    turn.metrics.add('ttsSynthMs', e.synthMs);
    turn.metrics.add('ttsAudioMs', e.audioMs);
  }

  _onPlaybackStart(e) {
    const turn = this.current;
    if (!turn || e.turnId !== turn.id) return;
    if (!Number.isFinite(turn.metrics.timestamps.tPlaybackStart)) {
      turn.metrics.mark('tPlaybackStart', e.tPlaybackStart);
      // where the answer was heard ('local' | 'avatar') and the avatar engine's own timings of the first chunk
      if (e.output) turn.metrics.set('ttsOutput', e.output);
      if (e.timings) for (const [k, v] of Object.entries(e.timings)) if (Number.isFinite(Number(v))) turn.metrics.set(k, Number(v));
      if (Number.isFinite(e.outputLatencyMs)) turn.metrics.set('outputLatencyMs', e.outputLatencyMs);
      if (e.approximate) turn.metrics.note('Playback start is approximate: audio-callback time plus the output latency reported by the audio driver.');
    }
  }

  _onDrained(e) {
    const turn = this.current;
    if (!turn || e.turnId !== turn.id) return;
    if (e.aborted) {
      this._finish(turn, 'stopped', 'playback aborted');
      return;
    }
    turn.metrics.mark('tPlaybackEnd', e.tPlaybackEnd);
    this._finish(turn, 'ok', 'playback complete');
  }

  _onTtsFailed(e) {
    const turn = this.current;
    if (!turn || (e.turnId && e.turnId !== turn.id)) return;
    this._fail(turn, `TTS error: ${e.message}`);
  }

  _fail(turn, message) {
    if (turn.finished) return;
    if (turn.preview) {
      // a failed preview is reported to whoever asked for it, not into the conversation
      this.log.error('preview', `Voice preview ${turn.id} failed: ${message}`);
      this.tts.stop();
      turn.previewError = message;
      this._finish(turn, 'error', 'voice preview failed');
      return;
    }
    this.log.error('turn', `Turn ${turn.id} failed: ${message}`);
    turn.abort.abort();
    this.tts.stop();
    this._message({ role: 'system', text: message, turnId: turn.id, source: 'error', route: turn.route });
    this.emit('problem', { source: 'turn', message });
    turn.metrics.note(message);
    this._finish(turn, 'error', 'error');
  }

  _finish(turn, outcome, reason) {
    if (turn.finished) return;
    turn.finished = true;
    clearTimeout(this._watchdog);
    this._watchdog = null;
    if (turn.preview) {
      // not a turn: nothing is added to the metrics store, the transcript or the history
      if (this.current === turn) this.current = null;
      this.sm.reset(reason);
      this.log.info('preview', `Voice preview ${turn.id} finished: ${outcome}`);
      this._syncListening();
      this._emitState();
      const r = turn.previewResult;
      if (outcome === 'ok' && !(r.audioMs > 0)) { outcome = 'error'; turn.previewError = 'TTS produced no audio for the preview'; }
      // the sample must have been spoken by the requested voice, not by whatever the engine had loaded
      if (outcome === 'ok' && r.voice && r.voice !== turn.voice) { outcome = 'error'; turn.previewError = `TTS spoke with '${r.voice}' instead of '${turn.voice}'`; }
      turn.resolvePreview(outcome === 'ok'
        ? { ok: true, voice: r.voice || turn.voice, synthMs: Math.round(r.synthMs), audioMs: Math.round(r.audioMs) }
        : { ok: false, voice: turn.voice, error: turn.previewError || (outcome === 'stopped' ? 'Voice preview was stopped' : 'Voice preview failed'), stopped: outcome === 'stopped' });
      return;
    }
    const final = turn.metrics.finalize(outcome);
    this.metricsStore.add(final);
    if (this.current === turn) this.current = null;
    this.sm.reset(reason);
    this.log.info('turn', `Turn ${turn.id} finished: ${outcome}`);
    this._syncListening();
    this.emit('turn', final);
    this._emitState();
  }
}

module.exports = { ConversationOrchestrator, ROUTES };
