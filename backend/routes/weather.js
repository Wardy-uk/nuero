'use strict';

/**
 * The outdoor weather station and its forecast overlay. Mounted at /api/weather
 * behind the PIN / API token like everything else.
 *
 *   POST /api/weather/observations      the Pi's forwarder (API token; ingest tier)
 *   GET  /api/weather/overview          one payload for the Weather screen
 *   GET  /api/weather/latest            the latest reading, for polling (Home Assistant)
 *   POST /api/weather/forecast/refresh  take a forecast snapshot now
 *
 * ⚠ ROUTE ORDER: literals only. Register literals before any parameterised
 * sibling (`routes/mobile.js` has the incident).
 */

const express = require('express');
const station = require('../services/weather-station');
const forecast = require('../services/weather-forecast');
const trend = require('../services/weather-trend');

const router = express.Router();

// POST /api/weather/observations — outdoor weather station readings (saim.weather.v1) forwarded from pi5's saim-weather-ingest. Idempotent; each record gets an outcome (stored | duplicate | rejected); identity is node + sequence + received_at. Keywords: weather station, outdoor sensor, BME280, ingest. Body: { observations: [record], source }
router.post('/observations', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { observations, source } = req.body;
    // A bare record is accepted too, so a one-off curl needs no wrapper.
    const list = Array.isArray(observations) ? observations : (req.body.schema ? [req.body] : null);
    if (!list) return res.status(400).json({ ok: false, error: 'observations must be an array of saim.weather.v1 records' });
    const r = station.ingest(list, { source: source || null });
    if (!r.ok) return res.status(400).json({ ok: false, error: r.reason });
    // ⚠ 200 even when some were rejected: the forwarder needs the per-record
    //   outcomes to clear its spool, and a non-2xx would make it resend all of it.
    res.json(r);
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message, retryable: true });
  }
});

// GET /api/weather/latest — the outdoor weather station's latest reading, cheap enough to poll every minute (Home Assistant's REST sensors read it): temperature, humidity, pressure, battery, its age, whether it is stale, and the 3-hour pressure tendency. Stale readings are flagged, never presented as current. Keywords: weather station, latest reading, home assistant, temperature, humidity, pressure. Query: node
router.get('/latest', (req, res) => {
  try {
    const nowMs = Date.now();
    const node = typeof req.query.node === 'string' && req.query.node ? req.query.node : station.defaultNode();
    const latest = station.latest(node, nowMs);
    if (!latest) return res.json({ ok: true, node, known: false, stale: true, why: 'the station has never reported' });
    let tendency = null;
    let pressureDelta3h = null;
    if (!latest.stale) {
      const c = trend.changeOver(station.recent(node, nowMs - 4 * forecast.HOUR, nowMs), 'pressureHpa', nowMs);
      const t = trend.tendencyBand(c.delta3h);
      tendency = t ? t.word : null;
      pressureDelta3h = c.delta3h == null ? null : Math.round(c.delta3h * 100) / 100;
    }
    const r1 = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : null);
    res.json({
      ok: true,
      node,
      known: true,
      stale: latest.stale,
      observedAt: new Date(latest.observedAt).toISOString(),
      ageSeconds: Math.round(latest.ageMs / 1000),
      temperatureC: r1(latest.temperatureC),
      humidityPct: r1(latest.humidityPct),
      pressureHpa: r1(latest.pressureHpa),
      batteryMv: latest.batteryMv ?? null,
      rssi: latest.rssi ?? null,
      tendency,
      pressureDelta3h,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/weather/overview — the Weather screen: station readings bucketed for a range (hour|day|week|month|year) with the standing forecast aligned onto the same buckets, the latest reading and its staleness, and the 6/12/24 hour trend summary. Keywords: weather, temperature, humidity, pressure, forecast, outlook. Query: range, node
router.get('/overview', (req, res) => {
  try {
    const range = String(req.query.range || 'day');
    const nowMs = Date.now();
    const plan = station.bucketPlan(range, nowMs);
    // ⚠ Refused, never defaulted: a typo answered with a day of data looks like
    //   it answered the question that was asked.
    if (!plan) return res.status(400).json({ ok: false, error: `range must be one of ${Object.keys(station.RANGES).join(', ')}` });

    const nodes = station.nodes();
    const node = typeof req.query.node === 'string' && req.query.node ? req.query.node : station.defaultNode();
    const latest = station.latest(node, nowMs);
    const local = station.buckets(node, plan);

    const fc = forecast.standingBetween(plan.fromMs, plan.toMs, nowMs);
    const aligned = forecast.alignToBuckets(fc.points, plan);
    const series = local.map((l, i) => ({
      t: l.t,
      n: l.n,
      local: { temperatureC: l.temperatureC, humidityPct: l.humidityPct, pressureHpa: l.pressureHpa },
      forecast: aligned[i] ? { temperatureC: aligned[i].temperatureC, humidityPct: aligned[i].humidityPct, pressureHpa: aligned[i].pressureHpa } : null,
    }));

    // The summary reads its OWN windows, not the chart's: the last six hours of
    // minutes and the next day of forecast, whatever range is on screen.
    const ahead = forecast.standingBetween(nowMs, nowMs + 25 * forecast.HOUR, nowMs).points.filter((p) => p.validAt > nowMs - forecast.HOUR);
    const summary = trend.summarise({
      obs: station.recent(node, nowMs - 6 * forecast.HOUR, nowMs),
      forecast: ahead,
      nowMs,
      providerLabel: fc.label || 'the forecast',
      issuedAt: fc.lastIssuedAt ?? null,
      latestStale: latest ? latest.stale : true,
    });

    res.json({
      ok: true,
      range,
      ranges: Object.entries(station.RANGES).map(([id, r]) => ({ id, label: r.label })),
      node,
      nodes,
      latest,
      staleAfterMs: station.STALE_AFTER_MS,
      history: station.count(node),
      plan: { fromMs: plan.fromMs, toMs: plan.toMs, bucketMs: plan.bucketMs, nowMs },
      forecast: { provider: fc.provider, label: fc.label || null, lastIssuedAt: fc.lastIssuedAt ?? null, points: fc.points.length },
      series,
      summary,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/weather/forecast/refresh — take a forecast snapshot now rather than waiting for the hourly one. Keywords: weather forecast refresh. Body: { force }
router.post('/forecast/refresh', async (req, res) => {
  try {
    // Destructured from req.body directly so the MCP inventory can read the field.
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required (it may be {})' });
    const { force } = req.body;
    const r = await forecast.snapshot({ force: force === true });
    res.status(r.ok ? 200 : 502).json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── External sources (EA rain gauge, Weather Underground) ────────────────────

// GET /api/weather/sources — external weather source health: per source and feed the last successful ingest, ingestion lag, stale verdict, error count, retry/backoff state, backfill progress and stored coverage. Keywords: weather sources, rain gauge, Environment Agency, Weather Underground, source health, backfill.
router.get('/sources', (req, res) => {
  try {
    const nowMs = Date.now();
    const ext = require('../services/weather-external');
    const ea = require('../services/weather-ea');
    const wu = require('../services/weather-wu');
    const sh = require('../services/source-health');
    const spine = (sh.getSourceHealth({}).sources || []).filter((s) => String(s.sourceId).startsWith('weather.'));
    res.json({
      ok: true,
      nowMs,
      feeds: ext.health(nowMs),
      coverage: ext.coverage(),
      backfill: (ext.syncState(ea.STATION.sourceId, ea.FEED_HY) || {}).backfill || null,
      sourceHealth: spine,
      // The latest reading of each imported neighbour, for the Nearby stations
      // card. A configured station with no reading yet is listed with null.
      nearby: wu.nearby(nowMs),
      wu: { importStations: wu.importStations(), importBlocked: wu.importBlocked(), credentialSource: wu.credentialSource(), publish: wu.publishConfig() },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/weather/rainfall — rainfall for an external source (default the EA Mount St Bernards gauge ea:3641) as one series, choosing per instant between the live and qualified feeds and saying which answered and its quality flag. Gaps are absent, never zero. Keywords: rain, rainfall, rain gauge history. Query: source, period (900|86400), from, to (ISO or epoch ms)
router.get('/rainfall', (req, res) => {
  try {
    const source = typeof req.query.source === 'string' && req.query.source ? req.query.source : 'ea:3641';
    const period = Number(req.query.period || 900);
    if (![900, 86400].includes(period)) return res.status(400).json({ ok: false, error: 'period must be 900 or 86400' });
    const parse = (v) => (v == null || v === '' ? null : /^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v)));
    const nowMs = Date.now();
    const toMs = req.query.to != null ? parse(req.query.to) : nowMs + 1;
    const fromMs = req.query.from != null ? parse(req.query.from) : toMs - (period === 900 ? 2 : 90) * 86400000;
    // ⚠ Refused, never defaulted: an unparseable bound would silently widen the search.
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) return res.status(400).json({ ok: false, error: 'from/to must be valid and from < to' });
    const maxSpan = period === 900 ? 92 : 366 * 45;
    if (toMs - fromMs > maxSpan * 86400000) return res.status(400).json({ ok: false, error: `span too long for this period (max ${maxSpan} days)` });
    const points = require('../services/weather-external').canonicalRain(source, { periodS: period, fromMs, toMs });
    const total = points.reduce((a, p) => a + (p.rainMm || 0), 0);
    res.json({ ok: true, source, periodS: period, fromMs, toMs, count: points.length, totalMm: Math.round(total * 100) / 100, points });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/weather/sources/ea/sync — run an Environment Agency rain gauge sync now: feed live (Flood Monitoring), qualified (recent hydrology record) or backfill (walk history back a few chunks). Keywords: EA sync, rain gauge refresh, backfill rainfall history. Body: { feed, force, maxChunks }
router.post('/sources/ea/sync', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { feed, force, maxChunks } = req.body;
    const ea = require('../services/weather-ea');
    let r;
    if (feed === 'live') r = await ea.syncLive({ force: force === true });
    else if (feed === 'qualified') r = await ea.syncQualifiedRecent({ force: force === true });
    else if (feed === 'backfill') r = await ea.backfillStep({ maxChunks: Number.isInteger(maxChunks) && maxChunks > 0 && maxChunks <= 50 ? maxChunks : 4 });
    else return res.status(400).json({ ok: false, error: 'feed must be live | qualified | backfill' });
    res.json({ ok: r.ok !== false, result: r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/weather/sources/wu/sync — import the configured neighbouring Weather Underground stations now. Answers blocked (not an error) until WU_API_KEY is set. Keywords: Weather Underground import, PWS. Body: {}
router.post('/sources/wu/sync', async (req, res) => {
  try {
    const r = await require('../services/weather-wu').syncImport();
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/weather/nowcast — the local nowcast from the ring of neighbouring stations: wind the stations measure, rain upwind and its rough arrival window, the pressure consensus, each station's direction/distance/latest reading, and the track record of past rain calls. Read-only: only the scheduled pass records predictions. Keywords: nowcast, rain arriving, upwind, pressure trend, nearby stations.
router.get('/nowcast', async (req, res) => {
  try {
    const nc = require('../services/weather-nowcast');
    const loc = await forecast.location().catch(() => ({ known: false }));
    const home = loc && loc.known ? { lat: loc.latitude, lon: loc.longitude } : null;
    const out = nc.build({ home });
    // ⚠ Home's coordinates are used and never returned.
    res.json({ ok: true, ...out, record: nc.record() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/weather/wu/key — store the Weather Underground API key used to import neighbouring PWS stations. Answers only whether it was accepted and where the key now comes from; the value is never returned. Keywords: Weather Underground key, WU API key, settings. Body: { key }
router.post('/wu/key', (req, res) => {
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
  const { key } = req.body;
  const wu = require('../services/weather-wu');
  const r = wu.setStoredKey(key);
  if (!r.ok) return res.status(400).json(r);
  res.json({ ok: true, credentialSource: wu.credentialSource() });
});

// DELETE /api/weather/wu/key — forget the stored Weather Underground API key (an .env WU_API_KEY still wins). Keywords: Weather Underground key remove.
router.delete('/wu/key', (req, res) => {
  const wu = require('../services/weather-wu');
  res.json({ ...wu.clearStoredKey(), credentialSource: wu.credentialSource() });
});

// GET /api/weather/wu/publish/preview — the Weather Underground upload that WOULD be sent for the home station's newest reading, imperial units, station key redacted. Sends nothing. Keywords: Weather Underground publish, ICOALV59, upload preview. Query: node
router.get('/wu/publish/preview', (req, res) => {
  try {
    const node = typeof req.query.node === 'string' && req.query.node ? req.query.node : station.defaultNode();
    const latest = station.latest(node);
    const wu = require('../services/weather-wu');
    if (!latest) return res.json({ ok: false, reason: 'the home station has never reported', config: wu.publishConfig() });
    res.json({ ...wu.previewUpload(latest), node, stale: latest.stale, ageMs: latest.ageMs });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
