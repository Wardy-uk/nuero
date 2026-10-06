#!/usr/bin/env node
'use strict';

/**
 * Stage a CONTROLLED outage of the canary source `neuro.selftest` (Build 15L),
 * so self-healing can be proven in production without breaking a real sense.
 *
 *   node backend/scripts/selftest-outage.js            # 3 failures now, then it is healthy again
 *   node backend/scripts/selftest-outage.js --failures 4
 *   node backend/scripts/selftest-outage.js --clear    # disarm anything left armed
 *
 * It arms the fault and runs the canary's sync N times straight away, so the
 * N failures land now rather than on the hourly schedule. The fault is then
 * spent: the next run — the self-heal retry, or the hourly job — succeeds.
 * That is the "transient upstream outage that has since cleared" a single
 * retry exists for. Nothing outside the event spine is touched.
 *
 * ⚠ Deliberately a SCRIPT, not a route: a route that fakes an outage would be
 * a way for a machine client to make NEURO act.
 */

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const val = (name, d) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

(async () => {
  const db = require('../db/database');
  await db.init();
  const canary = require('../services/selftest-source');
  if (flag('--clear')) { canary.clearFault(); console.log('fault cleared'); return; }
  const failures = Math.max(1, Math.min(10, Number(val('--failures', 3)) || 3));
  canary.armFault({ failures });
  for (let i = 0; i < failures; i += 1) {
    const r = await canary.sync();
    console.log(`run ${i + 1}: ${r.ok ? 'ok' : `failed — ${r.error}`}`);
    await new Promise((res) => setTimeout(res, 1500));
  }
  console.log(`armed and spent: ${failures} failure(s) published for ${canary.SOURCE_ID}. The next run will succeed.`);
  console.log('Watch: GET /api/events/investigations and GET /api/activity/timeline (the investigation job runs every 5 min).');
})().catch((e) => { console.error(e.message); process.exit(1); });
