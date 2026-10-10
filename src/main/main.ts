/**
 * Electron entry point. Creates the single workbench window, serves the
 * renderer over a private `wp://` scheme, and locks the window down:
 * no Node in the renderer, no new windows, no navigation away from the app,
 * and previewed pages confined to the loopback preview server.
 */

import { BrowserWindow, Menu, app, dialog, net, protocol, session, shell } from 'electron';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { pathToFileURL } from 'node:url';

import { mimeType } from '../shared/paths';
import { AppIpc } from './ipc';
import { buildMenu } from './menu';
import { SettingsStore, VaultSecretStore } from './settings';

const DIST = nodePath.resolve(__dirname, '..');
const RENDERER_DIR = nodePath.join(DIST, 'renderer');
const CANVAS_DIR = nodePath.join(DIST, 'canvas');
const APP_URL = 'wp://app/index.html';

// Tests point this at a throwaway folder so they never touch real settings.
if (process.env.WOVENPAGE_USER_DATA) app.setPath('userData', nodePath.resolve(process.env.WOVENPAGE_USER_DATA));

protocol.registerSchemesAsPrivileged([
  { scheme: 'wp', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let mainWindow: BrowserWindow | null = null;
let dirtyCount = 0;
let closing = false;
let ipc: AppIpc;

function initialProjectFromArgs(): string | null {
  const fromEnv = process.env.WOVENPAGE_OPEN;
  const candidates = [fromEnv, ...process.argv.slice(app.isPackaged ? 1 : 2)].filter((a): a is string => !!a && !a.startsWith('-'));
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return nodePath.resolve(candidate);
    } catch {
      /* not a folder */
    }
  }
  return null;
}

function serveRenderer(): void {
  protocol.handle('wp', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = nodePath.resolve(RENDERER_DIR, rel);
    if (file !== RENDERER_DIR && !file.startsWith(RENDERER_DIR + nodePath.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const response = await net.fetch(pathToFileURL(file).toString());
      const headers = new Headers(response.headers);
      headers.set('content-type', mimeType(file));
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function createWindow(): void {
  const settings = new SettingsStore();
  settings.get().initialProject = initialProjectFromArgs();
  const secrets = new VaultSecretStore();

  ipc = new AppIpc({
    window: () => mainWindow,
    settings,
    secrets,
    canvasDir: CANVAS_DIR,
    onDirtyCount: (count) => {
      dirtyCount = count;
    },
    closeNow: () => {
      closing = true;
      mainWindow?.close();
    },
  });
  ipc.register();

  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1000,
    minHeight: 620,
    show: false,
    title: 'Wovenpage',
    backgroundColor: settings.get().theme === 'indigo' ? '#161a2b' : '#e7ebe8',
    webPreferences: {
      preload: nodePath.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(buildMenu((command) => ipc.send('menu:command', command), () => mainWindow));

  const wc = mainWindow.webContents;

  // The workbench never navigates away from itself or opens child windows.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (!url.startsWith('wp://app/')) event.preventDefault();
  });
  // The canvas iframe may only show the local preview; anything else opens in the real browser.
  wc.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return;
    const origin = ipc.previewOrigin;
    const allowed = event.url === 'about:blank' || (origin !== null && event.url.startsWith(origin + '/'));
    if (!allowed) {
      event.preventDefault();
      if (/^https?:/i.test(event.url)) void shell.openExternal(event.url);
    }
  });

  mainWindow.on('close', (event) => {
    if (closing || dirtyCount === 0 || !mainWindow) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      message: dirtyCount === 1 ? 'One file has unsaved changes.' : `${dirtyCount} files have unsaved changes.`,
      detail: 'If you close without saving, those changes are lost.',
      buttons: ['Save all and close', 'Close without saving', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (choice === 0) ipc.send('app:save-and-close', null);
    else if (choice === 1) {
      closing = true;
      mainWindow.close();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // The window title is set by the app (site name), not by the page's <title>.
  mainWindow.on('page-title-updated', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  void mainWindow.loadURL(APP_URL);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    serveRenderer();
    // Previewed pages get no device permissions (camera, location, notifications...).
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    createWindow();
  });

  app.on('window-all-closed', () => {
    void ipc?.dispose().finally(() => app.quit());
  });
}
