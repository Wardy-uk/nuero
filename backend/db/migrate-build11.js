'use strict';

/**
 * Build 11 migration (3 Oct 2026) — the personal world model and governed
 * calendar actions. Idempotent, run on every boot after migrate-build8-actions.
 *
 *   1. COLUMNS, ADD COLUMN only (never a rebuild):
 *        goals          description, importance, start_date, review_date,
 *                       last_reviewed_at, provenance — 11F
 *        wm_meetings    calendar_key, calendar_name — 11C (which calendar an
 *                       entry came through; classification is applied at READ)
 *        wm_people      relationship, household — 11E (only what a note STATES)
 *   2. GOAL STATUS. Build 10 called a finished goal `done`; Build 11's
 *      vocabulary is `achieved`. Rows are renamed in place (0 live on 3 Oct).
 *   3. DUPLICATE IDENTITY for calendar actions, in the database (11K):
 *        create_calendar_event      one live action per prepared subject
 *        reschedule/cancel          one live action per calendar event
 *      The executable allow-list trigger needs nothing here — Build 6's
 *      migration regenerates it from the registry on every boot.
 */

const ACTIVE = ['prepared', 'approved', 'executing', 'execution_uncertain', 'executed'];
const q = (list) => list.map((s) => `'${s}'`).join(', ');

const COLUMNS = {
  goals: [['description', 'TEXT'], ['importance', 'TEXT'], ['start_date', 'TEXT'], ['review_date', 'TEXT'],
    ['last_reviewed_at', 'TEXT'], ['provenance', 'TEXT']],
  wm_meetings: [['calendar_key', 'TEXT'], ['calendar_name', 'TEXT']],
  wm_people: [['relationship', 'TEXT'], ['household', 'INTEGER']],
};

const INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_prepared_actions_one_active_calendar_create
     ON prepared_actions (commitment_id) WHERE action_type = 'create_calendar_event' AND status IN (${q(ACTIVE)})`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_prepared_actions_one_active_calendar_change
     ON prepared_actions (commitment_id) WHERE action_type IN ('reschedule_calendar_event', 'cancel_calendar_event')
       AND status IN (${q(ACTIVE)})`,
];

function migrate(db, { log = console.log } = {}) {
  const added = [];
  for (const [table, cols] of Object.entries(COLUMNS)) {
    const have = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
    if (!have.length) continue;
    for (const [name, type] of cols) {
      if (!have.includes(name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
        added.push(`${table}.${name}`);
      }
    }
  }
  if (added.length) log(`[DB] Build 11 columns added: ${added.join(', ')}`);

  const goalCols = db.prepare('PRAGMA table_info(goals)').all().map((r) => r.name);
  if (goalCols.length) {
    const r = db.prepare("UPDATE goals SET status = 'achieved' WHERE status = 'done'").run();
    if (r.changes) log(`[DB] Build 11: ${r.changes} goal(s) renamed done → achieved`);
  }

  if (db.prepare('PRAGMA table_info(prepared_actions)').all().length) {
    for (const ddl of INDEXES) db.exec(ddl);
  }
  return { added };
}

module.exports = { migrate, COLUMNS, INDEXES };
