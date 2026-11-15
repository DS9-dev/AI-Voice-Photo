'use strict';
/**
 * FAKE LM Studio server (OpenAI-compatible subset) for automated tests.
 * Never used for live acceptance.
 */
const http = require('node:http');

function createFakeLmStudio(options = {}) {
  const state = {
    models: options.models || [
      { id: 'text-embedding-nomic', type: 'embeddings', state: 'not-loaded' },
      { id: 'qwen/qwen3.5-9b', type: 'vlm', state: 'loaded', quantization: 'Q4_K_M', loaded_context_length: 8192 },
      { id: 'other/model-7b', type: 'llm', state: 'not-loaded' },
    ],
    native: options.native !== false,
    requests: [],
    // reply(body) -> {content, reasoning, inlineThink, usage, status, errorBody, chunkDelayMs, hang, finishReason}
    reply: options.reply || ((body) => ({ content: `Ответ на: ${body.messages.filter((m) => m.role === 'user').pop().content}.` })),
    rejectExtras: Boolean(options.rejectExtras),
    // Behaviour OBSERVED on the target PC (LM Studio, qwen/qwen3.5-9b, 2026-10-05):
    // the model thinks unless the request carries reasoning_effort "none" or the
    // assistant turn is pre-filled with an empty think block; chat_template_kwargs,
    // top-level enable_thinking and "/no_think" are ignored; reasoning counts
    // against max_tokens (finish_reason "length", no content when it runs out).
    emulateQwenThinking: Boolean(options.emulateQwenThinking),
    thinkingTokens: options.thinkingTokens ?? 400,
    rejectReasoningEffort: Boolean(options.rejectReasoningEffort),   // an older server that does not know the field
    ignorePrefill: Boolean(options.ignorePrefill),                   // a server where the prefill does not help
    ignoreEffort: Boolean(options.ignoreEffort),                     // a server that accepts but ignores reasoning_effort
  };
  const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'GET' && req.url === '/v1/models') {
      return send(200, { object: 'list', data: state.models.map((m) => ({ id: m.id, object: 'model' })) });
    }
    if (req.method === 'GET' && req.url === '/api/v0/models') {
      if (!state.native) return send(404, { error: 'not found' });
      return send(200, { object: 'list', data: state.models });
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', async () => {
        const body = JSON.parse(raw);
        state.requests.push(body);
        if (state.rejectExtras && (body.chat_template_kwargs || body.stream_options || body.top_k !== undefined)) {
          return send(400, { error: { message: 'Unrecognized key(s) in object' } });
        }
        if (body.reasoning_effort !== undefined && (state.rejectReasoningEffort || !EFFORTS.includes(body.reasoning_effort))) {
          return send(400, { error: { message: `Invalid 'reasoning_effort' value: '${body.reasoning_effort}'. Supported values: ${EFFORTS.join(', ')}.`, type: 'invalid_request_error', param: 'reasoning_effort', code: 'invalid_value' } });
        }
        const r = state.reply(body) || {};
        if (r.status && r.status !== 200) return send(r.status, r.errorBody || { error: { message: 'fake failure' } });
        if (r.rawBody !== undefined) { // something that is not a chat completion at all
          res.writeHead(200, { 'Content-Type': r.rawType || 'text/event-stream' });
          return res.end(r.rawBody);
        }
        let budget = Infinity;
        let thinking = false;
        if (state.emulateQwenThinking) {
          const last = body.messages[body.messages.length - 1];
          const prefilled = !state.ignorePrefill && last.role === 'assistant' && /<think>\s*<\/think>/.test(last.content);
          const off = (!state.ignoreEffort && body.reasoning_effort === 'none') || prefilled;
          thinking = !off;
          if (thinking) r.reasoning = 'Thinking Process: ' + 'шаг '.repeat(state.thinkingTokens - 2);
          else delete r.reasoning;
          budget = Number.isFinite(body.max_tokens) ? body.max_tokens : Infinity;
        }
        if (r.nonStreaming) { // the whole completion as one JSON document
          return send(200, { id: 'chatcmpl-fake', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: r.content ?? '', reasoning_content: r.reasoning || '', tool_calls: [] }, finish_reason: r.finishReason || 'stop' }], usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 } });
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const chunkDelay = r.chunkDelayMs ?? 2;
        const pieces = (text) => text.match(/\S+\s*|\s+/g) || [];
        let closed = false;
        res.on('close', () => { closed = true; });
        if (r.hang) return; // headers sent, never any data
        write({ choices: [{ index: 0, delta: { role: 'assistant' } }] });
        let spent = 0;
        let reasoningTokens = 0;
        let cut = false;
        for (const p of pieces(r.reasoning || '')) {
          if (closed) { state.abandoned = (state.abandoned || 0) + 1; return; }
          if (spent >= budget) { cut = true; break; }
          write({ choices: [{ index: 0, delta: { reasoning_content: p } }] });
          spent += 1; reasoningTokens += 1;
          await delay(chunkDelay);
        }
        const content = (r.inlineThink ? `<think>${r.inlineThink}</think>\n\n` : '') + (thinking && r.content ? '\n\n' : '') + (r.content ?? '');
        let n = 0;
        for (const p of cut ? [] : pieces(content)) {
          if (closed) return;
          if (spent >= budget) { cut = true; break; }
          write({ choices: [{ index: 0, delta: { content: p } }] });
          n += 1; spent += 1;
          await delay(chunkDelay);
        }
        if (r.streamError) { write({ error: { message: r.streamError } }); return res.end(); }
        write({ choices: [{ index: 0, delta: r.finalDelta || {}, finish_reason: cut ? 'length' : (r.finishReason || 'stop') }] });
        if (r.usage !== false && body.stream_options && body.stream_options.include_usage) {
          const u = r.usage || { prompt_tokens: 42, completion_tokens: n + 3, total_tokens: 45 + n };
          write({ choices: [], usage: state.emulateQwenThinking ? { prompt_tokens: 99, completion_tokens: spent, total_tokens: 99 + spent, completion_tokens_details: { reasoning_tokens: reasoningTokens } } : u });
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return undefined;
    }
    return send(404, { error: 'not found' });
  });

  return {
    state,
    server,
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      this.endpoint = `http://127.0.0.1:${server.address().port}/v1`;
      return this.endpoint;
    },
    async stop() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createFakeLmStudio };
