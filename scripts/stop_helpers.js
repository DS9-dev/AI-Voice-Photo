'use strict';
/**
 * Stops leftover processes started by THIS project only:
 *   - python processes running `services.voice_service`
 *   - Electron processes started from this project folder
 * LM Studio and any other application are never touched.
 * Normally not needed: the app stops its voice service when it closes.
 */
const { spawnSync } = require('node:child_process');
const { ROOT, IS_WIN } = require('./lib/proc');

function listWindows() {
  const script = [
    "$root = $args[0]",
    "Get-CimInstance Win32_Process | Where-Object {",
    "  ($_.Name -like 'python*' -and $_.CommandLine -like '*services.*_service*--app=ai-voice-photo*') -or",
    "  ($_.Name -like 'electron*' -and $_.CommandLine -like ('*' + $root + '*'))",
    "} | ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.Name }",
  ].join('\n');
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `& { ${script} } '${ROOT.replace(/'/g, "''")}'`], { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const [pid, name] = l.split('|'); return { pid: Number(pid), name }; });
}

function listPosix() {
  const fs = require('node:fs');
  const r = spawnSync('pgrep', ['-f', '--', 'services[.](voice|avatar)_service.*--app=ai-voice-photo'], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter(Boolean).map(Number)
    .filter((pid) => {
      if (pid === process.pid) return false;
      try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim().startsWith('python'); } catch { return false; }
    })
    .map((pid) => ({ pid, name: 'python' }));
}

const found = IS_WIN ? listWindows() : listPosix();
if (!found.length) {
  console.log('No leftover AI Voice Photo processes found.');
} else {
  for (const p of found) {
    if (IS_WIN) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
    else { try { process.kill(p.pid, 'SIGKILL'); } catch { /* already gone */ } }
    console.log(`Stopped ${p.name} (pid ${p.pid})`);
  }
}
