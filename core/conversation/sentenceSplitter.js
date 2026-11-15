'use strict';

const TERMINATORS = '.!?…';
const CLOSERS = '"\'»”)]';

/**
 * Splits a streamed LLM answer into speakable sentences as soon as each one
 * is complete, so TTS can start before the whole answer has been generated.
 *
 * A sentence ends at . ! ? … (plus trailing closers) followed by whitespace,
 * or at a newline. Very short fragments are merged into the next sentence so
 * TTS is not called for things like "Да." on their own unless the answer ends.
 */
class StreamingSentenceSplitter {
  constructor({ minChars = 12 } = {}) {
    this.minChars = minChars;
    this._buf = '';
  }

  push(text) {
    this._buf += text;
    return this._drain(false);
  }

  flush() {
    const out = this._drain(true);
    const rest = this._buf.trim();
    this._buf = '';
    if (rest) out.push(rest);
    return out;
  }

  _drain(final) {
    const out = [];
    let searchFrom = 0;
    for (;;) {
      const cut = this._findBoundary(searchFrom, final);
      if (cut === -1) break;
      const candidate = this._buf.slice(0, cut).trim();
      if (candidate.length >= this.minChars) {
        out.push(candidate);
        this._buf = this._buf.slice(cut);
        searchFrom = 0;
      } else {
        // too short: keep it and look for the next boundary
        searchFrom = cut;
      }
    }
    return out;
  }

  /** Index just past a sentence boundary at or after `from`, or -1. */
  _findBoundary(from, final) {
    const s = this._buf;
    for (let i = from; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\n') {
        if (s.slice(0, i).trim().length > 0) return i + 1;
        continue;
      }
      if (!TERMINATORS.includes(ch)) continue;
      // swallow runs like "?!" or "..." and closing quotes/brackets
      let j = i + 1;
      while (j < s.length && (TERMINATORS.includes(s[j]) || CLOSERS.includes(s[j]))) j++;
      if (j >= s.length) {
        // boundary not confirmed yet: need the next character (unless final,
        // in which case flush() emits the remainder anyway)
        return -1;
      }
      if (/\s/.test(s[j])) return j;
      // e.g. "3.5", "т.е." without space, URLs: not a boundary
      i = j - 1;
    }
    return -1;
  }
}

/** Non-streaming helper. */
function splitSentences(text, opts) {
  const sp = new StreamingSentenceSplitter(opts);
  return [...sp.push(text), ...sp.flush()];
}

module.exports = { StreamingSentenceSplitter, splitSentences };
