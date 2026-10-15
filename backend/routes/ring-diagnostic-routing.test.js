'use strict';

// The capture needs a real mounted route: a unit test of ringDiagnostic alone
// would not prove that Nick's iPhone can send it to the health namespace.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-ring-diagnostic-')), 'a.db');

const db = require('../db/database');
const router = require('./health');

let server;
let base;

const capture = {
  pairedName: 'JC Ring',
  capturedAt: '2026-10-09T11:00:00Z',
  characteristics: [{ service: '56FF', uuid: '56FF01', properties: ['read', 'notify'] }],
  packets: [{
    receivedAt: '2026-10-09T11:00:00Z', service: '56FF', characteristic: '56FF01',
    hex: 'AA 01 02', kind: 'notification',
  }],
  probes: [{
    occurredAt: '2026-10-09T11:01:00Z', kind: 'read-request', label: 'Manual read',
    service: '56FF', characteristic: '56FF01',
  }, {
    occurredAt: '2026-10-09T11:02:00Z', kind: 'observation', label: 'movement started',
  }],
};

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/health', router);
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

function post(body) {
  return fetch(`${base}/api/health/ring-diagnostic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Neuro-Client': 'Neuro iOS' },
    body: JSON.stringify(body),
  });
}

test('manual diagnostic capture is stored and can be retrieved for decoding', async () => {
  const receipt = await post(capture);
  assert.equal(receipt.status, 200);
  const receiptBody = await receipt.json();
  assert.equal(receiptBody.ok, true);
  assert.equal(receiptBody.packetsStored, 1);
  assert.equal(receiptBody.characteristicsStored, 1);
  assert.equal(receiptBody.probesStored, 2);
  assert.ok(Date.parse(receiptBody.receivedAt));

  const read = await fetch(`${base}/api/health/ring-diagnostic`);
  assert.equal(read.status, 200);
  const result = await read.json();
  assert.equal(result.available, true);
  assert.equal(result.capture.client, 'Neuro iOS');
  assert.deepEqual(result.capture.packets, capture.packets);
  assert.deepEqual(result.capture.characteristics, capture.characteristics);
  assert.deepEqual(result.capture.probes, capture.probes);

  const decoded = await (await fetch(`${base}/api/health/ring-diagnostic/decoded`)).json();
  assert.equal(decoded.available, true);
  assert.equal(decoded.decoded.notifications, 1);
  assert.equal(decoded.decoded.headers.AA, 1);
});

test('invalid data is refused and cannot overwrite the last usable capture', async () => {
  const refused = await post({ characteristics: capture.characteristics, packets: [{ ...capture.packets[0], hex: '' }] });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).ok, false);

  const result = await (await fetch(`${base}/api/health/ring-diagnostic`)).json();
  assert.equal(result.capture.packets[0].hex, 'AA 01 02');
});

test('an oversized or malformed protocol probe is refused', async () => {
  const refused = await post({
    ...capture,
    probes: [{ ...capture.probes[0], label: 'x'.repeat(161) }],
  });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).ok, false);

  const result = await (await fetch(`${base}/api/health/ring-diagnostic`)).json();
  assert.equal(result.capture.probes.length, 2, 'the useful capture remains intact');
});

// The upload itself decodes and stores the readings (persistJCRingReadings runs
// on POST). The backfill re-reads the same saved capture, so against the
// UNIQUE(metric, recorded_at_local, sample_index) key it must store NOTHING new:
// a backfill that double-counted would inflate every ring history it touched.
test('an upload stores its readings, and an explicit backfill of the same capture adds no duplicates', async () => {
  const receipt = await post({
    ...capture,
    packets: [{
      ...capture.packets[0],
      hex: '56 00 00 26 10 09 17 14 30 31 00 5C 39 70 3E',
    }],
  });
  assert.equal(receipt.status, 200);
  // One 0x56 HRV frame carries five readings: HRV, both vendor BP estimates,
  // the vendor stress score and the heart rate during the capture.
  assert.equal((await receipt.json()).readingsStored, 5, 'the upload decodes and stores all five readings in the frame');

  const backfill = await fetch(`${base}/api/health/ring-readings/backfill`, { method: 'POST' });
  assert.equal(backfill.status, 200);
  assert.deepEqual(await backfill.json(), {
    ok: true,
    packetsRead: 1,
    readingsStored: 0,
    receivedAt: (await (await fetch(`${base}/api/health/ring-diagnostic`)).json()).capture.receivedAt,
  });

  const readings = await (await fetch(`${base}/api/health/ring-readings`)).json();
  assert.equal(readings.available, true);
  assert.equal(readings.latest.hrv.value, 49);
  assert.equal(readings.latest.vendor_bp_systolic_estimate.value, 112);
  assert.equal(readings.latest.vendor_bp_diastolic_estimate.value, 62);
  assert.ok(readings.latest.vendor_stress_score, 'stress score stored');
  assert.ok(readings.latest.vendor_heart_rate_during_hrv, 'heart rate during HRV stored');

  // Positive control: the case backfill exists for (readings absent after an
  // upgrade) still converts — so the 0 above is idempotency, not a dead route.
  db.run('DELETE FROM jc_ring_samples', []);
  const again = await (await fetch(`${base}/api/health/ring-readings/backfill`, { method: 'POST' })).json();
  assert.equal(again.readingsStored, 5);
});

test('every raw 90-second PPG run is kept, and a run re-sent by a later sync is stored once', async () => {
  // Twelve full frames (50 samples each) = 600 samples, a sine-ish waveform.
  const frame = (seq) => {
    const bytes = [0x3A, (seq >> 8) & 0xff, seq & 0xff];
    for (let i = 0; i < 50; i++) {
      const v = 4000000 + Math.round(100000 * Math.sin(((seq * 50 + i) / 50) * 2 * Math.PI * 1.2));
      bytes.push((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
    }
    return { receivedAt: '2026-10-15T19:00:34Z', kind: 'notification', service: 'FFF0', characteristic: 'FFF7',
      hex: bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ') };
  };
  const packets = Array.from({ length: 12 }, (_, i) => frame(i));
  const first = await (await post({ ...capture, packets })).json();
  assert.equal(first.ppgRunsStored, 1);
  const again = await (await post({ ...capture, packets })).json();
  assert.equal(again.ppgRunsStored, 0, 'the same run from a later sync folds');
  const row = db.get('SELECT sample_count, samples_json, captured_at FROM jc_ring_ppg_runs');
  assert.equal(row.sample_count, 600);
  assert.equal(JSON.parse(row.samples_json).length, 600, 'every sample kept, not the 300-point preview');
  assert.equal(row.captured_at, '2026-10-15T19:00:34Z');
});
