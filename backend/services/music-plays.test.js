'use strict';

/**
 * The 24-hour music play log (16 Oct 2026). Pins: one row per track START
 * (heartbeats and re-sends extend it); a play older than 24 hours survives
 * only while its song, album or artist carries something Nick said; clearing
 * the rating lets it go; reads never delete; the log reaches the Leisure read.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mp-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'm.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.HA_TOKEN = '';
process.env.HA_URL = 'http://127.0.0.1:9';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');

const db = require('../db/database');
const np = require('./now-playing');
const mp = require('./music-plays');
const leisure = require('./leisure');

const H = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-16T08:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const play = (at, title, artist = 'AaRON', extra = {}) =>
  np.record({ state: 'playing', title, artist, album: 'Single', app: 'Apple Music', client: 'desktop', at: iso(at), ...extra }, { now: at });
const rows = () => db.all('SELECT * FROM music_plays ORDER BY played_at');

test.before(async () => { if (db.init) await db.init(); });
test.beforeEach(() => {
  db.run('DELETE FROM music_plays'); db.run('DELETE FROM leisure_items'); db.run('DELETE FROM leisure_observations');
  db.setState(np.KEY, 'null'); db.setState('now_playing_by_client', 'null');
});

test('one row per track start: heartbeats extend it, a new song starts another', () => {
  play(T0, 'Blouson Noir');
  play(T0 + 10 * 60000, 'Blouson Noir');           // heartbeat
  play(T0 + 14 * 60000, 'U-Turn (Lili)');           // next song
  const r = rows();
  assert.equal(r.length, 2);
  assert.equal(r[0].title, 'Blouson Noir');
  assert.equal(r[0].last_reported_at, iso(T0 + 10 * 60000));
});

test('the same song again after a long gap is a new play; a late copy is not', () => {
  play(T0, 'Blouson Noir');
  play(T0 + 2 * H, 'Blouson Noir');
  assert.equal(rows().length, 2, 'two hours apart is two plays');
  db.run('DELETE FROM music_plays');
  play(T0, 'Blouson Noir'); play(T0 + 5 * 60000, 'Blouson Noir'); play(T0 + 2 * 60000, 'Blouson Noir');
  assert.equal(rows().length, 1, 'a late copy of a report already covered adds nothing');
});

test('a paused or untitled report is not a play', () => {
  np.record({ state: 'paused', title: 'X', artist: 'Y', client: 'desktop', at: iso(T0) }, { now: T0 });
  np.record({ state: 'playing', title: null, artist: 'Y', client: 'desktop', at: iso(T0 + 1000) }, { now: T0 + 1000 });
  assert.equal(rows().length, 0);
});

test('after 24 hours only plays of something rated survive', () => {
  play(T0, 'Kept Song', 'Artist A');
  play(T0 + 5 * 60000, 'Dropped Song', 'Artist B');
  play(T0 + 10 * 60000, 'Artist-rated Song', 'Artist C');
  leisure.correct('music:track:artist a|kept song', 'loved', { now: T0 + H });
  leisure.correct('music:artist:artist c', 'neutral', { now: T0 + H });   // "just background" counts as saying something
  mp.prune({ now: T0 + 25 * H });
  assert.deepEqual(rows().map((r) => r.title).sort(), ['Artist-rated Song', 'Kept Song']);

  const v = mp.list({ now: T0 + 25 * H });
  assert.equal(v.last24h.length, 0);
  assert.equal(v.kept.length, 2);
  const kept = Object.fromEntries(v.kept.map((r) => [r.title, r]));
  assert.equal(kept['Kept Song'].rating, 'love');
  assert.deepEqual(kept['Artist-rated Song'].keptBecause, ['artist']);
});

test('clearing the rating lets the play go on the next prune', () => {
  play(T0, 'Song', 'Artist A');
  leisure.correct('music:track:artist a|song', 'liked', { now: T0 + H });
  leisure.correct('music:track:artist a|song', 'clear-preference', { now: T0 + 2 * H });
  mp.prune({ now: T0 + 25 * H });
  assert.equal(rows().length, 0);
});

test('reads never delete: an expired unrated play is hidden, not removed, by list()', () => {
  play(T0, 'Old Song');
  const v = mp.list({ now: T0 + 30 * H });
  assert.equal(v.last24h.length + v.kept.length, 0);
  assert.equal(rows().length, 1);
});

test('the log reaches the Leisure read, newest first, with the device', () => {
  play(T0, 'First');
  play(T0 + 5 * 60000, 'Second');
  const v = leisure.read({ now: T0 + 6 * 60000, haStates: [] });
  assert.deepEqual(v.plays.last24h.map((p) => p.title), ['Second', 'First']);
  assert.equal(v.plays.last24h[0].source, 'desktop-music');
  assert.equal(v.plays.last24h[0].ref, 'music:track:aaron|second');
});
