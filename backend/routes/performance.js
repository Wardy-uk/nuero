'use strict';

/**
 * Recovery, exertion and what the logger adds — NEURO's Athlytic-style reads.
 * Mounted at /api/performance, behind the PIN.
 *
 * Its own mount rather than more routes on /api/health, which is already long and
 * is the router other work is changing; a separate door keeps the two from
 * colliding and says what this group is for.
 *
 * ⚠ ROUTE ORDER: literals only. Register literals before any parameterised
 * sibling (routes/mobile.js has the incident).
 */

const express = require('express');
const exertion = require('../services/exertion');
const insights = require('../services/performance-insights');

const router = express.Router();

const guard = (fn) => (req, res) => {
  try { res.json({ ok: true, ...fn(req) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
};

/** GET /api/performance/today — recovery, exertion so far, load, the suggestion. */
router.get('/today', guard(() => exertion.summary()));

/** GET /api/performance/exertion?days=60 — the daily rows, newest first. */
router.get('/exertion', guard((req) => {
  const days = Math.min(800, Math.max(1, parseInt(req.query.days, 10) || 60));
  const rows = exertion.recent(days);
  return { days: rows, trainingLoad: exertion.trainingLoad(rows.filter((r) => r.complete)) };
}));

/**
 * POST /api/performance/exertion/rebuild  { days }
 * Re-roll a window (the hourly job covers 10 days). Idempotent.
 */
router.post('/exertion/rebuild', guard((req) => {
  const days = Math.min(800, Math.max(1, parseInt(req.body && req.body.days, 10) || 30));
  return exertion.sync({ days });
}));

/** GET /api/performance/fitness — VO2 max and walking heart rate as a trend. */
router.get('/fitness', guard(() => insights.loadCardioFitness()));

/** GET /api/performance/sleep-environment — the logger's room against sleep. */
router.get('/sleep-environment', guard((req) => {
  const source = ['radiator', 'logger'].includes(req.query.source) ? req.query.source : null;
  return insights.loadSleepEnvironment({ source });
}));

/**
 * POST /api/performance/bedroom/sync  { all?: true }
 * Copy the bedroom radiator's hourly statistics from Home Assistant. The hourly
 * job takes the last three days; `all` takes everything HA holds.
 */
router.post('/bedroom/sync', async (req, res) => {
  try {
    const r = await require('../services/bedroom-climate').sync({ days: req.body && req.body.all === true ? null : 3 });
    res.status(r.ok ? 200 : 503).json(r);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/performance/logger-location  { label, since: 'YYYY-MM-DD' }
 * Where the logger lives. Only nights after `since` are compared with sleep.
 */
router.post('/logger-location', (req, res) => {
  const r = insights.setLoggerLocation(req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});

/** GET /api/performance/heat-cost — effort against the heat, across carried hikes. */
router.get('/heat-cost', guard(() => insights.loadHeatCost()));

module.exports = router;
