'use strict';

/**
 * The pull channel, over real HTTP.
 *
 * The service suite proves the queue's rules. This proves the thing that makes
 * the design safe: an intent reaches the laptop ONLY on the response to a POST
 * the laptop itself made, and what travels is an id and nothing else.
 *
 * A green service suite says nothing about routing — and this is the one route
 * in the system whose end result is a program starting on Nick's work machine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-dir-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const db = require('../db/database');
const di = require('../services/desk-intents');

let server;
let base;
const HOST = 'DESKTOP-8LGF9RR';

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/desktop', require('./desktop'));
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => new Promise(r => server.close(r)));

async function post(p, body) {
  const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json() };
}
async function get(p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
}
function sample(over = {}) {
  return { at: new Date().toISOString(), app: 'Code', idleSeconds: 2, locked: false, host: HOST, ...over };
}
function reset() { db.setState(di.STATE_KEY, ''); }

test('⚠ an intent reaches the laptop ONLY on the response to its own POST', () => {
  reset();
  return post('/api/desktop/intents', { app: 'music', host: HOST }).then(async (q) => {
    assert.equal(q.body.ok, true);
    // Nothing was pushed anywhere. The laptop has to come and ask.
    const poll = await post('/api/desktop/activity', sample());
    assert.equal(poll.status, 200);
    assert.equal(poll.body.intents.length, 1);
    assert.equal(poll.body.intents[0].app, 'music');
  });
});

test('⚠ ONLY an id travels — never a path, never an argument', async () => {
  reset();
  await post('/api/desktop/intents', { app: 'code', host: HOST });
  const poll = await post('/api/desktop/activity', sample());
  assert.deepEqual(Object.keys(poll.body.intents[0]).sort(), ['app', 'id']);
});

test('⚠ NEGATIVE: an app outside the vocabulary never reaches the wire', async () => {
  reset();
  const q = await post('/api/desktop/intents', { app: 'powershell -c whoami' });
  assert.equal(q.body.ok, false);
  const poll = await post('/api/desktop/activity', sample());
  assert.deepEqual(poll.body.intents, []);
});

test('⚠ a second poll gets nothing — one claim, one launch', async () => {
  reset();
  await post('/api/desktop/intents', { app: 'music', host: HOST });
  await post('/api/desktop/activity', sample());
  const again = await post('/api/desktop/activity', sample());
  assert.deepEqual(again.body.intents, []);
});

test('⚠ an intent for one machine is not handed to another', async () => {
  reset();
  await post('/api/desktop/intents', { app: 'code', host: HOST });
  const other = await post('/api/desktop/activity', sample({ host: 'SOME-OTHER-PC' }));
  assert.deepEqual(other.body.intents, []);
  const mine = await post('/api/desktop/activity', sample());
  assert.equal(mine.body.intents.length, 1);
});

test('the outcome comes back, so a surface says "opened" not "sent"', async () => {
  reset();
  const q = await post('/api/desktop/intents', { app: 'music', host: HOST });
  await post('/api/desktop/activity', sample());
  await post('/api/desktop/intents/' + q.body.intent.id + '/done', { ok: true, detail: 'iTunes' });
  const s = await get('/api/desktop/intents/' + q.body.intent.id);
  assert.equal(s.body.state, 'opened');
  assert.equal(s.body.detail, 'iTunes');
});

test('⚠ a claimed-but-unreported intent reads as claimed, never as opened', async () => {
  reset();
  const q = await post('/api/desktop/intents', { app: 'music', host: HOST });
  await post('/api/desktop/activity', sample());
  const s = await get('/api/desktop/intents/' + q.body.intent.id);
  assert.equal(s.body.state, 'claimed');
});

test('⚠ posting a sample still works when the intent queue is unreadable', async () => {
  // The sample is the agent's actual job. A bookkeeping failure must not cost it.
  db.setState(di.STATE_KEY, '{{{ not json');
  const poll = await post('/api/desktop/activity', sample());
  assert.equal(poll.status, 200);
  assert.equal(poll.body.ok, true);
  assert.deepEqual(poll.body.intents, [], 'and no intent is invented out of a broken read');
});
