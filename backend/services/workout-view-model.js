'use strict';

/**
 * One workout, looked at properly (2 Nov 2026). PURE — no DB, no network, no
 * clock. `workout-view.js` reads; this decides what the numbers are.
 *
 * Input is the watch's own track from `workout_routes`: `[lat, lon, ele|null,
 * unixSeconds]`, already thinned by NeuroKit to roughly one point per 5 m or
 * 30 s. Everything here is derived from those points plus the heart-rate
 * samples Apple Health already sent; nothing is estimated from a model of Nick.
 *
 * ⚠ The watch's OWN distance and ascent (on the workout row) are the headline
 *   figures when present. The track-derived ones are shown beside them and
 *   labelled, never silently swapped in — two honest numbers that differ are
 *   more useful than one that hides which instrument produced it.
 * ⚠ A GPS jump is not distance. A segment implying more than MAX_SPEED_MS is
 *   dropped from distance, splits and moving time, and counted.
 */

const { haversineM } = require('./outdoor-model');

const MAX_SPEED_MS = 50;          // above this a segment is a GPS jump, not travel
const MOVING_SPEED_MS = 0.4;      // ~1.4 km/h — slower than this is stopped
const MAX_MOVING_GAP_S = 300;     // a longer silence is never counted as moving
const ELE_HYSTERESIS_M = 2;       // ascent counts a climb only past this much
const PROFILE_MAX_POINTS = 600;
const HR_BUCKET_S = 30;
const HR_MAX_GAP_S = 120;         // a heart-rate reading stands for at most this long
const PHOTO_TIME_SLACK_S = 300;   // a photo up to 5 min outside the track still pins to its end
const SAME_ROUTE_START_M = 1000;  // only compare walks that started within 1 km
const SAME_ROUTE_RADIUS_M = 150;
const SAME_ROUTE_SHARE = 0.8;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const r1 = (v) => (isNum(v) ? Math.round(v * 10) / 10 : null);
const r5 = (v) => Math.round(v * 1e5) / 1e5;

/** Keep only well-formed points, in time order. */
function cleanPoints(points) {
  if (!Array.isArray(points)) return [];
  return points
    .filter((p) => Array.isArray(p) && isNum(p[0]) && isNum(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180 && isNum(p[3]))
    .map((p) => [p[0], p[1], isNum(p[2]) ? p[2] : null, p[3]])
    .sort((a, b) => a[3] - b[3]);
}

function dist(a, b) { return haversineM({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }); }

/** Every n-th point, always keeping the last. */
function thin(points, max) {
  if (points.length <= max) return points.slice();
  const step = (points.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

/** Elevation smoothed with a 5-point running median (GPS/baro jitter is not climbing). */
function smoothElevation(points) {
  const ele = points.map((p) => p[2]);
  return ele.map((v, i) => {
    if (!isNum(v)) return null;
    const win = ele.slice(Math.max(0, i - 2), i + 3).filter(isNum).sort((a, b) => a - b);
    return win[Math.floor(win.length / 2)];
  });
}

/** Ascent and descent from a (smoothed) elevation series with a hysteresis threshold. */
function climb(eles) {
  let up = 0; let down = 0; let ref = null;
  for (const e of eles) {
    if (!isNum(e)) continue;
    if (ref == null) { ref = e; continue; }
    if (e - ref >= ELE_HYSTERESIS_M) { up += e - ref; ref = e; } else if (ref - e >= ELE_HYSTERESIS_M) { down += ref - e; ref = e; }
  }
  return { ascentM: Math.round(up), descentM: Math.round(down) };
}

/**
 * The walk, measured from its own track. Cumulative distance travels with each
 * point (`cum`), so the profile, splits and the map hover all agree on "where".
 */
function measure(rawPoints) {
  const points = cleanPoints(rawPoints);
  if (points.length < 2) return { known: false, why: points.length ? 'only one GPS point' : 'no GPS points', points };
  const eles = smoothElevation(points);
  const cum = [0];
  let moving = 0; let stopped = 0; let jumps = 0;
  for (let i = 1; i < points.length; i++) {
    const d = dist(points[i - 1], points[i]);
    const dt = points[i][3] - points[i - 1][3];
    const speed = dt > 0 ? d / dt : Infinity;
    if (speed > MAX_SPEED_MS) { jumps++; cum.push(cum[i - 1]); continue; }
    cum.push(cum[i - 1] + d);
    if (speed >= MOVING_SPEED_MS && dt <= MAX_MOVING_GAP_S) moving += dt; else stopped += Math.max(0, dt);
  }
  const distanceM = cum[cum.length - 1];
  const c = climb(eles);
  let hi = null; let lo = null;
  for (let i = 0; i < points.length; i++) {
    if (!isNum(eles[i])) continue;
    if (!hi || eles[i] > hi.ele) hi = { ele: eles[i], i };
    if (!lo || eles[i] < lo.ele) lo = { ele: eles[i], i };
  }
  const lats = points.map((p) => p[0]); const lons = points.map((p) => p[1]);
  const totalS = points[points.length - 1][3] - points[0][3];
  const at = (i) => (i == null ? null : { lat: r5(points[i][0]), lon: r5(points[i][1]), eleM: r1(eles[i]), t: points[i][3], km: r1(cum[i] / 100) / 10 });
  return {
    known: true, points, eles, cum,
    stats: {
      distanceM: Math.round(distanceM),
      totalSeconds: totalS,
      movingSeconds: Math.round(moving),
      stoppedSeconds: Math.round(totalS - moving),
      ascentM: c.ascentM, descentM: c.descentM,
      highest: hi ? at(hi.i) : null, lowest: lo ? at(lo.i) : null,
      movingPaceSecPerKm: distanceM >= 100 && moving > 0 ? Math.round(moving / (distanceM / 1000)) : null,
      avgMovingSpeedKmh: moving > 0 ? r1((distanceM / moving) * 3.6) : null,
      pointCount: points.length, gpsJumpsIgnored: jumps,
      start: at(0), end: at(points.length - 1),
      bounds: [[r5(Math.min(...lats)), r5(Math.min(...lons))], [r5(Math.max(...lats)), r5(Math.max(...lons))]],
      loop: dist(points[0], points[points.length - 1]) <= 250,
    },
  };
}

/** The line drawn on the map. */
function trackLine(m, max = 2500) {
  if (!m.known) return [];
  return thin(m.points, max).map((p) => [r5(p[0]), r5(p[1])]);
}

/** Elevation along distance, each point carrying its place and time for the map hover. */
function elevationProfile(m, max = PROFILE_MAX_POINTS) {
  if (!m.known) return [];
  const idx = thin(m.points.map((_, i) => i), max);
  return idx.map((i) => ({
    km: Math.round(m.cum[i]) / 1000, eleM: r1(m.eles[i]), t: m.points[i][3],
    lat: r5(m.points[i][0]), lon: r5(m.points[i][1]),
  })).filter((p) => p.eleM != null);
}

/** Linear interpolation of time at a cumulative distance. */
function timeAtDistance(m, target) {
  const { cum, points } = m;
  for (let i = 1; i < cum.length; i++) {
    if (cum[i] >= target) {
      const span = cum[i] - cum[i - 1];
      const f = span > 0 ? (target - cum[i - 1]) / span : 0;
      return { t: points[i - 1][3] + f * (points[i][3] - points[i - 1][3]), i };
    }
  }
  return null;
}

/**
 * Per-kilometre splits. The last one is partial and SAYS so — a 400 m tail at a
 * strolling pace is not a slow kilometre.
 */
function splits(m, hrSamples = []) {
  if (!m.known) return [];
  const total = m.cum[m.cum.length - 1];
  const out = [];
  let prevT = m.points[0][3]; let prevI = 0;
  for (let km = 1; km * 1000 <= total + 1e-6 || (km - 1) * 1000 < total; km++) {
    const end = Math.min(km * 1000, total);
    const hit = end >= total ? { t: m.points[m.points.length - 1][3], i: m.points.length - 1 } : timeAtDistance(m, end);
    if (!hit) break;
    const lenM = end - (km - 1) * 1000;
    if (lenM < 50) break;
    const secs = hit.t - prevT;
    const c = climb(m.eles.slice(prevI, hit.i + 1));
    const hr = hrSamples.filter((s) => s.t >= prevT && s.t <= hit.t).map((s) => s.bpm);
    out.push({
      km, lengthM: Math.round(lenM), partial: lenM < 999,
      seconds: Math.round(secs),
      paceSecPerKm: lenM > 0 ? Math.round(secs / (lenM / 1000)) : null,
      ascentM: c.ascentM, descentM: c.descentM,
      avgHr: hr.length ? Math.round(hr.reduce((a, b) => a + b, 0) / hr.length) : null,
    });
    prevT = hit.t; prevI = hit.i;
    if (end >= total) break;
  }
  return out;
}

/**
 * Heart rate across the workout. `samples` are `{t: unixSeconds, bpm}`.
 * Each reading stands for the time until the next one, capped at HR_MAX_GAP_S —
 * exertion.js's rule, because the watch samples faster when he works harder and
 * counting readings would measure the sampling rate, not the effort.
 */
function heartRate(samples, { startT, endT, max = null } = {}) {
  const s = (samples || []).filter((x) => isNum(x.t) && isNum(x.bpm) && x.bpm > 20 && x.bpm < 250)
    .filter((x) => (startT == null || x.t >= startT) && (endT == null || x.t <= endT))
    .sort((a, b) => a.t - b.t);
  if (!s.length) return { known: false, why: 'no heart-rate samples during this workout' };
  let wSum = 0; let wBpm = 0;
  const bands = [0, 0, 0, 0, 0];
  const cut = isNum(max) && max > 100 ? [0.6, 0.7, 0.8, 0.9].map((f) => f * max) : null;
  for (let i = 0; i < s.length; i++) {
    const next = i + 1 < s.length ? s[i + 1].t : (endT ?? s[i].t);
    const w = Math.max(1, Math.min(HR_MAX_GAP_S, next - s[i].t));
    wSum += w; wBpm += w * s[i].bpm;
    if (cut) { let b = 0; for (const c of cut) if (s[i].bpm >= c) b++; bands[b] += w; }
  }
  const buckets = new Map();
  for (const x of s) {
    const k = Math.floor(x.t / HR_BUCKET_S) * HR_BUCKET_S;
    const b = buckets.get(k) || { n: 0, sum: 0 };
    b.n++; b.sum += x.bpm; buckets.set(k, b);
  }
  const series = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([t, b]) => ({ t, bpm: Math.round(b.sum / b.n) }));
  const peak = s.reduce((a, b) => (b.bpm > a.bpm ? b : a));
  return {
    known: true, samples: s.length,
    avg: Math.round(wBpm / wSum), max: peak.bpm, maxAt: peak.t,
    min: Math.min(...s.map((x) => x.bpm)),
    series,
    bands: cut ? {
      basis: `share of your max heart rate (${Math.round(max)} bpm)`,
      rows: [
        { label: 'Under 60%', toBpm: Math.round(cut[0]) },
        { label: '60–70%', fromBpm: Math.round(cut[0]), toBpm: Math.round(cut[1]) },
        { label: '70–80%', fromBpm: Math.round(cut[1]), toBpm: Math.round(cut[2]) },
        { label: '80–90%', fromBpm: Math.round(cut[2]), toBpm: Math.round(cut[3]) },
        { label: '90% and over', fromBpm: Math.round(cut[3]) },
      ].map((r, i) => ({ ...r, minutes: Math.round(bands[i] / 6) / 10 })),
    } : null,
  };
}

/**
 * Where on the track a photo belongs. Its own GPS when it has one; otherwise the
 * track's position at the moment it was taken, flagged as placed by time.
 */
function placePhoto(photo, m) {
  if (isNum(photo.lat) && isNum(photo.lon)) return { lat: r5(photo.lat), lon: r5(photo.lon), placedBy: 'gps' };
  if (!m.known || !isNum(photo.takenT)) return { lat: null, lon: null, placedBy: 'none' };
  const pts = m.points;
  if (photo.takenT < pts[0][3] - PHOTO_TIME_SLACK_S || photo.takenT > pts[pts.length - 1][3] + PHOTO_TIME_SLACK_S) return { lat: null, lon: null, placedBy: 'none' };
  let best = pts[0];
  for (const p of pts) { if (Math.abs(p[3] - photo.takenT) < Math.abs(best[3] - photo.takenT)) best = p; }
  return { lat: r5(best[0]), lon: r5(best[1]), placedBy: 'time' };
}

/**
 * Was this the same route as an earlier walk? Both tracks must start within a
 * km of each other and each follow the other for 80% of its length within 150 m
 * — outdoor-model.matchRoute's geometry rule, applied walk to walk.
 */
function sameRoute(a, b) {
  if (!a.known || !b.known) return { same: false, why: 'one of the walks has no track' };
  if (dist(a.points[0], b.points[0]) > SAME_ROUTE_START_M) return { same: false, why: 'started somewhere else' };
  const pa = thin(a.points, 150); const pb = thin(b.points, 150);
  const near = (p, line) => line.some((q) => dist(p, q) <= SAME_ROUTE_RADIUS_M);
  const along = pa.filter((p) => near(p, pb)).length / pa.length;
  const covered = pb.filter((p) => near(p, pa)).length / pb.length;
  return along >= SAME_ROUTE_SHARE && covered >= SAME_ROUTE_SHARE
    ? { same: true, why: `${Math.round(along * 100)}% of this walk follows it, and it covers ${Math.round(covered * 100)}% of that one` }
    : { same: false, why: `different routes (${Math.round(along * 100)}% / ${Math.round(covered * 100)}%)` };
}

module.exports = {
  MAX_SPEED_MS, MOVING_SPEED_MS, ELE_HYSTERESIS_M, SAME_ROUTE_START_M,
  cleanPoints, thin, measure, trackLine, elevationProfile, splits, heartRate, placePhoto, sameRoute, climb,
};
