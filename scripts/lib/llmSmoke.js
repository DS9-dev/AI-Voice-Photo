'use strict';
/**
 * Direct LLM check: the application's own LLM provider, configuration and
 * system prompt against the real LM Studio, without Electron, the voice
 * service or TTS. Shows exactly what is sent and what comes back (shape and
 * counts; reasoning text is never printed or stored).
 *
 * Transport-agnostic so it can be unit tested against the fake server; only
 * scripts/llm_smoke.js runs it against the real one.
 */
const { LMStudioProvider } = require('../../core/providers/lmStudioProvider');
const { resolveLanguageProfile } = require('../../core/language/languages');
const { buildMessages } = require('../../core/conversation/prompt');
const { nowMs } = require('../../core/util/clock');

const GREETING = 'Привет! Как у тебя дела?';
/**
 * History transport is tested with a code word instead of a judgement about
 * a free-form answer: the model is told a word, then asked for it. The word is
 * picked at random per run, so it can only come back if the earlier exchange
 * really reached the model; the same question without history is the control.
 * (Nouns whose Russian inflections only append letters, so a plain substring
 * match is enough.)
 */
const CODE_WORDS = ['самовар', 'кактус', 'барабан', 'глобус', 'компас', 'жираф', 'зонтик', 'маяк'];
const memorizePrompt = (word) => `Запомни одно слово: «${word}». Ответь коротко, что запомнила.`;
const RECALL_PROMPT = 'Какое слово я только что попросил тебя запомнить? Назови это слово.';
const normalize = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
const mentions = (text, word) => normalize(text).includes(normalize(word));
const hasCyrillic = (s) => /[А-Яа-яЁё]/.test(s || '');
const ms = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? Math.round(b - a) : null);

function describeExchange(d) {
  const sse = d.sse || {};
  const keys = Object.entries(sse.deltaKeys || {}).map(([k, n]) => `${k}×${n}`).join(' ') || 'none';
  const lines = [];
  const { messages, ...fields } = d.request || {};
  lines.push(`request : POST ${d.url}`);
  lines.push(`          ${JSON.stringify(fields)}`);
  lines.push(`          messages: ${(messages || []).map((m) => `${m.role}(${m.chars} chars)`).join(', ')}`);
  lines.push(`response: HTTP ${d.httpStatus ?? '—'}, ${d.contentType || 'no content-type'}; ${sse.events ?? 0} stream events${sse.unparsed ? ` (${sse.unparsed} not JSON)` : ''}; delta fields ${keys}`);
  lines.push(`          finish_reason ${d.finishReason ?? '—'}; usage ${d.usage ? JSON.stringify(d.usage) : 'not reported'}`);
  lines.push(`thinking: control "${d.thinkingControl}"; attempts ${(d.attempts || []).map((a) => `${a.strategy}:${a.result}${a.status ? `(${a.status})` : ''}`).join(' → ')}`);
  return lines;
}

async function runLlmSmoke({ config, say = console.log, fetchImpl, thinkProbe = true, codeWord = null }) {
  const word = codeWord || CODE_WORDS[Math.floor(Math.random() * CODE_WORDS.length)];
  // temperature 0 for the code-word exchanges: they test transport, not style
  const steps = [
    { id: 'greeting', prompt: GREETING, params: undefined },
    { id: 'memorize', prompt: memorizePrompt(word), params: { temperature: 0 } },
    { id: 'recall', prompt: RECALL_PROMPT, params: { temperature: 0 } },
  ];
  const report = { generatedAt: new Date().toISOString(), endpoint: config.llm.endpoint, checks: [], exchanges: [], ok: false };
  report.codeWord = word;
  const check = (name, ok, detail = '') => {
    report.checks.push({ name, ok: Boolean(ok), detail: String(detail) });
    say(`  [${ok ? 'ok' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
    return Boolean(ok);
  };
  const provider = new LMStudioProvider({ getConfig: () => config.llm, fetchImpl });
  const profile = resolveLanguageProfile(config);

  say(`Endpoint: ${config.llm.endpoint}`);
  const conn = await provider.checkConnectivity();
  report.connectivity = { ok: conn.ok, error: conn.error, selectedModel: conn.selectedModel, selectedReason: conn.selectedReason, models: conn.models };
  for (const m of conn.models || []) say(`  model ${m.id}${m.loaded === true ? '  [loaded]' : m.loaded === false ? '' : '  [state unknown]'}${m.type ? `  (${m.type})` : ''}`);
  if (!check('LM Studio server reachable and a model selected', conn.ok, conn.ok ? `${conn.selectedModel} (${conn.selectedReason})` : conn.error)) {
    report.conclusion = 'request_failed: the LM Studio server could not be used. Start the local server in LM Studio and load the model.';
    say(`\n${report.conclusion}`);
    return report;
  }
  const model = conn.selectedModel;
  report.model = model;
  report.settings = { temperature: config.llm.temperature, topP: config.llm.topP, topK: config.llm.topK, maxTokens: config.llm.maxTokens, disableThinking: config.llm.disableThinking, reasoningBudgetTokens: config.llm.reasoningBudgetTokens };

  // The same message layout as a conversation: system prompt, history, new message.
  const history = [];
  for (const step of steps) {
    const prompt = step.prompt;
    say('');
    say(`> ${prompt}${step.params ? '   (temperature 0)' : ''}`);
    const messages = buildMessages({ systemPrompt: profile.llm.systemPrompt, historyMessages: history, userText: prompt });
    const ex = { id: step.id, prompt, outcome: null, text: '', error: null, sent: messages.map((m) => ({ role: m.role, chars: m.content.length })) };
    const t0 = nowMs();
    try {
      const r = await provider.streamChat({ model, messages, params: step.params });
      Object.assign(ex, {
        outcome: r.outcome, text: r.text, diagnosis: r.diagnosis, diag: r.diag, notes: r.notes,
        reasoningTokens: r.usage.reasoningTokens, reasoningChars: r.diag.reasoningChars,
        ttftMs: ms(r.timings.tRequest, r.timings.tFirstToken), firstContentMs: ms(r.timings.tRequest, r.timings.tFirstContent), totalMs: ms(r.timings.tRequest, r.timings.tDone),
      });
      for (const line of describeExchange(r.diag)) say(`  ${line}`);
      say(`  timing  : first token ${ex.ttftMs} ms, first answer text ${ex.firstContentMs} ms, complete ${ex.totalMs} ms`);
      for (const n of r.notes) say(`  note    : ${n}`);
      say(`  outcome : ${r.outcome}${r.diagnosis ? ` — ${r.diagnosis}` : ''}`);
      say(r.text ? `< ${r.text}` : '< (no answer)');
      if (r.text) history.push({ role: 'user', content: prompt }, { role: 'assistant', content: r.text });
    } catch (err) {
      Object.assign(ex, { outcome: err.outcome || 'request_failed', error: err.message, diag: err.diag || null, totalMs: Math.round(nowMs() - t0) });
      if (err.diag) for (const line of describeExchange(err.diag)) say(`  ${line}`);
      say(`  outcome : ${ex.outcome} — ${err.message}`);
      say('< (no answer)');
    }
    report.exchanges.push(ex);
  }

  // Control for the history test: the same question with NO history must not produce the word.
  const recall = report.exchanges.find((e) => e.id === 'recall');
  let control = null;
  if (recall && recall.outcome === 'ok') {
    say('');
    say(`Control: the recall question in a fresh context (no history)…`);
    try {
      const messages = buildMessages({ systemPrompt: profile.llm.systemPrompt, historyMessages: [], userText: RECALL_PROMPT });
      const r = await provider.streamChat({ model, messages, params: { temperature: 0 } });
      control = { outcome: r.outcome, text: r.text, mentionsCodeWord: mentions(r.text, word), sent: messages.map((m) => ({ role: m.role, chars: m.content.length })) };
      say(`< ${r.text || '(no answer)'}`);
    } catch (err) {
      control = { outcome: err.outcome || 'request_failed', error: err.message, text: '', mentionsCodeWord: false };
      say(`  control request failed: ${err.message}`);
    }
    report.historyControl = control;
  }

  // Informational: does this model think when it is NOT told to stop?
  if (thinkProbe) {
    say('');
    say('Control: the same model without any switch-off (48 tokens only)…');
    try {
      const messages = buildMessages({ systemPrompt: profile.llm.systemPrompt, historyMessages: [], userText: GREETING });
      const r = await provider.streamChat({ model, messages, params: { disableThinking: false, maxTokens: 48, reasoningBudgetTokens: 0 } });
      const thinks = r.diag.reasoningChars > 0;
      report.thinksByDefault = { thinks, reasoningTokens: r.usage.reasoningTokens, deltaKeys: r.diag.sse.deltaKeys, outcome: r.outcome };
      say(`  ${thinks ? 'This model THINKS by default' : 'This model does not think by default'}: delta fields ${Object.entries(r.diag.sse.deltaKeys).map(([k, n]) => `${k}×${n}`).join(' ')}; outcome ${r.outcome}.`);
    } catch (err) {
      report.thinksByDefault = { error: err.message };
      say(`  control request failed: ${err.message}`);
    }
  }

  say('');
  const ex = report.exchanges;
  const ok = ex.filter((e) => e.outcome === 'ok');
  check('Every prompt got an answer', ok.length === ex.length, ex.map((e) => e.outcome).join(', '));
  check('Answers are Russian text', ok.length > 0 && ok.every((e) => hasCyrillic(e.text)));
  check('No reasoning in front of the answers', ok.length > 0 && ok.every((e) => !e.reasoningChars), ok.map((e) => `${e.reasoningTokens ?? e.reasoningChars} reasoning`).join(', '));
  check('Time to first token measured', ok.length > 0 && ok.every((e) => Number.isFinite(e.ttftMs)), ok.map((e) => `${e.ttftMs} ms`).join(', '));
  // Session history, tested as transport:
  //  1. what the client put on the wire for the recall request (model-independent),
  //  2. the code word comes back when the history is there,
  //  3. and does not come back when it is not.
  if (recall && recall.diag) {
    const wire = (recall.diag.request && recall.diag.request.messages) || [];
    const earlier = ex.slice(0, ex.indexOf(recall));
    const expected = [
      { role: 'system', chars: profile.llm.systemPrompt.trim().length },
      ...earlier.flatMap((e) => [{ role: 'user', chars: e.prompt.length }, { role: 'assistant', chars: e.text.length }]),
      { role: 'user', chars: RECALL_PROMPT.length },
    ];
    const same = earlier.every((e) => e.outcome === 'ok') && JSON.stringify(wire.map((m) => ({ role: m.role, chars: m.chars }))) === JSON.stringify(expected);
    check('The recall request carried the whole session history (system prompt, both earlier exchanges, the question)', same,
      `${wire.map((m) => `${m.role}(${m.chars})`).join(', ')}`);
  }
  if (recall && recall.outcome === 'ok') {
    check(`With the history, the model returned the code word «${word}»`, mentions(recall.text, word), recall.text.slice(0, 100));
    if (control) {
      check('Without the history, the code word is not returned (control)', control.outcome === 'ok' && !control.mentionsCodeWord,
        control.outcome === 'ok' ? control.text.slice(0, 100) : `control request: ${control.outcome}`);
    }
  }
  report.thinkingControl = provider.thinkingControl(model);
  report.ok = report.checks.every((c) => c.ok);

  const kinds = [...new Set(ex.map((e) => e.outcome))];
  report.conclusion = report.ok
    ? `ok: the model answers through ${config.llm.endpoint} with thinking control "${report.thinkingControl ? report.thinkingControl.strategy : 'none needed'}".`
    : `Problem kind(s): ${kinds.filter((k) => k !== 'ok').join(', ') || 'see the failed checks'}.`;
  say(report.conclusion);
  return report;
}

module.exports = { runLlmSmoke, describeExchange, CODE_WORDS, RECALL_PROMPT, memorizePrompt, mentions };
