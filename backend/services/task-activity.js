'use strict';

/**
 * Task activity — Nick's choice and the evidence beside it (15 Oct 2026).
 * Precedence and vocabulary: shared/task-activity.cjs. Tables: task_activity
 * (the choice), task_activity_events (append-only history),
 * task_activity_observations (soft evidence from focus sessions).
 *
 * ⚠ Only `setChoice` and an ACCEPTED observation (`reviewObservation`, which is
 * Nick saying yes) write task_activity. Recording an observation never does.
 */

const db = require('../db/database');
const TA = require('../../shared/task-activity.cjs');

const nowIso = (now = Date.now()) => new Date(now).toISOString();
const event = (taskId, ev, { choice = null, via = null, ref = null, now = Date.now() } = {}) =>
  db.run('INSERT INTO task_activity_events (task_id, event, choice, via, ref, at) VALUES (?, ?, ?, ?, ?, ?)', [taskId, ev, choice, via, ref, nowIso(now)]);

const VIA = new Set(['neuro', 'saim']);

/**
 * Nick states (or clears) a task's activity. `choice` is one of TA.CHOICES, or
 * null to clear. Unknown values are REFUSED, never normalised.
 */
function setChoice(taskId, choice, { via = 'neuro', now = Date.now() } = {}) {
  const id = Number(taskId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, status: 400, error: 'taskId must be a positive integer' };
  if (!VIA.has(via)) return { ok: false, status: 400, error: `via must be one of ${[...VIA].join(', ')}` };
  if (!db.getTaskRow(id)) return { ok: false, status: 404, error: 'no such task' };
  if (choice === null) {
    db.run('DELETE FROM task_activity WHERE task_id = ?', [id]);
    event(id, 'cleared', { via, now });
    return { ok: true, taskId: id, choice: null };
  }
  if (!TA.CHOICES.includes(choice)) return { ok: false, status: 400, error: `choice must be one of ${TA.CHOICES.join(', ')} (or null to clear)` };
  db.run(`INSERT INTO task_activity (task_id, choice, via, observation_id, stated_at) VALUES (?, ?, ?, NULL, ?)
          ON CONFLICT(task_id) DO UPDATE SET choice = excluded.choice, via = excluded.via, observation_id = NULL, stated_at = excluded.stated_at`,
  [id, choice, via, nowIso(now)]);
  event(id, 'stated', { choice, via, now });
  return { ok: true, taskId: id, choice };
}

/**
 * Record what the laptop saw during a session on a task. Idempotent per
 * (task, session). Writes evidence ONLY — never a choice.
 */
function recordObservation({ taskId, sessionId, startedAt, endedAt, apps, now = Date.now() } = {}) {
  const id = Number(taskId);
  if (!Number.isInteger(id) || id <= 0 || !sessionId || !startedAt || !endedAt || !Array.isArray(apps)) return { ok: false, reason: 'incomplete observation' };
  if (!apps.length) return { ok: false, reason: 'no app use was seen' };
  const s = TA.observationSuggestion(apps);
  const r = db.run(`INSERT OR IGNORE INTO task_activity_observations
          (task_id, session_id, started_at, ended_at, apps_json, suggested_activity, suggested_minutes, suggested_share, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  [id, String(sessionId), startedAt, endedAt, JSON.stringify(apps.slice(0, 12)), s ? s.activity : null, s ? s.minutes : null, s ? s.share : null, nowIso(now)]);
  const row = db.get('SELECT id FROM task_activity_observations WHERE task_id = ? AND session_id = ?', [id, String(sessionId)]);
  if (r && r.changes) event(id, 'observed', { ref: `observation:${row.id}`, now });
  return { ok: true, observationId: row.id, created: Boolean(r && r.changes), suggested: s };
}

/**
 * Observe a finished focus session: desktop-activity samples inside its window.
 * Never throws; a session with no task, or a laptop that saw nothing, records nothing.
 */
function observeSession(session, { samples = null, now = Date.now() } = {}) {
  try {
    if (!session || session.taskId == null || !session.id) return { ok: false, reason: 'no task on the session' };
    const start = Date.parse(session.startedAt || ''); const end = Date.parse(session.endedAt || '') || now;
    if (!Number.isFinite(start)) return { ok: false, reason: 'no session start' };
    const da = require('./desktop-activity');
    const list = samples || da.samples();
    const apps = TA.observeWindow(list, start, end, { freshMinutes: da.FRESH_MINUTES, idleAwayMinutes: da.IDLE_AWAY_MINUTES });
    return recordObservation({ taskId: session.taskId, sessionId: session.id, startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(), apps, now });
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** Nick reviews an observation: accept (its suggestion becomes his choice) or dismiss. */
function reviewObservation(observationId, decision, { now = Date.now() } = {}) {
  const id = Number(observationId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, status: 400, error: 'observationId must be a positive integer' };
  if (!['accept', 'dismiss'].includes(decision)) return { ok: false, status: 400, error: 'decision must be accept or dismiss' };
  const o = db.get('SELECT * FROM task_activity_observations WHERE id = ?', [id]);
  if (!o) return { ok: false, status: 404, error: 'no such observation' };
  if (o.status !== 'pending') return { ok: false, status: 409, error: `already ${o.status}` };
  if (decision === 'accept') {
    if (!o.suggested_activity) return { ok: false, status: 409, error: 'this observation suggests no activity to accept — choose one instead' };
    if (!db.getTaskRow(o.task_id)) return { ok: false, status: 404, error: 'the task no longer exists' };
    db.run(`INSERT INTO task_activity (task_id, choice, via, observation_id, stated_at) VALUES (?, ?, 'observation-review', ?, ?)
            ON CONFLICT(task_id) DO UPDATE SET choice = excluded.choice, via = excluded.via, observation_id = excluded.observation_id, stated_at = excluded.stated_at`,
    [o.task_id, o.suggested_activity, id, nowIso(now)]);
  }
  db.run('UPDATE task_activity_observations SET status = ?, reviewed_at = ? WHERE id = ?', [decision === 'accept' ? 'accepted' : 'dismissed', nowIso(now), id]);
  event(o.task_id, decision === 'accept' ? 'observation-accepted' : 'observation-dismissed', { choice: decision === 'accept' ? o.suggested_activity : null, via: 'observation-review', ref: `observation:${id}`, now });
  return { ok: true, observationId: id, taskId: o.task_id, status: decision === 'accept' ? 'accepted' : 'dismissed', choice: decision === 'accept' ? o.suggested_activity : null };
}

const shapeObs = (o) => ({ id: o.id, taskId: o.task_id, sessionId: o.session_id, startedAt: o.started_at, endedAt: o.ended_at,
  apps: (() => { try { return JSON.parse(o.apps_json); } catch { return []; } })(), suggestedActivity: o.suggested_activity,
  suggestedMinutes: o.suggested_minutes, suggestedShare: o.suggested_share, status: o.status, reviewedAt: o.reviewed_at });

/** One task: Nick's choice, the resolved view, its observations and history. */
function forTask(taskId) {
  const id = Number(taskId);
  const row = db.getTaskRow(id);
  if (!row) return null;
  const choice = db.get('SELECT * FROM task_activity WHERE task_id = ?', [id]) || null;
  const observations = db.all('SELECT * FROM task_activity_observations WHERE task_id = ? ORDER BY id DESC LIMIT 20', [id]).map(shapeObs);
  const resolved = TA.resolveActivity({ choice: choice && choice.choice, task: { source: row.source, originPath: row.origin_path }, observations });
  return {
    taskId: id, choice: choice ? { choice: choice.choice, via: choice.via, observationId: choice.observation_id, statedAt: choice.stated_at } : null,
    resolved, observations,
    history: db.all('SELECT event, choice, via, ref, at FROM task_activity_events WHERE task_id = ? ORDER BY id DESC LIMIT 20', [id]),
  };
}

/** Every open task's resolved activity, for the candidates composer. Map taskId → resolveActivity(...). */
function forOpenTasks() {
  const tasks = db.all("SELECT id, source, origin_path FROM tasks WHERE status IN ('open', 'in-progress')");
  const choices = new Map(db.all('SELECT task_id, choice FROM task_activity').map((r) => [r.task_id, r.choice]));
  const obs = new Map();
  for (const o of db.all("SELECT * FROM task_activity_observations WHERE status = 'pending' ORDER BY id DESC")) {
    if (!obs.has(o.task_id)) obs.set(o.task_id, []);
    obs.get(o.task_id).push(shapeObs(o));
  }
  const out = new Map();
  for (const t of tasks) out.set(t.id, TA.resolveActivity({ choice: choices.get(t.id) || null, task: { source: t.source, originPath: t.origin_path }, observations: obs.get(t.id) || [] }));
  return out;
}

module.exports = { setChoice, recordObservation, observeSession, reviewObservation, forTask, forOpenTasks };
