'use strict';
/**
 * GUI self-test: `electron . --self-test`
 *
 * Launches the real application (real Core, real voice service, real
 * LM Studio connection), checks that the window renders and reflects the
 * component states, shuts down, verifies the voice service is gone, and
 * writes artifacts/reports/gui_selftest.json. It proves "the Electron app
 * launches and the GUI is alive" on this machine; it does not judge audio.
 */
const fs = require('node:fs');
const path = require('node:path');
const { pidAlive } = require('../../core/util/process');

/** Evaluated inside the renderer. Must stay self-contained. */
const DOM_PROBE_SCRIPT = `(() => {
  const text = (sel) => { const n = document.querySelector(sel); return n ? n.textContent.trim() : null; };
  const lang = document.getElementById('cfgLanguage');
  return {
    title: document.title,
    badge: text('#stateBadge'),
    chips: Array.from(document.querySelectorAll('#statusStrip .chip')).map((c) => ({
      name: c.dataset.component, state: c.dataset.state, text: c.textContent.trim(), detail: c.title,
    })),
    pages: Array.from(document.querySelectorAll('.nav-item')).map((t) => t.dataset.page),
    hasTitlebar: Boolean(document.querySelector('.titlebar .window-controls')),
    hasTranscript: Boolean(document.getElementById('transcript')),
    hasSend: Boolean(document.getElementById('sendBtn')),
    hasClear: Boolean(document.getElementById('clearBtn')),
    micModes: Array.from(document.querySelectorAll('#micMode option')).map((o) => o.value),
    routes: Array.from(document.querySelectorAll('#routeSelect option')).map((o) => o.value),
    endpoint: (document.getElementById('cfgLlmEndpoint') || {}).value || null,
    hasPhotoStage: Boolean(document.getElementById('photoStage')),
    avatarText: text('#avatarEngineState'),
    conversationLanguage: lang ? { value: lang.value, label: lang.selectedOptions[0] ? lang.selectedOptions[0].textContent : null } : null,
    theme: document.body.dataset.theme || null,
  };
})()`;

const DIAG_PROBE_SCRIPT = `(async () => {
  document.querySelector('.nav-item[data-page="diagnostics"]').click();
  await new Promise((r) => setTimeout(r, 1500));
  const cells = Array.from(document.querySelectorAll('#languageTable tr')).map((tr) => Array.from(tr.cells).map((c) => c.textContent.trim()));
  return {
    runtimeRows: document.getElementById('runtimeTable').rows.length,
    definitions: document.querySelectorAll('#metricDefs dt').length,
    logLines: document.getElementById('eventLog').childElementCount,
    language: cells,
    languageState: document.getElementById('languageState').dataset.state,
  };
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pure evaluation of the collected facts (unit tested). */
function evaluate({ dom, diag, statuses, consoleErrors, windowVisible }) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail: String(detail) });
  add('Window is visible', windowVisible);
  add('Renderer loaded the application page', dom && dom.title === 'AI Voice Photo', dom ? dom.title : 'no DOM');
  const chips = (dom && dom.chips) || [];
  add('Status strip shows MIC, STT, LLM, TTS, AVATAR', ['MIC', 'STT', 'LLM', 'TTS', 'AVATAR'].every((n) => chips.some((c) => c.name === n)), chips.map((c) => `${c.name}:${c.state}`).join(' '));
  add('Sidebar pages Chat, Models, Diagnostics, Settings exist', dom && ['chat', 'models', 'diagnostics', 'settings'].every((t) => dom.pages.includes(t)));
  add('Chat page has the photo stage', dom && dom.hasPhotoStage);
  add('Custom titlebar with window controls is present', dom && dom.hasTitlebar);
  add('Chat controls exist (transcript, send, Clear Session, mic modes, text bypass routes)', dom && dom.hasTranscript && dom.hasSend && dom.hasClear && dom.micModes.length === 3 && dom.routes.length === 3);
  add('Conversation state is displayed', dom && Boolean(dom.badge), dom ? dom.badge : '');
  const avatar = chips.find((c) => c.name === 'AVATAR');
  add('Avatar engine state is shown (AVP-04: Ditto)', avatar && ['ready', 'loading', 'not_configured', 'error'].includes(avatar.state) && dom && Boolean(dom.avatarText), avatar ? `${avatar.state}: ${avatar.detail}` : '');
  const lang = dom && dom.conversationLanguage;
  add('Settings show the conversation language (default: Русский)', lang && lang.value === 'ru' && lang.label === 'Русский', lang ? `${lang.value} / ${lang.label}` : 'missing');
  const langRows = (diag && diag.language) || [];
  add('Diagnostics show the language of every stage', langRows.length === 4 && langRows.every((r) => /^ru/.test(r[1] || '')), langRows.map((r) => `${r[0]}: ${r[1]}`).join(' | '));
  for (const [chipName, key] of [['STT', 'stt'], ['LLM', 'llm']]) {
    const chip = chips.find((c) => c.name === chipName);
    add(`${chipName} chip reflects the core status`, chip && statuses[key] && chip.state === statuses[key].state, chip ? `${chip.state} vs ${statuses[key] ? statuses[key].state : '?'}` : 'missing');
  }
  add('Renderer received the configuration', dom && Boolean(dom.endpoint), dom ? dom.endpoint : '');
  add('Diagnostics tab renders runtime state, definitions and log', diag && diag.runtimeRows >= 7 && diag.definitions >= 10 && diag.logLines > 0, diag ? JSON.stringify(diag) : 'no data');
  add('No errors in the renderer console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  return checks;
}

async function runSelfTest({ win, companion, rootDir, shutdown, loadTimeoutMs = 900000 }) {
  const result = { startedAt: new Date().toISOString(), finishedAt: null, ok: false, checks: [], statuses: null, error: null };
  const consoleErrors = [];
  win.webContents.on('console-message', (event, level, message) => {
    // signature differs between Electron versions
    const lvl = typeof level === 'number' || typeof level === 'string' ? level : event && event.level;
    const msg = typeof message === 'string' ? message : event && event.message;
    if (lvl === 3 || lvl === 'error') consoleErrors.push(String(msg));
  });
  let voicePid = null;
  let spawnPid = null;
  try {
    if (win.webContents.isLoading()) {
      await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    }
    const start = Date.now();
    for (;;) {
      const s = companion.statuses();
      const loading = ['mic', 'vad', 'stt', 'tts', 'output', 'llm'].filter((c) => s[c].state === 'loading');
      if (!loading.length || Date.now() - start > loadTimeoutMs) break;
      await sleep(500);
    }
    await sleep(800); // let the last status events reach the renderer
    const statuses = companion.statuses();
    result.statuses = Object.fromEntries(Object.entries(statuses).map(([k, v]) => [k, { state: v.state, detail: v.detail }]));
    voicePid = companion.voice.servicePid ?? null;
    spawnPid = companion.voice.spawnPid ?? null;
    result.voiceProcess = { startedProcessPid: spawnPid, servicePid: voicePid, relation: companion.voice.processRelation ?? null };
    const dom = await win.webContents.executeJavaScript(DOM_PROBE_SCRIPT, true);
    const diag = await win.webContents.executeJavaScript(DIAG_PROBE_SCRIPT, true);
    result.dom = dom;
    result.checks = evaluate({ dom, diag, statuses, consoleErrors, windowVisible: win.isVisible() });
  } catch (err) {
    result.error = err && err.stack ? err.stack : String(err);
  }

  await shutdown();
  await sleep(500);
  const serviceAlive = voicePid ? pidAlive(voicePid) : false;
  const spawnAlive = spawnPid ? pidAlive(spawnPid) : false;
  result.checks.push({
    name: 'Voice service stopped when the app shut down (started process and service process both gone)',
    ok: !serviceAlive && !spawnAlive,
    detail: voicePid ? `service pid ${voicePid}${serviceAlive ? ' STILL RUNNING' : ''}, started pid ${spawnPid}${spawnAlive ? ' STILL RUNNING' : ''}` : 'service was not running',
  });
  result.componentsReady = result.statuses ? ['mic', 'vad', 'stt', 'tts', 'output', 'llm'].every((c) => result.statuses[c].state === 'ready') : false;
  result.ok = !result.error && result.checks.every((c) => c.ok);
  result.finishedAt = new Date().toISOString();

  const file = path.join(rootDir, 'artifacts', 'reports', 'gui_selftest.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  return result;
}

module.exports = { runSelfTest, evaluate, DOM_PROBE_SCRIPT, DIAG_PROBE_SCRIPT };
