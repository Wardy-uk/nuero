'use strict';

/**
 * Weekly Summary routes.
 *   GET /api/weekly-summary?weekStarting=YYYY-MM-DD
 */

const express = require('express');
const router = express.Router();
const weekly = require('../services/weekly-summary');

router.get('/', (req, res) => {
  try {
    const weekStarting = req.query.weekStarting ? String(req.query.weekStarting) : undefined;
    const result = weekly.summarizeWeek({ weekStarting });
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[weekly-summary]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
