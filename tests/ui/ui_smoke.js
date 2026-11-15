'use strict';
/**
 * UI smoke test (developer tool, optional): loads the real renderer in
 * Chromium via Playwright and drives it against the real Core wired to the
 * FAKE voice service and FAKE LM Studio. Skips if Playwright is unavailable.
 *
 *   node tests/ui/ui_smoke.js [screenshot-dir]
 *
 * This checks UI wiring only. It is not live evidence for any model.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadPlaywright() {
  for (const id of ['playwright', '/opt/npm-tools/node_modules/playwright']) {
    try { return require(id); } catch { /* try next */ }
  }
  return null;
}

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log('SKIPPED: Playwright is not installed (optional developer test).');
    return;
  }
  const ROOT = path.join(__dirname, '..', '..');
  const shotDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'vvc-ui-'));
  fs.mkdirSync(shotDir, { recursive: true });

  const { Companion } = require(path.join(ROOT, 'core'));
  const { ConfigStore } = require(path.join(ROOT, 'core', 'config', 'configStore'));
  const { VoiceServiceClient } = require(path.join(ROOT, 'core', 'providers', 'voiceServiceClient'));
  const { createHandlers, dispatch } = require(path.join(ROOT, 'app', 'electron', 'appController'));
  const { createFakeLmStudio } = require(path.join(ROOT, 'tests', 'fixtures', 'fake_lmstudio'));

  const fake = createFakeLmStudio({
    reply: (body) => {
      const last = body.messages[body.messages.length - 1].content;
      const knows = body.messages.some((m) => /красный/.test(m.content));
      if (/цвета/.test(last)) return { content: knows ? 'Он был красный, ты сам говорил.' : 'Я не знаю, о каком автомобиле речь.', chunkDelayMs: 10 };
      return { content: 'Привет! Рада тебя слышать сегодня. Расскажи, как прошёл твой день?', chunkDelayMs: 25 };
    },
  });
  const endpoint = await fake.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vvc-ui-root-'));
  const configStore = new ConfigStore({ defaultPath: path.join(ROOT, 'config', 'default.json'), userPath: path.join(dir, 'user.json') });
  configStore.update({ llm: { endpoint }, avatar: { engine: 'none' }, tts: { output: 'local' } });
  const voiceClient = new VoiceServiceClient({
    command: process.execPath,
    args: [path.join(ROOT, 'tests', 'fixtures', 'fake_voice_service.js')],
    env: { FAKE_AUDIO_MS: '500', FAKE_SYNTH_MS: '40' },
  });
  const companion = new Companion({ rootDir: dir, overrides: { configStore, voiceClient, llmPollOkMs: 100000, llmPollFailMs: 100000 } });
  const handlers = createHandlers(companion);

  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.exposeFunction('__vvcInvoke', (channel, payload) => dispatch(handlers, channel, payload));
  await page.addInitScript(() => {
    window.__vvcQueue = [];
    window.vvc = {
      invoke: (channel, payload) => window.__vvcInvoke(channel, payload),
      onEvent: (cb) => { window.__vvcCb = cb; for (const e of window.__vvcQueue) cb(e); window.__vvcQueue = []; },
    };
    window.__vvcPush = (e) => { if (window.__vvcCb) window.__vvcCb(e); else window.__vvcQueue.push(e); };
  });
  let chain = Promise.resolve();
  companion.on('ui', (e) => { chain = chain.then(() => page.evaluate((ev) => window.__vvcPush(ev), e)).catch(() => {}); });

  const shot = (name) => page.screenshot({ path: path.join(shotDir, `${name}.png`) });
  const badge = () => page.textContent('#stateBadge');
  const chipState = (name) => page.getAttribute(`.chip[data-component="${name}"]`, 'data-state');
  const steps = [];
  const step = async (name, fn) => { await fn(); steps.push(name); console.log(`ok - ${name}`); };

  const state = (text) => page.waitForFunction((t) => document.getElementById('stateBadge').textContent === t, text, { timeout: 15000 });
  const idle = () => page.waitForFunction(() => document.getElementById('stateBadge').textContent.startsWith('READY'), null, { timeout: 15000 });
  const nav = (name) => page.click(`.nav-item[data-page="${name}"]`);

  try {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`file://${path.join(ROOT, 'app', 'renderer', 'index.html')}`);
    await companion.start();
    await companion.refreshLlm();

    await step('shell: titlebar, sidebar, bottom status strip, photo stage; avatar engine not configured', async () => {
      for (const name of ['MIC', 'STT', 'LLM', 'TTS']) {
        await page.waitForSelector(`.chip[data-component="${name}"][data-state="ready"]`, { timeout: 5000 });
      }
      assert.equal(await chipState('AVATAR'), 'not_configured');
      assert.match(await page.textContent('.chip[data-component="AVATAR"]'), /не настроен/);
      assert.equal(await page.isVisible('#photoStage'), true, 'the chat page shows the photo stage');
      assert.match(await page.textContent('#photoEmpty'), /Загрузите фотографию/);
      assert.match(await badge(), /READY · MIC OFF/);
      assert.deepEqual(await page.$$eval('.nav-item', (n) => n.map((x) => x.dataset.page)), ['chat', 'models', 'diagnostics', 'settings']);
      assert.deepEqual(await page.$$eval('.nav-item span', (n) => n.map((x) => x.textContent)), ['Чат', 'Модели', 'Диагностика', 'Настройки']);
      assert.equal(await page.locator('.window-controls button').count(), 3);
      const box = await page.locator('.statusbar').boundingBox();
      assert.ok(box.y > 700, 'status strip is at the bottom');
      assert.equal(await page.locator('[data-i18n]:empty').count(), 0, 'every labelled element has text');
      await shot('01-chat-idle');
    });

    await step('GUI self-test probes work against the real renderer', async () => {
      const { DOM_PROBE_SCRIPT, DIAG_PROBE_SCRIPT, evaluate } = require(path.join(ROOT, 'app', 'electron', 'selfTest'));
      const dom = await page.evaluate(DOM_PROBE_SCRIPT);
      const diag = await page.evaluate(DIAG_PROBE_SCRIPT);
      const checks = evaluate({ dom, diag, statuses: companion.statuses(), consoleErrors, windowVisible: true });
      assert.deepEqual(checks.filter((c) => !c.ok), [], JSON.stringify(checks.filter((c) => !c.ok)));
      await nav('chat');
    });

    await step('typed text -> LLM -> TTS shows THINKING, SPEAKING, transcript, then ready', async () => {
      const seen = new Set();
      const poll = setInterval(async () => { try { seen.add(await badge()); } catch { /* closing */ } }, 15);
      await page.fill('#textInput', 'Привет');
      await page.click('#sendBtn');
      await page.waitForSelector('.msg.user');
      await state('SPEAKING');
      assert.equal(await page.textContent('#statePill'), 'Говорю');
      assert.equal(await page.isDisabled('#sendBtn'), true, 'Send disabled while busy');
      assert.equal(await page.isDisabled('#stopBtn'), false, 'Stop enabled while busy');
      await shot('02-chat-speaking');
      await idle();
      clearInterval(poll);
      assert.ok(seen.has('THINKING') && seen.has('SPEAKING'), `states seen: ${[...seen].join(', ')}`);
      assert.match(await page.textContent('.msg.assistant .body'), /Привет! Рада тебя слышать сегодня\. Расскажи, как прошёл твой день\?/);
      assert.equal(await page.locator('.msg.assistant').count(), 1, 'streamed bubble replaced, not duplicated');
      assert.equal(await page.inputValue('#textInput'), '');
      assert.match(await page.textContent('#lastTurn'), /до первого звука \d+ мс/);
    });

    await step('full pipeline via simulated utterance; microphone gate shown', async () => {
      await page.selectOption('#micMode', 'full');
      await state('LISTENING');
      assert.match(await page.textContent('.chip[data-component="MIC"]'), /слушает/);
      voiceClient.send({ cmd: '_sim_utterance', text: 'Как тебя зовут?', speech_ms: 700 });
      await page.waitForFunction(() => document.getElementById('sttText').textContent === 'Как тебя зовут?', null, { timeout: 5000 });
      await state('SPEAKING');
      assert.match(await page.textContent('.chip[data-component="MIC"]'), /пауза/);
      await state('LISTENING');
      assert.match(await page.textContent('#transcript'), /Вы \(голос\)/);
      await shot('03-chat-after-voice');
    });

    await step('STT-only mode shows the transcript without calling the LLM', async () => {
      const before = fake.state.requests.length;
      await page.selectOption('#micMode', 'stt_only');
      await new Promise((r) => setTimeout(r, 150));
      voiceClient.send({ cmd: '_sim_utterance', text: 'Проверка распознавания' });
      await page.waitForFunction(() => document.getElementById('sttText').textContent === 'Проверка распознавания', null, { timeout: 5000 });
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(fake.state.requests.length, before);
      await page.selectOption('#micMode', 'off');
    });

    await step('TTS-only and LLM-only routes', async () => {
      const before = fake.state.requests.length;
      await page.selectOption('#routeSelect', 'tts_only');
      await page.fill('#textInput', 'Проверка голоса.');
      await page.press('#textInput', 'Enter');
      await state('SPEAKING');
      await idle();
      assert.equal(fake.state.requests.length, before, 'no LLM request for TTS-only');
      await page.selectOption('#routeSelect', 'llm_only');
      await page.fill('#textInput', 'Меня интересует красный автомобиль.');
      await page.click('#sendBtn');
      await page.waitForFunction((n) => document.querySelectorAll('.msg.assistant:not(.partial)').length === n, 3, { timeout: 8000 });
      await idle();
    });

    await step('session context then Clear Session', async () => {
      await page.fill('#textInput', 'А какого он был цвета?');
      await page.click('#sendBtn');
      await page.waitForFunction(() => /Он был красный/.test(document.getElementById('transcript').textContent), null, { timeout: 8000 });
      await idle();
      await page.click('#clearBtn');
      await page.waitForFunction(() => document.getElementById('transcript').children.length === 0);
      assert.match(await page.textContent('#sessionInfo'), /в контексте 0 из 10/);
      await page.fill('#textInput', 'А какого он был цвета?');
      await page.click('#sendBtn');
      await page.waitForFunction(() => /Я не знаю/.test(document.getElementById('transcript').textContent), null, { timeout: 8000 });
      await idle();
      await page.selectOption('#routeSelect', 'llm_tts');
    });

    await step('Models page: provider settings, applied immediately', async () => {
      await nav('models');
      assert.equal(await page.inputValue('#cfgLlmEndpoint'), endpoint);
      assert.equal(await page.inputValue('#cfgSttModel'), 'small');
      assert.match(await page.textContent('#llmStatus'), /qwen\/qwen3\.5-9b/);
      assert.match(await page.textContent('#cfgLlmModel'), /qwen\/qwen3\.5-9b \(загружена\)/);
      assert.equal((await page.textContent('#cfgLlmModel')).includes('embedding'), false);
      // VC-M1.2: the voice belongs to the character profile; Models only shows which one is in use
      assert.match(await page.textContent('#ttsVoiceValue'), /^xenia \(женский\) · Собеседница$/);
      assert.equal(await page.locator('#page-models select#cfgTtsVoice, #page-models #charVoice').count(), 0, 'the voice is not edited on Models');
      assert.equal(await page.textContent('#cfgTtsModel'), 'v5_5_ru');
      assert.match(await page.textContent('#ttsLanguageNote'), /Язык: Русский/);
      assert.equal(await page.locator('#page-models #cfgLanguage, #page-models #cfgMic, #page-models #cfgHistory, #page-models #charDescription, #cfgLlmPrompt').count(), 0, 'app-level settings are not duplicated on Models');
      await page.fill('#cfgLlmTemp', '0.6');
      await page.press('#cfgLlmTemp', 'Tab');
      await page.waitForFunction(() => /Сохранено/.test(document.getElementById('modelsNote').textContent));
      const saved = () => JSON.parse(fs.readFileSync(path.join(dir, 'user.json'), 'utf8'));
      assert.equal(saved().llm.temperature, 0.6);
      await shot('04-models');
    });

    await step('Settings page: conversation language (Русский), history, audio devices', async () => {
      await nav('settings');
      await page.waitForFunction(() => document.getElementById('cfgMic').options.length >= 3, null, { timeout: 5000 });
      assert.equal(await page.inputValue('#cfgLanguage'), 'ru');
      assert.equal(await page.$eval('#cfgLanguage', (s) => s.selectedOptions[0].textContent), 'Русский');
      assert.equal(await page.inputValue('#cfgHistory'), '10');
      assert.match(await page.textContent('#cfgMic'), /Fake Microphone \(по умолчанию\)/);
      await page.fill('#cfgHistory', '4');
      await page.press('#cfgHistory', 'Tab');
      await page.fill('#cfgVadSilence', '500');
      await page.press('#cfgVadSilence', 'Tab');
      await page.selectOption('#cfgMic', 'Fake Headset Mic');
      await page.waitForFunction(() => /Сохранено/.test(document.getElementById('settingsNote').textContent));
      await new Promise((r) => setTimeout(r, 200));
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'user.json'), 'utf8'));
      assert.equal(saved.session.historyTurns, 4);
      assert.equal(saved.vad.minSilenceMs, 500);
      assert.equal(saved.audio.inputDevice, 'Fake Headset Mic');
      // the per-turn notes: two independent switches, both off until the owner's manual acceptance
      assert.equal(await page.isChecked('#cfgPremiseCheck'), false);
      assert.equal(await page.isChecked('#cfgLengthVariation'), false);
      assert.match(await page.textContent('label[for="cfgPremiseCheck"]'), /Не соглашаться с несделанным/);
      assert.match(await page.textContent('label[for="cfgLengthVariation"]'), /Разная длина ответов/);
      await page.click('#cfgLengthVariation');
      await page.waitForFunction(() => document.getElementById('cfgLengthVariation').checked);
      await new Promise((r) => setTimeout(r, 300));
      const switched = JSON.parse(fs.readFileSync(path.join(dir, 'user.json'), 'utf8'));
      assert.equal(switched.conversation.lengthVariation, true);
      assert.notEqual(switched.conversation.premiseCheck, true, 'the other switch is independent');
      await page.click('#cfgLengthVariation');
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'user.json'), 'utf8')).conversation.lengthVariation, false);
      await shot('05-settings');
    });

    const savedUser = () => JSON.parse(fs.readFileSync(path.join(dir, 'user.json'), 'utf8'));
    const DEFAULT_PERSONA = /^Ты — девушка, которая находится в одной комнате с собеседником и разговаривает с ним вживую\./;
    const charNote = (re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('characterNote').textContent), re.source, { timeout: 8000 });
    const askLlm = async (text) => {
      await nav('chat');
      await page.selectOption('#routeSelect', 'llm_only');
      const before = fake.state.requests.length;
      await page.fill('#textInput', text);
      await page.click('#sendBtn');
      await page.waitForFunction(() => document.querySelectorAll('#transcript .msg.assistant:not(.partial)').length > 0, null, { timeout: 8000 });
      await idle();
      await page.selectOption('#routeSelect', 'llm_tts');
      return fake.state.requests[before];
    };

    await step('Settings → Персонаж: the built-in profile is the earlier persona; protected instructions are read-only', async () => {
      await nav('settings');
      assert.equal(await page.textContent('#characterCard h3'), 'Персонаж');
      assert.deepEqual(await page.$$eval('#charProfile option', (o) => o.map((x) => x.textContent)), ['Собеседница (встроенный)']);
      assert.equal(await page.inputValue('#charDisplayName'), 'Собеседница');
      assert.equal(await page.inputValue('#charName'), '');
      assert.match(await page.inputValue('#charDescription'), DEFAULT_PERSONA);
      assert.equal(await page.inputValue('#charVoice'), 'xenia');
      assert.deepEqual(await page.$$eval('#charVoice option', (o) => o.map((x) => x.value)), ['xenia', 'kseniya', 'baya', 'aidar', 'eugene']);
      assert.match(await page.textContent('#charVoice'), /xenia \(женский\) · по умолчанию/);
      for (const id of ['charSaveBtn', 'charCancelBtn', 'charDeleteBtn', 'charResetDescriptionBtn']) assert.equal(await page.isDisabled(`#${id}`), true, id);
      for (const id of ['charNewBtn', 'charDuplicateBtn', 'charPreviewBtn', 'charProfile']) assert.equal(await page.isDisabled(`#${id}`), false, id);
      assert.equal(await page.textContent('#characterState'), '');
      await page.click('#characterCard details summary');
      assert.match(await page.textContent('#coreRules'), /1\. Говори только по-русски\./);
      // VC-M1.1: the protected natural-conversation contract is shown in the same read-only block, before the system rules
      assert.match(await page.textContent('#coreRules'), /^\[КАК ВЕСТИ РАЗГОВОР\]\nТы собеседница: участвуешь в разговоре, а не ведёшь его/);
      assert.match(await page.textContent('#coreRules'), /\n\n\[ПРАВИЛА СИСТЕМЫ\]\n1\. Говори только по-русски\./);
      assert.equal(await page.textContent('#characterCard details summary'), 'Как вести разговор и правила системы (добавляются автоматически, не редактируются)');
      assert.match(await page.textContent('#coreRules'), /Никогда не говори, что ты что-то приготовила, налила, принесла, достала, подала, передала или включила, что делаешь это сейчас или сейчас сделаешь/);
      assert.equal(await page.locator('#coreRules').evaluate((n) => n.tagName), 'PRE', 'system rules are read-only text');
      await page.click('#characterCard details summary');
    });

    await step('Settings → Персонаж: edits are a draft until «Сохранить»; «Отменить» restores; saving the active character starts a new conversation', async () => {
      await page.fill('#charDescription', 'Ты — Мила, весёлая и любопытная.');
      assert.equal(await page.textContent('#characterState'), 'не сохранено');
      for (const id of ['charProfile', 'charNewBtn', 'charDuplicateBtn', 'charDeleteBtn']) assert.equal(await page.isDisabled(`#${id}`), true, `${id} is locked while there are unsaved changes`);
      for (const id of ['charSaveBtn', 'charCancelBtn', 'charResetDescriptionBtn']) assert.equal(await page.isDisabled(`#${id}`), false, id);
      assert.match(await page.textContent('#characterNote'), /после сохранения разговор начнётся заново/);
      assert.equal('characters' in savedUser(), false, 'nothing is stored before Save');
      assert.equal(companion.personaInfo().isDefault, true);
      await page.click('#charCancelBtn');
      assert.match(await page.inputValue('#charDescription'), DEFAULT_PERSONA);
      assert.equal(await page.textContent('#characterState'), '');
      assert.equal(await page.isDisabled('#charSaveBtn'), true);

      const sessionBefore = companion.history.sessionId;
      assert.ok(await page.locator('#transcript .msg').count() > 0, 'there is a conversation to protect');
      await page.fill('#charDescription', 'Ты — Мила, весёлая и любопытная.');
      await page.selectOption('#charVoice', 'baya');
      await page.click('#charSaveBtn');
      await charNote(/Сохранено .*Начат новый разговор\./);
      assert.equal(await page.textContent('#characterState'), '');
      assert.deepEqual(savedUser().characters, { activeId: 'default', profiles: [{ id: 'default', displayName: '', characterName: '', description: 'Ты — Мила, весёлая и любопытная.', voice: { provider: 'silero', id: 'baya' } }] });
      assert.equal('persona' in savedUser(), false);
      assert.equal(companion.history.sessionId, sessionBefore + 1);
      assert.equal(await page.locator('#transcript .msg').count(), 0, 'the earlier conversation is gone');
      await page.waitForFunction(() => /baya/.test(document.getElementById('ttsVoiceValue').textContent));
      assert.equal(await page.isDisabled('#charResetDescriptionBtn'), false);
      await shot('05b-settings-character');

      const request = await askLlm('Привет');
      const system = request.messages[0].content;
      assert.match(system, /\[ПРАВИЛА СИСТЕМЫ\]/);
      assert.match(system, /^\[ЛИЧНОСТЬ\]\nТы — Мила, весёлая и любопытная\.\n\n\[КАК ВЕСТИ РАЗГОВОР\]\n/, 'a custom description does not displace the protected contract');
      assert.deepEqual(request.messages.map((m) => m.role), ['system', 'user'], 'nothing of the earlier conversation is sent');
    });

    await step('Settings → Персонаж: «Прослушать» speaks the selected voice through TTS without the LLM, the chat or the history', async () => {
      await nav('settings');
      const requests = fake.state.requests.length;
      const messages = companion.snapshot().messages.length;
      const historyTurns = companion.snapshot().conversation.historyTurns;
      const turns = companion.diagnostics().turns.length;
      await page.selectOption('#charVoice', 'kseniya');          // not saved: the preview uses what is selected
      await page.click('#charPreviewBtn');
      await page.waitForFunction(() => document.getElementById('charPreviewBtn').textContent === 'Звучит…');
      assert.equal(await page.isDisabled('#charPreviewBtn'), true);
      await charNote(/^Прозвучал голос kseniya\.$/);
      assert.equal(await page.textContent('#charPreviewBtn'), 'Прослушать');
      await idle();
      assert.equal(fake.state.requests.length, requests, 'no LLM request');
      assert.equal(companion.snapshot().messages.length, messages, 'no chat message');
      assert.equal(companion.snapshot().conversation.historyTurns, historyTurns, 'history untouched');
      assert.equal(companion.diagnostics().turns.length, turns, 'not a conversation turn');
      assert.equal(savedUser().characters.profiles[0].voice.id, 'baya', 'listening does not save the voice');
      assert.equal(companion.languageStatus().tts.voiceLoaded, 'baya', 'the conversation voice is still the saved one');
      await page.click('#charCancelBtn');
      assert.equal(await page.inputValue('#charVoice'), 'baya');
    });

    await step('Settings → Персонаж: create, name, switch, duplicate, delete; ids stay internal; never zero profiles', async () => {
      const sessionBefore = companion.history.sessionId;
      await page.click('#charNewBtn');
      await charNote(/Активный профиль: Новый профиль\. Начат новый разговор\./);
      assert.deepEqual(await page.$$eval('#charProfile option', (o) => o.map((x) => x.textContent)), ['Собеседница (встроенный)', 'Новый профиль']);
      assert.equal(await page.inputValue('#charDisplayName'), 'Новый профиль');
      assert.match(await page.inputValue('#charDescription'), DEFAULT_PERSONA);
      assert.equal(await page.inputValue('#charVoice'), 'xenia');
      assert.equal(companion.history.sessionId, sessionBefore + 1);
      const created = savedUser().characters;
      assert.equal(created.profiles.length, 2);
      assert.match(created.activeId, /^p-[0-9a-f]{8}$/);
      assert.equal((await page.textContent('#characterCard')).includes(created.activeId), false, 'the id is not shown');

      await page.fill('#charDisplayName', '');
      await page.click('#charSaveBtn');
      assert.equal(await page.textContent('#characterNote'), 'Укажите имя профиля.');
      await page.fill('#charDisplayName', 'Терапевт');
      await page.fill('#charName', 'Анна');
      await page.fill('#charDescription', 'Ты — психотерапевт на сессии. Говоришь спокойно и на «вы».');
      await page.selectOption('#charVoice', 'aidar');
      await page.click('#charSaveBtn');
      await charNote(/Сохранено .*Начат новый разговор\./);
      const stored = savedUser().characters;
      assert.equal(stored.activeId, created.activeId, 'renaming does not change the id');
      assert.deepEqual(stored.profiles[1], { id: created.activeId, displayName: 'Терапевт', characterName: 'Анна', description: 'Ты — психотерапевт на сессии. Говоришь спокойно и на «вы».', voice: { provider: 'silero', id: 'aidar' } });
      assert.equal(stored.profiles[0].description, 'Ты — Мила, весёлая и любопытная.', 'the other profile is untouched');
      await page.waitForFunction(() => /^aidar \(мужской\) · Терапевт$/.test(document.getElementById('ttsVoiceValue').textContent));
      await shot('05c-settings-character-profile');

      const request = await askLlm('Здравствуйте');
      assert.match(request.messages[0].content, /^\[ЛИЧНОСТЬ\]\nТебя зовут Анна\.\n\nТы — психотерапевт на сессии\. Говоришь спокойно и на «вы»\.\n\n\[КАК ВЕСТИ РАЗГОВОР\]\nТы собеседница: /);
      assert.equal(request.messages[0].content.includes('Мила'), false);
      assert.equal(await page.textContent('#transcript .msg.assistant .who'), 'Анна');
      assert.equal(companion.languageStatus().tts.voiceLoaded, 'aidar', 'the voice service speaks with the voice of the active profile');

      // saving only the profile name or the voice keeps the conversation
      await nav('settings');
      const sessionKept = companion.history.sessionId;
      await page.selectOption('#charVoice', 'eugene');
      assert.match(await page.textContent('#characterNote'), /Есть несохранённые изменения/);
      await page.click('#charSaveBtn');
      await charNote(/^Сохранено \d\d:\d\d:\d\d\.$/);
      assert.equal(companion.history.sessionId, sessionKept);
      await page.waitForFunction(() => /eugene/.test(document.getElementById('ttsVoiceValue').textContent));

      // switching the profile starts a new conversation and brings the other character and voice back
      await page.selectOption('#charProfile', 'default');
      await charNote(/Активный профиль: Собеседница\. Начат новый разговор\./);
      assert.equal(companion.history.sessionId, sessionKept + 1);
      assert.equal(await page.inputValue('#charDescription'), 'Ты — Мила, весёлая и любопытная.');
      assert.equal(await page.inputValue('#charVoice'), 'baya');
      assert.equal(await page.isDisabled('#charDeleteBtn'), true, 'the built-in profile cannot be deleted');
      const back = await askLlm('Привет');
      assert.match(back.messages[0].content, /^\[ЛИЧНОСТЬ\]\nТы — Мила, весёлая и любопытная\.\n\n/);
      assert.equal(back.messages[0].content.includes('Анна'), false);
      assert.deepEqual(back.messages.map((m) => m.role), ['system', 'user']);

      // duplicate, then delete the copy (two clicks) and the profile
      await nav('settings');
      await page.selectOption('#charProfile', created.activeId);
      await charNote(/Активный профиль: Терапевт\./);
      await page.click('#charDuplicateBtn');
      await charNote(/Активный профиль: Терапевт \(копия\)\./);
      const copied = savedUser().characters;
      assert.equal(copied.profiles.length, 3);
      assert.notEqual(copied.activeId, created.activeId);
      assert.deepEqual({ ...copied.profiles[2], id: 0, displayName: 0 }, { ...copied.profiles[1], id: 0, displayName: 0 }, 'the copy has the same content');
      await page.dblclick('#charDeleteBtn');
      assert.equal(await page.textContent('#charDeleteBtn'), 'Точно удалить?');
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(savedUser().characters.profiles.length, 3, 'the first click only asks, and a double-click is one click');
      await new Promise((r) => setTimeout(r, 500));
      await page.click('#charDeleteBtn');
      await charNote(/Профиль удалён\. Активный профиль: Собеседница\. Начат новый разговор\./);
      assert.deepEqual(savedUser().characters.profiles.map((x) => x.displayName), ['', 'Терапевт']);
      assert.equal(savedUser().characters.activeId, 'default');
      await page.selectOption('#charProfile', created.activeId);
      await charNote(/Активный профиль: Терапевт\./);
      await page.click('#charDeleteBtn');
      await new Promise((r) => setTimeout(r, 750));
      await page.click('#charDeleteBtn');
      await charNote(/Профиль удалён\./);
      assert.deepEqual(await page.$$eval('#charProfile option', (o) => o.map((x) => x.textContent)), ['Собеседница (встроенный)']);
      assert.equal(await page.isDisabled('#charDeleteBtn'), true);

      // «Сбросить описание» restores the default persona and nothing else
      await page.click('#charResetDescriptionBtn');
      assert.match(await page.inputValue('#charDescription'), DEFAULT_PERSONA);
      await page.click('#charSaveBtn');
      await charNote(/Сохранено/);
      assert.deepEqual(savedUser().characters, { activeId: 'default', profiles: [{ id: 'default', displayName: '', characterName: '', description: '', voice: { provider: 'silero', id: 'baya' } }] });
      assert.equal(companion.personaInfo().isDefault, true);
      assert.equal(await page.isDisabled('#charResetDescriptionBtn'), true);
      await page.waitForFunction(() => /^baya \(женский\) · Собеседница$/.test(document.getElementById('ttsVoiceValue').textContent));
    });

    await step('Diagnostics: runtime, language per stage, resources, summary, turns, definitions, log', async () => {
      await nav('diagnostics');
      await page.waitForFunction(() => document.getElementById('turnTable').rows.length > 3, null, { timeout: 5000 });
      await page.waitForFunction(() => /VRAM/.test(document.getElementById('resourceTable').textContent), null, { timeout: 5000 });
      assert.match(await page.textContent('#runtimeTable'), /LLM \(LM Studio\)\s*готов/);
      assert.match(await page.textContent('#runtimeTable'), /Аватар \(анимация фото\)\s*не настроен/);
      const lang = await page.$$eval('#languageTable tr', (rows) => rows.map((r) => [r.cells[0].textContent, r.cells[1].textContent]));
      assert.deepEqual(lang, [['Conversation Language', 'ru'], ['STT Language', 'ru'], ['LLM Language Instruction', 'ru'], ['TTS Language / Voice', 'ru / baya']]);
      assert.equal(await page.getAttribute('#languageState', 'data-state'), 'ready');
      assert.match(await page.textContent('#summaryTable'), /Конец речи → первый звук ответа/);
      assert.match(await page.textContent('#diagCount'), /успешных ходов: 1/);
      const cols = await page.locator('#turnTable tr:first-child th').count();
      assert.match(await page.textContent('#turnTable tr:nth-child(2)'), /ru/);
      await page.check('#allColumns');
      assert.ok((await page.locator('#turnTable tr:first-child th').count()) > cols, 'all metrics on demand');
      await page.uncheck('#allColumns');
      await page.selectOption('#diagMode', 'text_llm_tts');
      assert.match(await page.textContent('#summaryTable'), /TTFT/);
      await page.click('summary[data-i18n="diag.definitions"]');
      assert.ok((await page.locator('#metricDefs dt').count()) >= 10);
      assert.ok((await page.locator('#eventLog div').count()) > 10);
      await page.click('#exportBtn');
      await page.waitForFunction(() => /Сохранено:/.test(document.getElementById('exportResult').textContent));
      await page.click('summary[data-i18n="diag.definitions"]');
      await page.selectOption('#diagMode', 'full');
      await page.evaluate(() => { document.querySelector('.page-area').scrollTop = 0; });
      await shot('06-diagnostics');
    });

    await step('theme cycles System -> Light -> Dark and is persisted', async () => {
      assert.equal(await page.getAttribute('body', 'data-theme'), 'system');
      assert.equal(await page.evaluate(() => document.body.classList.contains('light')), false, 'system = dark here');
      await page.click('#themeToggle');
      assert.equal(await page.getAttribute('body', 'data-theme'), 'light');
      assert.equal(await page.evaluate(() => document.body.classList.contains('light')), true);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'user.json'), 'utf8')).ui.theme, 'light');
      await nav('chat');
      await shot('07-chat-light');
      await nav('settings');
      await shot('08-settings-light');
      await page.click('#themeToggle');
      assert.equal(await page.getAttribute('body', 'data-theme'), 'dark');
      await page.click('#themeToggle');
      assert.equal(await page.getAttribute('body', 'data-theme'), 'system');
    });

    await step('errors are visible: LM Studio stopped -> error chip, banner and system message', async () => {
      await fake.stop();
      await companion.refreshLlm();
      await page.waitForSelector('.chip[data-component="LLM"][data-state="error"]', { timeout: 5000 });
      await nav('chat');
      await page.fill('#textInput', 'Ты тут?');
      await page.click('#sendBtn');
      await page.waitForSelector('.msg.system', { timeout: 8000 });
      assert.equal(await page.isVisible('#banner'), true);
      assert.match(await badge(), /READY/);
      await shot('10-llm-error');
    });

    assert.deepEqual(consoleErrors, [], `browser console errors: ${consoleErrors.join(' | ')}`);
    console.log(`\nUI smoke test passed (${steps.length} steps). Screenshots: ${shotDir}`);
  } finally {
    await browser.close();
    await companion.shutdown();
    await fake.stop().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`UI smoke test FAILED: ${err.stack || err}`);
  process.exit(1);
});
