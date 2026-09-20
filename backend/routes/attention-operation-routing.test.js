'use strict';

/**
 * Does `operation` actually reach a real `/api/attention` response?
 *
 * ⚠⚠ A GREEN SERVICE SUITE SAYS NOTHING ABOUT THE WIRING. `attention.build()`
 * composes the block behind a `try` that is deliberately never allowed to fail
 * the feed — so a missing require, a scope error or a renamed field would be
 * swallowed into a `console.warn` and `operation: null`, which every client
 * correctly reads as "render it the way you did before this existed". The
 * feature would be silently absent, everywhere, with 4,000 tests green.
 *
 * That is this repo's own lesson, twice over: the `readVantage` shape renamed
 * under its stubs, and the interaction 500 that shipped behind a full suite.
 * A STUB CANNOT TEST THE THING IT REPLACES — so this drives the real route,
 * through the real build, against a real (scratch) database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-attop-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const db = require('../db/database');
const intents = require('../services/desk-intents');
const { PHASES } = require('../../shared/operation-phase.cjs');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/attention', require('./attention'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

async function feed(query = '') {
  const res = await fetch(`${base}/api/attention${query}`);
  assert.equal(res.status, 200, 'the feed answers');
  return res.json();
}

test('the feed carries an operation block, composed and labelled', async () => {
  const body = await feed();
  const op = body.operation;
  assert.ok(op, 'operation is on the payload — not swallowed by the never-fail guard');
  assert.ok(PHASES.includes(op.phase), `${op.phase} is in the vocabulary`);
  assert.equal(typeof op.label, 'string');
  assert.ok(op.label.length > 0);
  assert.equal(typeof op.active, 'boolean');
  // Every field the contract promises is PRESENT, even when null — a consumer
  // must be able to tell "no subject" from "this build does not send subjects".
  for (const key of ['detail', 'subject', 'changedAt', 'confidence']) {
    assert.ok(Object.prototype.hasOwnProperty.call(op, key), `carries ${key}`);
  }
});

test('⚠ a request in flight reaches the phase THROUGH the real read', async () => {
  // This is the join the pure suite cannot see: `desk-intents` stores the
  // intent, `inFlight()` reads it back out of `agent_state`, and `build()`
  // hands it to the composer. Three modules, one fact.
  db.setState(intents.STATE_KEY, '');
  const queued = intents.queue('code');
  assert.equal(queued.ok, true);

  let body = await feed();
  assert.equal(body.operation.phase, 'executing');
  assert.match(body.operation.detail, /VS Code/);
  assert.equal(body.operation.subject.id, queued.intent.id);

  // Taken by the laptop, outcome unknown. ⚠ Claiming REMOVES it from `pending`,
  // so before claims were recorded this read straight back to STANDING BY while
  // the card beside it said "the laptop has taken it".
  intents.claim({ canOpen: ['code'] });
  body = await feed();
  assert.equal(body.operation.phase, 'verifying');

  // And an answer takes it out of flight entirely.
  intents.record(queued.intent.id, true, 'opened');
  body = await feed();
  assert.notEqual(body.operation.phase, 'verifying');
  assert.notEqual(body.operation.phase, 'executing');

  db.setState(intents.STATE_KEY, '');
});

test('⚠ an unreadable intent queue is a NAMED GAP, not a quiet one', async () => {
  // The composer correctly refuses to claim anything is in flight, and then
  // falls through — but "nothing is happening" is exactly what an unreadable
  // queue cannot support. The uncertainty goes where every other one goes.
  db.setState(intents.STATE_KEY, '{not json');
  const body = await feed();
  assert.ok(Array.isArray(body.gaps));
  assert.ok(body.gaps.some((g) => g && g.input === 'desk-intents'), JSON.stringify(body.gaps));
  // ⚠ And it did NOT invent a phase for it.
  assert.ok(!['executing', 'verifying'].includes(body.operation.phase));
  db.setState(intents.STATE_KEY, '');
});

test('⚠ every offered sentence carries its spoken phrases, over real HTTP', async () => {
  // `phrases` is what makes a sentence sayable as well as tappable. A field
  // composed and never sent is this codebase's most common failure.
  const body = await feed();
  assert.ok(Array.isArray(body.utterances) && body.utterances.length, 'she always offers something');
  for (const u of body.utterances) {
    assert.ok(Array.isArray(u.phrases) && u.phrases.length, `${u.say} has phrases`);
    assert.ok(u.phrases.includes(u.say), `${u.say} is sayable as written`);
  }
  // The escape hatch is sayable too — non-negotiable, out loud as well as
  // under a thumb.
  const { matchSaid } = require('../../shared/heard.cjs');
  const m = matchSaid('show me everything', body.utterances);
  assert.equal(m && m.utterance.intent.kind, 'reveal');
});

test('⚠ the payload is ADDITIVE — nothing a client read before has moved', async () => {
  // The Scriptable widget reads `say`/`speech`/`tab` and nothing else, and an
  // iOS build in Nick's pocket predates all of this.
  const body = await feed();
  for (const key of ['generatedAt', 'context', 'primary', 'secondary', 'dropped',
    'quiet', 'poolAvailable', 'gaps', 'utterances', 'surface', 'dashboard', 'field']) {
    assert.ok(Object.prototype.hasOwnProperty.call(body, key), `still carries ${key}`);
  }
});
