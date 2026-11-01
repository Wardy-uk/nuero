'use strict';

// Delegation prompts (1 Nov 2026) — services/delegation.js.
//   GET  /api/delegation                     open suggestions (≤3), each with its hand-over draft
//   POST /api/delegation/scan                judge new candidates now (spends model calls)
//   POST /api/delegation/:id/hand-over       {subject?, body?} → a governed compose_email (origin delegation)
//   POST /api/delegation/:id/dismiss         "Not this one"
// Every POST is machine-refused in the authority matrix and interactive in the
// MCP gateway: what goes to whom is Nick's call, on his screen.

const express = require('express');
const delegation = require('../services/delegation');

const router = express.Router();

const refuseMachine = (req, res) => {
  if (req.apiClient || req.get('X-Neuro-Machine-Client')) { res.status(403).json({ ok: false, error: 'Handing work over is Nick’s call, in NEURO.' }); return true; }
  return false;
};

router.get('/', (req, res) => {
  try {
    const out = delegation.list();
    const kind = req.query.kind; const id = req.query.id;
    if (kind && id) out.suggestions = out.suggestions.filter((s) => s.kind === kind && String(s.itemId) === String(id));
    res.json({ ok: true, ...out });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/delegation/scan — delegation prompts: judge new emails and tasks for a hand-over now.
router.post('/scan', async (req, res) => {
  if (refuseMachine(req, res)) return;
  try { res.json({ ok: true, ...(await delegation.scan()) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/delegation/:id/hand-over — delegation prompts: prepare the hand-over email to the direct report.
router.post('/:id/hand-over', (req, res) => {
  if (refuseMachine(req, res)) return;
  const { subject, body } = req.body || {};
  const r = delegation.handOver(req.params.id, { subject, body });
  if (!r.ok) return res.status(r.code || 400).json(r);
  res.json(r);
});

// POST /api/delegation/:id/dismiss — delegation prompts: "Not this one".
router.post('/:id/dismiss', (req, res) => {
  if (refuseMachine(req, res)) return;
  const r = delegation.dismiss(req.params.id);
  if (!r.ok) return res.status(r.code || 400).json(r);
  res.json(r);
});

module.exports = router;
