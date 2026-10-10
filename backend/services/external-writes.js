'use strict';

/**
 * Direct external writes — the ledger and the register (Build 13K, 6 Oct 2026).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Builds 6–11 governed everything NEURO sends AS Nick to other people (A4:
 * prepared_actions, approval proof, one executor). That left a second class
 * nobody had written down: writes that leave the building WITHOUT a per-item
 * approval — completing a card on a shared Planner board, escalating a Jira
 * ticket through NOVA, turning a light on. Not consequential enough for an
 * approval code each time, but still external, still capable of being done
 * twice, and still capable of "it said 200 and nothing changed".
 *
 * The 13K audit found the worst of them with NO ledger at all: `POST
 * /api/escalation` raised Jira priority and posted an internal comment with no
 * record, no duplicate guard, and it accepted the machine API token.
 *
 * ── The register ────────────────────────────────────────────────────────────
 * `WRITERS` is every direct external writer, with its authority (the
 * action-registry vocabulary, reused — not a second scale) and whether it is
 * on this ledger yet. `ledger: false` is an honest gap, not a claim of safety.
 *
 * ── The ledger rule ─────────────────────────────────────────────────────────
 *   begin()  writes the row BEFORE the call. Same key again:
 *              confirmed / applied-unverified → duplicate, do NOT call again;
 *              requested / uncertain          → blocked: the outcome is unknown,
 *                                               verify before anything repeats;
 *              failed (provably not applied)  → a new attempt is allowed.
 *   settle() records what happened and what the readback said.
 * A crash between begin and settle leaves `requested`, which blocks — the same
 * "unknown is verified, never retried" rule the A4 executor follows.
 */

const db = require('../db/database');

const WRITERS = Object.freeze({
  'nova.escalate': {
    target: 'Jira (via NOVA bridge)', authority: 'A3', initiation: 'human-only', ledger: true,
    effect: 'raise-only priority, tighten-only due date, one INTERNAL comment',
    why: 'Nick fills the form with the exact ticket and reason, so the submit IS the approval of that payload; machine clients are refused. Not A4 because nothing reaches a customer and every change is raise/tighten-only.',
    readback: 'ticket re-read through NOVA for a new internal comment',
  },
  'microsoft.task.complete': {
    target: 'Microsoft Planner / To Do', authority: 'A3', initiation: 'human', ledger: true,
    // Setting 100% / completed again is harmless, so an unknown outcome may be
    // re-attempted — unlike an escalation, which would post a second comment.
    idempotentTarget: true,
    effect: 'percentComplete 100 (Planner, team-visible) or status completed (To Do)',
    why: 'Completion on Nick\'s click is standing consent; Planner is shared, so it is external.',
    readback: 'Graph re-read: percentComplete === 100, or To Do completed / recurrence rolled',
  },
  'microsoft.task.progress': {
    target: 'Microsoft Planner / To Do', authority: 'A3', initiation: 'human', ledger: false,
    effect: 'percentComplete 50/0 or status inProgress/notStarted', why: 'Nick\'s click; reversible.', readback: 'none',
  },
  'microsoft.task.fields': {
    target: 'Microsoft Planner / To Do', authority: 'A3', initiation: 'human', ledger: false,
    effect: 'title / due date / notes (whitelisted); Planner guarded by If-Match', why: 'Nick\'s edit; reversible.', readback: 'none',
  },
  'microsoft.calendar.solo': {
    target: 'Outlook calendar', authority: 'A2', initiation: 'human-or-timer', ledger: false,
    effect: 'create/update/delete events with NO attendees (task blocks, day planner, Plaud admin blocks)',
    why: 'Nick\'s own calendar, nobody else is told, undoable. Planner and Plaud blocks keep their own ledgers.', readback: 'none',
  },
  'microsoft.mail.read-state': {
    target: 'Outlook mailbox', authority: 'A2', initiation: 'human', ledger: false,
    effect: 'isRead on dismiss', why: 'Nick\'s own mailbox, idempotent, undoable.', readback: 'none',
  },
  'homeassistant.room': {
    target: 'Home Assistant', authority: 'A2', initiation: 'human-only', ledger: false,
    effect: 'lights on / radiator target, only via an accepted room offer re-derived from a fresh read',
    why: 'Nick\'s own house, undoable, one attended caller.', readback: 'next house read',
  },
  'notion.sync': {
    target: 'Notion workspace', authority: 'A3', initiation: 'timer', ledger: false,
    effect: 'publish mapped vault notes; never deletes pages', why: 'standing toggle; per-note sync state and a lock.', readback: 'next reconcile pass',
  },
  'nova.121': {
    target: 'NOVA 1-2-1 sessions', authority: 'A3', initiation: 'timer', ledger: false,
    effect: 'session booked/cancelled, cadence, transcript candidate (NOVA holds it for a human)',
    why: 'idempotent at the far end; reconciled each morning.', readback: 'morning reconcile',
  },
  'wunderground.publish': {
    target: 'Weather Underground (our own station ICOALV59)', authority: 'A2', initiation: 'timer', ledger: false,
    effect: "upload the home station's newest reading", why: 'our own public weather station; WU folds a repeat dateutc; off unless WU_PUBLISH_ENABLED.', readback: 'external_weather_sync wu-upload row',
  },
  'tally.transaction.categorise': {
    target: 'Tally (pi-dev)', authority: 'A2', initiation: 'human-only', ledger: true,
    // Setting the same category again is harmless, so an unknown outcome may be re-attempted by Nick.
    idempotentTarget: true,
    effect: "one transaction's category; with 'Always', Tally's own merchant rule, applied to that merchant's uncategorised transactions",
    why: "Nick's own finance app and Tally is the one store (9 Oct 2026); his click is the approval; every change is re-categorisable in Tally.",
    readback: 'Tally answers the updated transaction; its category_id must equal the one chosen',
  },
  'hike.safety-alert': {
    target: 'the people Nick listed for hike safety (email, as Nick)', authority: 'A3', initiation: 'timer, armed by Nick', ledger: true,
    // A duplicate overdue alert costs far less than a missing one, so an unknown
    // outcome is looked for in Sent Items and then RE-ATTEMPTED — the opposite of
    // the governed executor's rule, deliberately (Nick, 10 Oct 2026).
    idempotentTarget: true,
    effect: 'one overdue alert (route card + last known positions + GPX) per armed walk, and one all-clear if he then checks in',
    why: 'Arming the walk is the approval of this card to these people, sent only if he is overdue; the approver is the person missing, so it cannot wait for the approval code. Machine clients cannot arm, extend, cancel or check in.',
    readback: 'Sent Items by internetMessageId; a draft no longer a draft counts as sent',
  },
  'email.self': {
    target: 'Nick\'s own mailbox', authority: 'A2', initiation: 'timer', ledger: false,
    effect: 'briefing / [TEST] copy to Nick only (refuses any other recipient)', why: 'nobody else is told.', readback: 'none',
  },
});

const STATUSES = ['requested', 'confirmed', 'applied-unverified', 'failed', 'uncertain'];

function _iso(now) { return new Date(now instanceof Date ? now.getTime() : now).toISOString(); }
function _row(id) { return db.get('SELECT * FROM external_write_ledger WHERE id = ?', [id]); }
function _shape(r) {
  if (!r) return null;
  let request = null; let result = null;
  try { request = JSON.parse(r.request_json); } catch { request = null; }
  try { result = r.result_json ? JSON.parse(r.result_json) : null; } catch { result = null; }
  return {
    id: r.id, writer: r.writer, key: r.idempotency_key, target: r.target, authority: r.authority,
    initiatedBy: r.initiated_by, status: r.status, attempts: r.attempts, request, result,
    readback: r.readback, requestedAt: r.requested_at, settledAt: r.settled_at,
  };
}

/**
 * Claim the right to make one external write. Synchronous from read to write
 * (better-sqlite3, one process), so two concurrent submits cannot both pass.
 *
 * @returns {{ ok:true, entry } | { ok:false, duplicate?:true, blocked?:true, entry, why }}
 */
function begin({ writer, key, target, request, initiatedBy = 'nick', now = Date.now() }) {
  const w = WRITERS[writer];
  if (!w) return { ok: false, refused: true, why: `unregistered external writer: ${writer}` };
  if (!w.ledger) return { ok: false, refused: true, why: `${writer} is registered without a ledger` };
  if (!key || typeof key !== 'string') return { ok: false, refused: true, why: 'an idempotency key is required' };
  const at = _iso(now);
  const held = db.get('SELECT * FROM external_write_ledger WHERE idempotency_key = ?', [key]);
  if (held) {
    if (held.status === 'confirmed' || held.status === 'applied-unverified') {
      return { ok: false, duplicate: true, entry: _shape(held), why: 'already done — not repeated' };
    }
    // Build 14D: `idempotentTarget` lets NICK re-attempt an unknown outcome
    // (setting 100% twice is harmless). A MACHINE never does — an agent that
    // retries whatever it was not sure about is exactly how "do it once"
    // becomes "do it until it answers". Its unknown outcome is held.
    if ((held.status === 'requested' || held.status === 'uncertain')
        && (!w.idempotentTarget || String(initiatedBy).startsWith('machine'))) {
      return { ok: false, blocked: true, entry: _shape(held), why: 'the last attempt\'s outcome is unknown — verify it before repeating' };
    }
    // failed (provably not applied), or an unknown outcome on a target where
    // repeating is harmless: a new attempt is allowed.
    db.run(`UPDATE external_write_ledger SET status = 'requested', attempts = attempts + 1, request_json = ?,
              result_json = NULL, readback = NULL, requested_at = ?, settled_at = NULL, initiated_by = ? WHERE id = ?`,
      [JSON.stringify(request || {}), at, initiatedBy, held.id]);
    return { ok: true, entry: _shape(_row(held.id)) };
  }
  const info = db.run(`INSERT INTO external_write_ledger
      (writer, idempotency_key, target, authority, initiated_by, status, request_json, requested_at)
      VALUES (?, ?, ?, ?, ?, 'requested', ?, ?)`,
    [writer, key, String(target || w.target), w.authority, initiatedBy, JSON.stringify(request || {}), at]);
  const id = info && (info.lastInsertRowid ?? info.lastID);
  const row = id != null ? _row(id) : db.get('SELECT * FROM external_write_ledger WHERE idempotency_key = ?', [key]);
  return { ok: true, entry: _shape(row) };
}

/** Record the outcome. Never throws — the external write already happened (or not). */
function settle(id, { status, result = null, readback = null, now = Date.now() }) {
  if (!STATUSES.includes(status) || status === 'requested') throw new Error(`settle: bad status ${status}`);
  try {
    db.run(`UPDATE external_write_ledger SET status = ?, result_json = ?, readback = ?, settled_at = ? WHERE id = ?`,
      [status, result == null ? null : JSON.stringify(result), readback, _iso(now), id]);
  } catch (e) {
    console.warn(`[ExternalWrites] could not settle ${id}: ${e.message}`);
  }
  return _shape(_row(id));
}

/**
 * Nick checked the external system and says what is there. The only way out of
 * `uncertain` / a stuck `requested` — never automatic.
 */
function resolveUnknown(key, { applied, now = Date.now(), note = null }) {
  const held = db.get('SELECT * FROM external_write_ledger WHERE idempotency_key = ?', [key]);
  if (!held) return { ok: false, why: 'no such write' };
  if (held.status !== 'uncertain' && held.status !== 'requested') return { ok: false, why: `it is ${held.status}, not unknown` };
  return { ok: true, entry: settle(held.id, { status: applied ? 'confirmed' : 'failed', readback: `human: ${note || (applied ? 'applied' : 'not applied')}`, now }) };
}

/**
 * Is a thrown transport error a PROVABLE non-delivery? Only a refusal the far
 * end actually returned (HTTP 4xx) proves nothing was applied; a timeout, a
 * network error or a 5xx might have landed.
 */
function classifyError(e) {
  const m = String((e && e.message) || e || '');
  if (/\b4\d\d\b/.test(m) && !/\b408\b|\b429\b/.test(m)) return 'failed';
  return 'uncertain';
}

function recent({ writer = null, limit = 50 } = {}) {
  const rows = writer
    ? db.all('SELECT * FROM external_write_ledger WHERE writer = ? ORDER BY id DESC LIMIT ?', [writer, limit])
    : db.all('SELECT * FROM external_write_ledger ORDER BY id DESC LIMIT ?', [limit]);
  return rows.map(_shape);
}

/**
 * A later, out-of-band success for a write that had failed (the Microsoft push
 * queue retrying). Settles the newest failed row for that target, if any.
 */
function settleLatestFailed(writer, target, { status = 'confirmed', result = null, readback = null, now = Date.now() } = {}) {
  const row = db.get(`SELECT id FROM external_write_ledger WHERE writer = ? AND target = ? AND status IN ('failed','uncertain','requested')
                      ORDER BY id DESC LIMIT 1`, [writer, String(target)]);
  return row ? settle(row.id, { status, result, readback, now }) : null;
}

/**
 * Free a settled row's idempotency key so the SAME key can be used again — for
 * a write whose target moved on, e.g. a recurring To Do task rolled forward:
 * the next tick completes a different occurrence and must not read as a
 * duplicate of this one. The row is kept, renamed.
 */
function releaseKey(id, suffix) {
  db.run('UPDATE external_write_ledger SET idempotency_key = idempotency_key || ? WHERE id = ?', [`#${suffix || id}`, id]);
}

function byKey(key) { return _shape(db.get('SELECT * FROM external_write_ledger WHERE idempotency_key = ?', [key])); }

/** Unknown outcomes waiting for Nick — for State of Play / Setup. */
function unresolved() {
  return db.all(`SELECT * FROM external_write_ledger WHERE status IN ('uncertain','requested') ORDER BY id`).map(_shape);
}

function localDate(now = Date.now()) {
  const d = new Date(now instanceof Date ? now.getTime() : now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = { WRITERS, STATUSES, begin, settle, settleLatestFailed, releaseKey, resolveUnknown, classifyError, recent, byKey, unresolved, localDate };
