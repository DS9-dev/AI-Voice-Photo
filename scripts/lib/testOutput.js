'use strict';
/**
 * Reads the outcome of every single test out of the runners' output, so that
 * reports can point at the tests that prove a statement instead of at a total.
 * Used by scripts/run_tests.js (which stores the lists in
 * artifacts/reports/test_results.json).
 */

/**
 * node --test --test-reporter=tap: top-level lines "ok 12 - title" / "not ok 12 - title",
 * optionally followed by "# SKIP reason". Subtests are indented and ignored.
 */
function parseTap(output) {
  const results = [];
  for (const line of String(output).split(/\r?\n/)) {
    const m = /^(not ok|ok) \d+ - (.*?)(?:\s+# (SKIP|TODO)\b.*)?$/i.exec(line);
    if (!m) continue;
    results.push({ name: m[2], ok: m[1] === 'ok', skipped: Boolean(m[3]) && m[3].toUpperCase() === 'SKIP' });
  }
  return results;
}

/**
 * python -m unittest -v: "test_x (pkg.mod.Class.test_x) ... ok" (3.11+) or
 * "test_x (pkg.mod.Class) ... ok" (older). A test with a docstring prints its
 * name on one line and "<docstring> ... ok" on the next. Output of the code
 * under test can come between "..." and the verdict, which then stands on a
 * later line.
 * Names are normalized to "Class.test_x".
 */
function parseUnittest(output) {
  const results = [];
  let pending = null;
  const verdict = (text) => {
    if (/^ok$/.test(text)) return { ok: true, skipped: false };
    if (/^(FAIL|ERROR)$/.test(text)) return { ok: false, skipped: false };
    if (/^skipped\b/.test(text)) return { ok: true, skipped: true };
    return null;
  };
  for (const raw of String(output).split(/\r?\n/)) {
    const line = raw.trimEnd();
    // with a docstring the name stands alone and the verdict follows the docstring line
    const start = /^(test\w+) \(([^)]+)\)(?: \.\.\. ?(.*))?$/.exec(line);
    if (start) {
      const method = start[1];
      const owner = start[2].endsWith(`.${method}`) ? start[2].slice(0, -method.length - 1) : start[2];
      const name = `${owner.split('.').pop()}.${method}`;
      const v = verdict((start[3] || '').trim());
      if (v) { results.push({ name, ...v }); pending = null; } else pending = name;
      continue;
    }
    if (pending) {
      const tail = / \.\.\. (ok|FAIL|ERROR|skipped.*)$/.exec(line);
      const v = verdict(tail ? tail[1] : line.trim());
      if (v) { results.push({ name: pending, ...v }); pending = null; }
    }
  }
  return results;
}

module.exports = { parseTap, parseUnittest };
