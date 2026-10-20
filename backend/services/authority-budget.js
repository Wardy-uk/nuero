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
/** The most a grant may ever say, for the first action. */
const CEILING = Object.freeze({ blocks: 1, blockMinutes: 30, notes: 1, moves: 1, spendPence: 0, contacts: 0 });
const CONFIRM_TTL_MS = 2 * 60000;
const GRANT_AHEAD_DAYS = 7;
const NOTE_FOLDER = 'Projects/Support Improvement Plan';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const londonDay = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
const dayLong = (d) => { const x = new Date(`${d}T12:00:00Z`); return `${DAYS[x.getUTCDay()]} ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}`; };
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rid = (p) => `${p}_${crypto.randomBytes(10).toString('hex')}`;

let ready = false;
/** Do the tables exist? (A read never creates them.) */
function has() {
  if (ready) return true;
  try { return Boolean(db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'saim_authority_events'`)); } catch { return false; }
}
/**
 * Create the tables — but NEVER inside a read-only pass (viewing the prepared
 * move must not create anything). There, absent tables read as "nothing granted,
 * nothing used, not stopped" and the queries below fall back accordingly.
 */
function ensure() {
  if (ready) return;
  if (require('./read-only-scope').active()) { ready = has(); return; }
  const g = db.getDb();
  g.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_saim_authority_grants_day ON saim_authority_grants(day);
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
      BEGIN SELECT RAISE(ABORT, 'an authority grant is never deleted'); END;

    CREATE TABLE IF NOT EXISTS saim_authority_reservations (
      id TEXT PRIMARY KEY,
      idem_key TEXT NOT NULL UNIQUE,
      day TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      move_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('calendar.solo', 'vault.note')),
      minutes INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'used', 'released', 'unknown')),
      title TEXT,
      created_at TEXT NOT NULL,
      settled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_saim_authority_res_day ON saim_authority_reservations(day, state);

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
  `);
  ready = true;
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
    ensure();
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
  ensure();
  if (!has()) return null;
  return db.get(`SELECT * FROM saim_authority_grants WHERE day = ? AND revoked_at IS NULL ORDER BY granted_at DESC LIMIT 1`, [day]) || null;
}

/** What the grant for `day` would say, in Nick's words. PURE. */
function statementFor(terms, lock) {
  const lines = [
    `On ${dayLong(terms.day)} SAiM may add one block to your calendar — up to ${terms.blockMinutes} minutes, just you, nobody invited.`,
    `On ${dayLong(terms.day)} SAiM may save one new note in ${NOTE_FOLDER}. It never changes or deletes a note.`,
    'Only for a prepared move you confirm yourself, one move only.',
    'No money, no messages, no invites, no task or board changes, and no follow-up afterwards.',
    `The allowance ends at midnight on ${dayLong(terms.day)}.`,
  ];
  if (lock && !lock.open) lines.push('SAiM is still technically locked on this device: until that lock is changed on the Pi, this allowance alone lets SAiM do nothing.');
  return lines;
}

const GRANT_KEYS = new Set(['day', 'blockMinutes']);

/** Validate the only terms a grant may carry. Refused, never clamped. */
function validateTerms(body = {}, now = Date.now()) {
  const extra = Object.keys(body || {}).filter((k) => !GRANT_KEYS.has(k));
  if (extra.length) return { ok: false, why: `${extra.join(', ')} ${extra.length === 1 ? 'is' : 'are'} not something SAiM can be allowed — the first action is one calendar block and one note` };
  const today = londonDay(now);
  const day = body.day == null ? today : String(body.day);
  if (!/^\d{4}-\d\d-\d\d$/.test(day) || Number.isNaN(Date.parse(`${day}T12:00:00Z`))) return { ok: false, why: 'the day must be a date' };
  if (day < today) return { ok: false, why: 'an allowance cannot be given for a day that has passed' };
  const last = londonDay(now + GRANT_AHEAD_DAYS * 86400000);
  if (day > last) return { ok: false, why: `an allowance can be given at most ${GRANT_AHEAD_DAYS} days ahead` };
  const minutes = body.blockMinutes == null ? CEILING.blockMinutes : Number(body.blockMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > CEILING.blockMinutes) return { ok: false, why: `a block can be at most ${CEILING.blockMinutes} minutes` };
  return { ok: true, terms: { day, action: ACTION, blocks: 1, blockMinutes: minutes, notes: 1, moves: 1, spendPence: 0, contacts: 0 } };
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
  ensure();
  if (!has()) return { blocks: 0, minutes: 0, notes: 0, moves: 0, moveKeys: [] };
  const rows = db.all(`SELECT kind, minutes, move_key FROM saim_authority_reservations WHERE day = ? AND ${COUNTS}`, [day]);
  return {
    blocks: rows.filter((r) => r.kind === 'calendar.solo').length,
    minutes: rows.filter((r) => r.kind === 'calendar.solo').reduce((a, r) => a + (r.minutes || 0), 0),
    notes: rows.filter((r) => r.kind === 'vault.note').length,
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
    if (!['calendar.solo', 'vault.note'].includes(s.kind)) return { ok: false, limit: 'action', say: 'This kind of action isn’t on today’s allowance.' };
  }
  if (fresh.length && isNewMove && u.moves + 1 > g.moves) {
    return { ok: false, limit: 'moves', say: g.moves === 0 ? 'Today’s allowance covers no prepared moves.' : `Today’s allowance covers ${plural(g.moves, 'prepared move', 'prepared moves')}, and it has been used.` };
  }
  const addBlocks = fresh.filter((s) => s.kind === 'calendar.solo');
  const addMinutes = addBlocks.reduce((a, s) => a + (s.minutes || 0), 0);
  const addNotes = fresh.filter((s) => s.kind === 'vault.note').length;
  if (addBlocks.length && u.blocks + addBlocks.length > g.blocks) return { ok: false, limit: 'blocks', say: `Today’s allowance has no calendar blocks left (${u.blocks} of ${g.blocks} used).` };
  if (addBlocks.length && u.minutes + addMinutes > g.block_minutes) {
    const left = Math.max(0, g.block_minutes - u.minutes);
    return { ok: false, limit: 'minutes', say: `This block is ${addMinutes} minutes; today’s allowance has ${left} ${left === 1 ? 'minute' : 'minutes'} left.` };
  }
  if (addNotes && u.notes + addNotes > g.notes) return { ok: false, limit: 'notes', say: `Today’s allowance has no new notes left (${u.notes} of ${g.notes} used).` };
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
  ensure();
  const day = londonDay(now);
  const lock = masterLock();
  const st = stopState();
  const g = _grantFor(day);
  const u = usage(day);
  const left = (granted, used) => ({ granted, used, left: Math.max(0, granted - used) });
  const allowance = g ? {
    blocks: left(g.blocks, u.blocks), minutes: left(g.block_minutes, u.minutes),
    notes: left(g.notes, u.notes), moves: left(g.moves, u.moves), spendPence: 0, contacts: 0,
  } : { blocks: left(0, u.blocks), minutes: left(0, u.minutes), notes: left(0, u.notes), moves: left(0, u.moves), spendPence: 0, contacts: 0 };

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
  const canAct = lock.open && !st.stopped && granted && allowance.blocks.left > 0 && allowance.notes.left > 0;
  const gates = {
    device: lock.open
      ? { open: true, say: 'The device lock on the Pi is open.' }
      : { open: false, say: 'SAiM is technically locked on this device.' },
    allowance: granted
      ? { open: allowance.blocks.left > 0 || allowance.notes.left > 0, say: `SAiM is allowed to make one calendar block (up to ${g.block_minutes} minutes) and one note today.` }
      : { open: false, say: 'SAiM has no allowance to act today.' },
  };
  return {
    ok: true, contract: 'saim-authority-v1', day, dayLabel: dayLong(day),
    gates, stopped: st.stopped, stoppedSince: st.since,
    grant: g ? { day: g.day, blockMinutes: g.block_minutes, statement: JSON.parse(g.statement), grantedAt: g.granted_at } : null,
    allowance, active, receipts, canAct,
    summary: st.stopped ? 'All SAiM actions are stopped.'
      : canAct ? 'SAiM can carry out one prepared move today, after you confirm it.'
        : !lock.open && !granted ? 'SAiM can’t act: the device is locked and there is no allowance today.'
          : !lock.open ? 'SAiM can’t act yet: the device is still locked.'
            : !granted ? 'SAiM can’t act: there is no allowance today.'
              : 'Today’s allowance has been used.',
  };
}

/** The small slice the prepared-move view needs. */
function brief({ now = Date.now() } = {}) {
  try {
    const s = status({ now });
    return { canAct: s.canAct, stopped: s.stopped, deviceOpen: s.gates.device.open, granted: Boolean(s.grant), summary: s.summary };
  } catch {
    return { canAct: false, stopped: true, deviceOpen: false, granted: false, summary: 'SAiM couldn’t read its allowance.' };
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
  ACTION, CEILING, CONFIRM_TTL_MS, STOPPED_SAY, londonDay, masterLock, stopState, stop, previewResume, resume,
  validateTerms, statementFor, previewGrant, grant, revoke, usage, judge, wouldFit, reserve, settle, releaseUnstarted, recordReceipt,
  status, brief, _test,
};
