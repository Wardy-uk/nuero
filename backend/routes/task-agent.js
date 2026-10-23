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
  if (r && r.ok === false) return res.status(r.status || 400).json({ ok: false, error: r.error, ...(r.limit ? { limit: r.limit } : {}), ...(r.resetsAt ? { resetsAt: r.resetsAt } : {}) });
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

// ── Settings → AI & SAiM → Anthropic (the Do this key, model and hard daily limits) ──
const settings = () => require('../services/task-agent-settings');

// GET /api/task-agent/settings — Do this settings: enabled, whether an Anthropic key is saved (configured true/false only, never the key), model, daily budget and run limit, today's spend/requests/runs and remaining allowance. Owner only.
router.get('/settings', (req, res) => {
  try {
    if (!owner(req, res)) return;
    res.json(settings().read());
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/task-agent/settings — save Do this settings: body.enabled, body.model, body.dailyUsd, body.dailyRuns, body.apiKey (paste/replace; never returned), body.clearKey. Omitted fields are unchanged; any invalid field refuses the whole save with field errors. Owner only.
router.post('/settings', (req, res) => {
  try {
    if (!owner(req, res)) return;
    const bad = strict(req.body, ['enabled', 'model', 'dailyUsd', 'dailyRuns', 'apiKey', 'clearKey']);
    if (bad) return res.status(400).json({ ok: false, errors: [{ field: null, error: bad }] });
    const { enabled, model, dailyUsd, dailyRuns, apiKey, clearKey } = req.body;
    const r = settings().save({ enabled, model, dailyUsd, dailyRuns, apiKey, clearKey });
    if (!r.ok) return res.status(r.status || 400).json({ ok: false, errors: r.errors, settings: r.settings });
    // Which fields changed — never a value, and never anything about the key beyond "changed".
    try { require('../db/database').logActivity('task_agent_settings', { event: 'saved', changed: r.changed }); } catch { /* never fails the save */ }
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: 'The settings could not be saved.' }); }
});

// POST /api/task-agent/settings/test — "Test Anthropic connection": one bounded synthetic request with the saved key (body.confirm must be true; without it the answer is the estimated cost). Reports model, tokens, cost and the ledger result — never the prompt or the key. Creates no task attempt or other work. Owner only.
router.post('/settings/test', async (req, res) => {
  try {
    if (!owner(req, res)) return;
    const bad = strict(req.body, ['confirm']);
    const { confirm } = req.body;
    if (bad) return res.status(400).json({ ok: false, error: bad });
    const r = await settings().testConnection({ confirm: confirm === true });
    res.status(r.ok ? 200 : (r.status || 400)).json(r);
  } catch (e) { res.status(500).json({ ok: false, error: 'The connection test could not run.' }); }
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

// POST /api/task-agent/tasks/:taskId/outputs/:outputId/save — prepare ONE finished Do this draft to be saved to the vault: stores the existing project-note prepared move and returns its recordId. Saves nothing; the save happens only through /api/prepared-moves/request + /confirm. Owner only.
router.post('/tasks/:taskId/outputs/:outputId/save', async (req, res) => {
  try {
    if (!owner(req, res)) return;
    const bad = strict(req.body, []);
    if (bad) return res.status(400).json({ ok: false, error: bad });
    if (!/^o\d{1,3}$/.test(req.params.outputId)) return res.status(400).json({ ok: false, error: 'bad output id' });
    send(res, await svc().prepareSave(req.params.taskId, req.params.outputId));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/task-agent/tasks/:taskId/handoff/preview — the Claude-desktop handoff Nick would send: why, what is included and excluded, the destination, and the editable prompt (query.includeDrafts=1 to include draft text). Sends nothing. Owner only.
router.get('/tasks/:taskId/handoff/preview', (req, res) => {
  try {
    if (!owner(req, res)) return;
    send(res, svc().handoffPreview(req.params.taskId, { includeDrafts: req.query.includeDrafts === '1' }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/task-agent/tasks/:taskId/handoff — Nick presses "Continue this with Claude on desktop" with his working brief (body.brief). The brief is screened; the final prompt is composed by NEURO from its fixed policy envelope, destination and context plus the brief, recorded by hash and returned for his device to copy. A whole prompt is never accepted. body.openOnDesk asks the laptop to open Claude via the existing desk intent. Nothing is sent to Claude. Owner only.
router.post('/tasks/:taskId/handoff', (req, res) => {
  try {
    if (!owner(req, res)) return;
    const { brief, includeDrafts, openOnDesk } = req.body;
    // ⚠ Only the working brief is accepted. A client-supplied prompt, policy, destination or source list is refused, never merged.
    const bad = strict(req.body, ['brief', 'includeDrafts', 'openOnDesk']);
    if (bad) return res.status(400).json({ ok: false, error: bad });
    if (typeof brief !== 'string') return res.status(400).json({ ok: false, error: 'brief is required' });
    send(res, svc().handoff(req.params.taskId, { brief, includeDrafts: includeDrafts === true, openOnDesk: openOnDesk === true }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
