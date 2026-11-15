'use strict';
/**
 * FAKE launcher for tests: reproduces the process shape of a Windows venv
 * `python.exe` launcher. It starts the real target as a CHILD process that
 * shares its stdio, waits for it and exits with its exit code.
 *
 *   node fake_launcher.js <script> [args...]
 *
 * What happens to the child when the launcher itself is killed depends on the
 * platform, exactly as with real launchers:
 *
 *   Linux/macOS  the child simply keeps running.
 *   Windows      Node (libuv) puts its children into a job object with
 *                KILL_ON_JOB_CLOSE, so the operating system kills the child
 *                the moment the launcher dies. CPython's venv launcher does
 *                the same for the interpreter it starts.
 *
 * FAKE_LAUNCHER_ORPHAN=1 starts the child DETACHED, i.e. outside that job.
 * The child then outlives a killed launcher on every platform. This is the
 * worst case the client must handle by itself: an owned service process that
 * nothing else will clean up.
 */
const { spawn } = require('node:child_process');

const [target, ...args] = process.argv.slice(2);
const orphanable = Boolean(process.env.FAKE_LAUNCHER_ORPHAN);
const child = spawn(process.execPath, [target, ...args], { stdio: 'inherit', detached: orphanable, windowsHide: true });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
child.on('error', () => process.exit(127));
