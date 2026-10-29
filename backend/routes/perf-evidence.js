'use strict';

/**
 * Performance evidence feed — read by VANTAGE's Performance Evidence section.
 *
 * GET /api/perf-evidence/candidates?from=YYYY-MM-DD&to=YYYY-MM-DD — performance evidence for VANTAGE: Nick's work in a window (tasks done late or overdue, wins, replies sent, management log, decisions, meeting write-ups). Read-only; judges nothing; each source says whether it answered. Window ≤31 days, refused not clamped.
 */

const express = require('express');
const router = express.Router();
const feed = require('../services/perf-evidence-feed');

// GET /api/perf-evidence/candidates — performance evidence for VANTAGE: Nick's own work in a window of at most 31 days (tasks overdue or done late, wins, replies sent, management log, decisions, meeting write-ups). Read-only; each source says whether it answered.
router.get('/candidates', (req, res) => {
  try {
    res.json(feed.candidates({ from: req.query.from, to: req.query.to }));
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
