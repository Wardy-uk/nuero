'use strict';

/**
 * "Warm this room until I leave" (17 Oct 2026) — the raise, the record of what
 * it was, and the restore on leaving, against a real scratch DB with the Home
 * Assistant doors faked AS MEASURED on the live house (Hive TRVs: hvac_modes
 * [auto, heat, off], a mode and a target, read back via /api/states).
 *
 * The rules pinned here are the ones that cost something when wrong:
 *   - the previous state is recorded BEFORE the first write;
 *   - leaving puts it back; a short blind spell is not leaving;
 *   - someone else home HOLDS the restore until the house empties;
 *   - a later human change DROPS the restore (never overwrite a person);
 *   - pending restores survive a restart.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-room-heat-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
delete process.env.HA_URL;
delete process.env.HA_TOKEN;

const db = require('../db/database');
const haRooms = require('./ha-rooms');

// ── A fake radiator, behaving like a Hive TRV ────────────────────────────────
const trv = {};
let calls = [];
let refuse = {};
let holdsAtFirstWrite = null;

function resetTrv(entity, s) { trv[entity] = { ...s }; }
haRooms.readClimate = async (entity) => {
  const s = trv[entity];
  if (!s) return { known: false, why: 'no state' };
  return { known: true, entity_id: entity, state: s.state, currentC: s.currentC, targetC: s.targetC, presetMode: s.presetMode || 'none', hvacAction: s.hvacAction || 'idle' };
};
haRooms.setHvacMode = async (entity, mode) => {
  if (holdsAtFirstWrite === null) holdsAtFirstWrite = db.getState('room_heat_holds');
  calls.push({ op: 'mode', entity, mode });
  if (refuse.mode) return { ok: false, reason: 'HA climate.set_hvac_mode -> 500' };
  trv[entity].state = mode;
  return { ok: true };
};
haRooms.setClimateTarget = async (entity, c) => {
  if (holdsAtFirstWrite === null) holdsAtFirstWrite = db.getState('room_heat_holds');
  calls.push({ op: 'target', entity, c });
  if (refuse.target) return { ok: false, reason: 'HA climate.set_temperature -> 500' };
  trv[entity].targetC = c;
  return { ok: true };
};

const E = 'climate.living_room_rad';
const OFFER = { kind: 'warm-room', area: 'Living Room', action: { kind: 'raise-until-leave', entity: E, toC: 20, hvacMode: 'heat' }, targetC: 20 };
const EMPTY = { known: true, othersHome: false, who: [] };
const HELEN = { known: true, othersHome: true, who: ['Helen'] };
const NOW = Date.parse('2026-10-17T18:00:00Z');

let roomHeat;
function fresh() {
  delete require.cache[require.resolve('./room-heat')];
  roomHeat = require('./room-heat');
  return roomHeat;
}

test.before(async () => { await db.init(); fresh(); });

function reset() {
  db.setState('room_heat_holds', '');
  db.setState('room_heat_history', '');
  calls = []; refuse = {}; holdsAtFirstWrite = null;
}

function events(kind) {
  return db.all('SELECT * FROM personal_ops_events WHERE kind = ? ORDER BY id', [kind]);
}

// ── The pure planner ─────────────────────────────────────────────────────────

const HOLD = { id: 'h1', entity: E, area: 'Living Room', room: 'living-room', setTo: { hvacMode: 'heat', targetC: 20 }, previous: { hvacMode: 'auto', targetC: 7 } };
const LIVE = { known: true, state: 'heat', targetC: 20 };

test('planRestore: still in the room → wait', () => {
  const p = fresh().planRestore(HOLD, { visit: { room: 'living-room' }, live: LIVE, household: EMPTY, now: NOW });
  assert.equal(p.action, 'wait');
});

test('⚠ a short blind spell is NOT leaving — the bedroom sensor goes deaf', () => {
  const p = roomHeat.planRestore(HOLD, { visit: { room: null, unseenSince: NOW - 5 * 60000 }, live: LIVE, household: EMPTY, now: NOW });
  assert.equal(p.action, 'wait');
  const long = roomHeat.planRestore(HOLD, { visit: { room: null, unseenSince: NOW - 16 * 60000 }, live: LIVE, household: EMPTY, now: NOW });
  assert.equal(long.action, 'restore', 'unseen everywhere for 15+ min counts as gone');
});

test('positively in another room, house empty → restore', () => {
  const p = roomHeat.planRestore(HOLD, { visit: { room: 'kitchen' }, live: LIVE, household: EMPTY, now: NOW });
  assert.equal(p.action, 'restore');
});

test('⚠ someone else home → HOLD the restore; unreadable household also holds (fails closed)', () => {
  assert.equal(roomHeat.planRestore(HOLD, { visit: { room: 'kitchen' }, live: LIVE, household: HELEN, now: NOW }).action, 'hold');
  assert.match(roomHeat.planRestore(HOLD, { visit: { room: 'kitchen' }, live: LIVE, household: HELEN, now: NOW }).why, /Helen is home/);
  assert.equal(roomHeat.planRestore(HOLD, { visit: { room: 'kitchen' }, live: LIVE, household: { known: false }, now: NOW }).action, 'hold');
  assert.equal(roomHeat.planRestore(HOLD, { visit: { room: 'kitchen' }, live: LIVE, household: undefined, now: NOW }).action, 'hold');
});

test('⚠ a later change DROPS the restore — and outranks the household hold', () => {
  const changed = { known: true, state: 'heat', targetC: 24 };
  assert.equal(roomHeat.planRestore(HOLD, { visit: { room: 'kitchen' }, live: changed, household: EMPTY, now: NOW }).action, 'drop');
  assert.equal(roomHeat.planRestore(HOLD, { visit: { room: 'kitchen' }, live: changed, household: HELEN, now: NOW }).action, 'drop');
  assert.equal(roomHeat.planRestore(HOLD, { visit: { room: 'kitchen' }, live: { known: true, state: 'off', targetC: 20 }, household: EMPTY, now: NOW }).action, 'drop');
});

test('an unreadable radiator is never restored or dropped blind', () => {
  assert.equal(roomHeat.planRestore(HOLD, { visit: { room: 'kitchen' }, live: { known: false, why: 'x' }, household: EMPTY, now: NOW }).action, 'wait');
});

// ── Raise ───────────────────────────────────────────────────────────────────

test('⚠ raise records the previous state BEFORE the first write, then reads it back', async () => {
  reset();
  resetTrv(E, { state: 'auto', currentC: 17.5, targetC: 7 });
  const r = await roomHeat.raise({ offer: OFFER, room: 'living-room', episode: 'living-room@1', offerKey: 'room:living-room:warm-room#living-room@1', now: new Date(NOW) });
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.deepEqual(r.previous, { hvacMode: 'auto', targetC: 7, presetMode: 'none' });
  assert.deepEqual(calls, [{ op: 'mode', entity: E, mode: 'heat' }, { op: 'target', entity: E, c: 20 }]);
  const before = JSON.parse(holdsAtFirstWrite);
  assert.ok(before[E], 'the hold was on disk before Home Assistant was touched');
  assert.deepEqual(before[E].previous, { hvacMode: 'auto', targetC: 7, presetMode: 'none' });
  assert.equal(events('room-heat-raised').length, 1, 'and it is a line in Activity');
});

test('an OFF radiator is switched to heat at 20 and remembered as off', async () => {
  reset();
  resetTrv(E, { state: 'off', currentC: 16.8, targetC: 7 });
  const r = await roomHeat.raise({ offer: OFFER, room: 'living-room', episode: 'e', offerKey: 'k', now: new Date(NOW) });
  assert.equal(r.ok, true);
  assert.equal(trv[E].state, 'heat');
  assert.equal(trv[E].targetC, 20);
  assert.equal(r.previous.hvacMode, 'off');
});

test('a radiator already in heat gets only the target — no needless mode call', async () => {
  reset();
  resetTrv(E, { state: 'heat', currentC: 17.5, targetC: 12 });
  await roomHeat.raise({ offer: OFFER, room: 'living-room', episode: 'e', offerKey: 'k', now: new Date(NOW) });
  assert.deepEqual(calls, [{ op: 'target', entity: E, c: 20 }]);
});

test('⚠ a refused write is a visible failure, and leaves no restore owed when nothing changed', async () => {
  reset();
  resetTrv(E, { state: 'heat', currentC: 17.5, targetC: 12 });
  refuse.target = true;
  const r = await roomHeat.raise({ offer: OFFER, room: 'living-room', episode: 'e', offerKey: 'k', now: new Date(NOW) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /refused the temperature/);
  assert.deepEqual(roomHeat.holds(), {}, 'nothing changed → nothing to put back');
  assert.ok(events('room-heat-raise-failed').length >= 1);
});

test('a write the radiator has not confirmed is reported unverified, never as done', async () => {
  reset();
  resetTrv(E, { state: 'heat', currentC: 17.5, targetC: 12 });
  const realSet = haRooms.setClimateTarget;
  haRooms.setClimateTarget = async (entity, c) => { calls.push({ op: 'target', entity, c }); return { ok: true }; }; // accepted, not applied
  const r = await roomHeat.raise({ offer: OFFER, room: 'living-room', episode: 'e', offerKey: 'k', now: new Date(NOW) });
  haRooms.setClimateTarget = realSet;
  assert.equal(r.ok, true);
  assert.equal(r.verified, false);
  assert.match(r.reason, /still reads set to 12°C/);
});

test('⚠ raising a radiator NEURO already holds keeps the ORIGINAL previous state', async () => {
  reset();
  resetTrv(E, { state: 'auto', currentC: 17.5, targetC: 7 });
  await roomHeat.raise({ offer: OFFER, room: 'living-room', episode: 'e1', offerKey: 'k1', now: new Date(NOW) });
  await roomHeat.raise({ offer: OFFER, room: 'living-room', episode: 'e2', offerKey: 'k2', now: new Date(NOW + 60000) });
  assert.deepEqual(roomHeat.holds()[E].previous, { hvacMode: 'auto', targetC: 7, presetMode: 'none' }, 'not our own 20°C');
});

// ── Restore ─────────────────────────────────────────────────────────────────

async function raised(prev) {
  reset();
  resetTrv(E, { state: prev.state, currentC: 17.5, targetC: prev.targetC });
  await roomHeat.raise({ offer: OFFER, room: 'living-room', episode: 'e', offerKey: 'k', now: new Date(NOW) });
  calls = [];
}

test('leaving puts an auto radiator back on its schedule (mode only — the schedule owns the target)', async () => {
  await raised({ state: 'auto', targetC: 7 });
  const r = await roomHeat.sweep({ visit: { room: 'kitchen' }, household: EMPTY, now: new Date(NOW + 30 * 60000) });
  assert.equal(r.restored, 1);
  assert.deepEqual(calls, [{ op: 'mode', entity: E, mode: 'auto' }]);
  assert.deepEqual(roomHeat.holds(), {});
  assert.equal(roomHeat.history()[0].finished.action, 'restored');
  assert.equal(events('room-heat-restored').length >= 1, true);
});

test('leaving puts a manual-heat radiator back to its old target, and an off one back off', async () => {
  await raised({ state: 'heat', targetC: 12 });
  await roomHeat.sweep({ visit: { room: 'kitchen' }, household: EMPTY, now: new Date(NOW + 60000) });
  assert.deepEqual(calls, [{ op: 'target', entity: E, c: 12 }]);
  assert.equal(trv[E].targetC, 12);

  await raised({ state: 'off', targetC: 7 });
  await roomHeat.sweep({ visit: { room: 'kitchen' }, household: EMPTY, now: new Date(NOW + 60000) });
  assert.deepEqual(calls, [{ op: 'mode', entity: E, mode: 'off' }]);
  assert.equal(trv[E].state, 'off');
});

test('still in the room → nothing is touched', async () => {
  await raised({ state: 'auto', targetC: 7 });
  const r = await roomHeat.sweep({ visit: { room: 'living-room' }, household: EMPTY, now: new Date(NOW + 60000) });
  assert.equal(r.waiting, 1);
  assert.deepEqual(calls, []);
});

test('⚠ held while someone else is home, restored when the house empties', async () => {
  await raised({ state: 'auto', targetC: 7 });
  const held = await roomHeat.sweep({ visit: { room: 'kitchen' }, household: HELEN, now: new Date(NOW + 60000) });
  assert.equal(held.held, 1);
  assert.deepEqual(calls, [], 'nothing written while Helen is home');
  assert.equal(roomHeat.holds()[E].status, 'held');
  const n = events('room-heat-restore-held').length;
  await roomHeat.sweep({ visit: { room: 'kitchen' }, household: HELEN, now: new Date(NOW + 120000) });
  assert.equal(events('room-heat-restore-held').length, n, 'the hold is logged once, not every minute');
  const later = await roomHeat.sweep({ visit: { room: 'kitchen' }, household: EMPTY, now: new Date(NOW + 3 * 3600000) });
  assert.equal(later.restored, 1);
  assert.deepEqual(calls, [{ op: 'mode', entity: E, mode: 'auto' }]);
});

test('⚠ a human change after NEURO\'s DROPS the restore — never overwritten', async () => {
  await raised({ state: 'auto', targetC: 7 });
  trv[E].targetC = 24; // Helen turned it up
  const r = await roomHeat.sweep({ visit: { room: 'kitchen' }, household: EMPTY, now: new Date(NOW + 60000) });
  assert.equal(r.dropped, 1);
  assert.deepEqual(calls, [], 'nothing written');
  assert.equal(trv[E].targetC, 24);
  assert.deepEqual(roomHeat.holds(), {});
  assert.ok(events('room-heat-restore-dropped').length >= 1);
});

test('⚠ a pending restore survives a restart', async () => {
  await raised({ state: 'auto', targetC: 7 });
  fresh(); // a new process: nothing in memory, only agent_state
  assert.ok(roomHeat.holds()[E], 'the hold was read back from the DB');
  const r = await roomHeat.sweep({ visit: { room: 'kitchen' }, household: EMPTY, now: new Date(NOW + 60000) });
  assert.equal(r.restored, 1);
  assert.equal(trv[E].state, 'auto');
});

test('a failed restore keeps the hold and tries again', async () => {
  await raised({ state: 'auto', targetC: 7 });
  refuse.mode = true;
  const r = await roomHeat.sweep({ visit: { room: 'kitchen' }, household: EMPTY, now: new Date(NOW + 60000) });
  assert.equal(r.failed, 1);
  assert.ok(roomHeat.holds()[E], 'still owed');
  refuse.mode = false;
  const again = await roomHeat.sweep({ visit: { room: 'kitchen' }, household: EMPTY, now: new Date(NOW + 120000) });
  assert.equal(again.restored, 1);
});

test('Activity renders each room-heat line', () => {
  const tl = require('./activity-timeline');
  const rows = db.all("SELECT * FROM personal_ops_events WHERE kind LIKE 'room-heat-%'");
  const entries = tl.fromPersonalOps(rows).filter(Boolean);
  assert.equal(entries.length, rows.length, 'every room-heat kind has a renderer');
  const raisedLine = entries.find((e) => /You warmed the living room to 20°C until you leave/.test(e.headline));
  assert.ok(raisedLine);
  assert.match(raisedLine.summary, /on its schedule/);
  assert.ok(entries.some((e) => /Left the living room radiator as it is/.test(e.headline)));
  assert.ok(entries.some((e) => /Holding the living room radiator at 20°C — Helen is home/.test(e.headline)));
});
