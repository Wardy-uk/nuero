#!/usr/bin/env node
'use strict';

/**
 * Reconcile a build's Nick-owned follow-ups into real NEURO tasks (Build 23AH).
 *
 *   node backend/scripts/build-followups.js            # dry run: what would happen
 *   node backend/scripts/build-followups.js --apply    # create / link the tasks
 *   node backend/scripts/build-followups.js --build=24 --apply   # another build's list
 *
 * An open task that already says the same thing is reused; one Nick already
 * finished is recorded as resolved and never recreated. Run from backend/ on
 * the Pi (it opens the live DB).
 */

const apply = process.argv.includes('--apply');
const which = (process.argv.find((a) => /^--build=\d+$/.test(a)) || '--build=23').split('=')[1];

(async () => {
  const db = require('../db/database');
  await db.init();
  const fu = require('../services/build-followups');
  const list = fu[`BUILD_${which}`];
  if (!list) throw new Error(`no follow-up list for Build ${which}`);
  const r = fu.reconcile(list, { apply });
  for (const x of r.results) console.log(`${x.outcome.padEnd(13)} ${x.key.padEnd(28)} ${x.taskId ? `task #${x.taskId}` : ''} ${x.text || x.why || ''}`);
  const v = fu.verify(list);
  console.log(apply ? `\nAcceptance: ${v.ok ? 'every follow-up has a task' : `MISSING ${v.missing.join(', ')}`}` : '\nDry run — nothing written. Re-run with --apply.');
  process.exit(apply && !v.ok ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
