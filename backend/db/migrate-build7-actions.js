'use strict';

/**
 * Build 7 migration (3 Oct 2026) — action convergence and human approval.
 *
 * Idempotent, run on every boot after migrate-build6-actions.js:
 *
 *   1. prepared_actions gains `origin` (risk | chase-button) and the approval
 *      PROVENANCE columns `approval_mechanism` / `approval_challenge_id`.
 *   2. `approval_challenges` — single-use, server-issued challenges.
 *   3. TRIGGERS:
 *        • an approval must carry a mechanism and a challenge that NEURO issued
 *          for this exact action and payload hash, and that was ACCEPTED (the
 *          right approval code was typed). The database half of "a machine
 *          client cannot approve".
 *        • the new provenance columns are immutable once an approval exists.
 *        • a consumed challenge cannot be un-consumed.
 *   4. ONE ACTIVE CHASE per (commitment, target person): a partial UNIQUE index
 *      over the live states. Two paths (a risk finding and the Chase button),
 *      a double click, two processes — whichever arrives second is refused by
 *      the database, not by remembering to check.
 *   5. LEGACY HISTORY: chases the old `saim_actions` queue sent are recorded in
 *      `action_legacy_history` as `legacy_unverified`, provenance
 *      `old_actions_queue`. Nothing is invented: no attempt row, no provider
 *      id, no verification — the old path recorded none of them.
 *   6. Any legacy chase still PENDING in the old queue is superseded — its
 *      executor no longer sends, so leaving it approvable would be a button
 *      that always fails.
 */

const ACTIVE = ['prepared', 'approved', 'executing', 'execution_uncertain', 'executed'];

function _addColumn(db, table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

function triggerDdl() {
  return [
    `CREATE TRIGGER IF NOT EXISTS prepared_actions_b7_approval_needs_proof BEFORE UPDATE OF status ON prepared_actions
       WHEN NEW.status = 'approved' AND OLD.status <> 'approved' AND (
            NEW.approval_mechanism IS NULL OR NEW.approval_challenge_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM approval_challenges ch
                        WHERE ch.challenge_id = NEW.approval_challenge_id AND ch.action_id = NEW.action_id
                          AND ch.payload_hash = NEW.payload_hash AND ch.version = NEW.version
                          AND ch.used_outcome = 'accepted'))
     BEGIN SELECT RAISE(ABORT, 'an approval needs a human-approval proof: an accepted challenge for this exact action and payload'); END`,
    `CREATE TRIGGER IF NOT EXISTS prepared_actions_b7_provenance_immutable BEFORE UPDATE ON prepared_actions
       WHEN OLD.approved_payload_hash IS NOT NULL AND (NEW.approval_mechanism IS NOT OLD.approval_mechanism
         OR NEW.approval_challenge_id IS NOT OLD.approval_challenge_id OR NEW.origin IS NOT OLD.origin)
     BEGIN SELECT RAISE(ABORT, 'approval provenance is immutable once given'); END`,
    `CREATE TRIGGER IF NOT EXISTS approval_challenges_b7_spent BEFORE UPDATE ON approval_challenges
       WHEN OLD.used_at IS NOT NULL AND (NEW.used_at IS NOT OLD.used_at
         OR (OLD.used_outcome <> 'pending' AND NEW.used_outcome IS NOT OLD.used_outcome)
         OR NEW.action_id IS NOT OLD.action_id OR NEW.payload_hash IS NOT OLD.payload_hash OR NEW.version IS NOT OLD.version)
     BEGIN SELECT RAISE(ABORT, 'a spent approval challenge cannot be reused or rewritten'); END`,
    `CREATE TRIGGER IF NOT EXISTS action_legacy_history_b7_no_delete BEFORE DELETE ON action_legacy_history
     BEGIN SELECT RAISE(ABORT, 'legacy action history is kept for audit'); END`,
  ];
}

const ONE_ACTIVE_CHASE = `CREATE UNIQUE INDEX IF NOT EXISTS ux_prepared_actions_one_active_chase
  ON prepared_actions (commitment_id, json_extract(target_json, '$.personId'))
  WHERE action_type = 'chase_commitment' AND status IN (${ACTIVE.map((s) => `'${s}'`).join(', ')})`;

// ⚠ Column-aware: an older saim_actions shape has no resolved_at/created_at,
// and this migration is NOT swallowed at boot — assuming a column would brick
// startup on exactly the machine that most needs the history carried over.
function _cols(db, table) { return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name); }

function importLegacy(db, { now = Date.now(), log = console.log } = {}) {
  const cols = _cols(db, 'saim_actions');
  const pick = (c) => (cols.includes(c) ? c : `NULL AS ${c}`);
  const rows = db.prepare(`SELECT id, payload, ${pick('created_at')}, ${pick('resolved_at')} FROM saim_actions
                           WHERE type = 'chase_commitment' AND status = 'executed' ORDER BY id`).all();
  const ins = db.prepare(`INSERT OR IGNORE INTO action_legacy_history
      (legacy_ref, action_type, status, provenance, subject_ref, target_name, target_email, target_source,
       channel_requested, occurred_at, queued_at, imported_at, note)
      VALUES (?, 'legacy_chase', 'legacy_unverified', 'old_actions_queue', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let added = 0;
  for (const r of rows) {
    let p = {};
    try { p = JSON.parse(r.payload || '{}') || {}; } catch { p = {}; }
    const to = p.to || {};
    const res = ins.run(`saim_actions:${r.id}`, p.waitingKey ? `waiting-on:${p.waitingKey}` : null, p.person || null,
      to.email || null, to.source || null, p.channel || 'email', r.resolved_at || null, r.created_at || null,
      new Date(now).toISOString(),
      'Sent by the pre-Build-6 approval queue. It kept no attempt ledger, no provider message id and no Sent Items check, '
      + 'so this records only that the old queue marked it executed. Delivery is NOT verified'
      + (p.channel === 'teams' ? '; Teams was requested, and whether it went by Teams or fell back to email was not recorded' : '')
      + (to.source === 'manual' ? '; the recipient was a manual override typed on the chase' : '') + '.');
    added += res.changes;
  }
  if (added) log(`[DB] Build 7: recorded ${added} legacy chase(s) as legacy_unverified history`);
  return added;
}

function migrate(db, { log = console.log, now = Date.now() } = {}) {
  const hasPa = db.prepare('PRAGMA table_info(prepared_actions)').all().length > 0;
  db.exec(`CREATE TABLE IF NOT EXISTS approval_challenges (
    challenge_id  TEXT PRIMARY KEY,
    action_id     TEXT NOT NULL,
    version       INTEGER NOT NULL,
    payload_hash  TEXT NOT NULL,
    issued_at     TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    issued_to     TEXT,
    used_at       TEXT,
    used_outcome  TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_approval_challenges_action ON approval_challenges(action_id)');
  db.exec(`CREATE TABLE IF NOT EXISTS action_legacy_history (
    legacy_ref        TEXT PRIMARY KEY,
    action_type       TEXT NOT NULL CHECK (action_type = 'legacy_chase'),
    status            TEXT NOT NULL CHECK (status = 'legacy_unverified'),
    provenance        TEXT NOT NULL CHECK (provenance = 'old_actions_queue'),
    subject_ref       TEXT,
    target_name       TEXT,
    target_email      TEXT,
    target_source     TEXT,
    channel_requested TEXT,
    occurred_at       TEXT,
    queued_at         TEXT,
    imported_at       TEXT NOT NULL,
    note              TEXT NOT NULL
  )`);

  if (hasPa) {
    _addColumn(db, 'prepared_actions', 'origin', 'TEXT');
    _addColumn(db, 'prepared_actions', 'approval_mechanism', 'TEXT');
    _addColumn(db, 'prepared_actions', 'approval_challenge_id', 'TEXT');
  }
  for (const ddl of triggerDdl()) {
    if (!hasPa && ddl.includes('ON prepared_actions')) continue;
    db.exec(ddl);
  }

  if (hasPa) {
    // ⚠ The index is the database half of duplicate prevention. If rows that
    // already violate it exist, creating it fails — refuse LOUDLY rather than
    // brick the boot (the app-level check in prepared-actions still runs).
    try { db.exec(ONE_ACTIVE_CHASE); } catch (e) {
      console.error(`[DB] Build 7: could NOT create the one-active-chase index (${e.message}) — duplicate live chases exist; resolve them, then restart`);
    }
  }

  const hasSaim = db.prepare('PRAGMA table_info(saim_actions)').all().length > 0;
  let legacy = 0;
  let retired = 0;
  if (hasSaim) {
    legacy = importLegacy(db, { now, log });
    const stamp = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
    const r = _cols(db, 'saim_actions').includes('resolved_at')
      ? db.prepare(`UPDATE saim_actions SET status = 'superseded', resolved_at = ? WHERE type = 'chase_commitment' AND status = 'pending'`).run(stamp)
      : db.prepare(`UPDATE saim_actions SET status = 'superseded' WHERE type = 'chase_commitment' AND status = 'pending'`).run();
    retired = r.changes;
    if (retired) log(`[DB] Build 7: superseded ${retired} pending legacy chase(s) — chases now go through Actions → Drafted by NEURO`);
  }
  return { legacy, retired };
}

module.exports = { migrate, importLegacy, triggerDdl, ONE_ACTIVE_CHASE, ACTIVE };
