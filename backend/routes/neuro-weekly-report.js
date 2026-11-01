'use strict';

/**
 * "What NEURO did for you" — the weekly report. READ-ONLY.
 *
 *   GET /api/activity/weekly-report?week=YYYY-MM-DD   (a London Monday; default
 *                                                     the last complete week)
 */

const express = require('express');
const report = require('../services/neuro-weekly-report');

const router = express.Router();

// GET /api/activity/weekly-report — What NEURO did for you: everything NEURO did on its own in one week (auto-booked 1-2-1s, Outlook archive, lapsed waiting-on, expired Spotted, ticket drafts, auto-confirmed promises, focus blocks, leave declines, router restarts, self-heal, notifications) plus the misfires to check (weekly report, autonomy, trust).
router.get('/', (req, res) => {
  const week = req.query.week === undefined || req.query.week === '' ? null : String(req.query.week);
  if (week !== null && !report.isMonday(week)) return res.status(400).json({ ok: false, error: 'week must be a Monday, YYYY-MM-DD' });
  try {
    res.json(report.compose({ week }));
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
