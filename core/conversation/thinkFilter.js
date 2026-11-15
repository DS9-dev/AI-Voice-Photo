'use strict';

const OPEN = '<think>';
const CLOSE = '</think>';

/**
 * Separates inline reasoning (<think>...</think>) from speakable content in a
 * token stream. Reasoning must never be sent to TTS.
 *
 * Runtimes differ: some put reasoning in a separate `reasoning_content`
 * delta (handled by the provider), others leave the tags inline (handled
 * here). Tags may be split across chunks, so a possible partial tag at the
 * end of the buffer is held back until it is resolved.
 */
class ThinkFilter {
  constructor() {
    this._buf = '';
    this._inThink = false;
    this.sawOrphanClose = false;
  }

  /** @returns {{content: string, reasoning: string}} */
  push(text) {
    this._buf += text;
    let content = '';
    let reasoning = '';
    for (;;) {
      const tag = this._inThink ? CLOSE : OPEN;
      const idx = this._buf.indexOf(tag);
      if (idx !== -1) {
        const before = this._buf.slice(0, idx);
        if (this._inThink) reasoning += before; else content += before;
        this._buf = this._buf.slice(idx + tag.length);
        this._inThink = !this._inThink;
        continue;
      }
      if (!this._inThink) {
        // a closing tag with no opening one: the template pre-opened the block
        const orphan = this._buf.indexOf(CLOSE);
        if (orphan !== -1) {
          this.sawOrphanClose = true;
          reasoning += content + this._buf.slice(0, orphan);
          content = '';
          this._buf = this._buf.slice(orphan + CLOSE.length);
          continue;
        }
      }
      // keep back a suffix that could be the start of a tag
      const hold = this._partialTagLength();
      const emit = this._buf.slice(0, this._buf.length - hold);
      this._buf = this._buf.slice(this._buf.length - hold);
      if (this._inThink) reasoning += emit; else content += emit;
      break;
    }
    return { content, reasoning };
  }

  flush() {
    const rest = this._buf;
    this._buf = '';
    if (this._inThink) return { content: '', reasoning: rest };
    return { content: rest, reasoning: '' };
  }

  _partialTagLength() {
    const tags = this._inThink ? [CLOSE] : [OPEN, CLOSE];
    let best = 0;
    for (const tag of tags) {
      const max = Math.min(tag.length - 1, this._buf.length);
      for (let n = max; n > best; n--) {
        if (this._buf.endsWith(tag.slice(0, n))) { best = n; break; }
      }
    }
    return best;
  }
}

module.exports = { ThinkFilter };
