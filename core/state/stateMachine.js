'use strict';
const { EventEmitter } = require('node:events');
const { nowMs } = require('../util/clock');

const States = Object.freeze({
  LISTENING: 'LISTENING',
  THINKING: 'THINKING',
  SPEAKING: 'SPEAKING',
});

/**
 * VC-M0 fixed interaction model:
 *
 *   LISTENING -> THINKING -> SPEAKING -> LISTENING
 *
 * Extra edges exist only for the diagnostic bypasses and for failures:
 *   LISTENING -> SPEAKING   typed text -> TTS (no LLM)
 *   THINKING  -> LISTENING  LLM-only bypass, empty answer, error, manual stop
 */
const TRANSITIONS = Object.freeze({
  LISTENING: ['THINKING', 'SPEAKING'],
  THINKING: ['SPEAKING', 'LISTENING'],
  SPEAKING: ['LISTENING'],
});

class InvalidTransitionError extends Error {
  constructor(from, to) {
    super(`Invalid state transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

class ConversationStateMachine extends EventEmitter {
  constructor({ clock = nowMs, historyLimit = 200 } = {}) {
    super();
    this.clock = clock;
    this.historyLimit = historyLimit;
    this._state = States.LISTENING;
    this.history = [];
  }

  get state() { return this._state; }

  /** Conversational input (voice or typed) is accepted only while LISTENING. */
  canAcceptInput() { return this._state === States.LISTENING; }

  canTransition(to) {
    return TRANSITIONS[this._state].includes(to);
  }

  transition(to, reason = '') {
    if (!Object.prototype.hasOwnProperty.call(States, to)) {
      throw new Error(`Unknown state ${to}`);
    }
    const from = this._state;
    if (!this.canTransition(to)) throw new InvalidTransitionError(from, to);
    this._state = to;
    const record = { from, to, reason, t: this.clock() };
    this.history.push(record);
    if (this.history.length > this.historyLimit) this.history.shift();
    this.emit('transition', record);
    return record;
  }

  /** Return to LISTENING from any state (used after errors / manual stop). */
  reset(reason = 'reset') {
    if (this._state === States.LISTENING) return null;
    return this.transition(States.LISTENING, reason);
  }
}

module.exports = { States, TRANSITIONS, ConversationStateMachine, InvalidTransitionError };
