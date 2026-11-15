'use strict';

function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** {n, median, min, max} over the finite values; nulls are ignored. */
function summarize(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return { n: 0, median: null, min: null, max: null };
  return { n: v.length, median: median(v), min: Math.min(...v), max: Math.max(...v) };
}

/** Summarize every derived interval over a list of finalized turns. */
function summarizeTurns(turns, keys) {
  const out = {};
  for (const key of keys) {
    out[key] = summarize(turns.map((t) => (t.derived ? t.derived[key] : null)));
  }
  return out;
}

module.exports = { median, summarize, summarizeTurns };
