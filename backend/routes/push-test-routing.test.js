'use strict';

/**
 * The test notification reports what HAPPENED, not that the button was pressed.
 *
 * `POST /api/push/test` answered `{ok:true}` unconditionally: `sendToAll` returns
 * nothing, so VAPID unset, no subscriptions and a failed delivery all came back as
 * success. A test that passes while the thing it tests is off is worse than none.
 * Real HTTP against a scratch DB, reading back the push_log row the send wrote.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-pushtest-')), 'a.db');
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

const db = require('../db/database');
const webpush = require('../services/webpush');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/push', require('./push'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const post = (u) => fetch(base + u, { method: 'POST' }).then(async (r) => ({ status: r.status, json: await r.json() }));

test('⚠ a send that could not be delivered is NOT reported as working', async () => {
  const res = await post('/api/push/test');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.outcome, 'undeliverable');
  assert.ok(res.json.reason, 'the reason must travel with the refusal');
});

test('positive control — a recorded delivery IS reported as sent, with the counts', async () => {
  const real = webpush.sendToAll;
  webpush.sendToAll = async () => db.logPushOutcome({ type: 'test', title: 'SARA', outcome: 'sent', reason: null, sentCount: 2, failedCount: 1 });
  try {
    const res = await post('/api/push/test');
    assert.equal(res.json.ok, true);
    assert.equal(res.json.sentCount, 2);
    assert.equal(res.json.failedCount, 1);
  } finally {
    webpush.sendToAll = real;
  }
});
