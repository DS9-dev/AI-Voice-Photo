'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeOrchestrator, say, playAll, tick } = require('./helpers');

test('full voice turn: LISTENING -> THINKING -> SPEAKING -> LISTENING with metrics and history', async () => {
  const { o, stt, tts, llm, history, events, transitions } = makeOrchestrator();
  o.setMicMode('full');
  assert.equal(stt.listening, true);

  say(stt, 'Привет, как дела?');
  assert.equal(o.state, 'THINKING');
  assert.equal(stt.listening, false, 'microphone gate closed while thinking');
  assert.deepEqual(llm.last.req.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(llm.last.req.messages[1].content, 'Привет, как дела?');

  llm.last.token('У меня всё отлично, спасибо! ');
  llm.last.token('А у тебя как?');
  assert.equal(o.state, 'SPEAKING', 'speaking starts with the first complete sentence');
  assert.equal(stt.listening, false);
  llm.last.finish();
  await tick();
  assert.deepEqual(tts.spoken.map((c) => c.text), ['У меня всё отлично, спасибо!', 'А у тебя как?']);
  assert.deepEqual(tts.spoken.map((c) => c.seq), [0, 1]);
  assert.deepEqual(tts.ended, ['t1']);
  assert.equal(o.state, 'SPEAKING', 'still speaking until playback completes');

  playAll(tts, 't1');
  assert.equal(o.state, 'LISTENING');
  assert.equal(stt.listening, true, 'gate reopened after playback');
  assert.deepEqual(transitions, ['LISTENING>THINKING', 'THINKING>SPEAKING', 'SPEAKING>LISTENING']);

  assert.deepEqual(history.turns, [{ user: 'Привет, как дела?', assistant: 'У меня всё отлично, спасибо! А у тебя как?' }]);
  assert.deepEqual(events.messages.map((m) => m.role), ['user', 'assistant']);

  const turn = events.turns[0];
  assert.equal(turn.mode, 'full');
  assert.equal(turn.outcome, 'ok');
  assert.equal(turn.derived.speechDurationMs, 1500);
  assert.equal(turn.derived.vadEndDelayMs, 600);
  assert.equal(turn.derived.sttFinalizeMs, 150);
  assert.equal(turn.derived.llmTtftMs, 50);
  assert.equal(turn.derived.perceivedLatencyMs, 20020 - 11500);
  assert.equal(turn.counters.llmCompletionTokens, 10);
  assert.equal(turn.counters.ttsChunks, 2);
  assert.equal(turn.counters.ttsSynthMs, 160);
  assert.ok(turn.notes.some((n) => /approximate/.test(n)));
});

test('no second request is accepted while THINKING', async () => {
  const { o, stt, llm, events } = makeOrchestrator();
  o.setMicMode('full');
  say(stt, 'Первый вопрос');
  assert.equal(o.state, 'THINKING');

  const typed = o.submitText('Второй вопрос');
  assert.equal(typed.accepted, false);
  assert.match(typed.reason, /busy \(THINKING\)/);

  say(stt, 'Третий вопрос'); // e.g. a stray utterance that slipped through
  assert.equal(llm.calls.length, 1, 'only one LLM request');
  assert.equal(o.state, 'THINKING');
  assert.ok(events.rejected.length >= 2);
  assert.equal(events.messages.filter((m) => m.role === 'user').length, 1);
});

test('no second request is accepted while SPEAKING, and listening resumes afterwards', async () => {
  const { o, stt, tts, llm, events, history } = makeOrchestrator();
  o.setMicMode('full');
  say(stt, 'Расскажи что-нибудь');
  llm.last.token('Хорошо, слушай внимательно. ');
  llm.last.token('Это будет интересно.');
  llm.last.finish();
  await tick();
  assert.equal(o.state, 'SPEAKING');

  assert.equal(o.submitText('Перебиваю').accepted, false);
  say(stt, 'Хорошо, слушай внимательно'); // the companion's own voice picked up by the mic
  assert.equal(llm.calls.length, 1);
  assert.equal(o.state, 'SPEAKING');
  assert.equal(stt.listening, false);

  playAll(tts, 't1');
  assert.equal(o.state, 'LISTENING');
  assert.equal(stt.listening, true);
  assert.equal(history.length, 1);
  assert.equal(events.messages.filter((m) => m.role === 'user').length, 1);
  assert.equal(o.snapshot().rejectedInputs >= 2, true);
});

test('with sentence streaming off, TTS starts only after the full answer', async () => {
  const { o, tts, llm } = makeOrchestrator({ tts: { sentenceStreaming: false } });
  o.submitText('Привет');
  llm.last.token('Первое предложение готово. ');
  llm.last.token('Второе тоже.');
  assert.equal(o.state, 'THINKING');
  assert.equal(tts.spoken.length, 0);
  llm.last.finish();
  await tick();
  assert.equal(o.state, 'SPEAKING');
  assert.deepEqual(tts.spoken.map((c) => c.text), ['Первое предложение готово.', 'Второе тоже.']);
});

test('reasoning is never sent to TTS and is flagged in the metrics', async () => {
  const { o, tts, llm, events } = makeOrchestrator();
  o.submitText('Привет');
  llm.last.reason('пользователь здоровается, надо ответить');
  assert.equal(o.state, 'THINKING');
  llm.last.token('Привет, рада тебя слышать!');
  llm.last.finish({ timings: { tRequest: 100, tHeaders: 110, tFirstToken: 150, tFirstContent: 900, tDone: 1000 } });
  await tick();
  assert.deepEqual(tts.spoken.map((c) => c.text), ['Привет, рада тебя слышать!']);
  playAll(tts, 't1');
  const turn = events.turns[0];
  assert.equal(turn.derived.llmTtftMs, 50);
  assert.equal(turn.derived.llmFirstContentMs, 800);
  assert.ok(turn.counters.llmReasoningChars > 0);
  assert.ok(turn.notes.some((n) => /reasoning/i.test(n)));
});

test('session context: the second request contains the first turn', async () => {
  const { o, tts, llm } = makeOrchestrator();
  o.submitText('Меня интересует красный автомобиль.');
  llm.last.token('Красный автомобиль — отличный выбор!');
  llm.last.finish();
  await tick();
  playAll(tts, 't1');
  o.submitText('А какого он был цвета?');
  assert.deepEqual(llm.last.req.messages.map((m) => [m.role, m.content]).slice(1), [
    ['user', 'Меня интересует красный автомобиль.'],
    ['assistant', 'Красный автомобиль — отличный выбор!'],
    ['user', 'А какого он был цвета?'],
  ]);
});

test('Clear Session removes previous turns from the next LLM request', async () => {
  const { o, tts, llm, history } = makeOrchestrator();
  o.submitText('Меня интересует красный автомобиль.');
  llm.last.token('Красный автомобиль — отличный выбор!');
  llm.last.finish();
  await tick();
  playAll(tts, 't1');
  assert.equal(history.length, 1);

  let cleared = null;
  o.on('sessionCleared', (e) => { cleared = e; });
  o.clearSession();
  assert.equal(history.length, 0);
  assert.ok(cleared.sessionId > 1);
  assert.equal(o.lastRequest, null);

  o.submitText('А какого он был цвета?');
  assert.deepEqual(llm.last.req.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(JSON.stringify(llm.last.req.messages).includes('красный'), false);
});

test('clearing the session during a turn stops it and does not store it', async () => {
  const { o, tts, llm, history } = makeOrchestrator();
  o.submitText('Вопрос');
  llm.last.token('Начинаю длинный ответ на вопрос. ');
  llm.last.token('И продолжаю');
  assert.equal(o.state, 'SPEAKING');
  o.clearSession();
  assert.equal(o.state, 'LISTENING');
  assert.equal(llm.last.aborted, true);
  assert.equal(tts.stops, 1);
  await tick();
  assert.equal(history.length, 0);
});

test('only the last N turns are sent to the LLM', async () => {
  const { o, tts, llm } = makeOrchestrator({ session: { historyTurns: 2 } });
  for (let i = 1; i <= 5; i++) {
    o.submitText(`вопрос номер ${i}`);
    llm.last.token(`Это ответ номер ${i}.`);
    llm.last.finish();
    await tick();
    playAll(tts, `t${i}`);
  }
  o.submitText('последний вопрос');
  const contents = llm.last.req.messages.map((m) => m.content);
  assert.equal(llm.last.req.messages.length, 1 + 4 + 1);
  assert.deepEqual(contents.slice(1), ['вопрос номер 4', 'Это ответ номер 4.', 'вопрос номер 5', 'Это ответ номер 5.', 'последний вопрос']);
});

test('LLM failure returns to LISTENING, shows the error and stores nothing', async () => {
  const { o, stt, llm, history, events } = makeOrchestrator();
  o.setMicMode('full');
  say(stt, 'Привет');
  llm.last.fail('LM Studio is not reachable');
  await tick();
  assert.equal(o.state, 'LISTENING');
  assert.equal(stt.listening, true);
  assert.equal(history.length, 0);
  assert.match(events.problems[0].message, /LM Studio is not reachable/);
  assert.equal(events.messages[events.messages.length - 1].role, 'system');
  assert.equal(events.turns[0].outcome, 'error');
});

test('LLM not ready (no model) fails the turn cleanly', async () => {
  const { o, llm, events } = makeOrchestrator();
  o.setLlmModel('');
  o.submitText('Привет');
  await tick();
  assert.equal(o.state, 'LISTENING');
  assert.equal(llm.calls.length, 0);
  assert.match(events.problems[0].message, /LLM is not ready/);
});

test('TTS failure during speech returns to LISTENING', async () => {
  const { o, tts, llm, events } = makeOrchestrator();
  o.submitText('Привет');
  llm.last.token('Это первое предложение ответа. ');
  llm.last.token('Второе');
  assert.equal(o.state, 'SPEAKING');
  tts.emit('failed', { turnId: 't1', message: 'audio device lost' });
  assert.equal(o.state, 'LISTENING');
  assert.equal(llm.last.aborted, true);
  assert.equal(tts.stops, 1);
  assert.match(events.problems[0].message, /audio device lost/);
});

test('TTS unavailable (service down) fails the turn instead of hanging in SPEAKING', async () => {
  const { o, tts, llm, events } = makeOrchestrator();
  tts.available = false;
  o.submitText('Привет');
  llm.last.token('Привет, это ответ. ');
  llm.last.token('Ещё');
  assert.equal(o.state, 'LISTENING');
  assert.match(events.problems[0].message, /TTS is not available/);
});

test('empty answer and reasoning-only answer are reported as errors', async () => {
  const a = makeOrchestrator();
  a.o.submitText('Привет');
  a.llm.last.finish();
  await tick();
  assert.equal(a.o.state, 'LISTENING');
  assert.match(a.events.problems[0].message, /empty answer/);

  const b = makeOrchestrator();
  b.o.submitText('Привет');
  b.llm.last.reason('думаю '.repeat(100));
  b.llm.last.finish({ finishReason: 'length' });
  await tick();
  assert.equal(b.o.state, 'LISTENING');
  assert.match(b.events.problems[0].message, /reasoning but no answer/);
  assert.equal(b.history.length, 0);
});

test('the provider\'s diagnosis of a missing answer is shown and recorded with the turn', async () => {
  const { o, llm, events, history } = makeOrchestrator();
  const diags = [];
  o.on('llmDiag', (d) => diags.push(d));
  o.submitText('Привет', 'llm_tts');
  llm.last.reason('думаю '.repeat(100));
  const diag = {
    url: 'http://127.0.0.1:1234/v1/chat/completions', model: 'stub-model', httpStatus: 200, contentType: 'text/event-stream',
    attempts: [{ strategy: 'effort', minimal: false, status: 200, result: 'reasoning_detected' }, { strategy: 'budget', minimal: false, status: 200, result: 'completed' }],
    request: { max_tokens: 2348 }, sse: { events: 302, deltaKeys: { role: 1, reasoning_content: 299 } },
    finishReason: 'length', contentChars: 0, reasoningChars: 600, thinkingControl: 'budget', outcome: 'reasoning_only',
  };
  llm.last.finish({ finishReason: 'length', outcome: 'reasoning_only', diagnosis: 'LLM returned reasoning but no answer: 299 reasoning tokens, reasoning used the whole token budget (max_tokens 2348, finish_reason "length").', diag });
  await tick();
  assert.equal(o.state, 'LISTENING');
  assert.match(events.problems[0].message, /299 reasoning tokens.*max_tokens 2348/);
  const turn = events.turns[0];
  assert.equal(turn.outcome, 'error');
  assert.equal(turn.counters.llmOutcome, 'reasoning_only');
  assert.equal(turn.counters.llmThinkingControl, 'budget');
  assert.equal(turn.counters.llmAttempts, 2);
  assert.equal(history.length, 0, 'a turn without an answer is not added to the session');
  assert.equal(diags.length, 1);
  assert.equal(o.lastLlmDiag.turnId, turn.turnId);
  assert.equal(o.lastLlmDiag.outcome, 'reasoning_only');
  const everything = JSON.stringify([events.messages, events.problems, turn, diags]);
  assert.equal(/думаю/.test(everything), false, 'reasoning text is never shown, stored or spoken');
});

test('a failed LLM request records what kind of failure it was', async () => {
  const { o, llm, events } = makeOrchestrator();
  o.submitText('Привет', 'llm_only');
  const err = Object.assign(new Error('LLM server returned HTTP 503: model unloaded'), { outcome: 'api_failure', diag: { url: 'u', httpStatus: 503, attempts: [{ strategy: 'effort', result: 'http_error' }], sse: null, thinkingControl: 'effort', contentChars: 0, reasoningChars: 0, finishReason: null } });
  llm.last.reject(err);
  await tick();
  assert.equal(events.turns[0].outcome, 'error');
  assert.equal(events.turns[0].counters.llmOutcome, 'api_failure');
  assert.match(events.problems[0].message, /HTTP 503/);
  assert.equal(o.lastLlmDiag.httpStatus, 503);
});

test('manual stop aborts generation and playback', async () => {
  const { o, tts, llm, events } = makeOrchestrator();
  o.submitText('Привет');
  assert.equal(o.stop(), true);
  assert.equal(o.state, 'LISTENING');
  assert.equal(llm.last.aborted, true);
  assert.equal(tts.stops, 1);
  await tick();
  assert.equal(events.turns[0].outcome, 'stopped');
  assert.equal(events.problems.length, 0);
  assert.equal(o.stop(), false);
});

test('events from an earlier, stopped turn do not affect the current one', async () => {
  const { o, tts, llm } = makeOrchestrator();
  o.submitText('Первый');
  llm.last.token('Ответ на первый вопрос. ');
  llm.last.token('Дальше');
  o.stop();
  o.submitText('Второй');
  assert.equal(o.state, 'THINKING');
  tts.emit('drained', { turnId: 't1', tPlaybackEnd: 1, chunks: 0, aborted: true });
  tts.emit('failed', { turnId: 't1', message: 'late error' });
  assert.equal(o.state, 'THINKING');
});

test('bypass B: typed text -> LLM only (no TTS)', async () => {
  const { o, tts, llm, history, events, transitions } = makeOrchestrator();
  assert.equal(o.submitText('Привет', 'llm_only').accepted, true);
  llm.last.token('Привет! Чем могу помочь?');
  llm.last.finish();
  await tick();
  assert.equal(o.state, 'LISTENING');
  assert.equal(tts.spoken.length, 0);
  assert.deepEqual(transitions, ['LISTENING>THINKING', 'THINKING>LISTENING']);
  assert.equal(history.length, 1);
  assert.equal(events.turns[0].mode, 'llm_only');
  assert.equal(events.turns[0].derived.turnDurationMs !== null, true);
});

test('bypass C: typed text -> TTS only (no LLM, no history)', async () => {
  const { o, tts, llm, history, events, transitions } = makeOrchestrator();
  o.submitText('Проверка голоса. Раз, два, три, четыре.', 'tts_only');
  assert.equal(o.state, 'SPEAKING');
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(tts.spoken.map((c) => c.text), ['Проверка голоса.', 'Раз, два, три, четыре.']);
  playAll(tts, 't1');
  assert.equal(o.state, 'LISTENING');
  assert.deepEqual(transitions, ['LISTENING>SPEAKING', 'SPEAKING>LISTENING']);
  assert.equal(history.length, 0);
  assert.equal(events.turns[0].mode, 'tts_only');
  assert.ok(events.turns[0].derived.ttsFirstAudioMs !== null);
});

test('bypass A: microphone -> STT only (no LLM, no TTS)', async () => {
  const { o, stt, tts, llm, history, events } = makeOrchestrator();
  o.setMicMode('stt_only');
  say(stt, 'Это проверка распознавания');
  assert.equal(o.state, 'LISTENING');
  assert.equal(llm.calls.length, 0);
  assert.equal(tts.spoken.length, 0);
  assert.equal(history.length, 0);
  assert.equal(events.stt[0].text, 'Это проверка распознавания');
  assert.equal(events.turns[0].mode, 'stt_only');
  assert.equal(events.turns[0].derived.speechEndToSttFinalMs, 750);
  assert.equal(stt.listening, true, 'listening resumes for the next utterance');
});

test('typed text bypasses STT (D) while the microphone is off', async () => {
  const { o, stt, tts, llm, events } = makeOrchestrator();
  assert.equal(o.micMode, 'off');
  o.submitText('Привет');
  llm.last.token('Привет! Рада тебя слышать.');
  llm.last.finish();
  await tick();
  playAll(tts, 't1');
  assert.equal(events.turns[0].mode, 'text_llm_tts');
  assert.equal(events.turns[0].input, 'text');
  assert.equal(stt.gate.includes(true), false, 'microphone gate never opened');
});

test('voice events are ignored while the microphone is off', () => {
  const { o, stt, llm } = makeOrchestrator();
  say(stt, 'Меня кто-нибудь слышит?');
  assert.equal(o.state, 'LISTENING');
  assert.equal(llm.calls.length, 0);
});

test('hearing / transcribing indicators follow the utterance', () => {
  const { o, stt } = makeOrchestrator();
  o.setMicMode('stt_only');
  stt.emit('speechStart', { utteranceId: 901, tSpeechStart: 1 });
  assert.equal(o.snapshot().hearing, true);
  stt.emit('speechEnd', { utteranceId: 901, tSpeechStart: 1, tSpeechEnd: 500, tVadEndDetected: 1100, speechMs: 499 });
  assert.equal(o.snapshot().hearing, false);
  assert.equal(o.snapshot().transcribing, true);
  assert.equal(o.submitText('набрал текст').accepted, false, 'typed input waits for the transcript');
  stt.emit('final', { utteranceId: 901, text: 'готово', tSttFinal: 1200, sttMs: 100 });
  assert.equal(o.snapshot().transcribing, false);
});

test('a discarded utterance resumes listening without starting a turn', () => {
  const { o, stt, llm, events } = makeOrchestrator();
  o.setMicMode('full');
  stt.emit('speechStart', { utteranceId: 902, tSpeechStart: 1 });
  stt.emit('speechEnd', { utteranceId: 902, tSpeechStart: 1, tSpeechEnd: 500, tVadEndDetected: 1100, speechMs: 499 });
  assert.equal(stt.listening, true); // last command sent; the service itself paused
  stt.emit('discarded', { utteranceId: 902, stage: 'stt', reason: 'known_hallucination', text: 'Продолжение следует...' });
  assert.equal(o.state, 'LISTENING');
  assert.equal(llm.calls.length, 0);
  assert.equal(events.stt[0].accepted, false);
  assert.equal(stt.gate[stt.gate.length - 1], true);
  assert.equal(stt.gate.filter((g) => g === true).length, 2, 'gate explicitly reopened after the discard');
});

test('speaking watchdog recovers if playback completion never arrives', async () => {
  const { o, llm, events } = makeOrchestrator({ conversation: { speakingWatchdogMs: 40 } });
  o.submitText('Привет');
  llm.last.token('Привет, это ответ. ');
  llm.last.token('Конец.');
  llm.last.finish();
  await tick();
  assert.equal(o.state, 'SPEAKING');
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(o.state, 'LISTENING');
  assert.match(events.problems[0].message, /did not report playback completion/);
});

test('invalid input is rejected without changing state', () => {
  const { o } = makeOrchestrator();
  assert.equal(o.submitText('   ').accepted, false);
  assert.equal(o.submitText('x', 'teleport').accepted, false);
  assert.throws(() => o.setMicMode('always'), /Unknown mic mode/);
  assert.equal(o.state, 'LISTENING');
});

test('voice service loss during speech fails the turn; LLM-only turns continue', async () => {
  const a = makeOrchestrator();
  a.o.submitText('Привет');
  a.llm.last.token('Первое предложение ответа. ');
  a.llm.last.token('x');
  a.o.resetVoiceLink('Voice service exited unexpectedly');
  assert.equal(a.o.state, 'LISTENING');
  assert.match(a.events.problems[0].message, /Voice service exited/);

  const b = makeOrchestrator();
  b.o.submitText('Привет', 'llm_only');
  b.o.resetVoiceLink('Voice service exited unexpectedly');
  assert.equal(b.o.state, 'THINKING');
});
