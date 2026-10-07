'use strict';

/**
 * weather-external — the store for weather NEURO reads from somebody else.
 *
 * Sources are ADAPTERS (weather-ea.js, weather-wu.js, later the ESP32 node or
 * Ecowitt/CWOP). Each turns its own API into the one internal shape below and
 * hands it here. NEURO is the source of truth; external services are inputs
 * (and, for our own WU station, an output — weather-wu.js publishes, nothing
 * here does).
 *
 *   { source_id, source_type, feed, observed_at, period_s, received_at,
 *     temperature_c, humidity_pct, dewpoint_c, pressure_hpa, wind_ms, gust_ms,
 *     wind_direction_deg, rain_mm, rain_rate_mm_h, rain_accum_mm,
 *     lat, lon, elevation_m, qc_status, qc_detail, raw_payload, provenance }
 *
 * SI throughout. Unit conversion happens in the ADAPTER, at the boundary, once.
 * Every measure is nullable: a rain gauge has no temperature, and a missing
 * reading is null — never 0, which for rain would claim it was dry.
 *
 * ⚠ IDENTITY is (source_id, feed, observed_at, period_s). The SAME instant from
 * two feeds is two rows on purpose: the EA's live telemetry and its qualified
 * record disagree sometimes, and both are evidence. `canonicalRain()` chooses
 * at read time and says which it chose.
 *
 * ⚠ A REVISION IS NOT A DUPLICATE. The EA re-issues a reading when it is
 * quality-checked (Unchecked → Good, sometimes with a corrected value). An
 * identical re-read is a duplicate and writes nothing; a changed one updates
 * in place, bumps `revision` and keeps the value it replaced in
 * `previous_payload` — the raw history survives one level deep.
 *
 * Pure half (validation, QC mapping, backoff) at the top; storage below,
 * requiring the DB lazily so the contract pins without a database.
 */

const MEASURES = ['temperature_c', 'humidity_pct', 'dewpoint_c', 'pressure_hpa', 'wind_ms', 'gust_ms',
  'wind_direction_deg', 'rain_mm', 'rain_rate_mm_h', 'rain_accum_mm', 'lat', 'lon', 'elevation_m'];

// Physical sanity bounds. A value outside is REFUSED (the record), not clipped:
// clipping manufactures a plausible number nobody measured.
const BOUNDS = Object.freeze({
  temperature_c: [-80, 70], humidity_pct: [0, 100], dewpoint_c: [-90, 50], pressure_hpa: [800, 1100],
  wind_ms: [0, 120], gust_ms: [0, 150], wind_direction_deg: [0, 360], rain_mm: [0, 500],
  rain_rate_mm_h: [0, 1000], rain_accum_mm: [0, 1000], lat: [-90, 90], lon: [-180, 180], elevation_m: [-500, 9000],
});

const SOURCE_ID = /^[a-z][a-z0-9]*:[A-Za-z0-9._-]{1,64}$/; // 'ea:3641', 'wu:ICOALV53'
const FEED = /^[a-z][a-z0-9-]{1,48}$/;
const FUTURE_SKEW_MS = 10 * 60 * 1000;
const QC = ['good', 'estimated', 'suspect', 'unchecked', 'provisional', 'missing', 'failed', 'unknown'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Validate one normalised observation. PURE. */
function validate(o, nowMs = Date.now()) {
  if (!o || typeof o !== 'object') return { ok: false, reason: 'observation must be an object' };
  if (typeof o.source_id !== 'string' || !SOURCE_ID.test(o.source_id)) return { ok: false, reason: 'source_id must look like "kind:id"' };
  if (typeof o.source_type !== 'string' || !o.source_type) return { ok: false, reason: 'source_type is required' };
  if (typeof o.feed !== 'string' || !FEED.test(o.feed)) return { ok: false, reason: 'feed must be a short kebab id' };
  if (!Number.isInteger(o.observed_at)) return { ok: false, reason: 'observed_at must be epoch ms' };
  if (isNum(nowMs) && o.observed_at > nowMs + FUTURE_SKEW_MS) return { ok: false, reason: 'observed_at is in the future' };
  const period = o.period_s == null ? 0 : o.period_s;
  if (!Number.isInteger(period) || period < 0) return { ok: false, reason: 'period_s must be a non-negative integer' };
  for (const k of MEASURES) {
    const v = o[k];
    if (v == null) continue;
    if (!isNum(v)) return { ok: false, reason: `${k} must be a finite number or null` };
    if (v < BOUNDS[k][0] || v > BOUNDS[k][1]) return { ok: false, reason: `${k} ${v} outside ${BOUNDS[k][0]}–${BOUNDS[k][1]}` };
  }
  if (o.qc_status != null && !QC.includes(o.qc_status) && !String(o.qc_status).startsWith('unknown:')) {
    return { ok: false, reason: `qc_status must be one of ${QC.join('|')}` };
  }
  if (o.raw_payload == null) return { ok: false, reason: 'raw_payload is required — provenance is not optional' };
  if (o.provenance == null) return { ok: false, reason: 'provenance is required' };
  return { ok: true, obs: { ...o, period_s: period } };
}

/** Exponential backoff for a source that keeps failing. PURE. 5 min → 6 h. */
function backoffMs(consecutiveFailures) {
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures <= 0) return 0;
  return Math.min(5 * 60 * 1000 * 2 ** (consecutiveFailures - 1), 6 * 3600 * 1000);
}

// ── HTTP with retry ──────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const RETRYABLE = (s) => s === 429 || s >= 500;

/**
 * GET JSON with a bounded in-call retry for transient failures (429 / 5xx /
 * network / timeout). A 4xx other than 429 is a permanent no and is NOT retried.
 * 204 returns null — "the station has nothing now" is an answer, not an error.
 * `opts.fetchImpl` and `opts.sleep` exist for tests.
 */
async function getJson(url, opts = {}) {
  const attempts = opts.attempts || 3;
  const delays = opts.delays || [2000, 8000];
  const f = opts.fetchImpl || fetch;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await f(url, { signal: AbortSignal.timeout(opts.timeoutMs || 30000), headers: { Accept: 'application/json', 'User-Agent': 'NEURO/1 (personal weather ingest)' } });
      if (res.status === 204) return null;
      if (!res.ok) {
        last = new HttpError(res.status, `HTTP ${res.status}`);
        if (!RETRYABLE(res.status)) throw last;
      } else {
        return await res.json();
      }
    } catch (e) {
      last = e;
      if (e instanceof HttpError && !RETRYABLE(e.status)) throw e;
    }
    if (i < attempts - 1) await sleep(delays[Math.min(i, delays.length - 1)]);
  }
  throw last;
}

// ── Storage ──────────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }

const STORED = ['source_type', 'received_at', ...MEASURES, 'qc_status', 'qc_detail', 'raw_payload', 'provenance'];
const _json = (v) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));

/** Has anything a reader could see changed? Receipt time never counts. */
function _differs(row, o) {
  for (const k of MEASURES) if ((row[k] ?? null) !== (o[k] ?? null)) return true;
  return (row.qc_status ?? null) !== (o.qc_status ?? null)
    || (row.qc_detail ?? null) !== (_json(o.qc_detail) ?? null)
    || row.raw_payload !== _json(o.raw_payload);
}

/**
 * Store a batch of normalised observations. Each gets an outcome:
 * stored | duplicate | revised | rejected. Synchronous end to end.
 */
function upsert(list, { nowMs = Date.now() } = {}) {
  const db = _db();
  const counts = { stored: 0, duplicate: 0, revised: 0, rejected: 0 };
  const rejects = [];
  let newest = null;
  db.batchSaves(() => {
    for (const raw of list) {
      const v = validate(raw, nowMs);
      if (!v.ok) { counts.rejected++; if (rejects.length < 20) rejects.push(v.reason); continue; }
      const o = { ...v.obs, received_at: Number.isInteger(v.obs.received_at) ? v.obs.received_at : nowMs };
      const row = db.get(
        'SELECT * FROM external_weather_observations WHERE source_id = ? AND feed = ? AND observed_at = ? AND period_s = ?',
        [o.source_id, o.feed, o.observed_at, o.period_s]
      );
      if (row && !_differs(row, o)) { counts.duplicate++; continue; }
      if (row) {
        db.run(
          `UPDATE external_weather_observations SET ${STORED.map((k) => `${k} = ?`).join(', ')},
             revision = revision + 1, previous_payload = ?, updated_at = ? WHERE id = ?`,
          [...STORED.map((k) => (k === 'qc_detail' || k === 'raw_payload' || k === 'provenance' ? _json(o[k]) : (o[k] ?? null))),
            row.raw_payload, nowMs, row.id]
        );
        counts.revised++;
      } else {
        db.run(
          `INSERT INTO external_weather_observations (source_id, feed, observed_at, period_s, ${STORED.join(', ')}, updated_at)
           VALUES (?, ?, ?, ?, ${STORED.map(() => '?').join(', ')}, ?)`,
          [o.source_id, o.feed, o.observed_at, o.period_s,
            ...STORED.map((k) => (k === 'qc_detail' || k === 'raw_payload' || k === 'provenance' ? _json(o[k]) : (o[k] ?? null))), nowMs]
        );
        counts.stored++;
      }
      if (newest == null || o.observed_at > newest) newest = o.observed_at;
    }
  });
  return { ...counts, received: list.length, newestObservedAt: newest, rejects };
}

// ── Sync state (per source + feed) ───────────────────────────────────────────

function syncState(sourceId, feed) {
  const r = _db().get('SELECT * FROM external_weather_sync WHERE source_id = ? AND feed = ?', [sourceId, feed]);
  if (!r) return null;
  return {
    sourceId: r.source_id, feed: r.feed,
    lastAttemptAt: r.last_attempt_at, lastSuccessAt: r.last_success_at, lastFailureAt: r.last_failure_at,
    lastError: r.last_error, consecutiveFailures: r.consecutive_failures, errorCount: r.error_count,
    retryAfter: r.retry_after, lastObservedAt: r.last_observed_at,
    lastStats: r.last_stats ? JSON.parse(r.last_stats) : null,
    backfill: r.backfill_state ? JSON.parse(r.backfill_state) : null,
  };
}

function _ensure(db, sourceId, feed) {
  db.run('INSERT OR IGNORE INTO external_weather_sync (source_id, feed) VALUES (?, ?)', [sourceId, feed]);
}

function recordSuccess(sourceId, feed, { nowMs = Date.now(), newestObservedAt = null, stats = null } = {}) {
  const db = _db();
  _ensure(db, sourceId, feed);
  db.run(
    `UPDATE external_weather_sync SET last_attempt_at = ?, last_success_at = ?, consecutive_failures = 0, retry_after = NULL,
       last_observed_at = MAX(COALESCE(last_observed_at, 0), COALESCE(?, 0)), last_stats = ? WHERE source_id = ? AND feed = ?`,
    [nowMs, nowMs, newestObservedAt, stats ? JSON.stringify(stats) : null, sourceId, feed]
  );
}

function recordFailure(sourceId, feed, error, { nowMs = Date.now() } = {}) {
  const db = _db();
  _ensure(db, sourceId, feed);
  const cur = db.get('SELECT consecutive_failures FROM external_weather_sync WHERE source_id = ? AND feed = ?', [sourceId, feed]);
  const n = (cur ? cur.consecutive_failures : 0) + 1;
  const msg = String((error && error.message) || error).slice(0, 300);
  db.run(
    `UPDATE external_weather_sync SET last_attempt_at = ?, last_failure_at = ?, last_error = ?, consecutive_failures = ?,
       error_count = error_count + 1, retry_after = ? WHERE source_id = ? AND feed = ?`,
    [nowMs, nowMs, msg, n, nowMs + backoffMs(n), sourceId, feed]
  );
  return { consecutiveFailures: n, retryAfter: nowMs + backoffMs(n) };
}

function setBackfill(sourceId, feed, state) {
  const db = _db();
  _ensure(db, sourceId, feed);
  db.run('UPDATE external_weather_sync SET backfill_state = ? WHERE source_id = ? AND feed = ?', [JSON.stringify(state), sourceId, feed]);
}

/** Is this source inside its backoff window? PURE over a state object. */
function backingOff(state, nowMs = Date.now()) {
  return !!(state && state.retryAfter && state.retryAfter > nowMs);
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Coverage per (source, feed, period): rows, first/last, newest received. */
function coverage() {
  return _db().all(
    `SELECT source_id, feed, period_s, COUNT(*) AS n, MIN(observed_at) AS first, MAX(observed_at) AS last,
            MAX(received_at) AS lastReceived, SUM(revision > 0) AS revised
       FROM external_weather_observations GROUP BY source_id, feed, period_s ORDER BY source_id, feed, period_s`, []
  ).map((r) => ({ sourceId: r.source_id, feed: r.feed, periodS: r.period_s, rows: r.n, firstObservedAt: r.first,
    lastObservedAt: r.last, lastReceivedAt: r.lastReceived, revisedRows: r.revised || 0 }));
}

// Which feed wins when both have the same instant. A qualified value that is
// itself marked missing does not beat live telemetry that has a number.
const FEED_RANK = { 'ea-hydrology': 2, 'ea-flood-monitoring': 1 };

/**
 * One rainfall series for a source and period, choosing per instant between
 * feeds, oldest first. Each point says which feed answered and its QC.
 * Gaps are absent instants, never zeros.
 */
function canonicalRain(sourceId, { periodS = 900, fromMs, toMs }) {
  const rows = _db().all(
    `SELECT observed_at, feed, rain_mm, qc_status FROM external_weather_observations
      WHERE source_id = ? AND period_s = ? AND observed_at >= ? AND observed_at < ? ORDER BY observed_at`,
    [sourceId, periodS, fromMs, toMs]
  );
  const best = new Map();
  for (const r of rows) {
    const cur = best.get(r.observed_at);
    const score = (r.rain_mm == null || r.qc_status === 'missing' ? 0 : 10) + (FEED_RANK[r.feed] || 0);
    if (!cur || score > cur.score) best.set(r.observed_at, { t: r.observed_at, rainMm: r.rain_mm, feed: r.feed, qc: r.qc_status, score });
  }
  return [...best.values()].map(({ score, ...p }) => p);
}

function latest(sourceId, { feed = null } = {}) {
  const r = _db().get(
    `SELECT * FROM external_weather_observations WHERE source_id = ? ${feed ? 'AND feed = ?' : ''}
      ORDER BY observed_at DESC LIMIT 1`, feed ? [sourceId, feed] : [sourceId]
  );
  if (!r) return null;
  const out = { sourceId: r.source_id, feed: r.feed, observedAt: r.observed_at, periodS: r.period_s, receivedAt: r.received_at, qc: r.qc_status };
  for (const k of MEASURES) out[k] = r[k];
  return out;
}

// How old the newest OBSERVATION may be before a feed is stale. The qualified
// record is judged on its last successful READ instead: it legitimately lags
// real time by days, so observation age says nothing about whether it works.
const STALE = Object.freeze({
  'ea-flood-monitoring': { ms: 3 * 3600 * 1000, on: 'observation' },
  'ea-hydrology': { ms: 72 * 3600 * 1000, on: 'success' },
  'wu-pws-v2': { ms: 3 * 3600 * 1000, on: 'observation' },
  'wu-upload': { ms: 60 * 60 * 1000, on: 'success' },
});

/**
 * Judge one sync row. PURE. States never collapse: `never` (no attempt),
 * `backing-off`, `failing`, `stale`, `ok` — and `lagMs` is null, never 0, when
 * nothing has been observed.
 */
function judge(s, nowMs = Date.now()) {
  if (!s || !s.lastAttemptAt) return { state: 'never', lagMs: null };
  const rule = STALE[s.feed] || { ms: 6 * 3600 * 1000, on: 'observation' };
  const lagMs = s.lastObservedAt ? nowMs - s.lastObservedAt : null;
  const basis = rule.on === 'success' ? s.lastSuccessAt : s.lastObservedAt;
  const stale = !basis || nowMs - basis > rule.ms;
  let state = 'ok';
  if (backingOff(s, nowMs)) state = 'backing-off';
  else if (s.consecutiveFailures > 0) state = 'failing';
  else if (stale) state = 'stale';
  return { state, lagMs, stale, staleAfterMs: rule.ms, staleOn: rule.on };
}

function health(nowMs = Date.now()) {
  const rows = _db().all('SELECT source_id, feed FROM external_weather_sync ORDER BY source_id, feed', []);
  return rows.map((r) => { const s = syncState(r.source_id, r.feed); return { ...s, ...judge(s, nowMs) }; });
}

module.exports = {
  STALE, judge, health,
  MEASURES, BOUNDS, QC, FEED_RANK, HttpError,
  validate, backoffMs, backingOff, getJson,
  upsert, syncState, recordSuccess, recordFailure, setBackfill,
  coverage, canonicalRain, latest,
};
