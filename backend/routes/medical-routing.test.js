'use strict';

/**
 * Real HTTP through real SQLite: records land once however many times they are
 * sent, a changed resend keeps what it replaced, one bad row does not sink the
 * batch, who entered a row is recorded from the caller (not the body), and a
 * scan with no vision model refuses honestly through the REAL defaults.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-medical-')), 'a.db');
// The scan test must never reach a paid API, whatever the host's environment.
delete process.env.ANTHROPIC_API_KEY;

const db = require('../db/database');
const router = require('./medical');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  // Stand-in for authority-guard: a request carrying this header is a machine.
  app.use((req, _res, next) => { if (req.headers['x-test-machine']) req.apiClient = req.headers['x-test-machine']; next(); });
  app.use('/api/medical', router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const post = (p, body, headers = {}) => fetch(`${base}/api/medical${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const get = async (p) => (await fetch(`${base}/api/medical${p}`)).json();

const FBC = [
  { kind: 'test_result', name: 'Haemoglobin', date: '2026-03-12', value: '145', unit: 'g/L', referenceRange: '130 - 180', panel: 'Full blood count' },
  { kind: 'test_result', name: 'Ferritin', date: '2026-03-12', value: '<10', unit: 'ug/L', flag: 'Low' },
  { kind: 'diagnosis', name: 'Asthma', date: '2014', status: 'active' },
  { kind: 'prescription', name: 'Sertraline 50mg tablets', date: '2026-09-01', dose: '50mg', directions: 'One each day', status: 'repeat' },
];

test('a batch lands, and the identical resend folds', async () => {
  const first = await (await post('/records', { records: FBC, client: 'chatgpt' }, { 'x-test-machine': 'gateway' })).json();
  assert.equal(first.ok, true);
  assert.equal(first.created, 4);
  const again = await (await post('/records', { records: FBC })).json();
  assert.equal(again.created, 0);
  assert.equal(again.unchanged, 4);
  const all = await get('/records');
  assert.equal(all.total, 4, 'four records, not eight');
  assert.equal(all.summary.test_result.count, 2);
});

test('provenance comes from the CALLER; the body only labels it', async () => {
  const { records } = await get('/records?kind=diagnosis');
  assert.equal(records[0].enteredBy, 'machine:gateway (chatgpt)');
  assert.equal(records[0].enteredVia, 'structured');
  // A body that claims to be Nick is still the machine that sent it.
  await post('/records', { records: [{ kind: 'diagnosis', name: 'Hay fever', client: 'nick' }], client: 'nick' }, { 'x-test-machine': 'gateway' });
  const hay = (await get('/records?name=Hay%20fever')).records[0];
  assert.match(hay.enteredBy, /^machine:gateway/);
});

test('values are transcribed: "<10" keeps its text and gets no number; the stated flag stays', async () => {
  const f = (await get('/records?name=Ferritin')).records[0];
  assert.equal(f.value, '<10');
  assert.equal(f.valueNum, null);
  assert.equal(f.flag, 'low');
  const h = (await get('/records?name=haemoglobin')).records[0];
  assert.equal(h.valueNum, 145);
  assert.equal(h.flag, null, 'nobody said high or low, so nothing does');
});

test('a changed resend is a REVISION that keeps what it replaced', async () => {
  const r = await (await post('/records', { records: [{ ...FBC[0], value: '146' }], via: 'screenshot' })).json();
  assert.equal(r.revised, 1);
  const h = (await get('/records?name=Haemoglobin')).records[0];
  assert.equal(h.value, '146');
  assert.equal(h.revisions, 1);
  assert.equal(h.enteredBy, 'nick');
  assert.equal(h.enteredVia, 'screenshot');
  const row = db.get('SELECT previous_json FROM medical_records WHERE id = ?', [h.id]);
  const prev = JSON.parse(row.previous_json);
  assert.equal(prev[0].content.value, '145', 'the earlier reading survives');
  assert.match(prev[0].enteredBy, /^machine:gateway/);
});

test('one bad row is refused by index; the rest still land', async () => {
  const r = await (await post('/records', { records: [
    { kind: 'test_result', name: 'eGFR', date: '2026-03-12', value: '>90', unit: 'mL/min/1.73m2' },
    { kind: 'test_result', name: 'ALT', date: '2026-02-31', value: '30' },
    { kind: 'test_result', name: 'ALT', date: '2026-03-12', value: '30', flag: 'Hihg' },
  ] })).json();
  assert.equal(r.created, 1);
  assert.equal(r.refused, 2);
  assert.deepEqual(r.results.filter(x => x.outcome === 'refused').map(x => x.index), [1, 2]);
  assert.match(r.results[1].why, /real date/);
});

test('a malformed body is a 400 that names the problem', async () => {
  assert.equal((await post('/records', { records: 'Haemoglobin 145' })).status, 400);
  assert.equal((await post('/records', { records: [] })).status, 400);
  assert.equal((await fetch(`${base}/api/medical/records?kind=xray`)).status, 400);
});

test('test history is every reading of one test, oldest first', async () => {
  await post('/records', { records: [
    { kind: 'test_result', name: 'HbA1c', date: '2026-06-01', value: '40' },
    { kind: 'test_result', name: 'HbA1c', date: '2025-06-01', value: '44' },
    { kind: 'test_result', name: 'HbA1c (IFCC)', date: '2026-01-01', value: '42' },
  ] });
  const h = await get('/tests/HbA1c');
  assert.deepEqual(h.readings.map(r => r.date), ['2025-06-01', '2026-06-01'], 'a different test name is not mixed in');
});

test('delete removes one record, and a missing one is a 404', async () => {
  const hay = (await get('/records?name=Hay%20fever')).records[0];
  const del = await fetch(`${base}/api/medical/records/${hay.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await get('/records?name=Hay%20fever')).total, 0);
  assert.equal((await fetch(`${base}/api/medical/records/${hay.id}`, { method: 'DELETE' })).status, 404);
});

test('scan through the REAL routing + provider defaults refuses honestly with no model, and echoes no image', async () => {
  const png = Buffer.from('not-really-a-png').toString('base64');
  const res = await post('/scan', { images: [{ imageBase64: png, mediaType: 'image/png' }] });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /can’t read screenshots/);
  assert.ok(!JSON.stringify(body).includes(png));
  assert.equal((await post('/scan', { images: [] })).status, 422);
});
