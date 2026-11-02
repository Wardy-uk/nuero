'use strict';

/**
 * "Nick's last walk" on VESTA (2 Nov 2026), over real HTTP, real SQLite and the
 * REAL workout-view (no stub): two tracked hikes, a photo on each.
 *
 * What these hold:
 *  • `walks` is its own scope and not a default; `hike` does not bring it.
 *  • Without it: /walks/last and the photo route answer 403, and `lastWalk` is
 *    ABSENT from /wall and /home (paired with an account that has it, where it
 *    is present).
 *  • With it: the redacted shape — the allow-listed fields, the line thinned to
 *    ≤600 points, and NO heart-rate series, splits, body, note path or nav.
 *  • A photo of the last walk is served; a photo of an EARLIER walk is 404 —
 *    the household sees the last walk, not the archive.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-vesta-walks-'));
process.env.NEURO_DB_PATH = path.join(root, 'w.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
process.env.WORKOUT_PHOTO_DIR = path.join(root, 'photos');
process.env.VESTA_WALK_MEMO_MS = '0';
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });
process.env.NEURO_API_TOKEN = process.env.NEURO_API_TOKEN || 'test-token-for-signing';
delete process.env.HA_TOKEN;

const db = require('../db/database');
const sql = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const NEW_START = Date.UTC(2026, 10, 1, 9, 42, 0);
const OLD_START = Date.UTC(2026, 9, 18, 10, 0, 0);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]).toString('base64');

/** A dense track: one point every 5 s for two hours — 1,441 points, so thinning matters. */
function track(start, lat0) {
  const pts = [];
  for (let i = 0; i <= 1440; i++) {
    const f = i / 1440;
    pts.push([lat0 + f * 0.05, -1.306 + Math.sin(f * 6) * 0.01, 170 + 120 * Math.sin(Math.PI * f), start / 1000 + i * 5]);
  }
  return pts;
}

let base; let server; let WALKS; let HIKE_ONLY; let NEW_PHOTO; let OLD_PHOTO;
test.before(async () => {
  await db.init();
  db.insertWorkouts([
    { sourceUuid: 'W-OLD', activityType: 'Hiking', startedAt: sql(OLD_START), endedAt: sql(OLD_START + 7200e3), durationSeconds: 7200,
      distanceM: 8000, elevationM: 150, avgHeartRate: 110, maxHeartRate: 140,
      payload: { route: { points: track(OLD_START, 53.2), pointCount: 1441, firstAt: sql(OLD_START), lastAt: sql(OLD_START + 7200e3) } } },
    { sourceUuid: 'W-NEW', activityType: 'Hiking', startedAt: sql(NEW_START), endedAt: sql(NEW_START + 7200e3), durationSeconds: 7320,
      distanceM: 9512, elevationM: 208, activeEnergyKcal: 700, avgHeartRate: 118, maxHeartRate: 150,
      payload: { route: { points: track(NEW_START, 52.68), pointCount: 1441, firstAt: sql(NEW_START), lastAt: sql(NEW_START + 7200e3) } } },
  ]);
  for (let i = 0; i < 60; i++) db.insertHealthSample('heartRate', 100 + i, sql(NEW_START + i * 60e3), 'test');
  const wv = require('../services/workout-view');
  const idOf = (u) => db.get('SELECT id FROM health_workouts WHERE source_uuid = ?', [u]).id;
  NEW_PHOTO = wv.storePhoto(idOf('W-NEW'), { assetId: 'N1', takenAt: new Date(NEW_START + 1800e3).toISOString(), full: JPEG, thumb: JPEG }).photoId;
  OLD_PHOTO = wv.storePhoto(idOf('W-OLD'), { assetId: 'O1', takenAt: new Date(OLD_START + 1800e3).toISOString(), full: JPEG, thumb: JPEG }).photoId;
  assert.ok(NEW_PHOTO && OLD_PHOTO);

  const capture = require('../services/capture-links');
  capture.create({ label: 'Helen', username: 'helen-w', pin: '246813', scopes: ['tasks', 'walks'] });
  capture.create({ label: 'Hiker', username: 'hiker-w', pin: '246813', scopes: ['tasks', 'hike'] });

  const express = require('express');
  const app = express(); app.use(express.json()); app.use('/api/v', require('./vesta'));
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}/api/v`;
  const login = async (u) => (await (await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, pin: '246813' }) })).json()).token;
  WALKS = await login('helen-w');
  HIKE_ONLY = await login('hiker-w');
  assert.ok(WALKS && HIKE_ONLY);
});
test.after(() => { try { server.close(); } catch { /* */ } });

const get = async (p, token) => {
  const r = await fetch(base + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, type, json: type.includes('json') ? await r.json() : null };
};

test('walks is its own scope, not a default, and hike does not bring it', () => {
  const capture = require('../services/capture-links');
  assert.ok(capture.SCOPES.includes('walks'));
  assert.ok(!capture.DEFAULT_SCOPES.includes('walks'));
  assert.deepEqual(capture.normaliseScopes(['hike']).includes('walks'), false);
});

test('without the scope: 403 on the routes, and lastWalk is ABSENT from wall and home', async () => {
  assert.equal((await get('/walks/last', HIKE_ONLY)).status, 403);
  assert.equal((await get(`/walks/photo/${NEW_PHOTO}?size=thumb`, HIKE_ONLY)).status, 403);
  const wall = await get('/wall', HIKE_ONLY);
  assert.equal(wall.status, 200);
  assert.ok(!('lastWalk' in wall.json), 'absent on the wall');
  const home = await get('/home', HIKE_ONLY);
  assert.equal(home.status, 200);
  assert.ok(!('lastWalk' in home.json), 'absent at home');
  assert.equal((await get('/walks/last')).status, 401, 'and nothing without signing in');
});

test('with the scope: the redacted last walk, the same on /walks/last, /wall and /home', async () => {
  const r = await get('/walks/last', WALKS);
  assert.equal(r.status, 200);
  const w = r.json.walk;
  assert.ok(w, 'a walk');
  assert.equal(w.day, '2026-11-01', 'the NEWER hike');
  assert.equal(w.distanceM, 9512);
  assert.equal(w.durationSeconds, 7320);
  assert.equal(w.ascentM, 208);
  assert.equal(w.avgHr, 118);
  assert.ok(Number.isFinite(w.highestM) && w.highestM >= 280, `highest ${w.highestM}`);
  assert.ok(w.line.length > 100 && w.line.length <= 600, `line thinned to ${w.line.length}`);
  assert.ok(w.start && Number.isFinite(w.start.lat));
  assert.equal(w.photos.length, 1);
  assert.equal(w.photos[0].id, NEW_PHOTO);
  assert.equal(String(w.startLocal).slice(0, 10), '2026-11-01');
  // The allow-list: nothing outside it.
  const allowed = ['id', 'day', 'title', 'startLocal', 'endLocal', 'distanceM', 'durationSeconds', 'ascentM', 'highestM', 'line', 'start', 'end', 'photos', 'weather', 'companions', 'avgHr'];
  assert.deepEqual(Object.keys(w).sort(), [...allowed].sort());
  const text = JSON.stringify(r.json);
  for (const k of ['heartRate', 'splits', 'body', 'note', 'nav', 'profile', 'maxHr', 'activeKcal', 'obsidian', 'logger']) {
    assert.ok(!text.includes(`"${k}"`), `${k} never leaves`);
  }
  const wall = await get('/wall', WALKS);
  assert.equal(wall.json.lastWalk.id, w.id);
  const home = await get('/home', WALKS);
  assert.equal(home.json.lastWalk.id, w.id);
});

test('a photo of the last walk is served; one from an earlier walk is 404', async () => {
  const thumb = await get(`/walks/photo/${NEW_PHOTO}?size=thumb`, WALKS);
  assert.equal(thumb.status, 200);
  assert.equal(thumb.type, 'image/jpeg');
  const full = await fetch(`${base}/walks/photo/${NEW_PHOTO}`, { headers: { Authorization: `Bearer ${WALKS}` } });
  assert.equal(full.status, 200);
  assert.match(full.headers.get('cache-control') || '', /private/);
  assert.equal((await get(`/walks/photo/${OLD_PHOTO}?size=thumb`, WALKS)).status, 404, 'not the archive');
  assert.equal((await get('/walks/photo/wp_0000000000000000', WALKS)).status, 404);
});

test('householdWalk is pure: no walk is null, and thinLine keeps both ends', () => {
  const vesta = require('../services/vesta');
  assert.equal(vesta.householdWalk({ ok: true, workout: null }), null);
  const line = Array.from({ length: 2000 }, (_, i) => [i, i + 1]);
  const t = vesta.thinLine(line);
  assert.equal(t.length, 600);
  assert.deepEqual(t[0], [0, 1]);
  assert.deepEqual(t[599], [1999, 2000]);
});
