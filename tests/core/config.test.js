'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigStore, deepMerge } = require('../../core/config/configStore');
const { resolveLanguageProfile, LANGUAGES } = require('../../core/language/languages');

const DEFAULT_PATH = path.join(__dirname, '..', '..', 'config', 'default.json');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vvc-config-'));
  const userPath = path.join(dir, 'user.json');
  return { dir, userPath, store: new ConfigStore({ defaultPath: DEFAULT_PATH, userPath }) };
}

test('defaults match the fixed project decisions', () => {
  const { store } = tempStore();
  const c = store.get();
  assert.equal(c.llm.provider, 'lmstudio');
  assert.match(c.llm.endpoint, /^http:\/\/127\.0\.0\.1:1234\/v1$/);
  assert.equal(c.stt.provider, 'faster-whisper');
  assert.equal(c.stt.model, 'small');
  assert.equal(c.conversation.language, 'ru');
  assert.equal('language' in c.stt, false, 'STT has no language setting of its own');
  assert.equal(c.ui.theme, 'system');
  assert.equal(c.tts.provider, 'silero');
  assert.equal(c.vad.provider, 'silero-vad');
  assert.equal(c.session.historyTurns, 10);
});

test('updates persist to user.json and survive a restart', () => {
  const { userPath, store } = tempStore();
  store.update({ audio: { inputDevice: 'USB Mic' }, llm: { endpoint: 'http://localhost:9999/v1/' }, tts: { voice: 'baya' }, vad: { minSilenceMs: 450 } });
  const again = new ConfigStore({ defaultPath: DEFAULT_PATH, userPath });
  const c = again.get();
  assert.equal(c.audio.inputDevice, 'USB Mic');
  assert.equal(c.llm.endpoint, 'http://localhost:9999/v1');   // trailing slash removed
  // `tts.voice` is the single voice of VC-M0 / VC-M1.1: it is accepted and kept as the voice of the built-in character profile
  assert.deepEqual(c.characters.profiles[0].voice, { provider: 'silero', id: 'baya' });
  assert.equal(c.tts.voice, '', 'the old key is not a second source of truth');
  assert.equal(resolveLanguageProfile(c).tts.voice, 'baya');
  assert.equal('voice' in (JSON.parse(fs.readFileSync(userPath, 'utf8')).tts || {}), false, 'saved as a profile, not under the old key');
  assert.equal(c.vad.minSilenceMs, 450);
  assert.equal(c.stt.model, 'small');                          // untouched default
});

test('only user-changed keys are written; no conversation history or secrets', () => {
  const { userPath, store } = tempStore();
  store.update({ session: { historyTurns: 4 } });
  const saved = JSON.parse(fs.readFileSync(userPath, 'utf8'));
  assert.deepEqual(saved, { session: { historyTurns: 4 } });
  const text = fs.readFileSync(userPath, 'utf8').toLowerCase();
  for (const word of ['apikey', 'api_key', 'token', 'password', 'messages']) assert.equal(text.includes(word), false, word);
});

test('values are clamped to safe ranges', () => {
  const { store } = tempStore();
  const c = store.update({ session: { historyTurns: 500 }, vad: { minSilenceMs: 1, threshold: 7 }, llm: { maxTokens: -3, temperature: 'x' }, conversation: { micMode: 'weird' } });
  assert.equal(c.session.historyTurns, 20);
  assert.equal(c.vad.minSilenceMs, 150);
  assert.equal(c.vad.threshold, 0.95);
  assert.equal(c.llm.maxTokens, 16);
  assert.equal(c.llm.temperature, 0.7);
  assert.equal(c.conversation.micMode, 'off');
});

test('conversation language persists and unsupported values fall back to the default', () => {
  const { userPath, store } = tempStore();
  store.update({ conversation: { language: 'ru' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(userPath, 'utf8')), { conversation: { language: 'ru' } });
  assert.equal(new ConfigStore({ defaultPath: DEFAULT_PATH, userPath }).get().conversation.language, 'ru');
  assert.equal(store.update({ conversation: { language: 'tlh' } }).conversation.language, 'ru');
  assert.equal(store.update({ ui: { theme: 'neon' } }).ui.theme, 'system');
  assert.equal(store.update({ ui: { theme: 'light' } }).ui.theme, 'light');
});

test('persona is ordinary persisted configuration; the default is not stored', () => {
  const { userPath, store } = tempStore();
  const builtIn = () => store.get().characters.profiles.find((p) => p.id === 'default');
  const describe = (description) => store.update({ characters: { activeId: 'default', profiles: [{ id: 'default', description }] } });
  assert.equal(store.get().persona.prompt, '');
  assert.equal(builtIn().description, '', 'empty = default persona of the language pack');
  assert.equal(fs.existsSync(userPath), false, 'nothing is stored for an untouched persona');

  // the VC-M0 / VC-M1.1 key still works as input: its text becomes the description of the built-in profile
  store.update({ persona: { prompt: '  Ты — весёлая соседка.  ' } });
  const saved = JSON.parse(fs.readFileSync(userPath, 'utf8'));
  assert.equal(saved.characters.profiles[0].description, 'Ты — весёлая соседка.');
  assert.equal('persona' in saved, false, 'saved as a profile, not under the old key');
  const again = new ConfigStore({ defaultPath: DEFAULT_PATH, userPath }).get();
  assert.equal(again.characters.profiles[0].description, 'Ты — весёлая соседка.');
  assert.equal(again.persona.prompt, '');
  assert.equal(resolveLanguageProfile(again).llm.persona, 'Ты — весёлая соседка.');

  // writing the default text back is the same as resetting
  describe(LANGUAGES.ru.llm.defaultPersona);
  assert.equal(builtIn().description, '');
  assert.equal(resolveLanguageProfile(store.get()).llm.personaIsDefault, true);
  describe('x'.repeat(10000));
  assert.equal(builtIn().description.length, 4000);
  describe('');
  assert.equal(builtIn().description, '');
  assert.equal(JSON.parse(fs.readFileSync(userPath, 'utf8')).characters.profiles[0].description, '');
  assert.equal('systemPrompt' in store.get().llm, false, 'the old single system-prompt setting is gone');
});

test('unknown keys are ignored', () => {
  const { userPath, store } = tempStore();
  store.update({ llm: { apiKey: 'secret', model: 'm' }, bogus: { a: 1 } });
  const saved = JSON.parse(fs.readFileSync(userPath, 'utf8'));
  assert.deepEqual(saved, { llm: { model: 'm' } });
  assert.equal(store.get().llm.apiKey, undefined);
});

test('a corrupt user file does not prevent startup', () => {
  const { userPath } = tempStore();
  fs.writeFileSync(userPath, '{not json');
  const store = new ConfigStore({ defaultPath: DEFAULT_PATH, userPath });
  assert.match(store.loadError, /Could not read/);
  assert.equal(store.get().stt.model, 'small');
});

test('change event carries the new config', () => {
  const { store } = tempStore();
  let seen = null;
  store.on('change', (cfg) => { seen = cfg; });
  store.update({ tts: { voice: 'kseniya' } });
  assert.equal(seen.characters.profiles[0].voice.id, 'kseniya');
  assert.equal(resolveLanguageProfile(seen).tts.voice, 'kseniya');
});

test('a user file that cannot be written does not leave the configuration half-applied', () => {
  const { userPath, store } = tempStore();
  fs.mkdirSync(userPath);                       // a directory where the file should be: every write fails
  const seen = [];
  const errors = [];
  store.on('change', (cfg) => seen.push(cfg));
  store.on('saveError', (message) => errors.push(message));
  const cfg = store.update({ session: { historyTurns: 6 }, tts: { voice: 'baya' } });
  assert.equal(cfg.session.historyTurns, 6, 'the new settings are in effect for this run');
  assert.equal(store.get().session.historyTurns, 6);
  assert.equal(seen.length, 1, 'and announced like any change');
  assert.equal(resolveLanguageProfile(seen[0]).tts.voice, 'baya');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Could not write .*user\.json: /);
  assert.equal(store.saveError, errors[0]);
  // once the file can be written again the error is gone and everything set meanwhile is saved
  fs.rmSync(userPath, { recursive: true, force: true });
  store.update({ vad: { minSilenceMs: 450 } });
  assert.equal(store.saveError, null);
  const saved = JSON.parse(fs.readFileSync(userPath, 'utf8'));
  assert.equal(saved.session.historyTurns, 6);
  assert.equal(saved.characters.profiles[0].voice.id, 'baya');
});

test('deepMerge does not allow prototype pollution', () => {
  deepMerge({}, JSON.parse('{"__proto__": {"polluted": true}}'));
  assert.equal({}.polluted, undefined);
});
