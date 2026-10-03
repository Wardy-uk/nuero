'use strict';

/**
 * Prepared actions (Build 5E) — what NEURO has drafted for Nick to approve.
 *
 * ⚠ Approval RECORDS a decision. In Build 5 nothing executes a prepared
 * action: this router imports no sender, and the table refuses `executed`.
 */

const express = require('express');

const router = express.Router();
const pa = () => require('../services/prepared-actions');

// GET /api/prepared-actions — drafts NEURO has prepared for approval (prepared action, follow-up draft, chase draft, approval queue): what it wants to do, for which commitment-at-risk finding, to whom, why, the evidence, the exact draft, authority A4, approval required, age and status. Nothing here is ever sent. ?status=prepared|approved|rejected|expired|cancelled&limit=50
router.get('/', (req, res) => {
  try {
    const status = pa().STATUSES.includes(req.query.status) ? req.query.status : null;
    res.json({ ok: true, executes: false, actions: pa().list({ status, limit: req.query.limit }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/prepared-actions/:id — one prepared action with its evidence, draft and decision history
router.get('/:id', (req, res) => {
  try {
    const a = pa().get(req.params.id);
    if (!a) return res.status(404).json({ ok: false, error: 'no such prepared action' });
    res.json({ ok: true, action: a });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/prepared-actions/:id/approve — record Nick's approval of a prepared action (approve draft). RECORDED ONLY: in Build 5 approving sends nothing and executes nothing; the response says executed:false. Body: { note? }
router.post('/:id/approve', (req, res) => {
  try {
    const { note } = req.body;
    const r = pa().approve(req.params.id, { note: typeof note === 'string' ? note.slice(0, 500) : null });
    if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error, executed: false });
    res.json({ ok: true, already: !!r.already, executed: false, notice: r.notice, action: r.action });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, executed: false });
  }
});

// POST /api/prepared-actions/:id/reject — record Nick's rejection of a prepared action (reject draft); kept for audit, and NEURO will not prepare another for the same risk episode. Body: { note? }
router.post('/:id/reject', (req, res) => {
  try {
    const { note } = req.body;
    const r = pa().reject(req.params.id, { note: typeof note === 'string' ? note.slice(0, 500) : null });
    if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error });
    res.json({ ok: true, already: !!r.already, action: r.action });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
