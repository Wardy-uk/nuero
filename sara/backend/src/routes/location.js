// /api/location — Tier-2 station reporting (which terminal currently sees you).
//
// Terminals (this Pi's watch-presence bridge, future desk Pi, car) POST their presence
// here. SARA merges the active station into the shared model's `location` block alongside
// the Tier-1 GPS zone from Home Assistant. This is the client/server seam that lets
// Stage 2 (central NEURO server + many terminals) work with no model change.
//
// POST /api/location/station   body: { station, present, source?, rssi?, detail? }
// GET  /api/location/stations  -> all known terminals + which is active (debug/insight)
const express = require('express');
const stations = require('../state/stations');

const router = express.Router();

router.post('/station', (req, res) => {
  const body = req.body || {};
  if (!body.station || typeof body.station !== 'string') {
    return res.status(400).json({ ok: false, error: 'station (string) is required' });
  }
  if (typeof body.present !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'present (boolean) is required' });
  }
  const rec = stations.report(body);
  res.json({ ok: true, recorded: rec, active: stations.active() });
});

router.get('/stations', (_req, res) => {
  res.json({ stations: stations.list(), active: stations.active() });
});

module.exports = router;
