'use strict';
/**
 * The LLM smoke procedure against the fake LM Studio. Proves the procedure;
 * only llm_smoke.bat on the target PC says anything about the real server.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { normalizeConfig } = require('../../core/config/configStore');
const { createFakeLmStudio } = require('../fixtures/fake_lmstudio');
const { runLlmSmoke, CODE_WORDS, RECALL_PROMPT, mentions } = require('../../scripts/lib/llmSmoke');

const DEFAULTS = require(path.join('..', '..', 'config', 'default.json'));

/** A model that can only repeat the word if the earlier exchange is in the request. */
function recallingReply(body) {
  const users = body.messages.filter((m) => m.role === 'user').map((m) => m.content);
  const last = users[users.length - 1];
  if (last === RECALL_PROMPT) {
    const told = users.map((u) => /«([^»]+)»/.exec(u)).filter(Boolean).pop();
    return { content: told ? `Ты просил запомнить слово ${told[1]}.` : 'Ты мне ещё ничего не называл.' };
  }
  return { content: /Запомни/.test(last) ? 'Хорошо, запомнила.' : 'Привет! У меня всё хорошо.' };
}

async function run(lm, llmPatch = {}, options = {}) {
  const fake = createFakeLmStudio({ reply: recallingReply, ...lm });
  const endpoint = await fake.start();
  const config = normalizeConfig({ llm: { endpoint, ...llmPatch } }, DEFAULTS);
  const said = [];
  try {
    const report = await runLlmSmoke({ config, say: (t) => said.push(t), ...options });
    return { report, out: said.join('\n'), fake };
  } finally { await fake.stop(); }
}

test('server behaving like the target PC: PASS, thinking switched off by the request, context used', async () => {
  const { report, out, fake } = await run({ emulateQwenThinking: true });
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => !c.ok)));
  assert.equal(report.model, 'qwen/qwen3.5-9b');
  assert.deepEqual(report.exchanges.map((e) => e.outcome), ['ok', 'ok', 'ok']);
  assert.deepEqual(report.thinkingControl, { strategy: 'effort', minimal: false });
  assert.equal(report.thinksByDefault.thinks, true, 'the control request shows the model would think if not told otherwise');
  assert.match(out, /request : POST http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions/);
  assert.match(out, /"reasoning_effort":"none"/);
  assert.match(out, /messages: system\(\d+ chars\), user\(\d+ chars\), assistant\(\d+ chars\), user\(\d+ chars\)/, 'later requests carry the session history');
  assert.match(out, /response: HTTP 200, text\/event-stream; \d+ stream events; delta fields role×1 content×\d+/);
  assert.match(out, /This model THINKS by default: delta fields role×1 reasoning_content×48/);
  assert.deepEqual(fake.state.requests[2].messages.map((m) => m.role), ['system', 'user', 'assistant', 'user', 'assistant', 'user'], 'the third request carries both earlier exchanges');
  // history transport: code word, wire check, control
  assert.ok(CODE_WORDS.includes(report.codeWord));
  const names = report.checks.map((c) => c.name);
  assert.ok(names.some((n) => n.startsWith('The recall request carried the whole session history')));
  assert.ok(names.includes(`With the history, the model returned the code word «${report.codeWord}»`));
  assert.ok(names.includes('Without the history, the code word is not returned (control)'));
  assert.equal(report.historyControl.mentionsCodeWord, false);
  assert.deepEqual(fake.state.requests[3].messages.map((m) => m.role), ['system', 'user'], 'the control request has no history');
  assert.equal(fake.state.requests[1].temperature, 0);
  assert.equal(fake.state.requests[0].temperature, 0.7, 'the greeting uses the application settings');
});

test('history check is about transport: the same model fails it when the history does not reach it', async () => {
  // a server-side fault: only the last user message is kept
  const dropHistory = (body) => recallingReply({ messages: [body.messages[0], body.messages[body.messages.length - 1]] });
  const { report } = await run({ reply: dropHistory }, {}, { codeWord: 'самовар', thinkProbe: false });
  assert.equal(report.ok, false);
  const failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(failed, ['With the history, the model returned the code word «самовар»']);
  const wire = report.checks.find((c) => c.name.startsWith('The recall request carried'));
  assert.equal(wire.ok, true, 'the client did send the history; the answer shows it was not used');
});

test('history check does not pass on an answer that merely sounds right', async () => {
  // an answer that would satisfy a "mentions a colour / sounds on-topic" style of check
  const vague = (body) => {
    const last = body.messages.filter((m) => m.role === 'user').pop().content;
    return { content: last === RECALL_PROMPT ? 'Ты просил запомнить одно слово, я его помню.' : 'Хорошо.' };
  };
  const { report } = await run({ reply: vague }, {}, { codeWord: 'кактус', thinkProbe: false });
  assert.equal(report.checks.find((c) => c.name.includes('returned the code word')).ok, false);
});

test('control catches a code word that leaks without history', async () => {
  const leaky = (body) => {
    const last = body.messages.filter((m) => m.role === 'user').pop().content;
    return { content: last === RECALL_PROMPT ? 'Это слово глобус.' : 'Хорошо.' };
  };
  const { report } = await run({ reply: leaky }, {}, { codeWord: 'глобус', thinkProbe: false });
  assert.equal(report.checks.find((c) => c.name.includes('returned the code word')).ok, true);
  assert.equal(report.checks.find((c) => c.name.startsWith('Without the history')).ok, false);
  assert.equal(report.ok, false);
});

test('code word matching tolerates case, ё and inflection, and nothing else', () => {
  assert.equal(mentions('Ты просил запомнить слово «Самовар».', 'самовар'), true);
  assert.equal(mentions('Речь шла о самоваре.', 'самовар'), true);
  assert.equal(mentions('Про жирафа.', 'жираф'), true);
  assert.equal(mentions('Я не помню никакого слова.', 'самовар'), false);
  assert.equal(mentions('', 'маяк'), false);
});

test('thinking that cannot be switched off: FAIL with the kind of problem named, no reasoning text printed', async () => {
  const { report, out } = await run({ emulateQwenThinking: true, ignoreEffort: true, ignorePrefill: true }, { reasoningBudgetTokens: 0 });
  assert.equal(report.ok, false);
  assert.deepEqual(report.exchanges.map((e) => e.outcome), ['reasoning_only', 'reasoning_only', 'reasoning_only']);
  assert.match(report.conclusion, /Problem kind\(s\): reasoning_only/);
  assert.match(out, /outcome : reasoning_only — LLM returned reasoning but no answer/);
  assert.equal(/шаг шаг|Thinking Process/.test(out + JSON.stringify(report)), false);
});

test('server not running: request failure is reported, nothing else is attempted', async () => {
  const config = normalizeConfig({ llm: { endpoint: 'http://127.0.0.1:9/v1' } }, DEFAULTS);
  const said = [];
  const report = await runLlmSmoke({ config, say: (t) => said.push(t) });
  assert.equal(report.ok, false);
  assert.equal(report.exchanges.length, 0);
  assert.match(report.conclusion, /^request_failed/);
});

test('HTTP failure from the server is told apart from an empty answer', async () => {
  const fake = createFakeLmStudio({ reply: () => ({ status: 500, errorBody: { error: { message: 'model crashed' } } }) });
  const endpoint = await fake.start();
  const said = [];
  try {
    const report = await runLlmSmoke({ config: normalizeConfig({ llm: { endpoint } }, DEFAULTS), say: (t) => said.push(t), thinkProbe: false });
    assert.deepEqual(report.exchanges.map((e) => e.outcome), ['api_failure', 'api_failure', 'api_failure']);
    assert.match(said.join('\n'), /response: HTTP 500/);
    assert.match(report.conclusion, /api_failure/);
  } finally { await fake.stop(); }
});
