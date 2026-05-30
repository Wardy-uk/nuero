'use strict';

const express = require('express');
const router = express.Router();
const ha = require('../services/ha');

// GET /api/ha/status — is the integration configured
router.get('/status', (req, res) => {
  res.json({ configured: ha.isConfigured() });
});

// GET /api/ha/phone — phone + presence snapshot from the Companion app
router.get('/phone', async (req, res) => {
  if (!ha.isConfigured()) {
    return res.status(400).json({ error: 'HA not configured (HA_URL / HA_TOKEN)' });
  }
  try {
    const phone = await ha.getPhoneStatus();
    res.json({ phone });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ha/states — all HA entity states (optionally filter by ?domain=sensor)
router.get('/states', async (req, res) => {
  if (!ha.isConfigured()) {
    return res.status(400).json({ error: 'HA not configured (HA_URL / HA_TOKEN)' });
  }
  try {
    let states = await ha.getStates();
    const { domain } = req.query;
    if (domain) states = states.filter(e => e.entity_id.startsWith(`${domain}.`));
    res.json({ count: states.length, states });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
