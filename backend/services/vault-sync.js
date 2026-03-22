'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';
const SYNC_DEBOUNCE_MS = 30 * 1000;       // 30s after last file change
const PULL_INTERVAL_MS = 5 * 60 * 1000;   // 5 min pull cadence

let watcher = null;
let debounceTimer = null;
let pullTimer = null;
let syncing = false;

// Status tracking
const state = {
  enabled: false,
  lastSync: null,
  lastCommit: null,
  lastPull: null,
  lastError: null,
  filesChanged: 0,
  totalSyncs: 0,
};

// ── Git helpers ──────────────────────────────────────────────────────────

function git(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: VAULT_PATH, windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`git ${args[0]} failed: ${stderr || err.message}`));
      resolve(stdout.trim());
    });
  });
}

async function hasChanges() {
  const status = await git(['status', '--porcelain']);
  return status.length > 0;
}

async function syncVault(reason = 'manual') {
  if (!VAULT_PATH || syncing) return { skipped: true, reason: syncing ? 'already running' : 'no vault path' };
  syncing = true;
  const started = Date.now();

  try {
    // Stage all changes
    await git(['add', '-A']);

    // Commit only if there are staged changes
    const changed = await hasChanges();
    if (changed) {
      const now = new Date();
      const msg = `vault sync ${now.toISOString().replace('T', ' ').slice(0, 16)}`;
      await git(['commit', '-m', msg]);
      state.lastCommit = now.toISOString();
      console.log(`[VaultSync] Committed: ${msg} (${reason})`);
    }

    // Pull remote changes (rebase to keep history clean)
    try {
      await git(['pull', '--rebase', 'origin', 'main']);
      state.lastPull = new Date().toISOString();
    } catch (pullErr) {
      console.error('[VaultSync] Pull conflict — attempting resolution');
      // Try to finish rebase with local-wins strategy
      try {
        await git(['checkout', '--ours', '.']);
        await git(['add', '-A']);
        await git(['rebase', '--continue']);
      } catch {
        // Abort rebase and merge instead
        try { await git(['rebase', '--abort']); } catch {}
        try {
          await git(['merge', 'origin/main', '--strategy-option', 'ours', '-m', 'auto-merge: local wins']);
        } catch (mergeErr) {
          throw new Error(`Pull/merge failed: ${mergeErr.message}`);
        }
      }
      state.lastPull = new Date().toISOString();
    }

    // Push
    await git(['push', 'origin', 'main']);

    state.lastSync = new Date().toISOString();
    state.lastError = null;
    state.totalSyncs++;
    const elapsed = Date.now() - started;
    console.log(`[VaultSync] Complete in ${elapsed}ms (${reason})${changed ? ' — pushed new commit' : ' — no local changes'}`);
    return { ok: true, changed, elapsed };

  } catch (err) {
    state.lastError = { time: new Date().toISOString(), message: err.message, reason };
    console.error(`[VaultSync] Error (${reason}):`, err.message);
    return { ok: false, error: err.message };
  } finally {
    syncing = false;
  }
}

// ── File watcher ─────────────────────────────────────────────────────────

function startWatcher() {
  if (!VAULT_PATH || !fs.existsSync(VAULT_PATH)) {
    console.log('[VaultSync] Vault path not found — watcher disabled');
    return;
  }

  // Check it's actually a git repo
  if (!fs.existsSync(path.join(VAULT_PATH, '.git'))) {
    console.log('[VaultSync] Vault is not a git repo — watcher disabled');
    return;
  }

  const chokidar = require('chokidar');

  watcher = chokidar.watch(VAULT_PATH, {
    ignored: [
      /(^|[\/\\])\.git([\/\\]|$)/,      // .git folder
      /(^|[\/\\])\.obsidian([\/\\]|$)/,  // .obsidian config (synced separately)
      /\.DS_Store$/,
      /~$/,                               // temp files
    ],
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
  });

  watcher.on('all', (event, filePath) => {
    state.filesChanged++;
    // Debounce — wait 30s after last change before syncing
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      syncVault('file-change').catch(() => {});
    }, SYNC_DEBOUNCE_MS);
  });

  watcher.on('error', (err) => {
    console.error('[VaultSync] Watcher error:', err.message);
  });

  // Periodic pull every 5 minutes (catches remote changes)
  pullTimer = setInterval(() => {
    if (!syncing) {
      syncVault('scheduled-pull').catch(() => {});
    }
  }, PULL_INTERVAL_MS);

  state.enabled = true;
  console.log(`[VaultSync] Watching ${VAULT_PATH} — debounce ${SYNC_DEBOUNCE_MS / 1000}s, pull every ${PULL_INTERVAL_MS / 60000}m`);

  // Initial sync on startup (pull any remote changes)
  setTimeout(() => {
    syncVault('startup').catch(() => {});
  }, 5000);
}

function stop() {
  if (watcher) { watcher.close(); watcher = null; }
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (pullTimer) { clearInterval(pullTimer); pullTimer = null; }
  state.enabled = false;
  console.log('[VaultSync] Stopped');
}

function getStatus() {
  return {
    ...state,
    vaultPath: VAULT_PATH || null,
    vaultExists: VAULT_PATH ? fs.existsSync(VAULT_PATH) : false,
    syncing,
  };
}

module.exports = { start: startWatcher, stop, syncVault, getStatus };
