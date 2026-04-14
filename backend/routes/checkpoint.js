'use strict';

/**
 * Checkpoint Progress routes.
 *   GET /api/checkpoint/:name  — :name = day-15 | day-30 | day-45 | day-60 | day-90
 */

const express = require('express');
const router = express.Router();
const checkpoint = require('../services/checkpoint-progress');

router.get('/:name', (req, res) => {
  try {
    const result = checkpoint.compareCheckpoint({ checkpoint: req.params.name });
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[checkpoint]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
