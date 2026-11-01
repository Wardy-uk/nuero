'use strict';

/**
 * /api/focus-blocks — the focus block on screen, and Nick's answers to it
 * (1 Nov 2026). Every POST is a HUMAN press: machine clients are refused here
 * and in the authority matrix (`focus-block.answer`, machine: refuse), and the
 * MCP gateway marks them interactive. Bodies are strict — a field this route
 * does not name is refused, not ignored.
 */

const express = require('express');
const router = express.Router();
const focusBlocks = require('../services/focus-blocks');

const caller = (req) => require('../services/intent-grants').callerOf(req);
const HUMAN_ONLY = 'Answering a focus block is Nick, on his own screen. An agent cannot do it.';

function strict(body, allowed) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  return extra.length ? `this route takes only ${allowed.join(', ') || 'no fields'} — refused: ${extra.join(', ')}` : null;
}

function guard(req, res, allowed) {
  if (req.apiClient || caller(req).machine) { res.status(403).json({ ok: false, error: HUMAN_ONLY }); return false; }
  // The kiosk shows the block read-only — a shared wall must not start Nick's work.
  if (req.attendedSurface === 'kiosk') { res.status(403).json({ ok: false, error: 'The kiosk shows the focus block; answer it on your phone or desktop.' }); return false; }
  const bad = strict(req.body, allowed);
  if (bad) { res.status(400).json({ ok: false, error: bad }); return false; }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ ok: false, error: 'block id must be a number' }); return false; }
  return true;
}

function send(res, r) {
  if (r && r.ok) return res.json(r);
  const { code, ...rest } = r || {};
  return res.status(code || 409).json({ ok: false, ...rest });
}

// GET /api/focus-blocks — the block on screen now (focus-block-v1), or null.
router.get('/', (req, res) => {
  try { res.json({ ok: true, focusBlock: focusBlocks.view({ now: new Date() }) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/focus-blocks/focus-state — is Nick in a focus block right now? {inFocus, until, task, blockId}. Read
// by the iPhone Shortcut that turns an iOS Focus on (docs/focus-dnd-shortcut.md). Cheap; never inferred from the diary.
router.get('/focus-state', (req, res) => {
  try { res.json({ ok: true, ...focusBlocks.focusState(new Date()) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/focus-blocks/:id/choose — pick a task for a focus block: starts a focus session on it.
router.post('/:id/choose', async (req, res) => {
  if (!guard(req, res, ['taskId', 'twoMinute', 'smallerStep', 'force'])) return;
  const { taskId, twoMinute, smallerStep, force } = req.body || {};
  try { send(res, await focusBlocks.choose(Number(req.params.id), { taskId, twoMinute: twoMinute === true, smallerStep, force: force === true })); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/focus-blocks/:id/two-minute — two minutes in: carry on, or stop there (counts as a start).
router.post('/:id/two-minute', async (req, res) => {
  if (!guard(req, res, ['answer'])) return;
  const { answer } = req.body || {};
  try { send(res, await focusBlocks.twoMinute(Number(req.params.id), { answer })); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/focus-blocks/:id/not-now — not now: slide the focus block later today, else let it go.
router.post('/:id/not-now', async (req, res) => {
  if (!guard(req, res, [])) return;
  try { send(res, await focusBlocks.notNow(Number(req.params.id))); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/focus-blocks/:id/wind-down — five minutes left: note where you got to (optional).
router.post('/:id/wind-down', async (req, res) => {
  if (!guard(req, res, ['note'])) return;
  const { note } = req.body || {};
  try { send(res, await focusBlocks.windDown(Number(req.params.id), { note })); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/focus-blocks/:id/end — the end check-in: done, more time (15/30), or stuck (make it smaller).
router.post('/:id/end', async (req, res) => {
  if (!guard(req, res, ['answer', 'minutes', 'step'])) return;
  const { answer, minutes, step } = req.body || {};
  try { send(res, await focusBlocks.endAnswer(Number(req.params.id), { answer, minutes, step })); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
