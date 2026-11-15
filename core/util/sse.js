'use strict';

/**
 * Incremental Server-Sent-Events parser. Feed decoded text chunks, get back
 * the `data:` payloads of every complete event (one string per event).
 */
class SseParser {
  constructor() {
    this._buffer = '';
    this._dataLines = [];
  }

  feed(chunk) {
    this._buffer += chunk;
    const out = [];
    let idx;
    while ((idx = this._buffer.indexOf('\n')) !== -1) {
      let line = this._buffer.slice(0, idx);
      this._buffer = this._buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        if (this._dataLines.length) {
          out.push(this._dataLines.join('\n'));
          this._dataLines = [];
        }
        continue;
      }
      if (line.startsWith(':')) continue; // comment / keep-alive
      if (line.startsWith('data:')) {
        let value = line.slice(5);
        if (value.startsWith(' ')) value = value.slice(1);
        this._dataLines.push(value);
      }
      // other fields (event:, id:, retry:) are not used by chat completions
    }
    return out;
  }

  /** Flush a trailing event that was not terminated by a blank line. */
  end() {
    const out = [];
    if (this._buffer.startsWith('data:')) {
      let value = this._buffer.slice(5);
      if (value.startsWith(' ')) value = value.slice(1);
      this._dataLines.push(value.replace(/\r$/, ''));
    }
    this._buffer = '';
    if (this._dataLines.length) {
      out.push(this._dataLines.join('\n'));
      this._dataLines = [];
    }
    return out;
  }
}

module.exports = { SseParser };
