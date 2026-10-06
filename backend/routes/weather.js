'use strict';

/**
 * The outdoor weather station and its forecast overlay. Mounted at /api/weather
 * behind the PIN / API token like everything else.
 *
 *   POST /api/weather/observations      the Pi's forwarder (API token; ingest tier)
 *   GET  /api/weather/overview          one payload for the Weather screen
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

module.exports = router;
