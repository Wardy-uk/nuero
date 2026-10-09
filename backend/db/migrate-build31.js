'use strict';

/**
 * Build 31 migration (9 Oct 2026) — personal relationships & people context.
 * Idempotent, run on every boot after migrate-build11. ADD COLUMN only.
 *
 *   wm_people  relationship_detail, sphere, importance, likes_json, merged_into
 *              — each only what a People note STATES (NULL = it does not say).
 *
 * The decisions table (keep-separate / not-this-person) is in schema.sql.
 * The projection fills the new columns on the next People publish; a note that
 * states none of them keeps its fingerprint, so nothing is republished for it.
 */

const COLUMNS = {
  wm_people: [['relationship_detail', 'TEXT'], ['sphere', 'TEXT'], ['importance', 'TEXT'], ['likes_json', 'TEXT'], ['merged_into', 'TEXT']],
};

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
  if (added.length) log(`[DB] Build 31 columns added: ${added.join(', ')}`);
  return { added };
}

module.exports = { migrate, COLUMNS };
