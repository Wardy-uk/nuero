// SARA desktop shell (Electron) — Phase 1.
//
// Loads the existing SARA frontend in a desktop window and exposes an OS-level
// lock/wake bridge to the renderer. The renderer (usePresenceLock) keeps its in-app
// LockScreen overlay AND, on capable platforms (Windows), additionally drives the real
// OS lock + Windows-Hello wake via IPC. On the Pi the adapter is a no-op, so SARA
// behaves exactly as the kiosk does today.
//
// Backend is assumed already running at SARA_URL (Phase 2 bundles/spawns it).
const { app, BrowserWindow, ipcMain, powerMonitor } = require('electron');
const lockAdapter = require('./lock');

const SARA_URL = process.env.SARA_URL || 'http://localhost:3005/';
const FULLSCREEN = process.env.SARA_FULLSCREEN === '1';

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    fullscreen: FULLSCREEN,
    backgroundColor: '#0b0f14',
    title: 'SARA',
    webPreferences: {
      preload: require('path').join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadURL(SARA_URL);
  return win;
}

// --- OS lock/wake bridge (renderer -> main) -------------------------------------
ipcMain.handle('sara:capabilities', () => ({
  platform: process.platform,
  osLock: !!lockAdapter.canOSLock,
  adapter: lockAdapter.name,
}));
ipcMain.handle('sara:lock', async () => {
  try {
    return { ok: await lockAdapter.lock() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});
ipcMain.handle('sara:wake', async () => {
  try {
    return { ok: await lockAdapter.wake() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});
// Pull SARA to the front (or release) so the "Locking…" countdown is visible over
// whatever app you're in. Used only during the grace countdown, when you've stopped
// interacting anyway — so stealing focus isn't disruptive.
ipcMain.handle('sara:attention', (_e, on) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (on) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.show();
    mainWindow.focus();
  } else {
    mainWindow.setAlwaysOnTop(false);
  }
  return true;
});

// Single-instance guard. A second launch (stray shortcut, autostart, an unlock-time
// relaunch) must NOT open a duplicate window with its own state — that's how you end up
// with one SARA still showing the lock overlay while a fresh one boots. Instead the
// second process quits and we focus/restore the window that's already running.
let mainWindow = null;
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    mainWindow = createWindow();
    // When Windows itself is unlocked (Hello), tell the renderer so SARA's privacy
    // overlay lifts too — the OS already re-authenticated, no second tap needed.
    powerMonitor.on('unlock-screen', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sara:os-unlocked');
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
