'use strict';

/**
 * Knowledge Gaps routes.
 *   GET /api/knowledge-gaps?topic=...&daysBack=90
 */

const express = require('express');
const router = express.Router();
const gaps = require('../services/knowledge-gaps');

router.get('/', (req, res) => {
  try {
    const topic = req.query.topic ? String(req.query.topic) : undefined;
    const daysBack = req.query.daysBack ? parseInt(req.query.daysBack, 10) : 90;
    const result = gaps.findKnowledgeGaps({ topic, daysBack });
    if (result.status === 'error') return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[knowledge-gaps]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
