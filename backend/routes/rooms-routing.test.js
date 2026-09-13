'use strict';

/**
 * Room offers, over real HTTP.
 *
 * The service suite proves the judgement. It says nothing about whether the
 * routes are reachable, which is what this drives.
 *
 * ⚠ ON ROUTE ORDER, HONESTLY: this router has a literal `/history` beside
 *   `/:key/accept`, which is the shape that has gone wrong here twice
 *   (`/triage/feedback` parsed as an email id, then `/triage/muted` four months
 *   later). It was MUTATION-CHECKED on 12 Sep 2026 by moving `/history` below
 *   the parameterised routes, and all nine tests still passed — because there
 *   is no `GET /:key` for it to be swallowed by, only POSTs. So order is NOT
 *   currently load-bearing and this suite does not protect it. That changes the
 *   moment anyone adds `GET /:key`; keep the literal above it anyway.
 *
 * It also drives the one thing that matters most: **accept is the only path
 * from a request to a change in Nick's house**, and a client must not be able
 * to name what gets switched on. Both refusals are asserted against real HTTP
 * rather than against the service that implements them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-rooms-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
// No Home Assistant. The house therefore reads `known:false`, which is itself
// one of the things under test: an unreachable house must never present as a
// house with nothing to do.
delete process.env.HA_URL;
delete process.env.HA_TOKEN;
// The service caches the house read for 10s so several polling surfaces do not
// hammer HA. That is right in production and wrong in a test that changes the
// house between assertions, so it is switched off here.
process.env.ROOMS_READ_CACHE_MS = '0';

const db = require('../db/database');
const haRooms = require('../services/ha-rooms');
const rooms = require('../services/rooms');

let server;
let base;

// What the fake house looks like. Dark, lamps off, one cool radiator — so both
// offers are live and can be accepted.
let house = {
  known: true,
  rooms: [{
    area: 'Living Room',
    lights: [{ entity_id: 'light.living_room_2', state: 'off' }],
    climate: [{ entity_id: 'climate.living_room_rad', state: 'heat', currentC: 16.0, targetC: 12.0 }],
  }],
  presence: { room: 'Living Room', confidence: 'sure', subject: 'watch', since: '2026-09-12T18:00:00Z' },
  sun: { state: 'below_horizon', nextSetting: null, nextRising: null },
  gaps: [],
};

let lightCalls = [];
let climateCalls = [];

test.before(async () => {
  await db.init();
  haRooms.readHouse = async () => JSON.parse(JSON.stringify(house));
  haRooms.turnOnLights = async (ids) => { lightCalls.push(ids); return { ok: true, entities: ids }; };
  haRooms.setClimateTarget = async (id, c) => { climateCalls.push({ id, c }); return { ok: true, entity: id, targetC: c }; };

  const app = express();
  app.use(express.json());
  app.use('/api/rooms', require('./rooms'));
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
});

test.after(() => new Promise(r => server.close(r)));

// A new VISIT, so an offer already answered in an earlier test does not bleed
// into the next one. Clearing both keys is exactly what walking out of the room
// and back would do, without waiting 45 real seconds for it.
function freshVisit() {
  db.setState(rooms.EPISODE_KEY, '');
  db.setState(rooms.DECISIONS_KEY, '');
}

async function get(p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
}
async function post(p, body) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json() };
}

test('GET /api/rooms returns the live offers', async () => {
  const { status, body } = await get('/api/rooms');
  assert.equal(status, 200);
  assert.equal(body.known, true);
  assert.equal(body.room, 'living-room');
  const kinds = body.offers.map(o => o.kind).sort();
  assert.deepEqual(kinds, ['lights-on', 'warm-room']);
});

test('⚠ /history is a LITERAL path, not a key called "history"', async () => {
  const { status, body } = await get('/api/rooms/history');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.entries), 'got the learning set, not an offer named history');
  assert.equal(body.ok, true);
});

test('accepting the lights offer turns on exactly the offered entities', async () => {
  freshVisit();
  lightCalls = [];
  const snap = await get('/api/rooms');
  const key = snap.body.offers.find(o => o.kind === 'lights-on').key;
  const { status, body } = await post('/api/rooms/' + encodeURIComponent(key) + '/accept');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(lightCalls, [['light.living_room_2']]);
});

test('⚠ the client CANNOT name what gets switched on', async () => {
  freshVisit();
  lightCalls = [];
  const snap = await get('/api/rooms');
  const offer = snap.body.offers.find(o => o.kind === 'warm-room');
  // A malicious/confused body naming other entities must be ignored entirely:
  // the service re-derives the offer from its own fresh read.
  const { body } = await post('/api/rooms/' + encodeURIComponent(offer.key) + '/accept', {
    entities: ['light.mum', 'climate.lizzy_s_room'],
    targetC: 30,
  });
  assert.equal(body.ok, true);
  assert.equal(lightCalls.length, 0, 'no light was touched by a heating offer');
  assert.deepEqual(climateCalls.at(-1), { id: 'climate.living_room_rad', c: 19 },
    'the radiator and target came from the server-side offer, not the request');
});

test('⚠ an offer that is no longer true cannot be executed late', async () => {
  freshVisit();
  const snap = await get('/api/rooms');
  const key = snap.body.offers.find(o => o.kind === 'lights-on')?.key;
  assert.ok(key);
  // The lamp goes on some other way — someone flicked the switch.
  const saved = JSON.parse(JSON.stringify(house));
  house.rooms[0].lights[0].state = 'on';
  const { status, body } = await post('/api/rooms/' + encodeURIComponent(key) + '/accept');
  house = saved;
  assert.equal(status, 200, 'a stale screen is a normal outcome, not a 500');
  assert.equal(body.ok, false);
  assert.match(body.reason, /no longer on the table|already answered/);
});

test('⚠ an unknown key is refused, never guessed at', async () => {
  const { status, body } = await post('/api/rooms/room%3Akitchen%3Alights-on%23made-up/accept');
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.match(body.reason, /no longer on the table/);
});

test('declining records a no and takes the offer off this visit', async () => {
  freshVisit();
  const snap = await get('/api/rooms');
  const key = snap.body.offers.find(o => o.kind === 'lights-on')?.key
    || snap.body.decided.find(d => d.kind === 'lights-on')?.key;
  assert.ok(key);
  await post('/api/rooms/' + encodeURIComponent(key) + '/decline');
  const after = await get('/api/rooms');
  assert.equal(after.body.offers.some(o => o.key === key), false, 'not asked again this visit');
  assert.ok(after.body.decided.some(d => d.key === key), 'and it says it was answered');
});

test('⚠ an unreachable house is known:false with no offers, never a calm room', async () => {
  freshVisit();
  const saved = house;
  house = { known: false, rooms: null, presence: null, sun: {}, gaps: ['HA unreachable'] };
  const { body } = await get('/api/rooms');
  house = saved;
  assert.equal(body.known, false);
  assert.deepEqual(body.offers, []);
  assert.ok(body.gaps.length > 0, 'and it says why');
});

test('the history endpoint carries the decisions as a learning set', async () => {
  // ⚠ Makes its OWN decision rather than relying on an earlier test's — the
  // preceding tests clear state to isolate their visits, so a history test that
  // read whatever happened to be left over would pass or fail on test ORDER.
  freshVisit();
  const snap = await get('/api/rooms');
  const key = snap.body.offers.find(o => o.kind === 'lights-on').key;
  await post('/api/rooms/' + encodeURIComponent(key) + '/decline');

  const { body } = await get('/api/rooms/history');
  assert.equal(body.ok, true);
  assert.equal(body.total, 1);
  const entry = body.entries[0];
  assert.equal(entry.decision, 'declined');
  assert.ok(entry.context, 'a decision carries the context that produced it');
  assert.equal(entry.context.kind, 'lights-on');
  assert.ok(entry.context.why, 'including WHY it was offered - the learning signal');
});


// ── The household gate, over real HTTP (13 Sep 2026) ─────────────────────────
//
// ⚠ THIS SUITE EXISTS BECAUSE THE UNIT TESTS COULD NOT SEE THE BUG. `assess()`
//   is pure and its own suite hands it a household, so it passed while
//   `rooms.js` was not forwarding `house.household` at all — the gate sat
//   permanently CLOSED, which is safe and utterly indistinguishable from being
//   wired. Caught by calling the live API, not by a test. These pin the wire.

async function readRooms() {
  const res = await fetch(base + '/api/rooms');
  return res.json();
}

test('the composed response carries the household reading', async () => {
  freshVisit();
  house.household = { known: true, othersHome: false, who: [], why: null };
  const out = await readRooms();
  assert.deepEqual(out.household, { known: true, othersHome: false, who: [], why: null });
});

test('an empty house lets the heating offer act', async () => {
  freshVisit();
  house.household = { known: true, othersHome: false, who: [], why: null };
  const warm = (await readRooms()).offers.find(o => o.kind === 'warm-room');
  assert.ok(warm);
  assert.equal(warm.act, true);
  assert.equal(warm.actRating, true);
});

test('⚠ someone else home: still offered, but may not act', async () => {
  freshVisit();
  house.household = { known: true, othersHome: true, who: ['Helen', 'Isaac'], why: null };
  const warm = (await readRooms()).offers.find(o => o.kind === 'warm-room');
  assert.ok(warm, 'asking is always allowed');
  assert.equal(warm.act, false);
  assert.equal(warm.actWhy, 'Helen and Isaac are home');
});

test('⚠ REGRESSION: a house read carrying NO household may not act', async () => {
  // This is the exact shape of the bug: the reader returns a house, the
  // composer forgets to forward the household, and everything looks fine.
  freshVisit();
  delete house.household;
  const out = await readRooms();
  const warm = out.offers.find(o => o.kind === 'warm-room');
  assert.ok(warm, 'the offer is still made');
  assert.equal(warm.act, false, 'but it must never act on a household nobody read');
  assert.match(warm.actWhy, /unreadable/);
  house.household = { known: true, othersHome: false, who: [], why: null };
});
