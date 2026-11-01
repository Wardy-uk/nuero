'use strict';

// Meeting follow-ups (1 Nov 2026) — see services/meeting-followups.js. Drafting
// and declining are Nick's presses: machine-refused in the authority matrix and
// interactive in the MCP gateway. Sending is the governed action's own press.

const express = require('express');
const mf = require('../services/meeting-followups');

const router = express.Router();
const fail = (res, r) => res.status(r.code || 400).json(r);

// GET /api/meeting-followups — meeting follow-up emails: drafts waiting for Nick's press, offers to draft one, and ones NEURO could not draft (why).
router.get('/', (req, res) => {
  try { res.json({ ok: true, ...mf.list() }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/meeting-followups/sweep — look for new meeting write-ups now (it also runs every 10 minutes): draft team ones, offer the rest.
router.post('/sweep', async (req, res) => {
  try { res.json({ ok: true, ...(await mf.sweep()) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/meeting-followups/:id/draft — Nick pressed Draft: write the follow-up email from the meeting write-up (one per meeting, ever).
router.post('/:id/draft', async (req, res) => {
  const r = await mf.draft(Number(req.params.id));
  return r.ok ? res.json(r) : fail(res, r);
});

// POST /api/meeting-followups/:id/decline — Nick said not this one: no follow-up for this meeting.
router.post('/:id/decline', (req, res) => {
  const r = mf.decline(Number(req.params.id));
  return r.ok ? res.json(r) : fail(res, r);
});

module.exports = router;
