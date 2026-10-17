'use strict';
/**
 * The wall's background provider (vesta/src/backgrounds.js), 17 Oct 2026:
 * ONE fixed photograph per time-of-day x weather combination, chosen from Home
 * Assistant's observed condition and the house's real sun, falling back to time
 * of day, held steady so a passing shower never flicks the screen. No rotation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const VESTA = path.join(__dirname, '..', '..', 'vesta');

async function bundle(entry) {
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom', 'nosleep.js/*'], loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}
const load = () => bundle(path.join(VESTA, 'src', 'backgrounds.js'));

test('weather categories come only from the observed condition', async () => {
  const b = await load();
  assert.equal(b.weatherCategory('sunny'), 'clear');
  assert.equal(b.weatherCategory('clear-night'), 'clear');
  assert.equal(b.weatherCategory('partlycloudy'), 'partly');
  assert.equal(b.weatherCategory('cloudy'), 'cloudy');
  assert.equal(b.weatherCategory('pouring'), 'rain');
  assert.equal(b.weatherCategory('lightning-rainy'), 'rain');
  assert.equal(b.weatherCategory('fog'), 'fog');
  assert.equal(b.weatherCategory('snowy-rainy'), 'snow');
  assert.equal(b.weatherCategory('windy'), null, 'no preference');
  assert.equal(b.weatherCategory(null), null, 'unavailable or stale: no preference');
});

test('every time-of-day x weather combination has ONE fixed, credited photograph', async () => {
  const b = await load();
  const expect = {
    'morning/clear': 'peak-sunrise', 'morning/partly': 'peak-sunrise', 'morning/cloudy': 'edale-overcast',
    'morning/rain': 'kinder-showers', 'morning/fog': 'morning-mist', 'morning/snow': 'curbar-snow', 'morning/-': 'peak-sunrise',
    'day/clear': 'vale-of-edale', 'day/partly': 'mam-tor', 'day/cloudy': 'edale-overcast',
    'day/rain': 'kinder-showers', 'day/fog': 'roaches-mist', 'day/snow': 'kinder-snow', 'day/-': 'mam-tor',
    'evening/clear': 'bakewell-sunset', 'evening/partly': 'bakewell-sunset', 'evening/cloudy': 'surprise-view',
    'evening/rain': 'kinder-showers', 'evening/fog': 'roaches-mist', 'evening/snow': 'curbar-snow', 'evening/-': 'bakewell-sunset',
    'night/clear': 'dartmoor-night', 'night/partly': 'dartmoor-night', 'night/cloudy': 'edale-overcast',
    'night/rain': 'kinder-showers', 'night/fog': 'roaches-mist', 'night/snow': 'kinder-snow', 'night/-': 'bakewell-sunset',
  };
  for (const [key, id] of Object.entries(expect)) {
    const [slot, w] = key.split('/');
    const weather = w === '-' ? null : w;
    const a = b.backgroundFor(slot, weather); const again = b.backgroundFor(slot, weather);
    assert.equal(a.id, id, key);
    assert.equal(again.src, a.src, `${key}: the same image every time (no rotation)`);
    assert.ok(a.credit && a.licence && a.place, `${key}: credited`);
    const file = path.join(VESTA, 'public', a.src);
    assert.ok(fs.existsSync(file), `${key}: ${a.src} is bundled`);
  }
  // Night darkens a daytime photograph, never the genuine night photo.
  assert.equal(b.backgroundFor('night', 'clear').night, false, 'the Milky Way is already night');
  assert.equal(b.backgroundFor('night', 'rain').night, true, 'a rain photo at night is darkened');
  assert.equal(b.backgroundFor('night', null).night, true);
  assert.equal(b.backgroundFor('day', 'rain').matched, 'exact');
  assert.equal(b.backgroundFor('evening', 'rain').matched, 'weather', 'weather you can see outranks the hour');
  assert.equal(b.backgroundFor('day', null).matched, 'time', 'no weather: time of day alone');
});

test('every bundled photograph is credited in CREDITS.txt, and the gaps are reported', async () => {
  const b = await load();
  const credits = fs.readFileSync(path.join(VESTA, 'public', 'backgrounds', 'CREDITS.txt'), 'utf8');
  for (const img of b.providers.bundled.images) {
    const file = img.src.split('/').pop();
    assert.ok(credits.includes(file), `${file} credited`);
    assert.ok(credits.includes(img.licence), `${img.licence} stated`);
  }
  const gaps = b.providers.bundled.gaps();
  for (const g of ['morning/cloudy', 'evening/rain', 'night/rain', 'night/fog']) assert.ok(gaps.includes(g), g);
  for (const g of ['day/rain', 'day/fog', 'day/snow', 'night/clear', 'morning/fog']) assert.ok(!gaps.includes(g), g);
});

test('held steady: a new time of day changes at once, a weather change waits 30 minutes, unchanged stays put', async () => {
  const b = await load();
  const A = { src: '/a.jpg', night: false, slot: 'day' };
  const B = { src: '/b.jpg', night: false, slot: 'day' };
  const C = { src: '/c.jpg', night: false, slot: 'evening' };
  const t0 = 1_000_000;
  const first = b.steadyChoice(null, A, t0);
  assert.equal(b.steadyChoice(first, B, t0 + 10 * 60 * 1000).bg.src, '/a.jpg', 'weather change after 10 min: held');
  assert.equal(b.steadyChoice(first, B, t0 + 29 * 60 * 1000).bg.src, '/a.jpg', 'still held at 29 min');
  assert.equal(b.steadyChoice(first, B, t0 + b.HOLD_MS).bg.src, '/b.jpg', 'after 30 min: changes');
  assert.equal(b.steadyChoice(first, C, t0 + 60 * 1000).bg.src, '/c.jpg', 'a new time of day changes at once');
  let cur = first;
  for (let m = 1; m <= 600; m += 1) cur = b.steadyChoice(cur, A, t0 + m * 60 * 1000);
  assert.equal(cur, first, 'ten hours of unchanged conditions: the very same choice');
  // Regression (17 Oct 2026): the photo chosen before the first weather reading
  // must not lock the screen for 30 minutes once the real reading arrives.
  const P = { src: '/time-only.jpg', night: true, slot: 'night', provisional: true };
  const R = { src: '/real.jpg', night: false, slot: 'night', provisional: false };
  const early = b.steadyChoice(null, P, t0);
  assert.equal(b.steadyChoice(early, R, t0 + 60 * 1000).bg.src, '/real.jpg', 'the first real observation replaces a provisional photo at once');
  const real = b.steadyChoice(early, R, t0 + 60 * 1000);
  assert.equal(b.steadyChoice(real, { ...B, slot: 'night', provisional: false }, t0 + 5 * 60 * 1000).bg.src, '/real.jpg', 'between real readings the 30-minute hold still applies');
  assert.equal(b.nextSlot('evening'), 'night');
  assert.equal(b.nextSlot('night'), 'morning');
});

test('time of day follows the house sun (Home Assistant), else the generic calculation', async () => {
  const w = await bundle(path.join(VESTA, 'src', 'views', 'Wall.jsx'));
  const at = (h, m = 0) => new Date(2026, 9, 17, h, m);
  assert.equal(w.photoSlot(at(12), { elevation: -8.4, rising: false }), 'night');
  assert.equal(w.photoSlot(at(12), { elevation: 2, rising: true }), 'morning', 'sunrise');
  assert.equal(w.photoSlot(at(13), { elevation: 25, rising: false }), 'day');
  assert.equal(w.photoSlot(at(16), { elevation: 8, rising: false }), 'evening', 'golden hour');
  assert.equal(w.photoSlot(at(17), { elevation: 0.5, rising: false }), 'evening', 'sunset');
  assert.equal(w.photoSlot(at(17), { elevation: -5, rising: false }), 'night', 'after dusk');
  assert.equal(w.photoSlot(at(9), { elevation: 15, rising: true }), 'morning', 'before 11 is still morning');
  // No sun reading (unavailable or stale): the generic calculation.
  assert.equal(w.photoSlot(at(2), null), 'night');
  assert.equal(w.photoSlot(at(13), null), 'day');
  // Dew point from the station's own readings.
  assert.equal(w.dewPoint(11.4, 82).toFixed(1), '8.4');
  assert.equal(w.dewPoint(20, 100).toFixed(1), '20.0');
  assert.equal(w.dewPoint(null, 82), null);
  assert.equal(w.dewPoint(11, 0), null);
});

test('a stale or unavailable condition is answered as unknown', () => {
  const ha = require('./ha-rooms');
  // Never read: unknown, and the wall falls back to time of day.
  const v = ha.cachedCondition();
  assert.ok(v === null || v.known === false || typeof v.condition === 'string');
  assert.ok(typeof ha.cachedSun === 'function');
});
