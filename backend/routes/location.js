'use strict';

const express = require('express');
const router = express.Router();
const location = require('../services/location');

// GET /api/location/today — today's dwell summary
router.get('/today', async (req, res) => {
  try {
    const dwells = await location.getCachedDwells();
    res.json({ dwells, configured: location.isConfigured() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/location/status
router.get('/status', (req, res) => {
  res.json({ configured: location.isConfigured() });
});

module.exports = router;
