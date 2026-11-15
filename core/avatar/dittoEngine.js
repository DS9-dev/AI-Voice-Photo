'use strict';
/**
 * DittoAvatarEngine (AVP-04): the AvatarEngine contract (core/avatar/avatarEngine.js)
 * implemented by the avatar service — Ditto in its own Python process
 * (services/avatar_service, environment .venv_avatar).
 *
 * The service animates the photo continuously (silence between answers keeps the face
 * alive), plays the speech it is given and shows each frame when its audio is actually
 * heard. Frames reach the window as an MJPEG stream on 127.0.0.1 (info().streamUrl).
 *
 * Process ownership, the JSON-lines protocol, hello and reaping are the voice service's
 * (VoiceServiceClient with its own status component 'avatar').
 */
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { VoiceServiceClient } = require('../providers/voiceServiceClient');

function avatarPython(rootDir, configured) {
  if (configured) return configured;
  return process.platform === 'win32'
    ? path.join(rootDir, '.venv_avatar', 'Scripts', 'python.exe')
    : path.join(rootDir, '.venv_avatar', 'bin', 'python');
}

class DittoAvatarEngine extends EventEmitter {
  constructor({ rootDir, getConfig, log = null, client = null }) {
    super();
    this.name = 'ditto';
    this.rootDir = rootDir;
    this.getConfig = getConfig;
    this.log = log;
    this.photo = '';
    this.conversationState = null;
    this.status = { state: 'loading', detail: 'Avatar service not started', info: {} };
    this.level = 0;
    const cfg = getConfig();
    this.python = avatarPython(rootDir, cfg.avatar.pythonPath);
    this.client = client || new VoiceServiceClient({
      command: this.python,
      args: ['-u', '-m', 'services.avatar_service', '--app=ai-voice-photo'],
      cwd: rootDir,
      components: ['avatar'],
      label: 'Avatar service',
      helloTimeoutMs: 60000,
    });
    this._wire();
  }

  _log(level, msg) { if (this.log) this.log[level]('avatar', msg); }

  _wire() {
    const c = this.client;
    c.on('status', (s) => {
      if (s.component !== 'avatar') return;
      const wasReady = this.status.state === 'ready';
      this.status = { state: s.state, detail: s.detail || '', info: s.info || {} };
      this.emit('state', this.info());
      if (!wasReady && s.state === 'ready') this.emit('connected');
    });
    c.on('log', (e) => this._log(e.level === 'warning' ? 'warn' : (e.level || 'info'), e.message));
    c.on('stderr', (line) => {
      if (/\b(Traceback|ERROR|Error:)\b/.test(line)) this._log('error', line.slice(0, 400));
    });
    c.on('speech_started', (e) => this.emit('speechStarted', { turnId: e.turnId, seq: e.seq, tailMs: e.tailMs, timings: { delayMs: e.delayMs } }));
    c.on('speech_ended', (e) => this.emit('speechEnded', { turnId: e.turnId, seq: e.seq, reason: e.reason, playedMs: e.playedMs, tailMs: e.tailMs, detail: e.detail }));
    c.on('level', (e) => { this.level = e.level; this.emit('level', e.level); });
    c.on('exit', (info) => {
      if (!info.expected) {
        this.status = { state: 'error', detail: `Avatar service exited unexpectedly (${info.detail})`, info: {} };
        this.emit('state', this.info());
        this.emit('disconnected', { reason: 'avatar service exited' });
      }
    });
  }

  _initConfig() {
    const cfg = this.getConfig();
    return {
      models_dir: path.join(this.rootDir, 'models'),
      photo: this.photo,
      max_size: cfg.avatar.maxSize,
      sharpen: cfg.avatar.sharpen,
      output_device: cfg.audio.outputDevice,
      host_api: cfg.audio.hostApi,
      out_rate: cfg.tts.sampleRate,
    };
  }

  async start() {
    if (!fs.existsSync(this.python)) {
      this.status = { state: 'error', detail: `Avatar environment not found (${this.python}): run setup_avatar.bat`, info: {} };
      this.emit('state', this.info());
      return;
    }
    try {
      const hello = await this.client.start(this._initConfig());
      this._log('info', `Avatar service started (pid ${hello.pid}, Python ${hello.python})`);
    } catch (err) {
      this.status = { state: 'error', detail: err.message, info: {} };
      this.emit('state', this.info());
    }
  }

  async stop() { await this.client.stop(); }

  /** Output device changed in the settings. */
  configure() {
    const c = this._initConfig();
    this.client.send({ cmd: 'configure', config: { output_device: c.output_device, host_api: c.host_api, sharpen: c.sharpen } });
  }

  setPhoto(photo) {
    this.photo = String(photo || '');
    if (this.client.running) this.client.send({ cmd: 'set_photo', path: this.photo });
    this.emit('state', this.info());
  }

  setConversationState(state) { this.conversationState = state; }

  speechBlocker() {
    if (this.status.state !== 'ready') return `the avatar is not ready (${this.status.detail || this.status.state})`;
    if (!this.status.info.animating) return 'no photo is being animated';
    return null;
  }

  setSpeechMode() { return true; }

  playSpeech({ turnId, seq, wav }) {
    return this.client.send({ cmd: 'play', turn_id: turnId, seq, wav_b64: Buffer.from(wav).toString('base64') });
  }

  stopSpeech(turnId, reason) { this.client.send({ cmd: 'stop', turn_id: turnId, reason }); }

  getStats() { return this.client.running ? this.client.request({ cmd: 'get_stats' }, 3000) : Promise.resolve(null); }

  record(action, file) { return this.client.request({ cmd: 'record', action, path: file }, 120000); }

  info() {
    const s = this.status;
    return {
      engine: this.name,
      state: s.state,
      detail: s.detail,
      photo: this.photo,
      streamUrl: s.info.streamUrl || null,
      animating: Boolean(s.info.animating),
      speechMode: true,
      animates: true,
    };
  }
}

module.exports = { DittoAvatarEngine, avatarPython };
