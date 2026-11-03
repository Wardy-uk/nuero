'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loops-')), 'agent.db');
const db = require('../db/database');
const L = require('./life-loops');
const { detectEventDate } = require('./next-steps');

const NOW = Date.parse('2026-11-03T12:00:00Z');

test.before(async () => { if (db.init) await db.init(); });

test('a decision is looked back on 30 days after it was made unless Nick picks a day; "too early" is not a verdict', () => {
  const r = L.addDecision('Move standup to 10:00');
  assert.ok(r.ok);
  assert.strictEqual(r.decision.lookBackSet, false);
  assert.ok(r.decision.lookBackOn);
  assert.strictEqual(L.addDecision('x', { lookBackOn: '2026-02-31' }).ok, false);
  const id = r.decision.id;
  L.setLookBack(id, '2026-11-01');
  assert.ok(L.decisionsDue(NOW).some((d) => d.id === id));
  L.reviewDecision(id, { outcome: 'too-early', now: NOW });
  assert.ok(!L.decisionsDue(NOW).some((d) => d.id === id), 'pushed on 30 days');
  L.setLookBack(id, '2026-11-01');
  assert.strictEqual(L.reviewDecision(id, { outcome: 'maybe' }).ok, false);
  L.reviewDecision(id, { outcome: 'right', lesson: 'Ask first', now: NOW });
  assert.ok(!L.decisionsDue(NOW).some((d) => d.id === id), 'answered');
});

test('rhythm: due when the gap has passed; Caught up resets it; never recorded is due now', () => {
  assert.strictEqual(L.setRhythm('Mum', { everyDays: 0 }).ok, false);
  L.setRhythm('Mum', { everyDays: 14, lastAt: '2026-10-01', now: NOW });
  L.setRhythm('Sam', { everyDays: 30, now: NOW });
  const list = L.listRhythm(NOW);
  assert.strictEqual(list.find((p) => p.name === 'Mum').due, true);
  assert.strictEqual(list.find((p) => p.name === 'Sam').due, true);
  L.caughtUp('Mum', { now: NOW });
  assert.strictEqual(L.listRhythm(NOW).find((p) => p.name === 'Mum').due, false);
});

test('a sealed letter carries no words until its day, then arrives once', () => {
  assert.strictEqual(L.writeLetter('hi', { openOn: '2026-11-03', now: NOW }).ok, false, 'must be after today');
  const w = L.writeLetter('Dear future me', { openOn: '2026-12-01', now: NOW });
  assert.strictEqual(w.letter.body, null);
  assert.strictEqual(L.openLetter(w.letter.id, { now: NOW }).ok, false);
  const later = Date.parse('2026-12-02T12:00:00Z');
  assert.strictEqual(L.lettersArrived(later).length, 1);
  assert.strictEqual(L.openLetter(w.letter.id, { now: later }).letter.body, 'Dear future me');
  assert.strictEqual(L.lettersArrived(later).length, 0);
});

test('garden picks are stable for a week and change the next', () => {
  const c = Array.from({ length: 30 }, (_, i) => `n${i}.md`);
  assert.deepStrictEqual(L.pickForWeek(c, '2026-W45'), L.pickForWeek(c.slice().reverse(), '2026-W45'));
  assert.notDeepStrictEqual(L.pickForWeek(c, '2026-W45'), L.pickForWeek(c, '2026-W46'));
});

test('choose for me: rated high and not recent; the pool says why the rest are out', () => {
  const entries = [
    { kind: 'restaurant', title: 'The Salt House', rating: 10, loggedOn: '2026-08-01' },
    { kind: 'restaurant', title: 'Harvest Grill', rating: 8, loggedOn: '2026-06-01' },
    { kind: 'restaurant', title: 'Olive', rating: 9, loggedOn: '2026-11-01' },
    { kind: 'restaurant', title: 'Meh Diner', rating: 4, loggedOn: '2026-01-01' },
  ];
  const r = L.choose(entries, { minRating: 7, skipDays: 14, weight: 0.6, today: '2026-11-03' });
  assert.deepStrictEqual(r.top.map((x) => x.title).sort(), ['Harvest Grill', 'The Salt House']);
  assert.match(r.pool.find((x) => x.title === 'Olive').why, /logged 2 days ago/);
  assert.match(r.pool.find((x) => x.title === 'Meh Diner').why, /below 7/);
  assert.strictEqual(L.logEntry({ kind: 'restaurant', title: 'X', rating: 11 }).ok, false);
});

test('an email mentioning a future date is spotted; a past or far date is not', () => {
  assert.strictEqual(detectEventDate('Your course: Date: 08/11/2026 Start 0745', '2026-11-03'), '2026-11-08');
  assert.strictEqual(detectEventDate('See you on Sunday 8th November', '2026-11-03'), '2026-11-08');
  assert.strictEqual(detectEventDate('Booked for 2 January', '2026-11-03'), '2027-01-02');
  assert.strictEqual(detectEventDate('Invoice dated 01/10/2026', '2026-11-03'), null);
  assert.strictEqual(detectEventDate('Renewal 01/09/2027', '2026-11-03'), null);
  assert.strictEqual(detectEventDate('nothing here', '2026-11-03'), null);
});
