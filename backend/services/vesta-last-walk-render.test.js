'use strict';
/**
 * "Nick's last walk" on VESTA (2 Nov 2026), rendered for real (esbuild + React
 * server render): the phone's card on Home and the wall's dock button + sheet.
 *
 * What these hold: with no `walks` scope nothing is mounted (absent); with it,
 * a walk draws its summary line ("Sun 1 Nov · 9.5 km · 2 h 02 · 208 m up"),
 * map and photos; `lastWalk: null` says "No walk recorded yet", and null WITH
 * a gap says it could not be read. Times are sliced, never parsed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'vesta', 'src');

async function load(rel) {
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [path.join(SRC, rel)],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom', 'nosleep.js/*'], loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const React = require('react');
const { renderToString } = require('react-dom/server');
const h = React.createElement;
const text = (html) => html.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/<!-- -->/g, '');

const TODAY = '2026-11-02';
const NOW = new Date(2026, 10, 2, 14, 5);
const CAL = { view: 'today', offset: 0, range: { from: TODAY, days: 42 }, onStep() {}, onToday() {}, onView() {} };

const WALK = {
  id: 7, day: '2026-11-01', title: 'Hike from near Breedon', startLocal: '2026-11-01T09:42', endLocal: '2026-11-01T11:44',
  distanceM: 9512, durationSeconds: 7320, ascentM: 208, highestM: 291,
  line: [[52.68, -1.30], [52.69, -1.31], [52.70, -1.30], [52.68, -1.30]],
  start: { lat: 52.68, lon: -1.30, name: 'near Breedon' }, end: { lat: 52.68, lon: -1.30, name: 'near Breedon' },
  photos: [{ id: 'wp_0123456789abcdef', lat: 52.69, lon: -1.31, takenLocal: '2026-11-01T10:12', width: 4032, height: 3024 },
           { id: 'wp_fedcba9876543210', lat: null, lon: null, takenLocal: '2026-11-01T11:02', width: 3024, height: 4032 }],
  weather: { words: 'Partly cloudy', tempMinC: 7.2, tempMaxC: 11.8, rainMm: 0, windMaxMph: 14, gustMaxMph: 25 },
  companions: ['Ember'], avgHr: 118,
};

function data(over = {}) {
  return {
    scopes: ['tasks', 'walks'], today: TODAY, from: TODAY, days: 42, gaps: [],
    tasks: { total: 0, tasks: [] }, lastWalk: WALK, ...over,
  };
}

test('the summary line: day, distance, time, climb — built from parts, never parsed', async () => {
  const L = await load('components/LastWalk.jsx');
  assert.equal(L.walkSummary(WALK), 'Sun 1 Nov · 9.5 km · 2 h 02 · 208 m up');
  assert.equal(L.walkDuration(45 * 60), '45 min');
  assert.equal(L.walkDay('2026-03-29'), 'Sun 29 Mar', 'the clocks-change day is still the right day');
  assert.equal(L.walkSummary({ ...WALK, ascentM: null, durationSeconds: null }), 'Sun 1 Nov · 9.5 km', 'unknown parts are left out, never 0');
});

test('phone Home: the card only with the scope; a walk, none, or unreadable', async () => {
  const B = await load('components/HouseBoard.jsx');
  const open = () => {};
  const html = text(renderToString(h(B.default, { board: data(), open })));
  assert.ok(html.includes('Nick’s last walk'), 'drawn with the scope');
  assert.ok(html.includes('Sun 1 Nov · 9.5 km · 2 h 02 · 208 m up'));
  assert.ok(html.includes('Hike from near Breedon'));
  assert.ok(html.includes('walk-map'), 'the map is drawn');
  assert.equal((html.match(/class="lw__photo /g) || []).length, 2, 'two photo thumbnails');

  const noScope = data({ scopes: ['tasks'] }); delete noScope.lastWalk;
  assert.ok(!text(renderToString(h(B.default, { board: noScope, open }))).includes('last walk'), 'absent scope: not mounted');
  const scopeButAbsent = data(); delete scopeButAbsent.lastWalk;
  assert.ok(!text(renderToString(h(B.default, { board: scopeButAbsent, open }))).includes('last walk'), 'absent block: not mounted');

  const none = text(renderToString(h(B.default, { board: data({ lastWalk: null }), open })));
  assert.ok(none.includes('No walk recorded yet.'));
  const gap = text(renderToString(h(B.default, { board: data({ lastWalk: null, gaps: [{ block: 'lastWalk', why: 'could not read the last walk' }] }), open })));
  assert.ok(gap.includes('I couldn’t read Nick’s last walk just now.') && !gap.includes('No walk recorded yet'), 'unreadable is not "none"');
});

test('the wall: a dock button with the track sketch, only with the scope — even on a read-only wall', async () => {
  const C = await load('views/WallCinema.jsx');
  const html = text(renderToString(h(C.CinemaView, { data: data(), now: NOW, cal: CAL, act: null })));
  assert.ok(html.includes('cine__dockbtn--walk'), 'the walk button is drawn without act');
  assert.ok(html.includes('aria-label="Last walk: Sun 1 Nov · 9.5 km · 2 h 02 · 208 m up"'));
  assert.ok(/<path d="M[\d.]+ [\d.]+ L/.test(html), 'the track is sketched from the line');
  const can = (s) => ['tasks'].includes(s);
  assert.deepEqual(C.dockItems(data(), can).map((d) => d.id), [], 'no scope: no button');
  const noScope = data({ scopes: ['tasks'] }); delete noScope.lastWalk;
  assert.ok(!text(renderToString(h(C.CinemaView, { data: noScope, now: NOW, cal: CAL, act: null }))).includes('Last walk'));
  const gap = C.dockItems(data({ lastWalk: null, gaps: [{ block: 'lastWalk', why: 'x' }] }), (s) => s === 'walks');
  assert.equal(gap[0].badge, '!', 'an unreadable walk is marked on the button');
});

test('the sheet: full map, figures, weather words and the photo grid', async () => {
  const C = await load('views/WallCinema.jsx');
  const sheet = (d) => text(renderToString(h(C.Sheet, { sheet: { kind: 'lastWalk' }, data: d, onClose() {}, onOpenWeek: null, act: null, setSheet() {}, dirty: false, setDirty() {} })));
  const html = sheet(data());
  assert.ok(html.includes('aria-label="Nick’s last walk"'), 'the sheet opens');
  assert.ok(html.includes('lw__map--full') && html.includes('walk-map'));
  for (const s of ['9.5 km', '2 h 02', '208 m', '291 m', '09:42–11:44', '118 bpm', 'with Ember', 'Partly cloudy · 7–12°C · no rain · wind to 14 mph']) {
    assert.ok(html.includes(s), `shows ${s}`);
  }
  assert.equal((html.match(/aria-label="Open the photo"/g) || []).length, 2, 'every photo in the grid is tappable');
  assert.ok(sheet(data({ lastWalk: null })).includes('No walk recorded yet.'));
  assert.ok(sheet(data({ lastWalk: null, gaps: [{ block: 'lastWalk', why: 'x' }] })).includes('I couldn’t read Nick’s last walk just now.'));
});
