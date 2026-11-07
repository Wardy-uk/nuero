'use strict';

/**
 * The evening Foodnoms reminder (7 Nov 2026).
 * Pinned: never when he logged, never twice a day, never when the log could not
 * be read, never when switched off; a stale phone sync is SAID; "today" is the
 * London date, not the UTC one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-foodnudge-')), 'a.db');
const db = require('../db/database');
const nudge = require('./food-log-nudge');

test.before(async () => { await db.init(); });

const EVENING = Date.parse('2026-11-07T20:00:00Z');   // 20:00 GMT

test('nothing logged and a fresh sync → one plain nudge', () => {
  const v = nudge.decide({ loggedToday: false, lastDeliveryMs: EVENING - 20 * 60000, nowMs: EVENING });
  assert.equal(v.send, true);
  assert.equal(v.day, '2026-11-07');
  assert.equal(v.stale, false);
  assert.match(v.body, /^Nothing logged in Foodnoms today/);
});

test('a stale phone sync is said, with the time it last synced', () => {
  const v = nudge.decide({ loggedToday: false, lastDeliveryMs: EVENING - 5 * 3600000, nowMs: EVENING });
  assert.equal(v.stale, true);
  assert.match(v.body, /phone last synced at 15:00/);
  assert.match(v.body, /ignore this/);
});

test('logged, already sent, unreadable or switched off → nothing', () => {
  assert.equal(nudge.decide({ loggedToday: true, nowMs: EVENING }).send, false);
  assert.equal(nudge.decide({ loggedToday: false, sentDay: '2026-11-07', nowMs: EVENING }).send, false);
  assert.equal(nudge.decide({ loggedToday: null, nowMs: EVENING }).send, false);
  assert.equal(nudge.decide({ enabled: false, loggedToday: false, nowMs: EVENING }).send, false);
});

test('run(): marks the day BEFORE sending, so a second tick sends nothing', async () => {
  let stored = null; const sent = [];
  const deps = {
    enabled: () => true, loggedToday: () => false, lastDeliveryMs: () => EVENING,
    sentDay: () => stored, markSent: (d) => { assert.equal(sent.length, 0, 'marked before the send'); stored = d; },
    push: async (t, b, data) => { sent.push({ t, b, data }); },
  };
  await nudge.run({ now: EVENING, deps });
  await nudge.run({ now: EVENING + 60000, deps });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.type, 'food_log');
});

test('loggedToday reads the LONDON date: 23:30 UTC in BST is tomorrow', () => {
  const summerNight = Date.parse('2026-07-10T22:30:00Z');       // 23:30 BST on 10 Jul
  db.run('INSERT INTO nutrition_entries (metric, value, recorded_at, source_uuid) VALUES (?,?,?,?)',
    ['dietary_energy_consumed', 400, '2026-07-10 23:30:00', 'u-bst']);    // 00:30 BST on 11 Jul
  assert.equal(nudge.loggedToday(summerNight), false, 'an entry at 00:30 BST on the 11th is not the 10th');
  assert.equal(nudge.loggedToday(Date.parse('2026-07-11T19:00:00Z')), true);
});
