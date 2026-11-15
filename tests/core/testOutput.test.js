'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTap, parseUnittest } = require('../../scripts/lib/testOutput');

test('TAP: every top-level test with its outcome; subtests and comments are ignored', () => {
  const out = [
    'TAP version 13', '# Subtest: first', 'ok 1 - first', '  ---', '  duration_ms: 1.5', '  ...',
    '# Subtest: a failing one', 'not ok 2 - a failing one — with a dash', '  ---', "  error: 'x'", '  ...',
    '    ok 1 - nested subtest', 'ok 3 - needs the real model # SKIP no model here', '1..3', '# tests 3', '# pass 1',
  ].join('\n');
  assert.deepEqual(parseTap(out), [
    { name: 'first', ok: true, skipped: false },
    { name: 'a failing one — with a dash', ok: false, skipped: false },
    { name: 'needs the real model', ok: true, skipped: true },
  ]);
  assert.deepEqual(parseTap(''), []);
});

test('unittest -v: both name formats, docstrings, output between the name and the verdict, failures and skips', () => {
  const out = [
    'test_a (tests.service.test_x.FirstTest.test_a) ... ok',
    'test_b (tests.service.test_x.FirstTest) ... ok',
    'test_c (tests.service.test_x.FirstTest.test_c) ... synthesis failed',
    'Traceback (most recent call last):', '  File "x.py", line 1, in f', 'RuntimeError: boom', 'ok',
    'test_d (tests.service.test_x.SecondTest.test_d)',
    'What the docstring says. ... ok',
    'test_e (tests.service.test_x.SecondTest.test_e) ... FAIL',
    'test_f (tests.service.test_x.SecondTest.test_f) ... ERROR',
    "test_g (tests.service.test_x.SecondTest.test_g) ... skipped 'no model'",
    '', '----------------------------------------------------------------------', 'Ran 7 tests in 0.1s', '', 'FAILED (failures=1, errors=1, skipped=1)',
  ].join('\r\n');
  assert.deepEqual(parseUnittest(out), [
    { name: 'FirstTest.test_a', ok: true, skipped: false },
    { name: 'FirstTest.test_b', ok: true, skipped: false },
    { name: 'FirstTest.test_c', ok: true, skipped: false },
    { name: 'SecondTest.test_d', ok: true, skipped: false },
    { name: 'SecondTest.test_e', ok: false, skipped: false },
    { name: 'SecondTest.test_f', ok: false, skipped: false },
    { name: 'SecondTest.test_g', ok: true, skipped: true },
  ]);
});
