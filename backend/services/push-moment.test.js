'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-pmoment-'));
process.env.NEURO_DB_PATH = path.join(scratch, 'agent.db');

const db = require('../db/database');
const pm = require('./push-moment');
const { OWNERS } = require('./push-owner');

test.before(async () => { await db.init(); });
function reset() { db.setState(pm.KEY, '[]'); }

const AT_DESK = { driving: 'not', atDesk: true, onDuty: true, hiking: false };
const OUT = { driving: 'not', atDesk: false, onDuty: true, hiking: false };

test('every push type NEURO owns says what it needs and which part of life it is', () => {
  const missing = Object.keys(OWNERS).filter((t) => !pm.TYPES[t]);
  assert.deepEqual(missing, [], `classify these in push-moment TYPES: ${missing.join(', ')}`);
});

test('a laptop job waits while he is out; a phone-doable one does not', () => {
  assert.equal(pm.decide('weekly_risk', OUT).hold, true);
  assert.equal(pm.decide('weekly_risk', OUT).until, 'desk');
  assert.equal(pm.decide('email', OUT).hold, false, 'an email can be answered on the phone');
  assert.equal(pm.decide('weekly_risk', AT_DESK).hold, false);
});

test('walking on a lunch break is fine; off duty and on a hike are not', () => {
  assert.equal(pm.decide('email', { ...OUT, onDuty: true }).hold, false);
  assert.equal(pm.decide('email', { ...AT_DESK, onDuty: false }).until, 'on-duty');
  assert.equal(pm.decide('email', { ...OUT, hiking: true }).until, 'hike-over');
  assert.equal(pm.decide('journal', { ...AT_DESK, onDuty: false }).hold, false, 'personal pushes ignore work hours');
});

test('driving holds everything but the hike check-in — critical included', () => {
  const drv = { ...AT_DESK, driving: 'driving' };
  assert.equal(pm.decide('escalation_alert', drv, { critical: true }).until, 'parked');
  assert.equal(pm.decide('hike_checkin', drv, { critical: true }).hold, false);
});

test('a critical push the phone can act on still goes off duty; a critical laptop one waits for the desk', () => {
  assert.equal(pm.decide('escalation_alert', { ...OUT, onDuty: false }, { critical: true }).hold, false);
  assert.equal(pm.decide('block_start', OUT, { critical: true }).until, 'desk');
});

test('UNKNOWN NEVER HOLDS', () => {
  const unknown = { driving: 'unknown', atDesk: null, onDuty: null, hiking: false };
  for (const t of Object.keys(pm.TYPES)) assert.equal(pm.decide(t, unknown).hold, false, t);
});

test('a held push is kept, replaced not stacked, and released when the moment allows', async () => {
  reset();
  const now = new Date('2026-11-09T10:00:00');
  const held = await pm.holdIfWrongMoment('Weekly Risk ready', 'send it', { type: 'weekly_risk', key: 'wr' }, { now, situationFn: async () => OUT });
  assert.equal(held.until, 'desk');
  await pm.holdIfWrongMoment('Weekly Risk ready', 'send it now', { type: 'weekly_risk', key: 'wr' }, { now, situationFn: async () => OUT });
  assert.equal(pm.read().length, 1);
  const sent = [];
  const push = async (title, body, data) => { sent.push({ title, body, data }); };
  let r = await pm.tick({ now, push, situationFn: async () => OUT });
  assert.deepEqual([r.released, r.stillHeld, sent.length], [0, 1, 0]);
  r = await pm.tick({ now: new Date('2026-11-09T11:00:00'), push, situationFn: async () => AT_DESK });
  assert.equal(r.released, 1);
  assert.equal(sent[0].body, 'send it now');
  assert.equal(sent[0].data._momentReleased, true, 'a released push is not held twice');
  assert.equal(pm.read().length, 0);
});

test('a released push is never held again, and the test probe is never held', async () => {
  reset();
  assert.equal(await pm.holdIfWrongMoment('x', 'y', { type: 'weekly_risk', _momentReleased: true }, { situationFn: async () => OUT }), null);
  assert.equal(await pm.holdIfWrongMoment('x', 'y', { type: 'test' }, { probe: true, situationFn: async () => OUT }), null);
});

test('a held push that has gone stale is not sent', async () => {
  reset();
  const at = new Date('2026-11-09T09:00:00');
  await pm.holdIfWrongMoment('Standup time', 'go', { type: 'standup', key: 's' }, { now: at, situationFn: async () => ({ ...AT_DESK, onDuty: false }) });
  const sent = [];
  const r = await pm.tick({ now: new Date('2026-11-09T12:00:00'), push: async (...a) => sent.push(a), situationFn: async () => AT_DESK });
  assert.deepEqual([r.released, r.stale, sent.length], [0, 1, 0]);
});

test('more than three released at once become one summary', async () => {
  reset();
  const now = new Date('2026-11-09T07:00:00');
  const off = async () => ({ ...AT_DESK, onDuty: false });
  for (let i = 0; i < 5; i++) await pm.holdIfWrongMoment(`Email ${i}`, 'b', { type: 'email', key: `e${i}` }, { now, situationFn: off });
  const sent = [];
  const r = await pm.tick({ now: new Date('2026-11-09T08:05:00'), push: async (t, b, d) => sent.push({ t, b, d }), situationFn: async () => AT_DESK });
  assert.equal(r.released, 5);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].d.type, 'held_summary');
  assert.match(sent[0].t, /5 things/);
});

test('work hours read the window, wrapping midnight', () => {
  assert.equal(pm._inWindow('08:00-18:00', new Date('2026-11-09T07:59:00')), false);
  assert.equal(pm._inWindow('08:00-18:00', new Date('2026-11-09T08:00:00')), true);
  assert.equal(pm._inWindow('22:00-07:00', new Date('2026-11-09T23:00:00')), true);
  assert.equal(pm._inWindow('junk', new Date()), null);
});
