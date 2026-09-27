'use strict';

/**
 * Environmental logger readings, and the hikes they belong to. Mounted at
 * /api/environment, behind the PIN like everything else.
 *
 * ⚠ ROUTE ORDER: literals only for now. Register literals before any
 * parameterised sibling (`routes/mobile.js` has the incident).
 */

const express = require('express');
const env = require('../services/environment');

const router = express.Router();

/**
 * POST /api/environment/readings
 * Body: `{ sensorId, model?, intervalSeconds?, readings: [{ t, tempC,
 *          humidityPct?, pressureHpa?, timingErrorSeconds? }] }`
 *
 * Idempotent on (sensorId, t). `duplicate` is reported beside `stored` — a
 * phone whose every reading is a duplicate is failing to clear its queue.
 */
router.post('/readings', (req, res) => {
  const v = env.validateBatch(req.body || {}, Math.floor(Date.now() / 1000));
  if (!v.ok) return res.status(400).json({ ok: false, error: v.reason });
  try {
    const { stored, duplicate } = env.store(v.sensorId, v.model, v.accepted, { intervalSeconds: v.intervalSeconds });
    // The cursor moves only AFTER the readings are stored, so a failure above
    // leaves it where it was and the next download fetches them again.
    let cursorMoved = null;
    if (v.cursor) {
      const lastT = v.accepted.length ? Math.max(...v.accepted.map((r) => r.t)) : null;
      cursorMoved = env.advanceCursor(v.sensorId, v.model, v.cursor, { source: v.source, lastT });
    }
    res.json({ ok: true, received: v.received, stored, duplicate, rejected: v.rejected, rejectedReasons: v.rejectedReasons, cursorMoved });
  } catch (e) {
    console.error('[Environment] ingest failed:', e.message);
    res.status(503).json({ ok: false, error: e.message, retryable: true });
  }
});

/**
 * GET /api/environment/readings?from=<unix s>&to=<unix s>
 *
 * The raw series for any window. This is the door for anything that knows a
 * walk's times but not a HealthKit workout — the website's Intervals.icu
 * activities, chiefly.
 */
router.get('/readings', (req, res) => {
  const from = Number(req.query.from);
  const to = Number(req.query.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
    return res.status(400).json({ ok: false, error: 'from and to must be unix seconds, with to after from' });
  }
  if (to - from > 7 * 86400) return res.status(400).json({ ok: false, error: 'window is limited to 7 days' });
  try {
    const readings = env.readingsBetween(from, to);
    res.json({ ok: true, readings, summary: env.summarise(readings) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/environment/sensors/:id — where NEURO has got to in a logger's log.
 *
 * `cursor: null` is a real answer — a logger never synced — and tells the
 * downloader to fetch everything.
 */
router.get('/sensors/:id', (req, res) => {
  try {
    const sensor = env.getSensor(String(req.params.id).slice(0, 64));
    res.json({ ok: true, cursor: sensor ? sensor.cursor : null, sensor });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/environment/hikes?days=60&types=Hiking,Walking
 *
 * HealthKit hikes, newest first, each with `conditions` (or `why` not).
 * `latestReadingAt` says whether the logger has been heard from at all, so
 * a list of hikes with no conditions can tell "logger silent" from "logger
 * not carried".
 */
router.get('/hikes', (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 60));
  const types = typeof req.query.types === 'string' && req.query.types.trim()
    ? req.query.types.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10)
    : env.HIKE_TYPES;
  try {
    res.json({ ok: true, ...env.hikes({ days, types }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
