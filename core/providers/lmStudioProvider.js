'use strict';
const { nowMs } = require('../util/clock');
const { SseParser } = require('../util/sse');
const { ThinkFilter } = require('../conversation/thinkFilter');

class LlmError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code; // unreachable | http | timeout | aborted | bad_response | no_model
    // extra.outcome: request_failed | api_failure | aborted;  extra.diag: request/response facts
    Object.assign(this, extra);
  }
}

function describeNetworkError(err) {
  const cause = err && err.cause;
  const code = (cause && cause.code) || err.code || '';
  return [err.message, code].filter(Boolean).join(' ');
}

/** Choose which model id to send. Pure function (unit tested). */
function selectModel({ configured, models, preferredPattern }) {
  const usable = models.filter((m) => m.type !== 'embeddings' && !/embed/i.test(m.id));
  if (configured) {
    const found = usable.find((m) => m.id === configured);
    return { id: configured, reason: found ? 'configured' : 'configured (not in server model list)' };
  }
  let re = null;
  if (preferredPattern) {
    try { re = new RegExp(preferredPattern, 'i'); } catch { re = null; }
  }
  const loaded = usable.filter((m) => m.loaded === true);
  if (re) {
    const a = loaded.find((m) => re.test(m.id));
    if (a) return { id: a.id, reason: 'loaded model matching preferred pattern' };
  }
  if (loaded.length) return { id: loaded[0].id, reason: 'first loaded model' };
  if (re) {
    const b = usable.find((m) => re.test(m.id));
    if (b) return { id: b.id, reason: 'available model matching preferred pattern (not reported as loaded)' };
  }
  if (usable.length) return { id: usable[0].id, reason: 'first available model' };
  return { id: '', reason: 'no models reported by server' };
}

const EMPTY_THINK_PREFILL = '<think>\n\n</think>\n\n';
const MAX_ATTEMPTS = 4;
const DEFAULT_REASONING_BUDGET_TOKENS = 2048;

function reasoningBudget(cfg) {
  return Number.isFinite(cfg.reasoningBudgetTokens) ? Math.max(0, cfg.reasoningBudgetTokens) : DEFAULT_REASONING_BUDGET_TOKENS;
}

/** What was sent, for diagnostics: everything except the message texts. */
function describeRequest(body) {
  const { messages, ...rest } = body;
  const last = messages[messages.length - 1];
  return {
    ...rest,
    messages: messages.map((m) => ({ role: m.role, chars: String(m.content ?? '').length })),
    assistantPrefill: Boolean(last && last.role === 'assistant'),
  };
}

/** Key structure of an unrecognized payload (never its text values). */
function shapeOf(value, depth = 0) {
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0], depth + 1)] : [];
  if (value && typeof value === 'object') {
    if (depth >= 3) return '{…}';
    return Object.fromEntries(Object.keys(value).slice(0, 12).map((k) => [k, shapeOf(value[k], depth + 1)]));
  }
  return typeof value;
}

/** Next plan after an HTTP 400, or null when nothing is left to drop. Pure (unit tested). */
function planAfterRejection(plan, detail) {
  let param = '';
  try { param = String((JSON.parse(detail).error || {}).param || ''); } catch { /* not JSON */ }
  const namesEffort = /reasoning_effort/i.test(param) || (!param && /reasoning_effort/i.test(detail));
  if (plan.strategy === 'effort' && namesEffort) return { strategy: 'plain', minimal: plan.minimal };
  if (!plan.minimal) return { strategy: plan.strategy === 'effort' ? 'plain' : plan.strategy, minimal: true };
  if (plan.strategy === 'effort') return { strategy: 'plain', minimal: true };
  return null;
}

/**
 * What kind of response was this? Pure (unit tested).
 *   ok             speakable answer text
 *   reasoning_only the model produced reasoning and no answer
 *   empty          a well-formed completion without any text
 *   parser_failure HTTP 200, but nothing in it was a chat-completion chunk
 */
function classify({ sse, finalText, reasoningChars, reasoningChunks, finishReason, reasoningTokens, contentType, maxTokens }) {
  if (finalText) return { outcome: 'ok', message: '' };
  if (reasoningChars > 0 || reasoningChunks > 0) {
    const used = Number.isFinite(reasoningTokens) ? `${reasoningTokens} reasoning tokens` : `${reasoningChunks} reasoning chunks`;
    const why = finishReason === 'length'
      ? `reasoning used the whole token budget (max_tokens ${maxTokens}, finish_reason "length")`
      : `the completion ended (finish_reason "${finishReason}") after the reasoning`;
    return { outcome: 'reasoning_only', message: `LLM returned reasoning but no answer: ${used}, ${why}. Thinking could not be switched off for this model through the API.` };
  }
  if (sse.withChoice === 0) {
    const what = sse.events === 0
      ? `no "data:" events in the response (content-type ${contentType || 'unknown'}, ${sse.bytes ?? 0} bytes)`
      : `${sse.events} event(s), none of them a chat-completion chunk (${sse.unparsed} not JSON${sse.unknownShapes.length ? `; shape ${JSON.stringify(sse.unknownShapes[0])}` : ''})`;
    return { outcome: 'parser_failure', message: `LLM response was not understood: ${what}.` };
  }
  const keys = Object.keys(sse.deltaKeys).filter((k) => k !== 'role');
  return { outcome: 'empty', message: `LLM returned an empty answer: ${sse.withChoice} chunk(s), finish_reason "${finishReason}", ${keys.length ? `delta fields ${keys.join(', ')}` : 'no text fields'}.` };
}

/**
 * LLMProvider for LM Studio's local OpenAI-compatible server.
 * No API key is required or sent.
 */
class LMStudioProvider {
  constructor({ getConfig, fetchImpl, clock = nowMs }) {
    this.getConfig = getConfig; // () => config.llm
    this.fetch = fetchImpl || globalThis.fetch;
    this.clock = clock;
    this.name = 'lmstudio';
    this._memo = new Map(); // "<endpoint>|<model>" -> thinking-control plan that worked
  }

  _endpoint() { return this.getConfig().endpoint.replace(/\/+$/, ''); }

  async _getJson(url, timeoutMs = 4000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new LlmError('http', `HTTP ${res.status} from ${url}`, { status: res.status });
      return await res.json();
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (ctrl.signal.aborted) throw new LlmError('timeout', `No response from ${url} within ${timeoutMs} ms`);
      throw new LlmError('unreachable', `Cannot reach ${url}: ${describeNetworkError(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Model list; uses LM Studio's native endpoint for loaded-state when present. */
  async listModels() {
    const endpoint = this._endpoint();
    const data = await this._getJson(`${endpoint}/models`);
    const models = (data.data || []).map((m) => ({ id: m.id, loaded: null, type: null }));
    try {
      const root = endpoint.replace(/\/v1$/, '');
      const native = await this._getJson(`${root}/api/v0/models`, 2500);
      const byId = new Map((native.data || []).map((m) => [m.id, m]));
      for (const m of models) {
        const n = byId.get(m.id);
        if (n) {
          m.loaded = n.state === 'loaded';
          m.type = n.type || null;
          if (n.quantization) m.quantization = n.quantization;
          if (n.loaded_context_length) m.contextLength = n.loaded_context_length;
        }
      }
    } catch {
      // native endpoint is optional; loaded-state stays unknown
    }
    return models;
  }

  async checkConnectivity() {
    const cfg = this.getConfig();
    const endpoint = this._endpoint();
    try {
      const models = await this.listModels();
      const sel = selectModel({ configured: cfg.model, models, preferredPattern: cfg.preferredModelPattern });
      if (!sel.id) {
        return { ok: false, endpoint, models, selectedModel: '', selectedReason: sel.reason, error: 'LM Studio is reachable but reports no models. Load a model in LM Studio.' };
      }
      return { ok: true, endpoint, models, selectedModel: sel.id, selectedReason: sel.reason, error: null };
    } catch (err) {
      return { ok: false, endpoint, models: [], selectedModel: cfg.model || '', selectedReason: '', error: err.message };
    }
  }

  /**
   * How thinking is handled for a request.
   *   effort  : reasoning_effort "none" (+ chat_template_kwargs). Observed on the
   *             target PC (LM Studio, qwen/qwen3.5-9b): the only request FIELD
   *             that switches thinking off; chat_template_kwargs alone is ignored.
   *   plain   : no reasoning_effort (for servers that reject the field).
   *   prefill : an empty think block as the start of the assistant turn; observed
   *             to work on the same server, needs no special field.
   *   budget  : thinking cannot be switched off (or is wanted): reasoning is let
   *             through, never spoken, and max_tokens is raised so the answer
   *             still fits behind it.
   */
  buildRequestBody({ model, messages, params = {} }, { minimal = false, strategy } = {}) {
    const cfg = { ...this.getConfig(), ...params };
    const plan = strategy || (cfg.disableThinking ? 'effort' : 'budget');
    const body = {
      model,
      messages: plan === 'prefill' ? [...messages, { role: 'assistant', content: EMPTY_THINK_PREFILL }] : messages,
      stream: true,
      temperature: cfg.temperature,
      top_p: cfg.topP,
      max_tokens: plan === 'budget' ? cfg.maxTokens + reasoningBudget(cfg) : cfg.maxTokens,
    };
    if (cfg.presencePenalty) body.presence_penalty = cfg.presencePenalty;
    if (plan === 'effort') body.reasoning_effort = 'none';
    if (!minimal) {
      if (cfg.topK > 0) body.top_k = cfg.topK;
      body.stream_options = { include_usage: true };
      if (cfg.disableThinking) body.chat_template_kwargs = { enable_thinking: false };
    }
    return body;
  }

  _memoKey(model) { return `${this._endpoint()}|${model}`; }

  /** Thinking-control plan that last produced an answer for this server + model. */
  thinkingControl(model) { return this._memo.get(this._memoKey(model)) || null; }

  /**
   * Streamed chat completion.
   * onContent(text)   speakable content delta (reasoning removed)
   * onReasoning(text) reasoning delta (never spoken)
   *
   * Always returns a result with `outcome` (ok | reasoning_only | empty |
   * parser_failure) and `diag` (what was sent and what came back, without any
   * reasoning text), or throws LlmError with `outcome` (request_failed |
   * api_failure | aborted) and the same `diag`.
   */
  async streamChat({ model, messages, params, signal, onContent, onReasoning }) {
    if (!model) throw new LlmError('no_model', 'No LLM model selected', { outcome: 'request_failed' });
    const cfg = { ...this.getConfig(), ...(params || {}) };
    const url = `${this._endpoint()}/chat/completions`;
    const notes = [];
    const diag = { url, model, attempts: [], request: null, httpStatus: null, contentType: null, sse: null, finishReason: null, usage: null, contentChars: 0, reasoningChars: 0, thinkingControl: null, outcome: null };

    let abortReason = null;
    let ctrl = new AbortController();
    const abortWith = (reason) => { if (!abortReason) abortReason = reason; ctrl.abort(); };
    const onExternalAbort = () => abortWith('aborted');
    if (signal) {
      if (signal.aborted) abortWith('aborted');
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    let timer = null;
    const arm = (ms, reason) => {
      clearTimeout(timer);
      if (ms > 0) timer = setTimeout(() => abortWith(reason), ms);
    };

    const timings = { tRequest: null, tHeaders: null, tFirstToken: null, tFirstContent: null, tDone: null };
    let text = '';
    let reasoningText = '';
    let finishReason = null;
    let usage = null;
    let contentChunks = 0;
    let reasoningChunks = 0;
    let filter = null;
    let sse = null;

    const emitContent = (piece, t) => {
      if (!piece) return;
      if (timings.tFirstContent === null && piece.trim() !== '') timings.tFirstContent = t ?? this.clock();
      text += piece;
      if (onContent) onContent(piece);
    };
    const emitReasoning = (piece) => {
      if (!piece) return;
      reasoningText += piece;
      if (onReasoning) onReasoning(piece);
    };

    // Where to start: what worked last time for this server + model.
    const memo = cfg.disableThinking ? this._memo.get(this._memoKey(model)) : null;
    let plan = cfg.disableThinking ? { strategy: 'effort', minimal: false, ...(memo || {}) } : { strategy: 'budget', minimal: false };
    if (memo && memo.strategy !== 'effort') notes.push(`Thinking control "${memo.strategy}" reused (it worked for this model before).`);

    const fail = (code, message, extra = {}) => {
      diag.outcome = extra.outcome;
      return new LlmError(code, message, { ...extra, diag });
    };

    try {
      for (let attemptNo = 1; ; attemptNo++) {
        const attempt = { strategy: plan.strategy, minimal: plan.minimal, status: null, result: null, ms: null };
        diag.attempts.push(attempt);
        const tAttempt = this.clock();
        if (timings.tRequest === null) timings.tRequest = tAttempt; // latency includes abandoned attempts
        const body = this.buildRequestBody({ model, messages, params }, plan);
        diag.request = describeRequest(body);
        diag.thinkingControl = plan.strategy;
        text = ''; reasoningText = ''; finishReason = null; usage = null; contentChunks = 0; reasoningChunks = 0;
        timings.tFirstToken = null; timings.tFirstContent = null;
        filter = new ThinkFilter();
        sse = { events: 0, unparsed: 0, withChoice: 0, done: false, deltaKeys: {}, unknownShapes: [] };
        diag.sse = sse;

        arm(cfg.firstByteTimeoutMs, 'timeout');
        const res = await this.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        timings.tHeaders = this.clock();
        attempt.status = res.status;
        diag.httpStatus = res.status;
        diag.contentType = res.headers && res.headers.get ? res.headers.get('content-type') : null;

        if (res.status === 400 && attemptNo < MAX_ATTEMPTS) {
          const detail = await res.text().catch(() => '');
          const next = planAfterRejection(plan, detail);
          if (next) {
            attempt.result = 'rejected_400';
            attempt.ms = Math.round(this.clock() - tAttempt);
            notes.push(next.minimal && !plan.minimal
              ? `Server rejected extended request fields (HTTP 400: ${detail.slice(0, 200)}); retried with minimal body.`
              : `Server rejected reasoning_effort (HTTP 400: ${detail.slice(0, 200)}); retried without it.`);
            plan = next;
            continue;
          }
          throw fail('http', `LLM server returned HTTP 400: ${detail.slice(0, 300)}`, { status: 400, outcome: 'api_failure' });
        }
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          attempt.result = 'http_error';
          throw fail('http', `LLM server returned HTTP ${res.status}: ${detail.slice(0, 300)}`, { status: res.status, outcome: 'api_failure' });
        }
        if (!res.body) throw fail('bad_response', 'LLM server returned no response body', { outcome: 'api_failure' });

        const canSwitch = plan.strategy !== 'budget' && attemptNo < MAX_ATTEMPTS;
        let switchPlan = false;

        const handleChoice = (choice, delta, tNow) => {
          sse.withChoice += 1;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          for (const k of Object.keys(delta)) sse.deltaKeys[k] = (sse.deltaKeys[k] || 0) + 1;
          const r = delta.reasoning_content ?? delta.reasoning;
          let reasoningPiece = typeof r === 'string' ? r : '';
          let contentPiece = '';
          if (typeof delta.content === 'string' && delta.content.length) {
            const parts = filter.push(delta.content);
            reasoningPiece += parts.reasoning;
            contentPiece = parts.content;
            contentChunks += 1;
          }
          if (typeof r === 'string' && r.length) reasoningChunks += 1;
          if (reasoningPiece && canSwitch && text === '') {
            // Thinking is on although this request asked for it to be off:
            // stop reading and try the next way of switching it off.
            switchPlan = true;
            return;
          }
          if ((reasoningPiece || contentPiece) && timings.tFirstToken === null) timings.tFirstToken = tNow;
          emitReasoning(reasoningPiece);
          emitContent(contentPiece, tNow);
        };

        const handlePayload = (payload) => {
          sse.events += 1;
          if (payload === '[DONE]') { sse.done = true; return; }
          let obj;
          try { obj = JSON.parse(payload); } catch { sse.unparsed += 1; return; }
          if (obj && obj.error) {
            const msg = typeof obj.error === 'string' ? obj.error : (obj.error.message || JSON.stringify(obj.error));
            throw fail('bad_response', `LLM server error: ${msg}`, { outcome: 'api_failure' });
          }
          if (obj && obj.usage) usage = obj.usage;
          const choice = obj && Array.isArray(obj.choices) ? obj.choices[0] : null;
          if (!choice) {
            if (!(obj && (obj.usage || Array.isArray(obj.choices))) && sse.unknownShapes.length < 3) sse.unknownShapes.push(shapeOf(obj));
            return;
          }
          // `message` instead of `delta`: a server that answered without streaming
          handleChoice(choice, choice.delta || choice.message || {}, this.clock());
        };

        if (/application\/json/i.test(diag.contentType || '')) {
          // Not an event stream: the whole completion in one JSON document.
          const raw = await res.text();
          notes.push('Server answered without streaming (one JSON document).');
          handlePayload(raw);
          sse.done = true;
        } else {
          const parser = new SseParser();
          const decoder = new TextDecoder('utf-8');
          let sawBytes = 0;
          for await (const chunk of res.body) {
            arm(cfg.idleTimeoutMs, 'timeout');
            sawBytes += chunk.length;
            for (const p of parser.feed(decoder.decode(chunk, { stream: true }))) {
              handlePayload(p);
              if (switchPlan || sse.done) break;
            }
            if (switchPlan || sse.done) break;
          }
          if (!sse.done && !switchPlan) for (const p of parser.end()) handlePayload(p);
          sse.bytes = sawBytes;
        }

        if (switchPlan) {
          // abandon this response; the server stops generating when the connection closes
          clearTimeout(timer);
          const old = ctrl;
          ctrl = new AbortController();
          old.abort();
          if (abortReason) throw new Error('aborted');
          attempt.result = 'reasoning_detected';
          attempt.ms = Math.round(this.clock() - tAttempt);
          const next = { strategy: plan.strategy === 'prefill' ? 'budget' : 'prefill', minimal: plan.minimal };
          notes.push(`Thinking was not switched off by "${plan.strategy}" (the model started reasoning); retried with "${next.strategy}".`);
          this._memo.delete(this._memoKey(model));
          plan = next;
          continue;
        }

        const tail = filter.flush();
        emitReasoning(tail.reasoning);
        emitContent(tail.content);
        timings.tDone = this.clock();
        attempt.result = 'completed';
        attempt.ms = Math.round(timings.tDone - tAttempt);
        break;
      }
    } catch (err) {
      const last = diag.attempts[diag.attempts.length - 1];
      if (last && !last.result) last.result = 'failed';
      if (err instanceof LlmError) throw err;
      if (abortReason === 'aborted') throw fail('aborted', 'LLM request aborted', { outcome: 'aborted' });
      if (abortReason === 'timeout') throw fail('timeout', 'LLM request timed out (no data from server)', { outcome: 'request_failed' });
      throw fail('unreachable', `LLM request failed: ${describeNetworkError(err)}`, { outcome: 'request_failed' });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }

    if (filter.sawOrphanClose) {
      notes.push('Stream contained </think> without <think>: early output was reasoning and may have been spoken.');
    }
    const hasUsage = usage && Number.isFinite(usage.completion_tokens);
    const reasoningTokens = usage && usage.completion_tokens_details
      && Number.isFinite(usage.completion_tokens_details.reasoning_tokens)
      ? usage.completion_tokens_details.reasoning_tokens : null;

    const finalText = text.trim();
    diag.finishReason = finishReason;
    diag.usage = usage ? { prompt_tokens: usage.prompt_tokens ?? null, completion_tokens: usage.completion_tokens ?? null, reasoning_tokens: reasoningTokens } : null;
    diag.contentChars = finalText.length;
    diag.reasoningChars = reasoningText.length;
    const verdict = classify({ sse, finalText, reasoningChars: reasoningText.length, reasoningChunks, finishReason, reasoningTokens, contentType: diag.contentType, maxTokens: diag.request.max_tokens });
    diag.outcome = verdict.outcome;
    if (verdict.outcome === 'ok' && cfg.disableThinking) this._memo.set(this._memoKey(model), { strategy: plan.strategy, minimal: plan.minimal });
    if (plan.strategy === 'budget' && cfg.disableThinking && reasoningText.length) {
      notes.push('Thinking could not be switched off through the API; the answer was taken from behind the reasoning (slow).');
    }

    return {
      model,
      text: finalText,
      reasoningText,
      finishReason,
      usage: {
        promptTokens: usage && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
        completionTokens: hasUsage ? usage.completion_tokens : contentChunks + reasoningChunks,
        reasoningTokens,
        approximate: !hasUsage,
      },
      streamedChunks: { content: contentChunks, reasoning: reasoningChunks },
      timings,
      notes,
      outcome: verdict.outcome,
      diagnosis: verdict.message,
      diag,
    };
  }
}

module.exports = { LMStudioProvider, LlmError, selectModel, classify, planAfterRejection, describeRequest, EMPTY_THINK_PREFILL };
