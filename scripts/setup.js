'use strict';
/**
 * One-time setup for AI Voice Photo (run through setup.bat or `npm run setup`).
 *
 *   node scripts/setup.js [--python <path>] [--cpu-torch] [--skip-models] [--skip-npm]
 *
 * Creates .venv, installs Python and Node dependencies, downloads the STT/TTS
 * model files and runs the environment check. Everything is logged to
 * artifacts/logs/setup.log. Nothing outside this project folder is modified.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ROOT, IS_WIN, venvPython, makeLogger, run, probe } = require('./lib/proc');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };

const TORCH_INDEX = 'https://download.pytorch.org/whl/cu128'; // CUDA 12.8 builds: required for RTX 50-series
const PY_MIN = [3, 10];
const PY_MAX = [3, 13];
const log = makeLogger(path.join(ROOT, 'artifacts', 'logs', 'setup.log'));

function fail(message) {
  log.line('');
  log.line(`SETUP FAILED: ${message}`);
  log.line(`Full log: ${log.file}`);
  process.exit(1);
}

function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text || '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function pythonCandidates() {
  const list = [];
  const explicit = option('--python');
  if (explicit) list.push([explicit, []]);
  if (IS_WIN) {
    for (const v of ['3.12', '3.11', '3.13', '3.10']) list.push(['py', [`-${v}`]]);
    list.push(['python', []]);
    for (const dir of ['MiniConda3', 'miniconda3', 'anaconda3']) list.push([path.join(os.homedir(), dir, 'python.exe'), []]);
  } else {
    for (const v of ['3.12', '3.11', '3.13', '3.10']) list.push([`python${v}`, []]);
    list.push(['python3', []]);
  }
  return list;
}

function findPython() {
  const code = 'import sys,struct;print("%d.%d.%d %d" % (sys.version_info[0],sys.version_info[1],sys.version_info[2],struct.calcsize("P")*8))';
  for (const [cmd, pre] of pythonCandidates()) {
    const out = probe(cmd, [...pre, '-c', code]);
    if (!out) continue;
    const v = parseVersion(out);
    const bits = Number(out.split(' ')[1]);
    if (!v || bits !== 64) continue;
    const ok = (v[0] === PY_MIN[0] && v[1] >= PY_MIN[1] && v[1] <= PY_MAX[1]);
    log.line(`  found Python ${v.join('.')} (${bits}-bit) via "${[cmd, ...pre].join(' ')}"${ok ? '' : ' — unsupported version, skipping'}`);
    if (ok) return { cmd, pre, version: v.join('.') };
  }
  return null;
}

async function step(title, fn) {
  log.line('');
  log.line(`=== ${title} ===`);
  await fn();
}

async function main() {
  log.line('AI Voice Photo setup');
  log.line(`Project: ${ROOT}`);
  log.line(`Node: ${process.version}`);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) fail(`Node.js 20 or newer is required (found ${process.version}). Install the current LTS from nodejs.org.`);

  const py = venvPython();

  await step('1/6 Python virtual environment (.venv)', async () => {
    if (fs.existsSync(py)) {
      log.line(`  using existing ${py}`);
      return;
    }
    const found = findPython();
    if (!found) fail(`No 64-bit Python ${PY_MIN.join('.')}–${PY_MAX.join('.')} found. Install Python 3.12 (python.org) or pass --python <path-to-python.exe>.`);
    const r = await run(found.cmd, [...found.pre, '-m', 'venv', path.join(ROOT, '.venv')], { log });
    if (r.code !== 0 || !fs.existsSync(py)) fail('Could not create the virtual environment.');
  });

  await step('2/6 PyTorch', async () => {
    await run(py, ['-m', 'pip', 'install', '--upgrade', 'pip'], { log });
    const have = probe(py, ['-c', 'import torch;print(torch.__version__, torch.version.cuda)'], { timeoutMs: 180000 });
    if (have) {
      log.line(`  torch already installed: ${have}`);
      if (!flag('--cpu-torch') && / None$/.test(have)) {
        log.line('  NOTE: this is a CPU-only torch build. Delete .venv and re-run setup to install the CUDA build.');
      }
      return;
    }
    const pipArgs = flag('--cpu-torch')
      ? ['-m', 'pip', 'install', 'torch']
      : ['-m', 'pip', 'install', 'torch', '--index-url', TORCH_INDEX];
    log.line(flag('--cpu-torch') ? '  installing CPU-only torch' : '  installing torch with CUDA 12.8 (large download, ~3 GB)');
    const r = await run(py, pipArgs, { log });
    if (r.code !== 0) fail('PyTorch installation failed (see log). If no wheel matches your Python version, install Python 3.12 and delete .venv.');
  });

  await step('3/6 Voice service Python packages', async () => {
    const r = await run(py, ['-m', 'pip', 'install', '-r', path.join('services', 'requirements.txt')], { log });
    if (r.code !== 0) fail('pip install -r services/requirements.txt failed (see log).');
    const still = probe(py, ['-c', 'import torch;print(torch.__version__, torch.version.cuda)'], { timeoutMs: 180000 });
    log.line(`  torch after dependency install: ${still}`);
  });

  await step('4/6 Node packages (Electron)', async () => {
    if (flag('--skip-npm')) { log.line('  skipped (--skip-npm)'); return; }
    if (fs.existsSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'))) {
      log.line('  Electron already installed');
      return;
    }
    const r = await run('npm', ['install', '--no-fund', '--no-audit'], { log, shell: true });
    if (r.code !== 0) fail('npm install failed (see log).');
  });

  await step('5/6 Model files (Whisper small + base, Silero TTS)', async () => {
    if (flag('--skip-models')) { log.line('  skipped (--skip-models); models download on first start instead'); return; }
    const r = await run(py, ['-m', 'services.voice_service.prefetch', '--models-dir', 'models', '--whisper', 'small', 'base', '--tts', 'v5_5_ru'], { log });
    if (r.code !== 0) log.line('  WARNING: some model downloads failed. They will be retried on first start; check your internet connection.');
  });

  let doctorOk = true;
  await step('6/6 Environment check', async () => {
    const r = await run(process.execPath, [path.join('scripts', 'doctor.js')], { log });
    doctorOk = r.code === 0;
  });

  log.line('');
  log.line(doctorOk ? 'SETUP COMPLETE.' : 'SETUP FINISHED WITH WARNINGS (see the environment check above).');
  log.line('Next:  run_tests.bat   then   start.bat   (LM Studio server must be running with Qwen 3.5 9B loaded)');
  log.line(`Log:   ${log.file}`);
}

main().catch((err) => fail(err.stack || String(err)));
