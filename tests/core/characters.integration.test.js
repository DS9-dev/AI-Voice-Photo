'use strict';
/**
 * Character profiles through the real application path (VC-M1.2): Core +
 * orchestrator + voice-service client + LM Studio provider, running against
 * the FAKE voice service process and the FAKE LM Studio server.
 *
 * What is proved here is application logic: which system prompt is sent, when
 * the session is cleared, which voice the voice service is told to use, and
 * that a voice preview is not a conversation turn. It is not evidence about a
 * real model or a real voice.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Companion } = require('../../core');
const { ConfigStore } = require('../../core/config/configStore');
const { VoiceServiceClient } = require('../../core/providers/voiceServiceClient');
const { LANGUAGES, buildCoreInstructions } = require('../../core/language/languages');
const { CHANNELS, createHandlers, dispatch } = require('../../app/electron/appController');
const { createFakeLmStudio } = require('../fixtures/fake_lmstudio');

const ROOT = path.join(__dirname, '..', '..');
const FAKE = path.join(__dirname, '..', 'fixtures', 'fake_voice_service.js');
const DEFAULT_PATH = path.join(ROOT, 'config', 'default.json');
const PACK = LANGUAGES.ru;
const CORE = buildCoreInstructions(PACK);
const PREVIEW_TEXT = PACK.tts.silero.previewText;
/** CURRENT_PROMPT = the prompt accepted in VC-M1.1 with system rule 5 as corrected in VC-M1.2 (see tests/fixtures/acceptedPrompts.js). */
const { VC_M1_1_PROMPT, CURRENT_PROMPT, withCurrentCore } = require('../fixtures/acceptedPrompts');

const FRIEND = 'Ты — давняя подруга. Говоришь на «ты», легко и с юмором.';
const SESSION = 'Ты — психотерапевт на сессии. Говоришь спокойно и на «вы», не торопишься.';

async function waitFor(predicate, timeoutMs = 4000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function boot({ lm = {}, env = {}, user } = {}) {
  const fake = createFakeLmStudio(lm);
  const endpoint = await fake.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vvc-char-int-'));
  const userPath = path.join(dir, 'user.json');
  if (user) fs.writeFileSync(userPath, JSON.stringify(user));
  const configStore = new ConfigStore({ defaultPath: DEFAULT_PATH, userPath });
  configStore.update({ llm: { endpoint }, avatar: { engine: 'none' }, tts: { output: 'local' } });
  const voiceClient = new VoiceServiceClient({ command: process.execPath, args: [FAKE], env, helloTimeoutMs: 3000 });
  // everything the Core tells the voice service, in order
  const sent = [];
  const send = voiceClient.send.bind(voiceClient);
  voiceClient.send = (cmd) => { sent.push(JSON.parse(JSON.stringify(cmd))); return send(cmd); };
  const synth = [];
  voiceClient.on('tts_synth_done', (e) => synth.push(e));
  const ttsStates = [];
  voiceClient.on('status', (s) => { if (s.component === 'tts') ttsStates.push(s.state); });
  const app = new Companion({ rootDir: dir, overrides: { configStore, voiceClient, llmPollOkMs: 100000, llmPollFailMs: 100000 } });
  const ui = [];
  app.on('ui', (e) => ui.push(e));
  await app.start();
  await app.refreshLlm();
  await waitFor(() => app.statuses().stt.state !== 'loading' && app.statuses().tts.state !== 'loading');
  const turns = () => ui.filter((e) => e.type === 'turn').map((e) => e.payload);
  const ask = async (text, route = 'llm_only') => {
    const n = turns().length;
    const requests = fake.state.requests.length;
    assert.equal(app.sendText(text, route).accepted, true);
    await waitFor(() => turns().length === n + 1, 5000, `turn for «${text}»`);
    return { request: fake.state.requests[requests], turn: turns()[n] };
  };
  const saved = () => JSON.parse(fs.readFileSync(userPath, 'utf8'));
  return { app, fake, ui, dir, voiceClient, configStore, sent, synth, ttsStates, turns, ask, saved, async close() { await app.shutdown(); await fake.stop(); } };
}

const roles = (request) => request.messages.map((m) => m.role);
const systemOf = (request) => request.messages[0].content;
const active = (app) => { const c = app.charactersInfo(); return c.profiles.find((p) => p.id === c.activeId); };
const cleared = (ui) => ui.filter((e) => e.type === 'sessionCleared').length;

/** Built-in profile = the friend, a second profile = the session-style character with another voice. */
function twoCharacters(app) {
  app.saveCharacter('default', { characterName: 'Лена', description: FRIEND, voice: 'kseniya' });
  const made = app.createCharacter();
  app.saveCharacter(made.id, { displayName: 'Сессия', characterName: 'Анна', description: SESSION, voice: 'aidar' });
  app.selectCharacter('default');
  return made.id;
}

// ---------------------------------------------------------- default path --

test('an untouched installation sends exactly the VC-M1.1 system prompt (rule 5 as corrected in VC-M1.2) and speaks with xenia', async () => {
  const t = await boot();
  try {
    const c = t.app.charactersInfo();
    assert.equal(c.activeId, 'default');
    assert.deepEqual(c.profiles.map((p) => [p.id, p.builtIn, p.displayName, p.characterName, p.voice.id]), [['default', true, 'Собеседница', '', 'xenia']]);
    assert.equal(c.builtInId, 'default');
    assert.deepEqual(c.defaults, { description: PACK.llm.defaultPersona, voice: 'xenia' });
    assert.deepEqual(c.voices.map((v) => v.id).sort(), ['aidar', 'baya', 'eugene', 'kseniya', 'xenia']);
    assert.deepEqual([...c.voicesLoaded].sort(), ['aidar', 'baya', 'eugene', 'kseniya', 'xenia'], 'the list the loaded TTS engine reports');
    assert.equal(c.previewText, PREVIEW_TEXT);
    assert.equal(c.coreInstructions, CORE);

    const { request, turn } = await t.ask('Привет', 'llm_tts');
    assert.equal(systemOf(request), CURRENT_PROMPT, 'byte-identical to the prompt accepted in VC-M1.1 except system rule 5');
    assert.equal(systemOf(request), withCurrentCore(VC_M1_1_PROMPT));
    assert.equal(turn.counters.persona, 'default');
    assert.equal(turn.counters.character, 'default');
    assert.equal(turn.counters.ttsVoice, 'xenia');
    assert.equal(turn.counters.language.ttsVoice, 'xenia');
    assert.ok(t.synth.length > 0 && t.synth.every((e) => e.voice === 'xenia'));
    assert.equal(t.sent.find((c2) => c2.cmd === 'init').config.tts.voice, 'xenia');
    assert.equal(fs.existsSync(path.join(t.dir, 'user.json')) && 'characters' in t.saved(), false, 'nothing about profiles is stored until one is edited');
  } finally { await t.close(); }
});

test('a VC-M1.1 user.json with an edited persona and voice starts as the built-in profile and keeps both', async () => {
  const mine = 'Ты — Вера, спокойная и немногословная. Мы давно знакомы.';
  const t = await boot({ user: { persona: { prompt: mine }, tts: { voice: 'baya' }, session: { historyTurns: 4 } } });
  try {
    assert.ok(t.app.diagnostics().log.some((e) => e.source === 'characters' && /earlier configuration are now the built-in character profile/.test(e.message)));
    const a = active(t.app);
    assert.deepEqual([a.id, a.builtIn, a.description, a.descriptionIsDefault, a.voice.id], ['default', true, mine, false, 'baya']);
    const { request, turn } = await t.ask('Привет', 'llm_tts');
    assert.equal(systemOf(request), `[ЛИЧНОСТЬ]\n${mine}\n\n${CORE}`);
    assert.equal(turn.counters.ttsVoice, 'baya');
    assert.deepEqual(t.saved().characters, { activeId: 'default', profiles: [{ id: 'default', displayName: '', characterName: '', description: mine, voice: { provider: 'silero', id: 'baya' } }] });
    assert.equal('persona' in t.saved(), false);
    assert.equal(t.saved().session.historyTurns, 4);
    // «Сбросить описание» restores the default persona and leaves the voice alone
    t.app.resetCharacterDescription('default');
    assert.equal(active(t.app).descriptionIsDefault, true);
    assert.equal(active(t.app).voice.id, 'baya');
    assert.equal(systemOf((await t.ask('Привет ещё раз')).request), CURRENT_PROMPT);
  } finally { await t.close(); }
});

test('damaged profile data: the application starts with a usable profile and says what it repaired', async () => {
  const t = await boot({ user: { characters: { activeId: 'gone', profiles: [{ id: 'a', displayName: 'A', voice: { provider: 'silero', id: 'nope' } }, { id: 'a' }, 'junk'] } } });
  try {
    const log = t.app.diagnostics().log.filter((e) => e.source === 'characters').map((e) => e.message).join('\n');
    assert.match(log, /Active profile 'gone' does not exist; using the built-in profile/);
    assert.match(log, /voice 'nope' does not exist for silero; using the default voice 'xenia'/);
    assert.match(log, /Duplicate profile id 'a'/);
    assert.match(log, /Profile entry 3 was not readable/);
    const c = t.app.charactersInfo();
    assert.equal(c.activeId, 'default');
    assert.deepEqual(c.profiles.map((p) => p.id), ['default', 'a', 'a-2']);
    assert.ok(c.profiles.every((p) => p.voice.id === 'xenia'));
    assert.equal(systemOf((await t.ask('Привет')).request), CURRENT_PROMPT);
  } finally { await t.close(); }
});

// ------------------------------------------------------------- CRUD + IPC --

test('create, edit, duplicate, delete through the application: stored, announced to the UI, never zero profiles', async () => {
  const t = await boot();
  try {
    const made = t.app.createCharacter();
    assert.match(made.id, /^p-[0-9a-f]{8}$/);
    assert.equal(made.characters.activeId, made.id);
    assert.equal(made.sessionCleared, true);
    assert.deepEqual(t.saved().characters.profiles.map((p) => p.displayName), ['', 'Новый профиль']);

    const edited = t.app.saveCharacter(made.id, { displayName: 'Сессия', characterName: 'Анна', description: SESSION, voice: 'aidar' });
    assert.deepEqual(t.saved().characters.profiles[1], { id: made.id, displayName: 'Сессия', characterName: 'Анна', description: SESSION, voice: { provider: 'silero', id: 'aidar' } });
    assert.equal(edited.characters.revision > made.characters.revision, true);
    const last = t.ui.filter((e) => e.type === 'characters').pop().payload;
    assert.deepEqual(last.profiles.map((p) => p.displayName), ['Собеседница', 'Сессия']);
    assert.equal(last.activeId, made.id);

    const copy = t.app.duplicateCharacter(made.id);
    assert.notEqual(copy.id, made.id);
    assert.equal(copy.characters.activeId, copy.id);
    assert.deepEqual(copy.characters.profiles.map((p) => p.displayName), ['Собеседница', 'Сессия', 'Сессия (копия)']);
    assert.deepEqual({ ...t.saved().characters.profiles[2], id: 0, displayName: 0 }, { ...t.saved().characters.profiles[1], id: 0, displayName: 0 });

    // deleting a profile that is not active keeps the active one and the session
    const sessions = cleared(t.ui);
    const afterInactive = t.app.deleteCharacter(made.id);
    assert.equal(afterInactive.sessionCleared, false);
    assert.equal(afterInactive.characters.activeId, copy.id);
    assert.equal(cleared(t.ui), sessions);
    // deleting the active one: the built-in profile becomes active, new session
    const afterActive = t.app.deleteCharacter(copy.id);
    assert.equal(afterActive.sessionCleared, true);
    assert.equal(afterActive.characters.activeId, 'default');
    assert.deepEqual(afterActive.characters.profiles.map((p) => p.id), ['default']);
    assert.equal(cleared(t.ui), sessions + 1);
    assert.deepEqual(t.saved().characters, { activeId: 'default', profiles: [{ id: 'default', displayName: '', characterName: '', description: '', voice: { provider: 'silero', id: '' } }] });

    assert.throws(() => t.app.deleteCharacter('default'), /built-in profile cannot be deleted/);
    assert.throws(() => t.app.deleteCharacter('nope'), /does not exist/);
    assert.throws(() => t.app.selectCharacter('nope'), /does not exist/);
    assert.throws(() => t.app.saveCharacter('default', { voice: 'en_42' }), /Voice 'en_42' does not exist/);
    assert.equal(t.app.charactersInfo().profiles.length, 1);
    assert.equal(active(t.app).voice.id, 'xenia');
    // a restart of the application finds the same profiles
    const again = new ConfigStore({ defaultPath: DEFAULT_PATH, userPath: path.join(t.dir, 'user.json') });
    assert.deepEqual(again.get().characters, t.app.config.get().characters);
  } finally { await t.close(); }
});

test('the UI channels reach the same operations; failures come back as an error, not as an exception', async () => {
  const t = await boot();
  try {
    for (const channel of ['characters:select', 'characters:create', 'characters:duplicate', 'characters:delete', 'characters:save', 'characters:resetDescription', 'characters:previewVoice']) {
      assert.ok(CHANNELS.includes(channel), channel);
    }
    const preload = fs.readFileSync(path.join(ROOT, 'app', 'electron', 'preload.js'), 'utf8');
    for (const channel of CHANNELS) assert.ok(preload.includes(`'${channel}'`), `${channel} is allowed in the preload script`);
    const handlers = createHandlers(t.app);
    const call = (channel, payload) => dispatch(handlers, channel, payload);

    const snap = await call('app:snapshot');
    assert.equal(snap.data.characters.activeId, 'default');
    const made = await call('characters:create');
    assert.equal(made.ok, true);
    const id = made.data.id;
    assert.equal((await call('characters:save', { id, fields: { displayName: 'Сессия', description: SESSION, voice: 'aidar' } })).data.characters.profiles[1].displayName, 'Сессия');
    assert.equal((await call('characters:select', { id: 'default' })).data.characters.activeId, 'default');
    assert.equal((await call('characters:select', { id })).data.sessionCleared, true);
    const copy = await call('characters:duplicate', { id });
    assert.equal(copy.data.characters.profiles.length, 3);
    assert.equal((await call('characters:resetDescription', { id })).data.characters.profiles[1].descriptionIsDefault, true);
    assert.equal((await call('characters:delete', { id: copy.data.id })).data.characters.profiles.length, 2);
    const preview = await call('characters:previewVoice', { voice: 'baya' });
    assert.deepEqual([preview.ok, preview.data.ok, preview.data.voice], [true, true, 'baya']);

    assert.deepEqual(await call('characters:delete', { id: 'default' }), { ok: false, error: 'The built-in profile cannot be deleted' });
    assert.deepEqual(await call('characters:select', { id: 'nope' }), { ok: false, error: "Profile 'nope' does not exist" });
    assert.deepEqual(await call('characters:save', { id, fields: { voice: 'nope' } }), { ok: false, error: "Voice 'nope' does not exist" });
    const refused = await call('characters:previewVoice', { voice: 'nope' });
    assert.deepEqual([refused.ok, refused.data.ok, refused.data.error], [true, false, "Voice 'nope' does not exist"]);
  } finally { await t.close(); }
});

// -------------------------------------------- prompt through the app (K) --

test('K. the active profile is what the LLM receives: persona section from the profile, protected sections unchanged', async () => {
  const t = await boot();
  try {
    const second = twoCharacters(t.app);
    const a = await t.ask('Привет');
    assert.equal(systemOf(a.request), `[ЛИЧНОСТЬ]\nТебя зовут Лена.\n\n${FRIEND}\n\n${CORE}`);
    assert.equal(a.turn.counters.persona, 'custom');
    assert.equal(a.turn.counters.character, 'default');
    assert.equal(a.request.messages.filter((m) => m.role === 'system').length, 1);

    t.app.selectCharacter(second);
    const b = await t.ask('Здравствуйте');
    assert.equal(systemOf(b.request), `[ЛИЧНОСТЬ]\nТебя зовут Анна.\n\n${SESSION}\n\n${CORE}`);
    assert.equal(b.turn.counters.character, second);
    for (const absent of ['Лена', 'подруга', 'Сессия', second, 'aidar', 'kseniya']) assert.equal(JSON.stringify(b.request.messages).includes(absent), false, absent);
    // the same protected text in both, byte for byte
    assert.equal(systemOf(a.request).slice(-CORE.length), systemOf(b.request).slice(-CORE.length));
    assert.equal(systemOf(b.request).slice(-CORE.length), CURRENT_PROMPT.slice(-CORE.length));
  } finally { await t.close(); }
});

// ------------------------------------------------- session isolation (L) --

test('L. switching the profile starts a new session: nothing the previous character heard or said reaches the new one', async () => {
  const t = await boot({ lm: { reply: (body) => ({ content: `Ответ ${body.messages.length}: запомнила про красный автомобиль.` }) } });
  try {
    const second = twoCharacters(t.app);
    const session0 = t.app.history.sessionId;

    await t.ask('Меня зовут Олег, у меня красный автомобиль.');
    const followUp = await t.ask('Какого он цвета?');
    assert.deepEqual(roles(followUp.request), ['system', 'user', 'assistant', 'user'], 'inside one profile the session history is used');
    assert.equal(t.app.snapshot().conversation.historyTurns, 2);
    assert.equal(t.app.snapshot().messages.length, 4);

    const before = cleared(t.ui);
    const switched = t.app.selectCharacter(second);
    assert.equal(switched.sessionCleared, true);
    assert.equal(switched.sessionId, session0 + 1);
    assert.equal(cleared(t.ui), before + 1, 'the same Clear Session the button uses');
    assert.equal(t.app.snapshot().conversation.historyTurns, 0);
    assert.deepEqual(t.app.snapshot().messages, [], 'the transcript of the previous character is gone');
    assert.deepEqual(t.app.history.getMessages(), []);

    const first = await t.ask('Какого цвета мой автомобиль?');
    assert.deepEqual(roles(first.request), ['system', 'user']);
    const wire = JSON.stringify(first.request.messages);
    for (const leaked of ['Олег', 'красный автомобиль.', 'Ответ 2', 'Лена', 'подруга']) assert.equal(wire.includes(leaked), false, `«${leaked}» leaked into the new character's conversation`);
    assert.match(systemOf(first.request), /психотерапевт на сессии/);

    // selecting the profile that is already active is not a switch
    const same = t.app.selectCharacter(second);
    assert.equal(same.sessionCleared, false);
    assert.equal(t.app.snapshot().conversation.historyTurns, 1);

    // back again: the first character does not get the second one's conversation either, nor her own old one
    t.app.selectCharacter('default');
    const back = await t.ask('Привет');
    assert.deepEqual(roles(back.request), ['system', 'user']);
    assert.equal(JSON.stringify(back.request.messages).includes('психотерапевт'), false);
    assert.equal(JSON.stringify(back.request.messages).includes('Олег'), false);
  } finally { await t.close(); }
});

test('L. editing who the ACTIVE character is starts a new session; the profile name and the voice do not', async () => {
  const t = await boot();
  try {
    const second = twoCharacters(t.app);
    const talk = async () => { await t.ask('Запомни: мой кот — Барсик.'); assert.equal(t.app.snapshot().conversation.historyTurns, 1); };
    const kept = (result, what) => { assert.equal(result.sessionCleared, false, what); assert.equal(t.app.snapshot().conversation.historyTurns, 1, what); };
    const reset = (result, what) => { assert.equal(result.sessionCleared, true, what); assert.equal(t.app.snapshot().conversation.historyTurns, 0, what); assert.deepEqual(t.app.snapshot().messages, [], what); };

    await talk();
    kept(t.app.saveCharacter('default', { displayName: 'Моя Лена' }), 'profile name');
    kept(t.app.saveCharacter('default', { voice: 'baya' }), 'voice');
    kept(t.app.saveCharacter('default', { characterName: 'Лена', description: FRIEND }), 'saving the same name and description');
    kept(t.app.saveCharacter(second, { characterName: 'Мария', description: 'Ты — Мария.' }), 'another, inactive profile');
    const stillThere = await t.ask('Как зовут кота?');
    assert.deepEqual(roles(stillThere.request), ['system', 'user', 'assistant', 'user']);
    assert.match(systemOf(stillThere.request), /^\[ЛИЧНОСТЬ\]\nТебя зовут Лена\./);
    t.app.clearSession();

    await talk();
    reset(t.app.saveCharacter('default', { characterName: 'Вера' }), 'character name');
    const renamed = await t.ask('Как зовут кота?');
    assert.deepEqual(roles(renamed.request), ['system', 'user'], 'the conversation of «Лена» is not continued by «Вера»');
    assert.match(systemOf(renamed.request), /^\[ЛИЧНОСТЬ\]\nТебя зовут Вера\./);
    assert.equal(JSON.stringify(renamed.request.messages).includes('Барсик'), false);
    t.app.clearSession();

    await talk();
    reset(t.app.saveCharacter('default', { description: 'Ты — строгая преподавательница.' }), 'description');
    await talk();
    reset(t.app.resetCharacterDescription('default'), 'reset of an edited description');
    await talk();
    kept(t.app.resetCharacterDescription('default'), 'reset of a description that already is the default');
    reset(t.app.createCharacter(), 'a new profile becomes active');
    await talk();
    reset(t.app.duplicateCharacter('default'), 'a copy becomes active');
  } finally { await t.close(); }
});

test('L. switching while she is answering stops that answer; it never enters the new conversation', async () => {
  const t = await boot({ lm: { reply: () => ({ content: 'Первое предложение подруги. Второе предложение подруги. Третье предложение подруги. Четвёртое предложение подруги.', chunkDelayMs: 60 }) } });
  try {
    const second = twoCharacters(t.app);
    assert.equal(t.app.sendText('Расскажи что-нибудь', 'llm_tts').accepted, true);
    await waitFor(() => t.ui.some((e) => e.type === 'assistantDelta'), 4000, 'first reply text');
    const switched = t.app.selectCharacter(second);
    assert.equal(switched.sessionCleared, true);
    await waitFor(() => t.turns().length === 1, 4000, 'stopped turn');
    assert.equal(t.turns()[0].outcome, 'stopped');
    assert.equal(t.app.snapshot().conversation.state, 'LISTENING');
    assert.deepEqual(t.app.history.getMessages(), []);
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(t.app.history.getMessages(), [], 'the stopped reply is not added afterwards');
    assert.deepEqual(t.app.snapshot().messages, []);
    t.fake.state.reply = () => ({ content: 'Здравствуйте.' });
    const next = await t.ask('Здравствуйте');
    assert.deepEqual(roles(next.request), ['system', 'user']);
    assert.equal(JSON.stringify(next.request.messages).includes('подруги'), false);
  } finally { await t.close(); }
});

test('L. words still being transcribed when the character changes are not answered by the new character', async () => {
  const t = await boot({ env: { FAKE_STT_MS: '400' } });
  try {
    const second = twoCharacters(t.app);
    t.app.setMicMode('full');
    await waitFor(() => t.ui.some((e) => e.type === 'listening' && e.payload.enabled), 3000, 'microphone open');
    t.voiceClient.send({ cmd: '_sim_utterance', text: 'Лена, помнишь, что я говорил про красный автомобиль?' });
    await waitFor(() => t.app.snapshot().conversation.transcribing, 3000, 'transcribing');
    const switched = t.app.selectCharacter(second);
    assert.equal(switched.sessionCleared, true);
    assert.equal(t.app.snapshot().conversation.transcribing, false);
    await new Promise((r) => setTimeout(r, 700));            // the transcript arrives meanwhile
    assert.equal(t.fake.state.requests.length, 0, 'no request to the LLM');
    assert.equal(t.turns().length, 0);
    assert.deepEqual(t.app.snapshot().messages, []);
    assert.ok(t.ui.some((e) => e.type === 'rejected' && e.payload.source === 'voice'), 'the dropped utterance is reported, not silently lost');
    assert.equal(t.app.snapshot().conversation.state, 'LISTENING');
    // the microphone works for the new character
    await waitFor(() => t.ui.filter((e) => e.type === 'listening').pop().payload.enabled, 3000, 'microphone open again');
    t.voiceClient.send({ cmd: '_sim_utterance', text: 'Здравствуйте.' });
    await waitFor(() => t.turns().length === 1, 6000, 'turn of the new character');
    const request = t.fake.state.requests[0];
    assert.deepEqual(roles(request), ['system', 'user']);
    assert.match(systemOf(request), /^\[ЛИЧНОСТЬ\]\nТебя зовут Анна\./);
    assert.equal(JSON.stringify(request.messages).includes('красный автомобиль'), false);
  } finally { await t.close(); }
});

test('a profile change that cannot be saved is still applied completely, and the failure is shown', async () => {
  const t = await boot();
  try {
    const second = twoCharacters(t.app);
    const userPath = path.join(t.dir, 'user.json');
    fs.rmSync(userPath);
    fs.mkdirSync(userPath);                       // every write fails from here on
    const revision = t.app.charactersInfo().revision;
    const switched = t.app.selectCharacter(second);
    assert.equal(switched.characters.activeId, second);
    assert.ok(switched.characters.revision > revision, 'the UI is told about the new state');
    assert.equal(t.ui.filter((e) => e.type === 'characters').pop().payload.activeId, second);
    assert.equal(t.sent.filter((c) => c.cmd === 'configure').pop().config.tts.voice, 'aidar', 'the voice service gets the new voice');
    const problem = t.ui.filter((e) => e.type === 'problem' && e.payload.source === 'config').pop();
    assert.match(problem.payload.message, /were not saved\. Could not write .*user\.json/);
    const { request, turn } = await t.ask('Здравствуйте', 'llm_tts');
    assert.match(systemOf(request), /^\[ЛИЧНОСТЬ\]\nТебя зовут Анна\./);
    assert.equal(turn.counters.ttsVoice, 'aidar', 'persona and voice belong to the same character');
  } finally { await t.close(); }
});

test('ids arriving from the UI are handled as the strings they stand for', async () => {
  const t = await boot();
  try {
    const second = twoCharacters(t.app);
    await t.ask('Привет');
    const renamed = t.app.saveCharacter(['default'], { characterName: 'Вера' });
    assert.equal(renamed.sessionCleared, true, 'the active character changed, however the id was spelled');
    t.app.selectCharacter(second);
    const deleted = t.app.deleteCharacter([second]);
    assert.equal(deleted.sessionCleared, true);
    assert.equal(deleted.characters.activeId, 'default');
    for (const bad of [undefined, null, {}, 42, '']) {
      assert.throws(() => t.app.selectCharacter(bad), /does not exist/);
      assert.throws(() => t.app.saveCharacter(bad, { characterName: 'X' }), /does not exist/);
      assert.throws(() => t.app.deleteCharacter(bad), /does not exist/);
      assert.throws(() => t.app.duplicateCharacter(bad), /does not exist/);
    }
    assert.equal(t.app.saveCharacter('default', null).sessionCleared, false);
    assert.equal(t.app.charactersInfo().profiles.length, 1);
  } finally { await t.close(); }
});

// ----------------------------------------------------- voice routing (M) --

test('M. the voice of the active profile is what the voice service speaks with; a change applies to the next synthesis without a restart', async () => {
  const t = await boot();
  try {
    const pid = t.voiceClient.hello.pid;
    const statesAtStart = t.ttsStates.length;
    const second = twoCharacters(t.app);       // built-in: kseniya, second: aidar; built-in active
    const configured = () => t.sent.filter((c) => c.cmd === 'configure').map((c) => c.config.tts.voice);
    assert.equal(configured().pop(), 'kseniya');

    // no waiting between the change and the next sentence: a stale voice would show here
    const a = await t.ask('Привет', 'llm_tts');
    assert.equal(a.turn.counters.ttsVoice, 'kseniya');
    assert.equal(a.turn.counters.language.ttsVoice, 'kseniya');

    t.app.selectCharacter(second);
    const b = await t.ask('Здравствуйте', 'llm_tts');
    assert.equal(b.turn.counters.ttsVoice, 'aidar');
    assert.equal(b.turn.counters.character, second);

    t.app.saveCharacter(second, { voice: 'eugene' });           // edit the voice of the active profile
    const c = await t.ask('И ещё раз', 'llm_tts');
    assert.equal(c.turn.counters.ttsVoice, 'eugene');
    assert.equal(t.app.snapshot().conversation.historyTurns, 2, 'changing the voice keeps the conversation');

    t.app.selectCharacter('default');
    const d = await t.ask('Привет', 'llm_tts');
    assert.equal(d.turn.counters.ttsVoice, 'kseniya');

    // every sentence of each turn was spoken by that turn's voice (as reported by the service)
    const byTurn = (turn) => t.synth.filter((e) => e.turnId === turn.turnId).map((e) => e.voice);
    for (const [turn, voice] of [[a.turn, 'kseniya'], [b.turn, 'aidar'], [c.turn, 'eugene'], [d.turn, 'kseniya']]) {
      assert.ok(byTurn(turn).length > 0);
      assert.deepEqual([...new Set(byTurn(turn))], [voice]);
    }
    // conversation turns never name a voice themselves: one source of truth, the configuration
    assert.equal(t.sent.filter((c2) => c2.cmd === 'tts_speak').some((c2) => 'voice' in c2), false);
    assert.deepEqual(configured().slice(-4), ['kseniya', 'aidar', 'eugene', 'kseniya']);

    // no restart, no reload
    assert.equal(t.voiceClient.hello.pid, pid);
    assert.equal(t.sent.filter((c2) => c2.cmd === 'init').length, 1);
    await waitFor(() => t.app.languageStatus().tts.voiceLoaded === 'kseniya');
    assert.deepEqual([...new Set(t.ttsStates.slice(statesAtStart))], ['ready'], 'TTS stays ready: the model is not reloaded for a voice change');
    assert.equal(t.app.languageStatus().coherent, true);
    assert.equal(t.app.languageStatus().tts.voice, 'kseniya');
    assert.deepEqual(t.app.languageStatus().character, { id: 'default', builtIn: true, displayName: 'Собеседница', characterName: 'Лена' });
  } finally { await t.close(); }
});

// ----------------------------------------------------- voice preview (N) --

test('N. voice preview: the selected voice speaks the fixed sentence through TTS; no LLM, no chat message, no history, no turn', async () => {
  const t = await boot();
  try {
    t.app.setMicMode('full');
    await waitFor(() => t.ui.some((e) => e.type === 'listening' && e.payload.enabled), 3000, 'microphone open');
    const mark = t.sent.length;
    const messages = t.ui.filter((e) => e.type === 'message').length;

    const pending = t.app.previewVoice({ voice: 'eugene' });
    assert.equal(t.app.snapshot().conversation.state, 'SPEAKING', 'the microphone is gated like for any speech of hers');
    assert.equal(t.app.sendText('Привет').accepted, false, 'no turn can start over a preview');
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.voice, 'eugene', 'the voice the TTS engine reports it used');
    assert.ok(result.audioMs > 0 && result.synthMs >= 0);
    assert.equal(t.app.snapshot().conversation.state, 'LISTENING');

    const cmds = t.sent.slice(mark);
    const speak = cmds.filter((c) => c.cmd === 'tts_speak');
    assert.ok(speak.length >= 1);
    assert.ok(speak.every((c) => c.voice === 'eugene'));
    assert.equal(speak.map((c) => c.text).join(' '), PREVIEW_TEXT, 'the fixed preview sentence, nothing else');
    assert.ok(speak.every((c) => /^preview\d+$/.test(c.turn_id)));
    assert.deepEqual(cmds.filter((c) => c.cmd === 'set_listening').map((c) => c.enabled), [false, true], 'gate closed for the sample, reopened after it');
    assert.equal(cmds.some((c) => c.cmd === 'configure' || c.cmd === 'init'), false, 'no reconfiguration, no restart');
    assert.ok(t.synth.filter((e) => /^preview/.test(e.turnId)).every((e) => e.voice === 'eugene'));

    assert.equal(t.fake.state.requests.length, 0, 'the LLM is not asked');
    assert.equal(t.ui.filter((e) => e.type === 'message').length, messages, 'no chat message, real or fake');
    assert.equal(t.ui.filter((e) => e.type === 'assistantDelta').length, 0);
    assert.deepEqual(t.app.snapshot().messages, []);
    assert.deepEqual(t.app.history.getMessages(), []);
    assert.equal(t.app.snapshot().conversation.historyTurns, 0);
    assert.equal(t.turns().length, 0, 'not a conversation turn');
    assert.equal(t.app.diagnostics().turns.length, 0);
    assert.equal(fs.existsSync(path.join(t.dir, 'user.json')) && 'characters' in t.saved(), false, 'listening saves nothing');
    assert.equal(active(t.app).voice.id, 'xenia');

    // the conversation voice is untouched by the preview
    const turn = await t.ask('Привет', 'llm_tts');
    assert.equal(turn.turn.counters.ttsVoice, 'xenia');
    assert.equal(t.sent.filter((c) => c.cmd === 'tts_speak' && !/^preview/.test(c.turn_id)).some((c) => 'voice' in c), false);

    // every voice of the list can be previewed, each with its own voice
    for (const voice of t.app.charactersInfo().voices.map((v) => v.id)) {
      const r = await t.app.previewVoice({ voice });
      assert.deepEqual([r.ok, r.voice], [true, voice]);
    }
    // without an explicit voice: the voice of the active profile
    assert.equal((await t.app.previewVoice()).voice, 'xenia');
    assert.equal(t.app.snapshot().conversation.historyTurns, 1);
    assert.equal(t.fake.state.requests.length, 1);
  } finally { await t.close(); }
});

test('N. voice preview failures are returned to the caller and leave the conversation alone', async () => {
  const t = await boot({ lm: { reply: () => ({ content: 'Одно предложение. Второе предложение. Третье предложение.', chunkDelayMs: 50 }) } });
  try {
    const speakCount = () => t.sent.filter((c) => c.cmd === 'tts_speak').length;
    // unknown voice / another provider: refused before anything is sent
    assert.deepEqual(await t.app.previewVoice({ voice: 'en_42' }), { ok: false, voice: 'en_42', error: "Voice 'en_42' does not exist" });
    assert.deepEqual(await t.app.previewVoice({ voice: 'random' }), { ok: false, voice: 'random', error: "Voice 'random' does not exist" });
    assert.deepEqual(await t.app.previewVoice({ voice: { provider: 'other-tts', id: 'nova' } }), { ok: false, voice: 'nova', error: "Voice provider 'other-tts' is not the active TTS provider" });
    assert.equal(speakCount(), 0);

    // while she is thinking or speaking: refused, the turn goes on
    assert.equal(t.app.sendText('Привет', 'llm_tts').accepted, true);
    const busy = await t.app.previewVoice({ voice: 'baya' });
    assert.equal(busy.ok, false);
    assert.equal(busy.busy, true);
    assert.match(busy.error, /not possible now: busy/);
    await waitFor(() => t.turns().length === 1, 6000);
    assert.equal(t.turns()[0].outcome, 'ok');
    assert.equal(t.sent.filter((c) => c.cmd === 'tts_speak').some((c) => c.voice), false);

    // stopped by the user
    const pending = t.app.previewVoice({ voice: 'baya' });
    t.app.stop();
    const stopped = await pending;
    assert.deepEqual([stopped.ok, stopped.stopped], [false, true]);
    assert.equal(t.app.snapshot().conversation.state, 'LISTENING');
    assert.equal(t.turns().length, 1);
    assert.equal(t.app.snapshot().messages.filter((m) => m.role === 'system').length, 0);
  } finally { await t.close(); }
});

test('N. a preview that the TTS engine cannot synthesize reports the engine error; nothing is written into the chat', async () => {
  const t = await boot({ env: { FAKE_FAIL: 'synth' } });
  try {
    const r = await t.app.previewVoice({ voice: 'kseniya' });
    assert.equal(r.ok, false);
    assert.equal(r.voice, 'kseniya');
    assert.match(r.error, /synth failed/);
    assert.equal(t.app.snapshot().conversation.state, 'LISTENING');
    assert.deepEqual(t.app.snapshot().messages, [], 'no system message in the conversation');
    assert.equal(t.turns().length, 0);
    assert.ok(t.app.diagnostics().log.some((e) => e.source === 'preview' && e.level === 'error'));
  } finally { await t.close(); }
});
