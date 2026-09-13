'use strict';

/**
 * The agent asks whether a button has been pressed.
 *
 * ⚠⚠ WHY THIS ROUTE EXISTS, measured on the live laptop 13 Sep 2026: claiming
 * used to happen ONLY on the back of a full activity sample, which is posted
 * every 120s because it answers "what is he doing" — a question that does not
 * need asking often. A launch button answers "do this NOW". Tied together, a
 * press took **111 seconds** to open Chrome and the next one **expired
 * unfired**. That is what "I tested the launch buttons, they all failed" was.
 *
 * ⚠ Real HTTP, because a green service suite says nothing about routing — and
 * a literal path beside a parameterised sibling is a shape this repo has
 * shipped broken before.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-deskclaim-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const db = require('../db/database');
const intents = require('../services/desk-intents');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/desktop', require('./desktop'));
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise(r => server.close(r)));

const post = async (p, body) => {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

test('a queued intent is handed over on a CLAIM, with no sample posted', async () => {
  const queued = await post('/api/desktop/intents', { app: 'music' });
  assert.equal(queued.json.ok, true);

  const before = db.getState('desktop_activity');
  const claim = await post('/api/desktop/intents/claim', {
    host: 'TESTBOX',
    canOpen: ['music', 'browser'],
  });
  assert.equal(claim.status, 200);
  assert.equal(claim.json.ok, true);
  assert.equal(claim.json.intents.length, 1, 'the press is handed over');
  assert.equal(claim.json.intents[0].app, 'music');

  // ⚠ THE ROUTE RECORDS NOTHING. That is what makes it safe to call every few
  // seconds, and it is the reason this narrow path can be opened to the kiosk
  // while the whole `desktop` segment stays closed — a claim cannot inject
  // desk activity.
  assert.equal(db.getState('desktop_activity'), before, 'no sample was stored');
});

test('⚠ it is SINGLE USE — a repeated poll cannot launch twice', async () => {
  await post('/api/desktop/intents', { app: 'browser' });
  const first = await post('/api/desktop/intents/claim', { host: 'T', canOpen: ['browser'] });
  assert.equal(first.json.intents.length, 1);
  const second = await post('/api/desktop/intents/claim', { host: 'T', canOpen: ['browser'] });
  assert.equal(second.json.intents.length, 0, 'already taken');
});

test('⚠ an agent that does not say what it understands is handed NOTHING', async () => {
  const queued = await post('/api/desktop/intents', { app: 'code' });
  const id = queued.json.intent.id;

  for (const body of [{ host: 'T' }, { host: 'T', canOpen: null }, { host: 'T', canOpen: 'code' }]) {
    const claim = await post('/api/desktop/intents/claim', body);
    assert.equal(claim.json.intents.length, 0, JSON.stringify(body));
  }

  // ⚠ AND THE PRESS IS STILL WAITING, not eaten. An older agent must not be
  // able to consume a request it cannot act on.
  const res = await fetch(`${base}/api/desktop/intents/${id}`);
  const status = await res.json();
  assert.equal(status.state, 'waiting');

  const claim = await post('/api/desktop/intents/claim', { host: 'T', canOpen: ['code'] });
  assert.equal(claim.json.intents.length, 1, 'and an agent that CAN act still gets it');
});

test('⚠ an agent is handed only what it can actually open', async () => {
  await post('/api/desktop/intents', { app: 'terminal' });
  const claim = await post('/api/desktop/intents/claim', { host: 'T', canOpen: ['music'] });
  assert.equal(claim.json.intents.length, 0, 'it cannot open a terminal, so it is not given one');
});

test('the literal path is not swallowed by a parameterised sibling', async () => {
  // If `/intents/claim` were ever read as `/intents/:id`, this would answer a
  // status for an intent called "claim" rather than claiming anything.
  const claim = await post('/api/desktop/intents/claim', { host: 'T', canOpen: ['music'] });
  assert.equal(claim.status, 200);
  assert.ok('intents' in claim.json, 'it claimed rather than reporting a status');
  assert.equal(claim.json.state, undefined);
});

test('⚠ the deadline is wider than the claim cadence', () => {
  // The bug this whole route exists for was a TTL sized to exactly one poll,
  // so a single missed poll killed the press. The agent claims every few
  // seconds; the deadline must survive an outage of many of them.
  assert.ok(intents.TTL_MS >= 5 * 60 * 1000, 'TTL must not shrink back to one poll');
});
