'use strict';

/**
 * Build 27 — /api/transport: Life → Transport. Read-only. What the car is, what
 * it needs, Tally's figures for what it costs, the driving state now (never
 * stored), each source on its own line, and anything that needs Nick under the
 * existing rules. Writes stay on /api/vehicle.
 */

const express = require('express');
const router = express.Router();

// GET /api/transport — the transport view: vehicle, MOT/tax/insurance/service, odometer, maintenance, tyres, fuel/MPG, Tally vehicle cost, cost per mile, driving state, source health. Keywords: car, Captur, transport, MOT, vehicle cost.
router.get('/', async (req, res) => {
  try { res.json(await require('../services/transport').read()); } catch (e) { console.error('[Transport]', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
