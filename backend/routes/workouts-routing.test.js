'use strict';

/**
 * Workout pages (2 Nov 2026), through real HTTP and real SQLite: the page reads
 * a real track and real heart-rate samples, photos land once and a removed one
 * is never taken back, and the vault note keeps Nick's own text and is never
 * recreated once he deletes it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-workouts-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'a.db');
process.env.WORKOUT_PHOTO_DIR = path.join(tmp, 'photos');
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH);

const db = require('../db/database');
const router = require('./workouts');
const notes = require('../services/workout-notes');

let server; let base;
const START = Date.UTC(2026, 10, 2, 9, 42, 0);
const sql = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/** A 3 km out-and-up: 2 points a minute for an hour, climbing 120 m then back down. */
function track() {
  const pts = [];
  for (let i = 0; i <= 120; i++) {
    const t = START / 1000 + i * 30;
    const f = i / 120;
    pts.push([52.68 + f * 0.027, -1.306, 170 + 120 * Math.sin(Math.PI * f), t]);
  }
  return pts;
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]).toString('base64');

test.before(async () => {
  await db.init();
  db.insertWorkouts([{
    sourceUuid: 'W-1', activityType: 'Hiking', startedAt: sql(START), endedAt: sql(START + 3600 * 1000), durationSeconds: 3600,
    distanceM: 3010, elevationM: 125, activeEnergyKcal: 300, avgHeartRate: 118, maxHeartRate: 150,
    payload: { route: { points: track(), pointCount: 121, firstAt: sql(START), lastAt: sql(START + 3600 * 1000) } },
  }]);
  for (let i = 0; i < 60; i++) db.insertHealthSample('heartRate', 100 + i, sql(START + i * 60 * 1000), 'test');
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/workouts', router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api/workouts`;
});
test.after(() => server && server.close());

const get = async (p) => { const r = await fetch(`${base}${p}`); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => { const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
const id = () => db.get("SELECT id FROM health_workouts WHERE source_uuid = 'W-1'").id;

test('the index lists the tracked workout and the literal paths are not swallowed by /:id', async () => {
  const l = await get('');
  assert.equal(l.body.workouts.length, 1);
  assert.equal(l.body.workouts[0].hike, true);
  const w = await get('/photo-windows');
  assert.equal(w.status, 200);
  assert.equal(w.body.windows[0].workoutId, id());
  const last = await get('/last-hike');
  assert.equal(last.body.workout.id, id());
});

test('the page measures the real track and the real heart rate', async () => {
  const { status, body } = await get(`/${id()}`);
  assert.equal(status, 200);
  assert.equal(body.contract, 'workout-view-v1');
  assert.equal(body.watch.distanceM, 3010);
  assert.ok(Math.abs(body.track.distanceM - 3002) < 30, `track distance ${body.track.distanceM}`);
  assert.ok(body.track.ascentM >= 110 && body.track.ascentM <= 125, `ascent ${body.track.ascentM}`);
  assert.equal(Math.round(body.track.highest.eleM), 290);
  // 3,002 m: three full kilometres; a 2 m tail is not a split.
  assert.equal(body.splits.length, 3);
  assert.equal(body.splits[2].partial, false);
  assert.equal(body.heartRate.known, true);
  assert.equal(body.heartRate.max, 159);
  assert.ok(body.map.line.length > 100);
  assert.ok(body.profile.length > 100);
  assert.equal(body.weather.state, 'pending');
});

test('a bad id is refused, a missing one is 404', async () => {
  assert.equal((await get('/abc')).status, 400);
  assert.equal((await get('/999999')).status, 404);
});

test('a photo lands once, pins by time without GPS, and a removed one is never taken back', async () => {
  const add = await post(`/${id()}/photos`, { assetId: 'A1', takenAt: new Date(START + 1800 * 1000).toISOString(), full: JPEG, thumb: JPEG });
  assert.equal(add.status, 200);
  const again = await post(`/${id()}/photos`, { assetId: 'A1', full: JPEG, thumb: JPEG });
  assert.equal(again.body.already, true);
  const page = (await get(`/${id()}`)).body;
  assert.equal(page.photos.length, 1);
  assert.equal(page.photos[0].placedBy, 'time');
  assert.equal(page.map.photos.length, 1);
  const img = await fetch(`${base}/photos/${add.body.photoId}?size=thumb`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  const rm = await post(`/photos/${add.body.photoId}/remove`);
  assert.equal(rm.status, 200);
  assert.equal((await fetch(`${base}/photos/${add.body.photoId}`)).status, 404);
  const back = await post(`/${id()}/photos`, { assetId: 'A1', full: JPEG, thumb: JPEG });
  assert.equal(back.status, 410);
  const win = (await get('/photo-windows')).body.windows[0];
  assert.deepEqual(win.removed, ['A1']);
});

test('a photo that is not a JPEG, or comes without a thumbnail, is refused', async () => {
  assert.equal((await post(`/${id()}/photos`, { assetId: 'A2', full: Buffer.from('hello').toString('base64'), thumb: JPEG })).status, 400);
  assert.equal((await post(`/${id()}/photos`, { assetId: 'A3', full: JPEG })).status, 400);
  assert.equal((await post(`/${id()}/photos`, { assetId: 'A4', lat: 52.6, full: JPEG, thumb: JPEG })).status, 400);
});

test('the vault note keeps Nick\'s text, and a deleted note is never recreated', () => {
  // The photo test above already wrote the note in the background.
  const first = notes.syncOne(id(), { force: true });
  assert.equal(first.ok, true);
  const file = path.join(process.env.OBSIDIAN_VAULT_PATH, first.path);
  assert.ok(first.path.startsWith('Personal/Hikes/2026/2026-11-02 '));
  let text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(notes.OPEN) && text.includes(notes.CLOSE));
  fs.writeFileSync(file, `${text}Lovely day, muddy at the bottom.\n`);
  const second = notes.syncOne(id(), { force: true });
  assert.equal(second.ok, true);
  text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('Lovely day, muddy at the bottom.'));
  assert.equal(text.split(notes.CLOSE).length, 2, 'one block, not two');
  fs.unlinkSync(file);
  const third = notes.syncOne(id(), { force: true });
  assert.equal(third.gone, true);
  assert.equal(fs.existsSync(file), false);
});
