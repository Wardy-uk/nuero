'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const activity = require('../services/activity');

// POST /api/activity/tab — track tab open
router.post('/tab', (req, res) => {
  const { tab } = req.body;
  if (!tab) return res.status(400).json({ error: 'tab required' });
  try {
    activity.trackTabOpen(tab);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/activity/summaries — last N days of daily summaries
router.get('/summaries', (req, res) => {
  const days = parseInt(req.query.days || '14', 10);
  try {
    const summaries = db.getDailySummaries(days);
    // Also include today's live summary
    const todayKey = new Date().toISOString().split('T')[0];
    const today = activity.buildDailySummary(todayKey);
    res.json({ summaries, today });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/activity/today — today's raw activity log
router.get('/today', (req, res) => {
  try {
    const events = db.getTodayActivity();
    res.json({ events });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
