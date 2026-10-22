'use strict';

/**
 * Task context — the store, the nightly scan, manual links and the read model
 * (22 Oct 2026). The judgement lives in task-context-model.js (PURE).
 *
 * WHAT IT IS: a small, inspectable layer of vault material pinned to an open
 * task — a note, a project folder or an area — with the reason it is there and
 * whether SAiM found it or Nick put it there. It is shown wherever the task is
 * worked on (the task card, Now, a prepared move, meeting prep, MCP).
 *
 * WHAT IT NEVER DOES:
 *  - write to the vault. Not on a scan, not on a read, not on an empty run.
 *    A link is a row in NEURO's DB; the source note is never touched.
 *  - delete a decision. Removing a link marks it `removed`; the scan never
 *    re-pins a pair Nick removed, and a manual re-link revives it.
 *  - guess between two plausible scopes. It stores ONE question instead.
 *  - read a vault file on a GET for one task. Everything a card shows was
 *    captured when the link was made or refreshed (search is the exception:
 *    looking for something to link is, by definition, a vault read).
 *
 * Tables are created by the first WRITE (a scan or a link). A NEURO that never
 * scans has none, and reads answer as empty rather than creating them.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const model = require('./task-context-model');

const RUN_RETENTION = 60;
const SEARCH_LIMIT = 15;

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const iso = (ms) => new Date(ms).toISOString();

// ── storage ──────────────────────────────────────────────────────────────────

let _ready = false;
function ensure() {
  if (_ready && _exists()) return;
  const x = db.getDb();
  x.exec(`CREATE TABLE IF NOT EXISTS task_context_links (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       INTEGER NOT NULL,
    source_type   TEXT NOT NULL CHECK (source_type IN ('note','project','area')),
    source_ref    TEXT NOT NULL,
    title         TEXT NOT NULL,
    preview       TEXT,
    origin        TEXT NOT NULL CHECK (origin IN ('nightly-scan','manual','mcp')),
    state         TEXT NOT NULL CHECK (state IN ('pinned','suggested','stale','removed')),
    stale_from    TEXT,
    stale_reason  TEXT,
    confidence    REAL,
    reasons_json  TEXT NOT NULL DEFAULT '[]',
    restricted    INTEGER NOT NULL DEFAULT 0,
    scope_json    TEXT,
    source_hash   TEXT,
    source_mtime  TEXT,
    source_changed_at TEXT,
    linked_by     TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    removed_at    TEXT,
    removed_by    TEXT,
    UNIQUE (task_id, source_type, source_ref)
  )`);
  x.exec('CREATE INDEX IF NOT EXISTS idx_task_context_task ON task_context_links(task_id, state)');
  x.exec(`CREATE TABLE IF NOT EXISTS task_context_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    trigger      TEXT NOT NULL,
    ok           INTEGER NOT NULL DEFAULT 0,
    receipt_json TEXT NOT NULL DEFAULT '{}',
    error        TEXT
  )`);
  x.exec(`CREATE TABLE IF NOT EXISTS task_context_questions (
    task_id      INTEGER PRIMARY KEY,
    question     TEXT NOT NULL,
    options_json TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    dismissed_at TEXT
  )`);
  _ready = true;
}

function _exists() {
  try { return Boolean(db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='task_context_links'`)); } catch { return false; }
}

function _row(r) {
  if (!r) return null;
  const reasons = (() => { try { return JSON.parse(r.reasons_json || '[]'); } catch { return []; } })();
  const scope = (() => { try { return r.scope_json ? JSON.parse(r.scope_json) : null; } catch { return null; } })();
  return {
    id: r.id, taskId: r.task_id, type: r.source_type, ref: r.source_ref, title: r.title,
    preview: r.restricted ? null : r.preview, restricted: Boolean(r.restricted),
    origin: r.origin, originLabel: model.ORIGIN_LABEL[r.origin] || r.origin, automatic: r.origin === 'nightly-scan',
    state: r.state, staleFrom: r.stale_from || null, staleReason: r.stale_reason || null,
    staleSay: r.stale_reason ? (model.STALE_SAY[r.stale_reason] || r.stale_reason) : null,
    confidence: r.confidence, reasons, reason: model.reasonLine({ origin: r.origin, reasons }),
    scopeItems: scope && Array.isArray(scope.items) ? scope.items : (r.source_type === 'note' ? null : []),
    open: r.source_type === 'note' ? { kind: 'note', path: r.source_ref } : { kind: 'folder', path: r.source_ref },
    linkedBy: r.linked_by || null, createdAt: r.created_at, updatedAt: r.updated_at,
    sourceChangedAt: r.source_changed_at || null, removedAt: r.removed_at || null,
  };
}

// ── the vault ────────────────────────────────────────────────────────────────

function vaultRoot() {
  const v = process.env.OBSIDIAN_VAULT_PATH;
  if (!v || !path.isAbsolute(v)) return { ok: false, why: 'OBSIDIAN_VAULT_PATH is not set' };
  try { if (!fs.statSync(v).isDirectory()) return { ok: false, why: 'the vault path is not a folder' }; } catch { return { ok: false, why: 'the vault could not be read' }; }
  return { ok: true, root: v };
}

function _deps(allPaths) {
  const ex = require('./vault-exclusions');
  let roster = null;
  try { roster = require('./entities').getRoster(); } catch { roster = { full: [] }; }
  const pm = require('./prepared-move');
  return {
    isExcludedPath: (r) => ex.isExcludedPath(r),
    isSensitivePath: (r) => ex.isSensitivePath(r),
    exists: (r) => allPaths.has(r),
    employmentScreen: ({ sourceTitle, sourceText }) => pm.employmentScreen({ sourceTitle, sourceText, roster }),
  };
}

function _tokenize() {
  const dedupe = require('./task-dedupe'); // lazily: task-dedupe ↔ task-store is a real cycle
  return (s) => dedupe.tokenize(s);
}

/**
 * READ-ONLY. Every note in the vault, screened; the eligible ones indexed.
 * Infrastructure folders (.obsidian, .stversions, lint backups) are not walked.
 */
function buildIndex({ root, nowMs = Date.now() } = {}) {
  const walk = require('./vault-walk');
  const ex = require('./vault-exclusions');
  const files = [];
  const traversal = walk.walk(root, {
    skipDir: (name) => ex.INFRA_DIRS.includes(name) || name === 'node_modules',
    skipFile: (rel) => !rel.toLowerCase().endsWith('.md'),
    visit: (rel, full) => files.push({ rel, full }),
  });
  const allPaths = new Set(files.map((f) => f.rel));
  const deps = _deps(allPaths);
  const tokenize = _tokenize();
  const byRel = new Map();
  const notes = [];
  const skipped = {};
  for (const f of files) {
    let text = null; let mtimeMs = null;
    try { text = fs.readFileSync(f.full, 'utf8'); mtimeMs = fs.statSync(f.full).mtimeMs; } catch { /* unreadable */ }
    const hash = text == null ? null : sha(text);
    const { fm, body } = model.splitNote(text || '');
    const screen = model.screenNote({ rel: f.rel, fm, body, readable: text != null }, deps);
    const entry = { rel: f.rel, exists: true, hash, mtimeMs, screen, text };
    if (screen.ok) {
      const n = model.indexNote({ rel: f.rel, text, mtimeMs, hash }, tokenize);
      entry.note = n;
      notes.push(n);
    } else {
      skipped[screen.reason] = (skipped[screen.reason] || 0) + 1;
      if (screen.restricted || screen.reason === 'employment-sensitive') entry.restricted = true;
    }
    byRel.set(f.rel, entry);
  }
  return { notes, byRel, skipped, scanned: files.length, traversal, stats: model.corpusStats(notes, tokenize), tokenize, nowMs };
}

/** Projects and areas the vault holds, as scopes { type, ref, name }. */
function listScopes(root) {
  const out = [];
  try {
    const pv = require('./projects').readVault({ vaultRoot: root, fresh: true });
    // Projects/Working is SAiM's private-drafts folder (private-brief.WORKING_FOLDER), not a project.
    for (const p of pv.projects || []) if (!/^Projects\/Working$/i.test(p.vaultPath)) out.push({ type: 'project', ref: p.vaultPath, name: p.name, projectId: p.projectId });
  } catch { /* no projects read: none offered, never invented */ }
  try {
    for (const d of fs.readdirSync(path.join(root, 'Areas'), { withFileTypes: true })) {
      const name = d.isDirectory() ? d.name : d.name.replace(/\.md$/i, '');
      if (!name || name.startsWith('_') || name.startsWith('.') || (!d.isDirectory() && !/\.md$/i.test(d.name))) continue;
      if (/^1-2-1 Tracker$/i.test(name)) continue; // generated
      if (!out.some((s) => s.type === 'area' && s.name === name)) out.push({ type: 'area', ref: `Areas/${name}`, name });
    }
  } catch { /* no Areas/ */ }
  return out;
}

function _openTasks() {
  return db.listTaskRows({ status: 'all', includeDone: false }).filter((r) => r.status === 'open' || r.status === 'in-progress');
}

function _projectLinksByTask(scopes) {
  const byId = new Map(scopes.filter((s) => s.type === 'project').map((s) => [s.projectId, s.ref]));
  const out = new Map();
  try {
    for (const r of db.all(`SELECT project_id, task_id FROM project_task_links WHERE state = 'linked'`)) {
      const ref = byId.get(r.project_id);
      if (!ref) continue;
      if (!out.has(r.task_id)) out.set(r.task_id, []);
      out.get(r.task_id).push(ref);
    }
  } catch { /* table absent: no explicit links */ }
  return out;
}

// ── activation: the scan is OFF until Nick turns it on (22 Oct 2026) ─────────
//
// ⚠ Deploying this must not silently perform the backfill. The first automatic run
// over the current vault IS the backfill, and that waits until the vault cleanup is
// approved and done. So the scheduled job is registered and visible but does
// nothing — no scan, no pins, no suggestions, no stale marks, no run receipt, not
// even a table — until Nick enables it in NEURO. Enabling runs the backfill there
// and then, deliberately; the 03:40 job continues from the next night. Manual
// linking and search work throughout. A machine can neither enable it nor scan.

const ACTIVATION_KEY = 'task_context_activation';
const WAITING_SAY = 'Automatic context linking is off — it is waiting for the vault cleanup to be approved and done. The first run after you enable it is the backfill.';
const ENABLE_SAY = 'Enabling scans every open task against the whole vault NOW (the backfill), pins only high-confidence context, keeps lower-confidence matches as suggestions, and then runs every night at 03:40. Nothing is written to the vault. Links you made by hand and links you removed are kept as they are.';

function activation() {
  let a = null;
  try { a = JSON.parse(db.getState(ACTIVATION_KEY) || 'null'); } catch { a = null; }
  return a && typeof a === 'object' ? a : { enabled: false };
}
function enabled() { return activation().enabled === true; }

/** READ. Whether automatic linking runs, and what Nick would be agreeing to. Creates nothing. */
function status() {
  const a = activation();
  return {
    ok: true, enabled: a.enabled === true, enabledAt: a.enabledAt || null, enabledBy: a.enabledBy || null,
    disabledAt: a.disabledAt || null, backfill: a.backfill || null, schedule: 'Every night at 03:40',
    say: a.enabled === true ? `Automatic context linking is on — every night at 03:40${a.backfill && a.backfill.at ? `; the backfill ran ${a.backfill.at}` : ''}.` : WAITING_SAY,
    enableSay: ENABLE_SAY,
    lastRun: lastRun(),
  };
}

/**
 * Nick turns automatic linking on. Runs the backfill NOW; if it fails, nothing is
 * enabled (an "on" switch over a scan that never ran is a light nobody earned).
 * Refused to anyone but Nick, and refused without the explicit confirmation.
 */
function activate({ by = 'nick', confirm = false, now = Date.now() } = {}) {
  if (by !== 'nick') return { ok: false, status: 403, error: 'Only Nick, in NEURO, can turn on automatic context linking.' };
  if (confirm !== true) return { ok: false, status: 400, error: 'Confirm first — enabling runs the backfill straight away.', enableSay: ENABLE_SAY };
  if (enabled()) return { ok: true, already: true, status: status() };
  const prev = activation();
  db.setState(ACTIVATION_KEY, JSON.stringify({ ...prev, enabled: true, enabledAt: iso(now), enabledBy: by, disabledAt: null }));
  const r = runScan({ now, trigger: 'backfill' });
  if (!r.ok) {
    db.setState(ACTIVATION_KEY, JSON.stringify({ ...prev, enabled: false }));
    return { ok: false, status: r.busy ? 409 : 500, error: `The backfill did not complete, so automatic linking was NOT turned on: ${r.error || 'unknown'}`, receipt: r.receipt || null };
  }
  db.setState(ACTIVATION_KEY, JSON.stringify({ enabled: true, enabledAt: iso(now), enabledBy: by, disabledAt: null, backfill: { runId: r.runId, at: iso(now), receipt: r.receipt } }));
  _log('task-context-enabled', { by, runId: r.runId });
  return { ok: true, backfill: r.receipt, runId: r.runId, status: status() };
}

/** Nick turns it off again. Links stay exactly as they are. */
function deactivate({ by = 'nick', now = Date.now() } = {}) {
  if (by !== 'nick') return { ok: false, status: 403, error: 'Only Nick, in NEURO, can turn automatic context linking off.' };
  const a = activation();
  if (!a.enabled) return { ok: true, already: true, status: status() };
  db.setState(ACTIVATION_KEY, JSON.stringify({ ...a, enabled: false, disabledAt: iso(now) }));
  _log('task-context-disabled', { by });
  return { ok: true, status: status() };
}

// ── the nightly scan ─────────────────────────────────────────────────────────

let _running = false;

/**
 * The scan. Idempotent: an unchanged vault and task list change no row.
 * Writes ONLY NEURO's own tables; returns the compact receipt it also stores.
 */
function runScan({ now = Date.now(), trigger = 'nightly' } = {}) {
  // ⚠ The activation boundary. Checked BEFORE ensure(): a disabled scan creates no
  // table, writes no receipt and touches no link. There is no exemption: activate()
  // turns the switch on first, then runs the backfill through this same door.
  if (!enabled()) return { ok: false, disabled: true, status: 409, error: WAITING_SAY };
  const v = vaultRoot();
  if (_running) return { ok: false, busy: true, error: 'A scan is already running.' };
  ensure();
  const startedAt = iso(now);
  const runId = db.run(`INSERT INTO task_context_runs (started_at, trigger) VALUES (?, ?)`, [startedAt, trigger]).lastInsertRowid;
  _running = true;
  const receipt = { tasks: 0, notesScanned: 0, notesEligible: 0, pinned: 0, suggested: 0, refreshed: 0, unchanged: 0, stale: 0, restored: 0, questions: 0, skipped: {}, skippedSay: {}, truncated: false };
  try {
    if (!v.ok) throw new Error(v.why);
    const ix = buildIndex({ root: v.root, nowMs: now });
    receipt.notesScanned = ix.scanned;
    receipt.notesEligible = ix.notes.length;
    receipt.skipped = ix.skipped;
    receipt.truncated = Boolean(ix.traversal && ix.traversal.truncated);
    // ⚠ A vault that suddenly reads empty (an unmounted disk, a sync mid-write)
    // is not evidence that every note went. Below half of the last good run's
    // count, nothing is marked stale and the receipt says why.
    const prev = _lastGoodScanned();
    receipt.shrunk = ix.scanned === 0 || (prev >= 20 && ix.scanned < prev / 2);
    if (receipt.shrunk) receipt.shrunkSay = `Only ${ix.scanned} note(s) readable against ${prev} last time — nothing was marked stale.`;
    for (const k of Object.keys(ix.skipped)) receipt.skippedSay[k] = model.SKIP_SAY[k] || k;
    const scopes = listScopes(v.root);
    const projectLinks = _projectLinksByTask(scopes);
    const tasks = _openTasks();
    receipt.tasks = tasks.length;
    const nowIso = iso(now);
    const tx = db.getDb().transaction(() => {
      for (const t of tasks) _scanTask(t, { ix, scopes, projectLinks: projectLinks.get(t.id) || [], nowIso, now, receipt, partial: receipt.truncated || receipt.shrunk });
    });
    tx();
    db.run(`UPDATE task_context_runs SET finished_at = ?, ok = 1, receipt_json = ? WHERE id = ?`, [iso(Date.now()), JSON.stringify(receipt), runId]);
    _prune();
    return { ok: true, runId, receipt };
  } catch (e) {
    db.run(`UPDATE task_context_runs SET finished_at = ?, ok = 0, receipt_json = ?, error = ? WHERE id = ?`, [iso(Date.now()), JSON.stringify(receipt), String(e.message || e).slice(0, 300), runId]);
    return { ok: false, runId, receipt, error: e.message };
  } finally {
    _running = false;
  }
}

function _lastGoodScanned() {
  const rows = db.all(`SELECT receipt_json FROM task_context_runs WHERE ok = 1 ORDER BY id DESC LIMIT 5`);
  for (const r of rows) {
    try { const x = JSON.parse(r.receipt_json || '{}'); if (!x.shrunk && x.notesScanned > 0) return x.notesScanned; } catch { /* next */ }
  }
  return 0;
}

function _prune() {
  db.run(`DELETE FROM task_context_runs WHERE id NOT IN (SELECT id FROM task_context_runs ORDER BY id DESC LIMIT ${RUN_RETENTION})`);
}

function _existing(taskId) {
  return db.all(`SELECT * FROM task_context_links WHERE task_id = ?`, [taskId]);
}

function _scanTask(t, { ix, scopes, projectLinks, nowIso, now, receipt, partial }) {
  const task = model.indexTask(t, ix.tokenize, { projectLinks });
  const existing = new Map(_existing(t.id).map((r) => [`${r.source_type}|${r.source_ref}`, r]));

  // 1. notes
  const found = [];
  for (const n of ix.notes) {
    if (n.domain === 'personal' && task.domain !== 'personal') continue; // never across the work/personal line
    const s = model.scoreNote(task, n, ix.stats, now);
    if (s) found.push({ n, s });
  }
  // The note the task was raised in, even when its screen withheld it from general
  // matching — it is this task's OWN source. A sensitive one is pinned restricted.
  // Any OTHER withheld origin (a daily note, an import) is where the task was
  // captured, not context worth pinning — it stays out.
  if (task.originPath && ix.byRel.has(task.originPath) && !found.some((f) => f.n.rel === task.originPath)) {
    const e = ix.byRel.get(task.originPath);
    if (e.screen.reason === 'employment-sensitive' || e.screen.reason === 'restricted') {
      const { body } = model.splitNote(e.text || '');
      found.push({ n: { rel: e.rel, title: model.titleOf(e.rel), preview: model.previewOf(body), hash: e.hash, mtimeMs: e.mtimeMs, restricted: true },
        s: { level: 'pin', confidence: 0.95, reasons: [{ code: 'origin', say: 'This task was raised in this note.' }] } });
    }
  }
  found.sort((a, b) => b.s.confidence - a.s.confidence || (b.n.mtimeMs || 0) - (a.n.mtimeMs || 0) || a.n.rel.localeCompare(b.n.rel));
  const pins = found.filter((f) => f.s.level === 'pin').slice(0, model.MAX_AUTO_PINS);
  const extra = found.filter((f) => f.s.level === 'pin').slice(model.MAX_AUTO_PINS);
  const sugg = [...found.filter((f) => f.s.level === 'suggest'), ...extra].slice(0, model.MAX_SUGGESTIONS);
  const wanted = new Map();
  for (const f of pins) wanted.set(`note|${f.n.rel}`, { type: 'note', ref: f.n.rel, title: f.n.title, preview: f.n.preview, hash: f.n.hash, mtimeMs: f.n.mtimeMs, state: 'pinned', confidence: f.s.confidence, reasons: f.s.reasons, restricted: Boolean(f.n.restricted) });
  for (const f of sugg) if (!wanted.has(`note|${f.n.rel}`)) wanted.set(`note|${f.n.rel}`, { type: 'note', ref: f.n.rel, title: f.n.title, preview: f.n.preview, hash: f.n.hash, mtimeMs: f.n.mtimeMs, state: 'suggested', confidence: Math.min(f.s.confidence, 0.7), reasons: f.s.reasons, restricted: false });

  // 2. scopes: the project/area the task came from or is linked to (pin);
  //    one the wording names (suggest); two or more named → ask, never guess.
  const scopeWant = new Map();
  if (task.project && scopes.some((s) => s.ref === task.project)) scopeWant.set(`project|${task.project}`, { state: 'pinned', confidence: 0.9, reasons: [{ code: 'origin-folder', say: 'The task came from this project’s folder.' }] });
  for (const ref of projectLinks) scopeWant.set(`project|${ref}`, { state: 'pinned', confidence: 0.95, reasons: [{ code: 'project-link', say: 'You linked this task to the project in NEURO.' }] });
  if (task.area && scopes.some((s) => s.ref === task.area)) scopeWant.set(`area|${task.area}`, { state: 'pinned', confidence: 0.85, reasons: [{ code: 'origin-folder', say: 'The task came from this area.' }] });
  const named = model.namedScopes(t.text, scopes).filter((s) => !scopeWant.has(`${s.type}|${s.ref}`));
  const namedProjects = named.filter((s) => s.type === 'project');
  const hasProject = [...scopeWant.keys()].some((k) => k.startsWith('project|'));
  if (namedProjects.length >= 2 && !hasProject) {
    _ask(t.id, 'Which project is this task part of?', namedProjects.map((s) => ({ type: 'project', ref: s.ref, title: s.name })), nowIso, receipt);
  } else {
    for (const s of named) {
      if (s.type === 'project' && hasProject) continue;
      scopeWant.set(`${s.type}|${s.ref}`, { state: 'suggested', confidence: 0.6, reasons: [{ code: 'named', say: `The task names ${s.type === 'project' ? 'this project' : 'this area'}.` }] });
    }
  }
  for (const [key, w] of scopeWant) {
    const [type, ref] = key.split('|');
    const sc = scopes.find((s) => s.ref === ref);
    const items = model.scopeItems(task, ix.notes, ref, ix.stats);
    wanted.set(key, { type, ref, title: sc ? sc.name : ref.split('/').pop(), preview: null, hash: sha(JSON.stringify(items)), mtimeMs: null, state: w.state, confidence: w.confidence, reasons: w.reasons, scope: { items }, restricted: false });
  }

  // 3. apply: add new, refresh changed, mark what no longer holds — never touch a removal.
  for (const [key, w] of wanted) {
    const row = existing.get(key);
    if (!row) {
      _insert(t.id, w, 'nightly-scan', null, nowIso);
      receipt[w.state === 'pinned' ? 'pinned' : 'suggested'] += 1;
      continue;
    }
    // A removal is Nick's decision. (A stated second guard: _refresh never changes a
    // `removed` state either, which is why mutating this line alone survives.)
    if (row.state === 'removed') continue;
    _refresh(row, w, nowIso, receipt, { upgrade: row.origin === 'nightly-scan' });
  }
  for (const [key, row] of existing) {
    // A partial read (capped walk, a vault that suddenly reads small) concludes nothing about absence.
    if (wanted.has(key) || row.state === 'removed' || partial) continue;
    if (row.source_type !== 'note') {
      // A scope Nick linked stays. An automatic one whose basis went (task moved) goes stale.
      if (row.origin === 'nightly-scan' && row.state !== 'stale' && !partial) _markStale(row, 'no-longer-matches', nowIso, receipt);
      else if (row.origin !== 'nightly-scan') _refreshScope(row, task, ix, nowIso, receipt);
      continue;
    }
    const e = ix.byRel.get(row.source_ref);
    if (!e) { if (!partial && row.state !== 'stale') _markStale(row, 'gone', nowIso, receipt); continue; }
    if (row.origin !== 'nightly-scan') {
      // Manual: never re-judged, only refreshed. A note now in a skipped place stays — Nick chose it.
      _refreshNote(row, e, nowIso, receipt);
      continue;
    }
    if (row.state !== 'stale' && !partial) _markStale(row, e.screen.ok ? 'no-longer-matches' : 'excluded', nowIso, receipt);
  }
}

function _insert(taskId, w, origin, by, nowIso) {
  db.run(`INSERT INTO task_context_links (task_id, source_type, source_ref, title, preview, origin, state, confidence, reasons_json, restricted, scope_json, source_hash, source_mtime, linked_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [taskId, w.type, w.ref, w.title, w.restricted ? null : (w.preview || null), origin, w.state, w.confidence ?? null, JSON.stringify(w.reasons || []), w.restricted ? 1 : 0,
    w.scope ? JSON.stringify(w.scope) : null, w.hash || null, w.mtimeMs ? iso(w.mtimeMs) : null, by, nowIso, nowIso]);
}

function _refresh(row, w, nowIso, receipt, { upgrade }) {
  const sets = []; const vals = [];
  const set = (col, val) => { sets.push(`${col} = ?`); vals.push(val); };
  if (row.state === 'stale') {
    set('state', row.stale_from || w.state); set('stale_from', null); set('stale_reason', null);
    receipt.restored += 1;
  } else if (upgrade && row.state === 'suggested' && w.state === 'pinned') {
    set('state', 'pinned'); receipt.pinned += 1;
  }
  if ((w.hash || null) !== (row.source_hash || null)) {
    set('title', w.title); set('preview', w.restricted ? null : (w.preview || null)); set('source_hash', w.hash || null);
    set('source_mtime', w.mtimeMs ? iso(w.mtimeMs) : row.source_mtime); set('source_changed_at', nowIso);
    if (w.scope) set('scope_json', JSON.stringify(w.scope));
    receipt.refreshed += 1;
  }
  if (upgrade) {
    const rj = JSON.stringify(w.reasons || []);
    if (rj !== row.reasons_json) set('reasons_json', rj);
    if ((w.confidence ?? null) !== row.confidence && w.confidence != null) set('confidence', w.confidence);
    if (Boolean(w.restricted) !== Boolean(row.restricted)) set('restricted', w.restricted ? 1 : 0);
  }
  if (!sets.length) { receipt.unchanged += 1; return; }
  set('updated_at', nowIso);
  db.run(`UPDATE task_context_links SET ${sets.join(', ')} WHERE id = ?`, [...vals, row.id]);
}

function _refreshNote(row, e, nowIso, receipt) {
  const { body } = model.splitNote(e.text || '');
  const restricted = Boolean(e.restricted || row.restricted);
  _refresh(row, { title: model.titleOf(e.rel), preview: restricted ? null : model.previewOf(body), hash: e.hash, mtimeMs: e.mtimeMs, state: row.stale_from || row.state, restricted }, nowIso, receipt, { upgrade: false });
}

function _refreshScope(row, task, ix, nowIso, receipt) {
  const items = model.scopeItems(task, ix.notes, row.source_ref, ix.stats);
  _refresh(row, { title: row.title, hash: sha(JSON.stringify(items)), scope: { items }, state: row.state }, nowIso, receipt, { upgrade: false });
}

function _markStale(row, reason, nowIso, receipt) {
  db.run(`UPDATE task_context_links SET state = 'stale', stale_from = ?, stale_reason = ?, updated_at = ? WHERE id = ?`, [row.state, reason, nowIso, row.id]);
  receipt.stale += 1;
}

function _ask(taskId, question, options, nowIso, receipt) {
  const cur = db.get(`SELECT * FROM task_context_questions WHERE task_id = ?`, [taskId]);
  const oj = JSON.stringify(options);
  if (cur && cur.options_json === oj) return; // asked already (or dismissed) — never re-asked unchanged
  db.run(`INSERT INTO task_context_questions (task_id, question, options_json, created_at, dismissed_at) VALUES (?,?,?,?,NULL)
          ON CONFLICT(task_id) DO UPDATE SET question = excluded.question, options_json = excluded.options_json, created_at = excluded.created_at, dismissed_at = NULL`,
  [taskId, question, oj, nowIso]);
  receipt.questions += 1;
}

// ── reads ────────────────────────────────────────────────────────────────────

function _task(taskId) {
  const id = Number(taskId);
  if (!Number.isInteger(id) || id <= 0) return null;
  try { return require('./task-store').getTask(id); } catch { return null; }
}

/** READ. A task's context, grouped. Never reads the vault; never creates a table. */
function forTask(taskId) {
  const t = _task(taskId);
  if (!t) return { ok: false, status: 404, error: 'No such task.' };
  const auto = enabled();
  const out = { ok: true, contract: model.CONTRACT, taskId: t.id, task: { id: t.id, text: t.text, status: t.status }, pinned: [], suggestions: [], stale: [], question: null, lastScan: null,
    automatic: { enabled: auto, say: auto ? null : WAITING_SAY } };
  if (!_exists()) { out.lastScan = null; return out; }
  const rows = db.all(`SELECT * FROM task_context_links WHERE task_id = ? AND state != 'removed' ORDER BY (origin = 'nightly-scan'), confidence DESC, updated_at DESC`, [t.id]).map(_row);
  out.pinned = rows.filter((r) => r.state === 'pinned');
  out.suggestions = rows.filter((r) => r.state === 'suggested');
  out.stale = rows.filter((r) => r.state === 'stale' && r.staleFrom === 'pinned');
  const q = db.get(`SELECT * FROM task_context_questions WHERE task_id = ? AND dismissed_at IS NULL`, [t.id]);
  if (q) out.question = { text: q.question, options: JSON.parse(q.options_json), askedAt: q.created_at };
  out.lastScan = lastRun();
  return out;
}

/** READ. Pinned context for several tasks at once (Now, meeting prep). */
function pinnedFor(taskIds, { limit = 3 } = {}) {
  const ids = [...new Set((taskIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map();
  if (!ids.length || !_exists()) return out;
  const rows = db.all(`SELECT * FROM task_context_links WHERE state = 'pinned' AND task_id IN (${ids.map(() => '?').join(',')}) ORDER BY (origin = 'nightly-scan'), confidence DESC, updated_at DESC`, ids);
  for (const r of rows) {
    if (!out.has(r.task_id)) out.set(r.task_id, []);
    if (out.get(r.task_id).length < limit) out.get(r.task_id).push(_row(r));
  }
  return out;
}

/** READ. Suggestions across open tasks (for MCP and a review list). */
function suggestions({ limit = 50 } = {}) {
  if (!_exists()) return { ok: true, suggestions: [], questions: [] };
  const open = new Set(_openTasks().map((t) => t.id));
  const rows = db.all(`SELECT l.*, t.text AS task_text FROM task_context_links l JOIN tasks t ON t.id = l.task_id WHERE l.state = 'suggested' ORDER BY l.confidence DESC, l.updated_at DESC`).filter((r) => open.has(r.task_id)).slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
  const qs = db.all(`SELECT q.*, t.text AS task_text FROM task_context_questions q JOIN tasks t ON t.id = q.task_id WHERE q.dismissed_at IS NULL`).filter((r) => open.has(r.task_id));
  return {
    ok: true,
    suggestions: rows.map((r) => ({ ...(_row(r)), taskText: r.task_text })),
    questions: qs.map((q) => ({ taskId: q.task_id, taskText: q.task_text, text: q.question, options: JSON.parse(q.options_json), askedAt: q.created_at })),
  };
}

function lastRun() {
  if (!_exists()) return null;
  const r = db.get(`SELECT * FROM task_context_runs ORDER BY id DESC LIMIT 1`);
  return r ? _run(r) : null;
}
function runs({ limit = 10 } = {}) {
  if (!_exists()) return [];
  return db.all(`SELECT * FROM task_context_runs ORDER BY id DESC LIMIT ?`, [Math.max(1, Math.min(60, Number(limit) || 10))]).map(_run);
}
function _run(r) {
  let receipt = {};
  try { receipt = JSON.parse(r.receipt_json || '{}'); } catch { /* kept empty */ }
  return { id: r.id, startedAt: r.started_at, finishedAt: r.finished_at, trigger: r.trigger, ok: Boolean(r.ok), error: r.error || null, receipt };
}

// ── manual links ─────────────────────────────────────────────────────────────

const ORIGIN_OF = (by) => (by && String(by).startsWith('machine:') ? 'mcp' : 'manual');

/**
 * Resolve what Nick asked to link. Returns { ok, target } or
 * { ok:false, needsChoice: { question, options } } when more than one thing fits —
 * never a guess — or { ok:false, status, error }.
 */
function resolveTarget({ type, ref }, { root }) {
  const want = String(ref || '').trim();
  if (!model.SOURCE_TYPES.includes(type)) return { ok: false, status: 400, error: 'type must be note, project or area.' };
  if (!want || want.length > 400) return { ok: false, status: 400, error: 'Say which one (a path or a name).' };
  if (type === 'note') return _resolveNote(want, root);
  const scopes = listScopes(root).filter((s) => s.type === type);
  const norm = (s) => String(s).toLowerCase().replace(/\.md$/i, '').trim();
  const exact = scopes.filter((s) => norm(s.ref) === norm(want) || norm(s.name) === norm(want) || s.projectId === want);
  if (exact.length === 1) return { ok: true, target: { type, ref: exact[0].ref, title: exact[0].name } };
  const loose = exact.length ? exact : scopes.filter((s) => norm(s.name).includes(norm(want)));
  if (loose.length === 1) return { ok: true, target: { type, ref: loose[0].ref, title: loose[0].name } };
  if (loose.length > 1) return { ok: false, status: 409, needsChoice: { question: `Which ${type} did you mean?`, options: loose.slice(0, 6).map((s) => ({ type, ref: s.ref, title: s.name })) } };
  return { ok: false, status: 404, error: `No ${type} called “${want}”.` };
}

function _resolveNote(want, root) {
  const ex = require('./vault-exclusions');
  const looksLikePath = /\//.test(want) || /\.md$/i.test(want);
  if (looksLikePath) {
    const rel = model.relNorm(/\.md$/i.test(want) ? want : `${want}.md`);
    const safe = require('../routes/vault')._safePath(rel);
    if (!safe) return { ok: false, status: 400, error: 'That path is not inside the vault.' };
    if (!fs.existsSync(safe)) return { ok: false, status: 404, error: 'No note at that path.' };
    return _noteTarget(rel, safe, ex);
  }
  // A name: find notes with that title. One → that note. Several → ask.
  const walk = require('./vault-walk');
  const hits = [];
  const wl = want.toLowerCase();
  walk.walk(root, {
    skipDir: (name) => ex.INFRA_DIRS.includes(name),
    skipFile: (rel) => !rel.toLowerCase().endsWith('.md'),
    visit: (rel) => { if (model.titleOf(rel).toLowerCase() === wl) hits.push(rel); },
  });
  if (hits.length === 1) return _noteTarget(hits[0], path.join(root, hits[0]), ex);
  if (hits.length > 1) return { ok: false, status: 409, needsChoice: { question: 'Which note did you mean?', options: hits.slice(0, 6).map((rel) => ({ type: 'note', ref: rel, title: model.titleOf(rel) })) } };
  return { ok: false, status: 404, error: `No note titled “${want}”. Search for it first.` };
}

function _noteTarget(rel, full, ex) {
  const skip = model.SCAN_SKIP_PREFIXES.find((s) => rel.startsWith(s.prefix) && s.refuseManual);
  if (skip) return { ok: false, status: 400, error: 'That is machine-produced output, not something worth linking to a task.' };
  let text = '';
  try { text = fs.readFileSync(full, 'utf8'); } catch { return { ok: false, status: 400, error: 'That note could not be read.' }; }
  const { fm, body } = model.splitNote(text);
  let restricted = ex.isSensitivePath(rel) || String(fm.private || '').toLowerCase() === 'true';
  if (!restricted) {
    try {
      const s = _deps(new Set()).employmentScreen({ sourceTitle: model.titleOf(rel), sourceText: body });
      restricted = Boolean(s && s.sensitive);
    } catch { /* a screen that could not run never makes a note LESS restricted — preview kept off below */ restricted = true; }
  }
  let mtimeMs = null; try { mtimeMs = fs.statSync(full).mtimeMs; } catch { /* kept null */ }
  return { ok: true, target: { type: 'note', ref: rel, title: model.titleOf(rel), preview: restricted ? null : model.previewOf(body), hash: sha(text), mtimeMs, restricted } };
}

/** Link ONE thing to a task, as Nick (or a chat on his explicit word). Never writes the vault. */
function link({ taskId, type, ref, by = 'nick', now = Date.now() } = {}) {
  const t = _task(taskId);
  if (!t) return { ok: false, status: 404, error: 'No such task.' };
  const v = vaultRoot();
  if (!v.ok) return { ok: false, status: 503, error: v.why };
  const r = resolveTarget({ type, ref }, { root: v.root });
  if (!r.ok) return r;
  ensure();
  const nowIso = iso(now);
  const target = r.target;
  if (target.type !== 'note') {
    const ix = buildIndex({ root: v.root, nowMs: now });
    const items = model.scopeItems(model.indexTask(t, ix.tokenize), ix.notes, target.ref, ix.stats);
    target.scope = { items };
    target.hash = sha(JSON.stringify(items));
  }
  const origin = ORIGIN_OF(by);
  const reasons = [{ code: 'manual', say: origin === 'mcp' ? 'Linked from a chat at your request.' : 'You linked this.' }];
  const cur = db.get(`SELECT * FROM task_context_links WHERE task_id = ? AND source_type = ? AND source_ref = ?`, [t.id, target.type, target.ref]);
  if (cur && cur.state === 'pinned' && cur.origin !== 'nightly-scan') return { ok: true, already: true, link: _row(cur) };
  if (cur) {
    db.run(`UPDATE task_context_links SET state = 'pinned', origin = ?, linked_by = ?, stale_from = NULL, stale_reason = NULL, removed_at = NULL, removed_by = NULL,
            title = ?, preview = ?, restricted = ?, scope_json = ?, source_hash = ?, source_mtime = ?, reasons_json = ?, confidence = NULL, updated_at = ? WHERE id = ?`,
    [origin, by, target.title, target.restricted ? null : (target.preview || null), target.restricted ? 1 : 0, target.scope ? JSON.stringify(target.scope) : null,
      target.hash || null, target.mtimeMs ? iso(target.mtimeMs) : null, JSON.stringify(reasons), nowIso, cur.id]);
  } else {
    _insert(t.id, { ...target, state: 'pinned', reasons, confidence: null }, origin, by, nowIso);
  }
  // A question about which project/area this belongs to is answered by linking one.
  if (target.type !== 'note' && _questionExists()) db.run(`UPDATE task_context_questions SET dismissed_at = ? WHERE task_id = ? AND dismissed_at IS NULL`, [nowIso, t.id]);
  const row = db.get(`SELECT * FROM task_context_links WHERE task_id = ? AND source_type = ? AND source_ref = ?`, [t.id, target.type, target.ref]);
  _log('task-context-linked', { taskId: t.id, type: target.type, by });
  return { ok: true, link: _row(row) };
}

function _questionExists() {
  try { return Boolean(db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='task_context_questions'`)); } catch { return false; }
}

/** Remove (unpin, or dismiss a suggestion). Kept as `removed` so the scan never re-adds it. */
function remove({ taskId, linkId, by = 'nick', now = Date.now() } = {}) {
  if (!_exists()) return { ok: false, status: 404, error: 'No such link.' };
  const row = db.get(`SELECT * FROM task_context_links WHERE id = ? AND task_id = ?`, [Number(linkId), Number(taskId)]);
  if (!row) return { ok: false, status: 404, error: 'No such link on that task.' };
  if (row.state === 'removed') return { ok: true, already: true, link: _row(row) };
  db.run(`UPDATE task_context_links SET state = 'removed', removed_at = ?, removed_by = ?, updated_at = ? WHERE id = ?`, [iso(now), by, iso(now), row.id]);
  _log('task-context-removed', { taskId: row.task_id, type: row.source_type, by, was: row.state });
  return { ok: true, link: _row(db.get(`SELECT * FROM task_context_links WHERE id = ?`, [row.id])) };
}

/** Accept a suggestion: it becomes pinned, still marked as found by the scan. */
function pin({ taskId, linkId, by = 'nick', now = Date.now() } = {}) {
  if (!_exists()) return { ok: false, status: 404, error: 'No such link.' };
  const row = db.get(`SELECT * FROM task_context_links WHERE id = ? AND task_id = ?`, [Number(linkId), Number(taskId)]);
  if (!row) return { ok: false, status: 404, error: 'No such link on that task.' };
  if (row.state === 'pinned') return { ok: true, already: true, link: _row(row) };
  if (row.state !== 'suggested') return { ok: false, status: 409, error: row.state === 'removed' ? 'That was removed — link it again instead.' : 'Only a suggestion can be pinned.' };
  db.run(`UPDATE task_context_links SET state = 'pinned', linked_by = ?, updated_at = ? WHERE id = ?`, [by, iso(now), row.id]);
  return { ok: true, link: _row(db.get(`SELECT * FROM task_context_links WHERE id = ?`, [row.id])) };
}

function dismissQuestion({ taskId, now = Date.now() } = {}) {
  if (!_questionExists()) return { ok: false, status: 404, error: 'No open question for that task.' };
  const q = db.get(`SELECT * FROM task_context_questions WHERE task_id = ? AND dismissed_at IS NULL`, [Number(taskId)]);
  if (!q) return { ok: false, status: 404, error: 'No open question for that task.' };
  db.run(`UPDATE task_context_questions SET dismissed_at = ? WHERE task_id = ?`, [iso(now), q.task_id]);
  return { ok: true };
}

/**
 * READ. Candidates to link: notes whose title or path matches every word of the
 * query, plus projects and areas by name. Restricted notes are offered by title
 * only; machine output is not offered at all.
 */
function search({ q, taskId = null } = {}) {
  const query = String(q || '').trim();
  if (query.length < 2) return { ok: false, status: 400, error: 'Type at least two characters.' };
  if (query.length > 120) return { ok: false, status: 400, error: 'That search is too long.' };
  const v = vaultRoot();
  if (!v.ok) return { ok: false, status: 503, error: v.why };
  const ex = require('./vault-exclusions');
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const notes = [];
  const traversal = require('./vault-walk').walk(v.root, {
    skipDir: (name) => ex.INFRA_DIRS.includes(name),
    skipFile: (rel) => !rel.toLowerCase().endsWith('.md'),
    visit: (rel, full) => {
      const hay = rel.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return;
      if (model.SCAN_SKIP_PREFIXES.some((s) => rel.startsWith(s.prefix) && s.refuseManual)) return;
      let mtimeMs = 0; try { mtimeMs = fs.statSync(full).mtimeMs; } catch { /* 0 */ }
      notes.push({ type: 'note', ref: rel, title: model.titleOf(rel), folder: path.posix.dirname(rel), restricted: ex.isSensitivePath(rel), mtimeMs, titleHit: words.every((w) => model.titleOf(rel).toLowerCase().includes(w)) });
    },
  });
  notes.sort((a, b) => (b.titleHit - a.titleHit) || b.mtimeMs - a.mtimeMs);
  const scopes = listScopes(v.root).filter((s) => words.every((w) => s.name.toLowerCase().includes(w)))
    .map((s) => ({ type: s.type, ref: s.ref, title: s.name }));
  const already = new Set();
  if (taskId && _exists()) for (const r of db.all(`SELECT source_type, source_ref FROM task_context_links WHERE task_id = ? AND state IN ('pinned','suggested')`, [Number(taskId)])) already.add(`${r.source_type}|${r.source_ref}`);
  const mark = (x) => ({ ...x, linked: already.has(`${x.type}|${x.ref}`) });
  return {
    ok: true, query,
    scopes: scopes.slice(0, 6).map(mark),
    notes: notes.slice(0, SEARCH_LIMIT).map(({ mtimeMs, titleHit, ...n }) => mark({ ...n, modified: mtimeMs ? iso(mtimeMs) : null })),
    more: Math.max(0, notes.length - SEARCH_LIMIT),
    complete: !traversal.truncated,
  };
}

function _log(kind, data) {
  try { db.logActivity(kind, data); } catch { /* bookkeeping never fails a link */ }
}

/** The nightly job, registered from scheduler.start() (it reads the whole vault). */
function registerJob() {
  const runtime = require('./runtime-jobs');
  runtime.defineJob({
    name: 'task-context-scan',
    cron: '40 3 * * *',
    class: 'best-effort',
    catchUp: 'latest',
    maxLagMs: 20 * 3600000,
    maxAttempts: 1,
    timeoutMs: 10 * 60 * 1000,
    why: 'Task context: pin genuinely related vault notes, projects and areas to open tasks. Idempotent; writes NEURO tables only, never the vault. Does nothing until Nick enables it (the first enabled run is the backfill).',
    run: async () => {
      // Off by default: a recorded no-op, never a failure and never a scan.
      if (!enabled()) return { skipped: 'not-enabled', say: WAITING_SAY };
      const r = runScan({ trigger: 'nightly' });
      if (!r.ok && !r.busy) throw new Error(r.error || 'scan failed');
      return r.receipt;
    },
  });
}

module.exports = {
  ensure, vaultRoot, buildIndex, listScopes, runScan, status, activate, deactivate, WAITING_SAY, ENABLE_SAY, forTask, pinnedFor, suggestions, lastRun, runs,
  resolveTarget, link, remove, pin, dismissQuestion, search, registerJob,
  _internals: { _exists, _row },
};
