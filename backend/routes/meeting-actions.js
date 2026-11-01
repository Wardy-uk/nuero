'use strict';

// Earned auto-filing of meeting actions (1 Nov 2026) — see
// services/meeting-actions-gate.js. Undo is Nick's press: machine-refused.

const express = require('express');
const gate = require('../services/meeting-actions-gate');

const router = express.Router();

// GET /api/meeting-actions/gate — whether meeting actions are filed straight to tasks or for review, and the approval rate over the last 20 decided.
router.get('/gate', (req, res) => {
  try { res.json({ ok: true, ...gate.state() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/meeting-actions/auto-filed/:taskId/undo — drop a meeting action NEURO filed automatically; within 7 days it counts against auto-filing.
router.post('/auto-filed/:taskId/undo', (req, res) => {
  const r = gate.undo(Number(req.params.taskId));
  return r.ok ? res.json(r) : res.status(r.code || 400).json(r);
});

module.exports = router;
