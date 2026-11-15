'use strict';
/**
 * AVP-04: avatar smoke test — the real Ditto avatar service without the rest of the app.
 *
 *   node scripts/avatar_smoke.js [--photo P] [--wav a.wav --wav b.wav] [--idle 6] [--record DIR]
 *
 * Starts the service with the configured (or given) photo, lets the face idle, then plays
 * each WAV (16-bit PCM) as one answer through the same path the app uses (playSpeech), and
 * reports: load time, render FPS, buffer, latency from "speech handed over" to "speech heard",
 * frames repeated/dropped, GPU memory. With --record the service writes what it SHOWED and
 * PLAYED (DIR/avatar_<n>_video.mp4 + _audio.wav) for an objective lip-sync check.
 * Writes artifacts/reports/avatar_smoke.json. The audio is played on the configured output.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ConfigStore } = require('../core/config/configStore');
const { DittoAvatarEngine } = require('../core/avatar/dittoEngine');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function args() {
  const a = { wav: [], idle: 6, record: '' };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '--photo') a.photo = v[++i];
    else if (v[i] === '--wav') a.wav.push(v[++i]);
    else if (v[i] === '--idle') a.idle = Number(v[++i]);
    else if (v[i] === '--record') a.record = v[++i];
  }
  return a;
}

function gpuUsedMb() {
  try {
    return Number(execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).trim().split(/\s+/)[0]);
  } catch { return null; }
}

async function main() {
  const a = args();
  const store = new ConfigStore({ defaultPath: path.join(ROOT, 'config', 'default.json'), userPath: path.join(ROOT, 'config', 'user.json') });
  const cfg = store.get();
  const photo = path.resolve(a.photo || cfg.avatar.photo || '');
  if (!fs.existsSync(photo)) throw new Error(`photo not found: ${photo}`);
  const report = { startedAt: new Date().toISOString(), photo, gpuBeforeMb: gpuUsedMb(), answers: [] };
  const engine = new DittoAvatarEngine({ rootDir: ROOT, getConfig: () => store.get(), log: { info: (s, m) => console.log(`  [${s}] ${m}`), warn: (s, m) => console.log(`  [${s}] ${m}`), error: (s, m) => console.log(`  [${s}] ERROR ${m}`) } });
  const events = [];
  engine.on('speechStarted', (e) => events.push({ ev: 'started', t: Date.now(), ...e }));
  engine.on('speechEnded', (e) => events.push({ ev: 'ended', t: Date.now(), ...e }));
  let levels = 0;
  engine.on('level', () => { levels += 1; });
  const errLog = fs.createWriteStream(path.join(ROOT, 'artifacts', 'logs', 'avatar_service.log'));
  // the service's stderr (Python log) and protocol events, for diagnosis
  engine.client.on('stderr', (l) => errLog.write(`${l}\n`));
  engine.client.on('event', (e) => { if (e.event !== 'level') errLog.write(`EVENT ${JSON.stringify(e).slice(0, 300)}\n`); });

  console.log('AI Voice Photo — avatar smoke test (Ditto)');
  const t0 = Date.now();
  engine.setPhoto(photo);
  await engine.start();
  while (!(engine.info().state === 'ready' && engine.info().animating)) {
    if (engine.info().state === 'error') throw new Error(engine.info().detail);
    if (Date.now() - t0 > 600000) throw new Error('avatar not ready in 10 min');
    await sleep(200);
  }
  report.readyS = Math.round((Date.now() - t0) / 100) / 10;
  console.log(`  ready in ${report.readyS} s, stream ${engine.info().streamUrl}`);
  await sleep(a.idle * 1000);
  report.idle = await engine.getStats();
  report.gpuIdleMb = gpuUsedMb();
  console.log(`  idle: ${report.idle.renderFps} fps, buffer ${report.idle.bufferMs} ms, slack ${report.idle.slackMs} ms, repeated ${report.idle.framesRepeated}`);

  let n = 0;
  for (const wavPath of a.wav) {
    n += 1;
    const wav = fs.readFileSync(wavPath);
    if (a.record) { fs.mkdirSync(a.record, { recursive: true }); await engine.record('start'); }
    const turnId = `smoke${n}`;
    const tHand = Date.now();
    engine.playSpeech({ turnId, seq: 0, wav });
    while (!events.some((e) => e.ev === 'ended' && e.turnId === turnId)) {
      if (Date.now() - tHand > 120000) throw new Error('speech did not end');
      await sleep(50);
    }
    await sleep(1500);   // a little silence after the answer, also recorded
    const st = await engine.getStats();
    const started = events.find((e) => e.ev === 'started' && e.turnId === turnId);
    const ended = events.find((e) => e.ev === 'ended' && e.turnId === turnId);
    const rss = (() => { try { return Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${engine.client.servicePid}).WorkingSet64`], { encoding: 'utf8' }).trim()) / 1048576; } catch { return null; } })();
    const rec = { serviceRssMb: rss ? Math.round(rss) : null, wav: path.basename(wavPath), handOverToHeardMs: started ? started.t - tHand : null, serviceDelayMs: started && started.timings ? started.timings.delayMs : null,
      endReason: ended.reason, playedMs: ended.playedMs, outputLatencyMs: ended.tailMs, stats: st, gpuMb: gpuUsedMb() };
    if (a.record) rec.recording = (await engine.record('stop', path.join(a.record, `avatar_${n}`))).result;
    report.answers.push(rec);
    console.log(`  answer ${n} (${rec.wav}): heard ${rec.handOverToHeardMs} ms after hand-over, render ${st.renderFps} fps, slack ${st.slackMs} ms, repeated ${st.framesRepeated}, dropped ${st.framesDropped}, out latency ${rec.outputLatencyMs} ms, GPU ${rec.gpuMb} MB, RAM ${rec.serviceRssMb} MB`);
  }
  report.levelEvents = levels;
  report.final = await engine.getStats();
  await engine.stop();
  report.gpuAfterStopMb = gpuUsedMb();
  const out = path.join(ROOT, 'artifacts', 'reports', 'avatar_smoke.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`  GPU memory: before ${report.gpuBeforeMb} MB, idle ${report.gpuIdleMb} MB, after stop ${report.gpuAfterStopMb} MB`);
  console.log(`Report: ${out}`);
}

main().catch((err) => { console.error(`FAIL: ${err.message}`); process.exit(1); });
