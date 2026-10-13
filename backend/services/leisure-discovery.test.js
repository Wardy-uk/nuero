'use strict';

/**
 * "You might like" (13 Oct 2026). Pure ranking + the real refresh/read path
 * against a scratch DB, with Deezer faked at fetch. Fixtures are shaped like
 * Deezer's live answers (M83 → Metronomy, The xx, …, checked from pi5).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-disc-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'd.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.HA_TOKEN = '';
process.env.HA_URL = 'http://127.0.0.1:9';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');

const db = require('../db/database');
const leisure = require('./leisure');
const D = require('./leisure-discovery');

const NOW = Date.parse('2026-10-13T15:00:00Z');
test.before(async () => { await db.init(); });

const at = (min) => new Date(NOW - min * 60000).toISOString();

const DEEZER = {
  search: { M83: [{ id: 678, name: 'M83' }], 'Dire Straits': [{ id: 176, name: 'Dire Straits' }], Phoenix: [{ id: 9, name: 'Phoenix (Band of Brothers)' }] },
  related: {
    678: [{ id: 1, name: 'Metronomy', nb_fan: 505017 }, { id: 2, name: 'The xx', nb_fan: 1104488 }, { id: 3, name: 'Dire Straits', nb_fan: 3000000 }, { id: 4, name: 'Hot Chip', nb_fan: 142928 }],
    176: [{ id: 5, name: 'Mark Knopfler', nb_fan: 900000 }, { id: 4, name: 'Hot Chip', nb_fan: 142928 }],
  },
  top: { 1: { title: 'The Look', preview: 'https://cdns-preview/x.mp3', link: 'https://www.deezer.com/track/1' } },
};

function fakeFetch(calls) {
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    let body = { data: [] };
    if (u.pathname === '/search/artist') body = { data: DEEZER.search[u.searchParams.get('q')] || [] };
    const rel = u.pathname.match(/^\/artist\/(\d+)\/related$/);
    if (rel) body = { data: DEEZER.related[rel[1]] || [] };
    const top = u.pathname.match(/^\/artist\/(\d+)\/top$/);
    if (top) body = { data: DEEZER.top[top[1]] ? [DEEZER.top[top[1]]] : [] };
    return { ok: true, status: 200, json: async () => body };
  };
}

function reset() {
  db.run('DELETE FROM leisure_items'); db.run('DELETE FROM leisure_observations');
  db.setState(D.KEY, 'null');
}

function heard(artist, title, album = 'X') {
  leisure.observeNowPlaying({ state: 'playing', artist, title, album, at: at(1) });
}
const refOf = (kind, title) => leisure.read({ now: NOW, haStates: [] }).listening[kind].find((o) => o.title === title).ref;

test('seeds: only what NEURO already believes — liked weighs 3, one play is nothing', () => {
  reset();
  heard('M83', 'Midnight City');
  heard('Dire Straits', 'Sultans Of Swing');
  assert.deepEqual(D.seedsFrom({ observations: leisure.listObservations(), items: leisure.listItems(), today: '2026-10-13' }), [], 'one play is never a seed');
  leisure.correct(refOf('artists', 'M83'), 'liked', { now: NOW });
  leisure.correct(refOf('tracks', 'Sultans Of Swing'), 'liked', { now: NOW });
  const seeds = D.seedsFrom({ observations: leisure.listObservations(), items: leisure.listItems(), today: '2026-10-13' });
  assert.deepEqual(seeds.map((s) => [s.name, s.weight]), [['Dire Straits', 3], ['M83', 3]], 'a liked SONG seeds its artist');
});

test('seeds: "don’t use for suggestions" and "not for me" are never seeds', () => {
  reset();
  heard('M83', 'Midnight City');
  leisure.correct(refOf('artists', 'M83'), 'liked', { now: NOW });
  leisure.correct(refOf('artists', 'M83'), 'remove-basis', { now: NOW });
  heard('Dire Straits', 'Sultans Of Swing');
  leisure.correct(refOf('artists', 'Dire Straits'), 'not-for-me', { now: NOW });
  assert.deepEqual(D.seedsFrom({ observations: leisure.listObservations(), items: leisure.listItems(), today: '2026-10-13' }), []);
});

test('rank: related to several of yours outranks one; anything already heard is never offered', () => {
  const seeds = [{ name: 'M83', weight: 3 }, { name: 'Dire Straits', weight: 3 }];
  const rel = (id) => DEEZER.related[id].map((a) => ({ id: a.id, name: a.name, fans: a.nb_fan }));
  const r = D.rank({ seeds, related: { m83: rel(678), 'dire straits': rel(176) }, known: new Set(['m83', 'dire straits']) });
  assert.equal(r[0].name, 'Hot Chip', 'related to BOTH seeds wins despite fewer fans');
  assert.deepEqual(r[0].because, ['M83', 'Dire Straits']);
  assert.ok(!r.some((x) => x.name === 'Dire Straits'), 'an artist he already plays is never a suggestion');
  assert.equal(D.becauseLine(r[0].because), 'because you listen to M83 and Dire Straits');
});

test('refresh → read: exact-name matching only, a song to try, and reading calls nothing', async () => {
  reset();
  heard('M83', 'Midnight City'); heard('Phoenix', '1901');
  leisure.correct(refOf('artists', 'M83'), 'liked', { now: NOW });
  leisure.correct(refOf('artists', 'Phoenix'), 'liked', { now: NOW });
  const calls = [];
  const r = await D.refresh({ now: NOW, fetchImpl: fakeFetch(calls) });
  assert.equal(r.ok, true);
  const v = leisure.read({ now: NOW, haStates: [] }).discovery;
  assert.deepEqual(v.unmatched, ['Phoenix'], 'Deezer’s "Phoenix (Band of Brothers)" is not Phoenix — never guessed');
  assert.ok(!calls.some((u) => u.includes('/artist/9/')), 'an unmatched seed is never asked about');
  const metro = v.items.find((x) => x.name === 'Metronomy');
  assert.deepEqual(metro.track, { title: 'The Look', link: 'https://www.deezer.com/track/1', preview: 'https://cdns-preview/x.mp3' });
  assert.equal(metro.why, 'because you listen to M83');
  // Reading again makes no network call (read has no fetch at all).
  const n = calls.length; leisure.read({ now: NOW, haStates: [] }); assert.equal(calls.length, n);
  // Throttled: the same seeds inside 12 h do not ask again.
  assert.equal((await D.refresh({ now: NOW + 3600000, fetchImpl: fakeFetch(calls) })).skipped, true);
});

test('"Not for me" removes a suggestion at READ time, before Deezer is asked again', async () => {
  reset();
  heard('M83', 'Midnight City');
  leisure.correct(refOf('artists', 'M83'), 'liked', { now: NOW });
  await D.refresh({ now: NOW, fetchImpl: fakeFetch([]) });
  assert.ok(leisure.read({ now: NOW, haStates: [] }).discovery.items.some((x) => x.name === 'The xx'));
  assert.equal(leisure.addItem({ kind: 'artist', title: 'The xx', preference: 'not-for-me' }, { now: NOW }).ok, true);
  assert.ok(!leisure.read({ now: NOW, haStates: [] }).discovery.items.some((x) => x.name === 'The xx'));
});

test('a failed refresh keeps the last good list and says so — never an empty panel', async () => {
  reset();
  heard('M83', 'Midnight City');
  leisure.correct(refOf('artists', 'M83'), 'liked', { now: NOW });
  await D.refresh({ now: NOW, fetchImpl: fakeFetch([]) });
  const before = leisure.read({ now: NOW, haStates: [] }).discovery.items.length;
  const r = await D.refresh({ now: NOW, force: true, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  assert.equal(r.ok, false);
  const v = leisure.read({ now: NOW, haStates: [] }).discovery;
  assert.equal(v.items.length, before);
  assert.match(v.lastError, /503/);
});

test('the refresh route is refused to machine clients', () => {
  const matrix = require('./authority-matrix');
  const rule = matrix.ruleFor ? matrix.ruleFor('POST', '/api/leisure/discovery/refresh') : null;
  if (rule) assert.equal(rule.machine, 'refuse');
  else assert.ok(fs.readFileSync(path.join(__dirname, 'authority-matrix.js'), 'utf8').includes("R('POST', '/api/leisure/discovery/refresh', 'internal.state', { machine: 'refuse' })"));
});
