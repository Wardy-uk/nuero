'use strict';

/**
 * energy-weather — the outdoor daily mean temperature that gas usage is read
 * against. NOT a second weather pipeline: it reads the stores NEURO already
 * keeps, and adds ONE adapter (Open-Meteo's historical archive) that writes into
 * the existing external-weather store (services/weather-external.js), exactly
 * like the EA and WU adapters.
 *
 * Why the archive: the local station and the WU ring only started in October
 * 2026, while Bright's history goes back to whenever the meter was fitted. A
 * weather baseline fitted on a fortnight explains nothing.
 *
 * ONE series is preferred for the whole history, so a fit is not bent by a
 * change of instrument part-way through:
 *   1. openmeteo:archive (ERA5 reanalysis, daily mean, ~5 days behind)
 *   2. the WU neighbour ring's median (weather_station_daily) — recent days only
 *   3. the home station's own mean, only for a day it covered ≥ 18 hours
 * Every day says which one it came from.
 */

const ext = require('./weather-external');
const model = require('./energy-model');

const SOURCE = 'openmeteo:archive';
const FEED = 'daily-mean';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const ARCHIVE_LAG_DAYS = 6;

function _db() { return require('../db/database').getDb(); }

/** Daily outdoor means between two London days (inclusive). Map day → { tMean, source }. */
function dailyMeans(fromDay, toDay) {
  const out = new Map();
  const db = _db();
  // 1. archive
  try {
    const a = model.londonMidnightMs(fromDay);
    const b = model.londonMidnightMs(model.addDays(toDay, 1));
    const rows = db.prepare(`SELECT observed_at, temperature_c FROM external_weather_observations
      WHERE source_id = ? AND feed = ? AND period_s = 86400 AND observed_at >= ? AND observed_at < ? AND temperature_c IS NOT NULL`).all(SOURCE, FEED, a, b);
    for (const r of rows) out.set(model.londonDay(r.observed_at), { tMean: r.temperature_c, source: 'open-meteo archive' });
  } catch (e) { console.warn(`[EnergyWeather] archive read failed: ${e.message}`); }
  // 2. WU ring median
  try {
    const rows = db.prepare('SELECT day, t_mean FROM weather_station_daily WHERE day BETWEEN ? AND ? AND t_mean IS NOT NULL').all(fromDay, toDay);
    const by = new Map();
    for (const r of rows) { if (!by.has(r.day)) by.set(r.day, []); by.get(r.day).push(r.t_mean); }
    for (const [day, ts] of by) if (!out.has(day) && ts.length >= 3) out.set(day, { tMean: model.round(model.median(ts), 2), source: `median of ${ts.length} neighbouring stations` });
  } catch (e) { console.warn(`[EnergyWeather] station-daily read failed: ${e.message}`); }
  // 3. home station
  try {
    const node = require('./weather-station').defaultNode();
    const nodeId = node && (node.node_id || node.id || node);
    if (nodeId && typeof nodeId === 'string') {
      const a = model.londonMidnightMs(fromDay);
      const b = model.londonMidnightMs(model.addDays(toDay, 1));
      const rows = db.prepare('SELECT observed_at, temperature_c FROM weather_observations WHERE node_id = ? AND observed_at >= ? AND observed_at < ?').all(nodeId, a, b);
      const by = new Map();
      for (const r of rows) { const d = model.londonDay(r.observed_at); if (!by.has(d)) by.set(d, { s: 0, n: 0, hours: new Set() }); const o = by.get(d); o.s += r.temperature_c; o.n += 1; o.hours.add(model.londonHour(r.observed_at)); }
      for (const [day, o] of by) if (!out.has(day) && o.hours.size >= 18) out.set(day, { tMean: model.round(o.s / o.n, 2), source: 'home weather station' });
    }
  } catch (e) { console.warn(`[EnergyWeather] home station read failed: ${e.message}`); }
  return out;
}

/** PURE. Open-Meteo archive JSON → external-weather observations. */
function shapeArchive(body, nowMs = Date.now()) {
  const d = body && body.daily;
  if (!d || !Array.isArray(d.time) || !Array.isArray(d.temperature_2m_mean)) return [];
  const out = [];
  d.time.forEach((day, i) => {
    const t = d.temperature_2m_mean[i];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || t == null || !Number.isFinite(t)) return;
    out.push({
      source_id: SOURCE, source_type: 'reanalysis', feed: FEED,
      observed_at: model.londonMidnightMs(day), period_s: 86400, received_at: nowMs,
      temperature_c: t, qc_status: 'good', raw_payload: { day, t }, provenance: 'open-meteo-era5',
    });
  });
  return out;
}

/**
 * Fill the archive back to `fromDay` (the oldest energy day), one year per
 * call, newest first. Resumable: the cursor lives in external_weather_sync.
 */
async function syncArchive({ fromDay, nowMs = Date.now(), fetchImpl, maxCalls = 3 } = {}) {
  if (!fromDay) return { ok: true, skipped: 'nothing-to-cover' };
  const state = ext.syncState(SOURCE, FEED) || {};
  if (ext.backingOff(state, nowMs)) return { ok: false, skipped: 'backing-off' };
  const loc = await require('./weather-forecast').location();
  if (!loc || !loc.known) return { ok: false, blocked: true, reason: 'home location unknown' };
  const end = model.addDays(model.londonDay(nowMs), -ARCHIVE_LAG_DAYS);
  const have = dailyMeans(fromDay, end);
  let cursor = end;
  let calls = 0; let stored = 0;
  try {
    while (cursor >= fromDay && calls < maxCalls) {
      const start = model.addDays(cursor, -365) < fromDay ? fromDay : model.addDays(cursor, -365);
      const missing = model.dayRange(start, cursor).some((d) => !have.has(d) || have.get(d).source !== 'open-meteo archive');
      if (missing) {
        const url = `${ARCHIVE_URL}?latitude=${loc.latitude.toFixed(3)}&longitude=${loc.longitude.toFixed(3)}&start_date=${start}&end_date=${cursor}&daily=temperature_2m_mean&timezone=Europe%2FLondon`;
        const body = await ext.getJson(url, { fetchImpl });
        const r = ext.upsert(shapeArchive(body, nowMs), { nowMs });
        stored += (r.stored || 0) + (r.revised || 0);
        calls += 1;
      }
      cursor = model.addDays(start, -1);
    }
    ext.recordSuccess(SOURCE, FEED, { nowMs, stats: { calls, stored } });
    return { ok: true, calls, stored };
  } catch (e) {
    ext.recordFailure(SOURCE, FEED, e, { nowMs });
    return { ok: false, error: e.message };
  }
}

module.exports = { SOURCE, FEED, dailyMeans, shapeArchive, syncArchive };
