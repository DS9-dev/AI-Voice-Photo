'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { clampTurns } = require('../session/sessionHistory');
const { isSupportedLanguage, DEFAULT_LANGUAGE, LANGUAGES } = require('../language/languages');
const { characterContext, normalizeCharacters } = require('../characters/characterProfiles');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = isPlainObject(base) ? { ...base } : {};
  if (!isPlainObject(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else if (isPlainObject(v)) out[k] = deepMerge({}, v);
    else out[k] = v;
  }
  return out;
}

/** Keep only keys that exist in the defaults (two levels), so stale or
 *  mistyped keys in user.json cannot leak into the running configuration. */
function pickKnown(defaults, candidate) {
  const out = {};
  if (!isPlainObject(candidate)) return out;
  for (const [section, defSection] of Object.entries(defaults)) {
    if (!isPlainObject(candidate[section]) || !isPlainObject(defSection)) continue;
    out[section] = {};
    for (const key of Object.keys(defSection)) {
      if (candidate[section][key] !== undefined) out[section][key] = candidate[section][key];
    }
  }
  return out;
}

function num(value, fallback, min, max) {
  const v = Number(value);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

const MIC_MODES = ['off', 'stt_only', 'full'];
const THEMES = ['system', 'light', 'dark'];
// where speech is heard: local speakers, or the photo-animation engine (core/avatar), which
// then plays the audio itself in sync with the animated face
const TTS_OUTPUTS = ['local', 'avatar'];

/** Clamp / sanitize values that would otherwise break the pipeline. */
function normalizeConfig(cfg, defaults) {
  const c = deepMerge(defaults, cfg);
  c.llm.endpoint = String(c.llm.endpoint || defaults.llm.endpoint).trim().replace(/\/+$/, '');
  c.llm.model = String(c.llm.model || '').trim();
  c.llm.temperature = num(c.llm.temperature, defaults.llm.temperature, 0, 2);
  c.llm.topP = num(c.llm.topP, defaults.llm.topP, 0.01, 1);
  c.llm.topK = Math.round(num(c.llm.topK, defaults.llm.topK, 0, 1000));
  c.llm.presencePenalty = num(c.llm.presencePenalty, defaults.llm.presencePenalty, -2, 2);
  c.llm.maxTokens = Math.round(num(c.llm.maxTokens, defaults.llm.maxTokens, 16, 4096));
  c.llm.disableThinking = Boolean(c.llm.disableThinking);
  c.llm.reasoningBudgetTokens = Math.round(num(c.llm.reasoningBudgetTokens, defaults.llm.reasoningBudgetTokens ?? 2048, 0, 8192));
  c.session.historyTurns = clampTurns(c.session.historyTurns);
  c.stt.beamSize = Math.round(num(c.stt.beamSize, defaults.stt.beamSize, 1, 10));
  c.tts.threads = Math.round(num(c.tts.threads, defaults.tts.threads, 1, 32));
  c.tts.sentenceStreaming = Boolean(c.tts.sentenceStreaming);
  // where speech is heard: local speakers unless the avatar engine is chosen (and able)
  c.tts.output = TTS_OUTPUTS.includes(c.tts.output) ? c.tts.output : 'local';
  c.vad.threshold = num(c.vad.threshold, defaults.vad.threshold, 0.05, 0.95);
  c.vad.minSpeechMs = Math.round(num(c.vad.minSpeechMs, defaults.vad.minSpeechMs, 60, 2000));
  c.vad.minSilenceMs = Math.round(num(c.vad.minSilenceMs, defaults.vad.minSilenceMs, 150, 3000));
  c.vad.speechPadMs = Math.round(num(c.vad.speechPadMs, defaults.vad.speechPadMs, 0, 1000));
  c.vad.maxUtteranceSec = num(c.vad.maxUtteranceSec, defaults.vad.maxUtteranceSec, 3, 120);
  c.audio.listenResumeDelayMs = Math.round(num(c.audio.listenResumeDelayMs, defaults.audio.listenResumeDelayMs, 0, 3000));
  c.audio.inputDevice = String(c.audio.inputDevice || '');
  c.audio.outputDevice = String(c.audio.outputDevice || '');
  if (!MIC_MODES.includes(c.conversation.micMode)) c.conversation.micMode = defaults.conversation.micMode;
  // per-turn notes (core/conversation/turnHints.js): off unless switched on
  c.conversation.premiseCheck = c.conversation.premiseCheck === true;
  c.conversation.lengthVariation = c.conversation.lengthVariation === true;
  // one conversation language for STT, LLM and TTS (see core/language/languages.js)
  if (!isSupportedLanguage(c.conversation.language)) c.conversation.language = DEFAULT_LANGUAGE;
  c.tts.provider = String(c.tts.provider || defaults.tts.provider);
  // Character profiles (VC-M1.2): who the companion is and which voice she has.
  // `persona.prompt` and `tts.voice` are the single persona and the single voice
  // of VC-M0 / VC-M1.1. Whenever they carry a value it is moved into the
  // built-in profile and the old keys are emptied, so nothing else reads them.
  const characters = normalizeCharacters(
    c.characters,
    characterContext(LANGUAGES[c.conversation.language], c.tts.provider),
    { legacyPersona: c.persona.prompt, legacyVoice: c.tts.voice },
  );
  c.characters = { activeId: characters.activeId, profiles: characters.profiles };
  c.persona.prompt = '';
  c.tts.voice = '';
  c.tts.modelId = String(c.tts.modelId || '');
  // the photo and the animation engine (core/avatar); 'none' = the photo is shown as it is
  c.avatar.engine = String(c.avatar.engine || defaults.avatar.engine || 'none');
  c.avatar.photo = String(c.avatar.photo || '');
  if (!THEMES.includes(c.ui.theme)) c.ui.theme = defaults.ui.theme;
  c.ui.language = String(c.ui.language || defaults.ui.language);
  return c;
}

const nonEmpty = (section, key) => isPlainObject(section) && String(section[key] ?? '').trim() !== '';
/** Does this user configuration still carry the single persona / single voice of VC-M0 / VC-M1.1? */
function hasLegacyPersona(user) {
  return isPlainObject(user) && (nonEmpty(user.persona, 'prompt') || nonEmpty(user.tts, 'voice'));
}

/** Notes about stored character profiles that had to be repaired (invalid ids, voices, active profile…). */
function characterNotes(user, defaults) {
  const c = deepMerge(defaults, user);
  const language = isSupportedLanguage(c.conversation.language) ? c.conversation.language : DEFAULT_LANGUAGE;
  return normalizeCharacters(
    c.characters,
    characterContext(LANGUAGES[language], String(c.tts.provider || defaults.tts.provider)),
    { legacyPersona: c.persona.prompt, legacyVoice: c.tts.voice },
  ).notes;
}

/**
 * Tracked defaults (config/default.json) overlaid with user-local settings
 * (config/user.json, git-ignored). Conversation history is never stored here.
 */
class ConfigStore extends EventEmitter {
  constructor({ defaultPath, userPath }) {
    super();
    this.defaultPath = defaultPath;
    this.userPath = userPath;
    this.defaults = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
    this.loadError = null;
    this.saveError = null;
    this._storedCharacters = undefined;
    this._user = this._readUser();
    this._config = normalizeConfig(this._user, this.defaults);
    // grows with every update(): lets readers cache what they derive from the configuration
    this.revision = 0;
    // what had to be repaired in the stored character profiles (never fatal)
    this.loadNotes = characterNotes(this._storedCharacters === undefined ? this._user : { ...this._user, characters: this._storedCharacters }, this.defaults);
    this.migratedLegacyPersona = this._adoptMigratedCharacters();
  }

  /**
   * VC-M0 / VC-M1.1 stored one persona (`persona.prompt`) and one voice
   * (`tts.voice`). normalizeConfig has already moved them into the built-in
   * character profile; here the user's own settings follow, so that the
   * profile is what gets saved and the old keys are not written again.
   * Nothing is written to disk by this: the file changes with the next save.
   */
  _adoptMigratedCharacters() {
    if (!hasLegacyPersona(this._user)) return false;
    this._user.characters = JSON.parse(JSON.stringify(this._config.characters));
    for (const [section, key] of [['persona', 'prompt'], ['tts', 'voice']]) {
      if (!isPlainObject(this._user[section])) continue;
      delete this._user[section][key];
      if (!Object.keys(this._user[section]).length) delete this._user[section];
    }
    return true;
  }

  _readUser() {
    if (!this.userPath || !fs.existsSync(this.userPath)) return {};
    try {
      const stored = JSON.parse(fs.readFileSync(this.userPath, 'utf8'));
      // kept as written, so that profile data of the wrong shape is reported rather than silently ignored
      this._storedCharacters = isPlainObject(stored) ? stored.characters : undefined;
      return pickKnown(this.defaults, stored);
    } catch (err) {
      // A corrupt user file must not prevent startup; report it instead.
      this.loadError = `Could not read ${this.userPath}: ${err.message}`;
      return {};
    }
  }

  get() { return JSON.parse(JSON.stringify(this._config)); }

  /** Deep-merge a patch, validate, persist. Returns the new config. */
  update(patch) {
    const before = this._config;
    this._user = pickKnown(this.defaults, deepMerge(this._user, patch));
    this._config = normalizeConfig(this._user, this.defaults);
    this.revision += 1;
    this._adoptMigratedCharacters();
    // persist the normalized values of exactly the keys the user has set
    this._user = pickKnown(this._user, this._config);
    // A file that cannot be written (locked, read-only) must not leave the
    // application half-configured: the new settings are in effect for this
    // run and announced as usual; that they were not saved is reported.
    try {
      this._save();
      this.saveError = null;
    } catch (err) {
      this.saveError = `Could not write ${this.userPath}: ${err.message}`;
    }
    this.emit('change', this.get(), before);
    if (this.saveError) this.emit('saveError', this.saveError);
    return this.get();
  }

  _save() {
    if (!this.userPath) return;
    fs.mkdirSync(path.dirname(this.userPath), { recursive: true });
    const tmp = `${this.userPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this._user, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.userPath);
  }
}

module.exports = { ConfigStore, deepMerge, normalizeConfig, pickKnown, hasLegacyPersona, MIC_MODES, THEMES, TTS_OUTPUTS };
