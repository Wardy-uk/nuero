'use strict';

/**
 * Personal loops (Build 15S–X). One today: "hike weekly", which exists only
 * while that goal is active. Reads are open; Nick's own statements (a hike he
 * confirms, a hike he plans) are refused to machine clients by the authority
 * matrix — a machine must not be able to write a hike into his record.
 *
 *   GET  /api/loops/hiking                       the loop: this week, recent weeks, recording confidence
 *   POST /api/loops/hiking/confirm               { day, note? }   a hike happened (Nick)
 *   POST /api/loops/hiking/plan                  { day, note? }   a hike is planned (Nick)
 *   POST /api/loops/hiking/entries/:id/withdraw  take one back
 */

const express = require('express');
const loop = require('../services/hiking-loop');

const router = express.Router();

// GET /api/loops/hiking — the weekly hiking goal loop: planned vs recorded vs unknown, recording confidence, weather for a planned day.
router.get('/hiking', async (req, res) => {
  try {
    // Build 16M: ?weeks= reaches back (max 26) so a past hike can be confirmed.
    if (req.query.weeks !== undefined && (!/^\d{1,2}$/.test(String(req.query.weeks)) || +req.query.weeks < 1 || +req.query.weeks > loop.MAX_WEEKS)) {
      return res.status(400).json({ ok: false, error: 'weeks must be a whole number from 1 to 26' });
    }
    const r = loop.read({ weeks: req.query.weeks === undefined ? 6 : Number(req.query.weeks) });
    if (r.active && r.current) {
      const next = r.current.planned.find((p) => p.day >= r.today);
      if (next) {
        try {
          const w = await require('../services/ha-rooms').readDailyForecast();
          const day = w && w.known ? (w.days || []).find((d) => d.date === next.day) : null;
          r.current.weather = day ? { known: true, day: next.day, ...day } : { known: false, day: next.day, why: w && w.known ? 'that day is beyond the forecast' : ((w && w.why) || 'forecast unreadable') };
        } catch (e) {
          r.current.weather = { known: false, day: next.day, why: e.message };
        }
      }
    }
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/loops/hiking/confirm — Nick confirms a hike happened on a day (hike done, confirm hike).
router.post('/hiking/confirm', (req, res) => {
  const { day, note } = req.body;
  const r = loop.addEntry('confirm', { day, note });
  res.status(r.ok ? 200 : r.status || 400).json(r);
});

// POST /api/loops/hiking/plan — Nick plans a hike for a day (plan hike).
router.post('/hiking/plan', (req, res) => {
  const { day, note } = req.body;
  const r = loop.addEntry('plan', { day, note });
  res.status(r.ok ? 200 : r.status || 400).json(r);
});

// POST /api/loops/hiking/deny — Nick says a day was NOT a hike (not a hike, rule out hike); beats a GPS track.
router.post('/hiking/deny', (req, res) => {
  const { day, note } = req.body;
  const r = loop.addEntry('deny', { day, note });
  res.status(r.ok ? 200 : r.status || 400).json(r);
});

// POST /api/loops/hiking/denials/:id/withdraw — take back a "not a hike".
router.post('/hiking/denials/:id/withdraw', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'id must be a number' });
  const r = loop.withdrawDenial(id);
  res.status(r.ok ? 200 : r.status || 400).json(r);
});

// GET /api/loops/personal-dates — birthdays and anniversaries coming up (lead time, linked preparation, state). Explicit dates only.
router.get('/personal-dates', (req, res) => {
  try {
    res.json({ ok: true, ...require('../services/personal-dates').read() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/loops/personal-dates/lead — Nick sets how many days ahead a personal date shows (birthday lead time). Body: id, days (1-60, null = default).
router.post('/personal-dates/lead', (req, res) => {
  const { id, days } = req.body;
  const r = require('../services/personal-dates').setLead(id, days === null ? null : Number(days));
  res.status(r.ok ? 200 : r.status || 400).json(r);
});

// GET /api/loops/personal-dates/entities — the People and Companions notes a birthday or anniversary can be set on, with the dates each note declares now.
router.get('/personal-dates/entities', (req, res) => {
  try {
    const r = require('../services/personal-dates').declaredEntities();
    res.status(r.ok ? 200 : 503).json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/loops/personal-dates/declared — add, edit or remove a birthday/anniversary on a People or Companions note (Nick only). Body: entity (People/<Name>|Companions/<Name>), kind (birthday|anniversary), date (YYYY-MM-DD or MM-DD; null removes it).
router.post('/personal-dates/declared', (req, res) => {
  const { entity, kind, date } = req.body || {};
  if (date === undefined) return res.status(400).json({ ok: false, error: 'date is required (null removes the date)' });
  try {
    const r = require('../services/personal-dates').setDeclared({ entity, kind, date });
    res.status(r.ok ? 200 : r.status || 400).json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/loops/hiking/entries/:id/withdraw — take back a hike confirmation or plan.
router.post('/hiking/entries/:id/withdraw', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'id must be a number' });
  const r = loop.withdraw(id);
  res.status(r.ok ? 200 : r.status || 400).json(r);
});

module.exports = router;
