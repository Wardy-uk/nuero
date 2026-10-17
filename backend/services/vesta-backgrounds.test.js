'use strict';
/**
 * The wall's background provider (vesta/src/backgrounds.js), 17 Oct 2026:
 * photographs by time of day AND observed weather, falling back to time of day,
 * held steady so a passing shower never flicks the screen.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

async function load() {
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [path.join(__dirname, '..', '..', 'vesta', 'src', 'backgrounds.js')],
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

test('weather categories come only from the observed condition', async () => {
  const b = await load();
  assert.equal(b.weatherCategory('sunny'), 'clear');
  assert.equal(b.weatherCategory('clear-night'), 'clear');
  assert.equal(b.weatherCategory('partlycloudy'), 'partly');
  assert.equal(b.weatherCategory('cloudy'), 'cloudy');
  assert.equal(b.weatherCategory('pouring'), 'rain');
  assert.equal(b.weatherCategory('fog'), 'fog');
  assert.equal(b.weatherCategory('snowy-rainy'), 'snow');
  assert.equal(b.weatherCategory('windy'), null, 'no preference');
  assert.equal(b.weatherCategory(null), null);
});

test('a pick matches time and weather where an image shows both, else falls back to time of day', async () => {
  const b = await load();
  const day = b.backgroundFor('day', 'partly');
  assert.equal(day.id, 'mam-tor'); assert.equal(day.matched, true);
  const rainy = b.backgroundFor('day', 'rain');
  assert.equal(rainy.id, 'mam-tor', 'no rain photograph: the day image, honestly marked');
  assert.equal(rainy.matched, false);
  assert.equal(b.backgroundFor('evening', 'cloudy').id, 'bakewell-sunset');
  const night = b.backgroundFor('night', null);
  assert.equal(night.night, true, 'night darkens an evening photograph');
  assert.equal(b.backgroundFor('morning', null).id, 'peak-sunrise', 'no weather read: time of day alone');
  for (const slot of b.SLOTS) for (const w of [null, ...b.WEATHER]) {
    const pick = b.backgroundFor(slot, w);
    assert.ok(pick && pick.src && pick.credit && pick.licence, `${slot}/${w} always has a credited image`);
  }
});

test('the gaps are reported, not filled with guesses', async () => {
  const b = await load();
  const gaps = b.providers.bundled.gaps();
  for (const g of ['day/rain', 'day/cloudy', 'day/fog', 'day/snow', 'morning/rain']) assert.ok(gaps.includes(g), g);
  assert.ok(!gaps.includes('day/partly') && !gaps.includes('morning/clear'));
});

test('the photo is held steady: a new slot switches at once, a weather-only change waits 30 minutes', async () => {
  const b = await load();
  const A = { src: '/a.jpg', night: false, slot: 'day' };
  const B = { src: '/b.jpg', night: false, slot: 'day' };
  const C = { src: '/c.jpg', night: false, slot: 'evening' };
  const t0 = 1_000_000;
  const first = b.steadyChoice(null, A, t0);
  assert.equal(first.bg.src, '/a.jpg');
  assert.equal(b.steadyChoice(first, B, t0 + 10 * 60 * 1000).bg.src, '/a.jpg', 'weather change after 10 min: held');
  assert.equal(b.steadyChoice(first, B, t0 + b.HOLD_MS).bg.src, '/b.jpg', 'after 30 min: changes');
  assert.equal(b.steadyChoice(first, C, t0 + 60 * 1000).bg.src, '/c.jpg', 'a new time of day changes at once');
  assert.equal(b.steadyChoice(first, A, t0 + 5).at, t0, 'the same image is not re-chosen');
});
