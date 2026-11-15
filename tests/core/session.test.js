'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionHistory, clampTurns } = require('../../core/session/sessionHistory');
const { buildMessages } = require('../../core/conversation/prompt');

test('keeps only the last N turns', () => {
  const h = new SessionHistory({ maxTurns: 3 });
  for (let i = 1; i <= 7; i++) h.addTurn(`u${i}`, `a${i}`);
  assert.equal(h.length, 3);
  assert.deepEqual(h.getMessages().map((m) => m.content), ['u5', 'a5', 'u6', 'a6', 'u7', 'a7']);
  assert.deepEqual(h.getMessages().map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
});

test('default is 10 turns and the limit is clamped to 0..20', () => {
  assert.equal(new SessionHistory().maxTurns, 10);
  assert.equal(clampTurns(-5), 0);
  assert.equal(clampTurns(999), 20);
  assert.equal(clampTurns('7'), 7);
  assert.equal(clampTurns('abc'), 10);
});

test('context cannot grow without bound', () => {
  const h = new SessionHistory({ maxTurns: 20 });
  for (let i = 0; i < 1000; i++) h.addTurn(`u${i}`, `a${i}`);
  assert.equal(h.length, 20);
  assert.equal(h.getMessages().length, 40);
});

test('zero turns disables history', () => {
  const h = new SessionHistory({ maxTurns: 0 });
  h.addTurn('u', 'a');
  assert.equal(h.length, 0);
  assert.deepEqual(h.getMessages(), []);
});

test('shrinking the limit trims immediately', () => {
  const h = new SessionHistory({ maxTurns: 10 });
  for (let i = 1; i <= 6; i++) h.addTurn(`u${i}`, `a${i}`);
  h.setMaxTurns(2);
  assert.deepEqual(h.turns.map((t) => t.user), ['u5', 'u6']);
});

test('clear removes all turns and starts a new session id', () => {
  const h = new SessionHistory();
  h.addTurn('u', 'a');
  const before = h.sessionId;
  h.clear();
  assert.equal(h.length, 0);
  assert.deepEqual(h.getMessages(), []);
  assert.equal(h.sessionId, before + 1);
});

test('incomplete turns are not stored', () => {
  const h = new SessionHistory();
  assert.equal(h.addTurn('u', ''), false);
  assert.equal(h.addTurn('  ', 'a'), false);
  assert.equal(h.length, 0);
});

test('buildMessages = system + history + current user message', () => {
  const h = new SessionHistory({ maxTurns: 2 });
  h.addTurn('Меня интересует красный автомобиль.', 'Отличный выбор!');
  const msgs = buildMessages({ systemPrompt: ' SYS ', historyMessages: h.getMessages(), userText: ' А какого он был цвета? ' });
  assert.deepEqual(msgs, [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'Меня интересует красный автомобиль.' },
    { role: 'assistant', content: 'Отличный выбор!' },
    { role: 'user', content: 'А какого он был цвета?' },
  ]);
  assert.deepEqual(buildMessages({ systemPrompt: '', userText: 'x' }), [{ role: 'user', content: 'x' }]);
});
