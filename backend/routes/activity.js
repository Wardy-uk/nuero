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

// GET /api/activity/suggestions — pattern-based actionable suggestions
router.get('/suggestions', (req, res) => {
  try {
    const suggestions = activity.detectPatterns();
    res.json({ suggestions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/activity/suggestions/apply — apply a one-click suggestion
router.post('/suggestions/apply', (req, res) => {
  const { id, ...params } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const result = activity.applySuggestion(id, params);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/activity/rebuild-embeddings — manually trigger embedding rebuild
router.post('/rebuild-embeddings', async (req, res) => {
  try {
    const embeddings = require('../services/embeddings');
    res.json({ started: true });
    // Run in background
    embeddings.rebuildEmbeddings().then(result => {
      console.log('[Embeddings] Manual rebuild complete:', result);
    }).catch(e => {
      console.error('[Embeddings] Manual rebuild error:', e.message);
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/activity/vault-sync — vault sync status
router.get("/vault-sync", (req, res) => {
  res.json({ enabled: true, mode: "syncthing", note: "Managed externally via Syncthing over Tailscale" });
});

// POST /api/activity/vault-sync — no-op (syncthing manages sync)
router.post("/vault-sync", (req, res) => {
  res.json({ ok: true, mode: "syncthing", note: "Sync is managed by Syncthing — no manual trigger needed" });
});

module.exports = router;
