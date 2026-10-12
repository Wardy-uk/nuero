'use strict';

/**
 * Car journeys, detected from Life360 and APPROVED by Nick (12 Oct 2026). PURE.
 *
 * Detection proposes; Nick decides. A detected journey is `pending` and counts
 * for nothing until he approves it. An approved journey is NEVER an odometer
 * reading (Build 27's rule stands: distance travelled is not what the dashboard
 * says). It feeds a running ESTIMATE only: the last trustworthy odometer
 * reading + the approved journeys since it. The next real reading reconciles,
 * and the gap is shown rather than hidden.
 *
 * Measured on Life360 (2–12 Oct 2026) before choosing anything:
 *   · fixes arrive every 5–45 s while driving, so straight-line legs follow the
 *     road closely (the commute measures 20.9–21.4 mi every time);
 *   · its `driving` flag stays on in car parks, so it is never trusted alone —
 *     movement is judged on the tracker's reported speed or the geometry;
 *   · walks and parked jitter produce 0–3 mi "journeys" at walking pace, hence
 *     the minimum distance and peak-speed filters.
 */

const MILE_M = 1609.344;

// Thresholds — NEURO's, stated, chosen against the measured data above.
const MOVING_KMH = 15;             // a fix (or the leg into it) at or above this is moving
const STOP_GAP_MS = 6 * 60000;     // no moving fix for 6 min ends a journey (traffic waits are shorter)
const ATTACH_MS = 10 * 60000;      // the fix just before/after a journey is its start/end only within 10 min
const MIN_MILES = 0.5;             // shorter is not a car journey worth asking about
const MIN_PEAK_KMH = 30;           // a journey that never reached 30 km/h was on foot or a bike
const JITTER_M = 25;               // a slow leg shorter than this is GPS noise, not distance
const MAX_LEG_KMH = 220;           // faster than this is a bad fix, not driving
const MAX_ACCURACY_M = 200;        // a fix wider than this cannot say where the car was

function haversineM(a, b) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat);
  const dLon = toR(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * HA history rows for one Life360 tracker → fixes, sorted, one per instant.
 * The time is Life360's own `last_seen` (when the phone reported), not when HA
 * noticed. Life360 reports speed in km/h on this (metric) HA.
 */
function fixesFromHistory(rows = []) {
  const out = [];
  for (const r of rows) {
    const a = r && r.attributes;
    if (!a) continue;
    const lat = Number(a.latitude);
    const lon = Number(a.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const acc = Number(a.gps_accuracy);
    if (Number.isFinite(acc) && acc > MAX_ACCURACY_M) continue;
    const t = Date.parse(a.last_seen || r.last_updated || r.last_changed || '');
    if (!Number.isFinite(t)) continue;
    const speed = Number(a.speed);
    out.push({
      t, lat, lon,
      accuracyM: Number.isFinite(acc) ? acc : null,
      speedKmh: Number.isFinite(speed) && speed >= 0 ? speed : null,
      // The HA zone it was in. Life360 also sets the state to `driving`, which is not a place.
      place: typeof r.state === 'string' && r.state && !['not_home', 'unknown', 'unavailable', 'driving'].includes(r.state) ? r.state : null,
    });
  }
  out.sort((x, y) => x.t - y.t);
  const dedup = [];
  for (const f of out) if (!dedup.length || dedup[dedup.length - 1].t !== f.t) dedup.push(f);
  return dedup;
}

/**
 * Fixes → journeys. A fix is MOVING when the tracker says ≥ 15 km/h or the leg
 * into it (distance over time) does. A journey runs from the fix before its
 * first moving fix to the fix after its last, and ends after 6 minutes with no
 * movement. `open` = still going at the edge of what was read; it is reported
 * so the caller can wait, and never stored as finished.
 */
function segment(fixes = [], { readEndMs = null } = {}) {
  const n = fixes.length;
  if (!n) return [];
  const legKmh = (i) => {
    if (i === 0) return null;
    const dt = (fixes[i].t - fixes[i - 1].t) / 3600000;
    if (dt <= 0) return null;
    return haversineM(fixes[i - 1], fixes[i]) / 1000 / dt;
  };
  const moving = fixes.map((f, i) => {
    const leg = legKmh(i);
    if (leg != null && leg > MAX_LEG_KMH) return false;
    return (f.speedKmh != null && f.speedKmh >= MOVING_KMH) || (leg != null && leg >= MOVING_KMH && haversineM(fixes[i - 1], f) > JITTER_M);
  });
  // A journey ends only on EVIDENCE of stopping: fixes that saw the car stand
  // still for STOP_GAP. Life360 can go quiet mid-drive; a gap with no fixes
  // is a continuation when the jump across it implies driving speed.
  const stoppedBetween = (a, b) => {
    const still = [];
    for (let k = a + 1; k < b; k++) if (!moving[k]) still.push(k);
    if (still.length) return fixes[still[still.length - 1]].t - fixes[a].t >= STOP_GAP_MS || fixes[b].t - fixes[still[0]].t >= STOP_GAP_MS;
    const dt = fixes[b].t - fixes[a].t;
    if (dt <= STOP_GAP_MS) return false;
    return haversineM(fixes[a], fixes[b]) / 1000 / (dt / 3600000) < MOVING_KMH / 2;
  };
  const runs = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    if (!moving[i]) continue;
    if (cur && !stoppedBetween(cur.last, i)) cur.last = i;
    else { if (cur) runs.push(cur); cur = { first: i, last: i }; }
  }
  if (cur) runs.push(cur);
  const end = readEndMs != null ? readEndMs : fixes[n - 1].t;
  return runs.map((run) => {
    const s = run.first > 0 && fixes[run.first].t - fixes[run.first - 1].t <= ATTACH_MS ? run.first - 1 : run.first;
    const e = run.last < n - 1 && fixes[run.last + 1].t - fixes[run.last].t <= ATTACH_MS && !moving[run.last + 1] ? run.last + 1 : run.last;
    let metres = 0; let gapMs = 0; let peak = 0; let movingMs = 0;
    for (let i = s + 1; i <= e; i++) {
      const d = haversineM(fixes[i - 1], fixes[i]);
      const dt = fixes[i].t - fixes[i - 1].t;
      const kmh = dt > 0 ? d / 1000 / (dt / 3600000) : 0;
      if (kmh > MAX_LEG_KMH) continue;
      if (d < JITTER_M && kmh < 5) continue;
      metres += d;
      if (dt > ATTACH_MS) gapMs += dt;
      if (moving[i]) movingMs += dt;
      peak = Math.max(peak, kmh);
    }
    // The tracker's own speed is the better peak: one bad fix makes a leg read
    // 180 km/h. Geometry stands in only when the tracker reported none.
    let reported = null;
    for (let i = run.first; i <= run.last; i++) if (fixes[i].speedKmh != null) reported = Math.max(reported || 0, fixes[i].speedKmh);
    if (reported != null) peak = reported;
    const startFix = fixes[s];
    const endFix = fixes[e];
    return {
      startedAt: startFix.t, endedAt: endFix.t,
      start: { lat: startFix.lat, lon: startFix.lon, place: startFix.place },
      end: { lat: endFix.lat, lon: endFix.lon, place: endFix.place },
      measuredMiles: round1(metres / MILE_M),
      movingMinutes: Math.round(movingMs / 60000),
      peakKmh: Math.round(peak),
      fixCount: e - s + 1,
      gapMinutes: Math.round(gapMs / 60000),
      open: end - fixes[run.last].t < STOP_GAP_MS,
    };
  });
}

/** Is this a journey worth asking Nick about? PURE. Returns null or the reason it is not. */
function rejectReason(j) {
  if (j.measuredMiles < MIN_MILES) return 'too-short';
  if (j.peakKmh < MIN_PEAK_KMH) return 'too-slow';
  return null;
}

/**
 * When an odometer reading was TAKEN, as an instant. A reading entered on the
 * day it is dated was taken no later than the moment it was entered; one dated
 * earlier has no time, so the end of its day is used (journeys that day are
 * then not added on top — the estimate errs low, never double-counts).
 */
function readingMoment(reading, { endOfLocalDay }) {
  const entered = reading && reading.provenance && Date.parse(reading.provenance.enteredAt || '');
  if (Number.isFinite(entered) && endOfLocalDay(entered) === endOfLocalDay(reading.observedMs)) return entered;
  return endOfLocalDay(reading.observedMs);
}

/**
 * The running estimate. PURE.
 *   current   vehicle.currentMileage() output, with observedMs + provenance
 *   journeys  [{ status, startedAt, miles }]
 * basis 'odometer' = no approved journey since the reading; 'journeys' = the
 * reading plus approved journeys. Pending miles are reported, never added.
 */
function estimate(current, journeys = [], { endOfLocalDay }) {
  if (!current) return null;
  const since = readingMoment(current, { endOfLocalDay });
  const after = journeys.filter((j) => j.startedAt >= since);
  const approved = after.filter((j) => j.status === 'approved');
  const pending = after.filter((j) => j.status === 'pending');
  const approvedMiles = round1(approved.reduce((s, j) => s + Number(j.miles || 0), 0));
  const pendingMiles = round1(pending.reduce((s, j) => s + Number(j.miles != null ? j.miles : j.measuredMiles || 0), 0));
  return {
    miles: Math.round(current.miles + approvedMiles),
    basis: approved.length ? 'journeys' : 'odometer',
    base: { miles: current.miles, observedOn: current.observedOn, since },
    approvedMiles, approvedCount: approved.length,
    pendingMiles, pendingCount: pending.length,
    why: approved.length
      ? `${current.miles.toLocaleString('en-GB')} mi read on ${current.observedOn} + ${approvedMiles} mi from ${approved.length} approved journey${approved.length === 1 ? '' : 's'} since — an estimate until the next odometer reading`
      : `the odometer reading on ${current.observedOn}; no approved journey since`,
  };
}

/**
 * How much of what the odometer measured between two readings the approved
 * journeys account for. PURE. Only windows that began after tracking started
 * are judged — before that there was nothing to compare. The shortfall is
 * miles nobody approved: journeys not detected, rejected, or driven by someone
 * else. It is shown, never used to correct anything.
 */
function reconcile(accepted = [], journeys = [], { trackingSince, endOfLocalDay }) {
  if (!Number.isFinite(trackingSince)) return [];
  const out = [];
  for (let i = 1; i < accepted.length; i++) {
    const a = accepted[i - 1];
    const b = accepted[i];
    const from = readingMoment(a, { endOfLocalDay });
    const to = readingMoment(b, { endOfLocalDay });
    if (from < trackingSince || to <= from) continue;
    const inside = journeys.filter((j) => j.status === 'approved' && j.startedAt >= from && j.startedAt < to);
    const journeyMiles = round1(inside.reduce((s, j) => s + Number(j.miles || 0), 0));
    const odometerMiles = b.miles - a.miles;
    out.push({
      from: a.observedOn, to: b.observedOn, odometerMiles, journeyMiles, journeys: inside.length,
      coverage: odometerMiles > 0 ? Math.round((journeyMiles / odometerMiles) * 100) : null,
      unaccounted: round1(odometerMiles - journeyMiles),
    });
  }
  return out.reverse();
}

module.exports = {
  MOVING_KMH, STOP_GAP_MS, ATTACH_MS, MIN_MILES, MIN_PEAK_KMH, MILE_M,
  haversineM, fixesFromHistory, segment, rejectReason, readingMoment, estimate, reconcile,
};
