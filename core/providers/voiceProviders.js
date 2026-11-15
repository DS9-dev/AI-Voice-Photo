'use strict';
const { EventEmitter } = require('node:events');

/**
 * STTProvider backed by the Python voice service
 * (microphone -> Silero VAD -> faster-whisper).
 */
class VoiceServiceSttProvider extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.name = 'faster-whisper (voice service)';
    client.on('speech_start', (e) => this.emit('speechStart', e));
    client.on('speech_end', (e) => this.emit('speechEnd', e));
    client.on('speech_discarded', (e) => this.emit('discarded', { ...e, stage: 'vad' }));
    client.on('stt_final', (e) => this.emit('final', e));
    client.on('stt_discarded', (e) => this.emit('discarded', { ...e, stage: 'stt' }));
    client.on('mic_level', (e) => this.emit('level', e));
  }

  setListening(enabled) {
    return this.client.send({ cmd: 'set_listening', enabled: Boolean(enabled) });
  }
}

/**
 * TTSProvider backed by the Python voice service (Silero TTS -> speakers).
 * Synthesis is per text chunk (sentence); audio is not streamed incrementally.
 */
class VoiceServiceTtsProvider extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.name = 'silero (voice service)';
    client.on('tts_synth_done', (e) => this.emit('synthDone', e));
    client.on('tts_playback_start', (e) => this.emit('playbackStart', e));
    client.on('tts_playback_end', (e) => this.emit('playbackEnd', e));
    client.on('tts_drained', (e) => this.emit('drained', e));
    client.on('tts_error', (e) => this.emit('failed', e));
    // VC-M3.2: a chunk synthesized with deliver="return" comes back as WAV bytes
    client.on('tts_audio', (e) => {
      if (!Buffer.isBuffer(e.payload)) return;
      this.emit('audio', {
        turnId: e.turnId, seq: e.seq, wav: e.payload, format: e.format, sampleRate: e.sampleRate,
        audioMs: e.audioMs, tEncoded: e.tEncoded, encodeMs: e.encodeMs,
      });
    });
  }

  /** Can this provider return synthesized audio instead of playing it (VC-M3.2)? */
  canReturnAudio() {
    return typeof this.client.hasFeature === 'function' && this.client.hasFeature('tts_return');
  }

  /**
   * Synthesize one chunk and return it as an 'audio' event (WAV bytes) instead of
   * playing it locally. 'synthDone' and 'failed' are emitted as for speak();
   * there are no playback events and no 'drained' for such chunks.
   */
  synthesize({ turnId, seq, text, voice }) {
    const cmd = { cmd: 'tts_speak', turn_id: turnId, seq, text, deliver: 'return' };
    if (voice) cmd.voice = voice;
    return this.client.send(cmd);
  }

  /**
   * `voice` is optional: without it the chunk is spoken in the configured
   * voice (the active character's). With it this one request uses that voice
   * (voice preview); an unknown voice is reported as 'failed', never replaced.
   */
  speak({ turnId, seq, text, voice }) {
    return this.client.send(voice ? { cmd: 'tts_speak', turn_id: turnId, seq, text, voice } : { cmd: 'tts_speak', turn_id: turnId, seq, text });
  }

  endTurn(turnId) {
    return this.client.send({ cmd: 'tts_end_turn', turn_id: turnId });
  }

  stop() {
    return this.client.send({ cmd: 'tts_stop' });
  }
}

module.exports = { VoiceServiceSttProvider, VoiceServiceTtsProvider };
