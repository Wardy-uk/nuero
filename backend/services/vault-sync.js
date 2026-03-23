'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';
const SYNC_DEBOUNCE_MS = 30 * 1000;       // 30s after last file change
const PULL_INTERVAL_MS = 5 * 60 * 1000;   // 5 min pull cadence
const CONFLICTS_DIR = 'Conflicts';

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
  lastConflict: null,
  conflicts: 0,
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

// Preserve remote versions of conflicting files before local-wins merge
async function preserveConflicts() {
  const saved = [];
  try {
    // Fetch latest remote so we can read their version
    await git(['fetch', 'origin', 'main']);

    // Find files that differ between local HEAD and remote
    const diffOutput = await git(['diff', '--name-only', 'HEAD', 'origin/main']);
    if (!diffOutput) return saved;

    const conflictDir = path.join(VAULT_PATH, CONFLICTS_DIR);
    if (!fs.existsSync(conflictDir)) fs.mkdirSync(conflictDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[T:]/g, '-').slice(0, 16);

    for (const filePath of diffOutput.split('\n').filter(Boolean)) {
      try {
        // Get the remote version of this file
        const remoteContent = await git(['show', `origin/main:${filePath}`]);
        // Get the local version
        const localPath = path.join(VAULT_PATH, filePath);
        const localContent = fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf-8') : null;

        // Only save if both versions exist and differ
        if (localContent !== null && remoteContent !== localContent) {
          const baseName = path.basename(filePath, '.md');
          const conflictFile = path.join(conflictDir, `${ts}-${baseName}.md`);
          const conflictContent = [
            '---',
            `type: sync-conflict`,
            `date: ${new Date().toISOString()}`,
            `original: ${filePath}`,
            `resolution: pending`,
            '---',
            '',
            `# Sync Conflict: ${baseName}`,
            `**File:** ${filePath}`,
            `**Detected:** ${new Date().toLocaleString('en-GB')}`,
            '',
            '## Remote Version (was on server)',
            '```',
            remoteContent,
            '```',
            '',
            '## Local Version (kept)',
            '```',
            localContent,
            '```',
            '',
            '> Review both versions and update the original file. Delete this conflict note when resolved.',
            ''
          ].join('\n');

          fs.writeFileSync(conflictFile, conflictContent, 'utf-8');
          saved.push(filePath);
          console.log(`[VaultSync] Conflict preserved: ${filePath} → ${CONFLICTS_DIR}/${ts}-${baseName}.md`);
        }
      } catch (e) {
        console.warn(`[VaultSync] Could not preserve conflict for ${filePath}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error('[VaultSync] preserveConflicts error:', e.message);
  }
  return saved;
}

// List unresolved conflict files
function getConflicts() {
  const conflictDir = path.join(VAULT_PATH, CONFLICTS_DIR);
  if (!VAULT_PATH || !fs.existsSync(conflictDir)) return [];
  try {
    return fs.readdirSync(conflictDir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const fullPath = path.join(conflictDir, f);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const originalMatch = content.match(/^original:\s*(.+)$/m);
        const resolutionMatch = content.match(/^resolution:\s*(.+)$/m);
        return {
          file: f,
          original: originalMatch ? originalMatch[1] : null,
          resolution: resolutionMatch ? resolutionMatch[1] : 'pending',
          date: fs.statSync(fullPath).mtime.toISOString()
        };
      })
      .filter(c => c.resolution === 'pending');
  } catch { return []; }
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
      console.error('[VaultSync] Pull conflict — preserving both versions');
      // Abort the failed rebase so we can handle conflicts safely
      try { await git(['rebase', '--abort']); } catch {}

      // Preserve conflicting remote content before merging
      const conflictFiles = await preserveConflicts();

      // Now merge with local-wins — but remote content is already saved
      try {
        await git(['merge', 'origin/main', '--strategy-option', 'ours', '-m',
          `auto-merge: local wins, ${conflictFiles.length} conflict(s) preserved in ${CONFLICTS_DIR}/`]);
      } catch (mergeErr) {
        throw new Error(`Pull/merge failed: ${mergeErr.message}`);
      }

      // Commit the conflict preservation files
      if (conflictFiles.length > 0) {
        await git(['add', '-A']);
        const hasNew = await hasChanges();
        if (hasNew) {
          await git(['commit', '-m', `preserve ${conflictFiles.length} conflict(s) in ${CONFLICTS_DIR}/`]);
        }

        state.conflicts += conflictFiles.length;
        state.lastConflict = new Date().toISOString();
        console.warn(`[VaultSync] ${conflictFiles.length} conflict(s) preserved in ${CONFLICTS_DIR}/`);

        // Send push notification about conflicts
        try {
          const webpush = require('./webpush');
          webpush.sendToAll('NEURO — Sync Conflict',
            `${conflictFiles.length} file(s) had conflicting changes. Both versions saved in ${CONFLICTS_DIR}/ — please review.`,
            { type: 'sync_conflict' }).catch(() => {});
        } catch {}
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
  const pendingConflicts = getConflicts();
  return {
    ...state,
    pendingConflicts: pendingConflicts.length,
    vaultPath: VAULT_PATH || null,
    vaultExists: VAULT_PATH ? fs.existsSync(VAULT_PATH) : false,
    syncing,
  };
}

module.exports = { start: startWatcher, stop, syncVault, getStatus, getConflicts };
