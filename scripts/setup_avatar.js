'use strict';
/**
 * AVP-04: one-time setup of the Ditto photo animation (run through setup_avatar.bat).
 *
 *   node scripts/setup_avatar.js [--python <path>] [--models-from <dir>] [--skip-models]
 *
 * 1. creates .venv_avatar (Python 3.10, separate from the voice service's .venv),
 * 2. installs PyTorch 2.7.1 (CUDA 12.8: RTX 50 / Blackwell) and services/avatar_requirements.txt
 *    (ONNX Runtime GPU, TensorRT 10, MediaPipe, …),
 * 3. downloads the Ditto weights (digital-avatar/ditto-talkinghead: PyTorch models, configs, the
 *    LMDM and decoder ONNX graphs) into models/ditto — or copies them from --models-from,
 * 4. checks that the GPU is visible from the new environment.
 * The TensorRT engines for this GPU are built on the first start of the avatar (1–2 min) and cached
 * in models/ditto/trt_cache. Nothing outside the project folder is changed. Log: artifacts/logs/setup_avatar.log
 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, IS_WIN, makeLogger, run, probe } = require('./lib/proc');

const VENV = path.join(ROOT, '.venv_avatar');
const PY = IS_WIN ? path.join(VENV, 'Scripts', 'python.exe') : path.join(VENV, 'bin', 'python');
const MODELS = path.join(ROOT, 'models', 'ditto');
const HF_REPO = 'digital-avatar/ditto-talkinghead';
const HF_FILES = ['ditto_pytorch/*', 'ditto_cfg/*', 'ditto_onnx/decoder.onnx', 'ditto_onnx/lmdm_v0.4_hubert.onnx', 'LICENSE', 'README.md'];
const log = makeLogger(path.join(ROOT, 'artifacts', 'logs', 'setup_avatar.log'));
const opt = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const flag = (name) => process.argv.includes(name);

function fail(msg) { log.line(`FAILED: ${msg}`); process.exit(1); }

function findPython310() {
  const explicit = opt('--python');
  const candidates = explicit ? [explicit] : (IS_WIN ? ['python3.10', 'py'] : ['python3.10']);
  for (const c of candidates) {
    const args = c === 'py' ? ['-3.10', '-c'] : ['-c'];
    const out = probe(c, [...args, 'import sys,struct;print(sys.version_info[:2], struct.calcsize("P")*8, sys.executable)']);
    if (out && /\(3, 10\) 64/.test(out)) return out.trim().split(' ').slice(-1)[0];
  }
  return null;
}

async function step(title, fn) {
  log.line(`\n== ${title}`);
  const r = await fn();
  if (r && r.code !== undefined && r.code !== 0) fail(`${title} (exit ${r.code})`);
}

async function main() {
  log.line('AI Voice Photo — avatar (Ditto) setup');
  if (!fs.existsSync(PY)) {
    const base = findPython310();
    if (!base) fail('Python 3.10 (64-bit) not found: install it from python.org or pass --python <path-to-python.exe>');
    await step(`Create .venv_avatar with ${base}`, () => run(base, ['-m', 'venv', VENV], { log }));
  } else {
    log.line('.venv_avatar exists: reusing it');
  }
  await step('Upgrade pip', () => run(PY, ['-m', 'pip', 'install', '--upgrade', 'pip'], { log }));
  await step('PyTorch 2.7.1 for CUDA 12.8', () => run(PY, ['-m', 'pip', 'install', 'torch==2.7.1', 'torchvision==0.22.1', 'torchaudio==2.7.1',
    '--index-url', 'https://download.pytorch.org/whl/cu128'], { log }));
  await step('Avatar requirements', () => run(PY, ['-m', 'pip', 'install', '-r', path.join('services', 'avatar_requirements.txt')], { log }));

  if (!flag('--skip-models')) {
    const from = opt('--models-from');
    if (from) {
      await step(`Copy Ditto models from ${from}`, async () => {
        for (const sub of ['ditto_pytorch', 'ditto_cfg']) fs.cpSync(path.join(from, sub), path.join(MODELS, sub), { recursive: true });
        fs.mkdirSync(path.join(MODELS, 'ditto_onnx'), { recursive: true });
        for (const f of ['decoder.onnx', 'lmdm_v0.4_hubert.onnx']) fs.copyFileSync(path.join(from, 'ditto_onnx', f), path.join(MODELS, 'ditto_onnx', f));
        return { code: 0 };
      });
    } else {
      const code = `from huggingface_hub import snapshot_download as d; d(${JSON.stringify(HF_REPO)}, local_dir=${JSON.stringify(MODELS)}, allow_patterns=${JSON.stringify(HF_FILES)})`;
      await step(`Download Ditto weights (${HF_REPO}, ~2.8 GB)`, () => run(PY, ['-c', code], { log }));
    }
  }
  await step('GPU check', () => run(PY, ['-c', 'import torch,onnxruntime as o,tensorrt as t;print("torch",torch.__version__,"cuda",torch.cuda.is_available(),torch.cuda.get_device_name(0) if torch.cuda.is_available() else "-","| onnxruntime",o.__version__,o.get_available_providers(),"| tensorrt",t.__version__)'], { log }));
  log.line('\nDone. Start the app: the first start of the avatar builds TensorRT engines for this GPU (1–2 min).');
}

main().catch((err) => fail(err.stack || String(err)));
