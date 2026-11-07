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
    const r = report.compose({ week });
    // The four weeks before, for "about a month" of time saved. Each is the
    // same compose(); a week that cannot be read is null, never 0.
    if (r.known !== false && r.week) {
      r.recentWeeks = [];
      for (let i = 1; i <= 4; i++) {
        const monday = report.mondayOf(new Date(Date.parse(`${r.week.monday}T12:00:00Z`) - i * 7 * 86400000).toISOString().slice(0, 10));
        try {
          const w = report.compose({ week: monday });
          r.recentWeeks.push({ monday, label: w.week.label, minutes: w.timeSaved ? w.timeSaved.minutes : null, acted: w.acted });
        } catch { r.recentWeeks.push({ monday, label: monday, minutes: null, acted: null }); }
      }
      const known = [r.timeSaved, ...r.recentWeeks].filter((x) => x && Number.isFinite(x.minutes));
      const sum = known.reduce((s, x) => s + x.minutes, 0);
      r.fiveWeekSaved = { minutes: Math.round(sum * 10) / 10, words: require('../services/time-saved').words(sum), weeks: known.length, estimated: true };
    }
    res.json(r);
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// GET /api/activity/weekly-report/estimates — the minutes NEURO counts per kind of thing it did for you (time saved estimates; editable).
router.get('/estimates', (req, res) => {
  res.json({ ok: true, estimates: require('../services/time-saved').estimates() });
});

// POST /api/activity/weekly-report/estimates — set how many minutes one kind of action saves you (time saved estimate), or null to reset it to NEURO's default.
router.post('/estimates', (req, res) => {
  const { area, minutes } = req.body;
  try {
    res.json({ ok: true, estimates: require('../services/time-saved').setEstimate(String(area || ''), minutes === undefined ? NaN : minutes) });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
