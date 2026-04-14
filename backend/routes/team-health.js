'use strict';

/**
 * Team Health routes.
 *   GET /api/team-health            -- all teams, prioritised issues
 *   GET /api/team-health?team=...   -- filter to one team
 */

const express = require('express');
const router = express.Router();
const teamHealth = require('../services/team-health');

router.get('/', (req, res) => {
  try {
    const team = req.query.team ? String(req.query.team) : undefined;
    const result = teamHealth.teamHealthSnapshot({ team });
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[team-health]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/teams', (_req, res) => {
  res.json({ ok: true, teams: Object.keys(teamHealth.TEAMS) });
});

module.exports = router;
