'use strict';
// HiLo report import (15 Oct 2026). Pure parsing + time conversion, then the
// real store against a scratch DB, then the real PDF when it is on this machine.
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-'));
process.env.NEURO_DB_PATH = path.join(scratch, 'agent.db');

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db/database');
const hilo = require('./hilo-import');

test.before(async () => { await db.init(); });

const cell = (str, x, y) => ({ str, x, y });
// One printed line in each of the report's two columns, as page 2 lays them out,
// with the right-hand date emitted LAST (the stream order the real file has).
const PAGE = [
  cell('1 October, 26', 13, 395), cell('00:34', 67, 395), cell('128', 87, 395), cell('74', 101, 395), cell('76', 114, 395),
  cell('05:39', 193, 395), cell('131', 215, 395), cell('78', 231, 395), cell('85', 246, 395),
  cell('1 October, 26', 13, 385), cell('09:08', 67, 385), cell('151', 87, 385), cell('92', 101, 385), cell('80', 114, 385),
  cell('2 October, 26', 144, 395),
];

test('rows are rebuilt from cell positions, not stream order', () => {
  const { readings, rejected } = hilo.parseItems([PAGE]);
  assert.deepStrictEqual(rejected, []);
  const locals = readings.map((r) => r.local).sort();
  assert.deepStrictEqual(locals, ['2026-10-01T00:34', '2026-10-01T09:08', '2026-10-02T05:39']);
  const r = readings.find((x) => x.local === '2026-10-02T05:39');
  assert.deepStrictEqual([r.sys, r.dia, r.hr], [131, 78, 85]);
});

test('a time with no date on its line is not a reading; an implausible row is rejected and said', () => {
  const { readings, rejected } = hilo.parseItems([[
    cell('12:00', 67, 100), cell('140', 87, 100), cell('80', 101, 100), cell('70', 114, 100),
    cell('3 October, 26', 13, 90), cell('10:00', 67, 90), cell('80', 87, 90), cell('140', 101, 90), cell('70', 114, 90),
  ]]);
  assert.strictEqual(readings.length, 0);
  assert.strictEqual(rejected.length, 1);
  assert.match(rejected[0].reason, /implausible/);
});

test('Europe/London wall clock → UTC: BST, GMT, the repeated hour by order, the skipped hour refused', () => {
  const { readings, rejected } = hilo.toUtc([
    { local: '2026-10-01T09:08', sys: 151, dia: 92, hr: 80 },
    { local: '2026-12-01T09:08', sys: 140, dia: 85, hr: 70 },
    { local: '2026-10-25T01:20', sys: 130, dia: 80, hr: 70 },
    { local: '2027-03-28T01:30', sys: 130, dia: 80, hr: 70 },
  ]);
  const at = Object.fromEntries(readings.map((r) => [r.local, r.at]));
  assert.strictEqual(at['2026-10-01T09:08'], '2026-10-01 08:08:00'); // matches Health's copy of the real reading
  assert.strictEqual(at['2026-12-01T09:08'], '2026-12-01 09:08:00');
  assert.strictEqual(at['2026-10-25T01:20'], '2026-10-25 00:20:00'); // first 01:20 (BST)
  assert.deepStrictEqual(rejected.map((r) => r.local), ['2027-03-28T01:30']);
  assert.strictEqual(hilo.toUtcCandidates('2026-10-25T01:20').length, 2);
});

test('store: a reading Health already sent folds; a new one is queued for Health; a disagreement keeps the stored value', () => {
  db.insertHealthSampleWithUuid('blood_pressure_systolic', 151, '2026-10-01 08:08:00', 'apple-health', 'u1');
  db.insertHealthSampleWithUuid('blood_pressure_diastolic', 92, '2026-10-01 08:08:00', 'apple-health', 'u2');
  db.insertHealthSampleWithUuid('blood_pressure_systolic', 150, '2026-10-01 09:00:00', 'apple-health', 'u3');
  db.insertHealthSampleWithUuid('blood_pressure_diastolic', 90, '2026-10-01 09:00:00', 'apple-health', 'u4');

  const r = hilo.storeReadings([
    { at: '2026-10-01 08:08:00', sys: 151, dia: 92, hr: 80 },
    { at: '2026-10-01 09:00:00', sys: 155, dia: 90, hr: 80 },
    { at: '2026-10-02 04:39:00', sys: 131, dia: 78, hr: 85 },
  ], { now: new Date('2026-10-15T10:00:00Z') });
  assert.strictEqual(r.new, 1);
  assert.strictEqual(r.alreadyHad, 1);
  assert.strictEqual(r.conflicts.length, 1);

  const count = db.get("SELECT COUNT(*) AS n FROM health_samples WHERE metric = 'blood_pressure_systolic'").n;
  assert.strictEqual(count, 3); // never doubled
  assert.strictEqual(db.get("SELECT value FROM health_samples WHERE metric='blood_pressure_systolic' AND recorded_at='2026-10-01 09:00:00'").value, 150);

  const pending = hilo.pendingForHealth();
  assert.deepStrictEqual(pending.map((p) => p.at), ['2026-10-02T04:39:00Z']);
  assert.strictEqual(pending[0].syncId, 'hilo:2026-10-02T04:39:00Z');

  // Re-import is idempotent.
  const again = hilo.storeReadings([{ at: '2026-10-02 04:39:00', sys: 131, dia: 78, hr: 85 }]);
  assert.strictEqual(again.new, 0);
  assert.strictEqual(again.alreadyHad, 1);
});

test('ack moves pending readings out of the queue and ignores junk', () => {
  const res = hilo.ackHealth({ written: ['2026-10-02T04:39:00Z', 'nonsense'], present: [] });
  assert.strictEqual(res.changed, 1);
  assert.deepStrictEqual(hilo.pendingForHealth(), []);
  assert.strictEqual(hilo.status().health.written, 1);
});

const REAL = 'C:/Users/NickW/iCloudDrive/Documents/Hilo_Blood_Pressure_Report_NW_Oct2026.pdf';
test('the real October report parses completely', { skip: !fs.existsSync(REAL) && 'report not on this machine' }, async () => {
  const pages = await hilo.readPdf(fs.readFileSync(REAL));
  assert.ok(hilo._isHiloReport(pages));
  const parsed = hilo.parseItems(pages);
  assert.deepStrictEqual(parsed.rejected, []);
  // The report's own summary counts 438 readings for October, plus one
  // September calibration row printed at the top of the table.
  const oct = parsed.readings.filter((r) => r.local.startsWith('2026-10'));
  // The iCloud file is RE-EXPORTED as the month goes on (438 rows on 15 Oct,
  // 737 on 24 Oct): a floor, not a fixed count. Completeness is "nothing rejected".
  assert.ok(oct.length >= 438, `${oct.length} October readings`);
  assert.ok(parsed.readings.every((r) => r.sys > r.dia && r.hr > 0));
});

test('route: the real PDF posted as application/pdf imports over HTTP; junk is refused with a reason', { skip: !fs.existsSync(REAL) && 'report not on this machine' }, async () => {
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/health', require('../routes/health'));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/health`;
  try {
    const res = await fetch(`${base}/hilo/import`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: fs.readFileSync(REAL) });
    const body = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(body));
    const parsedAll = hilo.parseItems(await hilo.readPdf(fs.readFileSync(REAL))).readings.length;
    assert.strictEqual(body.read, parsedAll, 'the route reads every row the parser finds');
    assert.ok(body.new > 400);
    const st = await (await fetch(`${base}/hilo/status`)).json();
    assert.ok(st.health.pending > 400);

    const junk = await fetch(`${base}/hilo/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pdfBase64: Buffer.from('not a pdf').toString('base64') }) });
    assert.strictEqual(junk.status, 422);
    assert.strictEqual((await junk.json()).reason, 'not-a-pdf');
    const empty = await fetch(`${base}/hilo/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(empty.status, 400);
  } finally { server.close(); }
});
