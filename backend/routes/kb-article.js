'use strict';

/**
 * KB Article routes.
 *   POST /api/kb-article  { action: 'create'|'update', title, category?, content?, tags?, force? }
 */

const express = require('express');
const router = express.Router();
const kb = require('../services/kb-article');

router.post('/', (req, res) => {
  try {
    const result = kb.manageKbArticle(req.body || {});
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[kb-article]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
