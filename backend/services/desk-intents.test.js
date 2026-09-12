'use strict';

/**
 * Opening something on the laptop, without a door into it.
 *
 * This is the one path in the system that ends in a program starting on Nick's
 * WORK machine, so what is under test is mostly what it refuses. The design
 * property being defended: the agent is outbound-only, the Pi can name an id
 * and never a command, and only a human act queues anything.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-di-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const db = require('../db/database');
const di = require('./desk-intents');

test.before(async () => { await db.init(); });
function reset() { db.setState(di.STATE_KEY, ''); }

// ── The vocabulary is the safety model ───────────────────────────────────────

test('⚠ NEGATIVE: an app outside the vocabulary is REFUSED, not queued', () => {
  reset();
  for (const bad of ['powershell', 'cmd', 'rm -rf /', '', null, 'MUSIC', '../../evil']) {
    const r = di.queue(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.reason, /not something SARA can open/);
  }
  assert.deepEqual(di.claim().intents, [], 'and nothing reached the queue');
});

test('⚠ the queued intent carries an ID ONLY — never a path or an argument', () => {
  reset();
  di.queue('music');
  const { intents } = di.claim();
  assert.equal(intents.length, 1);
  assert.deepEqual(Object.keys(intents[0]).sort(), ['app', 'id'], 'nothing else travels to the laptop');
  assert.equal(intents[0].app, 'music');
});

test('the vocabulary is small and deliberate', () => {
  // Growing this is a decision, and it still does nothing until the agent's own
  // config on the laptop maps the key to a command.
  assert.deepEqual(Object.keys(di.APPS).sort(), ['browser', 'code', 'music', 'terminal']);
});

// ── Expiry ───────────────────────────────────────────────────────────────────

test('⚠ an intent EXPIRES rather than firing an hour later', () => {
  const old = { id: 'x', app: 'music', at: new Date(Date.now() - di.TTL_MS - 1000).toISOString() };
  assert.equal(di.isExpired(old), true);
  assert.deepEqual(di.claimable([old]), []);
});

test('⚠ an unreadable timestamp counts as EXPIRED, never as live', () => {
  assert.equal(di.isExpired({ id: 'x', app: 'music', at: 'not a date' }), true);
  assert.equal(di.isExpired({ id: 'x', app: 'music' }), true);
});

test('a fresh intent is claimable', () => {
  reset();
  di.queue('code');
  assert.equal(di.claim().intents.length, 1);
});

test('an expired intent is swept and reported as expired, not as waiting', () => {
  reset();
  const r = di.queue('music');
  // Age it by hand.
  const raw = JSON.parse(db.getState(di.STATE_KEY));
  raw.pending[0].at = new Date(Date.now() - di.TTL_MS - 5000).toISOString();
  db.setState(di.STATE_KEY, JSON.stringify(raw));
  assert.equal(di.status(r.intent.id).state, 'expired');
  assert.deepEqual(di.claim().intents, []);
});

// ── Single use ───────────────────────────────────────────────────────────────

test('⚠ claiming REMOVES it — a retried poll cannot launch twice', () => {
  reset();
  di.queue('music');
  assert.equal(di.claim().intents.length, 1);
  assert.deepEqual(di.claim().intents, [], 'the second poll gets nothing');
});

test('⚠ an intent named for one host does not fire on another', () => {
  reset();
  di.queue('code', { host: 'DESKTOP-8LGF9RR' });
  assert.deepEqual(di.claim({ host: 'SOME-OTHER-PC' }).intents, [], 'wrong machine, nothing handed over');
  assert.equal(di.claim({ host: 'DESKTOP-8LGF9RR' }).intents.length, 1);
});

test('an intent with no host named is claimable by whichever machine polls', () => {
  reset();
  di.queue('music');
  assert.equal(di.claim({ host: 'ANY-PC' }).intents.length, 1);
});

// ── Saying what happened ─────────────────────────────────────────────────────

test('the agent reports the outcome, so a surface can say "opened" not "sent"', () => {
  reset();
  const r = di.queue('music');
  di.claim();
  di.record(r.intent.id, true, 'iTunes');
  const s = di.status(r.intent.id);
  assert.equal(s.state, 'opened');
  assert.equal(s.detail, 'iTunes');
});

test('a failure on the laptop is reported as a failure', () => {
  reset();
  const r = di.queue('code');
  di.claim();
  di.record(r.intent.id, false, 'not installed');
  assert.equal(di.status(r.intent.id).state, 'failed');
});

test('an intent still queued reads as waiting', () => {
  reset();
  const r = di.queue('music');
  assert.equal(di.status(r.intent.id).state, 'waiting');
});

test('⚠ a claimed-but-unreported intent is not silently called success', () => {
  reset();
  const r = di.queue('music');
  di.claim();
  assert.equal(di.status(r.intent.id).state, 'claimed', 'the laptop has it — that is not the same as done');
});

// ── Bounds ───────────────────────────────────────────────────────────────────

test('the queue is bounded — a stuck agent cannot grow it without limit', () => {
  reset();
  for (let i = 0; i < 20; i++) di.queue('music');
  const raw = JSON.parse(db.getState(di.STATE_KEY));
  assert.ok(raw.pending.length <= di.MAX_PENDING);
});
