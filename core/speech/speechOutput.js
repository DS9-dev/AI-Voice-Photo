'use strict';
/**
 * SpeechOutput: the TTSProvider the orchestrator talks to.
 *
 * It wraps the voice-service TTS provider and decides, once per answer, where
 * the answer is heard:
 *   local   the voice service synthesizes and plays (default);
 *   avatar  the voice service synthesizes and returns WAV bytes; they go to the
 *           photo-animation engine (core/avatar), which plays them with lip sync
 *           on the animated photo.
 *
 * The orchestrator sees the same events either way: synthDone, playbackStart,
 * playbackEnd, drained, failed. For an avatar answer 'drained' comes only after
 * the engine has reported the real end of the last chunk (plus its output
 * buffer), so the microphone stays closed while the face is still speaking.
 *
 * Policies (inherited from the VaMVoiceCompanion speech path, where they were
 * accepted on real hardware):
 *   - one answer never uses two outputs; the choice is made at its first chunk;
 *   - «avatar» falls back to «local» when the engine cannot play speech;
 *   - Stop: synthesis stops, nothing more is sent, the engine stops and clears;
 *     chunks of a stopped answer that arrive late are dropped;
 *   - engine lost during speech: nothing is repeated or replayed locally;
 *     the microphone waits for the estimated rest of the audio already sent
 *     (capped), then the answer ends with an error message.
 */
const { EventEmitter } = require('node:events');
const { nowMs } = require('../util/clock');

const OUTPUTS = ['local', 'avatar'];
// a synthesized chunk larger than this is not sent to the engine (same limit as the voice service)
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const JOURNAL_SIZE = 100;

class SpeechOutput extends EventEmitter {
  constructor({ local, avatar = null, getConfig, clock = nowMs, log = null, holdCapMs = 15000, keepClosedMs = 10000 }) {
    super();
    this.local = local;
    this.avatar = avatar;
    this.getConfig = getConfig;
    this.clock = clock;
    this.log = log;
    this.holdCapMs = holdCapMs;
    this.keepClosedMs = keepClosedMs;
    this.name = local.name;
    this.turns = new Map();        // avatar answers: turnId -> record (local answers are not tracked)
    this.localTurns = new Set();   // answers decided «local» (for the 'output' field of their events)
    this.lastDecision = null;      // {turnId, wanted, used, reason, at}
    this.audioModeSent = null;     // what speech mode was last told to the engine
    this.journal = [];
    this.dropped = 0;              // late chunks dropped (stopped / finished answers)
    this.lastStop = null;          // {turnId, ackMs}: stop sent -> engine confirmed (stop reaction time)

    local.on('synthDone', (e) => this._onSynthDone(e));
    local.on('playbackStart', (e) => this.emit('playbackStart', { ...e, output: 'local' }));
    local.on('playbackEnd', (e) => this.emit('playbackEnd', e));
    local.on('drained', (e) => { this.localTurns.delete(e.turnId); this.emit('drained', e); });
    local.on('failed', (e) => this._onLocalFailed(e));
    local.on('audio', (e) => this._onAudio(e));

    if (avatar) {
      avatar.on('speechStarted', (m) => this._onEngineMessage({ ...m, type: 'speech_started' }));
      avatar.on('speechEnded', (m) => this._onEngineMessage({ ...m, type: 'speech_ended' }));
      avatar.on('connected', () => { this.audioModeSent = null; this.syncAudioMode(); this._changed(); });
      avatar.on('disconnected', (d) => this._onDisconnected(d));
    }
  }

  _log(level, msg) { if (this.log) this.log[level]('speech', msg); }

  _changed() { this.emit('state', this.info()); }

  configuredOutput() {
    const o = this.getConfig().tts.output;
    return OUTPUTS.includes(o) ? o : 'local';
  }

  /** Why speech cannot go to the avatar engine right now (null = it can). */
  avatarBlocker() {
    if (!this.avatar) return 'no avatar engine';
    const blocker = this.avatar.speechBlocker();
    if (blocker) return blocker;
    if (typeof this.local.canReturnAudio !== 'function' || !this.local.canReturnAudio()) return 'the voice service cannot return synthesized audio';
    return null;
  }

  /** Tell the engine whether speech mode (its lip sync) should be on. */
  syncAudioMode() {
    const a = this.avatar;
    if (!a) { this.audioModeSent = null; return; }
    const want = this.configuredOutput() === 'avatar';
    if (this.audioModeSent === want) return;
    // switching away from the avatar while the face speaks: the answer finishes where it
    // started; speech mode (lip sync) is switched off after it
    if (!want && [...this.turns.values()].some((t) => !t.closed)) { this._modeDeferred = true; return; }
    this._modeDeferred = false;
    if (a.setSpeechMode(want)) this.audioModeSent = want;
  }

  // ------------------------------------------------------- TTSProvider --

  speak(req) {
    let t = this.turns.get(req.turnId);
    if (!t && !this.localTurns.has(req.turnId)) t = this._open(req.turnId);
    if (!t) return this.local.speak(req);
    if (t.closed) return true;           // the answer was stopped / failed: its rest is not spoken
    t.chunks.set(req.seq, { seq: req.seq, state: 'synth', audioMs: 0 });
    return this.local.synthesize(req);
  }

  endTurn(turnId) {
    const t = this.turns.get(turnId);
    if (!t) return this.local.endTurn(turnId);
    t.ended = true;
    this._check(t);
    return true;
  }

  stop() {
    const ok = this.local.stop();
    for (const t of this.turns.values()) if (!t.closed) this._stopAvatar(t, 'stop');
    this.localTurns.clear();
    return ok;
  }

  // ----------------------------------------------------------- decision --

  _open(turnId) {
    const wanted = this.configuredOutput();
    let used = 'local';
    let reason = '';
    if (wanted === 'avatar') {
      const blocker = this.avatarBlocker();
      if (blocker) reason = blocker; else used = 'avatar';
    }
    const prev = this.lastDecision;
    this.lastDecision = { turnId, wanted, used, reason, at: this.clock() };
    if (wanted === 'avatar' && used === 'local' && (!prev || prev.used !== 'local' || prev.reason !== reason)) {
      this._log('warn', `Speech goes to the local output: ${reason}`);
    } else if (used === 'avatar' && (!prev || prev.used !== 'avatar')) {
      this._log('info', `Speech goes through the avatar engine (${this.avatar.name})`);
    }
    this._changed();
    if (used === 'local') {
      this.localTurns.add(turnId);
      if (this.localTurns.size > 50) this.localTurns.delete(this.localTurns.values().next().value);
      return null;
    }
    const t = {
      turnId, chunks: new Map(), ended: false, closed: false, stopping: false,
      tOpen: this.clock(), tStopSent: null, firstStarted: false, tLastEnd: null, tailMs: 0, finalTimer: null, holdTimer: null,
    };
    this.turns.set(turnId, t);
    return t;
  }

  // ------------------------------------------------------ voice service --

  _onSynthDone(e) {
    this.emit('synthDone', e);
    const t = this.turns.get(e.turnId);
    if (!t || t.closed) return;
    const c = t.chunks.get(e.seq);
    if (!c) return;
    if (!(Number(e.audioMs) > 0)) { c.state = 'empty'; this._check(t); }  // nothing speakable: no audio follows
  }

  _onLocalFailed(e) {
    const t = e.turnId ? this.turns.get(e.turnId) : null;
    if (t && !t.closed) this._stopAvatar(t, 'tts error');
    this.emit('failed', e);
  }

  _onAudio(e) {
    const t = this.turns.get(e.turnId);
    const c = t && t.chunks.get(e.seq);
    if (!t || t.closed || !c || c.state !== 'synth') { this.dropped += 1; return; }  // late chunk of a stopped answer
    if (e.wav.length > MAX_AUDIO_BYTES) { this._fail(t, `speech chunk of ${e.wav.length} bytes is larger than the avatar limit`); return; }
    c.audioMs = Number(e.audioMs) || 0;
    c.bytes = e.wav.length;
    c.encodeMs = e.encodeMs;
    c.tSent = this.clock();
    if (!this.avatar.playSpeech({ turnId: t.turnId, seq: e.seq, sampleRate: e.sampleRate, audioMs: c.audioMs, wav: e.wav })) {
      this._fail(t, 'the speech chunk could not be sent to the avatar engine');
      return;
    }
    c.state = 'sent';
  }

  // ------------------------------------------------------- avatar engine --

  _onEngineMessage(m) {
    if (m.type !== 'speech_started' && m.type !== 'speech_ended') return;
    const t = this.turns.get(m.turnId);
    const c = t && t.chunks.get(m.seq);
    if (!t || !c) { this._log('warn', `Avatar engine ${m.type} for unknown speech ${m.turnId}#${m.seq} ignored`); return; }
    const now = this.clock();
    if (m.type === 'speech_started') {
      c.state = 'playing';
      c.tStarted = now;
      c.timing = {
        sendToStartMs: round(now - c.tSent), rxMs: m.rxMs, decodeMs: m.decodeMs, clipMs: m.clipMs,
        queueMs: m.queueMs, startMs: m.startMs, tailMs: m.tailMs,
      };
      if (!t.firstStarted && !t.closed) {
        t.firstStarted = true;
        const tail = Number(m.tailMs) || 0;
        this.emit('playbackStart', {
          turnId: t.turnId, seq: m.seq, tPlaybackStart: now + tail, approximate: true,
          outputLatencyMs: tail || null, output: 'avatar', timings: prefixKeys('avatar', c.timing),
        });
      }
      return;
    }
    // speech_ended
    c.endReason = m.reason;
    c.playedMs = m.playedMs;
    c.state = 'done';
    this._record(t, c);
    if (t.stopping) {
      if (t.stopAckMs === undefined && (m.reason === 'stopped' || m.reason === 'dropped')) {
        t.stopAckMs = round(now - t.tStopSent);
        this.lastStop = { turnId: t.turnId, ackMs: t.stopAckMs, at: Math.round(now) };
        this._log('info', `Avatar engine stopped speech of ${t.turnId} ${t.stopAckMs} ms after the stop request`);
        this._changed();
      }
      return;
    }
    if (t.closed) return;
    if (m.reason === 'completed') {
      t.tLastEnd = now;
      t.tailMs = Number(m.tailMs) || t.tailMs;
      this._check(t);
      return;
    }
    const why = {
      stopped: 'speech was stopped by the avatar engine',
      dropped: 'a speech chunk was dropped by the avatar engine',
      superseded: 'speech was replaced by another answer in the avatar engine',
      interrupted: 'speech in the avatar engine was interrupted',
      failed: `the avatar engine could not play a speech chunk${m.detail ? ` (${m.detail})` : ''}`,
      queue_full: 'the avatar engine speech queue is full',
    }[m.reason] || m.reason;
    this._fail(t, why);
  }

  _onDisconnected(d) {
    this.audioModeSent = null;
    for (const t of this.turns.values()) {
      if (t.closed) continue;
      // Policy: nothing is repeated and nothing is replayed locally — how much of a
      // sent chunk was heard is unknown. Synthesis of the rest stops. The microphone
      // stays closed for what may still sound from chunks already sent (the engine
      // normally stops by itself when the link drops), then the answer ends.
      t.closed = true;
      this.local.stop();
      const now = this.clock();
      let hold = 0;
      for (const c of t.chunks.values()) {
        if (c.state === 'playing') hold += Math.max(0, c.tStarted + c.audioMs - now);
        else if (c.state === 'sent') hold += c.audioMs;
        else continue;
        // the engine can no longer report these chunks; keep them visible in Diagnostics
        c.endReason = 'link_lost';
        c.playedMs = c.state === 'playing' ? Math.round(Math.min(c.audioMs, now - c.tStarted)) : 0;
        c.state = 'done';
        this._record(t, c);
      }
      hold = Math.min(this.holdCapMs, Math.round(hold));
      t.lostHoldMs = hold;
      this._log('warn', `Avatar engine lost during speech of ${t.turnId} (${d && d.reason}); nothing is repeated; microphone waits ${hold} ms`);
      t.holdTimer = setTimeout(() => {
        this.emit('failed', { turnId: t.turnId, message: 'Avatar engine lost during speech; the rest of the answer was not spoken (nothing is repeated)', reason: 'avatar_disconnected' });
        this._forget(t);
      }, hold);
      if (t.holdTimer.unref) t.holdTimer.unref();
    }
    this._changed();
  }

  // --------------------------------------------------------- lifecycle --

  _check(t) {
    if (t.closed || !t.ended) return;
    for (const c of t.chunks.values()) if (c.state !== 'done' && c.state !== 'empty') return;
    t.closed = true;
    const spoken = [...t.chunks.values()].filter((c) => c.state === 'done').length;
    const tail = spoken ? (t.tailMs || 0) : 0;
    // the last samples are still in the engine's output buffer for tailMs after it reports the end
    t.finalTimer = setTimeout(() => {
      this.emit('drained', { turnId: t.turnId, chunks: spoken, aborted: false, tPlaybackEnd: (t.tLastEnd ?? this.clock()) + tail, output: 'avatar' });
      this._forget(t);
    }, tail);
    if (t.finalTimer.unref) t.finalTimer.unref();
  }

  _stopAvatar(t, reason) {
    t.closed = true;
    t.stopping = true;
    t.tStopSent = this.clock();
    clearTimeout(t.finalTimer);
    clearTimeout(t.holdTimer);
    if (this.avatar) this.avatar.stopSpeech(t.turnId, reason);
    // keep the record a while: late audio of this answer is recognised and dropped,
    // and the engine's acknowledgement gives the stop reaction time
    const timer = setTimeout(() => this._forget(t), this.keepClosedMs);
    if (timer.unref) timer.unref();
  }

  _fail(t, message) {
    if (t.closed) return;
    this._stopAvatar(t, 'error');
    this.local.stop();
    this.emit('failed', { turnId: t.turnId, message, reason: 'avatar_speech' });
  }

  _forget(t) {
    if (this.turns.get(t.turnId) === t) this.turns.delete(t.turnId);
    if (this._modeDeferred) this.syncAudioMode();
    this._changed();
  }

  _record(t, c) {
    this.journal.push({
      turnId: t.turnId, seq: c.seq, audioMs: c.audioMs, bytes: c.bytes, encodeMs: c.encodeMs,
      ...(c.timing || {}), playedMs: c.playedMs, end: c.endReason, at: Math.round(this.clock()),
    });
    if (this.journal.length > JOURNAL_SIZE) this.journal.shift();
  }

  info() {
    const blocker = this.configuredOutput() === 'avatar' ? this.avatarBlocker() : null;
    return {
      configured: this.configuredOutput(),
      effective: this.configuredOutput() === 'avatar' && !blocker ? 'avatar' : 'local',
      blocker,
      lastDecision: this.lastDecision,
      active: [...this.turns.values()].filter((t) => !t.closed).map((t) => t.turnId),
      journal: this.journal.slice(-20),
      dropped: this.dropped,
      lastStop: this.lastStop,
    };
  }
}

function round(v) { return Math.round(v * 10) / 10; }
function prefixKeys(prefix, obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== null && v !== undefined) out[prefix + k[0].toUpperCase() + k.slice(1)] = v;
  return out;
}

module.exports = { SpeechOutput, OUTPUTS };
