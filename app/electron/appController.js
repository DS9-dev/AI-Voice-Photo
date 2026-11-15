'use strict';

/**
 * Bridge between the Core façade and the UI transport.
 * No Electron imports here: `ipcMain` and the event sink are injected, so the
 * same handlers are exercised by automated tests without Electron.
 */
const CHANNELS = Object.freeze([
  'app:snapshot',
  'chat:send',
  'chat:stop',
  'chat:clear',
  'mic:setMode',
  'config:update',
  'devices:list',
  'llm:refresh',
  'voice:restart',
  'characters:select',
  'characters:create',
  'characters:duplicate',
  'characters:delete',
  'characters:save',
  'characters:resetDescription',
  'characters:previewVoice',
  'avatar:info',
  'avatar:photo',
  'avatar:choosePhoto',
  'avatar:clearPhoto',
  'avatar:stats',
  'diag:get',
  'diag:resources',
  'diag:export',
]);

function createHandlers(companion, { pickPhoto = null } = {}) {
  return {
    'app:snapshot': () => companion.snapshot(),
    'chat:send': (p) => companion.sendText(p.text, p.route),
    'chat:stop': () => ({ stopped: companion.stop() }),
    'chat:clear': () => companion.clearSession(),
    'mic:setMode': (p) => companion.setMicMode(p.mode),
    'config:update': (p) => companion.updateConfig(p),
    'devices:list': () => companion.listDevices(),
    'llm:refresh': () => companion.refreshLlm(),
    'voice:restart': () => companion.restartVoiceService(),
    'characters:select': (p) => companion.selectCharacter(p.id),
    'characters:create': () => companion.createCharacter(),
    'characters:duplicate': (p) => companion.duplicateCharacter(p.id),
    'characters:delete': (p) => companion.deleteCharacter(p.id),
    'characters:save': (p) => companion.saveCharacter(p.id, p.fields),
    'characters:resetDescription': (p) => companion.resetCharacterDescription(p.id),
    'characters:previewVoice': (p) => companion.previewVoice({ voice: p.voice }),
    'avatar:info': () => companion.avatarInfo(),
    'avatar:photo': () => companion.photoData(),
    // the file dialog belongs to the shell (injected); the renderer never names a path itself
    'avatar:choosePhoto': async () => {
      if (!pickPhoto) throw new Error('No file dialog available');
      const file = await pickPhoto();
      return file ? { chosen: true, avatar: companion.setPhoto({ file }) } : { chosen: false, avatar: companion.avatarInfo() };
    },
    'avatar:clearPhoto': () => companion.clearPhoto(),
    'avatar:stats': () => companion.avatarStats(),
    'diag:get': () => companion.diagnostics(),
    'diag:resources': () => companion.getResources(),
    'diag:export': () => companion.exportDiagnostics(),
  };
}

/** Uniform result envelope so the renderer never sees a rejected IPC promise. */
async function dispatch(handlers, channel, payload) {
  const fn = handlers[channel];
  if (!fn) return { ok: false, error: `Unknown channel ${channel}` };
  try {
    return { ok: true, data: await fn(payload || {}) };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

function registerIpc({ ipcMain, companion, sendToUi, pickPhoto = null }) {
  const handlers = createHandlers(companion, { pickPhoto });
  for (const channel of CHANNELS) {
    ipcMain.handle(channel, (_event, payload) => dispatch(handlers, channel, payload));
  }
  companion.on('ui', (event) => sendToUi(event));
  return handlers;
}

module.exports = { CHANNELS, createHandlers, dispatch, registerIpc };
