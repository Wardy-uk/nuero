// GET /api/telemetry — the raw Home Assistant telemetry snapshot (WS3-WP1).
//
// Operator/evidence surface only. The shared state model already folds telemetry into
// /api/state; this route exposes the bridge's cached snapshot directly so operators can
// see exactly what HA reported and whether it is live, without parsing the full model.
// It is read-only and decides nothing — HA stays a telemetry bus.
const express = require('express');
const ha = require('../telemetry/homeAssistant');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ ...ha.getTelemetry(), checkedAt: new Date().toISOString() });
});

module.exports = router;
