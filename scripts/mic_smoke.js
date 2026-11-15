'use strict';
/**
 * Direct microphone smoke test (mic_smoke.bat / npm run mic-smoke).
 *
 * Takes the microphone, host API, VAD and STT settings from the application
 * configuration and runs services/voice_service/mic_smoke.py with them: the
 * same device opened the same way, the real Silero VAD, the real
 * faster-whisper model. Does not start the app, the LLM or TTS, and changes
 * no setting. Close the application first (one microphone owner at a time).
 *
 *   node scripts/mic_smoke.js [--seconds 15] [--device "name of another input"] [--no-scan]
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
    '-u', '-m', 'services.voice_service.mic_smoke',
    '--input-device', cfg.audio.inputDevice || '',
    '--host-api', cfg.audio.hostApi,
    '--stt-model', cfg.stt.model,
    '--stt-device', cfg.stt.device,
    '--compute-type', cfg.stt.computeType,
    '--beam-size', String(cfg.stt.beamSize),
    '--language', lang.stt.language,
    '--models-dir', 'models',
    '--vad-threshold', String(cfg.vad.threshold),
    '--min-speech-ms', String(cfg.vad.minSpeechMs),
    '--min-silence-ms', String(cfg.vad.minSilenceMs),
    '--speech-pad-ms', String(cfg.vad.speechPadMs),
    '--max-utterance-sec', String(cfg.vad.maxUtteranceSec),
    ...process.argv.slice(2),
  ];
  console.log('AI Voice Photo — microphone smoke test (real microphone, real VAD, real Whisper)');
  console.log(`Configured microphone: ${cfg.audio.inputDevice || '(empty = default input device)'}; host API setting: ${cfg.audio.hostApi}`);
  console.log(`STT: faster-whisper ${cfg.stt.model} on ${cfg.stt.device} (${cfg.stt.computeType}), language ${lang.stt.language}\n`);
  const r = await run(py, args, { echo: true, env: { PYTHONIOENCODING: 'utf-8' }, log: { line: console.log, raw: (t) => process.stdout.write(t), quiet() {} } });
  process.exit(r.code === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err.stack || String(err)); process.exit(2); });
