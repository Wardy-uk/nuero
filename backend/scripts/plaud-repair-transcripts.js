#!/usr/bin/env node
'use strict';

/**
 * Repair PLAUD transcripts that hold a repeated block (the 2026-10-08 paging bug).
 *
 * `fetchTranscriptSegments` paged by `offset`, which get_transcript does not take, so it
 * received page one every time and wrote the first 50 segments ceil(total/50) times —
 * 145 of 263 vault transcripts. This re-fetches each one through the fixed, guarded path
 * and rewrites ONLY the segment lines of the `Plaud/Transcripts` note.
 *
 * DRY RUN BY DEFAULT. It still reads PLAUD, so the report says what each repaired file
 * would hold. Nothing is written without --apply.
 *
 *   node scripts/plaud-repair-transcripts.js                  # dry run, all damaged
 *   node scripts/plaud-repair-transcripts.js --limit 3        # dry run, first 3
 *   node scripts/plaud-repair-transcripts.js --apply          # back up, then rewrite
 *   node scripts/plaud-repair-transcripts.js --ids a,b --apply
 *   node scripts/plaud-repair-transcripts.js --out /tmp/r.json
 *
 * Backups: Scripts/.lint-backups/plaud-repair-<date>/<same path>. Deliberately NOT under
 * Imports/ — the import pipeline walks that folder and would route every copy back in.
 *
 * Idempotent: a repaired note has no repeated line, so a second run finds nothing.
 * Takes the PLAUD run lock, so it cannot overlap the 15-minute sync.
 */

const path = require('path');
const fs = require('fs');

try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch { /* env supplied by the caller */ }

const db = require(path.join(__dirname, '..', 'db', 'database'));
const plaud = require(path.join(__dirname, '..', 'services', 'plaud-sync'));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

(async () => {
  if (!process.env.OBSIDIAN_VAULT_PATH || !path.isAbsolute(process.env.OBSIDIAN_VAULT_PATH)) {
    console.error('OBSIDIAN_VAULT_PATH must be set to an absolute path — refusing to guess where the vault is.');
    process.exit(2);
  }
  await db.init();
  const apply = process.argv.includes('--apply');
  const limit = arg('--limit') ? Number(arg('--limit')) : null;
  const ids = arg('--ids') ? arg('--ids').split(',').map((s) => s.trim()).filter(Boolean) : null;

  const result = await plaud.repairRepeatedTranscripts({ dryRun: !apply, limit, ids });
  const out = arg('--out');
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 1));

  if (!result.started) {
    console.log(`Not started: ${result.reason}`);
    process.exit(1);
  }
  console.log(`${apply ? 'APPLIED' : 'DRY RUN'} — found ${result.found}, scanned ${result.scanned}, ` +
    `${apply ? `repaired ${result.repaired}` : `would repair ${result.wouldRepair}`}, ` +
    `refused ${result.refused}, failed ${result.failed}${apply ? `; backups in ${result.backupDir}` : ''}`);
  for (const r of result.results) {
    const before = r.before ? `${r.before.segments}/${r.before.unique} to ${r.before.coveredTo}` : '?';
    const after = r.after ? `${r.after.segments} to ${r.after.coveredTo}` : '-';
    console.log(`  ${r.status.padEnd(12)} ${before.padEnd(18)} -> ${after.padEnd(14)} ${r.rel}${r.error ? `  (${r.error})` : ''}`);
  }
  process.exit(result.refused || result.failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
