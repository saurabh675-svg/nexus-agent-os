import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const appPath = app.getAppPath();
const port = Number(process.env.PORT || 8787);
const origin = `http://127.0.0.1:${port}`;
let mainWindow;
let booted = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(start).catch(showStartupError);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (booted && BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

async function start() {
  process.env.NEXUS_DESKTOP = '1';
  process.env.PORT = String(port);
  process.env.NEXUS_DATA_DIR = process.env.NEXUS_DATA_DIR || (app.isPackaged
    ? app.getPath('userData')
    : path.join(appPath, 'data'));
  await import(pathToFileURL(path.join(appPath, 'server.js')).href);
  await waitForServer();
  booted = true;
  createWindow();
}

async function waitForServer() {
  const deadline = Date.now() + 30000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
      lastError = new Error(`Nexus returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Nexus did not become ready at ${origin}: ${lastError?.message || 'timeout'}`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(origin + '/') || url === origin) return;
    event.preventDefault();
    openExternal(url);
  });
  mainWindow.loadURL(origin);
}

function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') shell.openExternal(url);
  } catch {}
}

async function showStartupError(error) {
  await app.whenReady();
  await dialog.showMessageBox({
    type: 'error',
    title: 'Nexus could not start',
    message: 'The local Nexus service failed to start.',
    detail: String(error?.stack || error?.message || error),
  });
  app.quit();
}
