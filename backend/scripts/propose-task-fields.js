#!/usr/bin/env node
'use strict';

/**
 * One-off backfill: work out NEURO's SUGGESTED MoSCoW / estimate / due date for
 * every open task that is missing them (services/task-proposals.js).
 *
 * DRY RUN BY DEFAULT — prints what it would suggest and writes nothing.
 * `--apply` stores the suggestions in `tasks.proposals_json` ONLY; it never
 * touches moscow / estimate_minutes / due_date, which stay Nick's.
 *
 *   node backend/scripts/propose-task-fields.js            # dry run
 *   node backend/scripts/propose-task-fields.js --apply    # store suggestions
 *   node backend/scripts/propose-task-fields.js --verbose  # list each task
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../db/database');

async function main() {
  const apply = process.argv.includes('--apply');
  const verbose = process.argv.includes('--verbose');
  await db.init();
  const proposals = require('../services/task-proposals');

  const all = db.listTaskRows({ status: 'all' });
  const open = all.filter(r => r.status === 'open' || r.status === 'in-progress');
  const ctx = proposals._context(all);
  const now = new Date();

  const counts = {
    open: open.length,
    missing: { moscow: 0, estimate: 0, due: 0 },
    proposed: { moscow: 0, estimate: 0, due: 0 },
    basis: {},
    changed: 0,
  };
  for (const row of open) {
    if (!row.moscow) counts.missing.moscow++;
    if (row.estimate_minutes == null) counts.missing.estimate++;
    if (!row.due_date) counts.missing.due++;
    const p = proposals.forRow(row, { ctx, now });
    for (const f of proposals.FIELDS) {
      if (!p[f]) continue;
      counts.proposed[f]++;
      const k = `${f}:${p[f].basis}`;
      counts.basis[k] = (counts.basis[k] || 0) + 1;
    }
    const next = proposals.encode(p);
    if ((next || null) !== (row.proposals_json || null)) {
      counts.changed++;
      if (apply) db.updateTaskRow(row.id, { proposals_json: next });
    }
    if (verbose && Object.keys(p).length) {
      const bits = [];
      if (p.moscow) bits.push(`MoSCoW ${p.moscow.value}?`);
      if (p.estimate) bits.push(`~${p.estimate.minutes}m? (${p.estimate.why})`);
      if (p.due) bits.push(`due ${p.due.date}? (${p.due.basis})`);
      console.log(`#${row.id} ${String(row.text).slice(0, 70)} → ${bits.join(' · ')}`);
    }
  }
  console.log(JSON.stringify({ mode: apply ? 'APPLIED' : 'dry run (nothing written)', ...counts }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
