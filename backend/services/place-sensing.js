'use strict';

/**
 * place-sensing — the phone's own answers to "where is he", kept as what they
 * are rather than flattened into position points (5 Oct 2026).
 *
 * Two feeds from the NEURO iOS app, both CoreLocation:
 *
 *   • VISITS (`CLVisit`) — iOS deciding Nick arrived somewhere and, later, that
 *     he left. The app has always sent each end as an ordinary point, and keeps
 *     doing so, so the existing 200m/20min clustering is unchanged. What a
 *     visit adds is the part a point CANNOT carry: "he is still there". A stay
 *     with only its arrival point is a single-point cluster and is ignored by
 *     the clustering, so three hours at the office was invisible until he left.
 *
 *   • GEOFENCES — region monitoring for the places Nick has saved
 *     (`saved_places`). The phone reports a crossing (enter / exit) and, on each
 *     wake, a determination (inside / outside), because iOS raises no enter for
 *     a region you are already standing in.
 *
 * ⚠ WHAT THIS DOES NOT DO: decide home vs away for SAiM's display lock or the
 * greeter. Those stay on Home Assistant's `person.nick`, which uses the router
 * as well as GPS — the phone's Wi-Fi positioning puts it ~90m out at home, and
 * the app is woken by iOS rarely enough that a lock depending on it would hold
 * a stale answer for hours.
 *
 * ⚠ NO COORDINATES OR PLACE NAMES REACH THE LOG OR THE EVENT SPINE. Visits
 * also arrive as points, so the location source's liveness is already covered
 * by the existing point ingest.
 *
 * Split like `location-points`: validation and judgement are PURE (no DB, no
 * clock, no network); the database is required lazily inside the functions
 * that touch it.
 */

const locationPoints = require('./location-points');

const MAX_VISITS_PER_REQUEST = 200;
const MAX_EVENTS_PER_REQUEST = 200;

/** iOS will monitor at most 20 regions per app. */
const MAX_MONITORED = 20;
/** Below ~100m iOS region monitoring is unreliable; above 2km it is not a place. */
const MIN_RADIUS_M = 100;
const MAX_RADIUS_M = 2000;
const DEFAULT_RADIUS_M = 200;
const PLACE_KINDS = ['home', 'work', 'other'];
const REGION_KINDS = ['enter', 'exit', 'inside', 'outside'];

/**
 * How long an "inside" answer stays believable without being refreshed, in
 * hours. The app re-asks on every wake, so a long day at the office refreshes
 * it; an answer this old means the app has stopped running, and the last thing
 * it said must not stand as where he is now.
 */
const REGION_TRUST_HOURS = 14;

/**
 * An open visit (arrived, not yet left) is only a current stay for this long.
 * iOS can miss a departure entirely; without a bound one missed departure
 * keeps him "at the office" for ever.
 */
const OPEN_VISIT_MAX_HOURS = 24;

/** A later fix this far from the visit means he has left, whatever iOS said. */
const LEFT_IF_FIX_BEYOND_M = 300;

/** Same 200m the clustering uses, so "the same place" means one thing. */
const SAME_PLACE_M = 200;
/** Slack when matching a visit's time span to a cluster's, in seconds. */
const MATCH_SLACK_S = 10 * 60;

function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }
function lower(s) { return typeof s === 'string' ? s.trim().toLowerCase() : ''; }

function distanceMetres(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** A unix-seconds timestamp, by the position feed's rules. null = absent. */
function checkTst(v, nowSeconds, label) {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (!isFiniteNumber(v) || !Number.isInteger(v) || v <= 0) return { ok: false, reason: `${label} must be a positive integer` };
  if (v >= locationPoints.MILLISECONDS_THRESHOLD) return { ok: false, reason: `${label} looks like milliseconds — it must be unix SECONDS` };
  if (nowSeconds != null && v > nowSeconds + locationPoints.MAX_FUTURE_SKEW_SECONDS) return { ok: false, reason: `${label} is in the future` };
  return { ok: true, value: v };
}

// ── Visits ───────────────────────────────────────────────────────────────────

/**
 * Validate one visit. PURE.
 *
 * Shape: `{ lat, lon, arrival, departure, acc? }`, times in unix SECONDS.
 * `departure: null` is a visit still in progress — NOT a missing value to
 * default. At least one end must be known.
 *
 * Coordinates and accuracy go through `location-points.validatePoint`, so a
 * visit and a point cannot disagree about what counts as a fix (Null Island,
 * the 500m accuracy ceiling).
 */
function validateVisit(raw, nowSeconds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'visit must be an object' };
  const a = checkTst(raw.arrival, nowSeconds, 'arrival');
  if (!a.ok) return a;
  const d = checkTst(raw.departure, nowSeconds, 'departure');
  if (!d.ok) return d;
  if (a.value == null && d.value == null) return { ok: false, reason: 'a visit needs an arrival or a departure' };
  if (a.value != null && d.value != null && d.value < a.value) return { ok: false, reason: 'departure is before arrival' };

  const p = locationPoints.validatePoint({
    lat: raw.lat, lon: raw.lon !== undefined ? raw.lon : raw.lng,
    tst: a.value != null ? a.value : d.value, acc: raw.acc,
  }, nowSeconds);
  if (!p.ok) return p;

  return {
    ok: true,
    visit: { lat: p.point.lat, lon: p.point.lon, accuracy: p.point.accuracy, arrival: a.value, departure: d.value },
  };
}

/** Validate a batch of visits. PURE. A bad visit is named, never fatal to the batch. */
function validateVisits({ deviceId, visits, nowSeconds } = {}) {
  if (typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > 200) return { ok: false, reason: 'deviceId is required' };
  if (!Array.isArray(visits)) return { ok: false, reason: 'visits must be an array' };
  if (visits.length > MAX_VISITS_PER_REQUEST) return { ok: false, reason: `too many visits — max ${MAX_VISITS_PER_REQUEST} per request` };
  const accepted = [];
  const rejectedReasons = {};
  let rejected = 0;
  for (const raw of visits) {
    const v = validateVisit(raw, nowSeconds);
    if (v.ok) accepted.push(v.visit);
    else { rejected++; rejectedReasons[v.reason] = (rejectedReasons[v.reason] || 0) + 1; }
  }
  return { ok: true, deviceId: deviceId.trim(), accepted, rejected, rejectedReasons, received: visits.length };
}

/** The identity of a visit across its two deliveries. PURE. */
function visitKey(v) {
  return v.arrival != null ? `a:${v.arrival}` : `d:${v.departure}`;
}

/**
 * Persist validated visits.
 *
 * ⚠ A DEPARTURE IS NEVER UN-LEARNED. The arrival delivery carries no departure
 * and the departure delivery carries one; a replayed arrival arriving after the
 * departure must not reopen a visit that has closed.
 */
function storeVisits(deviceId, accepted) {
  const db = require('../db/database');
  let stored = 0; let updated = 0; let duplicate = 0;
  for (const v of accepted) {
    const key = visitKey(v);
    const existing = db.get('SELECT departure_tst FROM device_visits WHERE device_id = ? AND visit_key = ?', [deviceId, key]);
    if (!existing) {
      db.run(
        `INSERT INTO device_visits (device_id, visit_key, lat, lng, accuracy, arrival_tst, departure_tst)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [deviceId, key, v.lat, v.lon, v.accuracy, v.arrival, v.departure]
      );
      stored++;
    } else if (existing.departure_tst == null && v.departure != null) {
      db.run(
        `UPDATE device_visits SET departure_tst = ?, updated_at = CURRENT_TIMESTAMP
         WHERE device_id = ? AND visit_key = ?`,
        [v.departure, deviceId, key]
      );
      updated++;
    } else {
      duplicate++;
    }
  }
  return { stored, updated, duplicate };
}

/** Visits overlapping a unix-second window, oldest first. Open visits overlap any window after their arrival. */
function visitsBetween(fromTst, toTst) {
  const db = require('../db/database');
  return db.all(
    `SELECT device_id, lat, lng, accuracy, arrival_tst, departure_tst
       FROM device_visits
      WHERE COALESCE(departure_tst, ?) >= ?
        AND COALESCE(arrival_tst, departure_tst) <= ?
      ORDER BY COALESCE(arrival_tst, departure_tst) ASC
      LIMIT 500`,
    [toTst, fromTst, toTst]
  ).map((r) => ({
    deviceId: r.device_id, lat: r.lat, lon: r.lng, accuracy: r.accuracy,
    arrival: r.arrival_tst, departure: r.departure_tst,
  }));
}

/**
 * Fold visits into the clustering's stays. PURE.
 *
 * `clusters` are `[{ lat, lon, fromTst, toTst, points }]` — every cluster,
 * including single-point ones. Returns spans `[{ lat, lon, fromTst, toTst,
 * basis }]` for the caller to apply its own dwell floor to.
 *
 * Rules, each a way this could otherwise go wrong:
 *   1. A cluster with ≥2 points keeps its OWN arrival. The arrival point is
 *      usually the visit's own arrival already (the app sends it as a point),
 *      and `location-history` dedupes recorded stays BY ARRIVAL TIME — moving
 *      the arrival of a stay it has already recorded would record it twice.
 *   2. A closed visit that matches extends the stay to its DEPARTURE, which the
 *      clustering cannot know (nothing fires while he sits still).
 *   3. A single-point cluster matched by a closed visit BECOMES a stay — the
 *      case this exists for: one arrival fix, then hours of silence.
 *   4. A closed visit matching no cluster is a stay on its own.
 *   5. An OPEN visit is never a stay here. A stay has a departure; "still
 *      there" is `currentStay`'s answer, not a dwell with a made-up end.
 */
function mergeVisitSpans(clusters = [], visits = []) {
  const closed = visits.filter((v) => v.arrival != null && v.departure != null);
  const used = new Set();
  const spans = [];

  for (const c of clusters) {
    const match = closed.findIndex((v, i) => !used.has(i)
      && distanceMetres(c.lat, c.lon, v.lat, v.lon) <= SAME_PLACE_M
      && c.fromTst <= v.departure + MATCH_SLACK_S
      && c.toTst >= v.arrival - MATCH_SLACK_S);
    if (match === -1) {
      if (c.points >= 2) spans.push({ lat: c.lat, lon: c.lon, fromTst: c.fromTst, toTst: c.toTst, basis: 'points' });
      continue;
    }
    used.add(match);
    const v = closed[match];
    if (c.points >= 2) {
      spans.push({ lat: c.lat, lon: c.lon, fromTst: c.fromTst, toTst: Math.max(c.toTst, v.departure), basis: 'points+visit' });
    } else {
      spans.push({ lat: v.lat, lon: v.lon, fromTst: v.arrival, toTst: v.departure, basis: 'visit' });
    }
  }

  closed.forEach((v, i) => {
    if (!used.has(i)) spans.push({ lat: v.lat, lon: v.lon, fromTst: v.arrival, toTst: v.departure, basis: 'visit' });
  });

  return spans.sort((a, b) => a.fromTst - b.fromTst);
}

/**
 * Is he still at the place he last arrived at? PURE.
 *
 * Returns `{ known, stay }`. `stay` is null when the newest visit has closed,
 * which is a real answer ("not mid-visit"), distinct from `known:false` (no
 * visit has ever arrived, so this feed cannot say).
 *
 * An open visit stops being current when: it is older than
 * OPEN_VISIT_MAX_HOURS (a departure iOS never delivered), or a later fix is
 * more than LEFT_IF_FIX_BEYOND_M from it (he plainly left).
 */
function currentStay({ visits = [], points = [], places = [], nowSeconds } = {}) {
  if (!visits.length) return { known: false, why: 'the phone has not reported a visit', stay: null };
  const newest = [...visits].sort((a, b) => (a.arrival || a.departure) - (b.arrival || b.departure)).pop();
  if (newest.departure != null || newest.arrival == null) return { known: true, stay: null };
  if (nowSeconds != null && nowSeconds - newest.arrival > OPEN_VISIT_MAX_HOURS * 3600) {
    return { known: true, stay: null, why: 'the last visit never closed and is too old to still be true' };
  }
  const movedAway = points.some((p) => p.tst > newest.arrival
    && distanceMetres(p.lat, p.lon, newest.lat, newest.lon) > LEFT_IF_FIX_BEYOND_M);
  if (movedAway) return { known: true, stay: null, why: 'a later fix is away from where the visit started' };

  const place = placeAt(places, newest.lat, newest.lon);
  return {
    known: true,
    stay: {
      arrivedAt: new Date(newest.arrival * 1000).toISOString(),
      minutes: nowSeconds != null ? Math.max(0, Math.round((nowSeconds - newest.arrival) / 60)) : null,
      lat: newest.lat, lon: newest.lon,
      place: place ? place.name : null,
      placeKind: place ? place.kind || null : null,
    },
  };
}

// ── Saved places and geofences ───────────────────────────────────────────────

/** The smallest saved place containing a coordinate, or null. PURE. */
function placeAt(places, lat, lng) {
  let best = null;
  for (const p of places || []) {
    if (!isFiniteNumber(p.lat) || !isFiniteNumber(p.lng)) continue;
    const r = isFiniteNumber(p.radius) ? p.radius : DEFAULT_RADIUS_M;
    if (distanceMetres(lat, lng, p.lat, p.lng) <= r && (!best || r < best.r)) best = { ...p, r };
  }
  return best;
}

/**
 * The places the phone should geofence. PURE.
 *
 * ⚠ CAPPED AT 20 AND SAYS SO — iOS refuses the 21st region silently, so
 * offering more would mean a place that is never monitored while looking as if
 * it is. Sorted by name so the same 20 are chosen every time; a radius is
 * clamped into what iOS can actually monitor and the clamp is reported.
 */
function monitorablePlaces(places = []) {
  const valid = (places || [])
    .filter((p) => p && typeof p.name === 'string' && p.name.trim() && isFiniteNumber(p.lat) && isFiniteNumber(p.lng))
    .map((p) => {
      const asked = isFiniteNumber(p.radius) ? p.radius : DEFAULT_RADIUS_M;
      const radius = Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, asked));
      return {
        name: p.name.trim(), lat: p.lat, lng: p.lng, radius,
        kind: PLACE_KINDS.includes(p.kind) ? p.kind : null,
        ...(radius !== asked ? { radiusClamped: asked } : {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { places: valid.slice(0, MAX_MONITORED), truncated: Math.max(0, valid.length - MAX_MONITORED), max: MAX_MONITORED };
}

/**
 * Validate a batch of geofence events against the places that exist. PURE.
 *
 * A place that is not saved is refused BY NAME rather than stored: an event
 * about a place NEURO cannot describe is one no reader can use, and it would
 * otherwise sit there telling `currentPlace` he is somewhere that no longer
 * exists. The name is canonicalised to the saved spelling.
 */
function validateRegionEvents({ deviceId, events, placeNames = [], nowSeconds } = {}) {
  if (typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > 200) return { ok: false, reason: 'deviceId is required' };
  if (!Array.isArray(events)) return { ok: false, reason: 'events must be an array' };
  if (events.length > MAX_EVENTS_PER_REQUEST) return { ok: false, reason: `too many events — max ${MAX_EVENTS_PER_REQUEST} per request` };
  const byLower = new Map(placeNames.map((n) => [lower(n), n]));
  const accepted = [];
  const rejectedReasons = {};
  let rejected = 0;
  const reject = (reason) => { rejected++; rejectedReasons[reason] = (rejectedReasons[reason] || 0) + 1; };
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') { reject('event must be an object'); continue; }
    const name = byLower.get(lower(raw.place));
    if (!name) { reject('not a saved place'); continue; }
    if (!REGION_KINDS.includes(raw.kind)) { reject(`kind must be one of ${REGION_KINDS.join(', ')}`); continue; }
    const t = checkTst(raw.tst, nowSeconds, 'tst');
    if (!t.ok || t.value == null) { reject(t.ok ? 'tst is required' : t.reason); continue; }
    accepted.push({ place: name, kind: raw.kind, tst: t.value });
  }
  return { ok: true, deviceId: deviceId.trim(), accepted, rejected, rejectedReasons, received: events.length };
}

function storeRegionEvents(deviceId, accepted) {
  const db = require('../db/database');
  let stored = 0;
  for (const e of accepted) {
    stored += db.run(
      'INSERT OR IGNORE INTO place_region_events (device_id, place, kind, tst) VALUES (?, ?, ?, ?)',
      [deviceId, e.place, e.kind, e.tst]
    ).changes;
  }
  return { stored, duplicate: accepted.length - stored };
}

/**
 * Each saved place's state from its events. PURE.
 *
 *   inside   the newest answer is enter/inside and recent enough to believe
 *   outside  the newest answer is exit/outside
 *   stale    the newest answer is "inside" but too old (the app stopped running)
 *   unknown  the phone has never said anything about this place
 *
 * `since` is when the current inside run began; `sinceExact` is false when the
 * run began with a determination rather than a crossing (registered while
 * already there, so the real arrival is earlier than NEURO can see).
 */
function regionStates({ events = [], places = [], nowSeconds } = {}) {
  return (places || []).map((p) => {
    const mine = events.filter((e) => lower(e.place) === lower(p.name)).sort((a, b) => a.tst - b.tst);
    if (!mine.length) return { place: p.name, kind: p.kind || null, state: 'unknown', since: null, lastAt: null };
    const last = mine[mine.length - 1];
    const lastAt = new Date(last.tst * 1000).toISOString();
    if (last.kind === 'exit' || last.kind === 'outside') {
      return { place: p.name, kind: p.kind || null, state: 'outside', since: null, lastAt };
    }
    let i = mine.length - 1;
    while (i > 0 && (mine[i - 1].kind === 'enter' || mine[i - 1].kind === 'inside')) i--;
    const start = mine[i];
    const stale = nowSeconds != null && nowSeconds - last.tst > REGION_TRUST_HOURS * 3600;
    return {
      place: p.name, kind: p.kind || null,
      state: stale ? 'stale' : 'inside',
      since: new Date(start.tst * 1000).toISOString(),
      sinceExact: start.kind === 'enter',
      lastAt,
      radius: isFiniteNumber(p.radius) ? p.radius : DEFAULT_RADIUS_M,
    };
  });
}

/**
 * The saved place he is in right now, according to the phone. PURE.
 *
 * `known:false` when nothing believable has been said about ANY place — "the
 * geofences cannot tell" — kept apart from `known:true, place:null`, which is
 * the phone positively saying he is in none of them. Overlapping places: the
 * smallest wins, as the most specific answer.
 */
function currentPlace({ events = [], places = [], nowSeconds } = {}) {
  const states = regionStates({ events, places, nowSeconds });
  const inside = states.filter((s) => s.state === 'inside').sort((a, b) => a.radius - b.radius);
  if (inside.length) {
    const s = inside[0];
    return { known: true, place: { name: s.place, kind: s.kind }, since: s.since, sinceExact: s.sinceExact, basis: 'phone geofence', states };
  }
  const answered = states.some((s) => s.state === 'outside');
  if (answered) return { known: true, place: null, basis: 'phone geofence', states };
  return {
    known: false, place: null, states,
    why: states.some((s) => s.state === 'stale') ? 'the phone stopped confirming where it is' : 'the phone has not reported any saved place',
  };
}

// ── Reading the stores ───────────────────────────────────────────────────────

/** Saved places, as stored. An unreadable store is `ok:false`, never an empty list. */
function savedPlaces() {
  try {
    const raw = require('../db/database').getState('saved_places');
    const places = raw ? JSON.parse(raw) : [];
    return { ok: true, places: Array.isArray(places) ? places : [] };
  } catch (e) {
    return { ok: false, places: [], why: e.message };
  }
}

function regionEventsSince(fromTst) {
  return require('../db/database').all(
    'SELECT place, kind, tst FROM place_region_events WHERE tst >= ? ORDER BY tst ASC LIMIT 5000',
    [fromTst]
  );
}

/** Where the geofences say he is now. Never throws. */
function readCurrentPlace(now = new Date()) {
  try {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const saved = savedPlaces();
    if (!saved.ok) return { known: false, place: null, why: `could not read saved places: ${saved.why}` };
    if (!saved.places.length) return { known: false, place: null, why: 'no saved places to geofence' };
    // Seven days is ample: the app re-confirms on every wake, so anything that
    // matters is far more recent than this, and an old exit still counts.
    const events = regionEventsSince(nowSeconds - 7 * 86400);
    return currentPlace({ events, places: saved.places, nowSeconds });
  } catch (e) {
    return { known: false, place: null, why: e.message };
  }
}

/** Is he mid-visit, and where. Never throws. */
function readCurrentStay(now = new Date()) {
  try {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const from = nowSeconds - OPEN_VISIT_MAX_HOURS * 3600;
    const visits = visitsBetween(from, nowSeconds);
    const points = locationPoints.pointsBetween(from, nowSeconds);
    return currentStay({ visits, points, places: savedPlaces().places, nowSeconds });
  } catch (e) {
    return { known: false, stay: null, why: e.message };
  }
}

// ── Build 18T: visits and geofences as CAPABILITIES of location.neuro-ios ──
//
// ⚠ THE CHOSEN MODEL: child capabilities, NOT sources of their own. A visit or
// a geofence event arrives through the same app, the same durable queue and
// the same POST as a location fix — they cannot go blind separately from it,
// so a second SourceHealth row would only be a second opinion about one
// transport. Liveness stays location.neuro-ios's, judged as before.
//
// ⚠ AND THEREFORE THEY ARE NEVER STALE. "No visit since Tuesday" is what a
// week at home looks like; it says nothing about whether the capability works.
// What a capability CAN say is whether it has ever been PROVEN (an event
// arrived), whether the build behind it HAS it, and whether its parent
// transport is alive. Frequency is never a verdict.
//
//   unavailable   the reported build lacks the capability (definite)
//   unproven      never seen an event — build unknown, or has it but no event yet
//   proven-quiet  an event has arrived before; nothing recent; parent alive
//   proven        an event arrived recently
//   parent-stale  proven once, but location.neuro-ios itself has gone stale —
//                 the PARENT's verdict owns that, this only points at it
const CAPABILITY_RECENT_MS = 7 * 86400000;

/** PURE. One place capability's state. */
function placeCapabilityState({ capability, build = null, lastEventAt = null, parentVerdict = null, now = Date.now() } = {}) {
  const has = build ? (build.capabilities || []).includes(capability) : null;
  if (build && !has) return { state: 'unavailable', line: `The installed build cannot send ${capability === 'geofence' ? 'geofence events' : 'visits'}.` };
  if (!lastEventAt) {
    return { state: 'unproven', line: has
      ? `The build has it; no ${capability === 'geofence' ? 'geofence event' : 'visit'} has arrived yet — not proven.`
      : `No ${capability === 'geofence' ? 'geofence event' : 'visit'} has ever arrived, and the build is unknown — not proven.` };
  }
  if (parentVerdict === 'stale' || parentVerdict === 'failing') {
    return { state: 'parent-stale', line: 'Location itself has gone stale, so nothing new can arrive — see the location source.' };
  }
  const age = now - Date.parse(lastEventAt);
  if (Number.isFinite(age) && age <= CAPABILITY_RECENT_MS) return { state: 'proven', line: `Last one ${String(lastEventAt).slice(0, 16).replace('T', ' ')}.` };
  return { state: 'proven-quiet', line: `Proven before (last ${String(lastEventAt).slice(0, 10)}); nothing recent — quiet is normal, not a fault.` };
}

/** Reader: both capabilities, from what is stored. Never throws. */
function placeCapabilities({ build = null, parentVerdict = null, now = Date.now() } = {}) {
  const db = require('../db/database');
  let lastVisit = null; let lastRegion = null;
  try { const r = db.get('SELECT MAX(received_at) AS at FROM device_visits'); lastVisit = r && r.at ? `${String(r.at).replace(' ', 'T')}${/Z$/.test(r.at) ? '' : 'Z'}` : null; } catch { /* unread */ }
  try { const r = db.get('SELECT MAX(received_at) AS at FROM place_region_events'); lastRegion = r && r.at ? `${String(r.at).replace(' ', 'T')}${/Z$/.test(r.at) ? '' : 'Z'}` : null; } catch { /* unread */ }
  return {
    parent: 'location.neuro-ios',
    visits: { capability: 'place-visits', lastEventAt: lastVisit, ...placeCapabilityState({ capability: 'place-visits', build, lastEventAt: lastVisit, parentVerdict, now }) },
    geofence: { capability: 'geofence', lastEventAt: lastRegion, ...placeCapabilityState({ capability: 'geofence', build, lastEventAt: lastRegion, parentVerdict, now }) },
  };
}

module.exports = {
  placeCapabilityState,
  placeCapabilities,
  CAPABILITY_RECENT_MS,
  MAX_VISITS_PER_REQUEST,
  MAX_EVENTS_PER_REQUEST,
  MAX_MONITORED,
  MIN_RADIUS_M,
  MAX_RADIUS_M,
  DEFAULT_RADIUS_M,
  PLACE_KINDS,
  REGION_KINDS,
  REGION_TRUST_HOURS,
  OPEN_VISIT_MAX_HOURS,
  LEFT_IF_FIX_BEYOND_M,
  validateVisit,
  validateVisits,
  visitKey,
  storeVisits,
  visitsBetween,
  mergeVisitSpans,
  currentStay,
  placeAt,
  monitorablePlaces,
  validateRegionEvents,
  storeRegionEvents,
  regionStates,
  currentPlace,
  savedPlaces,
  readCurrentPlace,
  readCurrentStay,
};
