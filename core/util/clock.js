'use strict';
const { performance } = require('node:perf_hooks');

/**
 * Wall-clock milliseconds since the Unix epoch with sub-millisecond resolution,
 * derived from a monotonic source so intervals never go backwards.
 * The Python voice service uses the same construction; the remaining offset
 * between the two processes is measured at startup (see VoiceServiceClient).
 */
function nowMs() {
  return performance.timeOrigin + performance.now();
}

module.exports = { nowMs };
