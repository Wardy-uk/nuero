'use strict';

/**
 * The nervous system, observed (Build 1). READ-ONLY.
 *
 * Counts, lag, failures and the SourceHealth projection — never event payloads,
 * and no controls. Replay is deliberately not a route: it is
 * `backend/scripts/events-replay.js`, run by hand on the Pi, because a rebuild
 * is an operator's act and nothing on a screen needs to be able to start one.
 *
 * Behind the PIN like every other /api route.
 */

const express = require('express');
const router = express.Router();
const bus = require('../services/event-bus');
const sourceHealth = require('../services/source-health');
const observationState = require('../services/observation-state');
const sourceBlindness = require('../services/source-blindness');

// GET /api/events/status — event backbone health: event count, newest event, consumer lag, failed and dead-lettered events
router.get('/status', (req, res) => {
  try {
    res.json({
      ok: true,
      ...bus.getStatus(),
      sourceHealth: sourceHealth.getSourceHealth().projection,
      observationState: observationState.list().projection,
      sourceBlindness: sourceBlindness.status(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/events/source-health — the SourceHealth projection: is each source working, fresh or stale, and when it last succeeded
router.get('/source-health', (req, res) => {
  try {
    res.json({ ok: true, ...sourceHealth.getSourceHealth() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/events/findings — source-blindness findings: which sensor has gone blind (stale, failing, never seen), the evidence event ids, severity, and what the attention policy decided (shadow or live). ?status=active|resolved
router.get('/findings', (req, res) => {
  try {
    const status = req.query.status === 'active' || req.query.status === 'resolved' ? req.query.status : null;
    res.json({ ok: true, evaluator: sourceBlindness.status(), findings: sourceBlindness.getFindings({ status }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/events/observations — latest native observation per thing (health metric, device, location fix time), with source app, observed vs received time, freshness and evidence event. No coordinates. ?kind=health|device|location
router.get('/observations', (req, res) => {
  try {
    const kind = ['health', 'device', 'location'].includes(req.query.kind) ? req.query.kind : null;
    res.json({ ok: true, ...observationState.list({ kind }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/events/runtime — durable scheduled jobs (calendar sync, source staleness check, ambient pass): due, running, succeeded, failed, skipped and overdue runs, scheduled vs actual start time, lag and duration. ?job=<name> adds that job's recent runs
router.get('/runtime', (req, res) => {
  try {
    const runtime = require('../services/runtime-jobs');
    const body = { ok: true, ...runtime.status() };
    if (typeof req.query.job === 'string' && runtime._jobs.has(req.query.job)) {
      body.runs = runtime.runs(req.query.job, { limit: 100 });
    }
    res.json(body);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/events/world/meetings — the world model's meeting state: what meeting is happening now, what is next, who is in it (mapped to known people), which calendar sources support it, and how fresh each source is
router.get('/world/meetings', (req, res) => {
  try {
    res.json({ ok: true, ...require('../services/world-model').meetingState() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/events/world/people — people known to the world model (declared in People notes): names, email addresses, explicitly stated role/team/relationship, provenance; plus any address two notes both claim
router.get('/world/people', (req, res) => {
  try {
    const wm = require('../services/world-model');
    res.json({ ok: true, people: wm.listPeople(), conflicts: wm.identityConflicts() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/events/world/meeting-context — SHADOW meeting-context findings: before a real meeting, what NEURO holds about it (open actions from the last occurrence, items owed from it, urgent emails from attendees), the evidence and missing evidence, confidence, recommended timing and what the attention policy would have done. ?status=active|withdrawn|expired
router.get('/world/meeting-context', (req, res) => {
  try {
    const mc = require('../services/meeting-context');
    const status = ['active', 'withdrawn', 'expired'].includes(req.query.status) ? req.query.status : null;
    res.json({ ok: true, mode: mc.mode(), findings: mc.findings({ status }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
