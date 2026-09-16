#!/usr/bin/env node
'use strict';

/**
 * Reject pending capture_todo candidates whose SOURCE NOTE no longer exists.
 *
 * ⚠ THE RULE, NOT A LIST. On 15 Sep 2026 a PLAUD id-format change re-pulled 118
 * recordings into 111 duplicate notes, and `action-candidates` did exactly what it is
 * built to do: it read 69 notes it had never seen and raised 364 commitments, 340 of
 * which Nick had already rejected or done. Archiving the duplicates removes the source;
 * this removes what they raised. Written as a rule so it also covers the next note that
 * is legitimately deleted or archived, rather than only this incident.
 *
 * ⚠ AN UNREADABLE VAULT REFUSES THE WHOLE RUN. Every note looks missing when the disk
 * is not there, and "reject everything" is the one outcome this must never produce by
 * accident.
 *
 * ⚠ capture_todo ONLY. Nothing here can touch anything that leaves the building; the
 * queue's own bulk-reject makes the same refusal and for the same reason.
 *
 * ⚠ It goes through `rememberReviewedAction`, exactly as the route does, so the note is
 * recorded as reviewed and the candidate is not raised again on the next scan.
 *
 * Dry run by default.
 */

const fs = require('fs');
const path = require('path');
const db = require(path.join(__dirname, '..', 'db', 'database'));
const actionCandidates = require(path.join(__dirname, '..', 'services', 'action-candidates'));

const apply = process.argv.includes('--apply');
const VAULT = process.env.OBSIDIAN_VAULT_PATH || '';

async function main() {
  if (!VAULT || !path.isAbsolute(VAULT) || !fs.existsSync(VAULT) || !fs.statSync(VAULT).isDirectory()) {
    console.error('[stale-candidates] Vault not readable at "' + VAULT + '". REFUSING — with no vault every ' +
      'source note reads as missing, and this would reject the entire review queue.');
    process.exit(1);
  }

  await db.init();

  const pending = db.getPendingSaimActions(10000).filter((a) => a.type === 'capture_todo');
  const missing = [];
  const kept = [];
  const unreadable = [];

  for (const action of pending) {
    let payload = action.payload;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { payload = {}; }
    }
    const source = payload && payload.sourcePath;
    if (!source) {
      // No source recorded is not evidence the source is gone.
      kept.push({ id: action.id, why: 'no sourcePath recorded' });
      continue;
    }
    const abs = path.join(VAULT, source);
    let exists;
    try { exists = fs.existsSync(abs); } catch (error) { unreadable.push({ id: action.id, source, why: error.message }); continue; }
    if (exists) kept.push({ id: action.id, source });
    else missing.push({ id: action.id, source, text: String((payload && payload.text) || '').slice(0, 70) });
  }

  const bySource = {};
  for (const m of missing) bySource[m.source] = (bySource[m.source] || 0) + 1;

  console.log('Pending capture_todo: ' + pending.length);
  console.log('Source note still present: ' + kept.length);
  console.log('Source note GONE (archived or deleted): ' + missing.length);
  if (unreadable.length) console.log('Source unreadable (left alone): ' + unreadable.length);
  console.log('');
  console.log('Distinct missing source notes: ' + Object.keys(bySource).length);
  console.table(Object.entries(bySource).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([source, n]) => ({ n, source: source.slice(-72) })));
  console.log('');
  console.log('Sample of what would be rejected:');
  console.table(missing.slice(0, 8).map((m) => ({ id: m.id, text: m.text })));

  if (!apply) {
    console.log('');
    console.log('DRY RUN — nothing rejected. Re-run with --apply.');
    return;
  }

  let rejected = 0;
  const failures = [];
  for (const m of missing) {
    try {
      const action = db.getSaimAction(m.id);
      if (!action || action.status !== 'pending') { failures.push({ id: m.id, why: 'no longer pending' }); continue; }
      db.updateSaimActionStatus(action.id, 'rejected');
      // Same call the route makes, so the note is recorded as reviewed and this is not
      // raised again on the next scan.
      actionCandidates.rememberReviewedAction(action, 'rejected');
      try { db.logActivity('saim_action_rejected', { actionId: action.id, type: action.type, reason: 'source note archived or deleted' }); } catch {}
      rejected += 1;
    } catch (error) {
      failures.push({ id: m.id, why: error.message });
    }
  }

  console.log('');
  console.log('Rejected ' + rejected + ' candidates whose source note is gone.');
  if (failures.length) { console.log('Failures:'); console.table(failures.slice(0, 10)); }
}

main().catch((error) => {
  console.error('[stale-candidates] failed:', error.message);
  process.exit(1);
});
