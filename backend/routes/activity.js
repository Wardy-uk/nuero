'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const activity = require('../services/activity');

// POST /api/activity/tab — track a screen open.
//
// Called by the NEURO desktop, by SAiM (phone, Pi kiosk and the laptop Electron
// window, all through one `goTab`) and by VANTAGE's own recorder. It feeds
// `GET /api/screen-usage`. `surface` is optional — see `activity.trackTabOpen`
// for why a missing one is accepted and an unrecognised one is refused.
router.post('/tab', (req, res) => {
  const { tab, surface } = req.body;
  if (!tab) return res.status(400).json({ error: 'tab required' });
  if (surface != null && !activity.SURFACES.has(surface)) {
    // 400, not a silent re-file: a client sending a surface nobody renders
    // should hear about it rather than have its opens appear under NEURO's.
    return res.status(400).json({
      error: `unknown surface "${surface}"`,
      known: [...activity.SURFACES],
    });
  }
  try {
    activity.trackTabOpen(tab, surface);
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

// GET /api/activity/embeddings-health — what the embedding path actually did.
//
// #56 — Voyage bypasses ai-routing, so it has no budget, no telemetry and no
// place on the AI panel; a failure was visible only as a console.warn nobody
// reads. It timed out on 13 Aug and the sole symptom was vault search quietly
// getting worse. `status` distinguishes not-configured / unprobed / degraded /
// ok, because "we have not called it yet" is not the same claim as "it works" —
// the same distinction getBridgeHealth draws for the NOVA bridge (#65).
router.get('/embeddings-health', (req, res) => {
  try {
    const embeddings = require('../services/embeddings');
    const db = require('../db/database');
    const health = embeddings.getEmbeddingHealth();

    // Rows a failed call left behind in an earlier version: real content hash,
    // fallback vector, so the rebuild skips them and every query scores them 0.
    let unreachableRows = 0;
    const unreachableFiles = new Set();
    if (health.configured) {
      for (const row of db.getAllEmbeddings()) {
        if (embeddings._storedIsReal(row)) continue;
        unreachableRows++;
        unreachableFiles.add(row.relative_path);
      }
    }

    res.json({
      ...health,
      unreachableRows,
      unreachableFiles: unreachableFiles.size,
      // Nothing self-heals these — they carry a valid hash. The next rebuild
      // sweeps them, so say so rather than leaving a bare number on screen.
      remedy: unreachableRows
        ? 'POST /api/activity/rebuild-embeddings — the sweep re-embeds these files'
        : null,
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
