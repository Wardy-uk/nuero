'use strict';

// /api/promises — the delivery half of the meeting-promises loop (21 Oct 2026,
// selected from saim-meeting-promises). ONE door: prepare the governed email
// that delivers a promise. It never sends; the approval code in NEURO → Actions
// and the existing executor do. Machine-refused in the authority matrix and
// interactive in the MCP gateway.

const express = require('express');
const delivery = require('../services/promise-delivery');

const router = express.Router();

// GET /api/promises/workflow — the Task workflow screen's read (31 Oct 2026): a task row and, if it is a promise, the same Keep my word thread Now composes (delivery note, prepared move, evidence). Read-only. ?taskId=N and/or ?key=promise:N.
router.get('/workflow', (req, res) => {
  const { taskId, key } = req.query || {};
  if (!taskId && !key) return res.status(400).json({ ok: false, error: 'taskId or key is required' });
  try {
    const r = require('../services/task-workflow').read({ taskId: taskId || null, key: key || null });
    if (!r) return res.status(404).json({ ok: false, error: 'No such task or open promise.' });
    return res.json({ ok: true, ...r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

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
