'use strict';

/**
 * Training Sync routes.
 *
 *   POST /api/training/apply-matrix
 *     Body: { categories[], items[], scores[], memberIds[], users[] }
 *     Auth: X-Neuro-Api-Token (machine clients only — rejects interactive PIN)
 *
 * n8n fetches data from NOVA (/api/public/training-export) on a nightly
 * schedule and POSTs it here to write into the vault.
 */

const express = require('express');
const router = express.Router();
const training = require('../services/training-sync');

router.post('/apply-matrix', (req, res, next) => {
  // Enforce machine auth — reject if caller used only the interactive PIN.
  const guard = req.app.locals.requireApiClient;
  if (typeof guard === 'function') return guard(req, res, next);
  return next();
}, (req, res) => {
  try {
    const result = training.applyMatrixToVault(req.body || {});
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[training/apply-matrix]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
