// SAiM desktop shell (Electron) — Phase 1.
//
// Loads the existing SAiM frontend in a desktop window and exposes an OS-level
// lock/wake bridge to the renderer. The renderer (usePresenceLock) keeps its in-app
// LockScreen overlay AND, on capable platforms (Windows), additionally drives the real
// OS lock + Windows-Hello wake via IPC. On the Pi the adapter is a no-op, so SAiM
// behaves exactly as the kiosk does today.
//
// Backend is assumed already running at SAIM_URL (Phase 2 bundles/spawns it).
const { app, BrowserWindow, ipcMain, powerMonitor } = require('electron');
const lockAdapter = require('./lock');

const SAIM_URL = process.env.SAIM_URL || 'http://localhost:3005/';
// How old the page may be before focusing the window refetches it. Ten minutes
// is long enough that alt-tabbing about does not reload anything, and short
// enough that a deploy reaches the desk the next time he looks at her.
const STALE_AFTER_MS = 10 * 60 * 1000;
let lastLoadedAt = 0;
const FULLSCREEN = process.env.SAIM_FULLSCREEN === '1';

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    fullscreen: FULLSCREEN,
    backgroundColor: '#0b0f14',
    title: 'SAiM',
    webPreferences: {
      preload: require('path').join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  // ⚠ SAiM.vbs launches with window style 0 so no console is ever created — and
  // Windows passes that SW_HIDE to the process, which the FIRST ShowWindow call
  // obeys. So she started, ran, and never appeared (11 Sep 2026: four live
  // processes, no window handle). The first show is spent hidden; asking again
  // is a normal show. A console launch is unaffected — she is already visible.
  win.once('ready-to-show', () => { if (!win.isVisible()) win.show(); });
  setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) win.show(); }, 3000);
  const ses = win.webContents.session;
  await ses.clearCache().catch(() => {});
  await ses.clearStorageData({
    storages: ['serviceworkers', 'cachestorage'],
  }).catch(() => {});
  win.loadURL(SAIM_URL);
  lastLoadedAt = Date.now();

  // ⚠ THE DESKTOP WINDOW NEVER UPDATED ITSELF. The kiosk gets its browser
  // restarted by `lwrespawn` and the phone reloads whenever it is opened; this
  // window is long-lived on a laptop, so a page loaded on Sunday was still on
  // screen on Monday showing a build from the previous evening — and Nick read
  // that as the deploy having failed, which it had not. The cache and the
  // service worker were both innocent; nothing had asked for the page again.
  //
  // Reloaded when the window is FOCUSED and the page is older than
  // `STALE_AFTER_MS`. Focus is the right trigger because it is the moment he is
  // about to read it and the moment he is not reading anything else; a timer
  // would reload the page out from under him mid-sentence.
  win.on('focus', () => {
    if (win.isDestroyed()) return;
    if (Date.now() - lastLoadedAt < STALE_AFTER_MS) return;
    lastLoadedAt = Date.now();
    win.webContents.reload();
  });
  return win;
}

// --- OS lock/wake bridge (renderer -> main) -------------------------------------
ipcMain.handle('saim:capabilities', () => ({
  platform: process.platform,
  osLock: !!lockAdapter.canOSLock,
  adapter: lockAdapter.name,
}));
ipcMain.handle('saim:lock', async () => {
  try {
    return { ok: await lockAdapter.lock() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});
ipcMain.handle('saim:wake', async () => {
  try {
    return { ok: await lockAdapter.wake() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});
// Pull SAiM to the front (or release) so the "Locking…" countdown is visible over
// whatever app you're in. Used only during the grace countdown, when you've stopped
// interacting anyway — so stealing focus isn't disruptive.
ipcMain.handle('saim:attention', (_e, on) => {
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

// --- Watch presence → OS lock (main process) ------------------------------------
// See presenceLock.js for why this is decided HERE rather than in whichever SAiM
// build the window happens to load. Off with SAIM_PRESENCE_LOCK=0; a no-op where
// the adapter cannot lock (the Pi), and blind — never locking — while the Watch
// reporter's file is missing or stale.
const fs = require('fs');
const path = require('path');
const { Notification } = require('electron');
const presenceLock = require('./presenceLock');
const PRESENCE_FILE = process.env.WATCH_STATUS_FILE
  || path.resolve(__dirname, '..', '..', 'windows-watch-lock', 'presence.json');
let presence = presenceLock.initialState();
let warning = null;
let lastBlindWhy = null;

function readPresence() {
  try { return JSON.parse(fs.readFileSync(PRESENCE_FILE, 'utf8')); } catch { return null; }
}

function startPresenceLock() {
  if (process.env.SAIM_PRESENCE_LOCK === '0' || !lockAdapter.canOSLock) return;
  console.log(`[SAiM] presence lock watching ${PRESENCE_FILE}`);
  powerMonitor.on('lock-screen', () => { presence = { ...presence, graceUntil: null, awayCount: 0 }; });
  setInterval(async () => {
    const payload = readPresence();
    const now = Date.now();
    const r = presenceLock.assessReading(payload, now);
    // Say once when she goes blind, so a dead reporter is findable in the log
    // rather than being a lock that simply never happens.
    const why = r.known ? null : r.why;
    if (why !== lastBlindWhy) { console.log(`[SAiM] presence ${why ? 'blind: ' + why : 'reading again'}`); lastBlindWhy = why; }

    const { state, action } = presenceLock.step(presence, { payload, now, idleS: powerMonitor.getSystemIdleTime() });
    presence = state;
    if (action === 'warn') {
      if (Notification.isSupported()) {
        warning = new Notification({ title: 'SAiM', body: 'Your Watch has gone — locking in 5 seconds. Move the mouse to stop it.', silent: true });
        warning.show();
      }
    } else if (action === 'cancel-warn') {
      warning?.close(); warning = null;
    } else if (action === 'lock') {
      warning?.close(); warning = null;
      await lockAdapter.lock();
    } else if (action === 'wake') {
      await lockAdapter.wake();
    }
  }, 2000).unref?.();
}

// Single-instance guard. A second launch (stray shortcut, autostart, an unlock-time
// relaunch) must NOT open a duplicate window with its own state — that's how you end up
// with one SAiM still showing the lock overlay while a fresh one boots. Instead the
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
      mainWindow.webContents.reloadIgnoringCache();
    }
  });

  app.whenReady().then(async () => {
    mainWindow = await createWindow();
    startPresenceLock();
    // When Windows itself is unlocked (Hello), tell the renderer so SAiM's privacy
    // overlay lifts too — the OS already re-authenticated, no second tap needed.
    powerMonitor.on('unlock-screen', () => {
      presence = presenceLock.onOSUnlocked(presence);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('saim:os-unlocked');
    });
    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = await createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
