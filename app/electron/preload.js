'use strict';
// Runs in the sandboxed preload context. Exposes a minimal, allow-listed API.
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = [
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
];

contextBridge.exposeInMainWorld('vvc', {
  invoke(channel, payload) {
    if (!CHANNELS.includes(channel)) return Promise.resolve({ ok: false, error: `Unknown channel ${channel}` });
    return ipcRenderer.invoke(channel, payload);
  },
  /** close | minimize | maximize (the window is frameless) */
  windowControl(action) {
    if (['close', 'minimize', 'maximize', 'fullscreen-on', 'fullscreen-off'].includes(action)) ipcRenderer.send('window:control', action);
  },
  onEvent(callback) {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('vvc:event', listener);
    return () => ipcRenderer.removeListener('vvc:event', listener);
  },
});
