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
