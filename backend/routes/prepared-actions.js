'use strict';

/**
 * Prepared actions — what NEURO has drafted for Nick to approve (Build 5E), and
 * since Build 6 the one door through which an approved chase is SENT.
 *
 * ⚠ A4 APPROVAL IS NICK'S. Approve and edit refuse a machine client (the API
 * token — n8n, the remote MCP gateway): an agent must never approve on his
 * behalf. They also require the payload hash the screen DISPLAYED, so an
 * approval binds to the exact words, recipient and version he read.
 *
 * ⚠ Only a type the registry marks executable is sent (Build 6:
 * chase_commitment). Approving anything else records the decision and sends
 * nothing, and the response says which.
 */

const express = require('express');

const router = express.Router();
const pa = () => require('../services/prepared-actions');
const executor = () => require('../services/action-executor');

const HUMAN_ONLY = 'Approving or editing an A4 action needs Nick, signed in to NEURO — a machine client cannot do it on his behalf.';

// GET /api/prepared-actions — drafts NEURO has prepared for approval (prepared action, follow-up draft, chase draft, approval queue, governed action): what it wants to do, for which commitment-at-risk finding, to whom, why, the evidence, the exact draft and its payloadHash, authority A4, whether the type executes, age, status (prepared|approved|executing|execution_uncertain|executed|verified|failed|rejected|expired|cancelled|superseded). ?status=&limit=50
router.get('/', (req, res) => {
  try {
    const status = pa().STATUSES.includes(req.query.status) ? req.query.status : null;
    res.json({ ok: true, executableTypes: require('../services/action-registry').executableTypes(),
      counts: pa().countsByStatus(), actions: pa().list({ status, limit: req.query.limit }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/prepared-actions/status — the execution ledger at a glance (action ledger, execution status, stuck actions, uncertain sends, verification): counts by status, anything stuck, anything failed or uncertain that needs review, attempts made, sends requested
router.get('/status', (req, res) => {
  try {
    res.json({ ok: true, ...executor().status() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/prepared-actions/:id — one prepared action with its evidence, exact draft, payloadHash, approval, decision history, execution attempts and Sent Items verifications
router.get('/:id', (req, res) => {
  try {
    const a = pa().get(req.params.id);
    if (!a) return res.status(404).json({ ok: false, error: 'no such prepared action' });
    res.json({ ok: true, action: a, attempts: executor().attemptsFor(a.actionId), verifications: executor().verificationsFor(a.actionId) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/prepared-actions/:id/approve — Nick approves the EXACT draft he was shown (approve draft, approve chase, send chase). Requires body.payloadHash from the screen; a changed draft is refused. For chase_commitment this SENDS the email as Nick and then verifies it in Sent Items; other types record the approval only. Refuses machine clients. Body: { payloadHash, note? }
router.post('/:id/approve', async (req, res) => {
  if (req.apiClient) return res.status(403).json({ ok: false, error: HUMAN_ONLY, executed: false });
  try {
    const { payloadHash, note } = req.body;
    const r = pa().approve(req.params.id, {
      payloadHash: typeof payloadHash === 'string' ? payloadHash : null,
      approver: 'nick (signed in to NEURO)',
      note: typeof note === 'string' ? note.slice(0, 500) : null,
    });
    if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error, executed: false });
    if (!r.executable) {
      return res.json({ ok: true, already: !!r.already, executed: false, notice: r.notice, action: r.action });
    }
    // Event-triggered execution. Idempotent: a second approve, a double click
    // or the reconciler reaching it first all end at the same single claim.
    const x = await executor().execute(req.params.id);
    const action = pa().get(req.params.id);
    res.json({
      ok: true,
      already: !!r.already,
      executed: ['executed', 'verified', 'execution_uncertain'].includes(action.status),
      status: action.status,
      detail: x.detail || r.notice,
      notice: r.notice,
      action,
    });
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

// POST /api/prepared-actions/:id/edit — Nick edits a prepared draft's subject or body (edit draft, change wording, resend after a proven failure). Creates a NEW version that needs its own approval; the old one is superseded and never changed. The recipient cannot be edited. Refuses machine clients. Body: { payloadHash, subject?, body? }
router.post('/:id/edit', (req, res) => {
  if (req.apiClient) return res.status(403).json({ ok: false, error: HUMAN_ONLY });
  try {
    const { payloadHash, subject, body } = req.body;
    const r = pa().edit(req.params.id, {
      payloadHash: typeof payloadHash === 'string' ? payloadHash : null,
      subject: typeof subject === 'string' ? subject : undefined,
      body: typeof body === 'string' ? body : undefined,
      editor: 'nick',
    });
    if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error });
    res.json({ ok: true, action: r.action, supersedes: r.supersedes });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
