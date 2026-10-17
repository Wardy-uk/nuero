'use strict';

/**
 * /api/energy — home energy from Bright / Glowmarkt (services/energy.js).
 * Every GET is a read and writes nothing. The credential routes never return a
 * password or a token — only whether one is held and where it came from.
 */

const express = require('express');
const energy = require('../services/energy');
const glow = require('../services/energy-glowmarkt');
const model = require('../services/energy-model');

const router = express.Router();
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function _fuel(v) { return energy.FUELS.includes(v) ? v : null; }

// GET /api/energy — the Energy page: today, yesterday, this month vs last, estimated cost, freshness, backfill progress and connection health for electricity and gas (energy-v1)
router.get('/', (req, res) => {
  try {
    const days = req.query.days == null ? 30 : Number(req.query.days);
    if (!Number.isInteger(days) || days < 1 || days > 400) return res.status(400).json({ ok: false, error: 'days must be a whole number 1–400' });
    res.json({ ok: true, ...energy.read({ days }) });
  } catch (e) {
    console.error('[Energy] read failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/energy/daily — energy usage and estimated cost per day (Europe/London) for one fuel between two dates; gas days carry outdoor temperature and heating degree days
router.get('/daily', (req, res) => {
  const fuel = _fuel(req.query.fuel);
  const { from, to } = req.query;
  if (!fuel) return res.status(400).json({ ok: false, error: 'fuel must be electricity or gas' });
  if (!DAY_RE.test(String(from || '')) || !DAY_RE.test(String(to || ''))) return res.status(400).json({ ok: false, error: 'from and to must be YYYY-MM-DD' });
  if (from > to) return res.status(400).json({ ok: false, error: 'from is after to' });
  if (model.dayRange(from, to).length > 800) return res.status(400).json({ ok: false, error: 'at most 800 days per request' });
  try { res.json({ ok: true, fuel, days: energy.daily(fuel, from, to) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/energy/halfhourly — the half-hour energy readings for one fuel on one day; a slot Bright has no reading for is null, never zero
router.get('/halfhourly', (req, res) => {
  const fuel = _fuel(req.query.fuel);
  if (!fuel) return res.status(400).json({ ok: false, error: 'fuel must be electricity or gas' });
  if (!DAY_RE.test(String(req.query.day || ''))) return res.status(400).json({ ok: false, error: 'day must be YYYY-MM-DD' });
  try { res.json({ ok: true, fuel, day: req.query.day, slots: energy.halfHourly(fuel, req.query.day) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/energy/insights — energy analysis: household baseline, always-on electricity, gas against outdoor temperature (weather-normalised), heating efficiency trend, unusual days, weekly totals, missing data
router.get('/insights', (req, res) => {
  try { res.json({ ok: true, ...energy.insights() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/energy/tariffs — energy tariffs held, meter-reported and manual, with effective dates
router.get('/tariffs', (req, res) => {
  try { res.json({ ok: true, tariffs: energy.tariffs({ includeRemoved: req.query.all === '1' }), settings: { gasCalorificValue: energy.settings().gasCalorificValue ?? null } }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/energy/tariffs — add a manual energy tariff { fuel, effectiveFrom, unitRateP, standingPDay, label }; refused, never clamped
router.post('/tariffs', (req, res) => {
  const { fuel, effectiveFrom, unitRateP, standingPDay, label } = req.body || {};
  const r = energy.addManualTariff({ fuel, effectiveFrom, unitRateP, standingPDay, label });
  res.status(r.ok ? 200 : 400).json(r);
});

// POST /api/energy/tariffs/:id/remove — withdraw a manual energy tariff (kept on record); a meter tariff cannot be removed
router.post('/tariffs/:id/remove', (req, res) => {
  const r = energy.removeManualTariff(Number(req.params.id));
  res.status(r.ok ? 200 : r.status || 400).json(r);
});

// POST /api/energy/gas-calorific-value — set { cv } (MJ/m³ from the gas bill) used only if Bright ever reports gas in cubic metres; null clears it
router.post('/gas-calorific-value', (req, res) => {
  const { cv } = req.body || {};
  if (cv === undefined) return res.status(400).json({ ok: false, error: 'send cv (a number, or null to clear)' });
  const r = energy.setGasCalorificValue(cv);
  res.status(r.ok ? 200 : 400).json(r);
});

// GET /api/energy/connection — whether Bright is connected (never the password or token)
router.get('/connection', (req, res) => {
  res.json({ ok: true, connection: glow.authState() });
});

// POST /api/energy/credentials — connect Bright { username, password }: verified against Bright and stored on the Pi only if accepted; never returned
router.post('/credentials', async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const r = await glow.connect(username, password);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
    res.json({ ok: true, resources: r.resources, connection: glow.authState() });
  } catch (e) {
    res.status(502).json({ ok: false, error: `Bright did not answer: ${e.message}`, connection: glow.authState() });
  }
});

// DELETE /api/energy/credentials — disconnect Bright: forget the stored username, password and token (readings are kept)
router.delete('/credentials', (req, res) => {
  res.json({ ...glow.clearCredentials(), connection: glow.authState() });
});

// POST /api/energy/sync — run an energy sync from Bright now (the recent window; add {backfill:true} for a backfill step)
router.post('/sync', async (req, res) => {
  const { backfill } = req.body || {};
  try {
    const recent = await energy.syncRecent({ force: true });
    const bf = backfill ? await energy.backfillStep({ maxChunks: 4 }) : undefined;
    res.json({ ok: recent.ok !== false, recent, backfill: bf });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

module.exports = router;
