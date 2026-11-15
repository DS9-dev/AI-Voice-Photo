'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** True while a process with this pid exists (zombies do not count). */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    return err.code === 'EPERM'; // exists but belongs to someone else
  }
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
      if (state === 'Z') return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Wait until the pid is gone; resolves true if it exited within the time. */
async function waitForExit(pid, timeoutMs, pollMs = 50) {
  const start = Date.now();
  for (;;) {
    if (!pidAlive(pid)) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Forcefully terminate one process (and its children), but only if its image
 * name matches `image` (e.g. "python.exe"). The image check guards against
 * hitting an unrelated process should the pid have been reused.
 * Resolves true if a kill was attempted.
 */
function killProcess(pid, image) {
  return new Promise((resolve) => {
    if (!pidAlive(pid)) { resolve(false); return; }
    const name = image ? path.basename(String(image)) : '';
    if (process.platform === 'win32') {
      const args = ['/F', '/T', '/FI', `PID eq ${pid}`];
      if (name) args.push('/FI', `IMAGENAME eq ${name}`);
      let child;
      try {
        child = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
      } catch {
        resolve(false);
        return;
      }
      child.on('error', () => resolve(false));
      child.on('close', () => resolve(true));
      return;
    }
    if (name && process.platform === 'linux') {
      try {
        const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
        // comm is truncated to 15 characters by the kernel
        if (comm !== name.slice(0, 15)) { resolve(false); return; }
      } catch {
        resolve(false);
        return;
      }
    }
    try {
      process.kill(pid, 'SIGKILL');
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

module.exports = { pidAlive, waitForExit, killProcess };
