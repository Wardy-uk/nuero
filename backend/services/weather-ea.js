'use strict';

/**
 * weather-ea — the Environment Agency's Mount St Bernards rain gauge.
 *
 *   station reference 3641 · WISKI 115298 · hydrology GUID 3944527a-…
 *   ~52.7386, -1.3206 · tipping bucket, 15-minute totals · open since 1985-10-24
 *
 * Two EA APIs, both Open Government Licence v3, both keyless, and they answer
 * different questions:
 *
 *   Flood Monitoring  /flood-monitoring/id/stations/3641/readings
 *     LIVE telemetry, ~the last month. No quality flags: it is provisional by
 *     definition, stored qc 'provisional'. Feed 'ea-flood-monitoring'.
 *   Hydrology         /hydrology/id/measures/<guid>-rainfall-t-{900|86400}-mm-qualified/readings
 *     The RECORD: 15-minute and daily totals back to 1985 with per-reading
 *     `quality` (Good / Unchecked / Estimated / Suspect / Missing) and
 *     `completeness`. Recent weeks arrive Unchecked and are re-issued Good
 *     later, so the recent window is re-read daily and a change is a REVISION.
 *     Feed 'ea-hydrology'.
 *
 * ⚠ HYDROLOGY TIMESTAMPS CARRY NO ZONE ("2026-10-07T12:00:00"). They are UTC:
 * measured on 7 Oct 2026 (BST) the newest hydrology reading was 12:00:00 and the
 * newest Flood Monitoring reading for the same gauge was 12:00:00Z. A naive
 * parse would read them as local and shift every summer reading by an hour.
 * The shaper appends Z explicitly and refuses any other shape.
 *
 * ⚠ The stamp is the period's START as far as can be told: the daily series is
 * stamped 09:00 on the date it names, i.e. the opening of the EA water day
 * (09:00–09:00 GMT). Stored as published; the convention is in provenance.
 *
 * ⚠ min-date / max-date are EXCLUSIVE on the hydrology API (min-date=X starts
 * the day after X). Inclusive is mineq-date. Getting this wrong silently drops
 * one day per chunk — checked: 1–8 Jan returned six days.
 *
 * Backfill is resumable and bounded per run: the cursor walks BACKWARDS from
 * the recent window, a month (15-min) or five years (daily) at a time, and is
 * persisted after every chunk, so a restart continues rather than re-reads.
 * 15-minute history defaults to WEATHER_EA_15MIN_FROM (2021-01-01) — ~200k rows,
 * ~60MB measured at ~300 bytes a row, a deliberate bound on a Pi whose DB is
 * already 600MB (set it earlier, back to 1985, if the space is wanted); daily
 * history is taken in full (~15k rows).
 */

const ext = require('./weather-external');

const STATION = Object.freeze({
  sourceId: 'ea:3641',
  sourceType: 'ea-raingauge',
  reference: '3641',
  wiskiId: '115298',
  guid: '3944527a-7e03-49e4-b50b-d9e46bce380a',
  label: 'Mount St Bernards rain gauge (Environment Agency)',
  lat: 52.738594, lon: -1.320561,
  openedOn: '1985-10-24',
});

const FM_BASE = 'https://environment.data.gov.uk/flood-monitoring';
const HY_BASE = 'https://environment.data.gov.uk/hydrology';
const FEED_LIVE = 'ea-flood-monitoring';
const FEED_HY = 'ea-hydrology';
const HEALTH_LIVE = 'weather.ea-3641';
const HEALTH_HY = 'weather.ea-3641-qualified';
const DAY = 24 * 3600 * 1000;

const measureId = (periodS) => `${STATION.guid}-rainfall-t-${periodS}-mm-qualified`;

// Per-row provenance is a short CODE; what it means is here, once. Repeating
// the full description on every one of ~200k rows cost ~150 bytes a row.
const PROVENANCE = Object.freeze({
  'ea/fm/3641-15min': { api: 'ea-flood-monitoring', measure: `${'3641'}-rainfall-tipping_bucket_raingauge-t-15_min-mm`, licence: 'OGL-3.0', stamp: 'as published, UTC (Z)' },
  'ea/hy/t-900-qualified': { api: 'ea-hydrology', measure: `${'3944527a-7e03-49e4-b50b-d9e46bce380a'}-rainfall-t-900-mm-qualified`, licence: 'OGL-3.0', stamp: 'period start, UTC (naive in source)' },
  'ea/hy/t-86400-qualified': { api: 'ea-hydrology', measure: `${'3944527a-7e03-49e4-b50b-d9e46bce380a'}-rainfall-t-86400-mm-qualified`, licence: 'OGL-3.0', stamp: 'water day from 09:00 GMT, UTC (naive in source)' },
});

function provenance(feed, periodS) {
  return feed === FEED_LIVE ? 'ea/fm/3641-15min' : `ea/hy/t-${periodS}-qualified`;
}

const QUALITY = { good: 'good', estimated: 'estimated', suspect: 'suspect', unchecked: 'unchecked', missing: 'missing' };

/** EA quality word → internal qc. An unrecognised word is KEPT, never guessed. PURE. */
function mapQuality(q) {
  if (q == null || q === '') return 'unknown';
  const k = String(q).trim().toLowerCase();
  return QUALITY[k] || `unknown:${String(q).slice(0, 32)}`;
}

const rain = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A Flood Monitoring reading → internal shape. PURE. */
function shapeFlood(item, receivedAt) {
  const t = Date.parse(item && item.dateTime);
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(String(item && item.dateTime)) || !Number.isFinite(t)) return null;
  return {
    source_id: STATION.sourceId, source_type: STATION.sourceType, feed: FEED_LIVE,
    observed_at: t, period_s: 900, received_at: receivedAt,
    rain_mm: rain(item.value), lat: STATION.lat, lon: STATION.lon,
    qc_status: 'provisional', qc_detail: null,
    raw_payload: { dateTime: item.dateTime, value: item.value ?? null },
    provenance: provenance(FEED_LIVE, 900),
  };
}

/** A Hydrology reading → internal shape. PURE. Naive timestamps are UTC (see header). */
function shapeHydrology(item, periodS, receivedAt) {
  const s = String(item && item.dateTime);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(s)) return null;
  const t = Date.parse(s + 'Z');
  if (!Number.isFinite(t)) return null;
  const raw = { dateTime: s, value: item.value ?? null };
  if (periodS === 86400 && item.date) raw.date = item.date;
  for (const k of ['quality', 'completeness', 'valid', 'invalid', 'missing']) if (item[k] != null) raw[k] = item[k];
  return {
    source_id: STATION.sourceId, source_type: STATION.sourceType, feed: FEED_HY,
    observed_at: t, period_s: periodS, received_at: receivedAt,
    rain_mm: rain(item.value), lat: STATION.lat, lon: STATION.lon,
    qc_status: mapQuality(item.quality), qc_detail: null, // the EA's completeness/valid/invalid/missing stay in raw_payload
    raw_payload: raw, provenance: provenance(FEED_HY, periodS),
  };
}

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

function _shapeAll(items, shaper) {
  const out = []; let unusable = 0;
  for (const it of Array.isArray(items) ? items : []) { const o = shaper(it); if (o) out.push(o); else unusable++; }
  return { out, unusable };
}

// ── Live ─────────────────────────────────────────────────────────────────────

/**
 * Pull live telemetry since the newest reading held (less an overlap, so a
 * late-arriving or revised reading is caught), capped to the ~month the feed
 * keeps. Refuses to run inside its backoff window unless forced.
 */
async function syncLive({ nowMs = Date.now(), force = false, fetchImpl, sleep } = {}) {
  const state = ext.syncState(STATION.sourceId, FEED_LIVE);
  if (!force && ext.backingOff(state, nowMs)) return { ok: false, skipped: 'backing-off', retryAfter: state.retryAfter };
  const run = require('./source-health').beginSourceRun(HEALTH_LIVE, { system: 'environment-agency', expectedIntervalMs: 15 * 60 * 1000, staleAfterMs: 3 * 3600 * 1000 });
  const sinceMs = Math.max(nowMs - 28 * DAY, state && state.lastObservedAt ? state.lastObservedAt - 6 * 3600 * 1000 : 0);
  const url = `${FM_BASE}/id/stations/${STATION.reference}/readings?since=${new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, 'Z')}&_sorted&_limit=10000`;
  try {
    const body = await ext.getJson(url, { fetchImpl, sleep });
    const { out, unusable } = _shapeAll(body && body.items, (it) => shapeFlood(it, nowMs));
    const r = ext.upsert(out, { nowMs });
    const stats = { fetched: out.length + unusable, unusable, stored: r.stored, revised: r.revised, duplicate: r.duplicate, rejected: r.rejected };
    ext.recordSuccess(STATION.sourceId, FEED_LIVE, { nowMs, newestObservedAt: r.newestObservedAt, stats });
    // ⚠ An empty live answer is NOT a success for freshness: the gauge reports
    //   zeros when dry, so no rows at all means the telemetry stopped.
    if (!out.length) run.fail('Flood Monitoring returned no readings', { reason: 'empty', ambiguous: true });
    else run.succeed(stats);
    return { ok: true, ...stats, newestObservedAt: r.newestObservedAt };
  } catch (e) {
    const b = ext.recordFailure(STATION.sourceId, FEED_LIVE, e, { nowMs });
    run.fail(e, { reason: e.status ? `http-${e.status}` : 'network' });
    return { ok: false, error: e.message, ...b };
  }
}

// ── Hydrology (qualified record) ─────────────────────────────────────────────

async function _hyChunk(periodS, fromYmd, toYmdExclusive, { nowMs, fetchImpl, sleep }) {
  const url = `${HY_BASE}/id/measures/${measureId(periodS)}/readings?mineq-date=${fromYmd}&max-date=${toYmdExclusive}&_limit=200000`;
  const body = await ext.getJson(url, { fetchImpl, sleep, timeoutMs: 90000 });
  const { out, unusable } = _shapeAll(body && body.items, (it) => shapeHydrology(it, periodS, nowMs));
  const r = ext.upsert(out, { nowMs });
  return { from: fromYmd, to: toYmdExclusive, fetched: out.length + unusable, unusable, stored: r.stored, revised: r.revised, duplicate: r.duplicate, rejected: r.rejected, newest: r.newestObservedAt };
}

const RECENT_DAYS = 120;

/** Re-read the recent qualified window, where Unchecked becomes Good. */
async function syncQualifiedRecent({ nowMs = Date.now(), days = RECENT_DAYS, force = false, fetchImpl, sleep } = {}) {
  const state = ext.syncState(STATION.sourceId, FEED_HY);
  if (!force && ext.backingOff(state, nowMs)) return { ok: false, skipped: 'backing-off', retryAfter: state.retryAfter };
  const run = require('./source-health').beginSourceRun(HEALTH_HY, { system: 'environment-agency', expectedIntervalMs: DAY, staleAfterMs: 3 * DAY });
  const chunks = [];
  try {
    // A month a request, newest last; the daily series in one.
    for (let end = nowMs + DAY; end > nowMs - days * DAY; end -= 31 * DAY) {
      const start = Math.max(end - 31 * DAY, nowMs - days * DAY);
      chunks.push(await _hyChunk(900, ymd(start), ymd(end), { nowMs, fetchImpl, sleep }));
    }
    chunks.push(await _hyChunk(86400, ymd(nowMs - days * DAY), ymd(nowMs + DAY), { nowMs, fetchImpl, sleep }));
    const sum = (k) => chunks.reduce((a, c) => a + c[k], 0);
    const stats = { chunks: chunks.length, fetched: sum('fetched'), stored: sum('stored'), revised: sum('revised'), duplicate: sum('duplicate'), rejected: sum('rejected') };
    const newest = Math.max(...chunks.map((c) => c.newest || 0)) || null;
    ext.recordSuccess(STATION.sourceId, FEED_HY, { nowMs, newestObservedAt: newest, stats });
    run.succeed(stats);
    return { ok: true, ...stats };
  } catch (e) {
    const b = ext.recordFailure(STATION.sourceId, FEED_HY, e, { nowMs });
    run.fail(e, { reason: e.status ? `http-${e.status}` : 'network' });
    return { ok: false, error: e.message, chunksDone: chunks.length, ...b };
  }
}

// ── Backfill ─────────────────────────────────────────────────────────────────

const SERIES = Object.freeze({
  900: { stepDays: 31, floorEnv: 'WEATHER_EA_15MIN_FROM', floorDefault: '2021-01-01' },
  86400: { stepDays: 5 * 366, floorEnv: 'WEATHER_EA_DAILY_FROM', floorDefault: STATION.openedOn },
});

function floorFor(periodS, env = process.env) {
  const s = SERIES[periodS];
  const v = env[s.floorEnv];
  return /^\d{4}-\d\d-\d\d$/.test(v || '') && v >= STATION.openedOn ? v : s.floorDefault;
}

/**
 * The next chunk a backfill should fetch, or null when it has reached its
 * floor. PURE. `cursor` is the exclusive upper date already covered.
 */
function nextChunk(periodS, cursor, floor) {
  if (!cursor || cursor <= floor) return null;
  const end = Date.parse(cursor + 'T00:00:00Z');
  const start = Math.max(end - SERIES[periodS].stepDays * DAY, Date.parse(floor + 'T00:00:00Z'));
  return { from: ymd(start), to: cursor };
}

/**
 * Walk the history backwards, at most `maxChunks` requests per call per
 * series. Persists after every chunk. Starts below the recent window, which
 * syncQualifiedRecent owns.
 */
async function backfillStep({ nowMs = Date.now(), maxChunks = 6, periods = [86400, 900], fetchImpl, sleep } = {}) {
  const sync = ext.syncState(STATION.sourceId, FEED_HY) || {};
  const all = { ...(sync.backfill || {}) };
  const report = {};
  for (const p of periods) {
    const floor = floorFor(p);
    const st = all[p] || { cursor: ymd(nowMs - RECENT_DAYS * DAY + DAY), floor, chunks: 0, rows: 0, errors: 0 };
    st.floor = floor; // a floor moved back by env re-opens the walk
    const done = [];
    for (let i = 0; i < maxChunks; i++) {
      const c = nextChunk(p, st.cursor, floor);
      if (!c) break;
      try {
        const r = await _hyChunk(p, c.from, c.to, { nowMs, fetchImpl, sleep });
        st.cursor = c.from; st.chunks++; st.rows += r.stored + r.revised; st.lastChunkAt = nowMs; st.lastError = null;
        done.push(r);
      } catch (e) {
        st.errors++; st.lastError = String(e.message).slice(0, 200);
        all[p] = st; ext.setBackfill(STATION.sourceId, FEED_HY, all);
        report[p] = { ...st, done, complete: false, stoppedOn: e.message };
        break;
      }
      all[p] = st; ext.setBackfill(STATION.sourceId, FEED_HY, all);
    }
    all[p] = st;
    report[p] = report[p] || { ...st, done, complete: !nextChunk(p, st.cursor, floor) };
  }
  ext.setBackfill(STATION.sourceId, FEED_HY, all);
  return report;
}

function status(nowMs = Date.now()) {
  const live = ext.syncState(STATION.sourceId, FEED_LIVE);
  const hy = ext.syncState(STATION.sourceId, FEED_HY);
  return { station: STATION, live, qualified: hy, backfill: hy ? hy.backfill : null, latest: ext.latest(STATION.sourceId, { feed: FEED_LIVE }), nowMs };
}

module.exports = {
  PROVENANCE, STATION, FEED_LIVE, FEED_HY, HEALTH_LIVE, HEALTH_HY, SERIES, RECENT_DAYS,
  mapQuality, shapeFlood, shapeHydrology, nextChunk, floorFor, measureId,
  syncLive, syncQualifiedRecent, backfillStep, status,
};
