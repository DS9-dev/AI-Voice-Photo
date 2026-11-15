'use strict';
/**
 * Runs all automated tests (npm test):
 *   - Core tests            node --test  tests/core/*.test.js
 *   - Voice service tests   python -m unittest discover -s tests/service -t .
 * Afterwards it checks that no service / fake-service / launcher process
 * started by the tests is still running.
 * Writes artifacts/reports/test_results.json. Exit code 0 only if all pass
 * and nothing is left running.
 *
 *   node scripts/run_tests.js [--core] [--service]
 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, run, findTestPython, listServiceProcesses } = require('./lib/proc');
const { parseTap, parseUnittest } = require('./lib/testOutput');

const only = process.argv.slice(2);
const want = (name) => !only.length || only.includes(`--${name}`);

const findPython = () => findTestPython();

async function runCore() {
  const dir = path.join(ROOT, 'tests', 'core');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join('tests', 'core', f));
  console.log(`\n=== Core tests (${files.length} files) ===`);
  const r = await run(process.execPath, ['--test', '--test-reporter=tap', ...files], { echo: false });
  const num = (label) => { const m = new RegExp(`^# ${label} (\\d+)`, 'm').exec(r.output); return m ? Number(m[1]) : 0; };
  // `results`: every test by title, so that a report can name the tests behind a statement
  const res = { suite: 'core', tests: num('tests'), passed: num('pass'), failed: num('fail'), skipped: num('skipped'), exitCode: r.code, results: parseTap(r.output) };
  for (const line of r.output.split('\n')) {
    if (/^\s*not ok /.test(line)) console.log(line.trimEnd());
  }
  if (r.code !== 0 && !res.failed) { res.failed = res.failed || 1; console.log(r.output.slice(-3000)); }
  console.log(`  ${res.passed}/${res.tests} passed, ${res.failed} failed, ${res.skipped} skipped`);
  if (res.failed) {
    fs.mkdirSync(path.join(ROOT, 'artifacts', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'artifacts', 'logs', 'test_core_output.log'), r.output);
    console.log('  details: artifacts/logs/test_core_output.log');
  }
  return res;
}

async function runService() {
  console.log('\n=== Voice service tests (Python) ===');
  const py = findPython();
  if (!py) {
    console.log('  NOT RUN: no Python with numpy found (run setup.bat first)');
    return { suite: 'service', tests: 0, passed: 0, failed: 0, skipped: 0, exitCode: null, notRun: 'python not available' };
  }
  const r = await run(py, ['-m', 'unittest', 'discover', '-v', '-s', path.join('tests', 'service'), '-t', '.'], { echo: false, env: { PYTHONIOENCODING: 'utf-8' } });
  const ran = /^Ran (\d+) tests?/m.exec(r.output);
  const tests = ran ? Number(ran[1]) : 0;
  const part = (name) => { const m = new RegExp(`${name}=(\\d+)`).exec(r.output); return m ? Number(m[1]) : 0; };
  const failed = part('failures') + part('errors');
  const skipped = part('skipped');
  const skippedTests = [];
  // verbose unittest output: "<test> (<class path>) ... skipped '<reason>'" on one line
  for (const line of r.output.split(/\r?\n/)) {
    const m = /^(test\w+) \(([^)]+)\) \.\.\. skipped '?(.*?)'?$/.exec(line);
    if (m) skippedTests.push({ test: `${m[1]} (${m[2]})`, reason: m[3] });
    else if (/ \.\.\. skipped /.test(line)) skippedTests.push({ test: '(see artifacts/logs/test_service_output.log)', reason: line.split(' ... skipped ')[1] });
  }
  const res = { suite: 'service', python: py, tests, passed: tests - failed - skipped, failed: r.code === 0 ? failed : Math.max(failed, 1), skipped, skippedTests, exitCode: r.code, results: parseUnittest(r.output) };
  console.log(`  ${res.passed}/${res.tests} passed, ${res.failed} failed, ${res.skipped} skipped`);
  for (const sk of skippedTests) console.log(`  skipped: ${sk.test} — ${sk.reason}`);
  fs.mkdirSync(path.join(ROOT, 'artifacts', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'artifacts', 'logs', 'test_service_output.log'), r.output);
  if (r.code !== 0) {
    console.log(r.output.split('\n').filter((l) => /^(FAIL|ERROR):/.test(l)).join('\n'));
    console.log('  details: artifacts/logs/test_service_output.log');
  }
  return res;
}

/** Processes of the voice service or its test doubles that appeared during the run and are still there. */
async function findOrphans(before) {
  if (before === null) return { checked: false, orphans: [] };
  const known = new Set(before.map((p) => p.pid));
  let left = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const now = listServiceProcesses();
    if (now === null) return { checked: false, orphans: [] };
    left = now.filter((p) => !known.has(p.pid));
    if (!left.length) break;
    await new Promise((r) => setTimeout(r, 500)); // processes that are just exiting
  }
  return { checked: true, orphans: left };
}

async function main() {
  const before = listServiceProcesses();
  const suites = [];
  if (want('core')) suites.push(await runCore());
  if (want('service')) suites.push(await runService());
  console.log('\n=== Leftover process check ===');
  const leftover = await findOrphans(before);
  if (!leftover.checked) console.log('  NOT CHECKED: the process list could not be read');
  else if (leftover.orphans.length) console.log(`  FAIL: still running after the tests: ${leftover.orphans.map((p) => `${p.name} pid ${p.pid}`).join(', ')}`);
  else console.log('  none: no voice-service, fake-service or launcher process is left running');
  const total = suites.reduce((a, s) => ({ tests: a.tests + s.tests, passed: a.passed + s.passed, failed: a.failed + s.failed, skipped: a.skipped + s.skipped }), { tests: 0, passed: 0, failed: 0, skipped: 0 });
  const notRun = suites.filter((s) => s.notRun);
  const ok = total.failed === 0 && notRun.length === 0 && suites.every((s) => s.tests > 0) && leftover.orphans.length === 0;
  const result = { generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, ok, total, suites, orphanCheck: { checked: leftover.checked, orphans: leftover.orphans } };
  const file = path.join(ROOT, 'artifacts', 'reports', 'test_results.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`\nTOTAL: ${total.passed}/${total.tests} passed, ${total.failed} failed, ${total.skipped} skipped${notRun.length ? ` — ${notRun.length} suite(s) NOT RUN` : ''}`);
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  console.log(`Report: ${file}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err.stack || String(err)); process.exit(2); });
