'use strict';
const { EventEmitter } = require('node:events');
const { nowMs } = require('./clock');

/** Compact bounded in-memory event log for the Diagnostics tab. */
class EventLog extends EventEmitter {
  constructor({ capacity = 500, clock = nowMs } = {}) {
    super();
    this.capacity = capacity;
    this.clock = clock;
    this.entries = [];
    this._seq = 0;
  }

  add(level, source, message, data) {
    const entry = {
      seq: ++this._seq,
      t: this.clock(),
      level,
      source,
      message: String(message),
    };
    if (data !== undefined) entry.data = data;
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    this.emit('entry', entry);
    return entry;
  }

  info(source, message, data) { return this.add('info', source, message, data); }
  warn(source, message, data) { return this.add('warn', source, message, data); }
  error(source, message, data) { return this.add('error', source, message, data); }

  list() { return this.entries.slice(); }
}

module.exports = { EventLog };
