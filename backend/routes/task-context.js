'use strict';

/**
 * Task context (22 Oct 2026) — vault notes, projects and areas pinned to a task.
 * See services/task-context.js for the model and the safety boundaries.
 *
 *   GET  /tasks/:taskId                  — a task's pinned context, suggestions, stale links, any open question
 *   GET  /search?q=&taskId=              — candidate notes / projects / areas to link (a vault read)
 *   GET  /suggestions                    — suggestions + open questions across open tasks
 *   GET  /runs                           — recent nightly-scan receipts
 *   POST /tasks/:taskId/links            — link ONE note, project or area (Nick, or a chat on his explicit word)
 *   POST /tasks/:taskId/links/:linkId/remove — unpin a link / dismiss a suggestion
 *   POST /tasks/:taskId/links/:linkId/pin    — accept a suggestion
 *   POST /tasks/:taskId/question/dismiss — "neither" to the scan's question
 *   POST /scan                           — run the scan now (human-only; interactive in the gateway)
 *
 * ⚠ Nothing here writes to the vault, and nothing links more than ONE thing per
 * call: a body carrying any field the route does not name is refused, so a chat
 * cannot bulk-link by sending a list.
 */

const express = require('express');
const router = express.Router();

const svc = () => require('../services/task-context');
const callerOf = (req) => require('../services/intent-grants').callerOf(req);

function byOf(req) {
  const m = callerOf(req).machine || (req.apiClient ? String(req.apiClient) : null);
  return m ? `machine:${m}` : 'nick';
}

function strict(body, allowed) {
  const extra = Object.keys(body || {}).filter((k) => !allowed.includes(k));
  return extra.length ? `Not accepted here: ${extra.join(', ')}.` : null;
}

function send(res, r) {
  if (r && r.ok) return res.json(r);
  return res.status((r && r.status) || 500).json(r || { ok: false, error: 'Nothing came back.' });
}

// GET /api/task-context/tasks/:taskId — a task's pinned context (notes, projects, areas), with why each is linked and whether it was found automatically or linked by Nick; plus suggestions, stale links and any open question
router.get('/tasks/:taskId', (req, res) => {
  try { send(res, svc().forTask(req.params.taskId)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/task-context/search — search candidate context to link to a task: vault notes by title/path, projects and areas by name (q required; taskId marks what is already linked)
router.get('/search', (req, res) => {
  try {
    const { q, taskId } = req.query;
    send(res, svc().search({ q, taskId: taskId ? Number(taskId) : null }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/task-context/suggestions — task context suggestions the nightly scan made but did not pin, and questions it asked instead of guessing, across open tasks
router.get('/suggestions', (req, res) => {
  try {
    const { limit } = req.query;
    send(res, svc().suggestions({ limit }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/task-context/runs — receipts of recent task context scans: what was scanned, pinned, suggested, refreshed, marked stale and skipped, and why
router.get('/runs', (req, res) => {
  try {
    const { limit } = req.query;
    res.json({ ok: true, runs: svc().runs({ limit }) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/task-context/tasks/:taskId/links — link ONE vault note, project or area to a task as context (type: note|project|area; ref: a vault path or a name). Only when Nick explicitly asks. Ambiguous → 409 with a question and options, never a guess. Never writes the vault.
router.post('/tasks/:taskId/links', (req, res) => {
  try {
    const { type, ref } = req.body || {};
    const bad = strict(req.body, ['type', 'ref']);
    if (bad) return res.status(400).json({ ok: false, error: bad });
    if (typeof ref !== 'string') return res.status(400).json({ ok: false, error: 'ref must be one path or name — one link per call.' });
    send(res, svc().link({ taskId: req.params.taskId, type, ref, by: byOf(req) }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/task-context/tasks/:taskId/links/:linkId/remove — unlink / unpin task context, or dismiss a suggestion. Kept as removed so the nightly scan never re-adds it. Only when Nick explicitly asks.
router.post('/tasks/:taskId/links/:linkId/remove', (req, res) => {
  try {
    const bad = strict(req.body, []);
    if (bad) return res.status(400).json({ ok: false, error: bad });
    send(res, svc().remove({ taskId: req.params.taskId, linkId: req.params.linkId, by: byOf(req) }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/task-context/tasks/:taskId/links/:linkId/pin — accept a task context suggestion: pin it to the task. Only when Nick explicitly asks.
router.post('/tasks/:taskId/links/:linkId/pin', (req, res) => {
  try {
    const bad = strict(req.body, []);
    if (bad) return res.status(400).json({ ok: false, error: bad });
    send(res, svc().pin({ taskId: req.params.taskId, linkId: req.params.linkId, by: byOf(req) }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/task-context/tasks/:taskId/question/dismiss — answer "neither" to the task context scan's question (which project/area); it is not asked again unless the options change
router.post('/tasks/:taskId/question/dismiss', (req, res) => {
  try {
    const bad = strict(req.body, []);
    if (bad) return res.status(400).json({ ok: false, error: bad });
    send(res, svc().dismissQuestion({ taskId: req.params.taskId }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/task-context/scan — run the nightly task context scan now (Nick only; refused to machine clients). Writes NEURO's own tables, never the vault.
router.post('/scan', (req, res) => {
  try {
    if (byOf(req) !== 'nick') return res.status(403).json({ ok: false, error: 'Only Nick, in NEURO, can run the task context scan.' });
    const bad = strict(req.body, []);
    if (bad) return res.status(400).json({ ok: false, error: bad });
    const r = svc().runScan({ trigger: 'manual' });
    if (r.busy) return res.status(409).json(r);
    send(res, r.ok ? r : { ...r, status: 500 });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
