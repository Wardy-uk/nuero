'use strict';

/**
 * SAiM's prepared move — the human half (19 Oct 2026). THREE routes, all
 * human-only and interactive (authority-matrix: saim.prepared-move, machine:
 * refuse; MCP gateway: interactive):
 *
 *   GET  /current — what SAiM has prepared, read only: stores nothing and
 *                   mints nothing (prepared-move-view).
 *   POST /request — prepare the move from live data, store it as an immutable
 *                   version, re-check it, and mint a one-use 60-second
 *                   confirmation. Shows exactly what a yes would write.
 *   POST /confirm — spend that confirmation and make exactly those writes.
 *
 * ⚠ NOT A GENERIC ACTION DOOR. Neither route accepts a date, time, note path,
 * event title, body, recipient or write type: a body carrying any field other
 * than the few named below is REFUSED, never ignored. What is written comes
 * only from the stored packet; the request picks one of the options it offered.
 * The switch (saim_prepared_move_execution, default off) is enforced inside
 * prepared-move-exec, not here.
 */

const express = require('express');
const router = express.Router();

const exec = () => require('../services/prepared-move-exec');
const view = () => require('../services/prepared-move-view');
const HUMAN_ONLY = 'Only Nick, in NEURO, can confirm a prepared move — a machine client cannot.';
const OPTION_RE = /^(approve|slot-[1-9])$/;
const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Refuse any field the route does not name — a date or a path sent here is an attempt, not a typo. */
function strict(body, allowed) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  return extra.length ? `this route takes only ${allowed.join(', ')} — refused: ${extra.join(', ')}` : null;
}
const caller = (req) => require('../services/intent-grants').callerOf(req);
const send = (res, r) => {
  if (r.ok) return res.json(r);
  const { code, ...rest } = r;
  return res.status(code || 409).json({ ...rest, error: (r.reasons || [r.error]).filter(Boolean).join(' ') });
};

// GET /api/prepared-moves/current — prepared move, read only (human only, interactive): what SAiM has prepared right now — what she drafted, why it matters, what is unresolved, the exact two writes and only the times that pass the fresh diary/leave checks. Stores nothing and mints no confirmation; `move: null` when nothing trustworthy is prepared. Refuses machine clients.
router.get('/current', async (req, res) => {
  if (req.apiClient || caller(req).machine) return res.status(403).json({ ok: false, error: HUMAN_ONLY });
  try {
    res.json(await view().currentView());
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/prepared-moves/request — prepared move, step 1 (human only, interactive): show exactly what confirming SAiM's prepared move would write (one solo calendar block, one new project note) and mint a one-use 60-second confirmation for that stored version. Refuses machine clients. Body: { option, surface, sessionId }
router.post('/request', async (req, res) => {
  if (req.apiClient || caller(req).machine) return res.status(403).json({ ok: false, error: HUMAN_ONLY });
  const bad = strict(req.body, ['option', 'surface', 'sessionId']);
  if (bad) return res.status(400).json({ ok: false, error: bad });
  const { option = 'approve', surface = 'neuro-web', sessionId } = req.body || {};
  if (typeof option !== 'string' || !OPTION_RE.test(option)) return res.status(400).json({ ok: false, error: 'option must be one of the times the move offered (approve, slot-1, …)' });
  if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) return res.status(400).json({ ok: false, error: 'sessionId is required' });
  try {
    send(res, await exec().requestForMove({ option, surface, sessionId, caller: caller(req) }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/prepared-moves/confirm — prepared move, step 2 (human only, interactive): spend the one-use confirmation and make exactly the stored writes, read each back and return a receipt. Refused, with nothing read or written, while saim_prepared_move_execution is off. Refuses machine clients. Body: { recordId, version, option, grantId }
router.post('/confirm', async (req, res) => {
  if (req.apiClient || caller(req).machine) return res.status(403).json({ ok: false, error: HUMAN_ONLY, executed: false });
  const bad = strict(req.body, ['recordId', 'version', 'option', 'grantId']);
  if (bad) return res.status(400).json({ ok: false, error: bad, executed: false });
  const { recordId, version, option, grantId } = req.body || {};
  if (typeof recordId !== 'string' || !/^pm_[0-9a-f]{20}$/.test(recordId)) return res.status(400).json({ ok: false, error: 'recordId is required', executed: false });
  if (!Number.isInteger(version) || version < 1) return res.status(400).json({ ok: false, error: 'version is required', executed: false });
  if (typeof option !== 'string' || !OPTION_RE.test(option)) return res.status(400).json({ ok: false, error: 'option must be one the move offered', executed: false });
  if (typeof grantId !== 'string' || !/^ig_[0-9a-f]{32}$/.test(grantId)) return res.status(400).json({ ok: false, error: 'grantId is required', executed: false });
  try {
    send(res, await exec().confirmMove({ recordId, version, option, grantId, caller: caller(req) }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, executed: false });
  }
});

module.exports = router;
