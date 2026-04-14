'use strict';

/**
 * Evidence Register routes.
 *   GET  /api/evidence            — list all outcomes + rows
 *   POST /api/evidence            — { action: 'add'|'update'|'list', outcome, evidence, location?, checkpoint? }
 */

const express = require('express');
const router = express.Router();
const evidence = require('../services/evidence-register');

router.get('/', (_req, res) => {
  try {
    const result = evidence.listEvidence();
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[evidence GET]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/', (req, res) => {
  try {
    const result = evidence.manageEvidence(req.body || {});
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[evidence POST]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
