'use strict';

/**
 * The shared AI budget gate's profile (22 Oct 2026) — READ ONLY.
 *
 *   GET /api/ai-gate/profile[?day=YYYY-MM-DD] — today's (London) shared NEURO + VANTAGE AI
 *     spend from the shared ledger: per call class, per app, Radar's share, every
 *     refusal reason the gate WOULD have applied, unpriced models, 14-day history.
 *
 * Shadow mode only: nothing here sets a cap or changes the mode. There is no
 * daily cap until Nick chooses one.
 */

const express = require('express');
const router = express.Router();
const gate = require('../services/ai-gate');
const { CLASS_NAMES } = require('../services/ai-gate-classes');

// GET /api/ai-gate/profile — AI budget, AI spend today, shared NEURO and VANTAGE model/embedding/TTS spend by call class, Radar share, shadow refusal reasons, unknown prices (read-only; no daily cap is set)
router.get('/profile', (req, res) => {
  const { day } = req.query;
  if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(day))) {
    return res.status(400).json({ ok: false, error: 'day must be YYYY-MM-DD' });
  }
  try {
    res.json({ ...gate.profile({ day: day || null }), neuroClasses: CLASS_NAMES.length, peer: require('../services/ai-gate-peer').last() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
