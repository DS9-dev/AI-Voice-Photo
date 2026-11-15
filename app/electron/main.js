'use strict';
// Electron main process: window + lifecycle only. All behaviour lives in core/.
const path = require('node:path');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { createCompanion } = require('../../core');
const { registerIpc } = require('./appController');

const ROOT = path.resolve(__dirname, '..', '..');
const SHUTDOWN_TIMEOUT_MS = 12000;
const SELF_TEST = process.argv.includes('--self-test');

let win = null;
let companion = null;
let quitting = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    frame: false,             // custom titlebar drawn by the renderer (reference-app pattern)
    backgroundColor: '#111318',
    title: 'AI Voice Photo',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.on('closed', () => { win = null; });
  win.loadFile(path.join(ROOT, 'app', 'renderer', 'index.html'));
}

/** Titlebar buttons of the frameless window. */
function onWindowControl(_event, action) {
  if (!win || win.isDestroyed()) return;
  if (action === 'close') win.close();
  else if (action === 'minimize') win.minimize();
  else if (action === 'maximize') {
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  }
}

/** File dialog for the avatar photo; resolves to a path or null. */
async function pickPhoto() {
  const res = await dialog.showOpenDialog(win, {
    title: 'Фото для AI Voice Photo',
    properties: ['openFile'],
    filters: [{ name: 'Изображения', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
  });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
}

function sendToUi(event) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('vvc:event', event);
  }
}

/** Stop everything this app started (the voice service). LM Studio is external. */
async function shutdown() {
  if (!companion) return;
  await Promise.race([
    companion.shutdown(),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
  ]);
}

function quitCleanly() {
  if (quitting) return;
  quitting = true;
  shutdown().catch(() => {}).finally(() => app.exit(0));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    companion = createCompanion({ rootDir: ROOT });
    registerIpc({ ipcMain, companion, sendToUi, pickPhoto });
    ipcMain.on('window:control', onWindowControl);
    createWindow();
    const started = companion.start().catch((err) => {
      console.error('Core failed to start:', err);
    });
    if (SELF_TEST) {
      // `electron . --self-test`: check the GUI, write a report, exit.
      const { runSelfTest } = require('./selfTest');
      started
        .then(() => runSelfTest({ win, companion, rootDir: ROOT, shutdown }))
        .then((result) => { quitting = true; app.exit(result.ok ? 0 : 1); })
        .catch((err) => { console.error('Self-test crashed:', err); quitting = true; shutdown().finally(() => app.exit(2)); });
    }
  });

  app.on('window-all-closed', () => quitCleanly());
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitCleanly();
  });
  process.on('SIGINT', quitCleanly);
  process.on('SIGTERM', quitCleanly);
}
