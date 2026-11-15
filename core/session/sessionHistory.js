'use strict';

const MIN_TURNS = 0;
const MAX_TURNS = 20;

function clampTurns(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 10;
  return Math.min(MAX_TURNS, Math.max(MIN_TURNS, v));
}

/**
 * Short-term memory for the current session only: the last N dialogue turns
 * (one turn = one user message + one companion reply). Nothing is persisted.
 */
class SessionHistory {
  constructor({ maxTurns = 10 } = {}) {
    this._maxTurns = clampTurns(maxTurns);
    this._turns = [];
    this.sessionId = 1;
  }

  get maxTurns() { return this._maxTurns; }
  get length() { return this._turns.length; }
  get turns() { return this._turns.map((t) => ({ ...t })); }

  setMaxTurns(n) {
    this._maxTurns = clampTurns(n);
    this._trim();
  }

  addTurn(user, assistant) {
    const u = String(user ?? '').trim();
    const a = String(assistant ?? '').trim();
    if (!u || !a) return false;
    this._turns.push({ user: u, assistant: a });
    this._trim();
    return true;
  }

  /** Flat OpenAI-style message list, oldest first. */
  getMessages() {
    const out = [];
    for (const t of this._turns) {
      out.push({ role: 'user', content: t.user });
      out.push({ role: 'assistant', content: t.assistant });
    }
    return out;
  }

  clear() {
    this._turns = [];
    this.sessionId += 1;
  }

  _trim() {
    const extra = this._turns.length - this._maxTurns;
    if (extra > 0) this._turns.splice(0, extra);
  }
}

module.exports = { SessionHistory, clampTurns, MIN_TURNS, MAX_TURNS };
