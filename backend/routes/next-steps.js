'use strict';

/**
 * /api/next-steps — everything pending in one list (services/next-steps.js).
 * Reads are open to every client; snoozing is Nick's, so machines are refused.
 */

const express = require('express');
const nextSteps = require('../services/next-steps');

const router = express.Router();

// GET /api/next-steps — next steps: every pending thing (emails to answer, the Monday report, drafts waiting, tasks due or overdue, 1-2-1s owed), grouped now / today / this week, plus what is snoozed and any source that could not be read.
router.get('/', (req, res) => {
  try {
    res.json(nextSteps.read());
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/next-steps/defer — snooze or "not today" a next step. Body: { id, minutes?, reason?, notToday? }. notToday = until tomorrow 08:00. Shares the attention record with Now and the Must Move lane. Nick only.
router.post('/defer', (req, res) => {
  if (req.apiClient) return res.status(403).json({ ok: false, error: 'Nick only' });
  try {
    const { id, minutes, reason, notToday } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    const mins = notToday ? nextSteps.minutesUntilTomorrowMorning() : minutes;
    const r = nextSteps.defer(String(id), { minutes: mins, reason: reason || 'not-now' });
    res.status(r.ok ? 200 : (r.status || 500)).json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/next-steps/undefer — bring a snoozed next step back now. Body: { id }. Nick only.
router.post('/undefer', (req, res) => {
  if (req.apiClient) return res.status(403).json({ ok: false, error: 'Nick only' });
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    const r = nextSteps.undefer(String(id));
    res.status(r.ok ? 200 : (r.status || 500)).json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
