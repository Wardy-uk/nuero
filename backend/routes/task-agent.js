'use strict';

// "Do this" — NEURO progressing one task as far as it safely can (23 Oct 2026).
// See services/task-agent.js and docs/task-agent.md.
//
// ⚠ EVERY ROUTE HERE, READS INCLUDED, IS NICK'S OWN SURFACE ONLY. The kiosk, the
// API token (MCP, n8n), any declared machine client and chat get neither the
// control nor the working output: the output can quote a restricted note's
// excerpt, which only Nick may see. Identity is task-context.viewerOf(req) — it
// can only DOWNGRADE on a header, never upgrade.

const express = require('express');
const router = express.Router();

const svc = () => require('../services/task-agent');
const viewerOf = (req) => require('../services/task-context').viewerOf(req);

const OWNER_ONLY = 'Only Nick, in NEURO on his own desktop or phone, can use Do this.';

function owner(req, res) {
  if (viewerOf(req) === 'owner') return true;
  res.status(403).json({ ok: false, error: OWNER_ONLY });
  return false;
}
function send(res, r) {
  if (r && r.ok === false) return res.status(r.status || 400).json({ ok: false, error: r.error });
  res.json(r);
}
function strict(body, allowed) {
  const extra = Object.keys(body || {}).filter((k) => !allowed.includes(k));
  return extra.length ? `Unexpected field: ${extra.join(', ')}` : null;
}

// GET /api/task-agent/tasks/:taskId — Nick's "Do this" workspace for one task: understanding, sources used, steps, private outputs, prepared handoffs, the open question. Owner only.
router.get('/tasks/:taskId', (req, res) => {
  try {
    if (!owner(req, res)) return;
    send(res, svc().view(req.params.taskId));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/task-agent/active — tasks with Do this work in progress, for Drafts. Owner only.
router.get('/active', (req, res) => {
  try {
    if (!owner(req, res)) return;
    send(res, svc().activeRuns());
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/task-agent/tasks/:taskId/start — the Do this press: start, or resume the same attempt (repeated presses never duplicate work). body.fresh starts a new attempt on a settled run. Owner only.
router.post('/tasks/:taskId/start', (req, res) => {
  try {
    if (!owner(req, res)) return;
    const { fresh } = req.body;
    const bad = strict(req.body, ['fresh']);
    if (bad) return res.status(400).json({ ok: false, error: bad });
    send(res, svc().start(req.params.taskId, { fresh: fresh === true }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/task-agent/tasks/:taskId/answer — Nick answers the run's one open question (body.questionId, body.text), or says the manual step is done (body.manualDone). The run continues at once. Owner only.
router.post('/tasks/:taskId/answer', (req, res) => {
  try {
    if (!owner(req, res)) return;
    const { questionId, text, manualDone } = req.body;
    const bad = strict(req.body, ['questionId', 'text', 'manualDone']);
    if (bad) return res.status(400).json({ ok: false, error: bad });
    if (typeof questionId !== 'string' || !questionId) return res.status(400).json({ ok: false, error: 'questionId is required' });
    send(res, svc().answer(req.params.taskId, { questionId, text: typeof text === 'string' ? text : '', manualDone: manualDone === true }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/task-agent/tasks/:taskId/stop — Nick stops the Do this run; its outputs and prepared actions are kept as they are. Owner only.
router.post('/tasks/:taskId/stop', (req, res) => {
  try {
    if (!owner(req, res)) return;
    const bad = strict(req.body, []);
    if (bad) return res.status(400).json({ ok: false, error: bad });
    send(res, svc().stop(req.params.taskId));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
