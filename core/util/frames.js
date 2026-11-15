'use strict';
/**
 * Mixed text / binary framing over a byte stream (VC-M3.2).
 *
 *   text frame    one JSON object per line, UTF-8, terminated by "\n"
 *   binary frame  "!<N> <JSON header>\n" followed by exactly N raw bytes
 *
 * A JSON line starts with "{", a binary header with "!", so the first byte of
 * a line tells which one it is. The decoder does not depend on how the bytes
 * arrive: a header split over several reads, a header and half a payload, or
 * several frames in one read all decode the same way.
 *
 * Used for the voice service's stdout (TTS audio returned to Core) and, on the
 * Core → Bridge link, by the test Bridge. Limits: a line (text or header) at
 * most `maxLineBytes`, a payload 1..`maxBinaryBytes`; anything else throws
 * FrameError and the stream must be closed (it can no longer be resynchronised).
 */

const MAX_LINE_BYTES = 64 * 1024;
const MAX_BINARY_BYTES = 4 * 1024 * 1024;
const BANG = 0x21;   // '!'
const NL = 0x0a;

class FrameError extends Error {
  constructor(message) { super(message); this.name = 'FrameError'; }
}

/** Build a binary frame: header object + payload Buffer. */
function encodeBinary(header, payload, { maxBinaryBytes = MAX_BINARY_BYTES, maxLineBytes = MAX_LINE_BYTES } = {}) {
  if (!Buffer.isBuffer(payload) || payload.length < 1) throw new FrameError('binary payload is empty');
  if (payload.length > maxBinaryBytes) throw new FrameError(`binary payload of ${payload.length} bytes exceeds ${maxBinaryBytes}`);
  const line = `!${payload.length} ${JSON.stringify(header)}\n`;
  if (Buffer.byteLength(line) > maxLineBytes) throw new FrameError('binary header too large');
  return Buffer.concat([Buffer.from(line, 'utf8'), payload]);
}

class FrameDecoder {
  constructor({ maxLineBytes = MAX_LINE_BYTES, maxBinaryBytes = MAX_BINARY_BYTES, allowBinary = true } = {}) {
    this.maxLineBytes = maxLineBytes;
    this.maxBinaryBytes = maxBinaryBytes;
    this.allowBinary = allowBinary;
    this.lineChunks = [];
    this.lineSize = 0;
    this.bin = null;      // {header, buf, pos} while a payload is being read
  }

  /**
   * @param {Buffer} buf
   * @returns {Array<{kind:'text', text:string} | {kind:'binary', header:string, payload:Buffer}>}
   */
  push(buf) {
    const out = [];
    let i = 0;
    while (i < buf.length) {
      if (this.bin) {
        const n = Math.min(this.bin.buf.length - this.bin.pos, buf.length - i);
        buf.copy(this.bin.buf, this.bin.pos, i, i + n);
        this.bin.pos += n;
        i += n;
        if (this.bin.pos === this.bin.buf.length) {
          out.push({ kind: 'binary', header: this.bin.header, payload: this.bin.buf });
          this.bin = null;
        }
        continue;
      }
      const nl = buf.indexOf(NL, i);
      const end = nl === -1 ? buf.length : nl;
      const part = buf.subarray(i, end);
      if (this.lineSize + part.length > this.maxLineBytes) throw new FrameError(`line longer than ${this.maxLineBytes} bytes`);
      if (nl === -1) {
        if (part.length) { this.lineChunks.push(Buffer.from(part)); this.lineSize += part.length; }
        break;
      }
      this.lineChunks.push(part);
      const line = Buffer.concat(this.lineChunks);
      this.lineChunks = [];
      this.lineSize = 0;
      i = nl + 1;
      if (line.length && line[0] === BANG) {
        this._startBinary(line);
      } else {
        out.push({ kind: 'text', text: line.toString('utf8').replace(/\r$/, '') });
      }
    }
    return out;
  }

  _startBinary(line) {
    if (!this.allowBinary) throw new FrameError('binary frame not allowed on this stream');
    const text = line.toString('utf8');
    const m = /^!([1-9][0-9]{0,9}) (\{.*\})\r?$/.exec(text);
    if (!m) throw new FrameError('malformed binary frame header');
    const n = Number(m[1]);
    if (n > this.maxBinaryBytes) throw new FrameError(`binary frame of ${n} bytes exceeds ${this.maxBinaryBytes}`);
    this.bin = { header: m[2], buf: Buffer.allocUnsafe(n), pos: 0 };
  }

  /** Bytes of an unfinished frame still expected (0 when at a frame boundary). */
  get pending() { return this.bin ? this.bin.buf.length - this.bin.pos : this.lineSize; }
}

module.exports = { FrameDecoder, FrameError, encodeBinary, MAX_LINE_BYTES, MAX_BINARY_BYTES };
