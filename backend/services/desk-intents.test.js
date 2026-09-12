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

// What a CURRENT agent declares it understands. Passing this is not optional:
// an agent that does not announce the capability is handed nothing.
const ABLE = ['music', 'code', 'terminal', 'browser'];

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
  assert.deepEqual(di.claim({ canOpen: ABLE }).intents, [], 'and nothing reached the queue');
});

test('⚠ the queued intent carries an ID ONLY — never a path or an argument', () => {
  reset();
  di.queue('music');
  const { intents } = di.claim({ canOpen: ABLE });
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
  assert.equal(di.claim({ canOpen: ABLE }).intents.length, 1);
});

test('an expired intent is swept and reported as expired, not as waiting', () => {
  reset();
  const r = di.queue('music');
  // Age it by hand.
  const raw = JSON.parse(db.getState(di.STATE_KEY));
  raw.pending[0].at = new Date(Date.now() - di.TTL_MS - 5000).toISOString();
  db.setState(di.STATE_KEY, JSON.stringify(raw));
  assert.equal(di.status(r.intent.id).state, 'expired');
  assert.deepEqual(di.claim({ canOpen: ABLE }).intents, []);
});

// ── Single use ───────────────────────────────────────────────────────────────

test('⚠ claiming REMOVES it — a retried poll cannot launch twice', () => {
  reset();
  di.queue('music');
  assert.equal(di.claim({ canOpen: ABLE }).intents.length, 1);
  assert.deepEqual(di.claim({ canOpen: ABLE }).intents, [], 'the second poll gets nothing');
});

test('⚠ an intent named for one host does not fire on another', () => {
  reset();
  di.queue('code', { host: 'DESKTOP-8LGF9RR' });
  assert.deepEqual(di.claim({ canOpen: ABLE, host: 'SOME-OTHER-PC' }).intents, [], 'wrong machine, nothing handed over');
  assert.equal(di.claim({ canOpen: ABLE, host: 'DESKTOP-8LGF9RR' }).intents.length, 1);
});

test('an intent with no host named is claimable by whichever machine polls', () => {
  reset();
  di.queue('music');
  assert.equal(di.claim({ canOpen: ABLE, host: 'ANY-PC' }).intents.length, 1);
});

// ── Saying what happened ─────────────────────────────────────────────────────

test('the agent reports the outcome, so a surface can say "opened" not "sent"', () => {
  reset();
  const r = di.queue('music');
  di.claim({ canOpen: ABLE });
  di.record(r.intent.id, true, 'iTunes');
  const s = di.status(r.intent.id);
  assert.equal(s.state, 'opened');
  assert.equal(s.detail, 'iTunes');
});

test('a failure on the laptop is reported as a failure', () => {
  reset();
  const r = di.queue('code');
  di.claim({ canOpen: ABLE });
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
  di.claim({ canOpen: ABLE });
  assert.equal(di.status(r.intent.id).state, 'claimed', 'the laptop has it — that is not the same as done');
});

// ── Bounds ───────────────────────────────────────────────────────────────────

test('the queue is bounded — a stuck agent cannot grow it without limit', () => {
  reset();
  for (let i = 0; i < 20; i++) di.queue('music');
  const raw = JSON.parse(db.getState(di.STATE_KEY));
  assert.ok(raw.pending.length <= di.MAX_PENDING);
});

// ── An older agent must not eat an intent it cannot act on ───────────────────

test('⚠ NEGATIVE: an agent that does not declare the capability is handed NOTHING', () => {
  // Claiming is a SERVER-side act, so an agent predating intents would still
  // cause one to be claimed and would then discard it with the response — Nick
  // presses a button and nothing ever happens, silently. Found live on
  // 12 Sep 2026 when an intent sat at `claimed` and never opened.
  reset();
  di.queue('music');
  assert.deepEqual(di.claim({ canOpen: null }).intents, [], 'nothing handed over');
});

test('⚠ and the intent is LEFT QUEUED for an agent that can act on it', () => {
  reset();
  di.queue('music');
  di.claim({ canOpen: null });            // an old agent polls
  const r = di.claim({ canOpen: ABLE });  // the new one polls next
  assert.equal(r.intents.length, 1, 'it was still there');
  assert.equal(r.intents[0].app, 'music');
});

test('⚠ an agent that can open SOME things is handed only those', () => {
  reset();
  di.queue('music');
  di.queue('terminal');
  const r = di.claim({ canOpen: ['music'] });
  assert.deepEqual(r.intents.map(i => i.app), ['music']);
  assert.equal(di.claim({ canOpen: ABLE }).intents[0].app, 'terminal', 'the other waits');
});
