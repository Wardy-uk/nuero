#!/usr/bin/env node
'use strict';

/**
 * Collapse the PLAUD sync ledger onto canonical recording ids.
 *
 * ⚠ WHY THIS IS NOT OPTIONAL. On 15 Sep 2026 PLAUD started prefixing ids with `of_`,
 * so the ledger came to hold 118 recordings TWICE — once as `X` (synced in July) and
 * once as `of_X` (re-pulled, writing a duplicate note). The code fix keys new work on
 * the canonical id, but the 376 entries still filed under bare ids are a LANDMINE:
 * `reconcilePlaudRecordings` / `repullPlaudRecordings` bypass the incremental window,
 * would match none of them, and would duplicate the entire back catalogue.
 *
 * ⚠ THE MERGE KEEPS THE ORIGINAL NOTE'S PATHS AND THE NEWEST FINGERPRINT, and both
 * halves matter. The paths, because the July note is the GOOD copy — the re-pulled twin
 * lost its `people:` list and `serial_number`. The fingerprint, because
 * `shouldProcessRecording` re-pulls anything whose fingerprint has moved, so keeping the
 * older one would re-download all 118 and rewrite the very notes we are keeping.
 *
 * Dry run by default. Writes a timestamped backup of the key before touching it.
 */

const path = require('path');
const fs = require('fs');
const db = require(path.join(__dirname, '..', 'db', 'database'));
const { canonicalPlaudId, unknownPrefix } = require(path.join(__dirname, '..', '..', 'shared', 'plaud-id.cjs'));

const STATE_KEY = 'plaud_sync_state';
const apply = process.argv.includes('--apply');

function newer(a, b) {
  const at = Date.parse(a && a.syncedAt) || 0;
  const bt = Date.parse(b && b.syncedAt) || 0;
  return bt > at ? b : a;
}

function mergeEntry(original, duplicate) {
  // `original` is the entry already filed under the canonical id.
  if (!original) return duplicate;
  if (!duplicate) return original;
  const latest = newer(original, duplicate);
  return {
    ...original,
    // Paths: the ORIGINAL note, always. Never the re-pulled twin.
    summaryRelativePath: original.summaryRelativePath,
    transcriptRelativePath: original.transcriptRelativePath,
    // Freshness: the newest we know about, so nothing re-pulls.
    syncedAt: latest.syncedAt || original.syncedAt,
    sourceFingerprint: latest.sourceFingerprint != null ? latest.sourceFingerprint : original.sourceFingerprint,
    summaryPreferenceRank: Math.max(original.summaryPreferenceRank || 0, duplicate.summaryPreferenceRank || 0),
  };
}

function collapse(map, label, report) {
  const out = {};
  let merged = 0;
  let rekeyed = 0;
  for (const [key, value] of Object.entries(map || {})) {
    const canonical = canonicalPlaudId(key) || key;
    const prefix = unknownPrefix(key);
    if (prefix) report.unknownPrefixes.add(prefix);
    if (canonical !== key) rekeyed += 1;
    if (out[canonical]) {
      merged += 1;
      out[canonical] = mergeEntry(out[canonical], value);
    } else {
      out[canonical] = value;
    }
  }
  report.sections.push({ section: label, before: Object.keys(map || {}).length, after: Object.keys(out).length, rekeyed, merged });
  return out;
}

async function main() {
  await db.init();
  const raw = db.getState(STATE_KEY);
  if (!raw) {
    console.error(`[migrate] ${STATE_KEY} is not set — nothing to migrate. REFUSING rather than writing an empty ledger.`);
    process.exit(1);
  }

  let state;
  try {
    state = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    console.error(`[migrate] ${STATE_KEY} did not parse (${error.message}). REFUSING — an unreadable ledger is never overwritten.`);
    process.exit(1);
  }

  const report = { sections: [], unknownPrefixes: new Set() };
  const next = {
    ...state,
    syncedRecordings: collapse(state.syncedRecordings, 'syncedRecordings', report),
    failedRecordings: collapse(state.failedRecordings, 'failedRecordings', report),
    pendingSpeakers: collapse(state.pendingSpeakers, 'pendingSpeakers', report),
  };

  console.table(report.sections);
  if (report.unknownPrefixes.size) {
    console.warn(`[migrate] ⚠ ids carrying an UNRECOGNISED prefix: ${[...report.unknownPrefixes].join(', ')} — ` +
      'these were left as-is. Add them to shared/plaud-id.cjs KNOWN_PREFIXES and re-run, or the next sync writes duplicates.');
  }

  const totalMerged = report.sections.reduce((n, s) => n + s.merged, 0);
  console.log(`\n${totalMerged} duplicate ledger entries collapsed.`);

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
    return;
  }

  // Beside the database, NEVER in the repo working tree: an untracked file there
  // blocks the next `git pull --ff-only` on the Pi, which is how a deploy silently
  // stops at the previous commit.
  const stamp = new Date().toISOString().split(':').join('-').split('.').join('-');
  const backup = path.join(__dirname, '..', 'db', 'plaud_sync_state.backup.' + stamp + '.json');
  fs.writeFileSync(backup, typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2));
  console.log(`Backed up the previous ledger to ${backup}`);

  db.setState(STATE_KEY, JSON.stringify(next));
  console.log('Ledger written.');
}

main().catch((error) => {
  console.error('[migrate] failed:', error.message);
  process.exit(1);
});
