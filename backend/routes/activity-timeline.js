'use strict';

/**
 * "What has NEURO done?" (Build 15D). READ-ONLY: every entry is normalised at
 * read time from records NEURO already keeps — see services/activity-timeline.
 *
 *   GET /api/activity/timeline           ?filter=&from=&to=&limit=
 *   GET /api/activity/timeline/summary   today's deterministic "Today NEURO…"
 */

const express = require('express');
const timeline = require('../services/activity-timeline');

const router = express.Router();

function _iso(v) {
  if (v === undefined || v === '') return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

// GET /api/activity/timeline — Activity: what NEURO noticed, investigated, decided, changed and verified (activity, audit, timeline, what has NEURO done).
router.get('/', (req, res) => {
  const { filter, from, to, limit } = req.query;
  const f = _iso(from); const t = _iso(to);
  if (f === undefined || t === undefined) return res.status(400).json({ ok: false, error: 'from / to must be dates' });
  if (filter && !timeline.FILTERS.includes(String(filter))) return res.status(400).json({ ok: false, error: `filter must be one of ${timeline.FILTERS.join(', ')}` });
  const n = limit === undefined ? 200 : Number(limit);
  if (!Number.isInteger(n) || n < 1 || n > 500) return res.status(400).json({ ok: false, error: 'limit must be 1–500' });
  try {
    res.json({ ok: true, ...timeline.read({ from: f, to: t, filter: filter || 'all', limit: n }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/activity/timeline/summary — Today NEURO: investigated, fixed, verified, prepared, uncertain (activity summary, today).
router.get('/summary', (req, res) => {
  try {
    const r = timeline.read({ filter: 'all', limit: 1 });
    res.json({ ok: true, today: r.today, gaps: r.gaps, pending: r.pending });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
