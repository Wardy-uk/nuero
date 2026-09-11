'use strict';

// What SARA says on arrival, and when she stays quiet. Pure halves only.
const { test } = require('node:test');
const assert = require('node:assert/strict');

// greeting.js requires the DB module at load; a scratch path keeps it off the real one.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'greet-')), 'agent.db');

const g = require('./greeting');

const at = (h, m = 0) => new Date(2026, 8, 11, h, m); // a Friday
const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

test('quiet hours, a meeting and the cooldown each keep her silent, with a reason', () => {
  assert.equal(g.decide({ room: 'study', now: at(23), quiet: true }).why, 'quiet hours');
  assert.equal(g.decide({ room: 'study', now: at(10), inMeeting: true }).why, 'in a meeting');
  const ledger = { rooms: { study: at(9, 0).toISOString() } };
  const d = g.decide({ room: 'study', now: at(10, 0), ledger });
  assert.equal(d.speak, false);
  assert.match(d.why, /60 min ago/);
});

test('the cooldown is per room, and ends', () => {
  const ledger = { rooms: { study: at(9, 0).toISOString() } };
  assert.equal(g.decide({ room: 'living-room', now: at(9, 10), ledger }).speak, true, 'another room is a new arrival');
  assert.equal(g.decide({ room: 'study', now: at(10, 31), ledger }).speak, true, 'past 90 minutes');
});

test('an unreadable last-greeted stamp does not silence her for ever', () => {
  assert.equal(g.decide({ room: 'study', now: at(10), ledger: { rooms: { study: 'garbage' } } }).speak, true);
});

test('outside work hours it is the greeting and nothing else', () => {
  const w = g.compose({ now: at(19), room: 'living-room', workHours: false, workTitle: '21 emails need action', rng: seq(0) });
  assert.equal(w.lead, null);
  assert.doesNotMatch(w.text, /emails/);
  assert.ok(g.OPENERS.evening.includes(w.text) || g.OPENERS.any.includes(w.text));
});

test('in work hours it adds the one real thing from the feed', () => {
  const w = g.compose({ now: at(10), room: 'study', workHours: true, workTitle: '21 emails need action', rng: seq(0) });
  assert.match(w.text, /21 emails need action\.$/);
  assert.ok(g.LEADS.some((l) => w.text.includes(l)));
});

test('work hours with nothing pressing is still just a greeting — no invented all-clear', () => {
  const w = g.compose({ now: at(10), room: 'study', workHours: true, workTitle: null, rng: seq(0) });
  assert.equal(w.lead, null);
  assert.doesNotMatch(w.text, /clear|nothing/i);
});

test('it varies: recently used openers are not picked again while others remain', () => {
  const pool = [...g.OPENERS.morning, ...g.OPENERS.any, ...g.ROOM_OPENERS.study];
  const recent = pool.slice(0, pool.length - 1);
  const w = g.compose({ now: at(9), room: 'study', workHours: false, ledger: { recentOpeners: recent }, rng: seq(0.99) });
  assert.equal(w.text, pool[pool.length - 1]);
});

test('"welcome back" is only offered once he has been greeted today', () => {
  const first = new Set();
  for (let i = 0; i < 40; i++) first.add(g.compose({ now: at(9), room: 'kitchen', workHours: false, rng: seq(i / 40) }).opener);
  assert.ok(![...first].some((o) => g.OPENERS.again.includes(o)), 'no "welcome back" on the first arrival of the day');

  const again = new Set();
  const ledger = { lastAnyAt: at(8).toISOString() };
  for (let i = 0; i < 40; i++) again.add(g.compose({ now: at(9), room: 'kitchen', workHours: false, ledger, rng: seq(i / 40) }).opener);
  assert.ok([...again].some((o) => g.OPENERS.again.includes(o)));
});

test('work hours are a working day, 08:00 to 18:00', () => {
  assert.equal(g.isWorkHours(at(7, 59), true), false);
  assert.equal(g.isWorkHours(at(8, 0), true), true);
  assert.equal(g.isWorkHours(at(17, 59), true), true);
  assert.equal(g.isWorkHours(at(18, 0), true), false);
  assert.equal(g.isWorkHours(at(10), false), false, 'a bank holiday or weekend is not work hours');
});

test('recording keeps the last few openers and leads, newest first, without duplicates', () => {
  let ledger = {};
  for (const o of ['A', 'B', 'A', 'C', 'D', 'E']) {
    ledger = g.recordGreeting(ledger, { room: 'study', now: at(9), opener: o, lead: null });
  }
  assert.deepEqual(ledger.recentOpeners, ['E', 'D', 'C', 'A']);
  assert.equal(ledger.rooms.study, at(9).toISOString());
});
