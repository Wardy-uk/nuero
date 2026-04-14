'use strict';

/**
 * Training Sync routes.
 *   POST /api/training/sync  { action: 'sync_all' | 'sync_person', person? }
 */

const express = require('express');
const router = express.Router();
const training = require('../services/training-sync');

router.post('/sync', async (req, res) => {
  try {
    const { action = 'sync_all', person } = req.body || {};
    const result = await training.syncTraining({ action, person });
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[training/sync]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
