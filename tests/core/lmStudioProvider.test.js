'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LMStudioProvider, LlmError, selectModel, classify, planAfterRejection, EMPTY_THINK_PREFILL } = require('../../core/providers/lmStudioProvider');
const { createFakeLmStudio } = require('../fixtures/fake_lmstudio');

const BASE = { model: '', preferredModelPattern: 'qwen3\\.5.*9b', temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 0, maxTokens: 300, disableThinking: true, firstByteTimeoutMs: 2000, idleTimeoutMs: 2000 };

async function setup(options = {}, cfgPatch = {}) {
  const fake = createFakeLmStudio(options);
  const endpoint = await fake.start();
  const cfg = { ...BASE, endpoint, ...cfgPatch };
  const provider = new LMStudioProvider({ getConfig: () => cfg });
  return { fake, provider, cfg };
}

const MSGS = [{ role: 'system', content: 'S' }, { role: 'user', content: 'Привет' }];

test('selectModel prefers the configured model, then a loaded Qwen 3.5 9B', () => {
  const models = [
    { id: 'embed-x', type: 'embeddings', loaded: true },
    { id: 'other/model', type: 'llm', loaded: true },
    { id: 'qwen/qwen3.5-9b', type: 'vlm', loaded: true },
  ];
  assert.equal(selectModel({ configured: 'other/model', models, preferredPattern: 'qwen3\\.5.*9b' }).id, 'other/model');
  assert.equal(selectModel({ configured: '', models, preferredPattern: 'qwen3\\.5.*9b' }).id, 'qwen/qwen3.5-9b');
  assert.equal(selectModel({ configured: '', models: models.slice(0, 2), preferredPattern: 'qwen3\\.5.*9b' }).id, 'other/model');
  assert.equal(selectModel({ configured: '', models: [models[0]], preferredPattern: '' }).id, '');
  assert.match(selectModel({ configured: 'gone', models, preferredPattern: '' }).reason, /not in server model list/);
  assert.equal(selectModel({ configured: '', models, preferredPattern: '(' }).id, 'other/model'); // bad regex tolerated
});

test('connectivity check discovers the loaded Qwen model through LM Studio', async () => {
  const { fake, provider } = await setup();
  try {
    const r = await provider.checkConnectivity();
    assert.equal(r.ok, true);
    assert.equal(r.selectedModel, 'qwen/qwen3.5-9b');
    assert.equal(r.models.find((m) => m.id === 'qwen/qwen3.5-9b').loaded, true);
    assert.equal(r.error, null);
  } finally { await fake.stop(); }
});

test('connectivity works without the native /api/v0 endpoint', async () => {
  const { fake, provider } = await setup({ native: false });
  try {
    const r = await provider.checkConnectivity();
    assert.equal(r.ok, true);
    assert.equal(r.selectedModel, 'qwen/qwen3.5-9b');
    assert.equal(r.models[1].loaded, null);
  } finally { await fake.stop(); }
});

test('unreachable server is reported as an error state, not thrown', async () => {
  const provider = new LMStudioProvider({ getConfig: () => ({ ...BASE, endpoint: 'http://127.0.0.1:9/v1' }) });
  const r = await provider.checkConnectivity();
  assert.equal(r.ok, false);
  assert.match(r.error, /Cannot reach|No response/);
});

test('server with no models is not ready', async () => {
  const { fake, provider } = await setup({ models: [] });
  try {
    const r = await provider.checkConnectivity();
    assert.equal(r.ok, false);
    assert.match(r.error, /no models/i);
  } finally { await fake.stop(); }
});

test('request body carries the configured generation settings and no API key', async () => {
  const { fake, provider } = await setup();
  try {
    await provider.streamChat({ model: 'qwen/qwen3.5-9b', messages: MSGS });
    const body = fake.state.requests[0];
    assert.equal(body.model, 'qwen/qwen3.5-9b');
    assert.deepEqual(body.messages, MSGS);
    assert.equal(body.stream, true);
    assert.equal(body.temperature, 0.7);
    assert.equal(body.top_p, 0.8);
    assert.equal(body.top_k, 20);
    assert.equal(body.max_tokens, 300);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.reasoning_effort, 'none', 'the field that switches thinking off on the target LM Studio');
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal('presence_penalty' in body, false);
  } finally { await fake.stop(); }
});

test('streams content, measures TTFT and uses server-reported token usage', async () => {
  const { fake, provider } = await setup({ reply: () => ({ content: 'Привет! Как твои дела сегодня?', usage: { prompt_tokens: 30, completion_tokens: 9 } }) });
  try {
    const pieces = [];
    const r = await provider.streamChat({ model: 'm', messages: MSGS, onContent: (p) => pieces.push(p) });
    assert.equal(r.text, 'Привет! Как твои дела сегодня?');
    assert.equal(pieces.join(''), 'Привет! Как твои дела сегодня?');
    assert.ok(pieces.length > 1, 'content arrives incrementally');
    assert.equal(r.usage.completionTokens, 9);
    assert.equal(r.usage.promptTokens, 30);
    assert.equal(r.usage.approximate, false);
    assert.equal(r.finishReason, 'stop');
    const t = r.timings;
    assert.ok(t.tRequest <= t.tHeaders && t.tHeaders <= t.tFirstToken && t.tFirstToken <= t.tDone);
    assert.equal(t.tFirstToken, t.tFirstContent);
  } finally { await fake.stop(); }
});

test('token count is marked approximate when the server sends no usage', async () => {
  const { fake, provider } = await setup({ reply: () => ({ content: 'раз два три', usage: false }) });
  try {
    const r = await provider.streamChat({ model: 'm', messages: MSGS });
    assert.equal(r.usage.approximate, true);
    assert.equal(r.usage.completionTokens, 3);
  } finally { await fake.stop(); }
});

test('reasoning_content is kept out of the answer and delays first content', async () => {
  const { fake, provider } = await setup({ reply: () => ({ reasoning: 'надо подумать о вопросе', content: 'Готово.', chunkDelayMs: 5 }) });
  try {
    const content = [];
    const reasoning = [];
    const r = await provider.streamChat({ model: 'm', messages: MSGS, onContent: (p) => content.push(p), onReasoning: (p) => reasoning.push(p) });
    assert.equal(r.text, 'Готово.');
    assert.equal(reasoning.join(''), 'надо подумать о вопросе');
    assert.equal(content.join('').includes('подумать'), false);
    assert.ok(r.timings.tFirstContent > r.timings.tFirstToken);
  } finally { await fake.stop(); }
});

test('inline <think> blocks are stripped from the answer', async () => {
  const { fake, provider } = await setup({ reply: () => ({ inlineThink: 'внутренние рассуждения', content: 'Привет!' }) });
  try {
    const r = await provider.streamChat({ model: 'm', messages: MSGS });
    assert.equal(r.text, 'Привет!');
    assert.equal(r.reasoningText, 'внутренние рассуждения');
  } finally { await fake.stop(); }
});

test('retries once with a minimal body when the server rejects optional fields', async () => {
  const { fake, provider } = await setup({ rejectExtras: true });
  try {
    const r = await provider.streamChat({ model: 'm', messages: MSGS });
    assert.equal(fake.state.requests.length, 2);
    assert.equal('chat_template_kwargs' in fake.state.requests[1], false);
    assert.equal('top_k' in fake.state.requests[1], false);
    assert.ok(r.text.length > 0);
    assert.match(r.notes[0], /retried with minimal body/);
    assert.equal(r.usage.approximate, true);
  } finally { await fake.stop(); }
});

test('HTTP errors, stream errors and missing model raise LlmError', async () => {
  const { fake, provider } = await setup({ reply: (body) => (body.messages[1].content === 'boom' ? { streamError: 'model crashed' } : { status: 500 }) });
  try {
    await assert.rejects(provider.streamChat({ model: 'm', messages: MSGS }), (e) => e instanceof LlmError && e.code === 'http' && e.status === 500);
    await assert.rejects(provider.streamChat({ model: 'm', messages: [MSGS[0], { role: 'user', content: 'boom' }] }), (e) => e.code === 'bad_response' && /model crashed/.test(e.message));
    await assert.rejects(provider.streamChat({ model: '', messages: MSGS }), (e) => e.code === 'no_model');
  } finally { await fake.stop(); }
});

test('a silent server times out instead of hanging forever', async () => {
  const { fake, provider } = await setup({ reply: () => ({ hang: true }) }, { firstByteTimeoutMs: 150, idleTimeoutMs: 150 });
  try {
    await assert.rejects(provider.streamChat({ model: 'm', messages: MSGS }), (e) => e.code === 'timeout');
  } finally { await fake.stop(); }
});

test('abort signal cancels generation', async () => {
  const { fake, provider } = await setup({ reply: () => ({ content: 'очень длинный ответ '.repeat(50), chunkDelayMs: 10 }) });
  try {
    const ctrl = new AbortController();
    let got = 0;
    const p = provider.streamChat({ model: 'm', messages: MSGS, signal: ctrl.signal, onContent: () => { got += 1; if (got === 3) ctrl.abort(); } });
    await assert.rejects(p, (e) => e.code === 'aborted');
    assert.ok(got < 50);
  } finally { await fake.stop(); }
});

test('connection refused during chat is an "unreachable" error', async () => {
  const provider = new LMStudioProvider({ getConfig: () => ({ ...BASE, endpoint: 'http://127.0.0.1:9/v1' }) });
  await assert.rejects(provider.streamChat({ model: 'm', messages: MSGS }), (e) => e.code === 'unreachable');
});

// ---------------------------------------------------------------------------
// Thinking control and response classification.
// The fake's `emulateQwenThinking` mode replays what LM Studio with
// qwen/qwen3.5-9b did on the target PC on 2026-10-05 (see the fixture).
// ---------------------------------------------------------------------------

test('target-PC replay: the request switches thinking off and gets a plain answer in one attempt', async () => {
  const { fake, provider } = await setup({ emulateQwenThinking: true });
  try {
    const reasoning = [];
    const r = await provider.streamChat({ model: 'qwen/qwen3.5-9b', messages: MSGS, onReasoning: (p) => reasoning.push(p) });
    assert.equal(fake.state.requests.length, 1);
    assert.equal(r.outcome, 'ok');
    assert.equal(r.text, 'Ответ на: Привет.');
    assert.equal(reasoning.length, 0);
    assert.equal(r.usage.reasoningTokens, 0);
    assert.equal(r.finishReason, 'stop');
    assert.equal(r.diag.thinkingControl, 'effort');
    assert.deepEqual(r.diag.attempts.map((a) => [a.strategy, a.status, a.result]), [['effort', 200, 'completed']]);
    assert.equal(r.diag.httpStatus, 200);
    assert.match(r.diag.contentType, /event-stream/);
    assert.ok(r.diag.sse.events > 3 && r.diag.sse.done === true);
    assert.ok(r.diag.sse.deltaKeys.content > 0 && !r.diag.sse.deltaKeys.reasoning_content);
    assert.equal(r.diag.request.reasoning_effort, 'none');
    assert.equal(r.diag.request.max_tokens, 300);
    assert.deepEqual(r.diag.request.messages, [{ role: 'system', chars: 1 }, { role: 'user', chars: 6 }], 'message texts are not copied into diagnostics');
  } finally { await fake.stop(); }
});

test('target-PC failure replay: thinking that cannot be switched off and eats the budget is "reasoning_only", with no reasoning text in the diagnostics', async () => {
  // what the previous build ran into: nothing it sent switched thinking off, max_tokens 300
  const { fake, provider } = await setup({ emulateQwenThinking: true, ignoreEffort: true, ignorePrefill: true }, { reasoningBudgetTokens: 0 });
  try {
    const content = [];
    const r = await provider.streamChat({ model: 'qwen/qwen3.5-9b', messages: MSGS, onContent: (p) => content.push(p) });
    assert.equal(r.outcome, 'reasoning_only');
    assert.equal(r.text, '');
    assert.equal(content.length, 0, 'nothing reaches the speakable channel');
    assert.equal(r.finishReason, 'length');
    assert.equal(r.usage.reasoningTokens, 300);
    assert.match(r.diagnosis, /reasoning but no answer: 300 reasoning tokens.*max_tokens 300.*finish_reason "length"/);
    assert.deepEqual(r.diag.attempts.map((a) => `${a.strategy}:${a.result}`), ['effort:reasoning_detected', 'prefill:reasoning_detected', 'budget:completed']);
    assert.ok(r.diag.reasoningChars > 0);
    assert.equal(/шаг|Thinking Process/.test(JSON.stringify(r.diag) + r.diagnosis + r.notes.join(' ')), false, 'diagnostics carry counts, never reasoning text');
  } finally { await fake.stop(); }
});

test('when reasoning_effort is ignored, the request is abandoned at the first reasoning token and repeated with an empty think block', async () => {
  const { fake, provider } = await setup({ emulateQwenThinking: true, ignoreEffort: true, reply: () => ({ content: 'Привет!', chunkDelayMs: 3 }) });
  try {
    const reasoning = [];
    const r = await provider.streamChat({ model: 'qwen/qwen3.5-9b', messages: MSGS, onReasoning: (p) => reasoning.push(p) });
    assert.equal(r.outcome, 'ok');
    assert.equal(r.text, 'Привет!');
    assert.equal(reasoning.length, 0, 'the abandoned attempt is not reported as reasoning of the answer');
    assert.equal(fake.state.requests.length, 2);
    const second = fake.state.requests[1];
    assert.deepEqual(second.messages[second.messages.length - 1], { role: 'assistant', content: EMPTY_THINK_PREFILL });
    assert.equal('reasoning_effort' in second, false);
    assert.equal(fake.state.abandoned, 1, 'the server saw the first connection close before the reasoning was finished');
    assert.deepEqual(r.diag.attempts.map((a) => `${a.strategy}:${a.result}`), ['effort:reasoning_detected', 'prefill:completed']);
    assert.match(r.notes.join(' '), /Thinking was not switched off by "effort".*retried with "prefill"/);
    assert.ok(r.timings.tRequest <= r.timings.tHeaders - r.diag.attempts[0].ms + 5, 'latency is counted from the first attempt');

    // the working plan is remembered for this server + model
    const again = await provider.streamChat({ model: 'qwen/qwen3.5-9b', messages: MSGS });
    assert.equal(fake.state.requests.length, 3);
    assert.deepEqual(again.diag.attempts.map((a) => a.strategy), ['prefill']);
    assert.deepEqual(provider.thinkingControl('qwen/qwen3.5-9b'), { strategy: 'prefill', minimal: false });
    assert.equal(provider.thinkingControl('other-model'), null);
  } finally { await fake.stop(); }
});

test('a server that rejects reasoning_effort gets the same request without it', async () => {
  const { fake, provider } = await setup({ rejectReasoningEffort: true });
  try {
    const r = await provider.streamChat({ model: 'm', messages: MSGS });
    assert.equal(r.outcome, 'ok');
    assert.equal(fake.state.requests.length, 2);
    assert.equal('reasoning_effort' in fake.state.requests[1], false);
    assert.equal(fake.state.requests[1].top_k, 20, 'the other optional fields are kept');
    assert.deepEqual(fake.state.requests[1].messages, MSGS, 'no think-block prefill for a model that does not think');
    assert.deepEqual(r.diag.attempts.map((a) => `${a.strategy}:${a.status}:${a.result}`), ['effort:400:rejected_400', 'plain:200:completed']);
    assert.match(r.notes[0], /rejected reasoning_effort/);
  } finally { await fake.stop(); }
});

test('when thinking cannot be switched off at all, the answer is taken from behind the reasoning', async () => {
  const { fake, provider } = await setup({ emulateQwenThinking: true, ignoreEffort: true, ignorePrefill: true, thinkingTokens: 500, reply: () => ({ content: 'Готово.', chunkDelayMs: 0 }) });
  try {
    const content = [];
    let reasoningChars = 0;
    const r = await provider.streamChat({ model: 'm', messages: MSGS, onContent: (p) => content.push(p), onReasoning: (p) => { reasoningChars += p.length; } });
    assert.equal(r.outcome, 'ok');
    assert.equal(r.text, 'Готово.');
    assert.equal(content.join('').trim(), 'Готово.');
    assert.ok(reasoningChars > 0);
    assert.equal(r.usage.reasoningTokens, 500);
    assert.equal(fake.state.requests[2].max_tokens, 300 + 2048, 'room for the reasoning is added on top of the answer limit');
    assert.equal(r.diag.thinkingControl, 'budget');
    assert.match(r.notes.join(' '), /could not be switched off through the API/);
    assert.ok(r.timings.tFirstContent > r.timings.tFirstToken);
  } finally { await fake.stop(); }
});

test('thinking left on by configuration: no switch-off fields, reasoning budget added', async () => {
  const { fake, provider } = await setup({ emulateQwenThinking: true, thinkingTokens: 50 }, { disableThinking: false, reasoningBudgetTokens: 1000 });
  try {
    const r = await provider.streamChat({ model: 'm', messages: MSGS });
    assert.equal(r.outcome, 'ok');
    const body = fake.state.requests[0];
    assert.equal(fake.state.requests.length, 1);
    assert.equal('reasoning_effort' in body, false);
    assert.equal('chat_template_kwargs' in body, false);
    assert.equal(body.max_tokens, 1300);
    assert.equal(provider.thinkingControl('m'), null);
  } finally { await fake.stop(); }
});

test('HTTP 200 that is not a chat completion is a parser failure, not an empty answer', async () => {
  const cases = [
    { rawBody: '<html>proxy says hello</html>', rawType: 'text/html', expect: /no "data:" events.*text\/html/ },
    { rawBody: 'data: {"result":{"text":"привет"}}\n\ndata: [DONE]\n\n', expect: /none of them a chat-completion chunk.*"result":\{"text":"string"\}/ },
    { rawBody: 'data: not json at all\n\n', expect: /1 not JSON/ },
  ];
  for (const c of cases) {
    const { fake, provider } = await setup({ reply: () => c });
    try {
      const r = await provider.streamChat({ model: 'm', messages: MSGS });
      assert.equal(r.outcome, 'parser_failure', c.rawBody);
      assert.equal(r.text, '');
      assert.match(r.diagnosis, c.expect);
      assert.equal(/привет/.test(r.diagnosis + JSON.stringify(r.diag)), false, 'only the key structure of an unknown payload is recorded');
    } finally { await fake.stop(); }
  }
});

test('a well-formed completion without text is "empty", and other delta fields are named', async () => {
  const { fake, provider } = await setup({ reply: () => ({ content: '', finalDelta: { tool_calls: [{ index: 0, function: { name: 'x', arguments: '{}' } }] }, finishReason: 'tool_calls' }) });
  try {
    const r = await provider.streamChat({ model: 'm', messages: MSGS });
    assert.equal(r.outcome, 'empty');
    assert.match(r.diagnosis, /empty answer: \d+ chunk\(s\), finish_reason "tool_calls", delta fields tool_calls/);
  } finally { await fake.stop(); }
});

test('a server that answers with one JSON document instead of a stream is still understood', async () => {
  const { fake, provider } = await setup({ reply: () => ({ nonStreaming: true, content: 'Привет, я здесь.', reasoning: '' }) });
  try {
    const r = await provider.streamChat({ model: 'm', messages: MSGS });
    assert.equal(r.outcome, 'ok');
    assert.equal(r.text, 'Привет, я здесь.');
    assert.match(r.notes.join(' '), /without streaming/);
    assert.equal(r.usage.completionTokens, 7);
  } finally { await fake.stop(); }
});

test('failures are classified: request failure vs HTTP/API failure vs abort', async () => {
  const { fake, provider } = await setup({ reply: (body) => (body.messages[1].content === 'boom' ? { streamError: 'model crashed' } : { status: 503 }) });
  try {
    await assert.rejects(provider.streamChat({ model: 'm', messages: MSGS }), (e) => e.outcome === 'api_failure' && e.diag.httpStatus === 503 && e.diag.attempts[0].result === 'http_error');
    await assert.rejects(provider.streamChat({ model: 'm', messages: [MSGS[0], { role: 'user', content: 'boom' }] }), (e) => e.outcome === 'api_failure' && e.diag.httpStatus === 200);
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(provider.streamChat({ model: 'm', messages: MSGS, signal: ctrl.signal }), (e) => e.code === 'aborted' && e.outcome === 'aborted');
  } finally { await fake.stop(); }
  const down = new LMStudioProvider({ getConfig: () => ({ ...BASE, endpoint: 'http://127.0.0.1:9/v1' }) });
  await assert.rejects(down.streamChat({ model: 'm', messages: MSGS }), (e) => e.outcome === 'request_failed' && e.diag.httpStatus === null && e.diag.url === 'http://127.0.0.1:9/v1/chat/completions');
  const { fake: slow, provider: p2 } = await setup({ reply: () => ({ hang: true }) }, { firstByteTimeoutMs: 120, idleTimeoutMs: 120 });
  try {
    await assert.rejects(p2.streamChat({ model: 'm', messages: MSGS }), (e) => e.code === 'timeout' && e.outcome === 'request_failed');
  } finally { await slow.stop(); }
});

test('planAfterRejection: which fields are dropped after an HTTP 400', () => {
  const effortError = JSON.stringify({ error: { message: "Invalid 'reasoning_effort' value", param: 'reasoning_effort' } });
  assert.deepEqual(planAfterRejection({ strategy: 'effort', minimal: false }, effortError), { strategy: 'plain', minimal: false });
  assert.deepEqual(planAfterRejection({ strategy: 'effort', minimal: false }, 'Unrecognized key(s) in object'), { strategy: 'plain', minimal: true });
  assert.deepEqual(planAfterRejection({ strategy: 'effort', minimal: false }, JSON.stringify({ error: { message: 'bad top_k', param: 'top_k' } })), { strategy: 'plain', minimal: true });
  assert.deepEqual(planAfterRejection({ strategy: 'prefill', minimal: false }, 'whatever'), { strategy: 'prefill', minimal: true });
  assert.equal(planAfterRejection({ strategy: 'plain', minimal: true }, 'whatever'), null, 'nothing left to drop: the 400 is reported');
});

test('classify: the five kinds of result', () => {
  const sse = (over = {}) => ({ events: 5, unparsed: 0, withChoice: 4, done: true, deltaKeys: { role: 1, content: 3 }, unknownShapes: [], ...over });
  assert.equal(classify({ sse: sse(), finalText: 'Да.', reasoningChars: 0, reasoningChunks: 0, finishReason: 'stop' }).outcome, 'ok');
  assert.equal(classify({ sse: sse(), finalText: 'Да.', reasoningChars: 900, reasoningChunks: 200, finishReason: 'stop' }).outcome, 'ok', 'an answer after reasoning is an answer');
  assert.equal(classify({ sse: sse({ deltaKeys: { role: 1, reasoning_content: 299 } }), finalText: '', reasoningChars: 1059, reasoningChunks: 299, finishReason: 'length', reasoningTokens: 299, maxTokens: 300 }).outcome, 'reasoning_only');
  assert.equal(classify({ sse: sse({ deltaKeys: { role: 1 } }), finalText: '', reasoningChars: 0, reasoningChunks: 0, finishReason: 'stop' }).outcome, 'empty');
  assert.equal(classify({ sse: sse({ events: 0, withChoice: 0 }), finalText: '', reasoningChars: 0, reasoningChunks: 0, finishReason: null, contentType: 'text/html' }).outcome, 'parser_failure');
});
