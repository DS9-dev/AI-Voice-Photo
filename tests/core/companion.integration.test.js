'use strict';
/**
 * Core + voice-service client + LM Studio provider wired together, running
 * against the FAKE voice service process and the FAKE LM Studio server.
 * This verifies integration logic only; it is not live evidence.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Companion } = require('../../core');
const { ConfigStore } = require('../../core/config/configStore');
const { VoiceServiceClient } = require('../../core/providers/voiceServiceClient');
const { createFakeLmStudio } = require('../fixtures/fake_lmstudio');

const ROOT = path.join(__dirname, '..', '..');
const FAKE = path.join(__dirname, '..', 'fixtures', 'fake_voice_service.js');

async function boot({ lm = {}, env = {}, config = {} } = {}) {
  const fake = createFakeLmStudio(lm);
  const endpoint = await fake.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vvc-int-'));
  const configStore = new ConfigStore({ defaultPath: path.join(ROOT, 'config', 'default.json'), userPath: path.join(dir, 'user.json') });
  configStore.update({ llm: { endpoint }, avatar: { engine: 'none' }, tts: { output: 'local' }, ...config });
  const voiceClient = new VoiceServiceClient({ command: process.execPath, args: [FAKE], env, helloTimeoutMs: 3000 });
  const app = new Companion({ rootDir: dir, overrides: { configStore, voiceClient, llmPollOkMs: 100000, llmPollFailMs: 100000 } });
  const ui = [];
  app.on('ui', (e) => ui.push(e));
  await app.start();
  await app.refreshLlm();
  await waitFor(() => app.statuses().stt.state !== 'loading' && app.statuses().tts.state !== 'loading');
  return { app, fake, ui, dir, voiceClient, configStore, async close() { await app.shutdown(); await fake.stop(); } };
}

async function waitFor(predicate, timeoutMs = 4000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timeout waiting for ${label}`);
}

const turnsOf = (ui) => ui.filter((e) => e.type === 'turn').map((e) => e.payload);
const statesOf = (ui) => ui.filter((e) => e.type === 'state').map((e) => e.payload.state);

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('startup: all components ready, Qwen discovered, avatar engine not configured', async () => {
  const t = await boot();
  try {
    const s = t.app.statuses();
    for (const c of ['mic', 'vad', 'stt', 'tts', 'output', 'llm']) assert.equal(s[c].state, 'ready', c);
    assert.equal(s.llm.selectedModel, 'qwen/qwen3.5-9b');
    assert.equal(s.avatar.state, 'not_configured');
    assert.equal(t.app.snapshot().conversation.state, 'LISTENING');
  } finally { await t.close(); }
});

test('typed text -> LLM -> TTS end to end with complete timing chain', async () => {
  const t = await boot({ lm: { reply: () => ({ content: 'Привет! Рада тебя слышать. Как прошёл твой день?', chunkDelayMs: 3 }) } });
  try {
    const r = t.app.sendText('Привет');
    assert.equal(r.accepted, true);
    await waitFor(() => turnsOf(t.ui).length === 1, 4000, 'turn');
    const turn = turnsOf(t.ui)[0];
    assert.equal(turn.mode, 'text_llm_tts');
    assert.equal(turn.outcome, 'ok');
    const ts = turn.timestamps;
    const order = ['tSubmit', 'tLlmRequest', 'tLlmFirstToken', 'tTtsTextReady', 'tTtsFirstAudio', 'tPlaybackStart', 'tPlaybackEnd'];
    for (let i = 1; i < order.length; i++) {
      assert.ok(ts[order[i]] >= ts[order[i - 1]], `${order[i - 1]} <= ${order[i]} (${ts[order[i - 1]]} vs ${ts[order[i]]})`);
    }
    for (const key of ['llmTtftMs', 'llmTotalMs', 'llmTokensPerSec', 'ttsFirstAudioMs', 'ttsSynthTotalMs', 'perceivedLatencyMs', 'turnDurationMs']) {
      assert.ok(Number.isFinite(turn.derived[key]) && turn.derived[key] >= 0, `${key}=${turn.derived[key]}`);
    }
    assert.ok(turn.derived.perceivedLatencyMs < turn.derived.turnDurationMs);
    assert.equal(turn.counters.ttsChunks, 2); // "Привет!" is merged with the next short sentence
    assert.deepEqual(statesOf(t.ui).filter((s, i, a) => s !== a[i - 1]).slice(-4), ['LISTENING', 'THINKING', 'SPEAKING', 'LISTENING']);
    assert.equal(t.fake.state.requests[0].model, 'qwen/qwen3.5-9b');
    assert.equal(t.app.snapshot().messages.length, 2);
  } finally { await t.close(); }
});

test('speaking starts before the LLM has finished (sentence-chunked TTS)', async () => {
  const long = 'Это первое предложение ответа. ' + 'И ещё одно длинное предложение следом. '.repeat(12);
  const t = await boot({ lm: { reply: () => ({ content: long, chunkDelayMs: 6 }) } });
  try {
    t.app.sendText('Расскажи');
    await waitFor(() => turnsOf(t.ui).length === 1, 8000, 'turn');
    const ts = turnsOf(t.ui)[0].timestamps;
    assert.ok(ts.tPlaybackStart < ts.tLlmDone, 'first audio played while the LLM was still generating');
  } finally { await t.close(); }
});

test('simulated voice utterance runs the full pipeline and reopens the microphone gate', async () => {
  const t = await boot();
  try {
    t.app.setMicMode('full');
    await waitFor(() => t.ui.some((e) => e.type === 'listening' && e.payload.enabled), 3000, 'gate open');
    t.voiceClient.send({ cmd: '_sim_utterance', text: 'Как тебя зовут?', speech_ms: 900 });
    await waitFor(() => turnsOf(t.ui).length === 1, 4000, 'turn');
    const turn = turnsOf(t.ui)[0];
    assert.equal(turn.mode, 'full');
    assert.equal(turn.input, 'voice');
    assert.equal(turn.outcome, 'ok');
    assert.ok(Math.abs(turn.derived.speechDurationMs - 900) < 1);
    assert.ok(turn.derived.vadEndDelayMs >= 600);
    assert.ok(turn.derived.perceivedLatencyMs > turn.derived.vadEndDelayMs, 'perceived latency includes the VAD silence wait');
    const ts = turn.timestamps;
    assert.ok(ts.tSpeechEnd <= ts.tVadEndDetected && ts.tVadEndDetected <= ts.tSttFinal && ts.tSttFinal <= ts.tLlmRequest + 1);
    const gateNow = () => t.ui.filter((e) => e.type === 'listening').map((e) => e.payload.enabled);
    // the service acknowledges the reopened gate asynchronously
    await waitFor(() => gateNow().at(-1) === true, 3000, 'gate reopened after playback');
    const gate = gateNow();
    assert.ok(gate.includes(false));
    assert.equal(t.app.snapshot().lastStt.text, 'Как тебя зовут?');
  } finally { await t.close(); }
});

test('an utterance spoken while THINKING/SPEAKING never reaches the LLM', async () => {
  const t = await boot({ lm: { reply: () => ({ content: 'Отвечаю на твой первый вопрос подробно. ' + 'Ещё немного текста для озвучки. '.repeat(6), chunkDelayMs: 8 }) }, env: { FAKE_AUDIO_MS: '60' } });
  try {
    t.app.setMicMode('full');
    await waitFor(() => t.ui.some((e) => e.type === 'listening' && e.payload.enabled));
    t.voiceClient.send({ cmd: '_sim_utterance', text: 'Первый вопрос' });
    await waitFor(() => statesOf(t.ui).includes('THINKING'));
    const ignored = [];
    t.voiceClient.on('_sim_ignored', (e) => ignored.push(e));
    t.voiceClient.send({ cmd: '_sim_utterance', text: 'Второй вопрос во время размышления' });
    await waitFor(() => statesOf(t.ui).includes('SPEAKING'), 4000, 'speaking');
    t.voiceClient.send({ cmd: '_sim_utterance', text: 'Третий вопрос во время речи' });
    assert.equal(t.app.sendText('Четвёртый, набранный').accepted, false);
    await waitFor(() => turnsOf(t.ui).length === 1, 8000, 'turn');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ignored.length, 2, 'both utterances hit a closed microphone gate');
    assert.equal(t.fake.state.requests.length, 1, 'exactly one LLM request');
    assert.equal(turnsOf(t.ui).length, 1);
    assert.equal(t.app.snapshot().conversation.state, 'LISTENING');
  } finally { await t.close(); }
});

test('session context is sent, and Clear Session removes it', async () => {
  const t = await boot({ lm: { reply: (body) => ({ content: body.messages.some((m) => /красный/.test(m.content)) ? 'Он был красный, как ты и говорил.' : 'Я не знаю, о чём речь.' }) } });
  try {
    t.app.sendText('Меня интересует красный автомобиль.', 'llm_only');
    await waitFor(() => turnsOf(t.ui).length === 1);
    t.app.sendText('А какого он был цвета?', 'llm_only');
    await waitFor(() => turnsOf(t.ui).length === 2);
    assert.equal(t.fake.state.requests[1].messages.length, 4);
    assert.match(t.app.snapshot().messages.at(-1).text, /красный/);

    const res = t.app.clearSession();
    assert.ok(res.sessionId > 1);
    assert.equal(t.app.snapshot().messages.length, 0);
    assert.equal(t.app.snapshot().conversation.historyTurns, 0);

    t.app.sendText('А какого он был цвета?', 'llm_only');
    await waitFor(() => turnsOf(t.ui).length === 3);
    const body = t.fake.state.requests[2];
    assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user']);
    assert.equal(JSON.stringify(body.messages).includes('красный'), false);
    assert.match(t.app.snapshot().messages.at(-1).text, /не знаю/);
  } finally { await t.close(); }
});

test('LM Studio down: visible error status and a failed turn, no hang', async () => {
  const t = await boot();
  try {
    await t.fake.stop();
    const status = await t.app.refreshLlm();
    assert.equal(status.state, 'error');
    assert.match(status.detail, /Cannot reach|No response/);
    t.app.sendText('Привет');
    await waitFor(() => turnsOf(t.ui).length === 1);
    assert.equal(turnsOf(t.ui)[0].outcome, 'error');
    assert.equal(t.app.snapshot().conversation.state, 'LISTENING');
    assert.ok(t.ui.some((e) => e.type === 'problem'));
  } finally { await t.app.shutdown(); }
});

test('TTS synthesis failure surfaces as an error and returns to LISTENING', async () => {
  const t = await boot({ env: { FAKE_FAIL: 'synth' } });
  try {
    t.app.sendText('Привет');
    await waitFor(() => turnsOf(t.ui).length === 1);
    assert.equal(turnsOf(t.ui)[0].outcome, 'error');
    assert.equal(t.app.snapshot().conversation.state, 'LISTENING');
    assert.ok(t.ui.some((e) => e.type === 'problem' && /TTS error/.test(e.payload.message)));
  } finally { await t.close(); }
});

test('voice service crash mid-speech: error statuses, turn fails, restart recovers', async () => {
  const t = await boot({ lm: { reply: () => ({ content: 'Это довольно длинный ответ для проверки. ' + 'Продолжаю говорить дальше и дальше. '.repeat(5) }) }, env: { FAKE_AUDIO_MS: '400' } });
  try {
    t.app.sendText('Привет');
    await waitFor(() => statesOf(t.ui).includes('SPEAKING'));
    t.voiceClient.send({ cmd: '_sim_crash' });
    await waitFor(() => t.app.statuses().tts.state === 'error', 3000, 'error status');
    assert.equal(t.app.snapshot().conversation.state, 'LISTENING');
    assert.equal(turnsOf(t.ui)[0].outcome, 'error');
    const r = await t.app.restartVoiceService();
    assert.equal(r.ok, true);
    await waitFor(() => t.app.statuses().tts.state === 'ready');
  } finally { await t.close(); }
});

test('configuration changes persist and voice-related ones are pushed to the service', async () => {
  const t = await boot();
  try {
    const logs = [];
    t.voiceClient.on('log', (e) => logs.push(e.message));
    // `tts.voice` (the single voice of VC-M0 / VC-M1.1) is still accepted: it is the voice of the built-in character profile
    const cfg = t.app.updateConfig({ tts: { voice: 'baya' }, session: { historyTurns: 3 }, vad: { minSilenceMs: 450 } });
    assert.equal(cfg.characters.profiles[0].voice.id, 'baya');
    assert.equal(t.app.languageProfile().tts.voice, 'baya');
    await waitFor(() => logs.some((m) => /fake configure/.test(m)), 2000, 'configure command');
    await waitFor(() => t.app.languageStatus().tts.voiceLoaded === 'baya', 3000, 'the service speaks with the new voice');
    const again = new ConfigStore({ defaultPath: path.join(ROOT, 'config', 'default.json'), userPath: path.join(t.dir, 'user.json') });
    assert.equal(again.get().characters.profiles[0].voice.id, 'baya');
    assert.equal(again.get().vad.minSilenceMs, 450);
    assert.equal(t.app.snapshot().conversation.maxHistoryTurns, 3);
    t.app.setMicMode('stt_only');
    assert.equal(new ConfigStore({ defaultPath: path.join(ROOT, 'config', 'default.json'), userPath: path.join(t.dir, 'user.json') }).get().conversation.micMode, 'stt_only');
  } finally { await t.close(); }
});

test('conversation language reaches the voice service and is reported coherently', async () => {
  const t = await boot();
  try {
    await waitFor(() => t.app.languageStatus().stt.loaded === 'ru' && t.app.languageStatus().tts.loaded === 'ru', 3000, 'language loaded');
    const lang = t.app.languageStatus();
    assert.deepEqual(lang.conversation, { code: 'ru', name: 'Русский' });
    assert.equal(lang.llm.instruction, 'ru');
    assert.equal(lang.tts.voiceLoaded, 'xenia');
    assert.equal(lang.coherent, true);
    assert.deepEqual(t.app.snapshot().languages.map((l) => l.code), ['ru']);
    assert.equal(t.app.diagnostics().language.coherent, true);

    t.app.sendText('Привет');
    await waitFor(() => turnsOf(t.ui).length === 1);
    assert.deepEqual(turnsOf(t.ui)[0].counters.language, { conversation: 'ru', stt: 'ru', llmInstruction: 'ru', tts: 'ru', ttsVoice: 'xenia', coherent: true });
    assert.match(t.fake.state.requests[0].messages[0].content, /по-русски/);

    // changing the voice goes through the same language profile
    t.app.updateConfig({ tts: { voice: 'kseniya' } });
    await waitFor(() => t.app.languageStatus().tts.voiceLoaded === 'kseniya', 3000, 'voice change');
    assert.equal(t.app.languageStatus().coherent, true);
    assert.ok(t.ui.some((e) => e.type === 'language'));
  } finally { await t.close(); }
});

test('an STT engine loaded for another language is reported as a mismatch', async () => {
  const t = await boot({ env: { FAKE_STT_LANGUAGE: 'en' } });
  try {
    await waitFor(() => t.app.languageStatus().stt.loaded === 'en', 3000, 'stt language');
    const lang = t.app.languageStatus();
    assert.equal(lang.coherent, false);
    assert.match(lang.mismatches[0], /STT is loaded for 'en'/);
    t.app.setMicMode('stt_only');
    await waitFor(() => t.ui.some((e) => e.type === 'listening' && e.payload.enabled));
    t.voiceClient.send({ cmd: '_sim_utterance', text: 'hello' });
    await waitFor(() => turnsOf(t.ui).length === 1);
    assert.equal(turnsOf(t.ui)[0].counters.language.coherent, false);
  } finally { await t.close(); }
});

test('persona: editable, persisted, sent to the LLM, resettable; core rules always present', async () => {
  const t = await boot();
  try {
    const info = t.app.personaInfo();
    assert.equal(info.isDefault, true);
    assert.match(info.text, /девушка, которая находится в одной комнате/);
    assert.match(info.coreInstructions, /Говори только по-русски/);
    // since VC-M1.2 the persona is the description of the active character profile
    const characters = t.app.snapshot().characters;
    assert.deepEqual(Object.keys(characters).sort(), ['activeId', 'builtInId', 'coreInstructions', 'defaults', 'limits', 'previewText', 'profiles', 'revision', 'voiceProvider', 'voices', 'voicesLoaded']);
    assert.equal(characters.coreInstructions, info.coreInstructions);
    assert.equal(characters.profiles[0].description, info.text);
    assert.equal(characters.profiles[0].descriptionIsDefault, true);
    assert.equal('persona' in t.app.snapshot(), false);

    t.app.saveCharacter('default', { description: 'Ты — Вера, спокойная и немногословная.' });
    assert.equal(t.app.personaInfo().isDefault, false);
    assert.ok(t.ui.some((e) => e.type === 'characters' && e.payload.profiles[0].description === 'Ты — Вера, спокойная и немногословная.'));
    const saved = JSON.parse(fs.readFileSync(path.join(t.dir, 'user.json'), 'utf8'));
    assert.equal(saved.characters.profiles[0].description, 'Ты — Вера, спокойная и немногословная.');
    assert.equal('persona' in saved, false);

    t.app.sendText('Привет', 'llm_only');
    await waitFor(() => turnsOf(t.ui).length === 1);
    const system = t.fake.state.requests[0].messages[0].content;
    assert.match(system, /^\[ЛИЧНОСТЬ\]\nТы — Вера, спокойная и немногословная\.\n\n\[КАК ВЕСТИ РАЗГОВОР\]\nТы собеседница: /);
    assert.match(system, /\n\n\[ПРАВИЛА СИСТЕМЫ\]\n1\. Говори только по-русски\./);
    assert.equal(system, `[ЛИЧНОСТЬ]\nТы — Вера, спокойная и немногословная.\n\n${info.coreInstructions}`, 'persona layer + the protected core exactly as shown in Settings');
    assert.match(system, /Никогда не говори, что ты что-то приготовила, налила, принесла, достала, подала, передала или включила, что делаешь это сейчас или сейчас сделаешь/);
    assert.equal(turnsOf(t.ui)[0].counters.persona, 'custom');

    // reset to default
    t.app.resetCharacterDescription('default');
    assert.equal(t.app.personaInfo().isDefault, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, 'user.json'), 'utf8')).characters.profiles[0].description, '');
    t.app.sendText('Ещё раз привет', 'llm_only');
    await waitFor(() => turnsOf(t.ui).length === 2);
    const second = t.fake.state.requests[1];
    assert.match(second.messages[0].content, /девушка, которая находится в одной комнате/);
    // the persona text is system-level only; it is not stored as a dialogue turn
    assert.equal(second.messages.filter((m) => m.role === 'system').length, 1);
    // the description of the active character changed, so her conversation started anew: nothing of «Вера» is sent
    assert.deepEqual(second.messages.map((m) => m.role), ['system', 'user']);
  } finally { await t.close(); }
});

test('microphone statistics: a silent gated microphone is recorded, not raised as an error; a dead stream is', async () => {
  const t = await boot();
  try {
    const stats = (over) => ({ reason: 'periodic', windowMs: 5024, frames: 157, peak: 0, rms: 0, signal: 'digital_silence', maxSpeechProb: 0, inSpeech: false, stream: { device: 'Микрофон гарнитуры (Xbox Controller)', hostApi: 'Windows WASAPI' }, ...over });
    const micProblems = () => t.ui.filter((e) => e.type === 'problem' && e.payload.source === 'mic');
    const micLog = () => t.app.diagnostics().log.filter((e) => e.source === 'mic');

    // a headset that sends exact zeros while nobody speaks: normal, no banner
    t.app._onMicStats(stats());
    assert.equal(micProblems().length, 0);
    const warned = micLog().filter((e) => e.level === 'warn');
    assert.equal(warned.length, 1);
    assert.match(warned[0].message, /only digital silence for 5\.0 s.*Normal for a gated or muted microphone while nobody speaks/);
    t.app._onMicStats(stats({ windowMs: 10048, frames: 314 }));
    assert.equal(micLog().filter((e) => e.level === 'warn').length, 1, 'reported once, not every five seconds');
    assert.equal(t.ui.filter((e) => e.type === 'micStats').length, 2);
    assert.equal(t.app.diagnostics().microphone.frames, 314);

    // sound arrives: recorded as such
    t.app._onMicStats(stats({ peak: 0.21, rms: 0.03, signal: 'ok', maxSpeechProb: 0.97 }));
    assert.match(micLog().pop().message, /delivers a signal \(peak 0\.21, highest speech probability 0\.97\)/);

    // a window that is too short to judge changes nothing
    t.app._onMicStats(stats({ windowMs: 900, frames: 28 }));
    assert.equal(micProblems().length, 0);

    // an open stream that never calls back IS a fault
    t.app._onMicStats(stats({ frames: 0, signal: 'no_frames' }));
    assert.equal(micProblems().length, 1);
    assert.match(micProblems()[0].payload.message, /delivered no audio frames in 5\.0 s/);
  } finally { await t.close(); }
});

test('devices, resources and diagnostics views', async () => {
  const t = await boot();
  try {
    const d = await t.app.listDevices();
    assert.equal(d.inputs.length, 2);
    assert.equal(d.outputs[0].name, 'Fake Speakers');
    const r = await t.app.getResources();
    assert.ok(r.coreRssMb > 0);
    assert.equal(r.voice.gpu[0].memoryTotalMb, 16000);
    t.app.sendText('Привет');
    await waitFor(() => turnsOf(t.ui).length === 1);
    const diag = t.app.diagnostics();
    assert.equal(diag.turns.length, 1);
    assert.equal(diag.summary.text_llm_tts.turns, 1);
    assert.equal(diag.summary.text_llm_tts.intervals.perceivedLatencyMs.n, 1);
    assert.equal(diag.summary.full.turns, 0);
    assert.ok(diag.definitions.length >= 10);
    assert.ok(diag.log.length > 0);
    assert.ok(diag.transitions.length >= 3);
    const { file } = t.app.exportDiagnostics();
    const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(exported.turns.length, 1);
  } finally { await t.close(); }
});

test('shutdown stops the voice service process and leaves LM Studio alone', async () => {
  const t = await boot();
  const pid = t.voiceClient.hello.pid;
  assert.equal(isAlive(pid), true);
  await t.app.shutdown();
  assert.equal(isAlive(pid), false, 'no orphan helper process');
  const res = await fetch(`${t.fake.endpoint}/models`);
  assert.equal(res.status, 200, 'external LLM server untouched');
  await t.fake.stop();
});

test('missing Python environment is reported instead of crashing', async () => {
  const fake = createFakeLmStudio();
  const endpoint = await fake.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vvc-int-'));
  fs.mkdirSync(path.join(dir, 'config'));
  fs.copyFileSync(path.join(ROOT, 'config', 'default.json'), path.join(dir, 'config', 'default.json'));
  fs.writeFileSync(path.join(dir, 'config', 'user.json'), JSON.stringify({ llm: { endpoint } }));
  const app = new Companion({ rootDir: dir, overrides: { llmPollOkMs: 100000, llmPollFailMs: 100000 } });
  try {
    await app.start();
    assert.equal(app.statuses().stt.state, 'error');
    assert.match(app.statuses().stt.detail, /Run setup\.bat/);
    // text -> LLM still works without the voice service
    const turns = [];
    app.on('ui', (e) => { if (e.type === 'turn') turns.push(e.payload); });
    await app.refreshLlm();
    app.sendText('Привет', 'llm_only');
    await waitFor(() => turns.length === 1);
    assert.equal(turns[0].outcome, 'ok');
  } finally { await app.shutdown(); await fake.stop(); }
});
