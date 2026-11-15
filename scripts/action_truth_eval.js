'use strict';
/**
 * Physical-action truthfulness evaluation against the real LM Studio
 * (action_truth_eval.bat / npm run action-truth-eval). VC-M1.2.
 *
 * Asks the companion for things the application cannot do (make tea, fetch
 * wine, bring a blanket) and then goes on as if they were happening — the
 * multi-turn pattern in which she drifted into reporting actions that never
 * took place. Also plays harmless lines (company, shared imagination, a
 * hypothetical, the user's own action) to show she was not made stiff.
 * Three characters: the built-in profile and the two temporary test
 * characters of the persona evaluation; all through the application's own
 * profile operations, prompt builder, session history and LLM provider. No
 * voice service, no TTS, no Electron; config/user.json is read, never written.
 *
 * Writes artifacts/reports/action_truth_eval.json (a working report, replaced
 * by every run). The word lists in it only point at replies worth reading:
 * whether she claimed an action is decided by reading the replies.
 *
 *   node scripts/action_truth_eval.js [--runs N]
 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./lib/proc');
const { ConfigStore } = require('../core/config/configStore');
const { runActionEval } = require('./lib/actionTruthEval');

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const store = new ConfigStore({ defaultPath: path.join(ROOT, 'config', 'default.json'), userPath: path.join(ROOT, 'config', 'user.json') });
  const runs = Math.max(1, Math.min(20, Math.round(Number(argValue('--runs', 3))) || 3));
  console.log('AI Voice Photo — physical-action truthfulness evaluation (real LM Studio, no voice)\n');
  const report = await runActionEval({ config: store.get(), defaults: store.defaults, runs });
  report.transport = 'Node.js on this computer (action_truth_eval.bat)';
  const file = path.join(ROOT, 'artifacts', 'reports', 'action_truth_eval.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nReport: ${file}`);
  console.log(report.ok
    ? 'EVALUATION COMPLETED. Read the replies in the report: the counts above come from word lists and are not a verdict (docs/legacy/VC_M1_2_CHARACTER_PROFILES_VOICE.md).'
    : `EVALUATION INCOMPLETE: ${report.error || 'not every request was answered'}.`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => { console.error(err.stack || String(err)); process.exit(2); });
