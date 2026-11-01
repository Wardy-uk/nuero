'use strict';

// Muted senders archived in Outlook (1 Nov 2026): the route half.
// A machine client cannot mute a whole sender (that now moves mail in Outlook),
// a person can; the muted list carries the archive status and per-sender count.
// Real HTTP over the real router and a real DB; no Graph is reached (kick() is a
// no-op inside a test process, pinned in the service test).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mutearch-route-')), 'a.db');

const db = require('../db/database');
const router = require('./email-triage');

let server; let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  // Stands in for api-auth / authority-guard, which set req.apiClient for a machine.
  app.use((req, _res, next) => { if (req.headers['x-test-machine']) req.apiClient = 'test-machine'; next(); });
  app.use('/api/email', router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

function seed() {
  db.setState('email_triage', JSON.stringify([
    { id: 'e1', from: 'Golf', fromEmail: 'news@golf.example', subject: 'Swing tips', category: 'FYI', lane: 'fyi', dismissed: false },
  ]));
  db.setState('email_triage_muted_senders', '{}');
  db.setState('email_muted_archive_counts', JSON.stringify({ 'news@golf.example': { archived: 4, lastAt: '2026-11-01T10:00:00Z' } }));
}

const dismiss = (headers) => fetch(`${base}/api/email/triage/dismiss/e1`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ reason: 'not-relevant', mute: 'sender' }),
});

test('a machine client cannot mute a whole sender; nothing is dismissed or muted', async () => {
  seed();
  const res = await dismiss({ 'x-test-machine': '1' });
  assert.equal(res.status, 403);
  assert.equal(db.getState('email_triage_muted_senders'), '{}');
  assert.equal(JSON.parse(db.getState('email_triage'))[0].dismissed, false);
});

test('a person can, and the muted list shows the archive status and count', async () => {
  seed();
  const res = await dismiss({});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.muted.ok, true);
  const list = await (await fetch(`${base}/api/email/triage/muted`)).json();
  assert.equal(list.ok, true);
  assert.equal(list.senders[0].address, 'news@golf.example');
  assert.equal(list.senders[0].archivedInOutlook, 4);
  assert.equal(list.archive.enabled, true, 'default ON');
});
