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

// The real entry captured mid-wedge on 21 Sep 2026, before tonight's reboot
// destroyed it. 46 characters: at the old 40-char cap it stored as
// "245x cp /tmp/syslog.log /tmp/syslog.l" and the destination — the whole
// finding — was the part that got cut.
const REAL_STUCK = '245x cp /tmp/syslog.log /tmp/syslog.log-1 /jffs';

test('a folded D-state entry survives storage whole', () => {
  // The watcher used to store `$NF`, the last ARGUMENT, so 245 identical `cp`
  // processes arrived as unranked entries reading "/jffs" and the pile-up was
  // invisible in the one field that should have named it. It now folds by
  // command with a count, which is longer than a bare process name.
  const row = rh.record(sample({
    dcount: 251,
    dprocs: [REAL_STUCK, '1x nt_center', '1x [jffs2_gcd_mtd4]'],
  }));
  assert.equal(row.dprocs[0], REAL_STUCK, 'the dominant command must not be truncated');
  assert.ok(row.dprocs[0].endsWith('/jffs'), 'the destination is the finding — it must survive');
  assert.equal(rh.samples()[0].dprocs[0], REAL_STUCK, 'and it must be what was stored');
});

test('the dominant stuck command reaches the issue a human reads', () => {
  // ⚠ The round trip again: two sustained samples so `sustainedD` fires, then
  // the detail string must NAME the cause. Without this the alert says "251
  // processes stuck in D state" and nothing about what they are, which is the
  // state that cost a wrong root-cause theory for a week.
  rh.record(sample({ dcount: 250, dprocs: [REAL_STUCK] }));
  rh.record(sample({ dcount: 251, dprocs: [REAL_STUCK] }));
  const a = rh.current();
  const stuck = a.issues.find((i) => /stuck in D state/.test(i.title));
  assert.ok(stuck, 'expected the sustained-D issue');
  assert.ok(
    stuck.detail.includes('cp /tmp/syslog.log'),
    `the detail must name the dominant command, got: ${stuck.detail}`
  );
});

test('a dprocs entry is still bounded', () => {
  // Bounded, just not at a length that cuts a real one in half. A command line
  // is untrusted text arriving over HTTP.
  const row = rh.record(sample({ dcount: 9, dprocs: ['9x ' + 'a'.repeat(400)] }));
  assert.ok(row.dprocs[0].length <= 90, 'entries stay capped');
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
