'use strict';

/**
 * The nervous system, observed (Build 1). READ-ONLY.
 *
 * Counts, lag, failures and the SourceHealth projection — never event payloads,
 * and no controls. Replay is deliberately not a route: it is
 * `backend/scripts/events-replay.js`, run by hand on the Pi, because a rebuild
 * is an operator's act and nothing on a screen needs to be able to start one.
 *
 * Behind the PIN like every other /api route.
 */

const express = require('express');
const router = express.Router();
const bus = require('../services/event-bus');
const sourceHealth = require('../services/source-health');

// GET /api/events/status — event backbone health: event count, newest event, consumer lag, failed and dead-lettered events
router.get('/status', (req, res) => {
  try {
    res.json({ ok: true, ...bus.getStatus(), sourceHealth: sourceHealth.getSourceHealth().projection });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/events/source-health — the SourceHealth projection: is each source working, fresh or stale, and when it last succeeded
router.get('/source-health', (req, res) => {
  try {
    res.json({ ok: true, ...sourceHealth.getSourceHealth() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
