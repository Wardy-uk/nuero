'use strict';

/**
 * /api/focus — RETIRED (Build 10O, 3 Oct 2026).
 *
 * It was the legacy decision-engine surface: a cached ranking, a SAiM line, a
 * suppression TIMER (dismiss / snooze / hide-today) and `action-done`, which
 * logged an outcome at the moment work started. Every responsibility now lives
 * in one canonical place:
 *
 *   what matters now        → GET /api/attention   (or /api/canonical/now)
 *   seen / not now / done   → POST /api/attention/records/:id/act
 *   is this PIN right?      → GET /api/auth/check  (the phone lock screen
 *                             borrowed /api/focus only because it answered 401)
 *   Actions-queue suggestions → the agent loop's own clock (they were produced
 *                             as a side effect of whoever polled this route)
 *
 * Six callers were migrated first (desktop Briefing, Focus and the attention
 * fallback; SAiM Focus, Surface fallback and LockScreen; the kiosk state
 * provider and snapshot poller; the local MCP get_focus tool). Anything still
 * calling — an old iOS build until the Mac rebuild — gets a 410 that names the
 * replacement, never a stale ranking that looks current.
 */

const express = require('express');
const router = express.Router();

const RETIRED = Object.freeze({
  ok: false,
  retired: true,
  error: '/api/focus is retired',
  use: {
    now: '/api/attention',
    nowWithWorld: '/api/canonical/now',
    act: '/api/attention/records/:id/act',
    pinCheck: '/api/auth/check',
  },
});

router.all('*', (req, res) => {
  res.status(410).json(RETIRED);
});

module.exports = router;
module.exports.RETIRED = RETIRED;
