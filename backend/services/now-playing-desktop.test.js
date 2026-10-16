'use strict';

/**
 * The laptop reports what is playing (16 Oct 2026). The desktop agent reads
 * Windows' media controls and posts to the same now-playing route the phone
 * uses, with client 'desktop'. Pins: the source is named per device all the
 * way through (current track, leisure ledger, source rows), each device's
 * health is judged on its OWN reports, and the route carries `app`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-npd-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'n.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.HA_TOKEN = '';
process.env.HA_URL = 'http://127.0.0.1:9';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');

const db = require('../db/database');
const np = require('./now-playing');
const leisure = require('./leisure');

const NOW = Date.parse('2026-10-16T10:00:00Z');
const iso = (minsAgo) => new Date(NOW - minsAgo * 60000).toISOString();

test.before(async () => { if (db.init) await db.init(); });
test.beforeEach(() => {
  db.setState(np.KEY, 'null');
  db.setState('now_playing_by_client', 'null');
  try { db.run('DELETE FROM leisure_observations'); } catch { /* table may be lazy */ }
});

test('a laptop report is the laptop\'s, everywhere it is named', () => {
  const r = np.record({ state: 'playing', title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', app: 'Apple Music', client: 'desktop', at: iso(2) }, { now: NOW });
  assert.equal(r.stored, true);
  assert.equal(r.item.app, 'Apple Music');
  assert.equal(np.sourceOf(np.current({ now: NOW })), 'desktop-music');

  const read = leisure.read({ now: NOW, haStates: [] });
  assert.equal(read.now.playing.source, 'desktop-music');
  assert.equal(read.now.playing.app, 'Apple Music');

  const obs = db.all('SELECT source FROM leisure_observations');
  assert.ok(obs.length > 0, 'a playing laptop report with an artist must fold into the ledger');
  for (const o of obs) assert.equal(o.source, 'desktop-music');
});

test('a phone report with no client stays the phone (older iOS builds)', () => {
  np.record({ state: 'playing', title: 'Song', artist: 'Artist', at: iso(1) }, { now: NOW });
  assert.equal(np.sourceOf(np.latest()), 'phone-music');
});

test('laptop plays do not make the iPhone look alive, and vice versa', () => {
  np.record({ state: 'playing', title: 'A', artist: 'X', client: 'Neuro', at: iso(60 * 30) }, { now: NOW });
  np.record({ state: 'playing', title: 'B', artist: 'Y', client: 'desktop', app: 'Apple Music', at: iso(5) }, { now: NOW });
  assert.equal(np.latestFrom('phone-music').title, 'A');
  assert.equal(np.latestFrom('desktop-music').title, 'B');

  const rows = Object.fromEntries(leisure.read({ now: NOW, haStates: [] }).sources.map((s) => [s.id, s]));
  assert.equal(rows['phone-music'].state, 'quiet');
  assert.equal(rows['desktop-music'].state, 'seeing');
  assert.match(rows['desktop-music'].detail, /Apple Music/);
});

test('an older report from one device never replaces a newer one from the same device', () => {
  np.record({ state: 'playing', title: 'New', artist: 'X', client: 'desktop', at: iso(1) }, { now: NOW });
  np.record({ state: 'paused', title: 'Old', artist: 'X', client: 'desktop', at: iso(10) }, { now: NOW });
  assert.equal(np.latestFrom('desktop-music').title, 'New');
});

test('an unreadable per-device store is never overwritten', () => {
  db.setState('now_playing_by_client', '{not json');
  np.record({ state: 'playing', title: 'T', artist: 'A', client: 'desktop', at: iso(1) }, { now: NOW });
  assert.equal(db.getState('now_playing_by_client'), '{not json');
});

test('the route carries app through (real HTTP)', async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/device', require('../routes/device'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    const body = JSON.stringify({ state: 'playing', title: 'Angel', artist: 'Massive Attack', app: 'Apple Music', client: 'desktop', at: new Date().toISOString() });
    const res = await fetch(`http://127.0.0.1:${port}/api/device/now-playing`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const json = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json));
    assert.equal(json.item.app, 'Apple Music');
    assert.equal(json.item.client, 'desktop');
  } finally { server.close(); }
});
