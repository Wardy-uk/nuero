// `record()` against a REAL scratch DB.
//
// ⚠ WHY THIS IS A SEPARATE FILE FROM THE PURE SUITE. The first version of this
// test lived beside the `assess()` tests and handed `assess` a fixture carrying
// `tempC` directly — so it passed happily with `tempC` REMOVED from record()'s
// whitelist, which is the exact bug it was written to catch. Mutation-checking
// is what found that. A whitelist can only be pinned by going through the
// writer, and the writer needs a database.
//
// ⚠ NEVER point this at the live agent.db.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NEURO_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-routerhealth-')), 'scratch.db',
);

const db = require('../db/database');
const rh = require('./router-health');

// ⚠ init() is async and the schema must exist before the first setState.
test.before(async () => { await db.init(); });

const sample = (over = {}) => ({
  at: new Date().toISOString(),
  reachable: true, shellOk: true, dstateReadable: true,
  uptimeSec: 45437, load1: 0.15, load5: 0.22, load15: 0.24, tasks: 140,
  dcount: 0, dprocs: [], memFreeKb: 109124, nvramFree: 5654, tempC: 68, ...over,
});

test('a posted temperature survives the whitelist and reaches the record', () => {
  // The live reading taken off the box on 18 Sep 2026.
  const row = rh.record(sample());
  assert.equal(row.tempC, 68, 'record() must keep tempC');
  assert.equal(rh.samples()[0].tempC, 68, 'and it must be what was stored');
});

test('assess reads the stored temperature, not one handed to it', () => {
  // ⚠ The round trip is the point: POST -> record -> store -> assess.
  rh.record(sample({ tempC: 90 }));
  const a = rh.current();
  assert.equal(a.latest.tempC, 90);
  assert.ok(a.issues.some((i) => i.level === 'critical' && /90/.test(i.title)));
});

test('a sample with no temperature stores null, never a number', () => {
  // "I did not read it" and "it is cool" are different facts.
  const row = rh.record(sample({ tempC: undefined }));
  assert.equal(row.tempC, null);
});
