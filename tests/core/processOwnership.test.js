'use strict';
/**
 * Process-ownership contract of VoiceServiceClient.
 *
 * On Windows `.venv\Scripts\python.exe` is a launcher that starts the real
 * interpreter as a child, so the pid the client spawned and the pid of the
 * service are different processes. The client must know both and must leave
 * neither behind. The launcher shape is reproduced here on every platform
 * with tests/fixtures/fake_launcher.js, which (unlike the real launcher) does
 * nothing to clean up its child: the worst case.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { VoiceServiceClient, relateProcesses } = require('../../core/providers/voiceServiceClient');
const { pidAlive, waitForExit, killProcess } = require('../../core/util/process');

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake_voice_service.js');
const LAUNCHER = path.join(__dirname, '..', 'fixtures', 'fake_launcher.js');

const direct = (env = {}) => new VoiceServiceClient({ command: process.execPath, args: [FAKE], env, helloTimeoutMs: 4000 });
const viaLauncher = (env = {}) => new VoiceServiceClient({ command: process.execPath, args: [LAUNCHER, FAKE], env, helloTimeoutMs: 4000 });

// ---------------------------------------------------------------------------
// Evidence: what was observed at each stage of the reaping scenarios is written
// to artifacts/reports/process_reaping.json (one entry per scenario).
const fs = require('node:fs');
const EVIDENCE = { generatedAt: new Date().toISOString(), platform: process.platform, node: process.version, scenarios: {} };
test.after(() => {
  try {
    const dir = path.join(__dirname, '..', '..', 'artifacts', 'reports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'process_reaping.json'), JSON.stringify(EVIDENCE, null, 2));
  } catch { /* reporting must not fail the tests */ }
});

/** Timeline recorder: snapshot of both owned pids at named stages. */
function recorder(spawnPid, servicePid) {
  const t0 = Date.now();
  const stages = [];
  const mark = (stage, extra = {}) => {
    const entry = { stage, tMs: Date.now() - t0, launcherAlive: pidAlive(spawnPid), serviceAlive: pidAlive(servicePid), ...extra };
    stages.push(entry);
    return entry;
  };
  return { stages, mark };
}

/** Test-only safety net so a failing test can never leave a process behind.
 *  Returns true if it had to act, which the caller treats as a failure. */
function lastResort(pids) {
  let acted = false;
  for (const pid of pids) {
    if (pidAlive(pid)) {
      acted = true;
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone meanwhile */ }
    }
  }
  return acted;
}

function once(emitter, name, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeoutMs);
    emitter.once(name, (e) => { clearTimeout(timer); resolve(e); });
  });
}

test('relateProcesses names the relationship explicitly', () => {
  assert.equal(relateProcesses(100, { pid: 100, parentPid: 1, ancestors: [1] }), 'direct');
  assert.equal(relateProcesses(100, { pid: 200, parentPid: 100, ancestors: [100, 1] }), 'launcher');
  assert.equal(relateProcesses(100, { pid: 300, parentPid: 200, ancestors: [200, 100, 1] }), 'descendant');
  assert.equal(relateProcesses(100, { pid: 300, parentPid: 200, ancestors: [200, 1] }), 'unrelated');
  assert.equal(relateProcesses(100, { pid: 300 }), 'unrelated');
});

test('pidAlive / waitForExit / killProcess', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(pidAlive(child.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-5), false);
  assert.equal(await waitForExit(child.pid, 100), false);
  // an image name that does not match must not kill the process
  await killProcess(child.pid, 'definitely-not-this-image.exe');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(pidAlive(child.pid), true, 'process with a different image name was left alone');
  assert.equal(await killProcess(child.pid, path.basename(process.execPath)), true);
  assert.equal(await waitForExit(child.pid, 5000), true);
  assert.equal(await killProcess(child.pid, path.basename(process.execPath)), false, 'nothing to kill any more');
});

test('direct start: the spawned process is the service process', async () => {
  const client = direct();
  const hello = await client.start({});
  assert.equal(client.processRelation, 'direct');
  assert.equal(client.spawnPid, client.child.pid);
  assert.equal(client.servicePid, hello.pid);
  assert.equal(client.servicePid, client.spawnPid);
  const stopped = await client.stop();
  assert.deepEqual({ how: stopped.how, clean: stopped.clean, killed: stopped.serviceKilledExplicitly }, { how: 'shutdown command', clean: true, killed: false });
  assert.equal(pidAlive(stopped.spawnPid), false);
});

test('start through a launcher: two pids, relationship verified, both owned', async () => {
  const client = viaLauncher();
  const hello = await client.start({});
  try {
    assert.equal(client.processRelation, 'launcher');
    assert.notEqual(client.servicePid, client.spawnPid, 'launcher pid and service pid differ');
    assert.equal(client.spawnPid, client.child.pid);
    assert.equal(client.servicePid, hello.pid);
    assert.equal(hello.parentPid, client.spawnPid, 'the service is a child of the process we started');
    assert.equal(pidAlive(client.spawnPid), true);
    assert.equal(pidAlive(client.servicePid), true);
    // the protocol works through the launcher
    const devices = await client.request({ cmd: 'list_devices' });
    assert.equal(devices.inputs.length, 2);
  } finally {
    const stopped = await client.stop();
    assert.equal(stopped.how, 'shutdown command');
    assert.equal(stopped.relation, 'launcher');
    assert.equal(stopped.clean, true);
    assert.equal(pidAlive(stopped.spawnPid), false, 'launcher gone');
    assert.equal(pidAlive(stopped.servicePid), false, 'service gone');
  }
});

test('launcher killed: the service process does not survive it', async () => {
  const client = viaLauncher();
  await client.start({});
  const { spawnPid, servicePid } = client;
  const exit = once(client, 'exit');
  const reaped = once(client, 'reaped');
  process.kill(spawnPid, 'SIGKILL');
  const info = await exit;
  assert.equal(info.expected, false);
  assert.equal(info.servicePid, servicePid);
  const result = await reaped;
  assert.equal(result.servicePid, servicePid);
  assert.equal(result.alive, false);
  assert.equal(pidAlive(spawnPid), false);
  assert.equal(pidAlive(servicePid), false, 'service process did not outlive its launcher');
  // Normal case: the service notices its closed stdin and exits by itself.
  assert.equal(result.killed, false);
  // whatever the dying service still printed must not make it look alive again
  await new Promise((r) => setTimeout(r, 100));
  for (const c of ['mic', 'vad', 'stt', 'tts', 'output']) assert.equal(client.statuses[c].state, 'error', c);
});

test('launcher killed and the service is stuck: the client terminates the service itself', async () => {
  // The stuck service ignores the shutdown command and a closed stdin, and it
  // is started outside the launcher's job object (FAKE_LAUNCHER_ORPHAN), so
  // on no platform does anything but the client remove it.
  const client = viaLauncher({ FAKE_IGNORE_SHUTDOWN: '1', FAKE_LAUNCHER_ORPHAN: '1' });
  await client.start({});
  const { spawnPid, servicePid } = client;
  const rec = recorder(spawnPid, servicePid);
  let killAnnounced = null;
  client.on('reapKill', (e) => { killAnnounced = rec.mark('client is about to terminate the service', { announced: e }); });
  try {
    const started = rec.mark('started');
    assert.equal(client.processRelation, 'launcher');
    assert.deepEqual([started.launcherAlive, started.serviceAlive], [true, true]);

    const exit = once(client, 'exit');
    const reaped = once(client, 'reaped');
    process.kill(spawnPid, 'SIGKILL');
    rec.mark('launcher terminated by the test');
    await exit;

    // PREMISE of this test: the launcher is gone and the owned service is
    // still running on its own. If this fails, the fixture did not create the
    // condition and the client's behaviour was not exercised at all.
    const afterLoss = rec.mark('client saw the launcher exit');
    assert.equal(afterLoss.launcherAlive, false, 'premise: launcher is gone');
    assert.equal(afterLoss.serviceAlive, true, 'premise: the stuck service outlived its launcher');

    const result = await reaped;
    const end = rec.mark('client reported reaping finished', { result });

    // The client detected the survivor, and it was still alive at the very
    // moment the client acted: nothing else had removed it.
    assert.ok(killAnnounced, 'the client announced that it terminates the service');
    assert.equal(killAnnounced.announced.servicePid, servicePid, 'it targets exactly the recorded service pid');
    assert.equal(killAnnounced.serviceAlive, true, 'the service was alive when the client acted');
    assert.equal(killAnnounced.launcherAlive, false);
    assert.equal(result.aliveWhenReapingStarted, true);
    assert.equal(result.killed, true, 'explicit termination was needed and done');
    assert.equal(result.alive, false);
    // ... and it is gone now, inside this test, before any later check could run.
    assert.equal(end.serviceAlive, false, 'no orphan');
    assert.equal(pidAlive(spawnPid), false);
    assert.equal(pidAlive(servicePid), false, 'no orphan');
  } finally {
    const hadToCleanUp = lastResort([servicePid, spawnPid]);
    EVIDENCE.scenarios.stuckServiceOutsideLauncherJob = { spawnPid, servicePid, image: client.serviceImage, stages: rec.stages, testSafetyNetHadToKill: hadToCleanUp };
    assert.equal(hadToCleanUp, false, 'the test safety net had to kill a process the client left behind');
  }
});

test('launcher killed and the service is stuck, default child process: no orphan whoever removes it', async () => {
  // Same stuck service, but started the default way. On Linux it survives the
  // launcher and the client terminates it. On Windows the operating system
  // kills it together with the launcher (libuv job object), so the client
  // finds nothing left to do. Who acted is recorded, the outcome is asserted.
  const client = viaLauncher({ FAKE_IGNORE_SHUTDOWN: '1' });
  await client.start({});
  const { spawnPid, servicePid } = client;
  const rec = recorder(spawnPid, servicePid);
  let clientKilled = false;
  client.on('reapKill', () => { clientKilled = true; rec.mark('client is about to terminate the service'); });
  try {
    rec.mark('started');
    const exit = once(client, 'exit');
    const reaped = once(client, 'reaped');
    process.kill(spawnPid, 'SIGKILL');
    await exit;
    const afterLoss = rec.mark('client saw the launcher exit');
    const result = await reaped;
    rec.mark('client reported reaping finished', { result });
    assert.equal(result.alive, false);
    assert.equal(result.killed, clientKilled);
    // either the client did it, or the service was already gone when the client looked
    assert.ok(result.killed || afterLoss.serviceAlive === false || result.aliveWhenReapingStarted === false || result.waitedMs < client.reapGraceMs,
      'service disappeared neither by the client nor before the grace period ended');
    assert.equal(pidAlive(spawnPid), false);
    assert.equal(pidAlive(servicePid), false, 'no orphan');
  } finally {
    const hadToCleanUp = lastResort([servicePid, spawnPid]);
    EVIDENCE.scenarios.stuckServiceDefaultChild = {
      spawnPid, servicePid, stages: rec.stages, removedBy: clientKilled ? 'client (explicit termination)' : 'not the client (operating system / launcher job object)',
      testSafetyNetHadToKill: hadToCleanUp,
    };
    assert.equal(hadToCleanUp, false, 'the test safety net had to kill a process the client left behind');
  }
});

test('a service that crashes by itself needs no reaping', async () => {
  const client = direct();
  await client.start({});
  const reaped = once(client, 'reaped');
  client.send({ cmd: '_sim_crash' });
  const result = await reaped;
  assert.deepEqual({ killed: result.killed, alive: result.alive }, { killed: false, alive: false });
});

test('a service outside the started process tree is rejected and still not left running', async () => {
  const client = viaLauncher({ FAKE_HIDE_PARENT: '1' });
  await assert.rejects(client.start({}), /neither the started process .* nor one of its descendants/);
  assert.equal(client.running, false);
  assert.equal(client.processRelation, 'unrelated');
  assert.ok(client.servicePid > 0 && client.servicePid !== client.spawnPid);
  assert.equal(await waitForExit(client.servicePid, 5000), true, 'rejected service process is gone');
  assert.equal(pidAlive(client.spawnPid), false);
  assert.match(client.statuses.stt.detail, /lifetime cannot be owned/);
});

test('stop escalates to a kill and still ends clean when the service ignores shutdown', async () => {
  const client = viaLauncher({ FAKE_IGNORE_SHUTDOWN: '1' });
  await client.start({});
  const { spawnPid, servicePid } = client;
  try {
    const stopped = await client.stop();
    assert.equal(stopped.clean, true);
    assert.equal(stopped.how, 'killed');
    assert.equal(pidAlive(stopped.spawnPid), false);
    assert.equal(pidAlive(stopped.servicePid), false);
  } finally {
    assert.equal(lastResort([servicePid, spawnPid]), false, 'the test safety net had to kill a process the client left behind');
  }
});

test('stop() with a stuck service outside the launcher job still ends with both processes gone', async () => {
  const client = viaLauncher({ FAKE_IGNORE_SHUTDOWN: '1', FAKE_LAUNCHER_ORPHAN: '1' });
  await client.start({});
  const { spawnPid, servicePid } = client;
  try {
    const stopped = await client.stop();
    assert.equal(stopped.how, 'killed');
    assert.equal(stopped.clean, true);
    assert.equal(pidAlive(spawnPid), false);
    assert.equal(pidAlive(servicePid), false);
    EVIDENCE.scenarios.stopWithStuckService = stopped;
  } finally {
    assert.equal(lastResort([servicePid, spawnPid]), false, 'the test safety net had to kill a process the client left behind');
  }
});

test('start(null) runs the process without initializing models or audio', async () => {
  const client = direct();
  await client.start(null);
  try {
    assert.equal(client.running, true);
    assert.equal(client.statuses.stt.state, 'stopped');
    assert.match(client.statuses.stt.detail, /not initialized/);
  } finally {
    assert.equal((await client.stop()).clean, true);
  }
});
