'use strict';

/**
 * Build 14S — replay every historical source-blind finding through the
 * investigation TRIGGER and report how many investigations would have started.
 *
 * READ-ONLY: opens the database `{ readonly: true }` and writes nothing. It
 * evaluates the real `sourceBlindness.liveEligible` (the only gate an
 * investigation has) every 30 minutes across each finding's life — from first
 * detection to resolution, or to now for one still open.
 *
 *   NEURO_DB_PATH=/mnt/data/nuero/backend/db/agent.db node backend/scripts/build14-investigation-replay.js
 */

const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.NEURO_DB_PATH || path.join(__dirname, '..', 'db', 'agent.db');
const ro = new Database(dbPath, { readonly: true, fileMustExist: true });
const sb = require('../services/source-blindness');
const native = require('../services/native-sources');

const STEP = 30 * 60 * 1000;
const now = Date.now();
const rows = ro.prepare('SELECT * FROM source_blind_findings ORDER BY first_detected_at').all();
const report = [];
let wouldStart = 0;
for (const r of rows) {
  const from = Date.parse(r.first_detected_at);
  const to = r.resolved_at ? Date.parse(r.resolved_at) : now;
  let firstLiveAt = null;
  for (let t = from; t <= to; t += STEP) {
    const shaped = { status: 'active', source: r.source_id, condition: r.condition, lastObservedOrSuccessAt: r.basis_at };
    if (sb.liveEligible(shaped, t).eligible) { firstLiveAt = new Date(t).toISOString(); break; }
  }
  if (firstLiveAt) wouldStart += 1;
  const basis = r.basis_at ? Date.parse(r.basis_at) : null;
  report.push({
    finding: r.finding_id, source: r.source_id, lifecycle: native.describe(r.source_id).lifecycle, condition: r.condition,
    status: r.status, resolution: r.resolution || null,
    silenceHoursAtEnd: basis ? Math.round(((to - basis) / 36e5) * 10) / 10 : null,
    wouldInvestigate: !!firstLiveAt, firstLiveAt,
  });
}
console.log(JSON.stringify({ db: dbPath, findings: rows.length, wouldStart, report }, null, 2));
ro.close();
