'use strict';

/**
 * Action Items routes.
 *   GET /api/vault-actions?person=Heidi+Power&status=open&daysBack=90
 */

const express = require('express');
const router = express.Router();
const actionItems = require('../services/action-items');

router.get('/', (req, res) => {
  try {
    const person = req.query.person ? String(req.query.person) : undefined;
    const status = req.query.status ? String(req.query.status) : 'open';
    const daysBack = req.query.daysBack ? parseInt(req.query.daysBack, 10) : 90;
    const items = actionItems.findActionItems({ person, status, daysBack });
    res.json({ ok: true, count: items.length, items });
  } catch (e) {
    console.error('[vault-actions]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
