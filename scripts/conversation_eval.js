'use strict';
/**
 * Natural-conversation evaluation against the real LM Studio
 * (conversation_eval.bat / npm run conversation-eval). VC-M1.1.
 *
 * The application's own configuration, system prompt, session history and LLM
 * provider; no voice service, no TTS, no Electron. Plays the fixed scenarios,
 * records every reply and what the evaluation-only detector says about it.
 * Unless --no-baseline is given, the same scenarios are also played with the
 * frozen VC-M0 system prompt (a controlled before/after on the same model).
 * Writes artifacts/reports/conversation_eval.json (a working report, replaced
 * by every run). With --record it also replaces the recorded evidence of the
 * stage, artifacts/reports/VC_M1_1_EVALUATION.json.
 *
 *   node scripts/conversation_eval.js [--runs N] [--no-baseline] [--record]
 *
 * The result is evidence for the reader, not a verdict: whether the
 * conversation feels natural is decided in the manual acceptance.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ROOT } = require('./lib/proc');
const { ConfigStore } = require('../core/config/configStore');
const { resolveLanguageProfile } = require('../core/language/languages');
const { runConversationEval } = require('./lib/conversationEval');

const BASELINE_FILE = path.join(ROOT, 'scripts', 'lib', 'baselines', 'vc_m0_system_prompt.ru.txt');
const BASELINE_PROVENANCE = 'System prompt of VC-M0 (commit c8e0bb2b8e1d75c044decc51cef84a323c9e42d2, core/language/languages.js, default persona, Russian), reconstructed from Git and stored unchanged.';
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const config = new ConfigStore({ defaultPath: path.join(ROOT, 'config', 'default.json'), userPath: path.join(ROOT, 'config', 'user.json') }).get();
  const runs = Math.max(1, Math.min(20, Math.round(Number(argValue('--runs', 3))) || 3));
  const profile = resolveLanguageProfile(config);
  console.log('AI Voice Photo — natural-conversation evaluation (real LM Studio, no voice)\n');

  let baseline = null;
  let baselineNote = null;
  if (process.argv.includes('--no-baseline')) baselineNote = 'skipped (--no-baseline)';
  else if (profile.code !== 'ru' || !profile.llm.personaIsDefault) baselineNote = 'skipped: the frozen VC-M0 prompt contains the default Russian persona, so it is only comparable while the default persona is in use';
  else baseline = { id: 'vc_m0_baseline', title: 'frozen VC-M0 system prompt (before VC-M1.1)', systemPrompt: fs.readFileSync(BASELINE_FILE, 'utf8').replace(/\r\n/g, '\n'), provenance: BASELINE_PROVENANCE };
  if (baselineNote) console.log(`Baseline: ${baselineNote}\n`);

  const report = await runConversationEval({ config, runs, baseline });
  report.transport = 'Node.js on this computer (conversation_eval.bat)';
  report.baselineNote = baselineNote;
  if (report.variants.current) report.variants.current.systemPromptSha256 = sha256(profile.llm.systemPrompt.trim());
  if (baseline && report.variants.vc_m0_baseline) report.variants.vc_m0_baseline.systemPromptSha256 = sha256(baseline.systemPrompt.trim());

  const dir = path.join(ROOT, 'artifacts', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const files = [path.join(dir, 'conversation_eval.json')];
  if (process.argv.includes('--record')) files.push(path.join(dir, 'VC_M1_1_EVALUATION.json'));
  console.log('');
  for (const file of files) {
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Report: ${file}`);
  }
  console.log(report.ok
    ? 'EVALUATION COMPLETED. The numbers above are evidence, not a verdict: naturalness is judged in the manual acceptance (docs/legacy/VC_M1_1_NATURAL_CONVERSATION.md).'
    : `EVALUATION INCOMPLETE: ${report.error || 'not every request was answered'}.`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => { console.error(err.stack || String(err)); process.exit(2); });
