'use strict';

/**
 * Leave guard routes (21 Oct 2026) — see services/leave-guard.js.
 *   GET  /api/leave/clashes              the stored review card
 *   POST /api/leave/clashes/refresh      recompute it now
 *   POST /api/leave/clashes/apply        { ids, edits? }  (machine-refused)
 *   POST /api/leave/clashes/done         { ids }  confirmed or dismissed on the card
 *   POST /api/leave/auto-decline/run     run the switch-gated decline pass now (machine-refused)
 */

const express = require('express');
const router = express.Router();
const guard = require('../services/leave-guard');

// GET /api/leave/clashes — what already in the diary or task list clashes with Nick's booked leave (holiday, annual leave, out of office), and the proposed fix for each.
router.get('/clashes', (req, res) => {
  try {
    const a = guard.stored();
    res.json({ ok: true, ...(a || { items: [], periods: [], computedAt: null, leaveKnown: null }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/leave/clashes/refresh — recompute the leave clash card now (holiday, annual leave). Reads only; changes nothing.
router.post('/clashes/refresh', async (req, res) => {
  try {
    res.json({ ok: true, ...(await guard.refresh()) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/leave/clashes/apply — apply the ticked fixes from the leave clash card: move tasks and blocks, decline others' meetings, prepare moves/cancels of Nick's meetings for the screen to confirm. Refuses machine clients. Body: { ids: [item ids], edits?: { [id]: { date } | { start, end } } }
router.post('/clashes/apply', async (req, res) => {
  if (req.apiClient) return res.status(403).json({ ok: false, error: 'Rearranging your diary around leave tells other people — it needs you, in NEURO.' });
  try {
    const { ids, edits } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ ok: false, error: 'ids (array) is required' });
    res.json(await guard.apply({ ids, edits: edits && typeof edits === 'object' ? edits : {} }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/leave/clashes/done — drop items from the leave clash card once confirmed or dismissed. Body: { ids: [item ids] }
router.post('/clashes/done', (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ ok: false, error: 'ids (array) is required' });
  res.json(guard.markDone(ids));
});

// POST /api/leave/auto-decline/run — run the auto-decline pass for invites on Nick's leave days now (only while the Settings switch is on). Refuses machine clients.
router.post('/auto-decline/run', async (req, res) => {
  if (req.apiClient) return res.status(403).json({ ok: false, error: 'Declining invites as you needs you, in NEURO.' });
  try {
    res.json(await guard.autoDecline());
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
