'use strict';

/**
 * /api/tasks/done-evidence — "Looks done" (1 Nov 2026). services/task-done-evidence.js.
 *
 * Mounted on /api/tasks AHEAD of routes/tasks.js, so the literal
 * `/done-evidence` is matched here before anything parameterised can read it
 * as a task id.
 *
 * NEURO offers; Nick closes. `close` is the ordinary completion (task-store
 * setStatus + the Microsoft push), so wins, blocks and a linked Planner card
 * behave exactly as for a tick. Both writes are machine-refused in the
 * authority matrix — a machine that could press Close would be NEURO closing
 * its own guesses.
 */

const express = require('express');
const router = express.Router();
const tde = require('../services/task-done-evidence');

// GET /api/tasks/done-evidence — open tasks NEURO has evidence are already done (sent email, ticked daily-note line, linked Planner task complete, named Jira ticket resolved), with the evidence in words and any source it could not read. Keywords: looks done, done evidence, close task suggestion.
router.get('/done-evidence', (req, res) => {
  try {
    res.json(tde.read());
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/tasks/:id/done-evidence/close — Nick confirms a "looks done" task is done: the normal task completion (wins, Microsoft push). Keywords: close looks done task.
router.post('/:id/done-evidence/close', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'A task id is required' });
    const taskStore = require('../services/task-store');
    const before = taskStore.getTask(id);
    if (!before) return res.status(404).json({ ok: false, error: 'Task not found' });
    if (!['open', 'in-progress'].includes(before.status)) return res.status(409).json({ ok: false, error: `That task is already ${before.status}` });
    const task = taskStore.setStatus(id, 'done');
    const push = require('./tasks').pushCompletionToMicrosoft;
    const msPush = push ? await push(task, 'nick') : null;
    res.json({ ok: true, task, msPush, recurred: task.recurred || null });
  } catch (e) {
    // A Jira-owned task refuses a manual tick, and says which ticket closes it.
    res.status(400).json({ ok: false, error: e.message });
  }
});

// POST /api/tasks/:id/done-evidence/not-yet — "not yet": stop offering THIS evidence for the task; a newer piece of evidence is offered again. Body {key} optional (one piece); without it, every piece currently offered. Keywords: dismiss looks done.
router.post('/:id/done-evidence/not-yet', (req, res) => {
  try {
    const { key } = req.body; // express.json always sets an object
    const r = tde.notYet(Number(req.params.id), { key: typeof key === 'string' && key ? key : null });
    if (!r.ok) return res.status(r.status || 400).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
