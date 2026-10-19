#!/usr/bin/env node
'use strict';

// Review the meeting-promises shadow. Writes ONLY promise_shadow_log (a label,
// or a missed promise) and never creates the table.
//   node backend/scripts/promise-shadow-review.js status
//   node backend/scripts/promise-shadow-review.js label <id> tp|fp|unsure [note…]
//   node backend/scripts/promise-shadow-review.js missed --task <id> [note…]
//   node backend/scripts/promise-shadow-review.js missed --text "<the promise>" [note…]

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const db = require('../db/database');
  await db.init();
  const shadow = require('../services/promise-shadow');
  if (!shadow.logExists()) { console.log('the shadow has never been enabled on this database'); return; }
  if (cmd === 'status') {
    const r = shadow.report({ days: 14 });
    console.log(JSON.stringify({ heartbeats: r.heartbeats, builds: r.builds, prompts: r.prompts, proposals: r.proposals.total,
      routingOnly: r.routingOnly.promises.length, suppressions: r.suppressions.total, missed: r.missed.length }, null, 2));
    return;
  }
  if (cmd === 'label') {
    const [id, value, ...note] = rest;
    console.log(JSON.stringify(shadow.label(id, { label: value, note: note.join(' ') || null })));
    return;
  }
  if (cmd === 'missed') {
    const i = rest.indexOf('--task'); const j = rest.indexOf('--text');
    const taskId = i >= 0 ? Number(rest[i + 1]) : null;
    const text = j >= 0 ? rest[j + 1] : null;
    const note = rest.filter((_, k) => k !== i && k !== i + 1 && k !== j && k !== j + 1).join(' ') || null;
    console.log(JSON.stringify(shadow.missed({ taskId, text, note })));
    return;
  }
  console.log('usage: status | label <id> tp|fp|unsure [note] | missed --task <id>|--text "<promise>" [note]');
  process.exitCode = 2;
})().catch((e) => { console.error(e); process.exit(1); });
