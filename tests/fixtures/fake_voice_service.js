'use strict';
/**
 * FAKE voice service for automated tests of the Core and the UI.
 * Speaks the same JSON-lines protocol as services/voice_service but contains
 * no audio and no models. Results obtained with it are never live evidence.
 *
 * Test hooks (commands that do not exist in the real service):
 *   {cmd:'_sim_utterance', text, speech_ms}  pretend the user said something
 *   {cmd:'_sim_crash'}                       exit abruptly
 * Environment:
 *   FAKE_FAIL=stt,tts     components that report an error on init
 *   FAKE_SYNTH_MS / FAKE_AUDIO_MS / FAKE_STT_MS   simulated durations
 *   FAKE_NO_HELLO=1       never send hello
 *   FAKE_HIDE_PARENT=1    report no relationship to the starting process
 *   FAKE_IGNORE_SHUTDOWN=1  ignore the shutdown command and stdin EOF (stuck service)
 *   FAKE_MIC_SIGNAL=digital_silence|very_quiet|ok   what the "microphone" delivers (default ok)
 *   FAKE_MIC_STATS_MS       period of mic_stats events while listening (default 5000)
 *   FAKE_NO_RETURN=1        do not announce the tts_return feature (an older service)
 *   FAKE_STDOUT_SPLIT=N     write stdout in pieces of N bytes (frame boundaries do not match writes)
 * deliver="return" (VC-M3.2): the chunk comes back as a binary tts_audio frame
 * carrying a real 16-bit mono WAV of FAKE_AUDIO_MS (quiet tone), like the real service.
 */
const readline = require('node:readline');
const { performance } = require('node:perf_hooks');

const now = () => performance.timeOrigin + performance.now() + Number(process.env.FAKE_CLOCK_SKEW_MS || 0);
const SPLIT = Number(process.env.FAKE_STDOUT_SPLIT || 0);
function out(buf) {
  if (!SPLIT) { process.stdout.write(buf); return; }
  for (let i = 0; i < buf.length; i += SPLIT) process.stdout.write(buf.subarray(i, i + SPLIT));
}
const emit = (event, fields = {}) => out(Buffer.from(JSON.stringify({ event, ...fields }) + '\n'));
/** binary frame: "!<N> <json>\n" + N bytes, written as one unit (like Emitter.emit_binary) */
const emitBinary = (event, payload, fields = {}) => out(Buffer.concat([Buffer.from(`!${payload.length} ${JSON.stringify({ event, ...fields })}\n`), payload]));

function toneWav(ms, rate = 48000) {
  const n = Math.max(1, Math.round(rate * ms / 1000));
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * 220 * i / rate)), 44 + i * 2);
  return b;
}
const fail = new Set((process.env.FAKE_FAIL || '').split(',').filter(Boolean));
const SYNTH_MS = Number(process.env.FAKE_SYNTH_MS || 15);
const AUDIO_MS = Number(process.env.FAKE_AUDIO_MS || 30);
const STT_MS = Number(process.env.FAKE_STT_MS || 15);

let listening = false;
let listenSince = 0;
let micTimer = null;
const MIC_SIGNAL = process.env.FAKE_MIC_SIGNAL || 'ok';
const MIC_STATS_MS = Number(process.env.FAKE_MIC_STATS_MS || 5000);
const micCounts = { speech_starts: 0, speech_ends: 0, stt: { requests: 0, final: 0, discarded: 0, last_reason: '' } };
/** Same fields as the real service's mic_stats event. */
function micStats(reason) {
  const windowMs = listenSince ? now() - listenSince : 0;
  const frames = Math.floor(windowMs / 32);
  const peak = MIC_SIGNAL === 'digital_silence' ? 0 : MIC_SIGNAL === 'very_quiet' ? 0.001 : 0.2;
  return {
    reason, t: now(), mic_open: true, listening, window_ms: windowMs, frames, frames_before_gate: 0, frames_dropped: 0,
    stream: { device: 'Fake Microphone', host_api: 'fake', sample_rate: 16000, channels: 1, stream_active: true, callbacks: frames, frames },
    peak, rms: peak / 4, signal: frames ? MIC_SIGNAL : 'no_frames', vad_ready: true, vad_threshold: 0.5,
    max_speech_prob: micCounts.speech_starts ? 0.99 : 0.02, frames_over_threshold: micCounts.speech_starts * 20,
    speech_starts: micCounts.speech_starts, speech_ends: micCounts.speech_ends, discarded_short: 0, in_speech: false, stt: { ...micCounts.stt },
  };
}
function setListening(on) {
  listening = on;
  clearInterval(micTimer);
  micTimer = null;
  if (on) {
    listenSince = now();
    micCounts.speech_starts = 0; micCounts.speech_ends = 0;
    micTimer = setInterval(() => emit('mic_stats', micStats('periodic')), MIC_STATS_MS);
    micTimer.unref();
  }
}
let utteranceId = 0;
let generation = 0;
let ttsChain = Promise.resolve();
const turns = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function status(component, state, detail = '', info = {}) {
  emit('status', { component, state, detail, info });
}

let config = {};
/** What the fake "loaded", derived from the configuration it was given. */
const FAKE_VOICES = ['xenia', 'kseniya', 'baya', 'aidar', 'eugene'];

function info(component) {
  if (component === 'stt') {
    const c = config.stt || {};
    return { model: c.model || 'fake', device: 'cpu', compute_type: 'int8', language: process.env.FAKE_STT_LANGUAGE || c.language || 'ru' };
  }
  if (component === 'tts') {
    const c = config.tts || {};
    return { language: c.language || 'ru', model: c.modelId || 'fake-tts', voice: c.voice || 'xenia', voices: FAKE_VOICES, device: 'cpu', streaming: false };
  }
  return { device: `Fake ${component}`, host_api: 'fake' };
}

function checkDrained(turnId) {
  const t = turns.get(turnId);
  if (!t || !t.ended || t.played < t.queued) return;
  turns.delete(turnId);
  emit('tts_drained', { turn_id: turnId, chunks: t.queued, aborted: false, t_playback_end: t.lastEnd ?? now() });
}

async function speak(gen, turnId, seq, text, tAccepted, voice, ret) {
  if (gen !== generation) return;
  const t0 = now();
  await sleep(SYNTH_MS);
  if (gen !== generation) return;
  if (fail.has('synth')) { emit('tts_error', { turn_id: turnId, seq, message: 'RuntimeError: synth failed (fake)' }); return; }
  // like the real service: a voice named for this request must exist; otherwise the configured voice speaks
  if (voice && !FAKE_VOICES.includes(voice)) { emit('tts_error', { turn_id: turnId, seq, message: `ValueError: voice '${voice}' is not available in fake-tts` }); return; }
  const usedVoice = voice || (config.tts && config.tts.voice) || 'xenia';
  const t1 = now();
  const speakable = /[A-Za-zА-Яа-яЁё]/.test(text);
  const audioMs = speakable ? AUDIO_MS : 0;
  emit('tts_synth_done', { turn_id: turnId, seq, t_accepted: tAccepted, t_synth_start: t0, t_synth_done: t1, synth_ms: t1 - t0, audio_ms: audioMs, chars: text.length, voice: usedVoice });
  if (!speakable) return;
  if (ret) {
    if (gen !== generation) return;
    const wav = toneWav(AUDIO_MS);
    emitBinary('tts_audio', wav, { turn_id: turnId, seq, format: 'wav', sample_rate: 48000, channels: 1, audio_ms: AUDIO_MS, t_encoded: now(), encode_ms: 0.1 });
    return;
  }
  const turn = turns.get(turnId);
  if (!turn) return;
  turn.queued += 1;
  emit('tts_playback_start', { turn_id: turnId, seq, t_playback_start: now() + 5, approximate: true, output_latency_ms: 5 });
  await sleep(AUDIO_MS);
  if (gen !== generation) return;
  const tEnd = now();
  emit('tts_playback_end', { turn_id: turnId, seq, t_playback_end: tEnd });
  turn.played += 1;
  turn.lastEnd = tEnd;
  checkDrained(turnId);
}

const handlers = {
  clock_sync: (m) => emit('clock_sync', { reply_to: m.id, service_now_ms: now() }),
  init: (m) => {
    config = m.config || {};
    for (const c of ['output', 'vad', 'mic', 'tts', 'stt']) {
      status(c, 'loading', 'fake loading');
      if (fail.has(c)) status(c, 'error', `fake ${c} failure`);
      else status(c, 'ready', `fake ${c}`, info(c));
    }
  },
  configure: (m) => {
    config = m.config || {};
    emit('log', { level: 'info', message: `fake configure: ${JSON.stringify(m.config).length} bytes` });
    for (const c of ['tts', 'stt']) if (!fail.has(c)) status(c, 'ready', `fake ${c}`, info(c));
  },
  list_devices: (m) => emit('devices', {
    reply_to: m.id, host_api: 'fake',
    inputs: [{ index: 0, name: 'Fake Microphone', is_default: true }, { index: 2, name: 'Fake Headset Mic', is_default: false }],
    outputs: [{ index: 1, name: 'Fake Speakers', is_default: true }],
  }),
  get_resources: (m) => emit('resources', { reply_to: m.id, rss_mb: 111.5, gpu: [{ name: 'Fake GPU', memory_used_mb: 1000, memory_total_mb: 16000, utilization_pct: 3 }] }),
  set_listening: (m) => { setListening(Boolean(m.enabled)); emit('listening', { enabled: listening, reason: 'command', t: now() }); },
  get_mic_stats: (m) => emit('mic_stats', { reply_to: m.id, ...micStats('request') }),
  tts_speak: (m) => {
    const gen = generation;
    const id = String(m.turn_id);
    const ret = m.deliver === 'return';
    if (!ret && !turns.has(id)) turns.set(id, { queued: 0, played: 0, ended: false, lastEnd: null });
    const tAccepted = now();
    ttsChain = ttsChain.then(() => speak(gen, id, m.seq, String(m.text || ''), tAccepted, m.voice ? String(m.voice) : null, ret));
  },
  tts_end_turn: (m) => {
    const gen = generation;
    const id = String(m.turn_id);
    if (!turns.has(id)) turns.set(id, { queued: 0, played: 0, ended: false, lastEnd: null });
    ttsChain = ttsChain.then(() => {
      if (gen !== generation) return;
      const t = turns.get(id);
      if (t) { t.ended = true; checkDrained(id); }
    });
  },
  tts_stop: () => {
    generation += 1;
    for (const id of turns.keys()) emit('tts_drained', { turn_id: id, chunks: 0, aborted: true, t_playback_end: now() });
    turns.clear();
  },
  shutdown: () => {
    if (process.env.FAKE_IGNORE_SHUTDOWN) return; // a stuck service
    for (const c of ['mic', 'vad', 'stt', 'tts', 'output']) status(c, 'stopped', 'fake stopped');
    emit('bye');
    setTimeout(() => process.exit(0), 5);
  },
  _sim_utterance: async (m) => {
    if (!listening) { emit('_sim_ignored', { reason: 'gate closed', text: m.text }); return; }
    const id = ++utteranceId;
    const speechMs = Number(m.speech_ms || 800);
    const silenceMs = 600;
    const tEnd = now() - silenceMs;
    const tStart = tEnd - speechMs;
    emit('speech_start', { utterance_id: id, t_speech_start: tStart });
    micCounts.speech_starts += 1; micCounts.speech_ends += 1; micCounts.stt.requests += 1;
    emit('mic_stats', micStats('speech_end'));
    setListening(false); // one utterance at a time, like the real service
    emit('speech_end', { utterance_id: id, t_speech_start: tStart, t_speech_end: tEnd, t_vad_end_detected: now(), speech_ms: speechMs, forced: false });
    const t0 = now();
    await sleep(STT_MS);
    const text = String(m.text || '');
    const common = { utterance_id: id, text, t_stt_start: t0, t_stt_final: now(), stt_ms: now() - t0, audio_ms: speechMs, model: 'fake', device: 'cpu', compute_type: 'int8', language: info('stt').language };
    if (m.discard) emit('stt_discarded', { ...common, reason: m.discard });
    else emit('stt_final', common);
  },
  _sim_crash: () => process.exit(3),
};

/** Parent chain of this process (full chain on Linux, parent only elsewhere). */
function ancestors() {
  const chain = [];
  let pid = process.ppid;
  for (let i = 0; i < 6 && pid > 1; i++) {
    chain.push(pid);
    try {
      const stat = require('node:fs').readFileSync(`/proc/${pid}/stat`, 'utf8');
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { break; }
  }
  return chain;
}

if (!process.env.FAKE_NO_HELLO) {
  emit('hello', {
    protocol: Number(process.env.FAKE_PROTOCOL || 1), pid: process.pid,
    parent_pid: process.env.FAKE_HIDE_PARENT ? 1 : process.ppid,
    ancestors: process.env.FAKE_HIDE_PARENT ? [] : ancestors(),
    executable: process.execPath, python: 'fake', platform: process.platform,
    features: process.env.FAKE_NO_RETURN ? [] : ['tts_return'],
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { emit('error', { message: 'malformed' }); return; }
  const h = handlers[msg.cmd];
  if (!h) { emit('error', { message: `unknown command: ${msg.cmd}`, ...(msg.id !== undefined ? { reply_to: msg.id } : {}) }); return; }
  Promise.resolve(h(msg)).catch((err) => emit('error', { message: String(err) }));
});
rl.on('close', () => { if (!process.env.FAKE_IGNORE_SHUTDOWN) process.exit(0); }); // parent went away
if (process.env.FAKE_IGNORE_SHUTDOWN) setInterval(() => {}, 1000); // stays alive whatever happens to its pipes
