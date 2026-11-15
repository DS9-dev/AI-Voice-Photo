'use strict';
/**
 * Environment check (npm run doctor). Reports what is installed and whether
 * LM Studio is reachable. Writes artifacts/reports/doctor.json.
 * Exit code 0 = everything needed for the full pipeline looks usable.
 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, IS_WIN, venvPython, run, probe } = require('./lib/proc');
const { ConfigStore } = require('../core/config/configStore');
const { LMStudioProvider } = require('../core/providers/lmStudioProvider');

async function main() {
  const report = { generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, problems: [], warnings: [] };
  const py = venvPython();

  // --- Python side -------------------------------------------------------
  if (!fs.existsSync(py)) {
    report.problems.push(`Python environment missing (${py}). Run setup.bat.`);
  } else {
    const r = await run(py, ['-m', 'services.voice_service.doctor', '--models-dir', 'models'], { echo: false, env: { PYTHONIOENCODING: 'utf-8' } });
    const start = r.output.indexOf('{');
    try {
      report.python = JSON.parse(r.output.slice(start, r.output.lastIndexOf('}') + 1));
    } catch {
      report.problems.push(`Python environment check failed: ${r.output.slice(-600)}`);
    }
  }
  const p = report.python;
  if (p) {
    for (const [name, info] of Object.entries(p.packages)) {
      if (!info.ok) report.problems.push(`Python package ${name}: ${info.error}`);
    }
    if (!p.torch.cuda_available) report.warnings.push('torch reports no CUDA device (TTS will use CPU, which is the default anyway).');
    else if (p.torch.cuda_smoke_test !== 'ok') report.warnings.push(`torch CUDA smoke test: ${p.torch.cuda_smoke_test}`);
    if (p.ctranslate2.error) report.problems.push(`CTranslate2 / faster-whisper: ${p.ctranslate2.error}`);
    else if (!p.ctranslate2.cuda_device_count) report.warnings.push('CTranslate2 sees no CUDA device: STT will fall back to CPU (slower).');
    if (!p.silero_vad_onnx.ok) report.problems.push(`Silero VAD: ${p.silero_vad_onnx.error}`);
    if (p.audio.error) report.problems.push(`Audio devices: ${p.audio.error}`);
    else {
      if (!p.audio.inputs.length) report.problems.push('No microphone (audio input device) found.');
      if (!p.audio.outputs.length) report.problems.push('No audio output device found.');
    }
    if (!p.models.silero_tts_files.length) report.warnings.push('Silero TTS model not downloaded yet (it will download on first start).');
    if (!p.models.whisper_cache_entries.length) report.warnings.push('Whisper model not downloaded yet (it will download on first start).');
  }

  // --- Electron ----------------------------------------------------------
  report.electronInstalled = fs.existsSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'));
  if (!report.electronInstalled) report.problems.push('Electron is not installed (run setup.bat or npm install).');

  // --- LM Studio ---------------------------------------------------------
  const config = new ConfigStore({ defaultPath: path.join(ROOT, 'config', 'default.json'), userPath: path.join(ROOT, 'config', 'user.json') });
  const llm = new LMStudioProvider({ getConfig: () => config.get().llm });
  const conn = await llm.checkConnectivity();
  report.lmStudio = { endpoint: conn.endpoint, ok: conn.ok, selectedModel: conn.selectedModel, selectedReason: conn.selectedReason, error: conn.error, models: conn.models };
  if (!conn.ok) report.warnings.push(`LM Studio: ${conn.error} (start the LM Studio local server and load Qwen 3.5 9B).`);

  // --- stray helper processes -------------------------------------------
  if (IS_WIN) {
    const out = probe('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*services.*_service*--app=ai-voice-photo*' -and $_.Name -like 'python*' } | ForEach-Object { $_.ProcessId }"]);
    report.voiceServiceProcesses = out ? out.split(/\s+/).filter(Boolean).map(Number) : [];
  }

  const file = path.join(ROOT, 'artifacts', 'reports', 'doctor.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2));

  // --- console summary ---------------------------------------------------
  const line = (k, v) => console.log(`  ${k.padEnd(22)} ${v}`);
  console.log('Environment check');
  line('Node', process.version);
  if (p) {
    line('Python', `${p.python} (${p.executable})`);
    line('torch', p.packages.torch.ok ? `${p.packages.torch.version}, CUDA ${p.torch.cuda_available ? `yes (${p.torch.device_name})` : 'no'}` : 'MISSING');
    line('faster-whisper', p.packages.faster_whisper && p.packages.faster_whisper.ok ? `${p.packages.faster_whisper.version}, CTranslate2 ${p.ctranslate2.version}, CUDA devices: ${p.ctranslate2.cuda_device_count}` : 'MISSING');
    line('Silero VAD', p.silero_vad_onnx.ok ? 'ok' : 'MISSING');
    line('Microphones', p.audio.error ? 'ERROR' : String(p.audio.inputs.length));
    line('Outputs', p.audio.error ? 'ERROR' : String(p.audio.outputs.length));
    line('Models on disk', `whisper: ${p.models.whisper_cache_entries.length} entr., silero: ${p.models.silero_tts_files.join(', ') || 'none'}`);
    if (Array.isArray(p.gpu) && p.gpu[0]) line('GPU', `${p.gpu[0].name}: ${p.gpu[0].memory_used_mb}/${p.gpu[0].memory_total_mb} MB VRAM in use`);
  }
  line('Electron', report.electronInstalled ? 'installed' : 'MISSING');
  line('LM Studio', conn.ok ? `ok — ${conn.selectedModel} (${conn.selectedReason})` : `NOT READY — ${conn.error}`);
  if (report.voiceServiceProcesses && report.voiceServiceProcesses.length) line('Voice service PIDs', report.voiceServiceProcesses.join(', '));
  for (const w of report.warnings) console.log(`  WARNING: ${w}`);
  for (const pr of report.problems) console.log(`  PROBLEM: ${pr}`);
  console.log(`  Report: ${file}`);
  process.exit(report.problems.length ? 1 : 0);
}

main().catch((err) => { console.error(err.stack || String(err)); process.exit(2); });
