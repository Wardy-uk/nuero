'use strict';

/**
 * SAiM's authority budget (20 Oct 2026) — the hard operating boundary on what a
 * confirmed prepared move may do. Server-enforced, durable, and checked inside
 * the executor (prepared-move-exec.execute) BEFORE any adapter is built or the
 * one-use confirmation is spent.
 *
 * EVERY CONSEQUENTIAL ALLOWANCE DEFAULTS TO ZERO. No grant row = nothing may be
 * done. A grant covers ONE London day and, for the first action, can never
 * exceed: one solo calendar block of up to 30 minutes, one NEW note, one
 * prepared move, £0 spend, 0 contacts — for the one action type below. Those
 * ceilings are CHECK constraints in the table as well as rules here.
 *
 * Two independent gates must BOTH be open for anything to happen:
 *   1. the environment master lock (SAIM_PREPARED_MOVE_EXECUTION on the Pi) —
 *      checked first by the executor; a grant never opens it;
 *   2. a grant for today here — changing the environment never creates one.
 * The emergency stop closes everything at once, mid-action included.
 *
 * The ledger (saim_authority_reservations) is keyed by the SAME idempotency key
 * as the external write ledger (`<moveKey>:<step>`), so:
 *   - a retry reuses its reservation and never consumes budget twice;
 *   - concurrent confirms are serialised by an IMMEDIATE transaction — the
 *     second sees the first's reservation and is refused at the limit;
 *   - a partial action keeps its truthful state: a step that wrote is `used`, a
 *     step that provably did not is `released`, an uncertain one is `unknown`
 *     (and counts as used).
 *
 * Granting, resuming and revoking are HUMAN acts (routes/saim-authority.js
 * refuses machine callers; the authority matrix and the MCP gateway refuse them
 * too). A grant and a resume each need a one-use confirmation token minted
 * against the exact terms shown.
 */

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const db = require('../db/database');

const ACTION = 'prepared-move.block-and-note';
const ALLOWED_ACTIONS = Object.freeze([ACTION]);
/**
 * The most a grant may ever say (22 Oct 2026: three moves a day). `blockMinutes`
 * is the most ONE block may be; `notes` counts every new written thing a move
 * makes — a new note OR a governed reply draft (which still waits for the
 * approval code; nothing is ever sent from here).
 */
const CEILING = Object.freeze({ blocks: 3, blockMinutes: 30, notes: 3, moves: 3, spendPence: 0, contacts: 0 });
/** The step kinds a move may reserve. A reply DRAFT is a written output, never a send. */
const STEP_KINDS = Object.freeze(['calendar.solo', 'vault.note', 'reply.draft']);
const OUTPUT_KINDS = Object.freeze(['vault.note', 'reply.draft']);
const CONFIRM_TTL_MS = 2 * 60000;
const GRANT_AHEAD_DAYS = 7;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const londonDay = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
const dayLong = (d) => { const x = new Date(`${d}T12:00:00Z`); return `${DAYS[x.getUTCDay()]} ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}`; };
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rid = (p) => `${p}_${crypto.randomBytes(10).toString('hex')}`;

let ready = false;
const TABLES = ['saim_authority_grants', 'saim_authority_reservations', 'saim_authority_controls', 'saim_authority_pending', 'saim_authority_events'];
/**
 * Do the tables exist? Every READ asks this and nothing else: a read never
 * creates the schema (20 Oct 2026 — opening May do used to create five empty
 * tables on first view). Absent tables read as the zero state: nothing granted,
 * nothing used, not stopped, no receipts.
 */
function has() {
  if (ready) return true;
  try { return db.get(`SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table' AND name IN (${TABLES.map(() => '?').join(',')})`, TABLES).n === TABLES.length; } catch { return false; }
}

/** The grants table, with the current ceilings as CHECK constraints. */
function grantsDDL() {
  return `
    CREATE TABLE IF NOT EXISTS saim_authority_grants (
      id TEXT PRIMARY KEY,
      day TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action = '${ACTION}'),
      blocks INTEGER NOT NULL CHECK (blocks BETWEEN 0 AND ${CEILING.blocks}),
      block_minutes INTEGER NOT NULL CHECK (block_minutes BETWEEN 0 AND ${CEILING.blockMinutes}),
      notes INTEGER NOT NULL CHECK (notes BETWEEN 0 AND ${CEILING.notes}),
      moves INTEGER NOT NULL CHECK (moves BETWEEN 0 AND ${CEILING.moves}),
      spend_pence INTEGER NOT NULL DEFAULT 0 CHECK (spend_pence = 0),
      contacts INTEGER NOT NULL DEFAULT 0 CHECK (contacts = 0),
      statement TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      revoked_at TEXT,
      revoked_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_saim_authority_grants_day ON saim_authority_grants(day);`;
}
function grantsTriggers() {
  return `
    CREATE TRIGGER IF NOT EXISTS saim_authority_grants_immutable
      BEFORE UPDATE ON saim_authority_grants
      WHEN NEW.id IS NOT OLD.id OR NEW.day IS NOT OLD.day OR NEW.action IS NOT OLD.action
        OR NEW.blocks IS NOT OLD.blocks OR NEW.block_minutes IS NOT OLD.block_minutes OR NEW.notes IS NOT OLD.notes
        OR NEW.moves IS NOT OLD.moves OR NEW.spend_pence IS NOT OLD.spend_pence OR NEW.contacts IS NOT OLD.contacts
        OR NEW.statement IS NOT OLD.statement OR NEW.granted_at IS NOT OLD.granted_at OR NEW.granted_by IS NOT OLD.granted_by
        OR (OLD.revoked_at IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'an authority grant is immutable; it can only be revoked, once'); END;
    CREATE TRIGGER IF NOT EXISTS saim_authority_grants_no_delete
      BEFORE DELETE ON saim_authority_grants
      BEGIN SELECT RAISE(ABORT, 'an authority grant is never deleted'); END;`;
}
function reservationsDDL() {
  return `
    CREATE TABLE IF NOT EXISTS saim_authority_reservations (
      id TEXT PRIMARY KEY,
      idem_key TEXT NOT NULL UNIQUE,
      day TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      move_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('calendar.solo', 'vault.note', 'reply.draft')),
      minutes INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'used', 'released', 'unknown')),
      title TEXT,
      created_at TEXT NOT NULL,
      settled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_saim_authority_res_day ON saim_authority_reservations(day, state);`;
}

/**
 * Create the schema — called ONLY by an intentional state change (grant
 * preview/grant, stop, resume, revoke of a real grant, reserve/settle/receipt
 * during a confirmed move). Never inside a read-only pass. The whole schema is
 * created in ONE IMMEDIATE transaction with IF NOT EXISTS, so it lands whole or
 * not at all, and a second caller racing the first waits and then finds it.
 */
function ensure() {
  if (ready) return;
  if (require('./read-only-scope').active()) { ready = has(); return; }
  const g = db.getDb();
  g.transaction(() => g.exec(`
    ${grantsDDL()}
    ${grantsTriggers()}
    ${reservationsDDL()}

    CREATE TABLE IF NOT EXISTS saim_authority_controls (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      at TEXT NOT NULL,
      by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saim_authority_pending (
      token TEXT PRIMARY KEY,
      purpose TEXT NOT NULL CHECK (purpose IN ('grant', 'resume')),
      terms_json TEXT NOT NULL,
      terms_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS saim_authority_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT
    );
    CREATE TRIGGER IF NOT EXISTS saim_authority_events_append_only_u
      BEFORE UPDATE ON saim_authority_events BEGIN SELECT RAISE(ABORT, 'the authority log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS saim_authority_events_append_only_d
      BEFORE DELETE ON saim_authority_events BEGIN SELECT RAISE(ABORT, 'the authority log is append-only'); END;
  `)).immediate();
  _migrateCeilings();
  ready = true;
}

/**
 * 22 Oct 2026: the one-move ceilings were CHECK constraints, which SQLite
 * cannot alter — so a table created before the three-move allowance is
 * REBUILT, rows carried over unchanged, inside ONE transaction, with its
 * immutability and no-delete triggers dropped and re-installed in the same
 * transaction. Only the ceilings and the new reservation kind change; no row
 * is altered. Runs once per process, only from ensure() (a state change).
 */
function _migrateCeilings() {
  const g = db.getDb();
  const sqlOf = (t) => (g.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t) || {}).sql || '';
  const grants = sqlOf('saim_authority_grants');
  const res = sqlOf('saim_authority_reservations');
  const oldGrants = /moves INTEGER NOT NULL CHECK \(moves BETWEEN 0 AND 1\)/.test(grants);
  const oldRes = res && !res.includes("'reply.draft'");
  if (!oldGrants && !oldRes) return;
  g.transaction(() => {
    if (oldGrants) {
      g.exec(`DROP TRIGGER IF EXISTS saim_authority_grants_immutable; DROP TRIGGER IF EXISTS saim_authority_grants_no_delete;
        ALTER TABLE saim_authority_grants RENAME TO saim_authority_grants_v1;`);
      g.exec(grantsDDL());
      // The index moved with the renamed table, so it is re-made after the old one goes.
      g.exec(`INSERT INTO saim_authority_grants SELECT * FROM saim_authority_grants_v1; DROP TABLE saim_authority_grants_v1;
        CREATE INDEX IF NOT EXISTS idx_saim_authority_grants_day ON saim_authority_grants(day);`);
      g.exec(grantsTriggers());
    }
    if (oldRes) {
      g.exec(`ALTER TABLE saim_authority_reservations RENAME TO saim_authority_reservations_v1;`);
      g.exec(reservationsDDL());
      g.exec(`INSERT INTO saim_authority_reservations SELECT * FROM saim_authority_reservations_v1; DROP TABLE saim_authority_reservations_v1;
        CREATE INDEX IF NOT EXISTS idx_saim_authority_res_day ON saim_authority_reservations(day, state);`);
    }
  }).immediate();
  console.log(`[AuthorityBudget] rebuilt ${[oldGrants && 'grants', oldRes && 'reservations'].filter(Boolean).join(' + ')} for the three-move allowance (rows carried over unchanged)`);
}

const iso = (ms) => new Date(ms).toISOString();
function event(kind, detail, now) { db.run('INSERT INTO saim_authority_events (at, kind, detail) VALUES (?, ?, ?)', [iso(now), kind, detail == null ? null : JSON.stringify(detail)]); }

// ── The two gates ────────────────────────────────────────────────────────────

/** Gate 1: the environment master lock. Read, never written, here. */
function masterLock() {
  try {
    const f = require('./feature-flags').list().find((x) => x.key === 'saim_prepared_move_execution') || {};
    return { open: Boolean(f.enabled), lockedByEnv: Boolean(f.lockedByEnv), envVar: f.envVar || 'SAIM_PREPARED_MOVE_EXECUTION' };
  } catch {
    return { open: false, lockedByEnv: false, envVar: 'SAIM_PREPARED_MOVE_EXECUTION' };
  }
}

/** The emergency stop. Unreadable counts as stopped (fail closed). */
function stopState() {
  try {
    // read only: never creates the schema (see has())
    if (!has()) return { stopped: false, since: null }; // never created = never stopped
    const r = db.get(`SELECT value, at FROM saim_authority_controls WHERE key = 'stop'`);
    if (!r) return { stopped: false, since: null };
    return { stopped: r.value === 'on', since: r.value === 'on' ? r.at : null };
  } catch {
    return { stopped: true, since: null, unreadable: true };
  }
}

const STOPPED_SAY = 'SAiM’s actions are stopped.';

function stop({ by = 'nick', now = Date.now() } = {}) {
  ensure();
  db.run(`INSERT INTO saim_authority_controls (key, value, at, by) VALUES ('stop', 'on', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = 'on', at = excluded.at, by = excluded.by`, [iso(now), by]);
  event('stopped', { by }, now);
  return { ok: true, stopped: true };
}

// ── Grants ───────────────────────────────────────────────────────────────────

function _grantFor(day) {
  // read only: never creates the schema (see has())
  if (!has()) return null;
  return db.get(`SELECT * FROM saim_authority_grants WHERE day = ? AND revoked_at IS NULL ORDER BY granted_at DESC LIMIT 1`, [day]) || null;
}

/** What the grant for `day` would say, in Nick's words. PURE. */
function statementFor(terms, lock) {
  const lines = [
    `Allow SAiM to carry out up to ${words(terms.moves)} prepared ${terms.moves === 1 ? 'move' : 'moves'} on ${dayLong(terms.day)}.`,
    'Each one still shows you exactly what it will do, and waits for you to confirm it before it writes anything.',
    `Altogether: up to ${words(terms.blocks)} private calendar ${terms.blocks === 1 ? 'block' : 'blocks'} of up to ${terms.blockMinutes} minutes each (just you, nobody invited), and up to ${words(terms.notes)} new ${terms.notes === 1 ? 'note or reply draft' : 'notes or reply drafts'}.`,
    'A reply draft waits in Actions for your approval — nothing is ever sent.',
    'No sending, no contacting anyone, no meeting invitations, no tasks, no shared-board changes, and no changes to what SAiM may do.',
    `It ends at midnight on ${dayLong(terms.day)}.`,
  ];
  if (lock && !lock.open) lines.push('Carrying out moves is switched off on NEURO’s server right now, so until that is switched on SAiM can prepare moves but not do them.');
  return lines;
}

const GRANT_KEYS = new Set(['day', 'blockMinutes']);
const WORDS = ['no', 'one', 'two', 'three'];
const words = (n) => WORDS[n] || String(n);

/** Validate the only terms a grant may carry. Refused, never clamped. */
function validateTerms(body = {}, now = Date.now()) {
  const extra = Object.keys(body || {}).filter((k) => !GRANT_KEYS.has(k));
  if (extra.length) return { ok: false, why: `${extra.join(', ')} ${extra.length === 1 ? 'is' : 'are'} not something SAiM can be allowed — the allowance is up to three prepared moves` };
  const today = londonDay(now);
  const day = body.day == null ? today : String(body.day);
  if (!/^\d{4}-\d\d-\d\d$/.test(day) || Number.isNaN(Date.parse(`${day}T12:00:00Z`))) return { ok: false, why: 'the day must be a date' };
  if (day < today) return { ok: false, why: 'an allowance cannot be given for a day that has passed' };
  const last = londonDay(now + GRANT_AHEAD_DAYS * 86400000);
  if (day > last) return { ok: false, why: `an allowance can be given at most ${GRANT_AHEAD_DAYS} days ahead` };
  const minutes = body.blockMinutes == null ? CEILING.blockMinutes : Number(body.blockMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > CEILING.blockMinutes) return { ok: false, why: `a block can be at most ${CEILING.blockMinutes} minutes` };
  return { ok: true, terms: { day, action: ACTION, blocks: CEILING.blocks, blockMinutes: minutes, notes: CEILING.notes, moves: CEILING.moves, spendPence: 0, contacts: 0 } };
}

function _mint(purpose, terms, now) {
  ensure();
  const token = rid('ac');
  const json = JSON.stringify(terms);
  db.run(`INSERT INTO saim_authority_pending (token, purpose, terms_json, terms_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [token, purpose, json, sha(json), iso(now), iso(now + CONFIRM_TTL_MS)]);
  return { token, expiresAt: iso(now + CONFIRM_TTL_MS) };
}

/** Spend a confirmation token for `purpose`, once. Returns the terms it was minted for. */
function _spend(purpose, token, now) {
  ensure();
  const r = db.get(`SELECT * FROM saim_authority_pending WHERE token = ?`, [String(token || '')]);
  if (!r || r.purpose !== purpose) return { ok: false, why: 'that confirmation is not one SAiM issued for this' };
  if (r.used_at) return { ok: false, why: 'that confirmation has already been used — ask again' };
  if (now > Date.parse(r.expires_at)) return { ok: false, why: 'that confirmation has expired — ask again' };
  if (sha(r.terms_json) !== r.terms_hash) return { ok: false, why: 'that confirmation no longer matches what was shown — ask again' };
  const ch = db.run(`UPDATE saim_authority_pending SET used_at = ? WHERE token = ? AND used_at IS NULL`, [iso(now), r.token]);
  if (!ch || ch.changes !== 1) return { ok: false, why: 'that confirmation has already been used — ask again' };
  return { ok: true, terms: JSON.parse(r.terms_json) };
}

/** Step 1: show exactly what would be granted, with a one-use token for exactly that. */
function previewGrant(body, { now = Date.now() } = {}) {
  const v = validateTerms(body, now);
  if (!v.ok) return { ok: false, code: 400, why: v.why };
  if (_grantFor(v.terms.day)) return { ok: false, code: 409, why: `SAiM already has an allowance for ${dayLong(v.terms.day)}` };
  const lock = masterLock();
  const statement = statementFor(v.terms, lock);
  const { token, expiresAt } = _mint('grant', { ...v.terms, statement }, now);
  return { ok: true, terms: v.terms, statement, confirmToken: token, expiresAt, masterLock: lock };
}

/** Step 2: grant exactly what was shown. */
function grant({ confirmToken, by = 'nick', now = Date.now() } = {}) {
  const s = _spend('grant', confirmToken, now);
  if (!s.ok) return { ok: false, code: 409, why: s.why };
  const t = s.terms;
  if (t.day < londonDay(now)) return { ok: false, code: 409, why: 'that day has passed — ask again' };
  if (_grantFor(t.day)) return { ok: false, code: 409, why: `SAiM already has an allowance for ${dayLong(t.day)}` };
  const id = rid('ag');
  db.run(`INSERT INTO saim_authority_grants (id, day, action, blocks, block_minutes, notes, moves, spend_pence, contacts, statement, granted_at, granted_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
  [id, t.day, t.action, t.blocks, t.blockMinutes, t.notes, t.moves, JSON.stringify(t.statement), iso(now), by]);
  event('granted', { day: t.day, blocks: t.blocks, blockMinutes: t.blockMinutes, notes: t.notes, moves: t.moves }, now);
  return { ok: true, day: t.day, statement: t.statement };
}

/** Take today's (or a given day's) allowance away. Immediate: reducing authority needs no ceremony. */
function revoke({ day = null, by = 'nick', now = Date.now() } = {}) {
  const d = day || londonDay(now);
  const g = _grantFor(d);
  if (!g) return { ok: true, revoked: false, why: `there was no allowance for ${dayLong(d)}` };
  db.run(`UPDATE saim_authority_grants SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL`, [iso(now), by, g.id]);
  event('revoked', { day: d }, now);
  return { ok: true, revoked: true, day: d };
}

/** Resuming after a stop is a human act with its own confirmation. */
function previewResume({ now = Date.now() } = {}) {
  const st = stopState();
  if (!st.stopped) return { ok: false, code: 409, why: 'SAiM’s actions are not stopped' };
  const statement = ['SAiM’s actions will be able to run again — still only within today’s allowance, and only with the device lock open.'];
  const { token, expiresAt } = _mint('resume', { statement }, now);
  return { ok: true, statement, confirmToken: token, expiresAt };
}

function resume({ confirmToken, by = 'nick', now = Date.now() } = {}) {
  const s = _spend('resume', confirmToken, now);
  if (!s.ok) return { ok: false, code: 409, why: s.why };
  db.run(`INSERT INTO saim_authority_controls (key, value, at, by) VALUES ('stop', 'off', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = 'off', at = excluded.at, by = excluded.by`, [iso(now), by]);
  event('resumed', { by }, now);
  return { ok: true, stopped: false };
}

// ── Usage and the atomic reservation ─────────────────────────────────────────

const COUNTS = `state IN ('reserved', 'used', 'unknown')`;
function usage(day) {
  // read only: never creates the schema (see has())
  if (!has()) return { blocks: 0, minutes: 0, notes: 0, replies: 0, moves: 0, moveKeys: [] };
  const rows = db.all(`SELECT kind, minutes, move_key FROM saim_authority_reservations WHERE day = ? AND ${COUNTS}`, [day]);
  return {
    blocks: rows.filter((r) => r.kind === 'calendar.solo').length,
    minutes: rows.filter((r) => r.kind === 'calendar.solo').reduce((a, r) => a + (r.minutes || 0), 0),
    notes: rows.filter((r) => OUTPUT_KINDS.includes(r.kind)).length,
    replies: rows.filter((r) => r.kind === 'reply.draft').length,
    moves: new Set(rows.map((r) => r.move_key)).size,
    moveKeys: [...new Set(rows.map((r) => r.move_key))],
  };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Reserve the budget for one move's steps, atomically (IMMEDIATE transaction).
 * `steps`: [{ key, kind: 'calendar.solo'|'vault.note', minutes, contacts, spendPence }].
 * A step whose key already holds a reservation (reserved/used/unknown) is REUSED,
 * never counted twice. Returns { ok, created: [keys], reused: [keys] } or
 * { ok:false, limit, say } naming the limit — never an internal identifier.
 */
/**
 * The one judgement both reserve() and wouldFit() make. PURE over its inputs:
 * the grant row (or null), today's usage, the steps not already reserved, and
 * whether this is a move not yet counted today.
 */
function judge({ stopped, g, action, steps, fresh, u, isNewMove }) {
  if (stopped) return { ok: false, limit: 'stop', say: STOPPED_SAY };
  if (!g) return { ok: false, limit: 'no-allowance', say: 'SAiM has no allowance to act today.' };
  if (!ALLOWED_ACTIONS.includes(action) || g.action !== action) return { ok: false, limit: 'action', say: 'This kind of action isn’t on today’s allowance.' };
  for (const s of steps) {
    if ((s.spendPence || 0) > g.spend_pence) return { ok: false, limit: 'spend', say: 'This would spend money, and today’s allowance is £0.' };
    if ((s.contacts || 0) > g.contacts) return { ok: false, limit: 'contacts', say: 'This would contact or invite someone, and today’s allowance allows nobody.' };
    if (!STEP_KINDS.includes(s.kind)) return { ok: false, limit: 'action', say: 'This kind of action isn’t on today’s allowance.' };
    if (s.kind === 'calendar.solo' && (s.minutes || 0) > g.block_minutes) return { ok: false, limit: 'minutes', say: `This block is ${s.minutes} minutes; a block may be at most ${g.block_minutes}.` };
  }
  if (fresh.length && isNewMove && u.moves + 1 > g.moves) {
    return { ok: false, limit: 'moves', say: g.moves === 0 ? 'Today’s allowance covers no prepared moves.' : `Today’s allowance covers ${plural(g.moves, 'prepared move', 'prepared moves')}, and it has been used.` };
  }
  const addBlocks = fresh.filter((s) => s.kind === 'calendar.solo');
  const addNotes = fresh.filter((s) => OUTPUT_KINDS.includes(s.kind)).length;
  if (addBlocks.length && u.blocks + addBlocks.length > g.blocks) return { ok: false, limit: 'blocks', say: `Today’s allowance has no calendar blocks left (${u.blocks} of ${g.blocks} used).` };
  if (addNotes && u.notes + addNotes > g.notes) return { ok: false, limit: 'notes', say: `Today’s allowance has no new notes or reply drafts left (${u.notes} of ${g.notes} used).` };
  return { ok: true };
}

/** Would these steps fit today's allowance? Reads only — reserves nothing. */
function wouldFit({ action = ACTION, moveKey = null, steps = [], now = Date.now() } = {}) {
  try {
    const day = londonDay(now);
    const u = usage(day);
    return judge({ stopped: stopState().stopped, g: _grantFor(day), action, steps, fresh: steps, u, isNewMove: !moveKey || !u.moveKeys.includes(moveKey) });
  } catch {
    return { ok: false, limit: 'unreadable', say: 'SAiM couldn’t check its allowance.' };
  }
}

function reserve({ action = ACTION, moveKey, title = null, steps = [], now = Date.now() } = {}) {
  ensure();
  const day = londonDay(now);
  const tx = db.getDb().transaction(() => {
    const existing = new Map(db.all(`SELECT idem_key, state FROM saim_authority_reservations WHERE idem_key IN (${steps.map(() => '?').join(',') || "''"})`, steps.map((s) => s.key)).map((r) => [r.idem_key, r.state]));
    const fresh = steps.filter((s) => { const was = existing.get(s.key); return !was || was === 'released'; });
    const u = usage(day);
    const g = _grantFor(day);
    const verdict = judge({ stopped: stopState().stopped, g, action, steps, fresh, u, isNewMove: !u.moveKeys.includes(moveKey) });
    if (!verdict.ok) return verdict;
    const created = [];
    for (const s of fresh) {
      if (existing.get(s.key) === 'released') {
        db.run(`UPDATE saim_authority_reservations SET state = 'reserved', day = ?, grant_id = ?, minutes = ?, settled_at = NULL, created_at = ? WHERE idem_key = ?`, [day, g.id, s.minutes || 0, iso(now), s.key]);
      } else {
        db.run(`INSERT INTO saim_authority_reservations (id, idem_key, day, grant_id, move_key, kind, minutes, state, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
          [rid('ar'), s.key, day, g.id, moveKey, s.kind, s.minutes || 0, title, iso(now)]);
      }
      created.push(s.key);
    }
    return { ok: true, day, created, reused: steps.filter((s) => !fresh.includes(s)).map((s) => s.key) };
  });
  try {
    return tx.immediate();
  } catch (e) {
    return { ok: false, limit: 'unreadable', say: 'SAiM couldn’t check its allowance, so nothing was done.', error: e.message };
  }
}

/** Settle one step's reservation to what actually happened. */
function settle(key, outcome, { now = Date.now() } = {}) {
  ensure();
  if (!['used', 'released', 'unknown'].includes(outcome)) throw new Error(`unknown budget outcome ${outcome}`);
  db.run(`UPDATE saim_authority_reservations SET state = ?, settled_at = ? WHERE idem_key = ?`, [outcome, iso(now), key]);
}

/** Release reservations this call created and never started (a refusal after reserving). */
function releaseUnstarted(keys = [], { now = Date.now() } = {}) {
  ensure();
  for (const k of keys) db.run(`UPDATE saim_authority_reservations SET state = 'released', settled_at = ? WHERE idem_key = ? AND state = 'reserved'`, [iso(now), k]);
}

function recordReceipt(receipt, { title = null, now = Date.now() } = {}) {
  try {
    ensure();
    event('receipt', {
      title, target: receipt.target, complete: receipt.complete, plain: receipt.plain, at: receipt.at,
      steps: (receipt.steps || []).map((s) => ({ step: s.step, status: s.status, target: s.target || null })),
    }, now);
  } catch { /* the external write ledger still holds the steps */ }
}

// ── What Nick sees ───────────────────────────────────────────────────────────

/** Everything the control surface shows. Reads only. */
function status({ now = Date.now() } = {}) {
  // read only: never creates the schema (see has())
  const day = londonDay(now);
  const lock = masterLock();
  const st = stopState();
  const g = _grantFor(day);
  const u = usage(day);
  const left = (granted, used) => ({ granted, used, left: Math.max(0, granted - used) });
  const allowance = g ? {
    blocks: left(g.blocks, u.blocks), minutes: left(g.blocks * g.block_minutes, u.minutes), blockMinutes: g.block_minutes,
    notes: left(g.notes, u.notes), moves: left(g.moves, u.moves), spendPence: 0, contacts: 0,
  } : { blocks: left(0, u.blocks), minutes: left(0, u.minutes), blockMinutes: 0, notes: left(0, u.notes), moves: left(0, u.moves), spendPence: 0, contacts: 0 };

  const tables = has();
  const resRows = !tables ? [] : db.all(`SELECT move_key, kind, state, title, created_at, settled_at FROM saim_authority_reservations WHERE day = ? ORDER BY created_at`, [day]);
  const receipts = !tables ? [] : db.all(`SELECT at, detail FROM saim_authority_events WHERE kind = 'receipt' ORDER BY id DESC LIMIT 10`)
    .map((r) => { try { return { at: r.at, ...JSON.parse(r.detail) }; } catch { return null; } }).filter(Boolean);
  const inFlight = resRows.filter((r) => r.state === 'reserved');
  const lastReceipt = receipts[0] || null;
  const active = inFlight.length
    ? { state: 'in-progress', title: inFlight[0].title, say: 'A prepared move is being carried out now.' }
    : (lastReceipt && londonDay(Date.parse(lastReceipt.at)) === day)
      ? { state: lastReceipt.complete ? 'done' : 'partly-done', title: lastReceipt.title, practice: lastReceipt.target === 'sandbox', say: lastReceipt.target === 'sandbox' ? `Practice run, nothing real was changed: ${lastReceipt.plain}` : lastReceipt.plain }
      : { state: 'none', title: null, say: 'Nothing has been carried out today.' };

  const granted = Boolean(g);
  // A move may still go ahead while there is a move left AND something it could
  // write (a block or a note/reply draft) left.
  const canAct = lock.open && !st.stopped && granted && allowance.moves.left > 0 && (allowance.blocks.left > 0 || allowance.notes.left > 0);
  const movesLeft = allowance.moves.left;
  const leftToday = granted
    ? `${words(movesLeft)} of ${words(g.moves)} prepared ${g.moves === 1 ? 'move' : 'moves'} left today · ${allowance.blocks.left} calendar ${allowance.blocks.left === 1 ? 'block' : 'blocks'} · ${allowance.notes.left} ${allowance.notes.left === 1 ? 'note or reply draft' : 'notes or reply drafts'}`
    : null;
  const gates = {
    device: lock.open
      ? { open: true, say: 'SAiM is ready.' }
      : { open: false, say: 'Carrying out moves is switched off on NEURO’s server.' },
    allowance: granted
      ? { open: canAct || (allowance.moves.left > 0), say: `Today SAiM may carry out up to ${words(g.moves)} prepared ${g.moves === 1 ? 'move' : 'moves'}, each only after you confirm it.` }
      : { open: false, say: 'You haven’t allowed SAiM to carry out any prepared moves today.' },
  };
  return {
    ok: true, contract: 'saim-authority-v1', day, dayLabel: dayLong(day),
    gates, stopped: st.stopped, stoppedSince: st.since,
    grant: g ? { day: g.day, blockMinutes: g.block_minutes, moves: g.moves, statement: JSON.parse(g.statement), grantedAt: g.granted_at } : null,
    allowance, active, receipts, canAct, leftToday,
    summary: st.stopped ? 'All SAiM actions are stopped.'
      : canAct ? `SAiM can carry out ${words(movesLeft)} more prepared ${movesLeft === 1 ? 'move' : 'moves'} today, each after you confirm it.`
        : !lock.open && !granted ? 'SAiM can prepare moves, but carrying them out is switched off on NEURO’s server and you haven’t allowed any today.'
          : !lock.open ? 'SAiM can prepare moves, but carrying them out is switched off on NEURO’s server.'
            : !granted ? 'You haven’t allowed SAiM to carry out any prepared moves today.'
              : 'Today’s prepared moves are used up. It starts again tomorrow.',
  };
}

/** The small slice the prepared-move view needs. */
/**
 * PURE over a status(). The ONE boundary between SAiM and acting, in plain
 * words, or null when none stands. Device lock first (nothing else matters
 * while it is closed), then the stop, then today's allowance. Read only.
 */
const BOUNDARY = {
  device: 'Carrying out moves is switched off on NEURO’s server, so I can prepare this but not do it.',
  stop: 'You’ve stopped all SAiM actions. Resume them in “What SAiM may do” and I can do this.',
  allowance: 'You haven’t allowed me to carry out prepared moves today. Allow up to three in “What SAiM may do” — I’ll still ask before each one.',
  used: 'Today’s prepared moves are used up. It starts again tomorrow; “What SAiM may do” shows what was done.',
  unreadable: 'I couldn’t check what I’m allowed to do, so I won’t do anything yet.',
};
function boundaryOf(s) {
  if (!s || !s.gates) return { gate: 'unreadable', say: BOUNDARY.unreadable };
  if (!s.gates.device.open) return { gate: 'device', say: BOUNDARY.device };
  if (s.stopped) return { gate: 'stop', say: BOUNDARY.stop };
  if (!s.grant) return { gate: 'allowance', say: BOUNDARY.allowance };
  if (!s.canAct) return { gate: 'used', say: BOUNDARY.used };
  return null;
}

function brief({ now = Date.now() } = {}) {
  try {
    const s = status({ now });
    return { canAct: s.canAct, stopped: s.stopped, deviceOpen: s.gates.device.open, granted: Boolean(s.grant), summary: s.summary, leftToday: s.leftToday, boundary: boundaryOf(s) };
  } catch {
    return { canAct: false, stopped: true, deviceOpen: false, granted: false, summary: 'SAiM couldn’t read its allowance.', boundary: { gate: 'unreadable', say: BOUNDARY.unreadable } };
  }
}

const _test = {
  /** Test-only: wipe the budget tables. Refuses anything but a temp database. */
  reset() {
    const p = path.resolve(process.env.NEURO_DB_PATH || '');
    if (!process.env.NEURO_DB_PATH || !p.startsWith(path.resolve(os.tmpdir()))) throw new Error('authority-budget reset is for test databases only');
    ensure();
    const g = db.getDb();
    g.exec(`DROP TRIGGER IF EXISTS saim_authority_grants_no_delete; DROP TRIGGER IF EXISTS saim_authority_events_append_only_d;
            DELETE FROM saim_authority_grants; DELETE FROM saim_authority_reservations; DELETE FROM saim_authority_controls; DELETE FROM saim_authority_pending; DELETE FROM saim_authority_events;`);
    ready = false; ensure();
  },
  /** Test-only: grant today's allowance in one step. */
  grantToday({ now = Date.now(), blockMinutes } = {}) {
    const p = previewGrant(blockMinutes ? { blockMinutes } : {}, { now });
    if (!p.ok) throw new Error(p.why);
    return grant({ confirmToken: p.confirmToken, now });
  },
};

module.exports = {
  ACTION, CEILING, STEP_KINDS, OUTPUT_KINDS, CONFIRM_TTL_MS, STOPPED_SAY, BOUNDARY, boundaryOf, londonDay, masterLock, stopState, stop, previewResume, resume,
  validateTerms, statementFor, previewGrant, grant, revoke, usage, judge, wouldFit, reserve, settle, releaseUnstarted, recordReceipt,
  status, brief, _test,
};
