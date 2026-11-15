'use strict';
/**
 * Direct TTS smoke test (tts_smoke.bat / npm run tts-smoke).
 *
 * Takes model, voice, device and output device from the application
 * configuration (through the same language profile the app uses) and runs
 * services/voice_service/tts_smoke.py with them: real model, real synthesis,
 * real audio. Does not start the app, the voice service, STT or the LLM.
 *
 *   node scripts/tts_smoke.js [--no-play] [--no-tls-check] [--text "..."]
 */
const path = require('node:path');
const fs = require('node:fs');
const { ROOT, venvPython, run } = require('./lib/proc');
const { ConfigStore } = require('../core/config/configStore');
const { resolveLanguageProfile } = require('../core/language/languages');

async function main() {
  const py = venvPython();
  if (!fs.existsSync(py)) {
    console.log(`Python environment not found (${py}). Run setup.bat first.`);
    process.exit(2);
  }
  const cfg = new ConfigStore({ defaultPath: path.join(ROOT, 'config', 'default.json'), userPath: path.join(ROOT, 'config', 'user.json') }).get();
  const lang = resolveLanguageProfile(cfg);
  const args = [
    '-u', '-m', 'services.voice_service.tts_smoke',
    '--model-id', lang.tts.modelId,
    '--voice', lang.tts.voice,
    '--language', lang.tts.language,
    '--device', cfg.tts.device,
    '--threads', String(cfg.tts.threads),
    '--sample-rate', String(cfg.tts.sampleRate),
    '--models-dir', 'models',
    '--host-api', cfg.audio.hostApi,
    ...(cfg.audio.outputDevice ? ['--output-device', cfg.audio.outputDevice] : []),
    ...process.argv.slice(2),
  ];
  console.log('AI Voice Photo — TTS smoke test');
  console.log(`Configured: Silero ${lang.tts.modelId}, voice ${lang.tts.voice}, language ${lang.code} (${lang.name}), device ${cfg.tts.device}\n`);
  const r = await run(py, args, { echo: true, env: { PYTHONIOENCODING: 'utf-8' }, log: { line: console.log, raw: (t) => process.stdout.write(t), quiet() {} } });
  process.exit(r.code === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err.stack || String(err)); process.exit(2); });
