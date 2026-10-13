'use strict';

// Naming where a journey started and ended (13 Oct 2026): zone → saved place →
// diary → nearest town (offline) → unnamed. Pure rules first, then naming a
// place through the real store, routes, auth and authority guard.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-placenames-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'p.db');
process.env.NEURO_PIN = 'pin-place';
process.env.NEURO_API_TOKEN = 'machine-token-place';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
process.env.NEURO_PLACES_FILE = path.join(tmp, 'places.tsv');
delete process.env.HA_URL;
process.env.HA_TOKEN = '';
fs.mkdirSync(path.join(tmp, 'vault'), { recursive: true });
// Real coordinates from GeoNames' GB file.
fs.writeFileSync(process.env.NEURO_PLACES_FILE, ['Castleton\t53.34312\t-1.77506', 'Hope\t53.34641\t-1.74372', 'Coalville\t52.72247\t-1.3702'].join('\n'));

const db = require('../db/database');
const N = require('./place-naming');
const J = require('./vehicle-journeys');
const PS = require('./place-sensing');

const T = Date.parse('2026-10-11T09:00:00Z');
const PEAK = { lat: 53.3420, lon: -1.7790, place: null };        // a Castleton car park
const index = () => N.localityIndex();

test('a zone wins; then a saved place within its radius; then the nearest town within 5 km; else unnamed', () => {
  assert.deepEqual(N.nameFor({ lat: 52.7, lon: -1.3, place: 'home' }, { index: index() }), { name: 'Home', source: 'zone' });
  const saved = [{ name: 'Castleton car park', lat: 53.3421, lng: -1.7791, radius: 200 }];
  assert.equal(N.nameFor(PEAK, { saved, index: index() }).name, 'Castleton car park');
  const near = N.nameFor(PEAK, { index: index() });
  assert.equal(near.name, 'near Castleton');
  assert.equal(near.source, 'locality');
  // 20 km from anything in the file: no name rather than a misleading one.
  assert.deepEqual(N.nameFor({ lat: 53.5, lon: -2.1, place: null }, { index: index() }), { name: null, source: 'none' });
  // No places file at all: unnamed, never a crash.
  assert.deepEqual(N.nameFor(PEAK, { index: null }), { name: null, source: 'none' });
});

test('the diary names an arrival — a meeting with people in it, or one with a location — never a solo block, never a departure', () => {
  const arrive = Date.parse('2026-10-13T13:40:00Z');
  const meeting = { subject: 'Acme quarterly review', start: Date.parse('2026-10-13T14:00:00Z'), end: Date.parse('2026-10-13T15:00:00Z'), showAs: 'busy', withOthers: true };
  const solo = { subject: 'Task block: write report', start: Date.parse('2026-10-13T13:30:00Z'), end: Date.parse('2026-10-13T14:30:00Z'), showAs: 'busy', withOthers: false };
  const dentist = { subject: 'Dentist', start: Date.parse('2026-10-13T13:45:00Z'), end: Date.parse('2026-10-13T14:15:00Z'), showAs: 'busy', withOthers: false, location: 'High St' };
  const end = { lat: 52.9, lon: -1.5, place: null };
  assert.equal(N.nameFor(end, { at: arrive, arrival: true, events: [meeting, solo], index: null }).name, 'Acme quarterly review');
  assert.equal(N.nameFor(end, { at: arrive, arrival: true, events: [solo], index: null }).name, null, 'a solo block says what he planned to do, not where he went');
  assert.equal(N.nameFor(end, { at: arrive, arrival: true, events: [dentist], index: null }).name, 'Dentist');
  assert.equal(N.nameFor(end, { at: arrive, arrival: false, events: [meeting], index: null }).name, null, 'a meeting says nothing about where he set off from');
  assert.equal(N.nameFor(end, { at: Date.parse('2026-10-13T12:00:00Z'), arrival: true, events: [meeting], index: null }).name, null, 'two hours early is not arriving for it');
  assert.equal(N.nameFor({ ...end, place: 'Office' }, { at: arrive, arrival: true, events: [meeting], index: null }).name, 'Office', 'a zone still wins');
});

test('diary wall-clock strings parse as local time', () => {
  assert.equal(N._parseWall('2026-10-13T09:00:00.0000000'), new Date(2026, 9, 13, 9, 0, 0).getTime());
});

let server; let base;
const PIN = { 'X-NEURO-PIN': 'pin-place', 'Content-Type': 'application/json' };
const MACHINE = { 'X-NEURO-API-TOKEN': 'machine-token-place', 'Content-Type': 'application/json' };
async function call(method, p, body, headers = PIN) {
  const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const JID = `vj:life360:${T}`;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api', require('./api-auth'));
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/vehicle', require('../routes/vehicle'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  require('./vehicle').createVehicle({ make: 'Renault', model: 'Captur' });
  db.run(`INSERT INTO vehicle_journeys (journey_id, vehicle_id, status, source, started_at, ended_at, start_lat, start_lon, end_lat, end_lon, start_place, end_place, measured_miles, detected_at)
          VALUES (?, 'vehicle:captur', 'pending', 'life360', ?, ?, 52.737, -1.3499, ?, ?, 'home', NULL, 89.5, ?)`,
  [JID, T, T + 7200000, PEAK.lat, PEAK.lon, new Date().toISOString()]);
  db.setState('saved_places', JSON.stringify([{ name: 'Office', lat: 52.96, lng: -1.46, radius: 200, kind: 'work' }]));
});
test.after(() => { server && server.close(); });

test('the card names it "near Castleton"; naming it saves a place that is NOT a geofence and renames the drive', async () => {
  let pend = J.forVehicle('vehicle:captur').pending;
  assert.equal(pend[0].startLabel.name, 'Home');
  assert.equal(pend[0].endLabel.name, 'near Castleton');
  const r = await call('POST', `/api/vehicle/journeys/${encodeURIComponent(JID)}/name-place`, { which: 'end', name: 'Castleton car park' });
  assert.equal(r.status, 200);
  pend = J.forVehicle('vehicle:captur').pending;
  assert.deepEqual(pend[0].endLabel, { name: 'Castleton car park', source: 'saved' });
  const places = JSON.parse(db.getState('saved_places'));
  const named = places.find((p) => p.name === 'Castleton car park');
  assert.equal(named.geofence, false);
  assert.equal(named.lat, PEAK.lat, 'the position comes from the journey, not the client');
  const fences = PS.monitorablePlaces(places).places.map((p) => p.name);
  assert.deepEqual(fences, ['Office'], 'a named car park never takes a geofence slot');
});

test('naming refuses a geofence place it would move, a blank name, and a machine', async () => {
  const clash = await call('POST', `/api/vehicle/journeys/${encodeURIComponent(JID)}/name-place`, { which: 'end', name: 'office' });
  assert.equal(clash.status, 409);
  assert.equal(JSON.parse(db.getState('saved_places')).find((p) => p.name === 'Office').lat, 52.96, 'Office did not move');
  assert.equal((await call('POST', `/api/vehicle/journeys/${encodeURIComponent(JID)}/name-place`, { which: 'end', name: '  ' })).status, 400);
  assert.equal((await call('POST', `/api/vehicle/journeys/${encodeURIComponent(JID)}/name-place`, { which: 'end', name: 'X' }, MACHINE)).status, 403);
});
