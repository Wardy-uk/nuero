'use strict';

/**
 * environment — readings from a carried environmental logger, and the hikes
 * they were taken on.
 *
 * The logger is a Blue Maestro Disc Maxi (temperature, humidity, pressure).
 * The phone downloads its log over Bluetooth and posts it here; nothing here
 * knows about Bluetooth.
 *
 * Two halves, the `location-points` split:
 *   • VALIDATION and MATCHING are pure — no DB, no clock — so the wire contract
 *     and the window join pin without a database.
 *   • Storage and reads live at the bottom, and require the DB LAZILY for the
 *     same reason `location-points.js` gives.
 *
 * ⚠ A READING'S TIME IS RECONSTRUCTED. The logger has no clock; the phone times
 * each record backwards from its download, good to ±half the logging interval.
 * `timing_error_s` travels with every row and every summary, so a consumer
 * can tell a ±30 s series from a ±7.5 min one instead of treating both as exact.
 *
 * ⚠ HIKES ARE MATCHED BY WINDOW, NOT BY ID. A hike is whatever has a start and
 * an end — a HealthKit workout here, an Intervals.icu activity on the website.
 * Readings belong to no hike in storage, so either source can ask "what did the
 * logger see between these two times" and get the same answer.
 */

/** Batch ceiling — matches `EnvironmentReadingBatch.maxReadingsPerRequest`. */
const MAX_READINGS_PER_REQUEST = 1000;
const MILLISECONDS_THRESHOLD = 1e11;
const MAX_FUTURE_SKEW_SECONDS = 300;

/**
 * Physical bounds, from the BME280 the Maxi carries (-40…85 °C, 300…1100 hPa).
 * A value outside them is a decoding fault — a wrong offset or endianness on
 * the phone — and storing it would put a 650 °C afternoon on a hike page.
 */
const BOUNDS = {
  temp: [-40, 85],
  humidity: [0, 100],
  pressure: [300, 1100],
};

/** What counts as a hike when the caller does not say. */
const HIKE_TYPES = ['Hiking', 'Walking'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ── Pure validation ──────────────────────────────────────────────────────────

function validateReading(raw, nowSeconds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'reading must be an object' };
  const { t, tempC, humidityPct, pressureHpa, timingErrorSeconds } = raw;

  if (!isNum(t) || !Number.isInteger(t) || t <= 0) return { ok: false, reason: 't must be a positive integer' };
  if (t >= MILLISECONDS_THRESHOLD) return { ok: false, reason: 't looks like milliseconds — it must be unix SECONDS' };
  if (nowSeconds != null && t > nowSeconds + MAX_FUTURE_SKEW_SECONDS) return { ok: false, reason: 't is in the future' };

  if (!isNum(tempC)) return { ok: false, reason: 'tempC must be a finite number' };
  if (tempC < BOUNDS.temp[0] || tempC > BOUNDS.temp[1]) return { ok: false, reason: 'tempC outside the sensor range' };

  // Absent and out-of-range are different facts: a temperature-only Maxi has no
  // humidity, and that is not a fault.
  if (humidityPct != null) {
    if (!isNum(humidityPct)) return { ok: false, reason: 'humidityPct must be a finite number' };
    if (humidityPct < BOUNDS.humidity[0] || humidityPct > BOUNDS.humidity[1]) return { ok: false, reason: 'humidityPct outside 0–100' };
  }
  if (pressureHpa != null) {
    if (!isNum(pressureHpa)) return { ok: false, reason: 'pressureHpa must be a finite number' };
    if (pressureHpa < BOUNDS.pressure[0] || pressureHpa > BOUNDS.pressure[1]) return { ok: false, reason: 'pressureHpa outside the sensor range' };
  }

  const err = isNum(timingErrorSeconds) && timingErrorSeconds >= 0 ? Math.round(timingErrorSeconds) : 0;
  return {
    ok: true,
    reading: { t, tempC, humidityPct: humidityPct ?? null, pressureHpa: pressureHpa ?? null, timingErrorSeconds: err },
  };
}

/**
 * Validate a batch. PURE. A bad reading does not fail the batch — the logger
 * cannot re-take it — and every rejection is named.
 */
function validateBatch(body = {}, nowSeconds) {
  const { sensorId, model, readings } = body;
  if (typeof sensorId !== 'string' || !sensorId.trim() || sensorId.length > 64) return { ok: false, reason: 'sensorId is required' };
  if (!Array.isArray(readings)) return { ok: false, reason: 'readings must be an array' };
  if (readings.length > MAX_READINGS_PER_REQUEST) return { ok: false, reason: `too many readings — max ${MAX_READINGS_PER_REQUEST} per request` };

  const accepted = [];
  const rejectedReasons = {};
  let rejected = 0;
  for (const raw of readings) {
    const v = validateReading(raw, nowSeconds);
    if (v.ok) accepted.push(v.reading);
    else { rejected++; rejectedReasons[v.reason] = (rejectedReasons[v.reason] || 0) + 1; }
  }
  // The cursor is optional (only the last chunk of a download carries it) and is
  // refused whole if malformed — half a cursor would move NEURO's idea of how far
  // through the log it is to somewhere nobody downloaded.
  let cursor = null;
  if (body.cursor != null) {
    const c = body.cursor;
    if (!c || !Number.isInteger(c.logCount) || c.logCount < 0 || !Number.isInteger(c.intervalSeconds) || c.intervalSeconds <= 0) {
      return { ok: false, reason: 'cursor must carry integer logCount and intervalSeconds' };
    }
    cursor = { logCount: c.logCount, intervalSeconds: c.intervalSeconds };
  }
  const intervalSeconds = Number.isInteger(body.intervalSeconds) && body.intervalSeconds > 0 ? body.intervalSeconds : null;
  return {
    ok: true,
    sensorId: sensorId.trim(),
    model: typeof model === 'string' ? model.slice(0, 64) : null,
    intervalSeconds,
    cursor,
    source: typeof body.source === 'string' ? body.source.slice(0, 32) : null,
    accepted,
    rejected,
    rejectedReasons,
    received: readings.length,
  };
}

// ── Pure derivation ──────────────────────────────────────────────────────────

/** Magnus-Tetens. The Maxi does not send a dew point; it is derived here. */
function dewPoint(tempC, rh) {
  if (!isNum(tempC) || !isNum(rh) || rh <= 0) return null;
  const a = 17.62, b = 243.12;
  const g = Math.log(rh / 100) + (a * tempC) / (b + tempC);
  return (b * g) / (a - g);
}

/** Standard-atmosphere altitude in metres. Only DIFFERENCES are meaningful. */
function pressureAltitude(hpa) {
  return 44330 * (1 - Math.pow(hpa / 1013.25, 1 / 5.255));
}

/**
 * Climb from pressure, with a 3 m hysteresis so sensor noise on the flat does
 * not accumulate into a phantom ascent.
 *
 * ⚠ WEATHER MOVES PRESSURE TOO. A front passing over a four-hour walk can be
 * 3–5 hPa — 25–40 m of "climb" that never happened. This is a second opinion
 * beside the watch's figure, never a replacement for it.
 */
function baroAscent(pressures, hysteresisM = 3) {
  const alts = pressures.filter(isNum).map(pressureAltitude);
  if (alts.length < 2) return null;
  let ascent = 0;
  let ref = alts[0];
  for (const h of alts.slice(1)) {
    if (h - ref >= hysteresisM) { ascent += h - ref; ref = h; }
    else if (ref - h >= hysteresisM) ref = h;
  }
  return Math.round(ascent);
}

const round = (v, dp = 1) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/**
 * Summarise readings (oldest first). PURE. Null when there are none — an empty
 * summary with zeros in it would read as a 0 °C walk.
 */
function summarise(readings) {
  if (!readings || !readings.length) return null;
  const temps = readings.map((r) => r.temperature_c ?? r.tempC);
  const hums = readings.map((r) => r.humidity_pct ?? r.humidityPct).filter(isNum);
  const pres = readings.map((r) => r.pressure_hpa ?? r.pressureHpa).filter(isNum);
  const dews = readings
    .map((r) => dewPoint(r.temperature_c ?? r.tempC, r.humidity_pct ?? r.humidityPct))
    .filter(isNum);
  return {
    readings: readings.length,
    tempMinC: round(Math.min(...temps)),
    tempMaxC: round(Math.max(...temps)),
    tempMeanC: round(mean(temps)),
    humidityMeanPct: round(mean(hums)),
    dewPointMeanC: round(mean(dews)),
    pressureStartHpa: round(pres[0] ?? null),
    pressureEndHpa: round(pres[pres.length - 1] ?? null),
    baroAscentM: baroAscent(pres),
    timingErrorSeconds: Math.max(...readings.map((r) => r.timing_error_s ?? r.timingErrorSeconds ?? 0)),
  };
}

/** SQLite UTC 'YYYY-MM-DD HH:MM:SS' → unix seconds. */
function sqlToSeconds(s) {
  if (typeof s !== 'string') return null;
  const ms = Date.parse(s.replace(' ', 'T') + 'Z');
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** A workout's window in unix seconds, falling back to its duration for the end. */
function workoutWindow(w) {
  const start = sqlToSeconds(w.started_at);
  if (start == null) return null;
  let end = sqlToSeconds(w.ended_at);
  if (end == null && isNum(w.duration_seconds)) end = start + w.duration_seconds;
  if (end == null || end <= start) return null;
  return { start, end };
}

/** How far before a walk to look for the "at home" baseline, in seconds. */
const BASELINE_WINDOW_S = 2 * 3600;

/**
 * Did the logger actually go on the walk? PURE.
 *
 * ⚠ A TIMESTAMP MATCH IS NOT EVIDENCE THE LOGGER WAS CARRIED. It holds months of
 * records, so every walk in that span has readings "inside" it — including every
 * walk it spent on a shelf at 21 °C. Publishing those would put the living room's
 * climate on a hike page as the weather it was walked in. So a walk earns
 * conditions only when the readings show the logger LEFT THE HOUSE:
 *
 *   • it climbed with him: the watch recorded 40 m+ of ascent and pressure agrees
 *     with at least 40% of it; or
 *   • the air changed: temperature 2 °C+ or humidity 10 points+ away from the two
 *     hours before he set off.
 *
 * And it is `not-carried` when the watch climbed and pressure stayed flat. Anything
 * else is `unknown`, which is NOT published — a flat walk on a mild day indoors and
 * out can look the same, and a wrong "we walked in 21 °C" is worse than a gap.
 */
function carriedVerdict(inside, before, workout = {}) {
  if (!inside || inside.length < 2) return { carried: 'unknown', why: 'fewer than two readings during the walk' };
  const temp = (r) => r.temperature_c ?? r.tempC;
  const hum = (r) => r.humidity_pct ?? r.humidityPct;
  const pres = (r) => r.pressure_hpa ?? r.pressureHpa;
  const climbed = isNum(workout.elevation_m) ? workout.elevation_m : null;
  const baro = baroAscent(inside.map(pres));
  if (climbed != null && climbed >= 40 && baro != null) {
    if (baro >= 0.4 * climbed) return { carried: 'likely', why: `pressure shows ~${baro} m of the watch's ${Math.round(climbed)} m climb` };
    if (baro < 0.2 * climbed) return { carried: 'not-carried', why: `the watch climbed ${Math.round(climbed)} m and pressure barely moved` };
  }
  if (before && before.length >= 2) {
    const tShift = Math.abs(mean(inside.map(temp)) - mean(before.map(temp)));
    const hIn = inside.map(hum).filter(isNum);
    const hBefore = before.map(hum).filter(isNum);
    const hShift = hIn.length && hBefore.length ? Math.abs(mean(hIn) - mean(hBefore)) : 0;
    if (tShift >= 2) return { carried: 'likely', why: `${round(tShift)} °C away from the house beforehand` };
    if (hShift >= 10) return { carried: 'likely', why: `humidity ${Math.round(hShift)} points away from the house beforehand` };
  }
  return { carried: 'unknown', why: 'the readings do not show the logger leaving the house' };
}

/**
 * Attach conditions to each workout. PURE — both lists are passed in.
 *
 * `readings` must be sorted by `t`. A reading belongs to a workout when its
 * reconstructed time falls inside the window; the timing error is REPORTED,
 * not used to widen the window, so a short walk is not padded with readings
 * taken in the car.
 */
function matchWorkouts(workouts, readings, { includeSeries = false } = {}) {
  return workouts.map((w) => {
    const win = workoutWindow(w);
    const base = {
      id: w.source_uuid || String(w.id),
      activityType: w.activity_type,
      startedAt: w.started_at,
      endedAt: w.ended_at,
      durationSeconds: w.duration_seconds,
      distanceM: w.distance_m,
      elevationM: w.elevation_m,
    };
    if (!win) return { ...base, conditions: null, why: 'the workout has no usable start and end' };
    const inside = readings.filter((r) => r.t >= win.start && r.t <= win.end);
    if (!inside.length) return { ...base, conditions: null, carried: 'unknown', why: 'no logger readings fall inside this walk' };
    const before = readings.filter((r) => r.t >= win.start - BASELINE_WINDOW_S && r.t < win.start);
    const verdict = carriedVerdict(inside, before, w);
    return {
      ...base,
      conditions: summarise(inside),
      carried: verdict.carried,
      carriedWhy: verdict.why,
      why: null,
      window: win,
      series: includeSeries ? inside.map((r) => ({
        t: r.t, tempC: r.temperature_c, humidityPct: r.humidity_pct, pressureHpa: r.pressure_hpa,
      })) : undefined,
    };
  });
}

// ── Storage and reads ────────────────────────────────────────────────────────

/**
 * How close two readings of one logger must be to be the SAME record. PURE.
 *
 * Two downloaders time a record independently, so its second copy lands a
 * second or two from the first rather than on it, and UNIQUE(sensor_id, t) alone
 * would keep both. Half an interval is the widest window that can never swallow
 * the NEXT record; 30 s caps it, because exact trailer timing does not need more.
 */
function dedupeToleranceSeconds(intervalSeconds) {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 1) return 0;
  return Math.min(30, Math.floor(intervalSeconds / 2));
}

// What a sensor is for (5 Oct 2026). `roaming` records wherever Nick is (the
// Blue Maestro logger); `outdoor-baseline` will be the sensor outside the house;
// `indoor` is a fixed room. An unset role on a Blue Maestro reads as roaming.
const ROLES = Object.freeze(['roaming', 'outdoor-baseline', 'indoor']);
// A live reading is "here, now" for this long. Past it, it says when it was.
const HERE_FRESH_S = 30 * 60;
// A reading arriving this close to its own time is LIVE, so it is tagged with
// where Nick is now; an older one (a log download) is not, rather than tagging
// last Tuesday's walk with today's office.
const LIVE_WINDOW_S = 15 * 60;

function store(sensorId, model, accepted, { intervalSeconds = null, place = null, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  if (!accepted.length) return { stored: 0, duplicate: 0 };
  const db = require('../db/database');
  const tol = dedupeToleranceSeconds(intervalSeconds);
  let stored = 0;
  db.batchSaves(() => {
    for (const r of accepted) {
      if (tol > 0 && db.get(
        'SELECT 1 FROM environment_readings WHERE sensor_id = ? AND t BETWEEN ? AND ? LIMIT 1',
        [sensorId, r.t - tol, r.t + tol]
      )) continue;
      const info = db.run(
        `INSERT OR IGNORE INTO environment_readings
           (sensor_id, model, t, temperature_c, humidity_pct, pressure_hpa, timing_error_s, place)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [sensorId, model, r.t, r.tempC, r.humidityPct, r.pressureHpa, r.timingErrorSeconds,
          place && nowSeconds - r.t <= LIVE_WINDOW_S ? place : null]
      );
      stored += info.changes;
    }
  });
  return { stored, duplicate: accepted.length - stored };
}

/**
 * Move a logger's cursor. Only ever FORWARD in time: two downloaders can finish
 * out of order, and an older download landing second must not rewind NEURO into
 * re-fetching records it already holds.
 */
function advanceCursor(sensorId, model, cursor, { source = null, lastT = null, now = Date.now() } = {}) {
  const db = require('../db/database');
  const syncedAt = Math.floor(now / 1000);
  const info = db.run(
    `INSERT INTO environment_sensors (sensor_id, model, interval_s, log_count, synced_at, last_t, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(sensor_id) DO UPDATE SET
       model = excluded.model, interval_s = excluded.interval_s, log_count = excluded.log_count,
       synced_at = excluded.synced_at, last_t = COALESCE(MAX(excluded.last_t, environment_sensors.last_t), excluded.last_t),
       source = excluded.source, updated_at = CURRENT_TIMESTAMP
     WHERE excluded.synced_at >= COALESCE(environment_sensors.synced_at, 0)`,
    [sensorId, model, cursor.intervalSeconds, cursor.logCount, syncedAt, lastT, source]
  );
  return info.changes > 0;
}

/** Set what a sensor is for. Refuses a role it does not know. */
function setRole(sensorId, role) {
  if (!ROLES.includes(role)) return { ok: false, error: `role must be one of ${ROLES.join(', ')}` };
  const db = require('../db/database');
  const info = db.run('UPDATE environment_sensors SET role = ? WHERE sensor_id = ?', [role, sensorId]);
  if (!info.changes) {
    db.run('INSERT INTO environment_sensors (sensor_id, role) VALUES (?, ?)', [sensorId, role]);
  }
  return { ok: true, sensorId, role };
}

function roleOf(row) {
  if (row.role && ROLES.includes(row.role)) return row.role;
  return /blue|maestro|disc/i.test(String(row.model || '')) ? 'roaming' : null;
}

/** Phone barometer readings. Idempotent on (source, t); place only when live. */
function storePressure(source, readings, { place = null, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const src = typeof source === 'string' && /^[a-z0-9._-]{1,60}$/i.test(source) ? source : null;
  if (!src) return { ok: false, error: 'source must be a short id' };
  if (!Array.isArray(readings) || !readings.length) return { ok: false, error: 'readings must be a non-empty list' };
  const db = require('../db/database');
  let stored = 0; let rejected = 0;
  for (const r of readings.slice(0, 500)) {
    const t = Number(r && r.t); const p = Number(r && r.pressureHpa);
    // 870–1090 hPa covers every pressure recorded at the surface, and a hill.
    if (!Number.isInteger(t) || t > nowSeconds + 300 || !Number.isFinite(p) || p < 500 || p > 1100) { rejected += 1; continue; }
    stored += db.run('INSERT OR IGNORE INTO environment_pressure (source, t, pressure_hpa, place) VALUES (?, ?, ?, ?)',
      [src, t, Math.round(p * 10) / 10, place && nowSeconds - t <= LIVE_WINDOW_S ? place : null]).changes;
  }
  return { ok: true, stored, rejected };
}

/**
 * What the air is like where Nick is, and at home outside (5 Oct 2026).
 *   roaming   the freshest roaming-sensor reading (the logger he carries)
 *   pressure  the freshest phone barometer reading
 *   outdoor   the freshest outdoor-baseline reading, once that sensor exists
 * Each is null when there is none, and carries its age; `fresh` says whether
 * it is recent enough to call "here, now". Never a stale value passed off as live.
 */
function here({ nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const db = require('../db/database');
  // Sensors known from their readings too: a logger's first live readings can
  // arrive before any download has written its sensor row.
  const sensors = db.all(`SELECT r.sensor_id AS sensor_id, COALESCE(s.model, r.model) AS model, s.role FROM
      (SELECT DISTINCT sensor_id, model FROM environment_readings) r
      LEFT JOIN environment_sensors s ON s.sensor_id = r.sensor_id
    UNION SELECT sensor_id, model, role FROM environment_sensors`);
  const ids = (role) => sensors.filter((r) => roleOf(r) === role).map((r) => r.sensor_id);
  const latestOf = (list) => {
    if (!list.length) return null;
    const row = db.get(`SELECT sensor_id, t, temperature_c, humidity_pct, pressure_hpa, place FROM environment_readings
                         WHERE sensor_id IN (${list.map(() => '?').join(',')}) ORDER BY t DESC LIMIT 1`, list);
    if (!row) return null;
    const ageS = nowSeconds - row.t;
    return { sensorId: row.sensor_id, at: new Date(row.t * 1000).toISOString(), ageMinutes: Math.round(ageS / 60),
      fresh: ageS <= HERE_FRESH_S, tempC: row.temperature_c, humidityPct: row.humidity_pct, pressureHpa: row.pressure_hpa, place: row.place || null };
  };
  const p = db.get('SELECT source, t, pressure_hpa, place FROM environment_pressure ORDER BY t DESC LIMIT 1');
  const pAge = p ? nowSeconds - p.t : null;
  return {
    roaming: latestOf(ids('roaming')),
    outdoor: latestOf(ids('outdoor-baseline')),
    pressure: p ? { source: p.source, at: new Date(p.t * 1000).toISOString(), ageMinutes: Math.round(pAge / 60), fresh: pAge <= HERE_FRESH_S, pressureHpa: p.pressure_hpa, place: p.place || null } : null,
  };
}

function getSensor(sensorId) {
  const db = require('../db/database');
  const row = db.get('SELECT * FROM environment_sensors WHERE sensor_id = ?', [sensorId]);
  if (!row) return null;
  return {
    sensorId: row.sensor_id,
    model: row.model,
    cursor: { logCount: row.log_count, intervalSeconds: row.interval_s, syncedAt: row.synced_at },
    lastT: row.last_t,
    source: row.source,
  };
}

function readingsBetween(fromSeconds, toSeconds, limit = 20000) {
  const db = require('../db/database');
  return db.all(
    `SELECT sensor_id, t, temperature_c, humidity_pct, pressure_hpa, timing_error_s
       FROM environment_readings WHERE t >= ? AND t <= ? ORDER BY t ASC LIMIT ?`,
    [fromSeconds, toSeconds, limit]
  );
}

function latestReading() {
  const db = require('../db/database');
  return db.get('SELECT sensor_id, t FROM environment_readings ORDER BY t DESC LIMIT 1') || null;
}

/** Recent hikes, newest first, each with what the logger saw. */
function hikes({ days = 60, types = HIKE_TYPES, now = new Date(), includeSeries = false } = {}) {
  const db = require('../db/database');
  const fromMs = now.getTime() - days * 86400000;
  const toSql = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const placeholders = types.map(() => '?').join(',');
  const workouts = db.all(
    `SELECT * FROM health_workouts
      WHERE started_at >= ? AND started_at <= ? AND activity_type IN (${placeholders})
      ORDER BY started_at DESC LIMIT 200`,
    [toSql(fromMs), toSql(now.getTime()), ...types]
  );
  const windows = workouts.map(workoutWindow).filter(Boolean);
  const readings = windows.length
    ? readingsBetween(Math.min(...windows.map((w) => w.start)) - BASELINE_WINDOW_S,
      Math.max(...windows.map((w) => w.end)), 200000)
    : [];
  const latest = latestReading();
  return {
    hikes: matchWorkouts(workouts, readings, { includeSeries }),
    latestReadingAt: latest ? new Date(latest.t * 1000).toISOString() : null,
  };
}

module.exports = {
  ROLES, HERE_FRESH_S, LIVE_WINDOW_S, setRole, roleOf, storePressure, here,
  MAX_READINGS_PER_REQUEST,
  HIKE_TYPES,
  validateReading,
  validateBatch,
  dewPoint,
  baroAscent,
  summarise,
  workoutWindow,
  carriedVerdict,
  matchWorkouts,
  dedupeToleranceSeconds,
  store,
  advanceCursor,
  getSensor,
  readingsBetween,
  latestReading,
  hikes,
};
