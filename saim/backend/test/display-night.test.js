// Night, and where a screen is (Nick, 2 Oct 2026): "overnight (times should be a
// setting) the screens should dim — 9pm to 7am for now — unless I'm interacting",
// and "the @home screens should display room info as well, so never nothing".
//
//   run: npm test   (from saim/backend)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const night = require('../src/display/night');

const at = (h, m = 0) => new Date(2026, 9, 2, h, m);

test('9pm to 7am is night, wrapping midnight, with the edges where he said', () => {
  const w = '21:00-07:00';
  assert.equal(night.inNight(w, at(20, 59)), false);
  assert.equal(night.inNight(w, at(21, 0)), true);
  assert.equal(night.inNight(w, at(0, 30)), true);
  assert.equal(night.inNight(w, at(6, 59)), true);
  assert.equal(night.inNight(w, at(7, 0)), false);
  assert.equal(night.inNight(w, at(13, 0)), false);
});

test('the default is his 21:00-07:00, not push quiet hours', () => {
  assert.equal(night.DEFAULT_WINDOW, '21:00-07:00');
});

test('"off" and junk are never night — a bad setting must not dim a screen', () => {
  assert.equal(night.inNight('off', at(23)), false);
  assert.equal(night.inNight('late', at(23)), false);
  assert.equal(night.inNight(null, at(23)), false);
  assert.equal(night.inNight('21:00-21:00', at(21, 30)), false);
});

test('a touch lifts the dim at night, and only for as long as the wake lasts', () => {
  const now = at(23);
  const woken = night.nightFor({ window: '21:00-07:00', source: 'default', wokenUntil: now.getTime() + 60_000, now });
  assert.equal(woken.active, true);
  assert.equal(woken.dim, false, 'he is using it');
  const expired = night.nightFor({ window: '21:00-07:00', source: 'default', wokenUntil: now.getTime() - 1, now });
  assert.equal(expired.dim, true, 'he walked away; it goes back down');
});

test('by day nothing dims, touched or not', () => {
  const d = night.nightFor({ window: '21:00-07:00', source: 'default', wokenUntil: undefined, now: at(12) });
  assert.equal(d.active, false);
  assert.equal(d.dim, false);
});

test('home screens know their Home Assistant area; the work screen has none', () => {
  assert.deepEqual(night.placeFor('study', { offsite: false, env: {} }), { place: 'home', area: 'Office' });
  assert.deepEqual(night.placeFor('bedroom', { offsite: false, env: {} }), { place: 'home', area: "Mum's Room" });
  assert.deepEqual(night.placeFor('living-room', { offsite: false, env: {} }), { place: 'home', area: 'Living Room' });
  // ⚠ The office Fire is not in this house, so it must never be handed a room of it.
  assert.deepEqual(night.placeFor('office', { offsite: true, env: {} }), { place: 'work', area: null });
});

test('the area map can be overridden without a code change', () => {
  const env = { SAIM_SCREEN_AREAS: 'study=Study;garage=Garage' };
  assert.equal(night.placeFor('study', { offsite: false, env }).area, 'Study');
  assert.equal(night.placeFor('garage', { offsite: false, env }).area, 'Garage');
});

test('the verdict carries place, area and night, and a wake is reachable over HTTP', async () => {
  const router = require('../src/routes/presence');
  const app = express();
  app.use('/api/presence', router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/presence`;
  try {
    const d = await (await fetch(`${base}/display?room=study`)).json();
    assert.equal(d.place, 'home');
    assert.equal(d.area, 'Office');
    assert.equal(typeof d.night, 'object');
    assert.equal(typeof d.night.dim, 'boolean');

    const w = await fetch(`${base}/display/wake?room=study`, { method: 'POST' });
    assert.equal(w.status, 200);
    const wb = await w.json();
    assert.equal(wb.ok, true);
    assert.equal(wb.night.dim, false, 'a screen he just touched is never dimmed');

    const bad = await fetch(`${base}/display/wake?room=../etc`, { method: 'POST' });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});
