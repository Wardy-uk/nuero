'use strict';

/**
 * place-sensing — the pure rules for visits and geofences (5 Oct 2026).
 *
 *   run: node --test backend/services/place-sensing.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const ps = require('./place-sensing');
const lifeState = require('./life-state');
const signals = require('./signals');

const NOW = 1_790_000_000; // a fixed "now" in unix seconds
const H = 3600;
const OFFICE = { name: 'Office', lat: 52.9500, lng: -1.4300, radius: 200, kind: 'work' };
const GYM = { name: 'Gym', lat: 52.9200, lng: -1.4700, radius: 150 };

// ── visits ───────────────────────────────────────────────────────────────────

test('an open visit (no departure) is valid; a visit with neither end is refused', () => {
  assert.equal(ps.validateVisit({ lat: 52.95, lon: -1.43, arrival: NOW - H, departure: null }, NOW).ok, true);
  assert.equal(ps.validateVisit({ lat: 52.95, lon: -1.43, arrival: null, departure: null }, NOW).ok, false);
});

test('visit times use the point feed rules: milliseconds and the future are refused by name', () => {
  assert.match(ps.validateVisit({ lat: 52.95, lon: -1.43, arrival: (NOW - H) * 1000 }, NOW).reason, /milliseconds/);
  assert.match(ps.validateVisit({ lat: 52.95, lon: -1.43, arrival: NOW + H }, NOW).reason, /future/);
  assert.match(ps.validateVisit({ lat: 52.95, lon: -1.43, arrival: NOW, departure: NOW - 60 }, NOW).reason, /before arrival/);
  assert.match(ps.validateVisit({ lat: 0, lon: 0, arrival: NOW - H }, NOW).reason, /null island/);
});

test('the two deliveries of one visit share a key; a departure-only visit has its own', () => {
  assert.equal(ps.visitKey({ arrival: 100, departure: null }), ps.visitKey({ arrival: 100, departure: 900 }));
  assert.equal(ps.visitKey({ arrival: null, departure: 900 }), 'd:900');
});

test('mergeVisitSpans: a one-point stay becomes a stay once its visit closes', () => {
  const clusters = [{ lat: OFFICE.lat, lon: OFFICE.lng, fromTst: NOW - 4 * H, toTst: NOW - 4 * H, points: 1 }];
  const visits = [{ lat: OFFICE.lat, lon: OFFICE.lng, arrival: NOW - 4 * H, departure: NOW - H }];
  const spans = ps.mergeVisitSpans(clusters, visits);
  assert.equal(spans.length, 1);
  assert.deepEqual([spans[0].fromTst, spans[0].toTst, spans[0].basis], [NOW - 4 * H, NOW - H, 'visit']);
  // Without the visit, the same cluster is no stay at all — the bug this fixes.
  assert.equal(ps.mergeVisitSpans(clusters, []).length, 0);
});

test('mergeVisitSpans keeps a real cluster\'s arrival (history dedupes on it) and extends its departure', () => {
  const clusters = [{ lat: OFFICE.lat, lon: OFFICE.lng, fromTst: NOW - 4 * H, toTst: NOW - 3 * H, points: 5 }];
  const visits = [{ lat: OFFICE.lat, lon: OFFICE.lng, arrival: NOW - 4 * H - 300, departure: NOW - H }];
  const [s] = ps.mergeVisitSpans(clusters, visits);
  assert.equal(s.fromTst, NOW - 4 * H, 'arrival is the cluster\'s, not moved');
  assert.equal(s.toTst, NOW - H);
});

test('an OPEN visit never becomes a stay with a made-up end; a far-away visit does not match', () => {
  const clusters = [{ lat: OFFICE.lat, lon: OFFICE.lng, fromTst: NOW - 2 * H, toTst: NOW - 2 * H, points: 1 }];
  assert.equal(ps.mergeVisitSpans(clusters, [{ lat: OFFICE.lat, lon: OFFICE.lng, arrival: NOW - 2 * H, departure: null }]).length, 0);
  const far = ps.mergeVisitSpans(clusters, [{ lat: GYM.lat, lon: GYM.lng, arrival: NOW - 2 * H, departure: NOW - H }]);
  assert.equal(far.length, 1, 'the gym visit stands on its own');
  assert.equal(far[0].lat, GYM.lat);
});

test('currentStay: open visit is current; missed departure ages out; a later far fix ends it', () => {
  const open = { lat: OFFICE.lat, lon: OFFICE.lng, arrival: NOW - 2 * H, departure: null };
  const r = ps.currentStay({ visits: [open], places: [OFFICE], nowSeconds: NOW });
  assert.equal(r.known, true);
  assert.equal(r.stay.place, 'Office');
  assert.equal(r.stay.minutes, 120);

  const old = { ...open, arrival: NOW - 30 * H };
  assert.equal(ps.currentStay({ visits: [old], nowSeconds: NOW }).stay, null);

  const moved = ps.currentStay({ visits: [open], points: [{ lat: GYM.lat, lon: GYM.lng, tst: NOW - H }], nowSeconds: NOW });
  assert.equal(moved.stay, null);

  assert.equal(ps.currentStay({ visits: [], nowSeconds: NOW }).known, false, 'no visit ever is not "not mid-visit"');
  assert.equal(ps.currentStay({ visits: [{ ...open, departure: NOW - H }], nowSeconds: NOW }).stay, null);
});

// ── geofences ────────────────────────────────────────────────────────────────

test('monitorablePlaces caps at 20 and SAYS how many were left out; radius is clamped and reported', () => {
  const many = Array.from({ length: 23 }, (_, i) => ({ name: `P${String(i).padStart(2, '0')}`, lat: 52 + i / 100, lng: -1 }));
  const m = ps.monitorablePlaces(many);
  assert.equal(m.places.length, 20);
  assert.equal(m.truncated, 3);
  const c = ps.monitorablePlaces([{ name: 'Tiny', lat: 52, lng: -1, radius: 20 }]).places[0];
  assert.equal(c.radius, ps.MIN_RADIUS_M);
  assert.equal(c.radiusClamped, 20);
});

test('validateRegionEvents refuses an unsaved place by name and canonicalises the spelling', () => {
  const v = ps.validateRegionEvents({
    deviceId: 'd', placeNames: ['Office'], nowSeconds: NOW,
    events: [{ place: 'office', kind: 'enter', tst: NOW - H }, { place: 'Narnia', kind: 'enter', tst: NOW - H }, { place: 'Office', kind: 'teleport', tst: NOW }],
  });
  assert.equal(v.accepted.length, 1);
  assert.equal(v.accepted[0].place, 'Office');
  assert.equal(v.rejectedReasons['not a saved place'], 1);
  assert.equal(v.rejected, 2);
});

test('currentPlace: inside / outside / stale / never-said are four different answers', () => {
  const places = [OFFICE, GYM];
  const inside = ps.currentPlace({ places, nowSeconds: NOW, events: [{ place: 'Office', kind: 'enter', tst: NOW - 2 * H }, { place: 'Office', kind: 'inside', tst: NOW - 10 * 60 }] });
  assert.equal(inside.known, true);
  assert.equal(inside.place.name, 'Office');
  assert.equal(inside.sinceExact, true);
  assert.equal(inside.since, new Date((NOW - 2 * H) * 1000).toISOString(), 'since is the enter, not the refresh');

  const out = ps.currentPlace({ places, nowSeconds: NOW, events: [{ place: 'Office', kind: 'enter', tst: NOW - 3 * H }, { place: 'Office', kind: 'exit', tst: NOW - H }] });
  assert.deepEqual([out.known, out.place], [true, null]);

  const stale = ps.currentPlace({ places, nowSeconds: NOW, events: [{ place: 'Office', kind: 'inside', tst: NOW - 20 * H }] });
  assert.equal(stale.known, false, 'an old "inside" is not where he is now');
  assert.match(stale.why, /stopped confirming/);

  assert.equal(ps.currentPlace({ places, nowSeconds: NOW, events: [] }).known, false);
});

test('a determination on registration is "inside" but its arrival is not exact', () => {
  const r = ps.currentPlace({ places: [OFFICE], nowSeconds: NOW, events: [{ place: 'Office', kind: 'inside', tst: NOW - H }] });
  assert.equal(r.sinceExact, false);
});

test('overlapping places: the smaller (more specific) one wins', () => {
  const campus = { name: 'Campus', lat: OFFICE.lat, lng: OFFICE.lng, radius: 1500 };
  const r = ps.currentPlace({ places: [campus, OFFICE], nowSeconds: NOW, events: [
    { place: 'Campus', kind: 'enter', tst: NOW - 2 * H }, { place: 'Office', kind: 'enter', tst: NOW - H },
  ] });
  assert.equal(r.place.name, 'Office');
});

// ── consumers ────────────────────────────────────────────────────────────────

test('life-state: the geofence names WORK, sits under the room sensor, over the HA zone', () => {
  const region = { known: true, place: { name: 'Office', kind: 'work' } };
  assert.deepEqual(lifeState.placeFor({ region, phone: { zone: 'not_home' } }), { kind: 'work', label: 'Office', basis: 'phone geofence' });
  // A name matching the work zones counts even without a kind.
  assert.equal(lifeState.placeFor({ region: { known: true, place: { name: 'Office', kind: null } } }).kind, 'work');
  assert.equal(lifeState.placeFor({ region: { known: true, place: { name: 'Gym', kind: null } } }).kind, 'elsewhere');
  // ...and a kind-less "Home" is home — the live saved place has no kind, and
  // reading it as elsewhere told him he was out while he was in bed.
  assert.equal(lifeState.placeFor({ region: { known: true, place: { name: 'Home', kind: null } } }).kind, 'home');
  // An explicit non-home kind still wins over the name.
  assert.equal(lifeState.placeFor({ region: { known: true, place: { name: 'Home', kind: 'other' } } }).kind, 'elsewhere');
  // The room sensor still wins.
  assert.equal(lifeState.placeFor({ room: { known: true, room: 'study' }, region }).basis, 'watch room sensor');
  // An unknown geofence changes nothing.
  assert.equal(lifeState.placeFor({ region: { known: false }, phone: { zone: 'home' } }).basis, 'phone zone');
});

test('Phone row: apps live + Companion stale is live, and says what is lost', () => {
  const r = signals.phoneRow({ state: 'stale', ageMinutes: 600 }, { state: 'live', ageMinutes: 20, basis: 'source-health' });
  assert.equal(r.state, 'live');
  assert.match(r.why, /zone, Wi-Fi name and CarPlay/);
  assert.match(r.detail, /phone apps: live/);
  assert.match(r.detail, /Home Assistant: stale/);
});

test('Phone row: no app ever heard from leaves the Companion verdict exactly as it was', () => {
  const companion = { state: 'stale', ageMinutes: 600, detail: 'nicks_iphone' };
  assert.deepEqual(signals.phoneRow(companion, null), companion);
  // Both live: the Companion row stands, with the apps named beside it.
  const both = signals.phoneRow({ state: 'live', ageMinutes: 5, detail: 'nicks_iphone' }, { state: 'live', ageMinutes: 30 });
  assert.equal(both.state, 'live');
  assert.equal(both.why, undefined);
  assert.match(both.detail, /^nicks_iphone · phone apps: live/);
});
