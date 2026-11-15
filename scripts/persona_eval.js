'use strict';
/**
 * Persona switching evaluation against the real LM Studio
 * (persona_eval.bat / npm run persona-eval). VC-M1.2.
 *
 * Plays the same neutral lines to the built-in profile and to two temporary
 * characters, each made the active character profile through the
 * application's own profile operations, prompt builder, session history and
 * LLM provider. No voice service, no TTS, no Electron. The temporary
 * characters live in memory only: config/user.json is read, never written.
 *
 * Writes artifacts/reports/persona_eval.json (a working report, replaced by
 * every run). With --record it also replaces the recorded evidence of the
 * stage, artifacts/reports/VC_M1_2_PERSONA_EVALUATION.json.
 *
 *   node scripts/persona_eval.js [--runs N] [--record]
 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./lib/proc');
const { ConfigStore } = require('../core/config/configStore');
const { runPersonaEval } = require('./lib/personaEval');

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const store = new ConfigStore({ defaultPath: path.join(ROOT, 'config', 'default.json'), userPath: path.join(ROOT, 'config', 'user.json') });
  const runs = Math.max(1, Math.min(20, Math.round(Number(argValue('--runs', 3))) || 3));
  console.log('AI Voice Photo — persona switching evaluation (real LM Studio, no voice)\n');
  const report = await runPersonaEval({ config: store.get(), defaults: store.defaults, runs });
  report.transport = 'Node.js on this computer (persona_eval.bat)';

  const dir = path.join(ROOT, 'artifacts', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const files = [path.join(dir, 'persona_eval.json')];
  if (process.argv.includes('--record')) files.push(path.join(dir, 'VC_M1_2_PERSONA_EVALUATION.json'));
  console.log('');
  for (const file of files) {
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Report: ${file}`);
  }
  console.log(report.ok
    ? 'EVALUATION COMPLETED. The verdict covers the name and the form of address only; how a character feels is judged in the manual acceptance (docs/legacy/VC_M1_2_CHARACTER_PROFILES_VOICE.md).'
    : `EVALUATION INCOMPLETE: ${report.error || 'not every request was answered'}.`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => { console.error(err.stack || String(err)); process.exit(2); });
