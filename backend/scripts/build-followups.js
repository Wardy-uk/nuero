#!/usr/bin/env node
'use strict';

/**
 * Reconcile a build's Nick-owned follow-ups into real NEURO tasks (Build 23AH).
 *
 *   node backend/scripts/build-followups.js            # dry run: what would happen
 *   node backend/scripts/build-followups.js --apply    # create / link the tasks
 *
 * An open task that already says the same thing is reused; one Nick already
 * finished is recorded as resolved and never recreated. Run from backend/ on
 * the Pi (it opens the live DB).
 */

const apply = process.argv.includes('--apply');

(async () => {
  const db = require('../db/database');
  await db.init();
  const fu = require('../services/build-followups');
  const r = fu.reconcile(fu.BUILD_23, { apply });
  for (const x of r.results) console.log(`${x.outcome.padEnd(13)} ${x.key.padEnd(28)} ${x.taskId ? `task #${x.taskId}` : ''} ${x.text || x.why || ''}`);
  const v = fu.verify(fu.BUILD_23);
  console.log(apply ? `\nAcceptance: ${v.ok ? 'every follow-up has a task' : `MISSING ${v.missing.join(', ')}`}` : '\nDry run — nothing written. Re-run with --apply.');
  process.exit(apply && !v.ok ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
