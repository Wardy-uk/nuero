'use strict';

/**
 * Room offers — the rules about when SARA may speak up about a room.
 *
 * `assess()` is pure, so what is under test is the product: which moments count
 * as dark, what "the lights are off" is allowed to mean, and the things it
 * refuses to conclude. Every fixture below is a REAL reading taken off the live
 * house on 12 Sep 2026, because the two most expensive failures here were both
 * found in live data and neither one throws:
 *
 *   - a Fahrenheit temperature read as Celsius (the room is never cool, so the
 *     rule never fires and never errors), and
 *   - `unavailable` read as `off` (SARA offers to turn on a bulb she cannot
 *     reach, and the offer fails at the moment he accepts it).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ro = require('./room-offers');

// Real sun.sun attributes, 12 Sep 2026.
const SUN = {
  nextSetting: '2026-09-12T18:27:43.575743+00:00',
  nextRising: '2026-09-13T05:36:16.432437+00:00',
};
// The same day rolled forward, for testing the pre-dawn edge.
const SUN_PREDAWN = {
  nextSetting: '2026-09-13T18:25:00.000000+00:00',
  nextRising: '2026-09-13T05:36:16.432437+00:00',
};

const AT = iso => new Date(iso);

function room(over = {}) {
  return {
    area: 'Living Room',
    // Real entity ids and states.
    lights: [
      { entity_id: 'light.living_room_2', state: 'off' },
      { entity_id: 'light.living_room_3', state: 'off' },
    ],
    climate: [
      { entity_id: 'climate.living_room_rad', state: 'heat', currentC: 20.0, targetC: 12.0 },
    ],
    ...over,
  };
}

const SURE = { room: 'Living Room', confidence: 'sure', subject: 'watch', since: '2026-09-12T18:00:00Z' };

function run(over = {}) {
  return ro.assess({
    rooms: [room(over.room || {})],
    presence: over.presence === undefined ? SURE : over.presence,
    sun: over.sun === undefined ? SUN : over.sun,
    now: over.now || AT('2026-09-12T18:20:00Z'),
    options: over.options,
  });
}

// ── The dark window, which is Nick's spec ────────────────────────────────────

test('within 15 minutes of sunset is dark', () => {
  const d = ro.isDark(SUN, AT('2026-09-12T18:20:00Z'));
  assert.equal(d.dark, true);
  assert.equal(d.known, true);
});

test('sixteen minutes before sunset is not yet dark', () => {
  const d = ro.isDark(SUN, AT('2026-09-12T18:11:00Z'));
  assert.equal(d.dark, false);
  assert.equal(d.known, true);
});

test('the middle of the night is dark', () => {
  const d = ro.isDark(SUN_PREDAWN, AT('2026-09-13T02:00:00Z'));
  assert.equal(d.dark, true);
});

test('just after sunset is dark, not daylight', () => {
  // The trap: next_setting has rolled to TOMORROW, so a naive "how long to
  // sunset" reads ~24h and concludes daylight at half past six in the evening.
  const rolled = { nextSetting: '2026-09-13T18:25:00Z', nextRising: '2026-09-13T05:36:00Z' };
  assert.equal(ro.isDark(rolled, AT('2026-09-12T18:35:00Z')).dark, true);
});

test('⚠ the window CLOSES 15 minutes before sunrise, it does not run past it', () => {
  // Nick confirmed this boundary explicitly. 11 minutes before dawn: no offer.
  const d = ro.isDark(SUN_PREDAWN, AT('2026-09-13T05:25:00Z'));
  assert.equal(d.dark, false);
  assert.equal(d.known, true);
  assert.match(d.why, /window closed/);
});

test('daytime is not dark', () => {
  assert.equal(ro.isDark(SUN, AT('2026-09-12T12:00:00Z')).dark, false);
});

test('⚠ unreadable sun times are UNKNOWN, never "not dark"', () => {
  const d = ro.isDark({ nextSetting: null, nextRising: null }, AT('2026-09-12T18:20:00Z'));
  assert.equal(d.known, false);
  assert.equal(d.dark, false);
  // and no offer is made off the back of it
  const out = run({ sun: {} });
  assert.equal(out.offers.length, 0);
  assert.ok(out.gaps.some(g => /dark/.test(g)));
});

// ── Lights: three states, not two ────────────────────────────────────────────

test('a dark room with every light off gets an offer', () => {
  const out = run();
  const lights = out.offers.filter(o => o.kind === 'lights-on');
  assert.equal(lights.length, 1);
  assert.deepEqual(lights[0].entities, ['light.living_room_2', 'light.living_room_3']);
});

test('one lamp already on means the room is sorted — no offer', () => {
  const out = run({ room: { lights: [
    { entity_id: 'light.living_room_2', state: 'on' },
    { entity_id: 'light.living_room_3', state: 'off' },
  ] } });
  assert.equal(out.offers.filter(o => o.kind === 'lights-on').length, 0);
});

test('⚠ `unavailable` is NOT `off` — she offers nothing she cannot reach', () => {
  // 7 of the 14 lights in this house read `unavailable` when probed: a smart
  // bulb switched off at the WALL. Offering to turn one on fails on acceptance.
  const out = run({ room: { lights: [
    { entity_id: 'light.living_room_2', state: 'unavailable' },
    { entity_id: 'light.living_room_3', state: 'unavailable' },
  ] } });
  assert.equal(out.offers.filter(o => o.kind === 'lights-on').length, 0);
  assert.ok(out.gaps.some(g => /reachable/.test(g)), 'and it says so rather than going quiet');
});

test('a mix of off and unavailable still offers the reachable ones', () => {
  const out = run({ room: { lights: [
    { entity_id: 'light.living_room_2', state: 'off' },
    { entity_id: 'light.living_room_3', state: 'unavailable' },
  ] } });
  const o = out.offers.find(x => x.kind === 'lights-on');
  assert.ok(o);
  assert.deepEqual(o.entities, ['light.living_room_2'], 'only the one she can actually light');
});

test('⚠ lights NEVER act — they ask, and that is the whole design', () => {
  const o = run().offers.find(x => x.kind === 'lights-on');
  assert.equal(o.act, false);
});

// ── Temperature: the Fahrenheit trap ─────────────────────────────────────────

test('a cool room in Celsius earns a warm-up offer', () => {
  const out = run({ room: { climate: [
    { entity_id: 'climate.living_room_rad', state: 'heat', currentC: 17.2, targetC: 12.0 },
  ] } });
  const warm = out.offers.find(o => o.kind === 'warm-room');
  assert.ok(warm);
  assert.equal(warm.currentC, 17.2);
  assert.equal(warm.act, true, 'heating may act — wrong costs pennies and is invisible');
});

test('a warm room earns nothing', () => {
  // The live reading: 20.0°C.
  assert.equal(run().offers.filter(o => o.kind === 'warm-room').length, 0);
});

test('⚠ NEGATIVE: the live Fahrenheit value is REFUSED, not read as a warm room', () => {
  // `sensor.living_room_rad_current_temperature` = 68.0 °F for a 20.0 °C room.
  // Fed in by mistake, the naive answer is "68 > 18.5, the room is fine" —
  // silent, permanent, and indistinguishable from a working rule.
  const t = ro.temperatureReading([
    { entity_id: 'climate.living_room_rad', state: 'heat', currentC: 68.0 },
  ]);
  assert.equal(t.known, false);
  assert.equal(t.reading, null);
  assert.deepEqual(t.suspect, ['climate.living_room_rad']);
  assert.match(t.why, /Fahrenheit/);
});

test('⚠ NEGATIVE: a suspect reading produces a GAP, never a silent no-offer', () => {
  const out = run({ room: { climate: [
    { entity_id: 'climate.living_room_rad', state: 'heat', currentC: 68.0 },
  ] } });
  assert.equal(out.offers.filter(o => o.kind === 'warm-room').length, 0);
  assert.ok(out.gaps.some(g => /Fahrenheit/.test(g)));
});

test('a dead TRV is a gap, not a warm room', () => {
  // climate.girls_rad reads `unavailable` on the live house.
  const out = run({ room: { climate: [
    { entity_id: 'climate.girls_rad', state: 'unavailable', currentC: null },
  ] } });
  assert.equal(out.offers.filter(o => o.kind === 'warm-room').length, 0);
  assert.ok(out.gaps.some(g => /reporting/.test(g)));
});

test('the coolest radiator decides, not the average', () => {
  const t = ro.temperatureReading([
    { entity_id: 'climate.a', state: 'heat', currentC: 21.0 },
    { entity_id: 'climate.b', state: 'heat', currentC: 16.0 },
  ]);
  assert.equal(t.reading.entity_id, 'climate.b');
});

// ── Presence: the watch, not Nick ────────────────────────────────────────────

test('⚠ anything below `sure` is not a room, and nothing is offered', () => {
  for (const confidence of ['unclear', null, undefined]) {
    const out = run({ presence: { room: 'Living Room', confidence, subject: 'watch' } });
    assert.equal(out.offers.length, 0, 'confidence=' + confidence);
    assert.ok(out.gaps.length > 0, 'and it says why');
  }
});

test('⚠ no presence reading at all is a GAP, not an empty house', () => {
  const out = run({ presence: null });
  assert.equal(out.offers.length, 0);
  assert.ok(out.gaps.some(g => /presence/.test(g)));
});

test('⚠ `subject` travels with every offer so nothing can promote the watch to Nick', () => {
  const out = run({ room: { climate: [
    { entity_id: 'climate.living_room_rad', state: 'heat', currentC: 17.0 },
  ] } });
  assert.ok(out.offers.length >= 2);
  for (const o of out.offers) assert.equal(o.subject, 'watch');
});

test('a room he is not in gets nothing, however cold and dark it is', () => {
  const out = ro.assess({
    rooms: [room({ area: 'Bathroom', climate: [{ entity_id: 'climate.bathroom_rad', state: 'auto', currentC: 12.0 }] })],
    presence: { room: 'Living Room', confidence: 'sure', subject: 'watch' },
    sun: SUN,
    now: AT('2026-09-12T18:20:00Z'),
  });
  assert.equal(out.offers.length, 0);
  assert.ok(out.gaps.some(g => /nothing was read for that area/.test(g)));
});

// ── Reader failure is never good news ────────────────────────────────────────

test('⚠ unreadable rooms are a NAMED GAP, never "nothing to do"', () => {
  const out = ro.assess({ rooms: null, presence: SURE, sun: SUN, now: AT('2026-09-12T18:20:00Z') });
  assert.equal(out.offers.length, 0);
  assert.ok(out.gaps.some(g => /not "nothing to do"/.test(g)));
});

test("the reader's own gaps are carried through, not dropped", () => {
  const out = ro.assess({
    rooms: [room()],
    presence: SURE,
    sun: SUN,
    now: AT('2026-09-12T18:20:00Z'),
    gaps: ['HA unreachable for 3 areas'],
  });
  assert.ok(out.gaps.includes('HA unreachable for 3 areas'));
});

// ── Keys ─────────────────────────────────────────────────────────────────────

test('an offer key names the thing, not the moment', () => {
  assert.equal(ro.offerKey('lights-on', 'Living Room'), 'room:living-room:lights-on');
  assert.equal(ro.offerKey('lights-on', "Lizzy's Room"), 'room:lizzy-s-room:lights-on');
});

test('area matching survives punctuation and case', () => {
  assert.equal(ro.slugEq('Living Room', 'living-room'), true);
  assert.equal(ro.slugEq("Lizzy's Room", 'lizzys room'), true);
  assert.equal(ro.slugEq('Kitchen', 'Bathroom'), false);
});

// ── The sun's own state is the authority (added after live testing) ──────────
//
// These exist because running the live snapshot forward through an evening
// exposed a rule that read "within 15 minutes of sunset" at every hour after
// dusk — `msToSet` goes NEGATIVE and every negative passes a `<=` test. Live it
// was masked by HA rolling the timestamp at sunset; a stale feed would have
// made the house permanently dark.

test('sun below the horizon is dark, on its own say-so', () => {
  const d = ro.isDark(
    { state: 'below_horizon', nextSetting: '2026-09-13T18:25:00Z', nextRising: '2026-09-13T05:36:00Z' },
    AT('2026-09-12T23:00:00Z'),
  );
  assert.equal(d.dark, true);
  assert.equal(d.why, 'sun is down');
});

test('sun below the horizon but 11 min from sunrise closes the window', () => {
  const d = ro.isDark(
    { state: 'below_horizon', nextSetting: '2026-09-13T18:25:00Z', nextRising: '2026-09-13T05:36:00Z' },
    AT('2026-09-13T05:25:00Z'),
  );
  assert.equal(d.dark, false);
  assert.match(d.why, /window closed/);
});

test('sun up and 7 min from setting is dusk', () => {
  const d = ro.isDark({ state: 'above_horizon', ...SUN }, AT('2026-09-12T18:20:00Z'));
  assert.equal(d.dark, true);
});

test('sun up and hours from setting is daylight', () => {
  const d = ro.isDark({ state: 'above_horizon', ...SUN }, AT('2026-09-12T12:00:00Z'));
  assert.equal(d.dark, false);
  assert.equal(d.why, 'daylight');
});

test('⚠ NEGATIVE: a STALE sun entity is unknown, never dark', () => {
  // next_setting hours in the past. The old code read this as "within 15 min of
  // sunset" and would have offered lights all day.
  const d = ro.isDark(
    { state: 'above_horizon', nextSetting: '2026-09-12T18:27:00Z', nextRising: '2026-09-13T05:36:00Z' },
    AT('2026-09-13T09:00:00Z'),
  );
  assert.equal(d.known, false);
  assert.equal(d.dark, false);
  assert.match(d.why, /stale/);
});

test('the few seconds either side of the rollover are tolerated', () => {
  const d = ro.isDark(
    { state: 'above_horizon', nextSetting: '2026-09-12T18:27:00Z', nextRising: '2026-09-13T05:36:00Z' },
    AT('2026-09-12T18:27:30Z'),
  );
  assert.equal(d.known, true, 'a 30-second-old rollover is not a stale feed');
  assert.equal(d.dark, true);
});

test('⚠ sun up with no sunset time is unknown, not daylight', () => {
  const d = ro.isDark({ state: 'above_horizon', nextSetting: null, nextRising: null }, AT('2026-09-12T12:00:00Z'));
  assert.equal(d.known, false);
});
