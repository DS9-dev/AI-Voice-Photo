'use strict';
/**
 * VC-M0 live acceptance procedure (tests A–G of the milestone spec).
 *
 * The logic is transport-agnostic so it can be unit tested against fakes,
 * but a report only counts as live evidence when `evidence === 'live'`,
 * which only scripts/live_acceptance.js sets, and only for the real voice
 * service (the fake announces itself and is detected below).
 */
const { summarizeTurns } = require('../../core/metrics/stats');
const { DERIVED_KEYS } = require('../../core/metrics/turnMetrics');
const { ConfigStore } = require('../../core/config/configStore');
const { pidAlive } = require('../../core/util/process');

const ALL_TESTS = ['B', 'C', 'D', 'F', 'G', 'A', 'E', 'L'];
const TEST_NAMES = {
  A: 'STT: microphone → VAD → STT',
  B: 'LLM: typed text → Qwen via LM Studio',
  C: 'TTS: typed text → Silero → speakers',
  D: 'Typed text → LLM → TTS',
  E: 'Full pipeline: microphone → VAD → STT → LLM → TTS → speakers',
  F: 'Short session context',
  G: 'Clear Session',
  L: 'Language configuration (one conversation language for STT, LLM and TTS)',
};
const REQUIRES = {
  A: ['mic', 'vad', 'stt'],
  B: ['llm'],
  C: ['tts', 'output'],
  D: ['llm', 'tts', 'output'],
  E: ['mic', 'vad', 'stt', 'llm', 'tts', 'output'],
  F: ['llm'],
  G: ['llm'],
  L: [],
};
const STT_SENTENCES = [
  'Сегодня хорошая погода, и я собираюсь пойти гулять в парк.',
  'Мне нужно купить хлеб, молоко и немного сыра.',
  'Проверка распознавания речи: раз, два, три, четыре, пять.',
];
const CONVERSATION_PROMPTS = [
  'Привет! Как тебя зовут?',
  'Расскажи что-нибудь интересное про космос.',
  'А что ты думаешь о путешествиях?',
  'Какой твой любимый цвет и почему?',
  'Спасибо, на сегодня всё.',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasCyrillic = (s) => /[А-Яа-яЁё]/.test(s || '');

/** Share of letters that are Cyrillic (0..1); 1 for text without letters. */
function cyrillicShare(text) {
  const letters = String(text || '').match(/\p{L}/gu) || [];
  if (!letters.length) return 1;
  return letters.filter((ch) => /[А-Яа-яЁё]/.test(ch)).length / letters.length;
}

function words(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^a-zа-яё0-9\s]/gi, ' ').split(/\s+/).filter((w) => w.length > 2));
}

/** Share of the words of `a` that also occur in `b` (0..1). */
function overlap(a, b) {
  const wa = words(a);
  const wb = words(b);
  if (!wa.size) return 0;
  let hit = 0;
  for (const w of wa) if (wb.has(w)) hit += 1;
  return hit / wa.size;
}

/** One line about an LLM exchange: what was sent, what came back. No message or reasoning text. */
function describeLlm(d) {
  const sse = d.sse || {};
  const keys = Object.entries(sse.deltaKeys || {}).map(([k, n]) => `${k}×${n}`).join(' ') || 'none';
  const req = d.request || {};
  return `LLM ${d.outcome}: POST ${d.url} → HTTP ${d.httpStatus ?? '—'}; max_tokens ${req.max_tokens ?? '?'}, reasoning_effort ${req.reasoning_effort ?? '—'};`
    + ` ${sse.events ?? 0} stream events, delta fields ${keys}; finish_reason ${d.finishReason ?? '—'};`
    + ` attempts ${(d.attempts || []).map((a) => `${a.strategy}:${a.result}`).join(' → ') || '—'}`;
}

/**
 * Why did listening end without a transcript? Decided from what the voice
 * service measured (frames, level, speech probability), not guessed. Pure.
 *   no_frames | no_signal | too_quiet | no_speech_detected | only_short_sounds | speech_not_finished | stt_discarded | unknown
 */
function explainNoSpeech(mic, discarded = []) {
  if (!mic) return { cause: 'unknown', lines: ['No microphone statistics were received from the voice service.'] };
  const s = mic.stream || {};
  const head = `microphone "${s.device || '?'}" via ${s.hostApi || '?'}, ${s.sampleRate || 16000} Hz, ${s.channels || 1} channel: ${mic.frames} frames in ${(mic.windowMs / 1000).toFixed(1)} s, peak ${mic.peak}, RMS ${mic.rms}, highest speech probability ${mic.maxSpeechProb} (threshold ${mic.vadThreshold})`;
  if (mic.signal === 'no_frames') return { cause: 'no_frames', lines: [`NO AUDIO FRAMES: ${head}.`, 'The input stream is open but the driver delivers nothing.'] };
  if (mic.signal === 'digital_silence') {
    return { cause: 'no_signal', lines: [
      `NO SIGNAL: ${head}.`,
      'The device delivered only digital silence for the whole listening period: muted or gated at the source, inactive,',
      'or microphone access for desktop apps is switched off in Windows (Settings → Privacy & security → Microphone).',
      'Run mic_smoke.bat: it records the device in the application\'s format and in its native format and shows the level.',
    ] };
  }
  if (discarded.length) {
    const last = discarded[discarded.length - 1];
    return { cause: 'stt_discarded', lines: [`Speech was detected and sent to Whisper, but the transcript was discarded (${last.reason}): "${last.text || ''}". ${head}.`] };
  }
  // a candidate is open right now (older services do not report inSpeech: fall back to the counters)
  const open = mic.inSpeech === undefined ? (mic.speechStarts > (mic.speechEnds || 0) + (mic.discardedShort || 0)) : mic.inSpeech;
  if (open) {
    return { cause: 'speech_not_finished', lines: [`A speech candidate is open but no end of speech was detected (continuous sound?): ${head}.`] };
  }
  if (mic.discardedShort > 0 && !mic.speechEnds) {
    return { cause: 'only_short_sounds', lines: [
      `ONLY SHORT SOUNDS: ${head}; ${mic.framesOverThreshold} frame(s) reached the threshold, ${mic.discardedShort} candidate(s) were shorter than the minimum speech length and were discarded.`,
      'No sustained speech arrived from the device. Run mic_smoke.bat and listen to artifacts/tmp/mic_smoke.wav.',
    ] };
  }
  if (mic.signal === 'very_quiet') return { cause: 'too_quiet', lines: [`SIGNAL TOO QUIET: ${head}.`, 'Raise the input level in Windows or move closer; run mic_smoke.bat to compare input devices.'] };
  return { cause: 'no_speech_detected', lines: [
    `SOUND BUT NO SPEECH DETECTED: ${head}; ${mic.discardedShort || 0} short burst(s) discarded.`,
    'The device carries sound, but the VAD did not classify it as speech. Run mic_smoke.bat: it records the audio so you can listen to what was captured.',
  ] };
}

async function runAcceptance({ companion, io, evidence = 'fake', options = {}, simulateUtterance = null }) {
  const selected = new Set((options.tests && options.tests.length ? options.tests : ALL_TESTS).map((t) => t.toUpperCase()));
  const interactive = options.interactive !== false;
  const nA = options.sttUtterances ?? 3;
  const nE = options.conversationTurns ?? 5;
  const speechTimeoutMs = options.speechTimeoutMs ?? 60000;
  const turnTimeoutMs = options.turnTimeoutMs ?? 120000;
  const loadTimeoutMs = options.loadTimeoutMs ?? 900000;

  const turns = [];
  const sttEvents = [];
  const stateEvents = [];
  const problems = [];
  const onUi = (e) => {
    if (e.type === 'turn') turns.push(e.payload);
    else if (e.type === 'stt') sttEvents.push({ ...e.payload, at: Date.now() });
    else if (e.type === 'state') stateEvents.push(e.payload);
    else if (e.type === 'problem') problems.push(e.payload.message);
  };
  companion.on('ui', onUi);

  const report = {
    schema: 1,
    milestone: 'VC-M0',
    evidence,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    environment: { node: process.version, platform: process.platform },
    tests: {},
    sttComparison: null,
    subjective: {},
    notes: [],
  };
  for (const id of Object.keys(TEST_NAMES)) report.tests[id] = { name: TEST_NAMES[id], status: 'NOT_RUN', checks: [], evidence: {}, user: {} };

  const check = (id, name, ok, detail = '') => {
    report.tests[id].checks.push({ name, ok: Boolean(ok), detail: String(detail) });
    io.say(`    [${ok ? 'ok' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
    return Boolean(ok);
  };
  const ask = async (id, key, question) => {
    if (!interactive) { report.tests[id].user[key] = 'not_asked'; return 'not_asked'; }
    const a = await io.ask(question);
    report.tests[id].user[key] = a;
    return a;
  };
  const finish = (id) => {
    const t = report.tests[id];
    const failed = t.checks.some((c) => !c.ok) || Object.values(t.user).includes('n');
    t.status = failed ? 'FAIL' : 'PASS';
    io.say(`  => Test ${id}: ${t.status}`);
    if (typeof options.onProgress === 'function') options.onProgress(report);
  };

  const waitFor = async (predicate, timeoutMs, pollMs = 25) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return true;
      await sleep(pollMs);
    }
    return predicate();
  };
  const waitIdle = () => waitFor(() => companion.orchestrator.state === 'LISTENING' && !companion.orchestrator.transcribing, turnTimeoutMs);
  const nextTurn = async (fromIndex, timeoutMs) => {
    await waitFor(() => turns.length > fromIndex, timeoutMs);
    return turns[fromIndex] || null;
  };
  const typed = async (text, route) => {
    await waitIdle();
    const from = turns.length;
    const res = companion.sendText(text, route);
    if (!res.accepted) return { accepted: false, reason: res.reason, turn: null, text: '' };
    const turn = await nextTurn(from, turnTimeoutMs);
    const msg = companion.messages.filter((m) => m.turnId === res.turnId && m.role === 'assistant').pop();
    const err = companion.messages.filter((m) => m.turnId === res.turnId && m.role === 'system').pop();
    const d = companion.orchestrator.lastLlmDiag;
    return { accepted: true, turn, text: msg ? msg.text : '', error: err ? err.text : '', llm: d && d.turnId === res.turnId ? d : null };
  };
  /** One typed exchange as shown to the user: the answer, or WHY there is none. */
  const sayExchange = (prompt, r) => {
    io.say(`    > ${prompt}`);
    if (r.text) io.say(`    < ${r.text}`);
    else io.say(`    < (no answer) — ${r.error || (r.accepted === false ? `input rejected: ${r.reason}` : 'no turn completed within the time limit')}`);
    if (r.llm && (r.llm.outcome !== 'ok' || (r.llm.attempts || []).length > 1)) io.say(`      ${describeLlm(r.llm)}`);
  };
  const finite = (v) => Number.isFinite(v);

  // ---------------------------------------------------------------- GUI --
  // Launches the real Electron application in self-test mode (only the live
  // CLI provides this hook). Must run before this script owns the microphone.
  report.gui = { status: 'NOT_RUN' };
  if (typeof options.guiSelfTest === 'function') {
    io.say('--- GUI — Electron application launches and renders ---');
    io.say('  A AI Voice Photo window opens by itself and closes again. Do not touch it.');
    try {
      const g = await options.guiSelfTest();
      report.gui = { status: g.ok ? 'PASS' : 'FAIL', ...g };
      for (const c of g.checks || []) io.say(`    [${c.ok ? 'ok' : 'FAIL'}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
      if (g.error) io.say(`    error: ${String(g.error).split('\n')[0]}`);
    } catch (err) {
      report.gui = { status: 'FAIL', error: err.message, checks: [] };
      io.say(`    GUI self-test could not run: ${err.message}`);
    }
    io.say(`  => GUI: ${report.gui.status}`);
    io.say('');
  }

  // ------------------------------------------------------------ startup --
  io.say('Starting the core and the voice service (first start may download models)…');
  await companion.start();
  await companion.refreshLlm();
  await waitFor(() => {
    const s = companion.statuses();
    return ['mic', 'vad', 'stt', 'tts', 'output'].every((c) => s[c].state !== 'loading');
  }, loadTimeoutMs, 200);

  if (companion.voice.hello && companion.voice.hello.python === 'fake' && report.evidence === 'live') {
    report.evidence = 'fake';
    report.notes.push('Voice service identified itself as the test fake; this report is not live evidence.');
  }

  const statuses = companion.statuses();
  report.components = {};
  io.say('Component status:');
  for (const [name, s] of Object.entries(statuses)) {
    report.components[name] = { state: s.state, detail: s.detail, info: s.info || undefined };
    io.say(`  ${name.padEnd(7)} ${s.state.padEnd(15)} ${s.detail || ''}`);
  }
  const cfg = companion.config.get();
  report.config = {
    stt: cfg.stt, tts: cfg.tts, vad: cfg.vad, audio: cfg.audio, session: cfg.session,
    llm: { provider: cfg.llm.provider, endpoint: cfg.llm.endpoint, configuredModel: cfg.llm.model, temperature: cfg.llm.temperature, topP: cfg.llm.topP, topK: cfg.llm.topK, maxTokens: cfg.llm.maxTokens, disableThinking: cfg.llm.disableThinking },
    persona: { isDefault: companion.personaInfo().isDefault, text: companion.personaInfo().text },
    conversation: { language: cfg.conversation.language },
  };
  report.language = companion.languageStatus();
  report.llmModel = statuses.llm.selectedModel || null;
  report.clockSync = { offsetMs: companion.voice.clockOffsetMs, rttMs: companion.voice.clockRttMs };
  try { report.resourcesAtStart = await companion.getResources(); } catch { report.resourcesAtStart = null; }

  const blocked = (id) => {
    const missing = REQUIRES[id].filter((c) => statuses[c].state !== 'ready');
    if (!missing.length) return false;
    const t = report.tests[id];
    t.status = 'BLOCKED';
    t.evidence.blockedBy = missing.map((c) => `${c}: ${statuses[c].state} — ${statuses[c].detail}`);
    io.say(`  => Test ${id}: BLOCKED (${t.evidence.blockedBy.join('; ')})`);
    return true;
  };
  const begin = (id) => {
    if (!selected.has(id)) { report.tests[id].status = 'SKIPPED'; return false; }
    io.say('');
    io.say(`--- TEST ${id} — ${TEST_NAMES[id]} ---`);
    return !blocked(id);
  };

  companion.orchestrator.setMicMode('off');
  let micDead = null; // set by test A when the microphone measurably delivers no sound

  // ------------------------------------------------------------- TEST B --
  if (begin('B')) {
    const prompts = ['Привет! Как у тебя дела?', 'Что ты любишь делать по вечерам?', 'Посоветуй, чем заняться в дождливый день.'];
    const runs = [];
    for (const p of prompts) {
      const r = await typed(p, 'llm_only');
      runs.push({ prompt: p, response: r.text, error: r.error || '', llm: r.llm, turn: r.turn });
      sayExchange(p, r);
    }
    const ok = runs.filter((r) => r.turn && r.turn.outcome === 'ok');
    report.tests.B.evidence = { model: report.llmModel, runs };
    const outcomes = runs.map((r) => (r.llm ? r.llm.outcome : 'no_llm_exchange'));
    check('B', 'LLM response kind (ok / reasoning_only / empty / parser_failure / request_failed / api_failure)', outcomes.every((o) => o === 'ok'), outcomes.join(', '));
    const lastOk = runs.filter((r) => r.llm && r.llm.outcome === 'ok').pop();
    if (lastOk) io.say(`    thinking control used: ${lastOk.llm.thinkingControl} (${lastOk.llm.attempts.map((a) => `${a.strategy}:${a.result}`).join(' → ')})`);
    check('B', 'LLM reached through LM Studio and answered every prompt', ok.length === prompts.length, `${ok.length}/${prompts.length} ok`);
    check('B', 'Model id reported by LM Studio is recorded', Boolean(report.llmModel), report.llmModel || 'none');
    check('B', 'Answers are Russian text', ok.length > 0 && ok.every((r) => hasCyrillic(r.response)));
    check('B', 'TTFT measured', ok.length > 0 && ok.every((r) => finite(r.turn.derived.llmTtftMs)), ok.map((r) => `${Math.round(r.turn.derived.llmTtftMs)} ms`).join(', '));
    check('B', 'Total generation time measured', ok.length > 0 && ok.every((r) => finite(r.turn.derived.llmTotalMs)), ok.map((r) => `${Math.round(r.turn.derived.llmTotalMs)} ms`).join(', '));
    const reasoning = ok.filter((r) => (r.turn.counters.llmReasoningChars || 0) > 0).length;
    if (reasoning) report.notes.push(`Test B: the model emitted reasoning before answering in ${reasoning}/${ok.length} runs (thinking mode is on; this adds latency).`);
    if (ok.length) await ask('B', 'shortCoherentRussian', 'Are the answers above short, coherent Russian? [y/n]');
    finish('B');
  }

  // ------------------------------------------------------------- TEST C --
  if (begin('C')) {
    const texts = ['Привет! Это проверка синтеза речи.', 'Меня хорошо слышно? Надеюсь, что да.'];
    const runs = [];
    for (const t of texts) {
      const r = await typed(t, 'tts_only');
      runs.push({ text: t, turn: r.turn });
    }
    const ok = runs.filter((r) => r.turn && r.turn.outcome === 'ok');
    report.tests.C.evidence = { voice: report.language.tts.voice, ttsInfo: statuses.tts.info || null, runs };
    check('C', 'Text was synthesized and playback completed', ok.length === texts.length, `${ok.length}/${texts.length} ok`);
    check('C', 'First-audio timing measured', ok.length > 0 && ok.every((r) => finite(r.turn.derived.ttsFirstAudioMs)), ok.map((r) => `${Math.round(r.turn.derived.ttsFirstAudioMs)} ms`).join(', '));
    check('C', 'Playback start observed at the audio device', ok.length > 0 && ok.every((r) => finite(r.turn.timestamps.tPlaybackStart)));
    check('C', 'Audio has a plausible duration', ok.length > 0 && ok.every((r) => (r.turn.counters.ttsAudioMs || 0) > 300), ok.map((r) => `${Math.round(r.turn.counters.ttsAudioMs || 0)} ms`).join(', '));
    await ask('C', 'heardFemaleRussianVoice', 'Did you HEAR a female Russian voice from the speakers? [y/n]');
    finish('C');
  }

  // ------------------------------------------------------------- TEST D --
  if (begin('D')) {
    const sttBefore = sttEvents.length;
    const prompts = ['Расскажи коротко, какая сегодня могла бы быть погода.', 'Какое время года тебе нравится больше всего?', 'Пожелай мне хорошего дня.'];
    const runs = [];
    for (const p of prompts) {
      const r = await typed(p, 'llm_tts');
      runs.push({ prompt: p, response: r.text, error: r.error || '', llm: r.llm, turn: r.turn });
      sayExchange(p, r);
    }
    const ok = runs.filter((r) => r.turn && r.turn.outcome === 'ok');
    report.tests.D.evidence = { runs };
    check('D', 'Response generated and spoken for every prompt', ok.length === prompts.length, `${ok.length}/${prompts.length} ok`);
    check('D', 'No microphone involved', sttEvents.length === sttBefore && companion.orchestrator.micMode === 'off', `mic mode ${companion.orchestrator.micMode}, STT events ${sttEvents.length - sttBefore}`);
    const need = ['llmTtftMs', 'llmTotalMs', 'ttsFirstAudioMs', 'perceivedLatencyMs', 'turnDurationMs'];
    check('D', 'Component timings recorded', ok.length > 0 && ok.every((r) => need.every((k) => finite(r.turn.derived[k]))), ok.map((r) => `submit→audio ${Math.round(r.turn.derived.perceivedLatencyMs)} ms`).join(', '));
    if (ok.length) await ask('D', 'heardSpokenAnswers', 'Were the answers spoken aloud and understandable? [y/n]');
    finish('D');
  }

  // ------------------------------------------------------------- TEST F --
  if (begin('F')) {
    await waitIdle();
    companion.clearSession();
    const first = await typed('Меня интересует красный автомобиль.', 'llm_only');
    const second = await typed('А какого он был цвета?', 'llm_only');
    const req = companion.orchestrator.lastRequest;
    sayExchange('Меня интересует красный автомобиль.', first);
    sayExchange('А какого он был цвета?', second);
    report.tests.F.evidence = { first: first.text, second: second.text, errors: [first.error, second.error].filter(Boolean), secondRequestMessages: req ? req.messages.map((m) => ({ role: m.role, content: m.content })) : null };
    check('F', 'Both turns completed', Boolean(first.turn && second.turn && first.turn.outcome === 'ok' && second.turn.outcome === 'ok'));
    check('F', 'Second request contained the previous turn', Boolean(req && req.messages.length === 4 && /красный/.test(req.messages[1].content)), req ? `${req.messages.length} messages sent` : 'no request');
    const usedContext = /красн/i.test(second.text);
    report.tests.F.evidence.answerMentionsRed = usedContext;
    if (usedContext) check('F', 'Second answer used the context (mentions red)', true);
    else if (!second.text) check('F', 'Second answer used the context', false, 'there was no second answer to judge');
    else await ask('F', 'usedContext', 'The second answer does not contain "красн…". Did it nevertheless use the earlier context correctly? [y/n]');
    finish('F');
  }

  // ------------------------------------------------------------- TEST G --
  if (begin('G')) {
    await waitIdle();
    if (!selected.has('F') || report.tests.F.status === 'BLOCKED') {
      await typed('Меня интересует красный автомобиль.', 'llm_only');
    }
    const before = companion.history.length;
    companion.clearSession();
    const r = await typed('А какого он был цвета?', 'llm_only');
    const req = companion.orchestrator.lastRequest;
    sayExchange('А какого он был цвета?', r);
    report.tests.G.evidence = { historyTurnsBeforeClear: before, response: r.text, requestMessages: req ? req.messages.map((m) => ({ role: m.role, content: m.content })) : null };
    check('G', 'History existed before Clear Session', before >= 1, `${before} turn(s)`);
    check('G', 'Request after Clear Session contains only system + current message', Boolean(req && req.messages.length === 2 && req.messages[0].role === 'system' && req.messages[1].role === 'user'), req ? req.messages.map((m) => m.role).join(', ') : 'no request');
    check('G', 'No earlier content in the active LLM context', Boolean(req && !/красн/i.test(JSON.stringify(req.messages))));
    report.tests.G.evidence.answerMentionsRed = /красн/i.test(r.text);
    finish('G');
    companion.clearSession();
  }

  // ------------------------------------------------------------- TEST A --
  if (begin('A')) {
    await waitIdle();
    const aFrom = turns.length;
    companion.orchestrator.setMicMode('stt_only');
    io.say(`  Speak ${nA} normal Russian sentences, one at a time. Suggested:`);
    STT_SENTENCES.slice(0, nA).forEach((s, i) => io.say(`    ${i + 1}. ${s}`));
    if (interactive) await io.pause('  Press Enter, then speak the first sentence…');
    const results = [];
    io.say(`  Microphone in use: ${statuses.mic.detail || '?'}`);
    for (let i = 0; i < nA; i++) {
      const from = turns.length;
      io.say(`  [${i + 1}/${nA}] Listening… speak now.`);
      if (simulateUtterance) simulateUtterance(STT_SENTENCES[i % STT_SENTENCES.length]);
      const sttFrom = sttEvents.length;
      const tListen = Date.now();
      const turn = await nextTurn(from, speechTimeoutMs);
      if (!turn) {
        // Say what the microphone delivered instead of only "nothing recognized".
        let mic = null;
        try { mic = await companion.getMicStats(); } catch { mic = companion.lastMicStats; }
        const discarded = sttEvents.slice(sttFrom).filter((s) => !s.accepted);
        const why = explainNoSpeech(mic, discarded);
        io.say(`      (nothing recognized within ${Math.round((Date.now() - tListen) / 1000)} s)`);
        for (const line of why.lines) io.say(`      ${line}`);
        results.push({ expected: STT_SENTENCES[i % STT_SENTENCES.length], text: null, turn: null, microphone: mic, discarded, cause: why.cause });
        if (why.cause === 'no_signal' || why.cause === 'no_frames') {
          io.say('      The remaining sentences are skipped: the selected microphone delivers no sound, so waiting again cannot succeed.');
          micDead = why.lines[0];
          break;
        }
        continue;
      }
      const stt = sttEvents.filter((s) => s.accepted).pop();
      results.push({ expected: STT_SENTENCES[i % STT_SENTENCES.length], text: stt ? stt.text : '', turn, microphone: companion.lastMicStats });
      io.say(`      recognized: "${stt ? stt.text : ''}"  (speech end → transcript ${Math.round(turn.derived.speechEndToSttFinalMs)} ms)`);
      await sleep(300);
    }
    await sleep(1500);
    const extra = Math.max(0, turns.slice(aFrom).filter((t) => t.mode === 'stt_only').length - results.filter((r) => r.turn).length);
    companion.orchestrator.setMicMode('off');
    const ok = results.filter((r) => r.turn && r.text);
    report.tests.A.evidence = { stt: statuses.stt.info || null, mic: statuses.mic.info || null, results, microphoneDeliversNoSound: micDead };
    if (micDead) check('A', 'Microphone delivers sound', false, micDead);
    check('A', 'Speech detected and transcribed', ok.length === nA, `${ok.length}/${nA} utterances`);
    check('A', 'Transcripts are Russian text', ok.length > 0 && ok.every((r) => hasCyrillic(r.text)));
    check('A', 'Finalization latency recorded', ok.length > 0 && ok.every((r) => finite(r.turn.derived.sttFinalizeMs) && finite(r.turn.derived.vadEndDelayMs)), ok.map((r) => `${Math.round(r.turn.derived.sttFinalizeMs)} ms`).join(', '));
    // Informational only: in STT-only mode nothing is played back, so there is
    // nothing to self-trigger on. The self-trigger checks are part of test E.
    report.tests.A.evidence.extraUtterancesAfterLastSentence = extra;
    if (extra) report.notes.push(`Test A: ${extra} additional utterance(s) were transcribed after the last requested sentence (background speech or noise).`);
    if (ok.length) await ask('A', 'transcriptsCorrect', 'Were the transcripts above essentially correct? [y/n]');
    finish('A');

    if (options.compareStt !== false && ok.length > 0 && report.tests.A.status !== 'BLOCKED') {
      const current = cfg.stt.model;
      const other = current === 'base' ? 'small' : 'base';
      io.say(`  Comparing STT models on the SAME recorded audio: ${current} (current) vs ${other}…`);
      try {
        const before = await companion.getResources();
        const res = await companion.voice.request({ cmd: 'stt_retranscribe', model: other }, 300000);
        const after = await companion.getResources();
        report.sttComparison = { currentModel: current, otherModel: other, otherInfo: res.model, results: res.results, gpuBefore: before.voice && before.voice.gpu, gpuAfter: after.voice && after.voice.gpu };
        for (const row of res.results) {
          io.say(`      ${current}: ${Math.round(row.referenceSttMs)} ms "${row.referenceText}"`);
          io.say(`      ${other.padEnd(current.length)}: ${Math.round(row.sttMs)} ms "${row.text}"`);
        }
      } catch (err) {
        report.sttComparison = { error: err.message };
        io.say(`      comparison not available: ${err.message}`);
      }
    }
  }

  // ------------------------------------------------------------- TEST E --
  if (micDead && selected.has('E')) {
    // Not a guess: test A measured that the selected microphone carries no sound.
    io.say('');
    io.say(`--- TEST E — ${TEST_NAMES.E} ---`);
    report.tests.E.status = 'BLOCKED';
    report.tests.E.evidence.blockedBy = [`microphone: ${micDead}`];
    io.say(`  => Test E: BLOCKED (${micDead})`);
  } else if (begin('E')) {
    await waitIdle();
    companion.clearSession();
    const eFrom = turns.length;
    const rejectedBefore = companion.orchestrator.rejectedInputs;
    io.say(`  Have a short spoken conversation: ${nE} things, waiting for each answer. Suggested:`);
    CONVERSATION_PROMPTS.slice(0, nE).forEach((s, i) => io.say(`    ${i + 1}. ${s}`));
    if (interactive) await io.pause('  Press Enter, then say the first thing…');
    companion.orchestrator.setMicMode('full');
    const results = [];
    let busyProbe = null;
    for (let i = 0; i < nE; i++) {
      await waitIdle();
      const from = turns.length;
      const transFrom = companion.stateMachine.history.length;
      io.say(`  [${i + 1}/${nE}] Listening… speak now.`);
      if (simulateUtterance) simulateUtterance(CONVERSATION_PROMPTS[i % CONVERSATION_PROMPTS.length]);
      // wait for the turn to start, probe "busy" once, then wait for it to finish
      const started = await waitFor(() => companion.orchestrator.state !== 'LISTENING' || turns.length > from, speechTimeoutMs);
      if (started && busyProbe === null && i >= 1) {
        await waitFor(() => companion.orchestrator.state === 'SPEAKING' || turns.length > from, turnTimeoutMs);
        if (companion.orchestrator.state === 'SPEAKING') {
          const res = companion.sendText('проверка занятости', 'llm_only');
          busyProbe = { state: 'SPEAKING', accepted: res.accepted, reason: res.reason || '' };
        }
      }
      const turn = started ? await nextTurn(from, turnTimeoutMs) : null;
      if (!turn) { io.say('      (no completed turn within the time limit)'); results.push({ turn: null }); continue; }
      const user = companion.messages.filter((m) => m.turnId === turn.turnId && m.role === 'user').pop();
      const assistant = companion.messages.filter((m) => m.turnId === turn.turnId && m.role === 'assistant').pop();
      const transitions = companion.stateMachine.history.slice(transFrom).map((h) => `${h.from}>${h.to}`);
      const prevAssistant = results.length && results[results.length - 1].assistant;
      results.push({
        user: user ? user.text : '', assistant: assistant ? assistant.text : '', turn, transitions,
        // an utterance that mostly repeats the companion's previous answer suggests
        // the microphone picked up the companion's own voice
        echoOverlap: prevAssistant && user && words(user.text).size >= 4 ? overlap(user.text, prevAssistant) : 0,
      });
      io.say(`      you:       "${user ? user.text : ''}"`);
      io.say(`      companion: "${assistant ? assistant.text : ''}"`);
      io.say(`      speech end → first audio: ${Math.round(turn.derived.perceivedLatencyMs)} ms  (VAD ${Math.round(turn.derived.vadEndDelayMs)} + STT ${Math.round(turn.derived.sttFinalizeMs)} + LLM first token ${Math.round(turn.derived.llmFirstContentMs)} + TTS ${Math.round(turn.derived.ttsFirstAudioMs)} …)`);
    }
    // stay silent: nothing may start by itself after the last answer
    await waitIdle();
    const quietFrom = turns.length;
    const sttQuietFrom = sttEvents.length;
    io.say('  Please stay silent for a few seconds…');
    await sleep(options.quietMs ?? 4000);
    const selfStarted = turns.length - quietFrom;
    const quietStt = sttEvents.slice(sttQuietFrom).map((s) => s.text);
    companion.orchestrator.setMicMode('off');

    const ok = results.filter((r) => r.turn && r.turn.outcome === 'ok');
    const expectedSeq = 'LISTENING>THINKING,THINKING>SPEAKING,SPEAKING>LISTENING';
    report.tests.E.evidence = {
      results, busyProbe, selfStartedTurnsAfterLastAnswer: selfStarted, transcriptsDuringSilence: quietStt,
      rejectedInputsDuringTest: companion.orchestrator.rejectedInputs - rejectedBefore,
    };
    check('E', 'Every spoken turn completed', ok.length === nE, `${ok.length}/${nE} turns ok`);
    check('E', 'State transitions LISTENING → THINKING → SPEAKING → LISTENING for every turn', ok.length > 0 && ok.every((r) => r.transitions.join(',') === expectedSeq), ok.map((r) => r.transitions.join(',') === expectedSeq ? 'ok' : r.transitions.join(',')).join(' | '));
    const fullTurns = turns.slice(eFrom).filter((t) => t.mode === 'full').length;
    const prompted = results.filter((r) => r.turn).length;
    check('E', 'Exactly one turn per spoken utterance (no extra request while THINKING/SPEAKING)', prompted > 0 && fullTurns - selfStarted === prompted, `${fullTurns - selfStarted} turn(s) for ${prompted} utterance(s)`);
    if (busyProbe) check('E', 'Typed input during SPEAKING was rejected', busyProbe.accepted === false, busyProbe.reason);
    else report.notes.push('Test E: the busy-input probe did not run (no turn reached SPEAKING while probing).');
    check('E', 'Returned to LISTENING after playback', companion.orchestrator.state === 'LISTENING');
    const need = ['speechDurationMs', 'vadEndDelayMs', 'sttFinalizeMs', 'llmFirstContentMs', 'llmTotalMs', 'ttsFirstAudioMs', 'perceivedLatencyMs', 'turnDurationMs'];
    check('E', 'End-to-end timestamps recorded for every turn', ok.length > 0 && ok.every((r) => need.every((k) => finite(r.turn.derived[k]))));
    const echoes = ok.filter((r) => r.echoOverlap >= 0.6);
    check('E', 'Companion did not answer its own voice (no echo-like user transcripts)', echoes.length === 0, echoes.length ? `${echoes.length} suspicious transcript(s)` : '');
    check('E', 'Nothing started by itself during silence after the last answer', selfStarted === 0, selfStarted ? `${selfStarted} self-started turn(s): ${quietStt.join(' | ')}` : '');
    await ask('E', 'coherentConversation', 'Was the spoken conversation coherent (it heard you, answered sensibly, spoke the answers)? [y/n]');
    finish('E');
    if (interactive) {
      report.subjective.responsiveEnough = await io.ask('Did the conversation feel responsive enough to be conversational? [y/n]');
      report.subjective.voiceQualityAcceptable = await io.ask('Was the voice quality acceptable for a baseline? [y/n]');
    }
  }

  // ------------------------------------------------------------- TEST L --
  // Language configuration: evaluated over everything that ran above.
  const runL = selected.has('L');
  let languageBeforeRestart = null;
  if (runL) {
    io.say('');
    io.say(`--- TEST L — ${TEST_NAMES.L} ---`);
    const lang = companion.languageStatus();
    const defaults = companion.config.defaults;
    const voiceTurns = turns.filter((t) => t.input === 'voice' && t.counters.language);
    const allWithLang = turns.filter((t) => t.counters.language);
    const answers = companion.messages.filter((m) => m.role === 'assistant').map((m) => m.text)
      .concat(Object.values(report.tests).flatMap((t) => (t.evidence.runs || []).map((r) => r.response).filter(Boolean)));
    const shares = answers.map(cyrillicShare);
    const female = (lang.tts.voices || []).filter((v) => v.gender === 'female').map((v) => v.id);
    report.tests.L.evidence = {
      defaultLanguage: defaults.conversation.language,
      language: lang,
      voiceTurnLanguages: voiceTurns.map((t) => ({ turnId: t.turnId, ...t.counters.language })),
      answersChecked: answers.length,
      lowestCyrillicShare: shares.length ? Math.min(...shares) : null,
    };
    check('L', 'Conversation language defaults to Russian (Русский)', defaults.conversation.language === 'ru' && lang.conversation.code === 'ru' && lang.conversation.name === 'Русский', `default ${defaults.conversation.language}, active ${lang.conversation.code} (${lang.conversation.name})`);
    check('L', 'STT processed speech as Russian', voiceTurns.length > 0 && voiceTurns.every((t) => t.counters.language.stt === 'ru'), voiceTurns.length ? `${voiceTurns.length} voice turn(s), STT language: ${[...new Set(voiceTurns.map((t) => t.counters.language.stt))].join(', ')}` : 'no voice turns were recorded (tests A/E did not run)');
    check('L', 'LLM was instructed in Russian and answered in Russian', lang.llm.instruction === 'ru' && answers.length > 0 && shares.every((x) => x >= 0.9), answers.length ? `${answers.length} answer(s), lowest Cyrillic share ${(Math.min(...shares) * 100).toFixed(0)}%` : 'no LLM answers were recorded');
    check('L', 'TTS is loaded for Russian with the configured female voice', lang.tts.loaded === 'ru' && lang.tts.voiceLoaded === lang.tts.voice && female.includes(lang.tts.voiceLoaded), `${lang.tts.loaded} / ${lang.tts.voiceLoaded}`);
    check('L', 'Diagnostics show the same language at every stage, for every turn', lang.coherent && allWithLang.length > 0 && allWithLang.every((t) => t.counters.language.coherent), lang.coherent ? `${allWithLang.length} turn(s) coherent` : lang.mismatches.join('; '));
    if (report.gui.status !== 'NOT_RUN') {
      const shown = report.gui.dom && report.gui.dom.conversationLanguage;
      check('L', 'Freshly started application shows the conversation language in Settings', Boolean(shown && shown.value === 'ru' && shown.label === 'Русский'), shown ? `${shown.value} / ${shown.label}` : 'not reported by the GUI self-test');
    }
    // persist explicitly, then verify after the core has been shut down (below)
    companion.updateConfig({ conversation: { language: lang.conversation.code } });
    languageBeforeRestart = lang.conversation.code;
  } else {
    report.tests.L.status = 'SKIPPED';
  }

  // ------------------------------------------------------------- wrap up --
  try { report.resourcesAtEnd = await companion.getResources(); } catch { report.resourcesAtEnd = null; }
  report.turns = turns.slice();
  report.summary = {};
  for (const mode of ['full', 'text_llm_tts', 'llm_only', 'tts_only', 'stt_only']) {
    const ok = turns.filter((t) => t.mode === mode && t.outcome === 'ok');
    const all = turns.filter((t) => t.mode === mode);
    report.summary[mode] = { okTurns: ok.length, failedTurns: all.length - ok.length, intervals: summarizeTurns(ok, DERIVED_KEYS) };
  }
  report.stateTransitions = companion.stateMachine.history.slice();
  report.problems = problems.slice();
  report.rejectedInputs = companion.orchestrator.rejectedInputs;
  report.ttsStreaming = { sentenceChunked: Boolean(cfg.tts.sentenceStreaming), incrementalAudio: false, note: 'Silero apply_tts returns the complete waveform per text chunk; audio is not streamed incrementally.' };

  // Both owned processes must be gone: the process the core started (on Windows
  // a venv launcher) and the service process it reported in `hello`.
  const spawnPid = companion.voice.spawnPid ?? null;
  const servicePid = companion.voice.servicePid ?? (companion.voice.hello ? companion.voice.hello.pid : null);
  const relation = companion.voice.processRelation ?? null;
  companion.off('ui', onUi);
  const stopped = await companion.shutdown();
  await sleep(300);
  const spawnAlive = spawnPid ? pidAlive(spawnPid) : false;
  const serviceAlive = servicePid ? pidAlive(servicePid) : false;
  report.cleanShutdown = {
    startedProcessPid: spawnPid,
    voiceServicePid: servicePid,
    relation,
    how: stopped ? stopped.how : null,
    serviceKilledExplicitly: stopped ? stopped.serviceKilledExplicitly : null,
    startedProcessStillRunning: spawnAlive,
    voiceServiceStillRunning: serviceAlive,
    stillRunning: spawnAlive || serviceAlive,
  };

  if (runL) {
    // "restart": the core is stopped; read the configuration from disk again
    let persisted = null;
    try {
      persisted = new ConfigStore({ defaultPath: companion.config.defaultPath, userPath: companion.config.userPath }).get().conversation.language;
    } catch (err) {
      persisted = `error: ${err.message}`;
    }
    report.tests.L.evidence.persistedAfterRestart = persisted;
    check('L', 'Selected conversation language persisted across a restart of the core', persisted === languageBeforeRestart, `on disk: ${persisted}`);
    finish('L');
  }

  const required = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'L'];
  const statusOf = (id) => report.tests[id].status;
  let functional;
  if (required.every((id) => statusOf(id) === 'PASS')) functional = 'PASS';
  else if (required.some((id) => statusOf(id) === 'BLOCKED')) functional = 'BLOCKED';
  else if (required.some((id) => statusOf(id) === 'FAIL')) functional = 'FAIL';
  else functional = 'INCOMPLETE';
  if (report.gui.status === 'FAIL' && functional === 'PASS') functional = 'FAIL';
  const confirmations = Object.values(report.tests).flatMap((t) => Object.values(t.user));
  let performance = 'NOT_JUDGED';
  if (report.subjective.responsiveEnough === 'y') performance = 'ACCEPTED_BY_USER';
  if (report.subjective.responsiveEnough === 'n') performance = 'NEEDS_OPTIMIZATION';
  report.overall = {
    functional,
    performance,
    userConfirmationsMissing: confirmations.includes('not_asked'),
    blockers: required.filter((id) => statusOf(id) === 'BLOCKED').flatMap((id) => report.tests[id].evidence.blockedBy.map((b) => `${id}: ${b}`)),
    guiVisualAcceptance: 'USER_REVIEW_PENDING',
  };
  report.finishedAt = new Date().toISOString();
  return report;
}

module.exports = { runAcceptance, ALL_TESTS, TEST_NAMES, overlap, cyrillicShare, describeLlm, explainNoSpeech };
