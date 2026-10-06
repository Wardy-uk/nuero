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
    const r = loop.read({});
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

// POST /api/loops/hiking/entries/:id/withdraw — take back a hike confirmation or plan.
router.post('/hiking/entries/:id/withdraw', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'id must be a number' });
  const r = loop.withdraw(id);
  res.status(r.ok ? 200 : r.status || 400).json(r);
});

module.exports = router;
