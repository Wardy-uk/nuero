'use strict';

/**
 * /api/health/hume over real HTTP + real SQLite: an upload lands once however
 * often it is sent, a bad bundle is a 400 naming every problem (so the phone
 * stops retrying it), and the reads carry the experimental label. Also pins the
 * mount: server.js must route /api/health/hume to this router.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-hume-route-')), 'a.db');

const db = require('../db/database');
const router = require('./hume');

let server;
let base;
test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/health/hume', router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api/health/hume`;
});
test.after(() => server && server.close());

const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Neuro-Client': 'neuro-ios' }, body: JSON.stringify(body) });

// SYNTHETIC: one history record (documented layout) + end marker.
const bundle = {
  bundleId: 'route-sync-0001', kind: 'sync', status: 'end-marker',
  device: { peripheralId: '6F1C2D3E-4A5B-4C6D-8E9F-0123456789AB', name: 'Hume Band BFCB' },
  phone: { timeZone: 'Europe/London' },
  packets: [
    { seq: 0, dir: 'tx', hex: '56000000000000000000000000000056', context: 'history' },
    { seq: 1, dir: 'rx', hex: '5600002610220917133a0a500a744256ff', context: 'history', at: '2026-10-22T08:29:26Z' },
  ],
};

test('POST /captures stores once; the second delivery is a duplicate', async () => {
  const r1 = await (await post('/captures', bundle)).json();
  assert.equal(r1.ok, true);
  assert.equal(r1.duplicate, false);
  assert.equal(r1.summary.new, 1);
  const r2 = await (await post('/captures', bundle)).json();
  assert.equal(r2.duplicate, true);
  assert.equal(db.get('SELECT client FROM hume_capture_bundles').client, 'neuro-ios');
});

test('a malformed bundle is a 400 with every problem named', async () => {
  const res = await post('/captures', { bundleId: 'no', kind: 'sync', packets: [{ seq: 'a' }] });
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.equal(j.ok, false);
  assert.ok(j.problems.length >= 3);
});

test('reads carry the experimental label; junk query is a 400', async () => {
  const s = await (await fetch(`${base}/status`)).json();
  assert.equal(s.label, 'Experimental Hume estimate');
  assert.equal(s.latestBp.systolic, 116);
  assert.equal(s.lastSync.transfer_status, 'end-marker');
  const recs = await (await fetch(`${base}/records?limit=5`)).json();
  assert.equal(recs.records[0].bp.systolic, 116);
  assert.equal((await fetch(`${base}/records?limit=0`)).status, 400);
  const pk = await (await fetch(`${base}/captures/route-sync-0001/packets`)).json();
  assert.equal(pk.packets.length, 2);
});

test('server.js mounts the Hume router at /api/health/hume, ahead of /api/health', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const hume = src.indexOf("app.use('/api/health/hume', require('./routes/hume'))");
  const health = src.indexOf("app.use('/api/health', healthRoutes)");
  assert.ok(hume > 0 && health > hume);
});
