'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { nowMs } = require('./util/clock');
const { EventLog } = require('./util/eventLog');
const { ConfigStore } = require('./config/configStore');
const { ConversationStateMachine } = require('./state/stateMachine');
const { SessionHistory } = require('./session/sessionHistory');
const { MetricsStore, METRIC_DEFINITIONS, DERIVED_KEYS } = require('./metrics/turnMetrics');
const { summarizeTurns } = require('./metrics/stats');
const { LMStudioProvider } = require('./providers/lmStudioProvider');
const { VoiceServiceClient } = require('./providers/voiceServiceClient');
const { VoiceServiceSttProvider, VoiceServiceTtsProvider } = require('./providers/voiceProviders');
const { assertProvider } = require('./providers/interfaces');
const { ConversationOrchestrator } = require('./conversation/orchestrator');
const { resolveLanguageProfile, resolveCharacterProfiles, listLanguages, LANGUAGES } = require('./language/languages');
const characterProfiles = require('./characters/characterProfiles');
const { SpeechOutput } = require('./speech/speechOutput');
const { createAvatarEngine, ENGINES } = require('./avatar/avatarEngine');

const TURN_MODES = ['full', 'text_llm_tts', 'llm_only', 'tts_only', 'stt_only'];
// the source photo of the avatar
const PHOTO_TYPES = Object.freeze({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.bmp': 'image/bmp' });
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;

function resolvePython(rootDir, configured) {
  if (configured) return configured;
  return process.platform === 'win32'
    ? path.join(rootDir, '.venv', 'Scripts', 'python.exe')
    : path.join(rootDir, '.venv', 'bin', 'python');
}

/**
 * Settings handed to the voice service (it never sees LLM settings).
 * The STT recognition language and the TTS model/voice are derived here from
 * the single conversation-language setting.
 */
function voiceConfig(cfg, rootDir) {
  const lang = resolveLanguageProfile(cfg);
  // where speech is heard (local / avatar engine) is decided in the core, per answer
  const tts = { ...cfg.tts };
  delete tts.output;
  return {
    language: lang.code,
    stt: { ...cfg.stt, language: lang.stt.language },
    tts: { ...tts, modelId: lang.tts.modelId, voice: lang.tts.voice, language: lang.tts.language },
    vad: cfg.vad,
    audio: cfg.audio,
    paths: { models_dir: path.join(rootDir, 'models') },
  };
}

/**
 * Application core façade: composition root used by both the Electron shell
 * and the headless live-acceptance script. Contains no Electron code.
 *
 * Emits a single 'ui' event stream: {type, payload}.
 */
class Companion extends EventEmitter {
  constructor({ rootDir, overrides = {} }) {
    super();
    this.rootDir = rootDir;
    this.clock = overrides.clock || nowMs;
    this.log = new EventLog({ clock: this.clock });
    this.config = overrides.configStore || new ConfigStore({
      defaultPath: path.join(rootDir, 'config', 'default.json'),
      userPath: path.join(rootDir, 'config', 'user.json'),
    });
    if (this.config.loadError) this.log.error('config', this.config.loadError);
    for (const note of this.config.loadNotes || []) this.log.warn('characters', note);
    if (this.config.migratedLegacyPersona) this.log.info('characters', 'The persona and voice of the earlier configuration are now the built-in character profile');
    const cfg = this.config.get();
    this._charactersRevision = 0;

    this.stateMachine = new ConversationStateMachine({ clock: this.clock });
    this.history = new SessionHistory({ maxTurns: cfg.session.historyTurns });
    this.metrics = new MetricsStore();

    this.llm = assertProvider('LLMProvider', overrides.llm || new LMStudioProvider({
      getConfig: () => this.config.get().llm,
      fetchImpl: overrides.fetchImpl,
      clock: this.clock,
    }));

    this.pythonPath = resolvePython(rootDir, cfg.service.pythonPath);
    this.voice = overrides.voiceClient || new VoiceServiceClient({
      command: this.pythonPath,
      // --app marks this project's voice service, so that stop_helpers never touches the voice
      // service of another application built from the same code (e.g. VaMVoiceCompanion)
      args: ['-u', '-m', 'services.voice_service', '--app=ai-voice-photo'],
      cwd: rootDir,
      clock: this.clock,
    });
    this.stt = assertProvider('STTProvider', overrides.stt || new VoiceServiceSttProvider(this.voice));
    this.tts = assertProvider('TTSProvider', overrides.tts || new VoiceServiceTtsProvider(this.voice));
    // The photo-animation engine (core/avatar). In this stage only 'none' exists:
    // the photo is shown as it is and every answer is heard locally.
    this.avatar = assertProvider('AvatarEngine', overrides.avatar || createAvatarEngine(cfg.avatar.engine, { getConfig: () => this.config.get(), log: this.log }));
    // Speech output: local speakers or the avatar engine (lip sync), chosen per answer
    this.speech = assertProvider('TTSProvider', new SpeechOutput({
      local: this.tts,
      avatar: this.avatar,
      getConfig: () => this.config.get(),
      clock: this.clock,
      log: this.log,
      ...(overrides.speechOptions || {}),
    }));

    this.orchestrator = new ConversationOrchestrator({
      llm: this.llm,
      stt: this.stt,
      tts: this.speech,
      getConfig: () => this.config.get(),
      getLanguage: () => ({ profile: this.languageProfile(), runtime: this._runtimeLanguage() }),
      history: this.history,
      stateMachine: this.stateMachine,
      metricsStore: this.metrics,
      log: this.log,
      clock: this.clock,
    });

    this.llmStatus = { component: 'llm', state: 'loading', detail: 'Checking LM Studio…', endpoint: cfg.llm.endpoint, models: [], selectedModel: '', selectedReason: '' };
    this.messages = [];
    this.lastStt = null;
    this.lastMicStats = null;
    this._micSignal = null;
    this._llmTimer = null;
    this._voiceLog = null;
    this._started = false;
    this._shuttingDown = false;
    this._llmPollOkMs = overrides.llmPollOkMs ?? 30000;
    this._llmPollFailMs = overrides.llmPollFailMs ?? 5000;
    this._manageVoiceLog = overrides.voiceClient ? Boolean(overrides.writeVoiceLog) : true;

    this._wire();
  }

  _ui(type, payload) { this.emit('ui', { type, payload }); }

  _wire() {
    const o = this.orchestrator;
    o.on('state', (s) => {
      // the engine animates listening / thinking / speaking expressions from this
      this.avatar.setConversationState({ state: s.state, hearing: s.hearing, transcribing: s.transcribing });
      this._ui('state', s);
    });
    o.on('message', (m) => {
      this.messages.push(m);
      if (this.messages.length > 500) this.messages.shift();
      this._ui('message', m);
    });
    o.on('assistantDelta', (d) => this._ui('assistantDelta', d));
    o.on('stt', (s) => { this.lastStt = s; this._ui('stt', s); });
    o.on('turn', (t) => this._ui('turn', t));
    o.on('problem', (p) => this._ui('problem', p));
    o.on('rejected', (r) => this._ui('rejected', r));
    o.on('sessionCleared', (s) => { this.messages = []; this.lastStt = null; this._ui('sessionCleared', s); });
    this.speech.on('state', () => this._onAvatarChange());
    this.avatar.on('state', () => this._onAvatarChange());
    this.log.on('entry', (e) => this._ui('log', e));

    this.voice.on('status', (s) => {
      if (s.state === 'error') this.log.error('voice', `${s.component}: ${s.detail}`);
      else this.log.info('voice', `${s.component}: ${s.state}${s.detail ? ` — ${s.detail}` : ''}`);
      this._ui('status', this.statuses());
      if (s.component === 'stt' || s.component === 'tts') this._ui('language', this.languageStatus());
      if (s.component === 'tts') this._ui('characters', this.charactersInfo());
      // whether speech can go through the avatar engine depends on the voice service (tts_return)
      if (s.component === 'tts') this._ui('avatar', this.avatarInfo());
    });
    this.voice.on('log', (e) => this.log.add(e.level || 'info', 'voice', e.message));
    this.voice.on('serviceError', (e) => this.log.error('voice', e.message || 'voice service error'));
    this.voice.on('listening', (e) => this._ui('listening', e));
    this.voice.on('clockSync', (e) => this.log.info('voice', `Clock sync with voice service: offset ${e.offsetMs.toFixed(2)} ms, round trip ${e.rttMs.toFixed(2)} ms`));
    this.voice.on('stderr', (line) => this._onVoiceStderr(line));
    this.voice.on('reaped', (r) => {
      if (r.killed) this.log.warn('voice', `Voice service process ${r.servicePid} outlived the process that started it (${r.reason}) and was terminated`);
      if (r.alive) this.log.error('voice', `Voice service process ${r.servicePid} could not be stopped`);
    });
    this.stt.on('level', (e) => this._ui('level', e));
    this.voice.on('mic_stats', (e) => this._onMicStats(e));
    o.on('llmDiag', (d) => this._ui('llmDiag', d));
    this.voice.on('exit', (info) => {
      if (!info.expected) {
        this.log.error('voice', `Voice service exited unexpectedly (${info.detail})`);
        this.orchestrator.resetVoiceLink('Voice service exited unexpectedly');
      }
      this._closeVoiceLog();
    });

    this.config.on('saveError', (message) => {
      // the settings are in effect for this run; the user has to know that they were not saved
      this.log.error('config', message);
      this._ui('problem', { source: 'config', message: `Settings are in effect but were not saved. ${message}` });
    });
    this.config.on('change', (cfg, before) => {
      this._ui('config', cfg);
      if (before && before.conversation.language !== cfg.conversation.language) {
        this.log.info('language', `Conversation language: ${cfg.conversation.language}`);
      }
      this._ui('language', this.languageStatus());
      if (before && JSON.stringify(before.characters) !== JSON.stringify(cfg.characters)) {
        this._charactersRevision += 1;
        const active = resolveCharacterProfiles(cfg).active;
        this.log.info('characters', `Character profiles: ${cfg.characters.profiles.length}, active '${active.displayName}' (voice ${active.voice.id})`);
      }
      this._ui('characters', this.charactersInfo());
    });
  }

  /**
   * What the microphone delivered while the gate was open. "mic ready" only
   * means the stream opened; a device that delivers nothing is reported here.
   */
  _onMicStats(stats) {
    this.lastMicStats = stats;
    this._ui('micStats', stats);
    const listenedLongEnough = stats.windowMs >= 3000;
    const signal = listenedLongEnough ? stats.signal : null;
    if (!signal || signal === this._micSignal) return;
    this._micSignal = signal;
    const device = (stats.stream && stats.stream.device) || 'microphone';
    const secs = (stats.windowMs / 1000).toFixed(1);
    if (signal === 'no_frames') {
      // an open stream that never calls back is a fault
      const message = `Microphone "${device}" delivered no audio frames in ${secs} s of listening.`;
      this.log.error('mic', message);
      this._ui('problem', { source: 'mic', message });
    } else if (signal === 'digital_silence') {
      // Not a fault by itself: a microphone that is gated or muted at the source
      // (many headsets) delivers exact zeros while nobody speaks. Recorded once,
      // shown in the microphone status, no error banner.
      this.log.warn('mic', `Microphone "${device}" has delivered only digital silence for ${secs} s of listening (${stats.frames} frames). Normal for a gated or muted microphone while nobody speaks; if you are speaking, the voice is not arriving.`);
    } else if (signal === 'very_quiet') {
      this.log.warn('mic', `Microphone "${device}" is very quiet (peak ${stats.peak} in ${secs} s); speech is unlikely to be detected.`);
    } else {
      this.log.info('mic', `Microphone "${device}" delivers a signal (peak ${stats.peak}, highest speech probability ${stats.maxSpeechProb}).`);
    }
  }

  /** Ask the voice service what the microphone is delivering right now. */
  async getMicStats() {
    if (!this.voice.running) return null;
    const stats = await this.voice.request({ cmd: 'get_mic_stats' }, 3000);
    this.lastMicStats = stats;
    return stats;
  }

  _onVoiceStderr(line) {
    if (this._voiceLog) {
      try { fs.appendFileSync(this._voiceLog, line + '\n'); } catch { /* ignore */ }
    }
    if (/\b(ERROR|CRITICAL|Traceback)\b/.test(line)) this.log.error('voice-log', line.slice(0, 400));
    else if (/\bWARNING\b/.test(line)) this.log.warn('voice-log', line.slice(0, 400));
  }

  _openVoiceLog() {
    if (!this._manageVoiceLog) return;
    try {
      const dir = path.join(this.rootDir, 'artifacts', 'logs');
      fs.mkdirSync(dir, { recursive: true });
      this._voiceLog = path.join(dir, 'voice_service.log');
      fs.writeFileSync(this._voiceLog, `--- voice service started ${new Date().toISOString()} ---\n`);
    } catch {
      this._voiceLog = null;
    }
  }

  _closeVoiceLog() { this._voiceLog = null; }

  // ------------------------------------------------------------ lifecycle --

  async start() {
    if (this._started) return;
    this._started = true;
    this.log.info('app', 'Starting AI Voice Photo core');
    this.refreshLlm().catch(() => {});
    await this._startAvatar();
    await this._startVoice();
    this.orchestrator.setMicMode(this.config.get().conversation.micMode);
  }

  async _startVoice() {
    if (this.voice instanceof VoiceServiceClient && !fs.existsSync(this.voice.command) && path.isAbsolute(this.voice.command)) {
      const msg = `Python environment not found at ${this.voice.command}. Run setup.bat first.`;
      this.voice._failStart(msg);
      this.log.error('voice', msg);
      return false;
    }
    this._openVoiceLog();
    try {
      const hello = await this.voice.start(voiceConfig(this.config.get(), this.rootDir));
      const via = this.voice.processRelation && this.voice.processRelation !== 'direct'
        ? `, started through ${this.voice.processRelation} process ${this.voice.spawnPid}` : '';
      this.log.info('voice', `Voice service started (pid ${hello.pid}${via}, Python ${hello.python})`);
      this.orchestrator.resetVoiceLink();
      return true;
    } catch (err) {
      this.log.error('voice', `Voice service failed to start: ${err.message}`);
      return false;
    }
  }

  async restartVoiceService() {
    this.log.info('voice', 'Restarting voice service');
    this.orchestrator.stop('voice service restart');
    await this.voice.stop();
    const ok = await this._startVoice();
    return { ok };
  }

  /** Stop everything this application started. LM Studio is external and untouched. */
  async shutdown() {
    if (this._shuttingDown) return;
    this._shuttingDown = true;
    clearTimeout(this._llmTimer);
    this.orchestrator.stop('shutdown');
    try { await this.avatar.stop(); } catch (err) { this.log.error('avatar', `Avatar engine did not stop cleanly: ${err.message}`); }
    const stopped = await this.voice.stop();
    if (stopped && !stopped.clean) this.log.error('voice', `Voice service did not stop cleanly: ${JSON.stringify(stopped)}`);
    this.log.info('app', 'Core stopped');
    return stopped || null;
  }

  // ------------------------------------------------------------------ LLM --

  async refreshLlm() {
    clearTimeout(this._llmTimer);
    const res = await this.llm.checkConnectivity();
    const prev = this.llmStatus;
    this.llmStatus = {
      component: 'llm',
      state: res.ok ? 'ready' : 'error',
      detail: res.ok ? `${res.selectedModel} (${res.selectedReason})` : res.error,
      endpoint: res.endpoint,
      models: res.models,
      selectedModel: res.ok ? res.selectedModel : '',
      selectedReason: res.selectedReason,
    };
    this.orchestrator.setLlmModel(this.llmStatus.selectedModel);
    if (prev.state !== this.llmStatus.state || prev.selectedModel !== this.llmStatus.selectedModel) {
      if (res.ok) this.log.info('llm', `LM Studio ready: ${res.selectedModel} (${res.selectedReason})`);
      else this.log.error('llm', `LM Studio not ready: ${res.error}`);
    }
    this._ui('status', this.statuses());
    if (!this._shuttingDown) {
      this._llmTimer = setTimeout(() => this.refreshLlm().catch(() => {}), res.ok ? this._llmPollOkMs : this._llmPollFailMs);
      if (this._llmTimer.unref) this._llmTimer.unref();
    }
    return this.llmStatus;
  }

  // --------------------------------------------------------------- avatar --
  // The source photo and the photo-animation engine (core/avatar/avatarEngine.js).

  async _startAvatar() {
    const cfg = this.config.get();
    if (cfg.avatar.photo && !fs.existsSync(cfg.avatar.photo)) this.log.warn('avatar', `Photo not found: ${cfg.avatar.photo}`);
    this.avatar.setPhoto(cfg.avatar.photo);
    try {
      await this.avatar.start();
      this.log.info('avatar', `Avatar engine: ${this.avatar.name} (${this.avatar.info().detail})`);
    } catch (err) {
      this.log.error('avatar', `Avatar engine failed to start: ${err.message}`);
    }
    this._onAvatarChange();
  }

  _onAvatarChange() {
    this._ui('avatar', this.avatarInfo());
    this._ui('status', this.statuses());
  }

  /** The avatar as the status strip shows it. */
  avatarStatus() {
    const i = this.avatar.info();
    return { component: 'avatar', state: i.state, detail: i.detail };
  }

  /** Everything the UI shows about the photo, the engine and where speech goes. */
  avatarInfo() {
    const cfg = this.config.get();
    const photo = cfg.avatar.photo;
    return {
      engine: this.avatar.info(),
      engines: ENGINES,
      photo: photo ? { path: photo, name: path.basename(photo), exists: fs.existsSync(photo) } : null,
      speech: this.speech.info(),
    };
  }

  /** Use a photo file as the avatar (path chosen by the user). */
  setPhoto({ file } = {}) {
    const full = path.resolve(String(file || ''));
    const ext = path.extname(full).toLowerCase();
    if (!PHOTO_TYPES[ext]) throw new Error(`Unsupported photo type '${ext || '?'}': use JPG, PNG, WEBP or BMP`);
    let st;
    try { st = fs.statSync(full); } catch { throw new Error(`Photo not found: ${full}`); }
    if (!st.isFile()) throw new Error(`Not a file: ${full}`);
    if (st.size > MAX_PHOTO_BYTES) throw new Error(`Photo is larger than ${MAX_PHOTO_BYTES / 1048576} MB`);
    this.updateConfig({ avatar: { photo: full } });
    this.log.info('avatar', `Photo: ${full}`);
    return this.avatarInfo();
  }

  clearPhoto() {
    this.updateConfig({ avatar: { photo: '' } });
    this.log.info('avatar', 'Photo removed');
    return this.avatarInfo();
  }

  /** The current photo as a data URL for the renderer (null when there is none or it cannot be read). */
  photoData() {
    const photo = this.config.get().avatar.photo;
    if (!photo) return null;
    const type = PHOTO_TYPES[path.extname(photo).toLowerCase()];
    try {
      const buf = fs.readFileSync(photo);
      if (buf.length > MAX_PHOTO_BYTES) return { path: photo, error: 'too large' };
      return { path: photo, dataUrl: `data:${type};base64,${buf.toString('base64')}`, bytes: buf.length };
    } catch (err) {
      return { path: photo, error: err.message };
    }
  }

  // ------------------------------------------------------------- commands --

  sendText(text, route) { return this.orchestrator.submitText(text, route); }
  stop() { return this.orchestrator.stop(); }
  clearSession() { this.orchestrator.clearSession(); return { sessionId: this.history.sessionId }; }

  setMicMode(mode) {
    this.orchestrator.setMicMode(mode);
    this.config.update({ conversation: { micMode: mode } });
    return this.orchestrator.snapshot();
  }

  updateConfig(patch) {
    const before = this.config.get();
    const cfg = this.config.update(patch);
    this.history.setMaxTurns(cfg.session.historyTurns);
    if (before.llm.endpoint !== cfg.llm.endpoint || before.llm.model !== cfg.llm.model) {
      this.refreshLlm().catch(() => {});
    }
    const voiceBefore = JSON.stringify(voiceConfig(before, this.rootDir));
    const voiceAfter = JSON.stringify(voiceConfig(cfg, this.rootDir));
    if (voiceBefore !== voiceAfter) {
      this.voice.send({ cmd: 'configure', config: voiceConfig(cfg, this.rootDir) });
    }
    if (before.tts.output !== cfg.tts.output) {
      // takes effect from the next answer; an answer being spoken finishes where it started
      this.log.info('speech', `Speech output: ${cfg.tts.output === 'avatar' ? 'through the avatar engine' : 'local'}`);
      this.speech.syncAudioMode();
      this._onAvatarChange();
    }
    if (before.avatar.photo !== cfg.avatar.photo) {
      this.avatar.setPhoto(cfg.avatar.photo);
      this._onAvatarChange();
    }
    if (before.avatar.engine !== cfg.avatar.engine) {
      this.log.warn('avatar', `Avatar engine '${cfg.avatar.engine}' takes effect after a restart of the application`);
    }
    this.log.info('config', 'Configuration updated');
    this._ui('state', this.orchestrator.snapshot());
    return cfg;
  }

  async listDevices() {
    const r = await this.voice.request({ cmd: 'list_devices' }, 8000);
    return { hostApi: r.hostApi, inputs: r.inputs || [], outputs: r.outputs || [] };
  }

  async getResources() {
    const out = { coreRssMb: Math.round(process.memoryUsage().rss / 1048576), voice: null };
    try {
      const r = await this.voice.request({ cmd: 'get_resources' }, 5000);
      out.voice = { rssMb: r.rssMb ?? null, gpu: r.gpu ?? null, error: r.error ?? null };
    } catch (err) {
      out.voice = { rssMb: null, gpu: null, error: err.message };
    }
    return out;
  }

  // ------------------------------------------------------------- language --

  /** Per-provider language settings derived from `conversation.language`. */
  languageProfile() { return resolveLanguageProfile(this.config.get()); }

  /** The persona in effect (the active character), as the VC-M0 acceptance script reads it. */
  personaInfo() {
    const llm = this.languageProfile().llm;
    return { text: llm.persona, isDefault: llm.personaIsDefault, defaultText: llm.defaultPersona, coreInstructions: llm.coreInstructions, maxLength: characterProfiles.LIMITS.description };
  }

  // ----------------------------------------------------- character profiles --
  // WHO the companion is and which voice she has (VC-M1.2). Profiles live in
  // the configuration; every change goes through updateConfig, so the voice
  // reaches the voice service the same way any other setting does.

  _characterContext(cfg = this.config.get()) {
    return characterProfiles.characterContext(LANGUAGES[this.languageProfile().code], cfg.tts.provider);
  }

  /**
   * Everything Settings → «Персонаж» shows: the profiles with their defaults
   * filled in, the active one, the voices that can be chosen, and the
   * protected core (read-only).
   */
  charactersInfo() {
    const cfg = this.config.get();
    const profile = this.languageProfile();
    const resolved = resolveCharacterProfiles(cfg);
    const tts = this.voice.statuses.tts;
    return {
      // grows with every stored change, so a view can tell a newer state from an older one
      revision: this._charactersRevision,
      activeId: resolved.activeId,
      profiles: resolved.profiles,
      builtInId: characterProfiles.DEFAULT_PROFILE_ID,
      defaults: { description: profile.llm.defaultPersona, voice: this._characterContext(cfg).defaultVoice },
      voiceProvider: profile.tts.provider,
      voices: profile.tts.voices,
      // what the loaded TTS model itself reports (null until it is ready)
      voicesLoaded: tts && tts.state === 'ready' && tts.info && Array.isArray(tts.info.voices) ? tts.info.voices : null,
      previewText: profile.tts.previewText,
      limits: characterProfiles.LIMITS,
      coreInstructions: profile.llm.coreInstructions,
    };
  }

  /**
   * Apply new stored profiles. A conversation belongs to one character: when
   * the change makes the companion somebody else, the session is cleared first
   * so that replies of the previous character never reach the new one.
   */
  _applyCharacters(characters, { newSession, reason }) {
    if (newSession) {
      this.log.info('characters', `${reason}: starting a new session`);
      this.orchestrator.dropPendingVoice('the active character changed');
      this.orchestrator.clearSession();
    }
    this.updateConfig({ characters });
    return { characters: this.charactersInfo(), sessionCleared: Boolean(newSession), sessionId: this.history.sessionId };
  }

  /** Make another profile the active one. Always starts a new session when the profile changes. */
  selectCharacter(rawId) {
    const id = String(rawId);
    const cfg = this.config.get();
    const next = characterProfiles.setActiveProfile(cfg.characters, this._characterContext(cfg), id);
    return this._applyCharacters(next.characters, { newSession: cfg.characters.activeId !== id, reason: 'Character profile selected' });
  }

  /** A new profile (default persona, default voice); it becomes active. */
  createCharacter() {
    const cfg = this.config.get();
    const next = characterProfiles.createProfile(cfg.characters, this._characterContext(cfg));
    return { ...this._applyCharacters(next.characters, { newSession: true, reason: 'Character profile created' }), id: next.id };
  }

  /** A copy of a profile under a new id; it becomes active. */
  duplicateCharacter(rawId) {
    const id = String(rawId);
    const cfg = this.config.get();
    const next = characterProfiles.duplicateProfile(cfg.characters, this._characterContext(cfg), id);
    return { ...this._applyCharacters(next.characters, { newSession: true, reason: 'Character profile duplicated' }), id: next.id };
  }

  /** Delete a user-created profile. Deleting the active one activates the built-in profile. */
  deleteCharacter(rawId) {
    const id = String(rawId);
    const cfg = this.config.get();
    const next = characterProfiles.deleteProfile(cfg.characters, this._characterContext(cfg), id);
    return this._applyCharacters(next.characters, { newSession: cfg.characters.activeId === id, reason: 'Active character profile deleted' });
  }

  /**
   * Save edited fields of a profile: displayName, characterName, description,
   * voice. Changing the name or the description of the ACTIVE profile changes
   * who is speaking, so it starts a new session; the profile name and the
   * voice do not.
   */
  saveCharacter(rawId, fields = {}) {
    const id = String(rawId);
    const cfg = this.config.get();
    const ctx = this._characterContext(cfg);
    const next = characterProfiles.updateProfile(cfg.characters, ctx, id, fields || {});   // throws for an unknown profile or voice
    const before = characterProfiles.resolveCharacters(cfg.characters, ctx).profiles.find((p) => p.id === id);
    const after = characterProfiles.resolveCharacters(next.characters, ctx).profiles.find((p) => p.id === id);
    const newSession = cfg.characters.activeId === id && characterProfiles.identityChanged(before, after);
    return this._applyCharacters(next.characters, { newSession, reason: 'Active character changed' });
  }

  /** Restore the default description of a profile; nothing else is touched. */
  resetCharacterDescription(id) {
    return this.saveCharacter(id, { description: '' });
  }

  /**
   * Speak the fixed preview sentence in a given voice through the real TTS
   * path. No LLM, no chat message, no history. Resolves when playback ends:
   * {ok, voice, synthMs, audioMs} or {ok: false, error}.
   */
  previewVoice({ voice } = {}) {
    const profile = this.languageProfile();
    const id = String((voice && typeof voice === 'object' ? voice.id : voice) || profile.tts.voice);
    const provider = String((voice && typeof voice === 'object' && voice.provider) || profile.tts.provider);
    if (provider !== profile.tts.provider) return Promise.resolve({ ok: false, voice: id, error: `Voice provider '${provider}' is not the active TTS provider` });
    if (!profile.tts.voices.some((v) => v.id === id)) return Promise.resolve({ ok: false, voice: id, error: `Voice '${id}' does not exist` });
    return this.orchestrator.previewVoice({ text: profile.tts.previewText, voice: id });
  }

  /** What the loaded STT / TTS engines report (undefined while not ready). */
  _runtimeLanguage() {
    const s = this.voice.statuses;
    const ready = (c) => s[c] && s[c].state === 'ready' && s[c].info;
    return {
      stt: ready('stt') ? s.stt.info.language : undefined,
      tts: ready('tts') ? s.tts.info.language : undefined,
      ttsVoice: ready('tts') ? s.tts.info.voice : undefined,
    };
  }

  /** Configured vs. loaded language per stage, to expose mismatches. */
  languageStatus() {
    const p = this.languageProfile();
    const r = this._runtimeLanguage();
    const mismatches = [];
    if (r.stt !== undefined && r.stt !== p.code) mismatches.push(`STT is loaded for '${r.stt}'`);
    if (r.tts !== undefined && r.tts !== p.code) mismatches.push(`TTS is loaded for '${r.tts}'`);
    if (r.ttsVoice !== undefined && r.ttsVoice !== p.tts.voice) mismatches.push(`TTS voice is '${r.ttsVoice}', configured '${p.tts.voice}'`);
    return {
      conversation: { code: p.code, name: p.name },
      stt: { configured: p.stt.language, loaded: r.stt ?? null },
      llm: { instruction: p.llm.language, personaIsDefault: p.llm.personaIsDefault },
      character: p.character,
      tts: { configured: p.tts.language, loaded: r.tts ?? null, voice: p.tts.voice, voiceLoaded: r.ttsVoice ?? null, modelId: p.tts.modelId, voices: p.tts.voices },
      coherent: mismatches.length === 0,
      mismatches,
      notes: p.notes,
    };
  }

  // ---------------------------------------------------------------- views --

  statuses() {
    return {
      mic: this.voice.statuses.mic,
      vad: this.voice.statuses.vad,
      stt: this.voice.statuses.stt,
      tts: this.voice.statuses.tts,
      output: this.voice.statuses.output,
      llm: this.llmStatus,
      avatar: this.avatarStatus(),
    };
  }

  diagnostics() {
    const turns = this.metrics.list();
    const summary = {};
    for (const mode of TURN_MODES) {
      const ok = turns.filter((t) => t.mode === mode && t.outcome === 'ok');
      summary[mode] = { turns: ok.length, intervals: summarizeTurns(ok, DERIVED_KEYS) };
    }
    return {
      turns,
      summary,
      definitions: METRIC_DEFINITIONS,
      log: this.log.list(),
      transitions: this.stateMachine.history.slice(),
      clockSync: { offsetMs: this.voice.clockOffsetMs, rttMs: this.voice.clockRttMs },
      language: this.languageStatus(),
      microphone: this.lastMicStats,   // last listen window: frames, level, speech probability
      llm: this.orchestrator.lastLlmDiag, // last LLM exchange: request shape, response shape, outcome
      avatar: this.avatar.info(),
      speech: { ...this.speech.info(), journal: this.speech.journal.slice() },  // avatar speech timings; never audio data
    };
  }

  snapshot() {
    return {
      conversation: this.orchestrator.snapshot(),
      statuses: this.statuses(),
      config: this.config.get(),
      messages: this.messages.slice(),
      lastStt: this.lastStt,
      language: this.languageStatus(),
      languages: listLanguages(),
      characters: this.charactersInfo(),
      avatar: this.avatarInfo(),
      pythonPath: this.pythonPath,
      rootDir: this.rootDir,
    };
  }

  exportDiagnostics() {
    const dir = path.join(this.rootDir, 'artifacts', 'diagnostics');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `diagnostics_${stamp}.json`);
    const data = {
      exportedAt: new Date().toISOString(),
      conversation: this.orchestrator.snapshot(),
      statuses: this.statuses(),
      config: this.config.get(),
      ...this.diagnostics(),
    };
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    this.log.info('diagnostics', `Diagnostics exported to ${file}`);
    return { file };
  }
}

function createCompanion(options) {
  return new Companion(options);
}

module.exports = { Companion, createCompanion, voiceConfig, resolvePython, TURN_MODES };
