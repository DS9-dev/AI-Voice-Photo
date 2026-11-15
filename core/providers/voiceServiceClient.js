'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { nowMs } = require('../util/clock');
const { pidAlive, waitForExit, killProcess } = require('../util/process');
const { FrameDecoder } = require('../util/frames');

const PROTOCOL_VERSION = 1;
const COMPONENTS = ['mic', 'vad', 'stt', 'tts', 'output'];

function snakeToCamel(key) {
  return key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function camelize(value) {
  if (Array.isArray(value)) return value.map(camelize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[snakeToCamel(k)] = camelize(v);
    return out;
  }
  return value;
}

/**
 * Convert a raw service event to Core form: top-level `t` / `t_*` timestamps are
 * shifted from the service clock onto the Core clock, keys become camelCase.
 */
function normalizeEvent(raw, clockOffsetMs) {
  const shifted = {};
  for (const [k, v] of Object.entries(raw)) {
    shifted[k] = ((k === 't' || k.startsWith('t_')) && typeof v === 'number') ? v - clockOffsetMs : v;
  }
  return camelize(shifted);
}

/**
 * How the process that answered `hello` relates to the process we spawned.
 *
 *   direct      the same process (pid equal)
 *   launcher    a direct child of the spawned process. This is the normal
 *               shape on Windows: `.venv\Scripts\python.exe` is a small venv
 *               launcher that starts the real interpreter as its child, so
 *               the spawn pid and the service pid differ.
 *   descendant  further down the spawned process's tree (nested launchers)
 *   unrelated   anything else: rejected, because lifecycle ownership could
 *               not be guaranteed
 */
function relateProcesses(spawnPid, hello) {
  if (hello.pid === spawnPid) return 'direct';
  if (hello.parentPid === spawnPid) return 'launcher';
  if (Array.isArray(hello.ancestors) && hello.ancestors.includes(spawnPid)) return 'descendant';
  return 'unrelated';
}

/**
 * Owns the Python voice-service child process and its JSON-lines protocol
 * (commands on stdin, events on stdout, human-readable logs on stderr).
 *
 * Process ownership contract
 *   spawnPid    the process this client started (may be a launcher)
 *   servicePid  the process that runs the service code (reported in `hello`)
 * The client is responsible for BOTH. After stop(), and after an unexpected
 * exit of the spawned process, it verifies that the service process is gone
 * and terminates it explicitly if it is not. It never relies on a launcher
 * to clean up its child.
 */
class VoiceServiceClient extends EventEmitter {
  constructor({ command, args = [], cwd, env, clock = nowMs, spawnImpl = spawn, helloTimeoutMs = 30000 }) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.clock = clock;
    this.spawnImpl = spawnImpl;
    this.helloTimeoutMs = helloTimeoutMs;
    this.child = null;
    this.running = false;
    this.clockOffsetMs = 0;
    this.clockRttMs = null;
    this.hello = null;
    this.spawnPid = null;
    this.servicePid = null;
    this.serviceImage = '';
    this.processRelation = null;
    this.lastStop = null;
    this.reapGraceMs = 1500;
    this._nextId = 1;
    this._pending = new Map();
    this._stopping = false;
    this.statuses = {};
    this._resetStatuses('stopped', 'Voice service not started');
  }

  _resetStatuses(state, detail) {
    for (const c of COMPONENTS) this.statuses[c] = { component: c, state, detail, info: {} };
  }

  _setStatus(component, state, detail = '', info = {}) {
    this.statuses[component] = { component, state, detail, info };
    this.emit('status', this.statuses[component]);
  }

  async start(initConfig) {
    if (this.running) throw new Error('Voice service already running');
    this._stopping = false;
    for (const c of COMPONENTS) this._setStatus(c, 'loading', 'Starting voice service');

    let child;
    try {
      child = this.spawnImpl(this.command, this.args, {
        cwd: this.cwd,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...(this.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      this._failStart(`Cannot start voice service: ${err.message}`);
      throw err;
    }
    this.child = child;
    this.running = true;

    const helloPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Voice service did not start within ${this.helloTimeoutMs} ms`)), this.helloTimeoutMs);
      this.once('hello', (h) => { clearTimeout(timer); resolve(h); });
      this.once('exit', (info) => { clearTimeout(timer); reject(new Error(`Voice service exited during startup (${info.detail})`)); });
      child.once('error', (err) => { clearTimeout(timer); reject(new Error(`Cannot start voice service (${this.command}): ${err.message}`)); });
    });

    child.on('error', (err) => {
      if (this.child !== child) return;
      this._onExit(child, null, null, err.message);
    });
    child.on('exit', (code, signal) => this._onExit(child, code, signal, null));
    child.stdin.on('error', () => { /* EPIPE after exit: handled by exit */ });

    // Output that arrives after this child has been declared dead (a service
    // process can outlive its launcher for a moment) must not change state.
    // stdout carries JSON lines and, since VC-M3.2, binary frames (returned TTS
    // audio): "!<N> <json>\n" + N bytes (core/util/frames.js).
    const frames = new FrameDecoder({ maxBinaryBytes: 4 * 1024 * 1024 });
    let framesBroken = false;
    child.stdout.on('data', (buf) => {
      if (this.child !== child || framesBroken) return;
      let items;
      try {
        items = frames.push(buf);
      } catch (err) {
        // the stream cannot be resynchronised after a framing error: the service is restarted by the owner
        framesBroken = true;
        this.emit('stderr', `[protocol] voice service stdout framing error: ${err.message}`);
        this.emit('serviceError', { message: `voice service output unreadable: ${err.message}` });
        return;
      }
      for (const it of items) {
        if (this.child !== child) return;
        if (it.kind === 'text') this._onLine(it.text);
        else this._onLine(it.header, it.payload);
      }
    });
    readline.createInterface({ input: child.stderr, crlfDelay: Infinity })
      .on('line', (line) => this.emit('stderr', line));

    this.spawnPid = child.pid ?? null;
    this.servicePid = null;
    this.serviceImage = '';
    this.processRelation = null;
    try {
      this.hello = await helloPromise;
      // record the service process first, so it is reaped even if startup is rejected below
      this.servicePid = this.hello.pid;
      this.serviceImage = this.hello.executable || '';
      this.processRelation = relateProcesses(this.spawnPid, this.hello);
      if (this.hello.protocol !== PROTOCOL_VERSION) {
        throw new Error(`Voice service protocol ${this.hello.protocol} != expected ${PROTOCOL_VERSION}`);
      }
      if (this.processRelation === 'unrelated') {
        throw new Error(`Voice service process ${this.hello.pid} (parent ${this.hello.parentPid}) is neither the started process ${this.spawnPid} nor one of its descendants; refusing to run a service whose lifetime cannot be owned`);
      }
      await this._syncClock();
      // initConfig === null starts the process without loading models or opening audio devices
      if (initConfig !== null) this.send({ cmd: 'init', config: initConfig });
      else this._resetStatuses('stopped', 'Voice service running, not initialized');
    } catch (err) {
      await this.stop().catch(() => {});
      this._failStart(err.message);
      throw err;
    }
    return this.hello;
  }

  _failStart(message) {
    for (const c of COMPONENTS) this._setStatus(c, 'error', message);
  }

  async _syncClock(samples = 5) {
    let best = null;
    for (let i = 0; i < samples; i++) {
      const tSend = this.clock();
      const reply = await this.request({ cmd: 'clock_sync' }, 3000);
      const tRecv = this.clock();
      const rtt = tRecv - tSend;
      const offset = reply.serviceNowMs - (tSend + tRecv) / 2;
      if (!best || rtt < best.rtt) best = { rtt, offset };
    }
    this.clockOffsetMs = best.offset;
    this.clockRttMs = best.rtt;
    this.emit('clockSync', { offsetMs: best.offset, rttMs: best.rtt });
  }

  _onLine(line, payload = null) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let raw;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      this.emit('stderr', `[non-protocol stdout] ${trimmed.slice(0, 300)}`);
      return;
    }
    if (!raw || typeof raw.event !== 'string') return;
    const ev = normalizeEvent(raw, this.clockOffsetMs);
    if (payload) ev.payload = payload;  // binary frame: raw bytes, never logged
    if (ev.event === 'status' && COMPONENTS.includes(ev.component)) {
      this._setStatus(ev.component, ev.state, ev.detail || '', ev.info || {});
    }
    if (ev.replyTo !== undefined && this._pending.has(ev.replyTo)) {
      const p = this._pending.get(ev.replyTo);
      this._pending.delete(ev.replyTo);
      clearTimeout(p.timer);
      if (ev.event === 'error') p.reject(new Error(ev.message || 'voice service error'));
      else p.resolve(ev);
    }
    this.emit('event', ev);
    if (ev.event !== 'status' && ev.event !== 'error') this.emit(ev.event, ev);
    if (ev.event === 'error') this.emit('serviceError', ev);
  }

  _onExit(child, code, signal, errorMessage) {
    if (this.child !== child || !this.running) return;
    this.running = false;
    this.child = null;
    const expected = this._stopping;
    const detail = errorMessage || (signal ? `signal ${signal}` : `exit code ${code}`);
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`Voice service exited (${detail})`));
    }
    this._pending.clear();
    if (expected) this._resetStatuses('stopped', 'Voice service stopped');
    else this._resetStatuses('error', `Voice service exited unexpectedly (${detail})`);
    for (const c of COMPONENTS) this.emit('status', this.statuses[c]);
    this.emit('exit', { code, signal, expected, detail, spawnPid: this.spawnPid, servicePid: this.servicePid });
    // The started process died on its own. If it was a launcher, make sure the
    // service process does not survive it. (stop() does its own reaping.)
    if (!expected) this._reapService('started process exited unexpectedly').catch(() => {});
  }

  /**
   * Guarantee that the service process is gone.
   *
   * 1. Poll the recorded service pid. A healthy service ends by itself (its
   *    stdin closes), so it is given `reapGraceMs` to do that; the wait ends
   *    the moment the pid disappears.
   * 2. If the pid has been alive without interruption for the whole grace
   *    period, terminate exactly that process: by pid, and only if its image
   *    name is the one the service reported in `hello`. No other process is
   *    ever touched, and nothing is selected by name alone.
   * 3. Wait until it is really gone, then report.
   *
   * Emits 'reapKill' just before terminating and always 'reaped' at the end.
   *
   * Why this exists although Windows often cleans up by itself: libuv puts
   * the children of a Node/Electron process into a kill-on-close job object,
   * and CPython's venv launcher does the same for the interpreter it starts,
   * so a service usually dies with its launcher. Neither is a contract of
   * this application (a process started outside those jobs survives), so
   * ownership is enforced here, explicitly, on every platform.
   */
  async _reapService(reason) {
    const pid = this.servicePid;
    const started = this.clock();
    const result = {
      reason, spawnPid: this.spawnPid, servicePid: pid, relation: this.processRelation, image: this.serviceImage,
      aliveWhenReapingStarted: false, killed: false, alive: false, waitedMs: 0,
    };
    if (pid && pid !== process.pid) {
      result.aliveWhenReapingStarted = pidAlive(pid);
      const exited = await waitForExit(pid, this.reapGraceMs);
      if (!exited) {
        this.emit('reapKill', { reason, spawnPid: this.spawnPid, servicePid: pid, image: this.serviceImage, aliveForMs: this.clock() - started });
        result.killed = await killProcess(pid, this.serviceImage);
        await waitForExit(pid, 5000);
      }
      result.alive = pidAlive(pid);
      result.waitedMs = Math.round(this.clock() - started);
    }
    this.emit('reaped', result);
    return result;
  }

  /** Optional capability announced by the running service in `hello` (e.g. 'tts_return'). */
  hasFeature(name) {
    return Boolean(this.running && this.hello && Array.isArray(this.hello.features) && this.hello.features.includes(name));
  }

  /** Fire-and-forget command. Returns false if the service is not running. */
  send(cmd) {
    if (!this.running || !this.child || !this.child.stdin.writable) return false;
    try {
      this.child.stdin.write(JSON.stringify(cmd) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  /** Command with a correlated reply event. */
  request(cmd, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Voice service did not answer '${cmd.cmd}' within ${timeoutMs} ms`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      if (!this.send({ ...cmd, id })) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(new Error('Voice service is not running'));
      }
    });
  }

  _waitExit(ms) {
    if (!this.running) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.off('exit', onExit); resolve(false); }, ms);
      const onExit = () => { clearTimeout(timer); resolve(true); };
      this.once('exit', onExit);
    });
  }

  /**
   * Graceful stop, escalating to closing stdin and finally killing the tree.
   * Resolves with what happened to both owned processes; `clean` is true only
   * when neither the started process nor the service process is left.
   */
  async stop() {
    if (!this.running || !this.child) return this.lastStop;
    this._stopping = true;
    const child = this.child;
    const spawnPid = this.spawnPid;
    let how = 'shutdown command';
    this.send({ cmd: 'shutdown' });
    if (!(await this._waitExit(4000))) {
      how = 'stdin closed';
      try { child.stdin.end(); } catch { /* ignore */ }
      if (!(await this._waitExit(1500))) {
        how = 'killed';
        try {
          if (process.platform === 'win32' && child.pid) {
            // kill the whole tree: a venv launcher plus the interpreter it started
            spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          } else {
            child.kill('SIGKILL');
          }
        } catch { /* ignore */ }
        await this._waitExit(3000);
      }
    }
    const reap = await this._reapService('stop');
    this.lastStop = {
      how,
      spawnPid,
      servicePid: reap.servicePid,
      relation: reap.relation,
      serviceKilledExplicitly: reap.killed,
      spawnAlive: spawnPid ? pidAlive(spawnPid) : false,
      serviceAlive: reap.alive,
    };
    this.lastStop.clean = !this.lastStop.spawnAlive && !this.lastStop.serviceAlive;
    return this.lastStop;
  }
}

module.exports = { VoiceServiceClient, relateProcesses, normalizeEvent, camelize, snakeToCamel, PROTOCOL_VERSION, COMPONENTS };
