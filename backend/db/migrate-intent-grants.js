'use strict';

/**
 * Human-originated action provenance (9 Oct 2026). Idempotent, run on every
 * boot after migrate-build11.
 *
 *   1. human_action_intents — one-use, 60-second grants minted when Nick
 *      presses the final button (Book, Move, Send…) on an attended NEURO
 *      surface. Bound to the action, its version and its payload hash.
 *   2. prepared_actions gains WHO started it and WHAT proved it:
 *        initiated_by     human_direct | human_assisted | neuro_autonomous |
 *                         machine:<client> | scheduler
 *        authority_proof  intent_grant | approval_code | trusted_device | none
 *        intent_grant_id  the grant spent, when there was one
 *   3. Triggers: a consumed grant cannot be rewritten or revived, and the
 *      provenance on an approved action is immutable (the Build 7 trigger
 *      already covers mechanism/challenge/origin; this covers the new three).
 *
 * Not swallowed by the caller: the triggers are the database half of "a grant
 * is single use", and a boot without them is a sending path without its gate.
 */

const COLUMNS = [['initiated_by', 'TEXT'], ['authority_proof', 'TEXT'], ['intent_grant_id', 'TEXT']];

function migrate(db, { log = console.log } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS human_action_intents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    action_capability TEXT NOT NULL,
    action_id TEXT,
    action_version INTEGER,
    payload_hash TEXT NOT NULL,
    session_id TEXT NOT NULL,
    surface TEXT NOT NULL CHECK (surface IN ('neuro-web', 'neuro-ios', 'saim-kiosk')),
    initiated_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    outcome TEXT CHECK (outcome IS NULL OR outcome IN ('pending', 'executed', 'expired', 'mismatch', 'cancelled', 'refused'))
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_human_action_intents_action ON human_action_intents (action_id)');

  const have = db.prepare('PRAGMA table_info(prepared_actions)').all().map((r) => r.name);
  for (const [col, ddl] of COLUMNS) {
    if (!have.includes(col)) { db.exec(`ALTER TABLE prepared_actions ADD COLUMN ${col} ${ddl}`); log(`[migrate-intent] prepared_actions.${col} added`); }
  }

  db.exec(`CREATE TRIGGER IF NOT EXISTS human_action_intents_spent BEFORE UPDATE ON human_action_intents
    WHEN OLD.consumed_at IS NOT NULL AND (
         NEW.consumed_at IS NOT OLD.consumed_at
      OR (OLD.outcome IS NOT 'pending' AND NEW.outcome IS NOT OLD.outcome)
      OR NEW.action_id IS NOT OLD.action_id OR NEW.payload_hash IS NOT OLD.payload_hash
      OR NEW.action_version IS NOT OLD.action_version OR NEW.expires_at IS NOT OLD.expires_at)
    BEGIN SELECT RAISE(ABORT, 'a spent intent grant cannot be revived or rewritten'); END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS human_action_intents_no_delete BEFORE DELETE ON human_action_intents
    BEGIN SELECT RAISE(ABORT, 'intent grants are kept for audit'); END`);
  // The trusted-device proof was retired the same day: historical rows keep it,
  // and nothing new may be recorded with it — in either column.
  db.exec(`CREATE TRIGGER IF NOT EXISTS prepared_actions_no_new_trusted_device BEFORE UPDATE ON prepared_actions
    WHEN (NEW.authority_proof = 'trusted_device' AND OLD.authority_proof IS NOT 'trusted_device')
      OR (NEW.approval_mechanism = 'trusted-device' AND OLD.approval_mechanism IS NOT 'trusted-device')
    BEGIN SELECT RAISE(ABORT, 'trusted_device is retired as an approval proof'); END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS prepared_actions_no_new_trusted_device_ins BEFORE INSERT ON prepared_actions
    WHEN NEW.authority_proof = 'trusted_device' OR NEW.approval_mechanism = 'trusted-device'
    BEGIN SELECT RAISE(ABORT, 'trusted_device is retired as an approval proof'); END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS prepared_actions_intent_provenance_immutable BEFORE UPDATE ON prepared_actions
    WHEN OLD.approved_payload_hash IS NOT NULL AND (NEW.initiated_by IS NOT OLD.initiated_by
      OR NEW.authority_proof IS NOT OLD.authority_proof OR NEW.intent_grant_id IS NOT OLD.intent_grant_id)
    BEGIN SELECT RAISE(ABORT, 'action provenance is immutable once approved'); END`);
}

module.exports = { migrate };
