'use strict';

/**
 * Visits and geofences over REAL HTTP and real SQLite (5 Oct 2026). The pure
 * suite proves the rules; this proves the routes store and read them, that a
 * visit's second delivery closes the first, and that the life-state read
 * actually picks the geofence up — a field nothing joins is the commonest
 * failure in this codebase.
 *
 *   run: node --test backend/routes/place-sensing-routing.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-places-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'n.db');

const db = require('../db/database');
const ps = require('../services/place-sensing');
const location = require('../services/location');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/location', require('./location'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
// The scratch dir is left for `scripts/run-tests.js`, which removes the run's
// whole TMPDIR — Windows refuses to delete a SQLite file still held open.
test.after(() => server && server.close());

const NOW = Math.floor(Date.now() / 1000);
const H = 3600;
const OFFICE = { lat: 52.95, lng: -1.43 };

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('a saved place takes a kind and radius; junk is refused, omission changes nothing', async () => {
  const ok = await call('POST', '/api/location/places', { name: 'Office', ...OFFICE, kind: 'work', radius: 250 });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.places[0].kind, 'work');
  assert.equal((await call('POST', '/api/location/places', { name: 'Office', ...OFFICE, kind: 'pub' })).status, 400);
  assert.equal((await call('POST', '/api/location/places', { name: 'Office', ...OFFICE, radius: 5 })).status, 400);
  const again = await call('POST', '/api/location/places', { name: 'Office', ...OFFICE });
  assert.equal(again.json.places[0].kind, 'work', 'omitting kind does not clear it');
  assert.equal(again.json.places[0].radius, 250);
});

test('GET /regions lists what the phone should geofence', async () => {
  const r = await call('GET', '/api/location/regions');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.places.map((p) => [p.name, p.kind, p.radius]), [['Office', 'work', 250]]);
  assert.equal(r.json.truncated, 0);
});

test('region events: stored, unsaved place refused by name, replay folds, state reads inside', async () => {
  const body = { deviceId: 'phone-1', events: [
    { place: 'office', kind: 'enter', tst: NOW - 2 * H },
    { place: 'Nowhere', kind: 'enter', tst: NOW - H },
  ] };
  const a = await call('POST', '/api/location/regions/events', body);
  assert.equal(a.status, 200);
  assert.deepEqual([a.json.stored, a.json.rejected], [1, 1]);
  assert.equal(a.json.rejectedReasons['not a saved place'], 1);
  const b = await call('POST', '/api/location/regions/events', body);
  assert.deepEqual([b.json.stored, b.json.duplicate], [0, 1]);

  const s = await call('GET', '/api/location/regions/state');
  assert.equal(s.json.known, true);
  assert.equal(s.json.place.name, 'Office');
  assert.equal(s.json.place.kind, 'work');
});

test('the life-state read picks the geofence up as WORK', async () => {
  // ⚠ The room sensor outranks the geofence BY DESIGN, and on the Pi this read
  // reached the LIVE SAiM sensor ("watch at the work desk sensor") and passed
  // through it. Stubbed to "no room reading" so this tests the geofence only.
  const roomPresence = require('../services/room-presence');
  const realRead = roomPresence.read;
  roomPresence.read = async () => ({ known: false });
  let life;
  try {
    life = await require('../services/life-state').read(new Date(), { ignoreDeclared: true });
  } finally { roomPresence.read = realRead; }
  assert.equal(life.place.kind, 'work');
  assert.equal(life.place.basis, 'phone geofence');
});

test('an exit makes him nowhere saved — a positive answer, not unknown', async () => {
  await call('POST', '/api/location/regions/events', { deviceId: 'phone-1', events: [{ place: 'Office', kind: 'exit', tst: NOW - 30 * 60 }] });
  const s = await call('GET', '/api/location/regions/state');
  assert.deepEqual([s.json.known, s.json.place], [true, null]);
});

test('a visit arrives open, then closes on its second delivery; a replayed arrival never reopens it', async () => {
  const open = { lat: OFFICE.lat, lon: OFFICE.lng, arrival: NOW - 3 * H, departure: null, acc: 30 };
  const a = await call('POST', '/api/location/visits', { deviceId: 'phone-1', visits: [open] });
  assert.deepEqual([a.status, a.json.stored], [200, 1]);

  let r = await call('GET', '/api/location/visits?hours=6');
  assert.equal(r.json.current.known, true);
  assert.equal(r.json.current.stay.place, 'Office', 'named from the saved place, not guessed');

  const closed = await call('POST', '/api/location/visits', { deviceId: 'phone-1', visits: [{ ...open, departure: NOW - H }] });
  assert.equal(closed.json.updated, 1);
  const replay = await call('POST', '/api/location/visits', { deviceId: 'phone-1', visits: [open] });
  assert.equal(replay.json.duplicate, 1);

  r = await call('GET', '/api/location/visits?hours=6');
  assert.equal(r.json.visits.length, 1);
  assert.equal(r.json.visits[0].departure, NOW - H, 'still closed after the replay');
  assert.equal(r.json.current.stay, null);
});

test('a bad visit is named, never fatal; a bad window is a 400', async () => {
  const r = await call('POST', '/api/location/visits', { deviceId: 'phone-1', visits: [{ lat: 52, lon: -1, arrival: NOW * 1000 }] });
  assert.equal(r.status, 200);
  assert.equal(r.json.rejected, 1);
  assert.equal((await call('GET', '/api/location/visits?hours=0')).status, 400);
  assert.equal((await call('POST', '/api/location/visits', { visits: [] })).status, 400);
});

test('getTodayDwells: a one-point stay plus its closed visit is a dwell (ios source)', async (t) => {
  // Today, in the local day, so getTodayPoints finds it.
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const arrival = Math.floor(start.getTime() / 1000) + 60;
  const departure = arrival + 2 * H;
  if (departure > NOW) return t.skip('too early in the day to place a closed two-hour visit');
  db.insertLocationPoints([{ deviceId: 'phone-2', lat: 53.1, lng: -1.2, tst: arrival, source: 'ios' }]);
  await call('POST', '/api/location/visits', { deviceId: 'phone-2', visits: [{ lat: 53.1, lon: -1.2, arrival, departure }] });
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false }); // no Nominatim from a test
  try {
    const dwells = await location.getTodayDwells();
    const d = dwells.find((x) => Math.abs(x.lat - 53.1) < 0.001);
    assert.ok(d, 'the stay exists');
    assert.equal(d.durationMinutes, 120);
  } finally { global.fetch = realFetch; }
});
