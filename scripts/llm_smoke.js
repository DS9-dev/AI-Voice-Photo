'use strict';
/**
 * Direct LLM smoke test (llm_smoke.bat / npm run llm-smoke).
 *
 * The application's LLM provider, configuration and system prompt against
 * the real LM Studio server. Does not start the app, the voice service or
 * TTS. Writes artifacts/reports/llm_smoke.json.
 *
 *   node scripts/llm_smoke.js [--no-think-probe]
 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./lib/proc');
const { ConfigStore } = require('../core/config/configStore');
const { runLlmSmoke } = require('./lib/llmSmoke');

async function main() {
  const config = new ConfigStore({ defaultPath: path.join(ROOT, 'config', 'default.json'), userPath: path.join(ROOT, 'config', 'user.json') }).get();
  console.log('AI Voice Photo — LLM smoke test (real LM Studio, no voice)\n');
  const report = await runLlmSmoke({ config, thinkProbe: !process.argv.includes('--no-think-probe') });
  const file = path.join(ROOT, 'artifacts', 'reports', 'llm_smoke.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nReport: ${file}`);
  console.log(`RESULT: ${report.ok ? 'PASS' : 'FAIL'}`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => { console.error(err.stack || String(err)); process.exit(2); });
