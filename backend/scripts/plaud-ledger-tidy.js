#!/usr/bin/env node
'use strict';

/**
 * PLAUD sync ledger tidy-up (15 Oct 2026) — DRY RUN BY DEFAULT.
 *
 * Clears ledger entries that can never change state again, so the retry window and the
 * status screen stop describing work that does not exist:
 *   - a speaker HOLD on a recording that was already pulled (the hold was never cleared);
 *   - a FAILURE on a recording PLAUD no longer holds (get_file 404 by its of_ id) and the
 *     vault has no note for;
 *   - a FAILURE on a recording that is already SYNCED (a re-pull that used the bare id).
 * It NEVER touches: syncedRecordings, pendingRecordings, a failure for a recording PLAUD
 * still holds and NEURO has not synced, or anything without evidence supplied.
 *
 * Evidence is supplied, never fetched here (no PLAUD or vault access from this script):
 *   { "<canonical id>": { "plaud": "present"|"gone", "activeNotes": <n> } }
 *
 *   node backend/scripts/plaud-ledger-tidy.js --from-json <ledger.json> --evidence <ev.json>
 *   node backend/scripts/plaud-ledger-tidy.js --evidence <ev.json> --apply   (live DB; backs up first)
 */

/** PURE. The proposed change for every hold and failure, with its reason. */
function planTidy(state, evidence = {}) {
  const synced = state.syncedRecordings || {};
  const pending = state.pendingRecordings || {};
  const items = [];
  for (const [id, hold] of Object.entries(state.pendingSpeakers || {})) {
    const ev = evidence[id] || {};
    if (synced[id] && ev.activeNotes > 0) {
      items.push({ ledger: 'pendingSpeakers', id, current: `held since ${hold.firstSeenAt}, ${hold.attempts} attempt(s); already synced ${synced[id].syncedAt}`, change: 'remove', reason: 'already pulled — the hold can never apply again', recoverable: true });
    } else if (!synced[id] && ev.plaud === 'gone') {
      items.push({ ledger: 'pendingSpeakers', id, current: `held since ${hold.firstSeenAt}; not synced`, change: 'remove', reason: 'PLAUD no longer holds this recording, so it can never be pulled', recoverable: true });
    } else {
      items.push({ ledger: 'pendingSpeakers', id, current: `held since ${hold.firstSeenAt}`, change: 'keep', reason: 'not proven stale', recoverable: true });
    }
  }
  for (const [id, f] of Object.entries(state.failedRecordings || {})) {
    const ev = evidence[id] || {};
    const current = `failed ${f.failedAt}${f.attempts ? ` (${f.attempts} attempts)` : ''}: ${f.message}`;
    if (synced[id] && ev.activeNotes > 0) {
      items.push({ ledger: 'failedRecordings', id, current, change: 'remove', reason: 'already synced with notes in the vault — the failure was a later re-pull attempt', recoverable: true });
    } else if (!synced[id] && ev.plaud === 'gone' && ev.activeNotes === 0) {
      items.push({ ledger: 'failedRecordings', id, current, change: 'remove', reason: 'PLAUD returns 404 for it by its of_ id and the vault has no note — it can never succeed', recoverable: true });
    } else if (pending[id]) {
      items.push({ ledger: 'failedRecordings', id, current, change: 'keep', reason: 'still outstanding: PLAUD holds it but has not transcribed it (tracked as pending too)', recoverable: true });
    } else if (ev.plaud === 'present' && !synced[id]) {
      items.push({ ledger: 'failedRecordings', id, current, change: 'keep', reason: 'PLAUD still holds it and NEURO has no note — the re-pull resolves it', recoverable: true });
    } else {
      items.push({ ledger: 'failedRecordings', id, current, change: 'keep', reason: 'no evidence supplied', recoverable: true });
    }
  }
  return items;
}

/** PURE. The ledger after the plan; never mutates its input. */
function applyPlan(state, items) {
  const next = JSON.parse(JSON.stringify(state));
  for (const i of items) if (i.change === 'remove' && next[i.ledger]) delete next[i.ledger][i.id];
  return next;
}

module.exports = { planTidy, applyPlan };

if (require.main === module) {
  const fs = require('fs');
  const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };
  const apply = process.argv.includes('--apply');
  const evidence = JSON.parse(fs.readFileSync(arg('evidence'), 'utf8'));
  (async () => {
    let state; let db = null;
    if (arg('from-json')) state = JSON.parse(fs.readFileSync(arg('from-json'), 'utf8'));
    else { db = require('../db/database'); await db.init(); state = JSON.parse(db.getState('plaud_sync_state') || '{}'); }
    const items = planTidy(state, evidence);
    for (const i of items) console.log(`${i.change.toUpperCase().padEnd(6)} ${i.ledger.padEnd(16)} ${i.id}  — ${i.reason}\n         now: ${i.current}`);
    const removed = items.filter((i) => i.change === 'remove').length;
    console.log(`\n${removed} to remove, ${items.length - removed} kept.${apply ? '' : ' DRY RUN — nothing written.'}`);
    if (apply) {
      if (!db) { console.error('refusing: --apply only against the live DB, never a --from-json copy'); process.exit(2); }
      const key = `plaud_sync_state_backup_${new Date().toISOString().replace(/[:.]/g, '-')}`;
      db.setState(key, JSON.stringify(state));
      db.setState('plaud_sync_state', JSON.stringify(applyPlan(state, items)));
      console.log(`applied; the previous ledger is kept in agent_state.${key}`);
    }
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
