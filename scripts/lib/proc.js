'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const IS_WIN = process.platform === 'win32';

function venvPython(root = ROOT) {
  return IS_WIN ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python');
}

/** Append-only log file that mirrors console output. */
function makeLogger(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `--- ${new Date().toISOString()} ---\n`);
  const write = (text) => { try { fs.appendFileSync(file, text); } catch { /* ignore */ } };
  return {
    file,
    line(text = '') { console.log(text); write(text + '\n'); },
    raw(text) { process.stdout.write(text); write(text); },
    quiet(text) { write(text); },
  };
}

/**
 * Run a command, streaming output to the console and the log. Resolves {code, output}.
 *
 * windowsHide: on Windows this starts the child with "show window: hidden".
 * That is right for console helpers (no flashing console windows) and wrong
 * for a GUI application: Windows applies the hidden state to the first window
 * the child shows, so an Electron window started this way stays invisible.
 * Pass windowsHide:false when the child is supposed to show a window.
 */
function run(cmd, args, { cwd = ROOT, env, log, shell = false, echo = true, windowsHide = true } = {}) {
  return new Promise((resolve) => {
    if (log && echo) log.line(`> ${cmd} ${args.join(' ')}`);
    let output = '';
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, ...(env || {}) }, shell, windowsHide });
    } catch (err) {
      resolve({ code: -1, output: String(err) });
      return;
    }
    const onData = (buf) => {
      const text = buf.toString('utf8');
      output += text;
      if (log) { if (echo) log.raw(text); else log.quiet(text); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => resolve({ code: -1, output: output + String(err) }));
    child.on('close', (code) => resolve({ code, output }));
  });
}

/** Quick synchronous probe; returns trimmed stdout or null. */
function probe(cmd, args, { shell = false, timeoutMs = 20000 } = {}) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', shell, windowsHide: true, timeout: timeoutMs });
    if (r.status !== 0) return null;
    return (r.stdout || '').trim();
  } catch {
    return null;
  }
}

/** Python used for tests: the project venv, else a Python on PATH that has numpy. */
function findTestPython(root = ROOT) {
  const venv = venvPython(root);
  if (fs.existsSync(venv)) return venv;
  for (const cmd of ['python', 'python3']) {
    if (probe(cmd, ['-c', 'import numpy;print(1)'])) return cmd;
  }
  return null;
}

/**
 * Pids of processes that belong to this project's voice service or its test
 * doubles (python running services.voice_service; node running the fake
 * service or fake launcher). Used to prove that nothing is left running.
 */
function listServiceProcesses() {
  if (IS_WIN) {
    const script = "Get-CimInstance Win32_Process | Where-Object { ($_.Name -like 'python*' -and $_.CommandLine -like '*services.voice_service*') -or ($_.Name -like 'node*' -and ($_.CommandLine -like '*fake_voice_service.js*' -or $_.CommandLine -like '*fake_launcher.js*')) } | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $_.Name }";
    const out = probe('powershell', ['-NoProfile', '-Command', script], { timeoutMs: 30000 });
    if (out === null) return null; // could not query
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [pid, ppid, name] = l.split('|');
      return { pid: Number(pid), ppid: Number(ppid), name };
    });
  }
  const r = spawnSync('ps', ['-eo', 'pid=,ppid=,stat=,args='], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const found = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m || m[3].startsWith('Z')) continue;
    const args = m[4];
    const first = args.split(' ')[0];
    const isPy = /python[\d.]*$/.test(first) && args.includes('services.voice_service');
    const isNode = /node$/.test(first) && (args.includes('fake_voice_service.js') || args.includes('fake_launcher.js'));
    if (isPy || isNode) found.push({ pid: Number(m[1]), ppid: Number(m[2]), name: first });
  }
  return found;
}

module.exports = { ROOT, IS_WIN, venvPython, makeLogger, run, probe, findTestPython, listServiceProcesses };
