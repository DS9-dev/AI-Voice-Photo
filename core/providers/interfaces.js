'use strict';

/**
 * Provider boundaries. Core only talks to these contracts; concrete
 * implementations (LM Studio, the Python voice service) are replaceable.
 *
 * LLMProvider
 *   checkConnectivity() -> Promise<{ok, endpoint, models, selectedModel, selectedReason, error}>
 *   streamChat({model, messages, params, signal, onContent, onReasoning})
 *       -> Promise<{text, reasoningText, finishReason, usage, timings, model, notes}>
 *
 * STTProvider (EventEmitter) — owns microphone capture + VAD + transcription
 *   setListening(enabled)          gate conversational microphone input
 *   events:
 *     'speechStart' {utteranceId, tSpeechStart}
 *     'speechEnd'   {utteranceId, tSpeechStart, tSpeechEnd, tVadEndDetected, speechMs}
 *     'final'       {utteranceId, text, tSttStart, tSttFinal, sttMs, audioMs, ...}
 *     'discarded'   {utteranceId, reason}
 *
 * TTSProvider (EventEmitter) — owns synthesis + audio output
 *   speak({turnId, seq, text, voice?})  queue one text chunk for synthesis + playback;
 *                                  `voice` (optional) = this request only, e.g. a voice preview
 *   endTurn(turnId)                no more chunks for this turn
 *   stop()                         drop queued/playing audio immediately
 *   events:
 *     'synthDone'     {turnId, seq, tSynthDone, synthMs, audioMs, voice}
 *     'playbackStart' {turnId, seq, tPlaybackStart, approximate}
 *     'playbackEnd'   {turnId, seq, tPlaybackEnd}
 *     'drained'       {turnId, tPlaybackEnd, chunks, aborted}
 *     'failed'        {turnId, message}
 *   The orchestrator's TTSProvider is core/speech/speechOutput.js: it wraps the
 *   voice-service provider and plays each answer either locally or through the avatar engine
 *   (tts.output); 'playbackStart' / 'drained' then also carry `output` ('local' | 'avatar').
 *   The voice-service provider additionally offers canReturnAudio() and synthesize() (event
 *   'audio' {turnId, seq, wav, sampleRate, audioMs}) for that purpose.
 *
 * AvatarEngine (EventEmitter) — the photo-animation engine; full contract in
 *   core/avatar/avatarEngine.js. Implementations: NullAvatarEngine ('none': the photo is
 *   shown as it is, speech stays local). The neural engine is the next stage.
 */
const CONTRACTS = Object.freeze({
  LLMProvider: ['checkConnectivity', 'streamChat'],
  STTProvider: ['setListening', 'on'],
  TTSProvider: ['speak', 'endTurn', 'stop', 'on'],
  AvatarEngine: ['start', 'stop', 'info', 'setPhoto', 'setConversationState', 'speechBlocker', 'setSpeechMode', 'playSpeech', 'stopSpeech', 'on'],
});

function assertProvider(kind, obj) {
  const methods = CONTRACTS[kind];
  if (!methods) throw new Error(`Unknown provider kind ${kind}`);
  for (const m of methods) {
    if (!obj || typeof obj[m] !== 'function') {
      throw new TypeError(`${kind} is missing method ${m}()`);
    }
  }
  return obj;
}

module.exports = { CONTRACTS, assertProvider };
