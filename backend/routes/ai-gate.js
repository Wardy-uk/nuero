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
const { CLASS_NAMES, SETTABLE, MAX_LIMIT, limitOf, setClassLimit } = require('../services/ai-gate-classes');

// GET /api/ai-gate/profile — AI budget, AI spend today, shared NEURO and VANTAGE model/embedding/TTS spend by call class, Radar share, shadow refusal reasons, unknown prices (read-only; no daily cap is set)
router.get('/profile', (req, res) => {
  const { day } = req.query;
  if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(day))) {
    return res.status(400).json({ ok: false, error: 'day must be YYYY-MM-DD' });
  }
  try {
    const classLimits = Object.fromEntries(SETTABLE.map((c) => [c, { maxPerDay: limitOf(c), max: MAX_LIMIT }]));
    res.json({ ...gate.profile({ day: day || null }), neuroClasses: CLASS_NAMES.length, classLimits, peer: require('../services/ai-gate-peer').last() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/ai-gate/class-limit — Nick sets or clears ONE class's daily model-request limit (body.callClass, body.maxPerDay: 1..1000 or null). Only task_agent is settable. In shadow mode the gate records a limit and does not block; only AI_GATE_MODE=enforce refuses. Owner only.
router.post('/class-limit', (req, res) => {
  try {
    if (require('../services/task-context').viewerOf(req) !== 'owner') return res.status(403).json({ ok: false, error: 'Only Nick, in NEURO → Settings, can change an AI limit.' });
    const { callClass, maxPerDay } = req.body;
    const extra = Object.keys(req.body || {}).filter((k) => !['callClass', 'maxPerDay'].includes(k));
    if (extra.length) return res.status(400).json({ ok: false, error: `Unexpected field: ${extra.join(', ')}` });
    if (!('maxPerDay' in (req.body || {}))) return res.status(400).json({ ok: false, error: 'maxPerDay is required (a number, or null to remove the limit)' });
    const r = setClassLimit(String(callClass || ''), maxPerDay);
    if (!r.ok) return res.status(r.status || 400).json(r);
    try { require('../db/database').logActivity('ai_gate_class_limit', { callClass: r.callClass, maxPerDay: r.maxPerDay }); } catch { /* never fails the save */ }
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
