// GET /api/presence — compact "are you here?" signal for the kiosk auto-lock.
//
// The SARA frontend lock logic polls this (small payload) rather than the full
// /api/state, so a wall display can cheaply ask "should I lock?" on a tight interval.
// It is a thin read over the same Home Assistant telemetry snapshot the shared model
// already uses — it decides nothing and owns no state; the frontend decides whether to
// lock. HA stays a telemetry bus.
//
// `away` is the single boolean the client acts on:
//   true  -> SARA may auto-lock (you appear to have left)
//   false -> you're present
//   null  -> unknown (no proximity entity configured, HA down, or an unrecognised
//            state). The client MUST NOT auto-lock on null — only the idle-timeout
//            safety net should fire, so a blind signal can never lock you out.
const express = require('express');
const ha = require('../telemetry/homeAssistant');

const router = express.Router();

router.get('/', (_req, res) => {
  const t = ha.getTelemetry();
  const prox = t.available ? t.signals.proximity : null;
  res.json({
    source: t.source,
    available: t.available,
    reason: t.reason || null,
    away: prox ? prox.away : null,
    present: prox ? prox.present : null,
    proximity: prox || null,
    polledAt: t.polledAt || null,
    checkedAt: new Date().toISOString(),
  });
});

module.exports = router;
