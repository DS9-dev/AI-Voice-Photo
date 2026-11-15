'use strict';
/**
 * Avatar engine boundary: the photo-animation engine of AI Voice Photo.
 *
 * The engine turns one source photo of a face into a talking, blinking,
 * slightly moving portrait. It is NOT implemented in this stage: the only
 * engine is 'none' (NullAvatarEngine), which shows the photo as it is and
 * never takes speech, so every answer is heard on the local output exactly as
 * before. A real engine (local neural renderer, separate process, …) plugs in
 * here without touching the conversation core.
 *
 * Contract (an EventEmitter):
 *   name                    engine id ('none', …)
 *   start() / stop()        async lifecycle (load models, open the render window / process)
 *   info()                  {engine, state, detail, photo, speechMode, ...} for UI and Diagnostics
 *                           state: not_configured | loading | ready | error
 *   setPhoto(path | '')     the source photo changed ('' = no photo)
 *   setConversationState(s) LISTENING | THINKING | SPEAKING (+ hearing) — lets the engine
 *                           animate idle / listening / thinking expressions between answers
 *   speechBlocker()         null when speech can go through the engine now, else the reason
 *   setSpeechMode(enabled)  -> bool: speech goes through the engine from now on (or not)
 *   playSpeech({turnId, seq, sampleRate, audioMs, wav})
 *                           -> bool: one synthesized chunk (16-bit PCM WAV bytes) queued for
 *                           playback with lip sync; the engine plays the audio itself so that
 *                           sound and mouth stay in sync
 *   stopSpeech(turnId, reason)  stop and drop everything of that answer
 *   events:
 *     'speechStarted' {turnId, seq, tailMs?, timings?}     the chunk is audible now
 *     'speechEnded'   {turnId, seq, reason, playedMs?, tailMs?, detail?}
 *                     reason: completed | stopped | dropped | superseded | interrupted | failed | queue_full
 *     'connected' / 'disconnected' {reason}                 a separate engine process came / went
 *     'state'         info()
 *
 * core/speech/speechOutput.js is the only user of the speech part: it decides
 * per answer whether speech goes to the engine (tts.output = 'avatar' and no
 * blocker) or to the local speakers, and keeps the microphone closed until the
 * engine reports the real end of the last chunk.
 */
const { EventEmitter } = require('node:events');

const ENGINES = ['none'];

class NullAvatarEngine extends EventEmitter {
  constructor({ getConfig = null, log = null } = {}) {
    super();
    this.name = 'none';
    this.getConfig = getConfig;
    this.log = log;
    this.photo = '';
    this.conversationState = null;
  }

  async start() { this.emit('state', this.info()); }
  async stop() {}

  setPhoto(photo) {
    this.photo = String(photo || '');
    this.emit('state', this.info());
  }

  setConversationState(state) { this.conversationState = state; }

  speechBlocker() { return 'no photo-animation engine is connected'; }
  setSpeechMode() { return false; }
  playSpeech() { return false; }
  stopSpeech() {}

  info() {
    return {
      engine: this.name,
      state: 'not_configured',
      detail: 'Photo animation engine is not connected yet: the photo is shown as it is',
      photo: this.photo,
      speechMode: false,
      animates: false,
    };
  }
}

/** The engine named in the configuration; unknown names fall back to 'none'. */
function createAvatarEngine(name, options = {}) {
  switch (name) {
    case 'none':
    default:
      return new NullAvatarEngine(options);
  }
}

module.exports = { NullAvatarEngine, createAvatarEngine, ENGINES };
