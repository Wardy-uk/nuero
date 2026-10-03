'use strict';

/**
 * Build 8 migration (3 Oct 2026) — outbound governance completion.
 *
 * Idempotent, run on every boot after migrate-build7-actions.js:
 *
 *   1. DUPLICATE IDENTITY in the database, per type (8K). Partial UNIQUE
 *      indexes, so a second live action is refused by SQLite even for a caller
 *      that forgot to ask:
 *        reply_email             one live reply per source email
 *        chase_agenda            one per meeting EVER (verified included —
 *                                a second ask is worse than none)
 *        send_weekly_risk_report one live send per report week
 *      (chase_commitment's index is Build 7's, unchanged.)
 *   2. LEGACY HISTORY WIDENED. Build 7's `action_legacy_history` CHECKs allowed
 *      only `legacy_chase` from `old_actions_queue`. SQLite cannot widen a CHECK,
 *      so the table is REBUILT (every row copied, the no-delete trigger
 *      re-installed) — this migration says so, as Build 6 said of its rebuild.
 *   3. LEGACY SENDS RECORDED, never verified (8H): the old queue's executed
 *      reply_email / chase_agenda / send_weekly_risk_report rows, and replies the
 *      Inbox composer sent DIRECTLY before Build 8 (sent_replies up to the
 *      cutover stamp), as `legacy_unverified`. Nothing is invented: no attempt
 *      row, no provider id, no verification.
 *   4. PENDING LEGACY OUTBOUND SUPERSEDED: any reply_email / chase_agenda /
 *      send_weekly_risk_report / respond_meeting / schedule_focus_block-with-
 *      attendees still pending in the old queue. Its executor now refuses, so
 *      leaving it approvable would be a button that always fails, and NO
 *      legacy approval carries over to the governed path — whatever it was for
 *      is re-prepared by its producer and needs a fresh human approval.
 */

const ACTIVE = ['prepared', 'approved', 'executing', 'execution_uncertain', 'executed'];
const q = (list) => list.map((s) => `'${s}'`).join(', ');

const INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_prepared_actions_one_active_reply
     ON prepared_actions (commitment_id) WHERE action_type = 'reply_email' AND status IN (${q(ACTIVE)})`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_prepared_actions_one_agenda_chase
     ON prepared_actions (commitment_id) WHERE action_type = 'chase_agenda' AND status IN (${q([...ACTIVE, 'verified'])})`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_prepared_actions_one_active_report
     ON prepared_actions (commitment_id) WHERE action_type = 'send_weekly_risk_report' AND status IN (${q(ACTIVE)})`,
];

const LEGACY_TYPES = ['legacy_chase', 'legacy_reply_email', 'legacy_chase_agenda', 'legacy_weekly_risk_report'];
const LEGACY_PROVENANCE = ['old_actions_queue', 'inbox_composer'];

const LEGACY_DDL = (name) => `CREATE TABLE ${name} (
    legacy_ref        TEXT PRIMARY KEY,
    action_type       TEXT NOT NULL CHECK (action_type IN (${q(LEGACY_TYPES)})),
    status            TEXT NOT NULL CHECK (status = 'legacy_unverified'),
    provenance        TEXT NOT NULL CHECK (provenance IN (${q(LEGACY_PROVENANCE)})),
    subject_ref       TEXT,
    target_name       TEXT,
    target_email      TEXT,
    target_source     TEXT,
    channel_requested TEXT,
    occurred_at       TEXT,
    queued_at         TEXT,
    imported_at       TEXT NOT NULL,
    note              TEXT NOT NULL
  )`;

const NO_DELETE = `CREATE TRIGGER IF NOT EXISTS action_legacy_history_b7_no_delete BEFORE DELETE ON action_legacy_history
     BEGIN SELECT RAISE(ABORT, 'legacy action history is kept for audit'); END`;

const CUTOVER_KEY = 'build8_outbound_cutover_at';
const OUTBOUND_LEGACY = ['reply_email', 'chase_agenda', 'send_weekly_risk_report'];
const LEGACY_TYPE_FOR = { reply_email: 'legacy_reply_email', chase_agenda: 'legacy_chase_agenda', send_weekly_risk_report: 'legacy_weekly_risk_report' };

function _cols(db, table) { return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name); }
const _parse = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };

function widenLegacyHistory(db, { log = console.log } = {}) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'action_legacy_history'").get();
  if (!row) { db.exec(LEGACY_DDL('action_legacy_history')); db.exec(NO_DELETE); return 'created'; }
  if (row.sql.includes('legacy_reply_email')) { db.exec(NO_DELETE); return 'already'; }
  const tx = db.transaction(() => {
    db.exec('DROP TRIGGER IF EXISTS action_legacy_history_b7_no_delete');
    db.exec('DROP TABLE IF EXISTS action_legacy_history_b8');
    db.exec(LEGACY_DDL('action_legacy_history_b8'));
    db.exec(`INSERT INTO action_legacy_history_b8 SELECT legacy_ref, action_type, status, provenance, subject_ref, target_name,
               target_email, target_source, channel_requested, occurred_at, queued_at, imported_at, note FROM action_legacy_history`);
    db.exec('DROP TABLE action_legacy_history');
    db.exec('ALTER TABLE action_legacy_history_b8 RENAME TO action_legacy_history');
    db.exec(NO_DELETE);
  });
  tx();
  log('[DB] Build 8: action_legacy_history rebuilt to record every legacy outbound type (rows carried over, no-delete trigger re-installed)');
  return 'rebuilt';
}

function _cutover(db, now) {
  const hasState = _cols(db, 'agent_state').length > 0;
  if (!hasState) return new Date(now).toISOString();
  const r = db.prepare('SELECT value FROM agent_state WHERE key = ?').get(CUTOVER_KEY);
  if (r && r.value) return r.value;
  const stamp = new Date(now).toISOString();
  db.prepare('INSERT OR REPLACE INTO agent_state (key, value) VALUES (?, ?)').run(CUTOVER_KEY, stamp);
  return stamp;
}

function importLegacy(db, { now = Date.now(), log = console.log } = {}) {
  const ins = db.prepare(`INSERT OR IGNORE INTO action_legacy_history
      (legacy_ref, action_type, status, provenance, subject_ref, target_name, target_email, target_source,
       channel_requested, occurred_at, queued_at, imported_at, note)
      VALUES (?, ?, 'legacy_unverified', ?, ?, ?, ?, ?, 'email', ?, ?, ?, ?)`);
  const importedAt = new Date(now).toISOString();
  let added = 0;

  if (_cols(db, 'saim_actions').length) {
    const cols = _cols(db, 'saim_actions');
    const pick = (c) => (cols.includes(c) ? c : `NULL AS ${c}`);
    const rows = db.prepare(`SELECT id, type, payload, ${pick('created_at')}, ${pick('resolved_at')} FROM saim_actions
                             WHERE type IN (${q(OUTBOUND_LEGACY)}) AND status = 'executed' ORDER BY id`).all();
    for (const r of rows) {
      const p = _parse(r.payload);
      let name = null; let email = null; let source = null; let ref = null;
      if (r.type === 'send_weekly_risk_report') {
        const to = (Array.isArray(p.to) ? p.to : [])[0] || {};
        name = to.name || null; email = to.email || null; source = to.source || null; ref = p.week ? `weekly-risk:${p.week}` : null;
      } else if (r.type === 'chase_agenda') {
        const o = p.organizer || {};
        name = o.name || null; email = o.email || o.address || null; ref = p.eventId ? `meeting:${p.eventId}` : null;
      } else {
        const to = (Array.isArray(p.to) ? p.to : [])[0];
        email = (to && (to.email || to)) || null; ref = p.emailId ? `email:${p.emailId}` : null;
      }
      added += ins.run(`saim_actions:${r.id}`, LEGACY_TYPE_FOR[r.type], 'old_actions_queue', ref, name, email, source,
        r.resolved_at || null, r.created_at || null, importedAt,
        'Sent by the pre-Build-8 approval queue on a PIN-only approve. It kept no attempt ledger, no provider message id '
        + 'and no Sent Items check, so this records only that the old queue marked it executed. Delivery is NOT verified.').changes;
    }
  }

  if (_cols(db, 'sent_replies').length) {
    const cutover = _cutover(db, now);
    const rows = db.prepare('SELECT id, email_id, recipients, recipients_source, sent_at FROM sent_replies WHERE sent_at <= ? ORDER BY id').all(cutover);
    for (const r of rows) {
      let first = null;
      try { first = (JSON.parse(r.recipients || '[]') || [])[0] || null; } catch { first = null; }
      added += ins.run(`sent_replies:${r.id}`, 'legacy_reply_email', 'inbox_composer', r.email_id ? `email:${r.email_id}` : null,
        (first && first.name) || null, (first && first.email) || null, r.recipients_source || null,
        r.sent_at || null, null, importedAt,
        'Sent DIRECTLY by the Inbox composer before Build 8 — one PIN call, no approval step, no ledger, no Sent Items check. '
        + `Recipients were ${r.recipients_source === 'explicit' ? 'chosen in the composer' : 'picked by Graph from the thread'}. Delivery is NOT verified.`).changes;
    }
  }
  if (added) log(`[DB] Build 8: recorded ${added} legacy outbound send(s) as legacy_unverified history`);
  return added;
}

function supersedePending(db, { now = Date.now(), log = console.log } = {}) {
  if (!_cols(db, 'saim_actions').length) return 0;
  const hasResolved = _cols(db, 'saim_actions').includes('resolved_at');
  const stamp = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
  const where = `status = 'pending' AND (type IN (${q([...OUTBOUND_LEGACY, 'respond_meeting'])})
                 OR (type = 'schedule_focus_block' AND json_array_length(COALESCE(json_extract(payload, '$.attendees'), '[]')) > 0))`;
  const r = hasResolved
    ? db.prepare(`UPDATE saim_actions SET status = 'superseded', resolved_at = ? WHERE ${where}`).run(stamp)
    : db.prepare(`UPDATE saim_actions SET status = 'superseded' WHERE ${where}`).run();
  if (r.changes) log(`[DB] Build 8: superseded ${r.changes} pending legacy outbound action(s) — no legacy approval carries over; re-prepare them through the governed path`);
  return r.changes;
}

function migrate(db, { log = console.log, now = Date.now() } = {}) {
  const hasPa = _cols(db, 'prepared_actions').length > 0;
  if (hasPa) {
    for (const ddl of INDEXES) {
      // ⚠ The indexes are the database half of duplicate prevention. If rows
      // that already violate one exist, creating it fails — say so LOUDLY
      // rather than brick the boot (the app-level checks still run).
      try { db.exec(ddl); } catch (e) {
        console.error(`[DB] Build 8: could NOT create a duplicate-prevention index (${e.message}) — resolve the duplicate live actions, then restart`);
      }
    }
  }
  const legacyTable = widenLegacyHistory(db, { log });
  const legacy = importLegacy(db, { now, log });
  const superseded = supersedePending(db, { now, log });
  return { legacyTable, legacy, superseded };
}

module.exports = { migrate, widenLegacyHistory, importLegacy, supersedePending, INDEXES, LEGACY_TYPES, CUTOVER_KEY };
