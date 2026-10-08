#!/usr/bin/env node
'use strict';

/**
 * One-off: send NOVA the repaired transcripts for the 1-2-1s / conversations it has
 * already APPROVED (the 2026-10-08 Plaud paging bug). Run AFTER
 * `plaud-repair-transcripts.js --apply`, and only once NOVA has the
 * `/121/transcript-correction` route (NOVA branch fix/121-transcript-correction).
 *
 * Dry run by default — lists exactly what would be sent. NOVA accepts a correction only
 * where the new text completes what it holds, and never re-extracts actions.
 *
 *   node scripts/nova-transcript-corrections.js
 *   node scripts/nova-transcript-corrections.js --apply
 *   node scripts/nova-transcript-corrections.js --ids a,b --apply
 */

const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch { /* env supplied by the caller */ }

const { correctNovaTranscripts } = require(path.join(__dirname, '..', 'services', 'nova-121-transcripts'));

const i = process.argv.indexOf('--ids');
const ids = i >= 0 ? process.argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean) : null;
const apply = process.argv.includes('--apply');

correctNovaTranscripts({ apply, ids }).then((r) => {
  if (!r.ok) { console.error(r.error); process.exit(1); }
  console.log(`${apply ? 'APPLIED' : 'DRY RUN'} — NOVA approved ${r.approved}; ` +
    `${apply ? `corrected ${r.corrected}, unchanged ${r.unchanged}, failed ${r.failed}` : `would send ${r.wouldSend}`}; ` +
    `still repeated in vault ${r.stillRepeated}`);
  for (const x of r.results) {
    const rows = x.rows ? `  [${x.rows.map((w) => `${w.table.replace('agent_', '')}#${w.id}: ${w.corrected ? 'corrected' : w.reason}`).join('; ')}]` : '';
    console.log(`  ${x.status.padEnd(24)} ${x.id} ${x.rel || ''}${x.error ? `  (${x.error})` : ''}${rows}`);
  }
  process.exit(r.failed ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
