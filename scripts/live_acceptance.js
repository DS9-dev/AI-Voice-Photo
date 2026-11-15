'use strict';
/**
 * VC-M0 live acceptance on the real hardware (run through acceptance.bat).
 *
 *   node scripts/live_acceptance.js [--tests B,C,D,F,G,A,E,L] [--no-compare-stt] [--no-gui]
 *                                   [--stt-utterances 3] [--turns 5]
 *
 * Uses the same Core as the Electron app, with the REAL voice service and the
 * REAL LM Studio. Close the Electron app first (one microphone owner at a time).
 * Writes artifacts/reports/live_acceptance_<time>.json and ..._latest.json,
 * (the VaMVoiceCompanion milestone report generators were not carried over).
 */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { ROOT, run } = require('./lib/proc');
const { createCompanion } = require('../core');
const { runAcceptance, ALL_TESTS } = require('./lib/acceptance');

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };

/**
 * Everything the run prints, and every Core event-log entry, also goes to
 * artifacts/logs/acceptance.log as it happens, so a run that is interrupted
 * still leaves a complete trace.
 */
function makeTranscript() {
  const file = path.join(ROOT, 'artifacts', 'logs', 'acceptance.log');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `--- live acceptance started ${new Date().toISOString()} ---\n`);
  } catch { return { file: null, write() {} }; }
  return { file, write(text) { try { fs.appendFileSync(file, text + '\n'); } catch { /* ignore */ } } };
}

function makeIo(transcript, onInterrupt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', onInterrupt);
  const question = (q) => new Promise((resolve) => rl.question(q, (a) => { transcript.write(`${q} ${a}`); resolve(a); }));
  const say = (text) => { console.log(text); transcript.write(text); };
  return {
    say,
    async ask(q) {
      for (;;) {
        const a = (await question(`  ? ${q} `)).trim().toLowerCase();
        if (['y', 'yes', 'д', 'да'].includes(a)) return 'y';
        if (['n', 'no', 'н', 'нет'].includes(a)) return 'n';
        say('    please answer y or n');
      }
    },
    async pause(text) { await question(`${text} `); },
    close: () => rl.close(),
  };
}

/** Launch the real Electron app in self-test mode and read its report. */
async function guiSelfTest() {
  const file = path.join(ROOT, 'artifacts', 'reports', 'gui_selftest.json');
  try { fs.unlinkSync(file); } catch { /* none yet */ }
  let electronPath;
  try {
    electronPath = require('electron'); // from Node this is the path of the Electron executable
  } catch {
    return { ok: false, checks: [], error: 'Electron is not installed (run setup.bat)' };
  }
  // windowsHide:false — the self-test checks that the window is really visible
  const r = await run(electronPath, ['.', '--self-test'], { echo: false, windowsHide: false });
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, checks: [], error: `Electron exited with code ${r.code} without writing a self-test report. Output: ${r.output.slice(-800)}` };
  }
}

async function main() {
  const tests = (option('--tests') || ALL_TESTS.join(',')).split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  console.log('AI Voice Photo — VC-M0 live acceptance');
  console.log(`Tests: ${tests.join(', ')}`);
  console.log('Requirements: LM Studio local server running with Qwen 3.5 9B loaded; microphone and speakers connected;');
  console.log('              the Electron app is closed. You will be asked a few y/n questions about what you hear.\n');

  const dir = path.join(ROOT, 'artifacts', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const transcript = makeTranscript();
  const companion = createCompanion({ rootDir: ROOT });
  companion.log.on('entry', (e) => transcript.write(`    [core ${e.level} ${e.source}] ${e.message}`));

  // Ctrl+C: stop the voice service, keep what was measured so far, say so.
  let progress = null;
  let interrupted = false;
  const onInterrupt = () => {
    if (interrupted) return;
    interrupted = true;
    console.log('\nInterrupted. Stopping the voice service…');
    transcript.write('--- interrupted by the user (Ctrl+C) ---');
    if (progress) {
      try { fs.writeFileSync(path.join(dir, 'live_acceptance_interrupted.json'), JSON.stringify({ ...progress, interrupted: true, finishedAt: new Date().toISOString() }, null, 2)); } catch { /* ignore */ }
    }
    companion.shutdown().catch(() => {}).finally(() => {
      console.log(`Not a result: the run was interrupted. Trace: ${transcript.file || '(not written)'}`);
      process.exit(130);
    });
  };
  process.on('SIGINT', onInterrupt);

  const io = makeIo(transcript, onInterrupt);
  let report;
  try {
    report = await runAcceptance({
      companion,
      io,
      evidence: 'live',
      options: {
        tests,
        interactive: true,
        onProgress: (r) => { progress = r; },
        compareStt: !args.includes('--no-compare-stt'),
        sttUtterances: Number(option('--stt-utterances') || 3),
        conversationTurns: Number(option('--turns') || 5),
        guiSelfTest: args.includes('--no-gui') ? null : guiSelfTest,
      },
    });
  } finally {
    io.close();
    await companion.shutdown().catch(() => {});
  }

  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const file = path.join(dir, `live_acceptance_${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  const partial = tests.length < ALL_TESTS.length;
  if (!partial) fs.writeFileSync(path.join(dir, 'live_acceptance_latest.json'), JSON.stringify(report, null, 2));

  console.log('\n================ RESULT ================');
  console.log(`  GUI   : ${report.gui.status.padEnd(8)} Electron application launches and renders`);
  for (const [id, t] of Object.entries(report.tests)) console.log(`  Test ${id}: ${t.status.padEnd(8)} ${t.name}`);
  const full = report.summary.full.intervals.perceivedLatencyMs;
  if (full.n) console.log(`  Speech end → first audible answer: median ${Math.round(full.median)} ms (min ${Math.round(full.min)}, max ${Math.round(full.max)}, n=${full.n})`);
  console.log(`  Functional: ${report.overall.functional}   Performance: ${report.overall.performance}`);
  const cs = report.cleanShutdown;
  console.log(`  Voice service stopped cleanly: ${cs.stillRunning ? 'NO (still running!)' : 'yes'} (service pid ${cs.voiceServicePid}, started pid ${cs.startedProcessPid}, ${cs.relation})`);
  console.log(`  Report: ${file}`);
  if (transcript.file) console.log(`  Trace : ${transcript.file}`);
  if (partial) console.log('  (partial run: not stored as the latest full acceptance result)');
  process.exit(report.overall.functional === 'PASS' ? 0 : 1);
}

main().catch((err) => { console.error(`Acceptance run crashed: ${err.stack || err}`); process.exit(2); });
