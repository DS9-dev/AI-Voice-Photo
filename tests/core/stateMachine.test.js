'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ConversationStateMachine, States, InvalidTransitionError } = require('../../core/state/stateMachine');

test('starts in LISTENING and accepts input only there', () => {
  const sm = new ConversationStateMachine();
  assert.equal(sm.state, States.LISTENING);
  assert.equal(sm.canAcceptInput(), true);
  sm.transition('THINKING');
  assert.equal(sm.canAcceptInput(), false);
  sm.transition('SPEAKING');
  assert.equal(sm.canAcceptInput(), false);
  sm.transition('LISTENING');
  assert.equal(sm.canAcceptInput(), true);
});

test('the main cycle LISTENING -> THINKING -> SPEAKING -> LISTENING is recorded', () => {
  let t = 0;
  const sm = new ConversationStateMachine({ clock: () => ++t });
  const seen = [];
  sm.on('transition', (r) => seen.push(`${r.from}>${r.to}`));
  sm.transition('THINKING', 'utterance');
  sm.transition('SPEAKING');
  sm.transition('LISTENING');
  assert.deepEqual(seen, ['LISTENING>THINKING', 'THINKING>SPEAKING', 'SPEAKING>LISTENING']);
  assert.equal(sm.history.length, 3);
  assert.equal(sm.history[0].reason, 'utterance');
  assert.deepEqual(sm.history.map((h) => h.t), [1, 2, 3]);
});

test('invalid transitions throw and leave the state unchanged', () => {
  const sm = new ConversationStateMachine();
  assert.throws(() => sm.transition('LISTENING'), InvalidTransitionError);
  sm.transition('THINKING');
  assert.throws(() => sm.transition('THINKING'), InvalidTransitionError);
  sm.transition('SPEAKING');
  assert.throws(() => sm.transition('THINKING'), InvalidTransitionError);
  assert.equal(sm.state, 'SPEAKING');
  assert.throws(() => sm.transition('DANCING'), /Unknown state/);
});

test('bypass and failure edges exist', () => {
  const a = new ConversationStateMachine();
  a.transition('SPEAKING', 'tts-only');
  a.transition('LISTENING');
  const b = new ConversationStateMachine();
  b.transition('THINKING');
  b.transition('LISTENING', 'llm-only / error');
  assert.equal(b.state, 'LISTENING');
});

test('reset returns to LISTENING from any state and is a no-op when already there', () => {
  const sm = new ConversationStateMachine();
  assert.equal(sm.reset(), null);
  sm.transition('THINKING');
  sm.reset('error');
  assert.equal(sm.state, 'LISTENING');
  sm.transition('THINKING');
  sm.transition('SPEAKING');
  const rec = sm.reset('stop');
  assert.equal(rec.from, 'SPEAKING');
  assert.equal(sm.state, 'LISTENING');
});

test('transition history is bounded', () => {
  const sm = new ConversationStateMachine({ historyLimit: 4 });
  for (let i = 0; i < 10; i++) { sm.transition('THINKING'); sm.transition('LISTENING'); }
  assert.equal(sm.history.length, 4);
});
