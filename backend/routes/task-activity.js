'use strict';

const express = require('express');
const ta = require('../services/task-activity');

const router = express.Router();
const send = (res, out) => (out && out.ok === false ? res.status(out.status || 400).json(out) : res.json(out));

// POST /api/task-activity/observations/:observationId/review — Nick reviews observed app use from a focus session: accept (its suggested activity becomes his choice for the task) or dismiss. Task activity, observation review. Body { decision: 'accept' | 'dismiss' }.
router.post('/observations/:observationId/review', (req, res) => {
  const { decision } = req.body || {};
  send(res, ta.reviewObservation(req.params.observationId, decision));
});

// GET /api/task-activity/:taskId — what kind of work a task is: Nick's stated activity choice (or "not sure"), suggestions (where it came from, app use observed in focus sessions) with their basis, observations and history. Task activity.
router.get('/:taskId', (req, res) => {
  const out = ta.forTask(req.params.taskId);
  return out ? res.json({ ok: true, ...out }) : res.status(404).json({ ok: false, error: 'no such task' });
});

// POST /api/task-activity/:taskId — Nick states a task's activity (draft, write, spreadsheet, email, code, read, call) or "unsure" (open the task in NEURO), or clears it with null. Authoritative; suggestions never set it. Task activity choice. Body { choice, via?: 'neuro' | 'saim' }.
router.post('/:taskId', (req, res) => {
  const { choice, via } = req.body || {};
  if (!('choice' in (req.body || {}))) return res.status(400).json({ ok: false, error: 'choice is required (null clears it)' });
  send(res, ta.setChoice(req.params.taskId, choice, { via: via || 'neuro' }));
});

module.exports = router;
