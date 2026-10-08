'use strict';

const express = require('express');
const household = require('../services/household');

const router = express.Router();

// GET /api/household — who's in the house: Nick, the people who live here, visitors (Lizzy, Daniel) and Ember, each home / away / unknown / untracked from Home Assistant presence, with whether a photo exists. Unknown when presence cannot be read, never away.
router.get('/', (req, res) => {
  try { res.json(household.read()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/household/home — household/home read model: occupancy (occupied/empty/unknown, conservative), household tasks classified as Home, dated home items from the Radar, Home Assistant's device watchdog, hazard-sensor capability, source health. Keywords: home, house, household, occupancy, chores, batteries.
router.get('/home', async (req, res) => {
  try { res.json(await require('../services/home').read({ live: true })); } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/household/photo/:id — one household member's photo (served from outside the repo, behind the PIN). 404 when none has been added.
router.get('/photo/:id', (req, res) => {
  const f = household.photoFile(req.params.id);
  if (!f) return res.status(404).json({ error: 'no photo' });
  res.set('Cache-Control', 'private, max-age=86400');
  res.type(f.ext === 'jpg' ? 'jpeg' : f.ext);
  res.sendFile(f.path);
});

module.exports = router;
