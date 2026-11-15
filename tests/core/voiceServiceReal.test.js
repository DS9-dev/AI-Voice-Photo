'use strict';
/**
 * Process lifecycle of the REAL voice service (services/voice_service),
 * started exactly as the application starts it, but without the `init`
 * command: no model is loaded and no audio device is opened.
 *
 * This is where the Windows venv-launcher behaviour is verified for real:
 * which process the client started, which process answered, how they are
 * related, and that neither is left running. The facts observed are written
 * to artifacts/reports/process_identity.json.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { VoiceServiceClient } = require('../../core/providers/voiceServiceClient');
const { pidAlive, waitForExit } = require('../../core/util/process');
const { findTestPython } = require('../../scripts/lib/proc');

const ROOT = path.join(__dirname, '..', '..');
const PYTHON = findTestPython(ROOT);
const skip = PYTHON ? false : 'no Python with the service dependencies found (run setup.bat)';

const makeClient = () => new VoiceServiceClient({ command: PYTHON, args: ['-u', '-m', 'services.voice_service'], cwd: ROOT, helloTimeoutMs: 60000 });

// Facts observed in these tests, written to artifacts/reports/process_identity.json
const FACTS = { generatedAt: new Date().toISOString(), platform: process.platform, command: PYTHON };
test.after(() => {
  try {
    const dir = path.join(ROOT, 'artifacts', 'reports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'process_identity.json'), JSON.stringify(FACTS, null, 2));
  } catch { /* reporting must not fail the tests */ }
});

function once(emitter, name, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeoutMs);
    emitter.once(name, (e) => { clearTimeout(timer); resolve(e); });
  });
}

test('real service: process identity is explicit and both processes stop on shutdown', { skip }, async () => {
  const client = makeClient();
  const hello = await client.start(null);
  let stopped;
  Object.assign(FACTS, {
    startedProcess: { pid: client.spawnPid, image: hello.launchedAs, meaning: 'the process the core started (child.pid)' },
    serviceProcess: { pid: hello.pid, parentPid: hello.parentPid, ancestors: hello.ancestors, image: hello.executable, meaning: 'the process running services.voice_service (hello.pid)' },
    viaLauncher: hello.viaLauncher,
    relation: client.processRelation,
  });
  try {
    assert.equal(client.spawnPid, client.child.pid);
    assert.equal(client.servicePid, hello.pid);
    assert.notEqual(client.processRelation, 'unrelated');
    if (hello.viaLauncher === true) {
      // e.g. Windows venv: .venv\Scripts\python.exe starts the real interpreter as its child
      assert.ok(['launcher', 'descendant'].includes(client.processRelation), client.processRelation);
      assert.notEqual(hello.pid, client.spawnPid);
      assert.ok(hello.ancestors.includes(client.spawnPid), 'the started process is an ancestor of the service process');
    } else if (hello.viaLauncher === false) {
      assert.equal(client.processRelation, 'direct');
      assert.equal(hello.pid, client.spawnPid);
    }
    assert.equal(pidAlive(client.spawnPid), true);
    assert.equal(pidAlive(client.servicePid), true);
  } finally {
    stopped = await client.stop();
    FACTS.shutdown = stopped;
  }
  assert.equal(stopped.how, 'shutdown command', 'graceful stop was enough');
  assert.equal(stopped.serviceKilledExplicitly, false);
  assert.equal(stopped.clean, true);
  assert.equal(pidAlive(stopped.spawnPid), false, 'started process is gone');
  assert.equal(pidAlive(stopped.servicePid), false, 'service process is gone');
});

test('real service: killing the started process leaves no orphan service', { skip }, async () => {
  const client = makeClient();
  await client.start(null);
  const { spawnPid, servicePid } = client;
  const reaped = once(client, 'reaped');
  const exit = once(client, 'exit');
  let clientKilled = false;
  client.on('reapKill', () => { clientKilled = true; });
  process.kill(spawnPid, 'SIGKILL'); // on Windows this terminates the launcher (or the interpreter itself)
  await exit;
  const serviceAliveWhenLauncherExitSeen = pidAlive(servicePid);
  const result = await reaped;
  // Which mechanism removed the real service is recorded, not assumed: it ends
  // by itself (closed stdin, or the launcher's job object) or the client ends it.
  FACTS.startedProcessKilled = {
    spawnPid, servicePid, relation: client.processRelation, serviceAliveWhenLauncherExitSeen,
    removedBy: clientKilled ? 'client (explicit termination)' : 'service ended without the client (stdin EOF / launcher job object)',
    reaped: result,
  };
  assert.equal(result.alive, false);
  assert.equal(await waitForExit(spawnPid, 5000), true);
  assert.equal(pidAlive(servicePid), false, 'service process did not survive');
  assert.equal(client.running, false);
  assert.equal(client.statuses.stt.state, 'error');
});

test('real service: restart gives a fresh process pair and the old pair is gone', { skip }, async () => {
  const client = makeClient();
  await client.start(null);
  const first = { spawn: client.spawnPid, service: client.servicePid };
  assert.equal((await client.stop()).clean, true);
  await client.start(null);
  try {
    assert.notEqual(client.servicePid, first.service);
    assert.equal(pidAlive(first.spawn), false);
    assert.equal(pidAlive(first.service), false);
  } finally {
    assert.equal((await client.stop()).clean, true);
  }
});
