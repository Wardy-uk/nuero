'use strict';

// UAT volunteers (26 Oct 2026) — Nick's half, behind the PIN. See
// services/uat-volunteers.js. Every POST here is machine-refused in the
// authority matrix and interactive in the MCP gateway: picking who is asked,
// and what is sent, is Nick's.

const express = require('express');
const uat = require('../services/uat-volunteers');

const router = express.Router();
const fail = (res, r) => res.status(r.code || 400).json(r);

// GET /api/uat — UAT volunteer rounds (picks, invites, answers, reply to Dan) and the rota per team.
router.get('/', (req, res) => {
  try { res.json({ ok: true, ...uat.list() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/uat/rounds/:id/invites — prepare the invite emails for every pick not yet invited; the screen sends them with one press.
router.post('/rounds/:id/invites', (req, res) => {
  const r = uat.prepareInvites(Number(req.params.id));
  return r.ok ? res.json(r) : fail(res, r);
});

// POST /api/uat/rounds/:id/selections/:selectionId/swap — swap a pick before its invite is sent (person omitted = next in the rota).
router.post('/rounds/:id/selections/:selectionId/swap', (req, res) => {
  const { person } = req.body;
  const r = uat.swap(Number(req.params.id), Number(req.params.selectionId), person || null);
  return r.ok ? res.json(r) : fail(res, r);
});

// POST /api/uat/rounds/:id/dismiss — not a volunteer request, or Nick is handling it himself.
router.post('/rounds/:id/dismiss', (req, res) => {
  const r = uat.dismiss(Number(req.params.id));
  return r.ok ? res.json(r) : fail(res, r);
});

// POST /api/uat/rounds/:id/retry — read a UAT email NEURO could not read again.
router.post('/rounds/:id/retry', async (req, res) => {
  try {
    const r = await uat.retry(Number(req.params.id));
    return r.ok ? res.json(r) : fail(res, r);
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/uat/tick — bring every round up to date now (what the 5-minute timer does).
router.post('/tick', async (req, res) => {
  try { await uat.tick(); res.json({ ok: true, ...uat.list() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
