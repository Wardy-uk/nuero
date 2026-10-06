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

// GET /api/events/investigations — bounded investigations of a sense that went blind: state, evidence, hypotheses, confidence, recommended fix (never executed), stop reason, and a short summary. ?open=1 for open ones only
router.get('/investigations', (req, res) => {
  try {
    const investigations = require('../services/investigations');
    const rows = investigations.list({ open: req.query.open === '1' ? true : null, limit: Math.min(Number(req.query.limit) || 50, 200) });
    res.json({ ok: true, investigations: rows.map((i) => ({ ...i, summary: investigations.summaryFor(i) })) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/events/investigations/:id — one investigation with its full audit trail (detected, evidence refs, hypotheses, decision, fix, approval hand-off, resolution, expiry)
router.get('/investigations/:id', (req, res) => {
  try {
    const investigations = require('../services/investigations');
    const one = investigations.get(req.params.id);
    if (!one) return res.status(404).json({ ok: false, error: 'no such investigation' });
    res.json({ ok: true, investigation: { ...one, summary: investigations.summaryFor(one) }, events: investigations.events(one.id) });
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

// GET /api/events/world/presence — Build 13H: who is home, from Home Assistant on the event spine: Nick home/away/work/zone/unknown, whether anyone else is in and who HA names, when each last changed, and the source's health (a source that has not answered makes every answer unknown, never away)
router.get('/world/presence', (req, res) => {
  try { res.json(require('../services/ha-presence').read()); }
  catch (e) { res.status(500).json({ error: e.message }); }
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

// GET /api/events/world/tasks — Build 4 world-model tasks (obligation, todo, task): every task NEURO knows from its own task list and Microsoft Planner / To Do, one row per real task (a Microsoft task linked to a NEURO task by its id is one task, with both sources), status with which source closed it, due date and whether the date was stated or a placeholder, owner, meeting link and provenance. ?status=open|completed|cancelled|unknown|all
router.get('/world/tasks', (req, res) => {
  try {
    const wo = require('../services/world-obligations');
    const status = ['open', 'completed', 'cancelled', 'unknown', 'all'].includes(req.query.status) ? req.query.status : 'open';
    res.json({ ok: true, status, tasks: wo.listTasks({ status, limit: 500 }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/events/world/commitments — Build 4 world-model commitments (promises, waiting-for, owed, obligations): who promised what to whom, from which meeting write-up or task, open or closed and by what authority, with the promisor resolved to a person only on an exact name. direction by-nick = Nick's promises; to-nick = what others owe him. ?status=open|completed|cancelled|superseded|unknown|all&direction=by-nick|to-nick
router.get('/world/commitments', (req, res) => {
  try {
    const wo = require('../services/world-obligations');
    const status = ['open', 'completed', 'cancelled', 'superseded', 'unknown', 'all'].includes(req.query.status) ? req.query.status : 'open';
    const direction = ['by-nick', 'to-nick'].includes(req.query.direction) ? req.query.direction : null;
    res.json({ ok: true, status, direction, commitments: wo.listCommitments({ status, direction, limit: 1000 }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/events/world/meeting-commitments — what came out of the last <meeting>: the commitments from the newest written-up occurrence of a recurring meeting, which are still open, who owns each, and which are due before the next occurrence. ?title=Tech Leadership
router.get('/world/meeting-commitments', (req, res) => {
  try {
    const title = String(req.query.title || '').trim();
    if (!title) return res.status(400).json({ ok: false, error: 'title is required (the meeting title, e.g. Tech Leadership)' });
    const wm = require('../services/world-model');
    const wo = require('../services/world-obligations');
    const nowLocal = wm.localMinute(Date.now());
    const prev = wo.fromPreviousOccurrence(title, { beforeLocal: nowLocal });
    const next = wm.nextMeetings({ limit: 200 }).find((m) => m.title.trim().toLowerCase().replace(/\s+/g, ' ') === title.toLowerCase().replace(/\s+/g, ' ')) || null;
    const nextDay = next ? next.start.slice(0, 10) : null;
    const commitments = prev.commitments.map((c) => ({
      ...c,
      dueBeforeNext: nextDay && c.due && c.status === 'open' ? c.due.date <= nextDay : null,
    }));
    res.json({
      ok: true,
      title,
      previous: prev.occurrence,
      next: next ? { meetingId: next.meetingId, start: next.start, kind: next.kind } : null,
      commitments,
      open: commitments.filter((c) => c.status === 'open').length,
      why: prev.occurrence ? null : 'no write-up of an earlier occurrence is linked to the calendar (history kept since 14 Sep 2026)',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/events/world/commitment-risk — SHADOW commitment-at-risk findings: promises (Nick's, and what others owe him) that are about to matter and still look open — a stated deadline today/tomorrow or recently passed, or the next occurrence of the meeting they came from within 24h — with evidence, what could not be checked, confidence, level, novelty and what the attention policy would have done. Nothing is ever sent. ?status=active|resolved
router.get('/world/commitment-risk', (req, res) => {
  try {
    const cr = require('../services/commitment-risk');
    const status = ['active', 'resolved'].includes(req.query.status) ? req.query.status : null;
    res.json({ ok: true, mode: cr.mode(), findings: cr.findings({ status }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/events/world/meeting-intelligence — SHADOW meeting findings (Build 5A), one per upcoming real meeting: your actions and items owed from the last occurrence with their progress state, linked commitment-risk findings (by id, not restated), related urgent email, what could not be read, confidence, timing and what the attention policy would have done. Nothing is ever sent. ?status=active|withdrawn|expired
router.get('/world/meeting-intelligence', (req, res) => {
  try {
    const mi = require('../services/meeting-intelligence');
    const status = ['active', 'withdrawn', 'expired'].includes(req.query.status) ? req.query.status : null;
    res.json({ ok: true, mode: mi.mode(), findings: mi.findings({ status }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/events/world/meeting-prep-parity — the old live meeting-prep push beside the unified meeting pipeline, per meeting: both said something, only one did, or neither; and whether the record supports retiring meeting-prep (it is never retired automatically). ?days=14
router.get('/world/meeting-prep-parity', (req, res) => {
  try {
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 14));
    const prep = require('../services/meeting-prep');
    res.json({ ok: true, meetingPrepMode: prep.prepMode(), ...require('../services/meeting-intelligence').parity({ sinceDays: days }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/events/world/progress — Build 5D progress evidence (did it happen, sent email, later note, fulfilled, likely done): with ?commitmentId=…, one commitment's derived state (fulfilled = fact; likely_fulfilled = an inference that never completes it; contradicted; progress_observed; no_evidence; unknown) with every piece of evidence and the rule that matched; without, a summary of every commitment that has any evidence, and whether sent mail and notes could be read.
router.get('/world/progress', (req, res) => {
  try {
    const pe = require('../services/progress-evidence');
    const id = String(req.query.commitmentId || '').trim();
    if (id) {
      const p = pe.progressFor(id);
      if (!p) return res.status(404).json({ ok: false, error: 'no such commitment' });
      return res.json({ ok: true, progress: p });
    }
    res.json({ ok: true, ...pe.summary() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/events/world/obligations — counts across the Build 4 task and commitment projections: tasks by status, sources by system, commitments by direction/status/kind, how promisors were resolved, how many are linked to a meeting, and the relationship links (synced, realised-by, possible-same)
router.get('/world/obligations', (req, res) => {
  try {
    res.json({ ok: true, ...require('../services/world-obligations').summary() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
