'use strict';
/**
 * Voice selection smoke test (voice_smoke.bat / npm run voice-smoke), VC-M1.2.
 *
 * 1. Reads the speaker list out of the installed Silero model FILE (no model
 *    load): services/voice_service/model_speakers.py.
 * 2. Loads the real model once and lets EVERY speaker say the preview
 *    sentence: services/voice_service/voice_smoke.py. Checks that the audio is
 *    real, that the speakers differ, that an unknown voice is refused and that
 *    a voice change needs no reload.
 *
 * Does not start the application, the voice service, STT or the LLM.
 *
 *   node scripts/voice_smoke.js [--play] [--record] [--text "..."]
 *
 *   --play     also play every voice through the configured audio output
 *   --record   write the result into artifacts/reports/VC_M1_2_VOICE_VALIDATION.json
 *
 * Developer options (used where the real model cannot be loaded):
 *   --inspect-only            step 1 only
 *   --python <exe>            Python to use instead of the project environment
 *   --model <file>            model file to inspect instead of models/silero/<id>.pt
 *   --where <text>            where this runs (recorded)
 *   --blocked-reason <text>   why there is no real synthesis (recorded with --inspect-only)
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { ROOT, venvPython, run } = require('./lib/proc');
const { ConfigStore } = require('../core/config/configStore');
const { resolveLanguageProfile, LANGUAGES } = require('../core/language/languages');
const { buildVoiceValidation, describeVoiceValidation } = require('./lib/voiceValidation');

const REPORT = path.join(ROOT, 'artifacts', 'reports', 'voice_smoke.json');
const RECORD = path.join(ROOT, 'artifacts', 'reports', 'VC_M1_2_VOICE_VALIDATION.json');

function parseArgs(argv) {
  const out = { play: false, record: false, inspectOnly: false, python: null, model: null, where: null, blocked: null, text: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--play') out.play = true;
    else if (a === '--record') out.record = true;
    else if (a === '--inspect-only') out.inspectOnly = true;
    else if (a === '--python') out.python = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--where') out.where = argv[++i];
    else if (a === '--blocked-reason') out.blocked = argv[++i];
    else if (a === '--text') out.text = argv[++i];
    else { console.log(`Unknown option ${a}`); process.exit(2); }
  }
  return out;
}

const quiet = { line() {}, raw() {}, quiet() {} };
const loud = { line: console.log, raw: (t) => process.stdout.write(t), quiet() {} };

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const py = opts.python || venvPython();
  if (!opts.python && !fs.existsSync(py)) {
    console.log(`Python environment not found (${py}). Run setup.bat first.`);
    process.exit(2);
  }
  const cfg = new ConfigStore({ defaultPath: path.join(ROOT, 'config', 'default.json'), userPath: path.join(ROOT, 'config', 'user.json') }).get();
  const lang = resolveLanguageProfile(cfg);
  const pack = LANGUAGES[lang.code];
  const ttsPack = pack.tts[lang.tts.provider];
  const offered = ttsPack.voices.map((v) => v.id);
  const where = opts.where || `${os.hostname()} (${process.platform})`;
  const modelFile = opts.model || path.join(ROOT, 'models', 'silero', `${lang.tts.modelId}.pt`);

  console.log('AI Voice Photo — voice selection smoke test');
  console.log(`Configured: Silero ${lang.tts.modelId}, language ${lang.code} (${lang.name}), device ${cfg.tts.device}`);
  console.log(`The application offers: ${offered.join(', ')} (default ${ttsPack.defaultVoice})\n`);

  // 1. the model file itself
  console.log(`1. Speakers stored in the model file ${modelFile}`);
  let inspection;
  if (!fs.existsSync(modelFile)) {
    inspection = { error: `model file not found: ${modelFile} (it is downloaded by setup.bat or on first start)` };
  } else {
    const r = await run(py, ['-u', path.join('services', 'voice_service', 'model_speakers.py'), modelFile, '--json'], { echo: false, env: { PYTHONIOENCODING: 'utf-8' }, log: quiet });
    // the tool prints one JSON document; anything Python itself adds around it (a warning on stderr) is not part of it
    const text = String(r.output || '');
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    try { inspection = JSON.parse(json); } catch { inspection = { error: (text || `exit code ${r.code}`).trim().slice(0, 400) }; }
    if (!inspection.error && !Array.isArray(inspection.speakers)) inspection = { ...inspection, error: 'the model file contains no speaker table' };
  }
  console.log(inspection.error ? `   could not be read: ${inspection.error}` : `   ${inspection.speakers.join(', ')}  (sha256 ${inspection.file.sha256})`);

  // 2. the loaded model
  let smoke = null;
  let code = 0;
  if (!opts.inspectOnly) {
    console.log('\n2. Real synthesis with every speaker');
    try { fs.rmSync(REPORT, { force: true }); } catch { /* ignore */ }
    const args = [
      '-u', '-m', 'services.voice_service.voice_smoke',
      '--model-id', lang.tts.modelId,
      '--default-voice', ttsPack.defaultVoice,
      '--expected', offered.join(','),
      '--language', lang.tts.language,
      '--device', cfg.tts.device,
      '--threads', String(cfg.tts.threads),
      '--sample-rate', String(cfg.tts.sampleRate),
      '--models-dir', 'models',
      '--host-api', cfg.audio.hostApi,
      '--text', opts.text || ttsPack.previewText,
      '--report', REPORT,
      ...(cfg.audio.outputDevice ? ['--output-device', cfg.audio.outputDevice] : []),
      ...(opts.play ? ['--play'] : []),
    ];
    const r = await run(py, args, { echo: true, env: { PYTHONIOENCODING: 'utf-8' }, log: loud });
    code = r.code === 0 ? 0 : 1;
    try { smoke = JSON.parse(fs.readFileSync(REPORT, 'utf8')); } catch { smoke = { ok: false, error: `voice_smoke.py produced no report (exit code ${r.code})`, checks: [], speakers: [], voices: {} }; }
  }

  const record = buildVoiceValidation({
    pack, provider: lang.tts.provider, inspection, inspectionWhere: where, smoke, smokeWhere: smoke ? where : null,
    blocked: opts.blocked || 'REAL_SYNTHESIS_NOT_RUN',
  });
  console.log(`\n${describeVoiceValidation(record)}`);
  if (opts.record) {
    fs.mkdirSync(path.dirname(RECORD), { recursive: true });
    fs.writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`\nRecorded: ${RECORD}`);
  } else if (!opts.inspectOnly) {
    console.log('\nNot recorded (run with --record to write artifacts/reports/VC_M1_2_VOICE_VALIDATION.json).');
  }
  const inspectionOk = record.modelFileInspection.status === 'PASS';
  process.exit(opts.inspectOnly ? (inspectionOk ? 0 : 1) : (code === 0 && inspectionOk && record.realSynthesis.status === 'PASS' ? 0 : 1));
}

main().catch((err) => { console.error(err.stack || String(err)); process.exit(2); });
