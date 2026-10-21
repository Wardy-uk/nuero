'use strict';

// /api/promises — the delivery half of the meeting-promises loop (21 Oct 2026,
// selected from saim-meeting-promises). ONE door: prepare the governed email
// that delivers a promise. It never sends; the approval code in NEURO → Actions
// and the existing executor do. Machine-refused in the authority matrix and
// interactive in the MCP gateway.

const express = require('express');
const delivery = require('../services/promise-delivery');

const router = express.Router();

// POST /api/promises/:key/prepare — prepare the governed email that delivers one meeting promise (needs approval in Actions; never sends).
router.post('/:key/prepare', (req, res) => {
  const { to, move } = req.body || {};
  if (move !== undefined && move !== delivery.MOVE) return res.status(400).json({ ok: false, error: `only ${delivery.MOVE} is prepared here` });
  try {
    const r = delivery.prepare(req.params.key, { to });
    return r.ok ? res.json(r) : res.status(r.code || 400).json(r);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
