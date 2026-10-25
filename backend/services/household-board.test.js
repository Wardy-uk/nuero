'use strict';

// The family wall's household board and home control (25 Oct 2026) — the PURE
// halves. The routes are covered over real HTTP in
// routes/vesta-wall-board-routing.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const board = require('./household-board');
const hc = require('./home-control');

const H = 3600e3;
const d0 = Date.UTC(2026, 9, 26, 0, 0); // Mon 26 Oct 2026 00:00 GMT
const day = { todayStart: d0, tomorrowStart: d0 + 24 * H, dayAfterStart: d0 + 48 * H };
const pts = (fn) => Array.from({ length: 48 }, (_, h) => ({ validAt: d0 + h * H, temperatureC: 8 + (h % 6), precipProb: fn(h) }));

test('outlook: raining now (nowcast) beats the forecast', () => {
  const o = board.composeOutlook({ ...day, nowMs: d0 + 10 * H, points: pts(() => 0), nowcast: { home: { raining: true }, arrival: { state: 'raining-here' } } });
  assert.deepEqual(o.rain, { state: 'raining', say: 'Raining now' });
});

test('outlook: nowcast arrival gives a London clock time; never "will"', () => {
  const o = board.composeOutlook({ ...day, nowMs: d0 + 10 * H, points: pts(() => 0), nowcast: { home: { raining: false }, arrival: { state: 'rain-likely', etaMin: [20, 45] } } });
  assert.deepEqual(o.rain, { state: 'arriving', say: 'Rain likely from about 10:20' });
});

test('outlook: forecast-only — first wet hour, small chance, no rain, and no points at all', () => {
  const wet = board.composeOutlook({ ...day, nowMs: d0 + 10 * H, points: pts((h) => (h === 15 ? 60 : 5)), nowcast: null });
  assert.deepEqual(wet.rain, { state: 'arriving', say: 'Rain likely from about 15:00' });
  const small = board.composeOutlook({ ...day, nowMs: d0 + 10 * H, points: pts((h) => (h === 15 ? 35 : 5)), nowcast: null });
  assert.equal(small.rain.state, 'dry');
  assert.match(small.rain.say, /35%/);
  const dry = board.composeOutlook({ ...day, nowMs: d0 + 10 * H, points: pts(() => 5), nowcast: null });
  assert.deepEqual(dry.rain, { state: 'dry', say: 'No rain expected today' });
  const none = board.composeOutlook({ ...day, nowMs: d0 + 10 * H, points: [], nowcast: null });
  assert.equal(none.known, false);
  assert.deepEqual(none.rain, { state: 'unknown', say: "Can't see the rain radar right now" });
  assert.deepEqual(none.today, { highC: null, lowC: null, rainChance: null }, 'missing is null, never 0');
  for (const o of [wet, small, dry, none]) assert.ok(!/\bwill\b/i.test(o.rain.say));
});

test('outlook: today rain chance is the REST of today; tomorrow is the whole day', () => {
  const o = board.composeOutlook({ ...day, nowMs: d0 + 12 * H + 30 * 60e3, points: pts((h) => (h === 3 ? 90 : h === 30 ? 55 : 10)), nowcast: null });
  assert.equal(o.today.rainChance, 10, 'the 90% at 03:00 is in the past');
  assert.equal(o.tomorrow.rainChance, 55);
  assert.equal(o.today.highC, 13); assert.equal(o.today.lowC, 8);
});

test('tea view: only today..+6 with text, recent distinct and capped', () => {
  const v = board.teaView({ days: { '2026-10-25': { text: 'Old' }, '2026-10-26': { text: 'Pie' }, '2026-11-02': { text: 'Too far' }, '2026-10-28': { text: '' } },
    recent: ['A', 'a', 'B', 'C', 'D', 'E', 'F', 'G'] }, '2026-10-26');
  assert.deepEqual(v, { today: 'Pie', days: [{ date: '2026-10-26', text: 'Pie' }], recent: ['A', 'B', 'C', 'D', 'E', 'F'] });
});

test('countdowns: nearest two from today, say words, past dropped; week stamping', () => {
  const v = board.countdownView({
    a: { key: 'a', title: 'A', date: '2026-10-26' }, b: { key: 'b', title: 'B', date: '2026-10-27' },
    c: { key: 'c', title: 'C', date: '2026-11-07' }, old: { key: 'old', title: 'Old', date: '2026-10-20' },
  }, '2026-10-26');
  assert.deepEqual(v.map((x) => [x.key, x.say]), [['a', 'today'], ['b', 'tomorrow']]);
  assert.equal(board.countdownSay(12), 'in 12 days');
  const week = board.stampWeek([{ date: '2026-10-26', events: [{ id: 'e1', start: '2026-10-25T00:00:00' }, { id: null, start: '2026-10-26T10:00:00' }] }], new Set(['e1@2026-10-25']));
  assert.deepEqual(week[0].events.map((e) => [e.countdownKey, e.countdown]), [['e1@2026-10-25', true], [null, false]]);
});

test('care lines: overdue, weekday, an appointment past its date is not called overdue treatment', () => {
  assert.equal(board.careLine({ care_id: 'x', kind: 'worm', title: 'Worming', due_date: '2026-10-23' }, 'Ember', '2026-10-26').say, 'Worming 3 days overdue');
  assert.equal(board.careLine({ care_id: 'x', kind: 'flea', title: 'Flea', due_date: '2026-10-27' }, 'Ember', '2026-10-26').say, 'Flea due tomorrow');
  assert.equal(board.careLine({ care_id: 'x', kind: 'flea', title: 'Flea', due_date: '2026-10-29' }, 'Ember', '2026-10-26').say, 'Flea due Thu');
  assert.match(board.careLine({ care_id: 'x', kind: 'vet', title: 'Vet', due_date: '2026-10-24' }, 'Ember', '2026-10-26').say, /not marked done/);
});

test('home control: the allow-set is exactly the room map; exclusions are absent', () => {
  const allowed = hc.allowedEntities();
  for (const e of ['light.anwio_smart_light_3', 'climate.mums_rad', 'switch.bedroom_socket_3', 'light.outback', 'climate.office_rad', 'climate.lizzy_s_room']) assert.ok(allowed.has(e), e);
  for (const e of [...allowed.keys()]) {
    assert.ok(/^(light|switch|climate)\./.test(e), `${e} is a light, socket or radiator`);
    assert.ok(!/office.*socket|work|ipad|ember|thermostat|child_lock|mute/i.test(e), `${e} is not an excluded device`);
  }
  assert.equal(allowed.size, 30);
});

test('home control shaping: boost end time only while Hive says boost; unavailable climate has no control', () => {
  const now = Date.UTC(2026, 9, 26, 10, 0);
  const states = [
    { entity_id: 'climate.living_room_rad', state: 'heat', attributes: { current_temperature: 19.5, temperature: 21, preset_mode: 'boost' } },
    { entity_id: 'climate.kitchen_rad', state: 'unavailable', attributes: {} },
    { entity_id: 'climate.mums_rad', state: 'heat', attributes: { current_temperature: 17, temperature: 18, preset_mode: 'none' } },
  ];
  const { rooms, lightsOn } = hc.shapeRooms(states, { boosts: { 'climate.living_room_rad': now + H, 'climate.mums_rad': now + H }, nowMs: now });
  const lr = rooms.find((r) => r.id === 'living-room');
  assert.deepEqual(lr.boost, { on: true, untilHHMM: '11:00' });
  assert.equal(rooms.find((r) => r.id === 'main-bedroom').boost.untilHHMM, null, 'a stale record is not an end time when Hive says no boost');
  const k = rooms.find((r) => r.id === 'kitchen');
  assert.equal(k.climate, null); assert.equal(k.tempC, null);
  assert.equal(lightsOn, 0);
});

test('activity: a wall press renders as one line', () => {
  const tl = require('./activity-timeline');
  const fn = tl.fromPersonalOps;
  assert.equal(typeof fn, 'function', 'positive control: the normaliser is reachable');
  const [e] = fn([{ id: 1, kind: 'wall-home-control', subject_id: 'entity:light.hall', actor: 'vesta:fam', at: '2026-10-26T10:00:00Z',
    detail_json: JSON.stringify({ entity: 'light.hall', action: 'on', name: 'Hall', by: 'Family', ok: true, verified: true }) }]);
  assert.equal(e.headline, 'Family (family wall) turned Hall on');
  assert.equal(e.status, 'verified');
});
