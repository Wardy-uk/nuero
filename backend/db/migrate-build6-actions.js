'use strict';

/**
 * Build 6 migration for `prepared_actions` (3 Oct 2026).
 *
 * ⚠ THIS IS THE MIGRATION BUILD 5 SAID A FUTURE BUILD MUST WRITE. Build 5
 * installed two triggers refusing `executed` outright and documented that an
 * executing build "must drop this trigger in a migration that says so". This is
 * that migration, and it says so: the Build 5 triggers are DROPPED here and
 * replaced by narrower ones — one executable type, only after an approval that
 * binds the exact payload hash, never twice.
 *
 * Two parts, both idempotent, run on every boot after schema.sql:
 *
 *   1. REBUILD an old-shape table. SQLite cannot widen a CHECK, and the status
 *      vocabulary grows (executing, execution_uncertain, verified, failed,
 *      superseded). The old rows are COPIED, never dropped: every row gets a
 *      payload hash computed by the same function approvals use, version 1,
 *      and its subject ref. Measured before writing: the live table held
 *      ZERO rows on 3 Oct 2026, but this must be correct for the rows a test
 *      or another machine may hold, so it is written as a copy, not a guard.
 *   2. INSTALL the Build 6 triggers. The executable-type allow-list is
 *      generated from services/action-registry.js and REPLACED on every boot,
 *      so the database and the registry cannot drift.
 */

const registry = require('../services/action-registry');

const NEW_TABLE_DDL = (name) => `CREATE TABLE ${name} (
  action_id             TEXT PRIMARY KEY,
  idempotency_key       TEXT NOT NULL UNIQUE,
  finding_id            TEXT NOT NULL,
  commitment_id         TEXT NOT NULL,
  subject_ref           TEXT,
  action_type           TEXT NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1,
  parent_action_id      TEXT,
  target_json           TEXT NOT NULL,
  reason                TEXT NOT NULL,
  evidence_json         TEXT NOT NULL,
  evidence_hash         TEXT,
  draft_json            TEXT NOT NULL,
  payload_hash          TEXT NOT NULL,
  authority_class       TEXT NOT NULL CHECK (authority_class = 'A4'),
  approval_required     INTEGER NOT NULL DEFAULT 1 CHECK (approval_required = 1),
  status                TEXT NOT NULL CHECK (status IN ('prepared', 'approved', 'executing', 'execution_uncertain',
                          'executed', 'verified', 'failed', 'rejected', 'expired', 'cancelled', 'superseded')),
  created_at            TEXT NOT NULL,
  expires_at            TEXT,
  decided_at            TEXT,
  decision_note         TEXT,
  approved_by           TEXT,
  approved_at           TEXT,
  approved_payload_hash TEXT,
  approved_evidence_hash TEXT,
  approval_expires_at   TEXT,
  executed_at           TEXT,
  verified_at           TEXT,
  chase_recorded_at     TEXT,
  last_check_at         TEXT,
  last_block            TEXT,
  outcome_detail        TEXT,
  retry_safe            INTEGER,
  history_json          TEXT NOT NULL,
  updated_at            TEXT NOT NULL
)`;

const parse = (j) => { try { return j ? JSON.parse(j) : null; } catch { return null; } };

const TERMINAL = ['verified', 'failed', 'rejected', 'expired', 'cancelled', 'superseded'];

function triggerDdl() {
  const exec = registry.executableTypes().map((t) => `'${t.replace(/'/g, "''")}'`).join(', ') || "''";
  return [
    // A row is born prepared. Approval, execution and every later state are
    // TRANSITIONS, which is what the update triggers below can see.
    `CREATE TRIGGER IF NOT EXISTS prepared_actions_b6_born_prepared BEFORE INSERT ON prepared_actions
       WHEN NEW.status <> 'prepared'
     BEGIN SELECT RAISE(ABORT, 'a prepared action is born prepared'); END`,
    `CREATE TRIGGER IF NOT EXISTS prepared_actions_b6_no_delete BEFORE DELETE ON prepared_actions
     BEGIN SELECT RAISE(ABORT, 'prepared actions are kept for audit and never deleted'); END`,
    // The approved payload cannot change underneath its approval. An edit is a
    // NEW ROW (a new version) that needs its own approval.
    `CREATE TRIGGER IF NOT EXISTS prepared_actions_b6_payload_immutable BEFORE UPDATE ON prepared_actions
       WHEN NEW.draft_json IS NOT OLD.draft_json OR NEW.target_json IS NOT OLD.target_json
         OR NEW.payload_hash IS NOT OLD.payload_hash OR NEW.action_type IS NOT OLD.action_type
         OR NEW.version IS NOT OLD.version OR NEW.commitment_id IS NOT OLD.commitment_id
         OR NEW.idempotency_key IS NOT OLD.idempotency_key
     BEGIN SELECT RAISE(ABORT, 'a prepared action''s payload is immutable — an edit creates a new version'); END`,
    `CREATE TRIGGER IF NOT EXISTS prepared_actions_b6_approval_immutable BEFORE UPDATE ON prepared_actions
       WHEN OLD.approved_payload_hash IS NOT NULL AND (NEW.approved_payload_hash IS NOT OLD.approved_payload_hash
         OR NEW.approved_by IS NOT OLD.approved_by OR NEW.approved_at IS NOT OLD.approved_at
         OR NEW.approval_expires_at IS NOT OLD.approval_expires_at)
     BEGIN SELECT RAISE(ABORT, 'an approval is immutable once given'); END`,
    // Approval must bind THIS payload, by a named approver, from `prepared`.
    `CREATE TRIGGER IF NOT EXISTS prepared_actions_b6_approve_binds BEFORE UPDATE OF status ON prepared_actions
       WHEN NEW.status = 'approved' AND OLD.status <> 'approved' AND (OLD.status <> 'prepared'
         OR NEW.approved_payload_hash IS NULL OR NEW.approved_payload_hash <> NEW.payload_hash OR NEW.approved_by IS NULL)
     BEGIN SELECT RAISE(ABORT, 'an approval must bind the exact payload hash, name its approver, and come from prepared'); END`,
    // A4 cannot execute unapproved: only approved → executing, and only while the
    // approval still matches the payload.
    `CREATE TRIGGER IF NOT EXISTS prepared_actions_b6_execute_gate BEFORE UPDATE OF status ON prepared_actions
       WHEN NEW.status = 'executing' AND (OLD.status <> 'approved' OR NEW.approved_payload_hash IS NULL
         OR NEW.approved_payload_hash <> NEW.payload_hash)
     BEGIN SELECT RAISE(ABORT, 'only an approved action whose payload matches its approval can execute'); END`,
    // The allow-list, from the registry. Replaced every boot (see below).
    `CREATE TRIGGER prepared_actions_b6_executable_types BEFORE UPDATE OF status ON prepared_actions
       WHEN NEW.status IN ('executing', 'execution_uncertain', 'executed', 'verified') AND NEW.action_type NOT IN (${exec})
     BEGIN SELECT RAISE(ABORT, 'not an executable action type'); END`,
    // The legal shape of execution. `executed` only from `executing`; `verified`
    // only after something was sent; `execution_uncertain` only from a send.
    `CREATE TRIGGER IF NOT EXISTS prepared_actions_b6_lifecycle BEFORE UPDATE OF status ON prepared_actions
       WHEN NEW.status <> OLD.status AND (
            (NEW.status = 'executed' AND OLD.status <> 'executing')
         OR (NEW.status = 'verified' AND OLD.status NOT IN ('executed', 'execution_uncertain'))
         OR (NEW.status = 'execution_uncertain' AND OLD.status NOT IN ('executing', 'executed')))
     BEGIN SELECT RAISE(ABORT, 'illegal execution transition'); END`,
    // Terminal means terminal. A verified action never executes again.
    `CREATE TRIGGER IF NOT EXISTS prepared_actions_b6_terminal BEFORE UPDATE OF status ON prepared_actions
       WHEN NEW.status <> OLD.status AND OLD.status IN (${TERMINAL.map((s) => `'${s}'`).join(', ')})
     BEGIN SELECT RAISE(ABORT, 'a terminal action does not change state'); END`,
  ];
}

function migrate(db, { log = console.log } = {}) {
  const cols = db.prepare('PRAGMA table_info(prepared_actions)').all().map((r) => r.name);
  if (!cols.length) return { rebuilt: false, rows: 0 };

  let rebuilt = false;
  let rows = 0;
  if (!cols.includes('payload_hash')) {
    const old = db.prepare('SELECT * FROM prepared_actions').all();
    const tx = db.transaction(() => {
      db.exec('DROP TRIGGER IF EXISTS prepared_actions_never_executed_b5');
      db.exec('DROP TRIGGER IF EXISTS prepared_actions_never_inserted_executed_b5');
      db.exec('DROP TABLE IF EXISTS prepared_actions_b6');
      db.exec(NEW_TABLE_DDL('prepared_actions_b6'));
      const ins = db.prepare(`INSERT INTO prepared_actions_b6 (action_id, idempotency_key, finding_id, commitment_id, subject_ref,
          action_type, version, target_json, reason, evidence_json, evidence_hash, draft_json, payload_hash, authority_class,
          approval_required, status, created_at, expires_at, decided_at, decision_note, history_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const r of old) {
        const evidence = parse(r.evidence_json);
        const target = parse(r.target_json);
        const draft = parse(r.draft_json);
        const ref = evidence && evidence.commitment && evidence.commitment.source ? evidence.commitment.source.ref || null : null;
        ins.run(r.action_id, r.idempotency_key, r.finding_id, r.commitment_id, ref, r.action_type, r.target_json, r.reason,
          r.evidence_json, registry.evidenceHash(evidence),
          r.draft_json, registry.payloadHash({ actionType: r.action_type, version: 1, commitmentId: r.commitment_id, target, draft }),
          r.authority_class, r.approval_required, r.status, r.created_at, r.expires_at, r.decided_at, r.decision_note,
          r.history_json, r.updated_at);
      }
      db.exec('DROP TABLE prepared_actions');
      db.exec('ALTER TABLE prepared_actions_b6 RENAME TO prepared_actions');
      db.exec('CREATE INDEX IF NOT EXISTS idx_prepared_actions_status ON prepared_actions(status, created_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_prepared_actions_finding ON prepared_actions(finding_id)');
    });
    tx();
    rebuilt = true;
    rows = old.length;
    log(`[DB] Build 6: prepared_actions rebuilt for approval-gated execution (${rows} row(s) carried over; Build 5 "never executed" triggers dropped and replaced)`);
  }

  // Safe on every boot: the Build 5 triggers must not come back, and the
  // allow-list trigger is regenerated from the registry.
  db.exec('DROP TRIGGER IF EXISTS prepared_actions_never_executed_b5');
  db.exec('DROP TRIGGER IF EXISTS prepared_actions_never_inserted_executed_b5');
  db.exec('DROP TRIGGER IF EXISTS prepared_actions_b6_executable_types');
  for (const ddl of triggerDdl()) db.exec(ddl);
  db.exec('CREATE INDEX IF NOT EXISTS idx_prepared_actions_subject ON prepared_actions(subject_ref, status)');
  return { rebuilt, rows };
}

module.exports = { migrate, triggerDdl, NEW_TABLE_DDL };
