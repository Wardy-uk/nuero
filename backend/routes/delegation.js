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

// ── Delegating by hand (6 Nov 2026, services/task-delegation.js) ──────────────
// Registered before the /:id routes for readability; none of these shapes can
// match /:id/hand-over or /:id/dismiss.
const td = require('../services/task-delegation');

// GET /api/delegation/people — delegate tasks: Nick's direct reports he can hand work to, with email and any leave in the next 7 days.
router.get('/people', (req, res) => {
  try { res.json({ ok: true, people: td.people() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/delegation/tasks/pending — delegate tasks: hand-over emails prepared but not yet read back from Sent Items.
router.get('/tasks/pending', (req, res) => {
  try { td.reconcile(); res.json({ ok: true, pending: td.pending() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/delegation/tasks/draft — delegate tasks: the hand-over email for one or several tasks, nothing sent or recorded. Body: person, items [{kind: task|ms, id}].
router.post('/tasks/draft', (req, res) => {
  if (refuseMachine(req, res)) return;
  const { person, items } = req.body || {};
  const r = td.draft({ person, items });
  if (!r.ok) return res.status(r.code || 400).json(r);
  res.json(r);
});

// POST /api/delegation/tasks — delegate one or several tasks (NEURO or Microsoft) to a direct report as ONE delegation; they leave Tasks for Commitments → Delegated. Body: person, items [{kind: task|ms, id}], via (email|told), subject?, body?.
router.post('/tasks', (req, res) => {
  if (refuseMachine(req, res)) return;
  const { person, items, via, subject, body } = req.body || {};
  const r = td.delegate({ person, items, via, subject, body });
  if (!r.ok) return res.status(r.code || 400).json(r);
  res.json(r);
});

// POST /api/delegation/take-back — take delegated work back: reopens the tasks and drops the commitment. Body: key (the waiting-on key behind the commitment).
router.post('/take-back', (req, res) => {
  if (refuseMachine(req, res)) return;
  const { key } = req.body || {};
  const r = td.takeBack(key);
  if (!r.ok) return res.status(r.code || 400).json(r);
  res.json(r);
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
