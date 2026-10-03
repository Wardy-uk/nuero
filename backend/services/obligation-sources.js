'use strict';

/**
 * The obligation PRODUCERS (Build 4B, 3 Oct 2026). They publish what each store
 * holds; the `world-model` projector folds it (world-obligations.js). Nothing
 * here writes a wm_* table.
 *
 *   publishNeuroTasks()      NEURO's `tasks` table — the authority on Nick's work
 *   publishWaitingOn()       `waiting_on` — what somebody else said they would do,
 *                            extracted from a meeting write-up
 *   publishMicrosoftTasks()  called by obsidian.syncMicrosoftTasks with what
 *                            Graph returned (Planner: every task incl. completed;
 *                            To Do: open tasks only)
 *   reconcile()              the first two, on a durable job — the backstop for
 *                            any writer that bypasses the store's own hook
 *
 * ⚠ NEVER THROWS. Every caller is an ingestion or write path whose behaviour
 * must not change because the world model failed (source-health's contract).
 *
 * Change, not polling: every key carries a fingerprint of the record's state,
 * so a reconcile that finds nothing changed folds into the events already held.
 *
 * ── Meeting linkage is decided HERE, once, and carried in the payload ──────
 *
 * A meeting-derived obligation names its write-up (`Meetings/YYYY/MM/…md`).
 * The write-up → calendar occurrence link uses the rule Build 3D verified:
 * the note's PLAUD `start_at` (UTC, no zone marker) must fall inside exactly
 * ONE calendar_history occurrence with other people in it (±20 min). The
 * result travels in the event, so a replay reproduces the link rather than
 * re-deciding it against a calendar that has since moved on.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');
const bus = require('./event-bus');
const ck = require('./change-key');

const NOTE_SLACK_MIN = 20;
const MAX_TEXT = 500;

function _safe(input, opts) {
  try { return bus.publishEvent(input, opts); } catch (e) {
    console.warn(`[ObligationSources] could not publish ${input && input.type}: ${e.message}`);
    return null;
  }
}

function fingerprintOf(obj) {
  return crypto.createHash('sha256').update(bus.canonicalJson(obj)).digest('hex').slice(0, 32);
}

const lower = (s) => String(s || '').trim().toLowerCase();
const normSubject = (s) => lower(s).replace(/\s+/g, ' ');

function _localMinute(ms) {
  return require('./world-model').localMinute(ms);
}

function _shift(local, min) {
  const t = Date.UTC(+local.slice(0, 4), +local.slice(5, 7) - 1, +local.slice(8, 10), +local.slice(11, 13), +local.slice(14, 16)) + min * 60000;
  return new Date(t).toISOString().slice(0, 16);
}

// ── meeting linkage ─────────────────────────────────────────────────────────

/** Is this vault path a meeting write-up? (Meetings/YYYY/MM/…) */
function isMeetingNote(p) {
  return /^Meetings\/\d{4}\/\d{2}\//.test(String(p || ''));
}

/**
 * Link a write-up to the calendar occurrence it records. PURE over its inputs:
 * `startAt` is the note's PLAUD start (UTC, unmarked) and `occurrences` the
 * calendar_history rows for that day. Returns the link object that travels in
 * the event — including WHY there is no link when there is none.
 */
function linkOccurrence(notePath, startAt, occurrences) {
  const base = { notePath, rule: 'one-occurrence-starting-within-20min-of-the-recording', occurrence: null };
  if (!startAt) return { ...base, why: 'write-up carries no PLAUD start time' };
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(startAt) ? startAt : `${startAt}Z`);
  if (!Number.isFinite(ms)) return { ...base, why: 'write-up start time unreadable' };
  const local = _localMinute(ms);
  // calendar_history keeps EVERY slot an occurrence was ever seen at (UNIQUE on
  // event id + start), so a 1-2-1 moved twice is three rows. Measured on the
  // live store (3 Oct): that ghosting made 7 of 8 recent write-ups ambiguous.
  // Only the NEWEST reported slot of each occurrence id is a candidate, and an
  // entry marked free or cancelled never is.
  const newest = new Map();
  for (const o of occurrences || []) {
    if (o.show_as === 'free' || o.show_as === 'cancelled') continue;
    const cur = newest.get(o.event_id);
    if (!cur || String(o.first_seen || '') > String(cur.first_seen || '')) newest.set(o.event_id, o);
  }
  const live = [...newest.values()];
  const overlaps = live.filter((o) => {
    const s = String(o.start_time).slice(0, 16);
    const e = String(o.end_time || o.start_time).slice(0, 16);
    return local >= _shift(s, -NOTE_SLACK_MIN) && local <= _shift(e, NOTE_SLACK_MIN);
  });
  if (!overlaps.length) return { ...base, noteStartLocal: local, why: 'no calendar occurrence with other people overlaps the recording' };
  // A recording starts when the meeting does: the link is the ONE occurrence
  // whose start is within 20 minutes of it. Two such starts is ambiguity, and
  // ambiguity is refused, never ranked.
  const starting = overlaps.filter((o) => {
    const s = String(o.start_time).slice(0, 16);
    return local >= _shift(s, -NOTE_SLACK_MIN) && local <= _shift(s, NOTE_SLACK_MIN);
  });
  if (starting.length > 1) return { ...base, noteStartLocal: local, why: `${starting.length} calendar occurrences start within ${NOTE_SLACK_MIN} min of the recording — not guessing which` };
  if (!starting.length) return { ...base, noteStartLocal: local, why: `${overlaps.length} occurrence(s) span the recording but none started within ${NOTE_SLACK_MIN} min of it — not guessing` };
  const o = starting[0];
  return {
    ...base,
    noteStartLocal: local,
    why: null,
    occurrence: {
      meetingId: o.source === 'graph' ? `graph:${o.event_id}` : `${o.source || 'unknown'}:${o.event_id}`,
      subject: o.subject || null,
      seriesKey: normSubject(o.subject),
      start: String(o.start_time).slice(0, 16),
      end: String(o.end_time || o.start_time).slice(0, 16),
    },
  };
}

function _readStartAt(notePath, vaultRoot) {
  try {
    const text = fs.readFileSync(path.join(vaultRoot, notePath), 'utf8').slice(0, 4000);
    const m = text.match(/^start_at:\s*"?([0-9T:.\-+Z]+)"?/m);
    return { found: true, startAt: m ? m[1] : null };
  } catch { return { found: false, startAt: null }; }
}

/** Link a write-up path to its occurrence (reads the vault + calendar_history). Never throws. */
function meetingLinkFor(notePath, { vaultRoot = process.env.OBSIDIAN_VAULT_PATH, cache = null } = {}) {
  if (!isMeetingNote(notePath)) return null;
  if (cache && cache.has(notePath)) return cache.get(notePath);
  let link;
  if (!vaultRoot) link = { notePath, rule: 'plaud-start-within-occurrence±20min', occurrence: null, why: 'vault not configured' };
  else {
    const read = _readStartAt(notePath, vaultRoot);
    if (!read.found) link = { notePath, rule: 'plaud-start-within-occurrence±20min', occurrence: null, why: 'write-up not found (moved or archived)' };
    else {
      let occ = [];
      try {
        const day = notePath.match(/(\d{4}-\d{2}-\d{2})/);
        // The note's own start decides the day when it has one; the filename date otherwise.
        const ms = read.startAt ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(read.startAt) ? read.startAt : `${read.startAt}Z`) : NaN;
        const d = Number.isFinite(ms) ? _localMinute(ms).slice(0, 10) : (day ? day[1] : null);
        if (d) {
          occ = db.all(`SELECT event_id, start_time, end_time, subject, source, show_as, first_seen FROM calendar_history
                         WHERE substr(start_time, 1, 10) = ? AND attendees_other = 1 AND is_all_day = 0`, [d]);
        }
      } catch { occ = []; }
      link = linkOccurrence(notePath, read.startAt, occ);
    }
  }
  if (cache) cache.set(notePath, link);
  return link;
}

// ── NEURO tasks ─────────────────────────────────────────────────────────────

function _mgmtByTask() {
  const out = new Map();
  try {
    for (const r of db.all('SELECT id, person, owner, type, task_id FROM management_log WHERE task_id IS NOT NULL')) {
      out.set(r.task_id, { id: r.id, person: r.person || null, owner: r.owner || null, type: r.type || null });
    }
  } catch { /* table absent in an old DB: no management-log context */ }
  return out;
}

/** The observation payload for one tasks row. PURE given the row and its context. */
function neuroTaskPayload(row, { meeting = null, managementLog = null } = {}) {
  const body = {
    system: 'neuro',
    recordId: String(row.id),
    title: String(row.text || '').slice(0, MAX_TEXT),
    status: row.status,
    moscow: row.moscow || null,
    priority: row.priority == null ? null : String(row.priority),
    dueDate: row.due_date ? String(row.due_date).slice(0, 10) : null,
    source: row.source || null,
    originPath: row.origin_path || null,
    originLine: row.origin_line == null ? null : row.origin_line,
    origin: row.origin || null,
    originProposed: row.origin_proposed === 1,
    msId: row.ms_id || null,
    msSource: row.ms_source || null,
    assignee: row.assignee || null,
    household: row.household === 1,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    completedAt: row.completed_at || null,
    meeting,
    managementLog,
  };
  return { ...body, fingerprint: fingerprintOf(body) };
}

/**
 * The idempotency key is the TRANSITION, not the state. A state-only key folds
 * A→B→A into the first A — a task reopened to exactly its original state would
 * vanish into the event that created it (caught by the reopen test). Keyed on
 * the transition, a return to an earlier state is a new fact, and an unchanged
 * record is not republished at all.
 */
// ⚠ Build 5B: the previous token is the EVENT that set the held state, read
// from the log (change-key.js). The Build 4 token was the held FINGERPRINT,
// which fixed A→B→A and left A→B→A→B: the second A→B reproduced the first
// one's key and folded, leaving the projection at A.
const TASK_TYPES = ['observation.task.observed', 'observation.task.removed'];
const TASK_REMOVED = ['observation.task.removed'];

function _sourceSystem(system) {
  if (system === 'neuro') return 'neuro-tasks';
  if (system === 'eventkit-reminders') return 'eventkit';
  return 'microsoft-graph';
}

function _publishTask(payload, nowMs) {
  const subjectId = `${payload.system}:${payload.recordId}`.slice(0, 256);
  const held = ck.latest('task', subjectId, TASK_TYPES, TASK_REMOVED);
  if (ck.isUnchanged(held, payload.fingerprint)) return { duplicate: true, unchanged: true };
  return _safe({
    type: 'observation.task.observed',
    occurredAt: new Date(nowMs).toISOString(),
    source: { system: _sourceSystem(payload.system), recordId: payload.recordId },
    subject: { entityType: 'task', entityId: subjectId },
    idempotencyKey: ck.observationKey(`task-observed:${payload.system}`, payload.recordId, held, payload.fingerprint),
    payload,
  }, { now: nowMs });
}

function _publishRemoved(system, recordId, heldRow, nowMs, why) {
  const subjectId = `${system}:${recordId}`.slice(0, 256);
  const last = ck.latest('task', subjectId, TASK_TYPES, TASK_REMOVED);
  if (last && last.removed) return { duplicate: true, unchanged: true };
  return _safe({
    type: 'observation.task.removed',
    occurredAt: new Date(nowMs).toISOString(),
    source: { system: _sourceSystem(system), recordId: String(recordId) },
    subject: { entityType: 'task', entityId: subjectId },
    // Keyed on the observation that made it present: one removal per presence.
    idempotencyKey: ck.removalKey(`task-removed:${system}`, recordId, last),
    payload: { system, recordId: String(recordId), lastFingerprint: heldRow.fingerprint || (last && last.fingerprint) || 'none', why },
  }, { now: nowMs });
}

/** Records the projection holds from a source and has not marked removed. */
function _held(system) {
  try {
    return db.all('SELECT record_id, fingerprint, evidence_event_id FROM wm_task_sources WHERE system = ? AND removed = 0', [system]);
  } catch { return []; }
}

/**
 * Publish every NEURO task row (unchanged rows fold). A row that has vanished
 * from the table — which only a deliberate delete does — is published as
 * removed, because a read of the whole table IS complete.
 */
function publishNeuroTasks({ now = Date.now(), vaultRoot } = {}) {
  try {
    const nowMs = now instanceof Date ? now.getTime() : now;
    const rows = db.all('SELECT * FROM tasks ORDER BY id');
    const cache = new Map();
    const mgmt = _mgmtByTask();
    let changed = 0;
    const seen = new Set();
    for (const row of rows) {
      seen.add(String(row.id));
      const meeting = isMeetingNote(row.origin_path) ? meetingLinkFor(row.origin_path, { vaultRoot, cache }) : null;
      const r = _publishTask(neuroTaskPayload(row, { meeting, managementLog: mgmt.get(row.id) || null }), nowMs);
      if (r && !r.duplicate) changed += 1;
    }
    let removed = 0;
    for (const h of _held('neuro')) {
      if (seen.has(h.record_id)) continue;
      const r = _publishRemoved('neuro', h.record_id, h, nowMs, 'row no longer in the tasks table');
      if (r && !r.duplicate) removed += 1;
    }
    return { observed: rows.length, changed, removed };
  } catch (e) {
    console.warn(`[ObligationSources] NEURO tasks not recorded: ${e.message}`);
    return { error: e.message };
  }
}

// ── waiting_on ──────────────────────────────────────────────────────────────

/** The observation payload for one waiting_on row. PURE given the row. */
function waitingOnPayload(row, { meeting = null } = {}) {
  const body = {
    system: 'waiting-on',
    recordId: String(row.key),
    description: String(row.text || '').slice(0, MAX_TEXT),
    status: row.status,
    promisorFirstName: row.person || null,
    promisorFull: row.person_full || null,
    // The extractor routed this here because its owner was somebody OTHER than
    // Nick, in a write-up of a meeting Nick was in. That classification is the
    // source's, and it is what makes Nick the waiting party.
    waitingParty: 'nick',
    sourcePath: row.source_path || null,
    sourceDate: row.source_date || null,
    firstSeen: row.first_seen || null,
    lastSeen: row.last_seen || null,
    sightings: row.sightings || 1,
    reopenedAt: row.reopened_at || null,
    resolvedAt: row.resolved_at || null,
    snoozedUntil: row.snoozed_until || null,
    askedAt: row.asked_at || null,
    meeting,
  };
  // ⚠ lastSeen is OUT of the fingerprint: it is stamped on every re-sighting of
  // the same line, and keying on it would turn the 9-variants-of-one-recording
  // fold into nine "changes". Sightings (the count) is in — a re-sighting in a
  // genuinely new note is evidence.
  const { lastSeen, ...stable } = body;
  return { ...body, fingerprint: fingerprintOf(stable) };
}

function publishWaitingOn({ now = Date.now(), vaultRoot } = {}) {
  try {
    const nowMs = now instanceof Date ? now.getTime() : now;
    const rows = db.all('SELECT * FROM waiting_on ORDER BY key');
    const cache = new Map();
    let changed = 0;
    for (const row of rows) {
      const meeting = row.source_path ? meetingLinkFor(row.source_path, { vaultRoot, cache }) : null;
      const payload = waitingOnPayload(row, { meeting });
      const subjectId = `waiting-on:${payload.recordId}`.slice(0, 256);
      const held = ck.latest('commitment', subjectId, ['observation.commitment.observed']);
      if (ck.isUnchanged(held, payload.fingerprint)) continue; // unchanged: nothing to say
      const r = _safe({
        type: 'observation.commitment.observed',
        occurredAt: new Date(nowMs).toISOString(),
        source: { system: 'neuro-waiting-on', recordId: payload.recordId.slice(0, 256) },
        subject: { entityType: 'commitment', entityId: subjectId },
        idempotencyKey: ck.observationKey('commitment-observed:waiting-on', payload.recordId, held, payload.fingerprint),
        payload,
      }, { now: nowMs });
      if (r && !r.duplicate) changed += 1;
    }
    return { observed: rows.length, changed };
  } catch (e) {
    console.warn(`[ObligationSources] waiting-on not recorded: ${e.message}`);
    return { error: e.message };
  }
}

// ── Microsoft ───────────────────────────────────────────────────────────────

/** Planner task → payload. PURE. Graph's own completedDateTime is the completion fact. */
function plannerPayload(t) {
  const done = !!t.completedDateTime || Number(t.percentComplete) >= 100;
  const body = {
    system: 'ms-planner',
    recordId: String(t.id),
    title: String(t.title || '(untitled)').slice(0, MAX_TEXT),
    status: done ? 'completed' : (Number(t.percentComplete) > 0 ? 'in-progress' : 'notStarted'),
    dueDate: t.dueDateTime ? String(t.dueDateTime).slice(0, 10) : null,
    completedAt: t.completedDateTime || null,
    createdAt: t.createdDateTime || null,
    planId: t.planId || null,
    percentComplete: Number.isFinite(Number(t.percentComplete)) ? Number(t.percentComplete) : null,
  };
  return { ...body, fingerprint: fingerprintOf(body) };
}

/** To Do task → payload. PURE. */
function todoPayload(t, listName) {
  const body = {
    system: 'ms-todo',
    recordId: String(t.id),
    title: String(t.title || '(untitled)').slice(0, MAX_TEXT),
    status: t.status || 'notStarted',
    dueDate: t.dueDateTime && t.dueDateTime.dateTime ? String(t.dueDateTime.dateTime).slice(0, 10) : null,
    completedAt: t.completedDateTime && t.completedDateTime.dateTime ? t.completedDateTime.dateTime : null,
    createdAt: t.createdDateTime || null,
    importance: t.importance || null,
    listName: listName || null,
  };
  return { ...body, fingerprint: fingerprintOf(body) };
}

/**
 * Publish what one Microsoft sync saw.
 *
 *   planner          array or null (null = Planner did not answer)
 *   todo             [{ listName, tasks }] or null
 *   complete         true ONLY when every fetch answered in full — removal is
 *                    concluded from absence, and absence from a partial read
 *                    is not evidence (the calendar's truncated-walk rule)
 */
function publishMicrosoftTasks({ planner = null, todo = null, complete = false, now = Date.now() } = {}) {
  try {
    const nowMs = now instanceof Date ? now.getTime() : now;
    let changed = 0;
    const seen = { 'ms-planner': new Set(), 'ms-todo': new Set() };
    for (const t of Array.isArray(planner) ? planner : []) {
      if (!t || !t.id) continue;
      const p = plannerPayload(t);
      seen['ms-planner'].add(p.recordId);
      const r = _publishTask(p, nowMs);
      if (r && !r.duplicate) changed += 1;
    }
    for (const list of Array.isArray(todo) ? todo : []) {
      for (const t of Array.isArray(list.tasks) ? list.tasks : []) {
        if (!t || !t.id) continue;
        const p = todoPayload(t, list.listName);
        seen['ms-todo'].add(p.recordId);
        const r = _publishTask(p, nowMs);
        if (r && !r.duplicate) changed += 1;
      }
    }
    let removed = 0;
    if (complete && Array.isArray(planner) && Array.isArray(todo)) {
      for (const system of ['ms-planner', 'ms-todo']) {
        for (const h of _held(system)) {
          if (seen[system].has(h.record_id)) continue;
          const why = system === 'ms-todo'
            ? 'no longer in the open To Do list (To Do lists open tasks only: completed or deleted, it cannot say which)'
            : 'no longer returned by Planner';
          const r = _publishRemoved(system, h.record_id, h, nowMs, why);
          if (r && !r.duplicate) removed += 1;
        }
      }
    }
    return { planner: seen['ms-planner'].size, todo: seen['ms-todo'].size, changed, removed, complete: !!complete };
  } catch (e) {
    console.warn(`[ObligationSources] Microsoft tasks not recorded: ${e.message}`);
    return { error: e.message };
  }
}

// ── Apple Reminders (Build 11D) ─────────────────────────────────────────────

/**
 * One reminder as the phone holds it → payload. PURE.
 *
 * Reminders is the AUTHORITY on its own records (like Planner on its cards):
 * the completion flag is Apple's, and NEURO never writes to iCloud. The
 * reminder's NOTES are deliberately NOT carried: the log is immutable and a
 * free-text note is exactly the content that should not be in it (the
 * calendar body rule). Priority is carried only when Nick SET one — EventKit's
 * 0 means none, and none is not "low".
 */
function reminderPayload(r) {
  const pr = Number(r.priority);
  const body = {
    system: 'eventkit-reminders',
    recordId: String(r.id),
    title: String(r.title || '(untitled)').slice(0, MAX_TEXT),
    status: r.isCompleted === true ? 'completed' : 'notStarted',
    dueDate: r.dueDate ? String(r.dueDate).slice(0, 10) : null,
    // Wall-clock HH:MM when the reminder has a time; absent for a date-only one.
    dueTime: typeof r.dueTime === 'string' && /^\d{2}:\d{2}$/.test(r.dueTime) ? r.dueTime : null,
    completedAt: r.isCompleted === true && r.completedAt ? String(r.completedAt) : null,
    createdAt: r.createdAt ? String(r.createdAt) : null,
    priority: Number.isFinite(pr) && pr > 0 ? (pr <= 4 ? 'high' : pr === 5 ? 'medium' : 'low') : null,
    list: { id: r.listId ? String(r.listId) : null, title: r.list ? String(r.list).slice(0, 200) : null },
  };
  return { ...body, fingerprint: fingerprintOf(body) };
}

/**
 * Publish what one Reminders push showed.
 *
 *   reminders   [{ id, title, list, listId, isCompleted, completedAt, dueDate, dueTime, priority }]
 *               already filtered to TRACKED lists by the caller
 *   complete    true ONLY when the phone read every tracked list in full —
 *               absence is concluded only from a complete read (To Do's rule)
 *   trackedKeys the list keys this push covered; a reminder held from a list
 *               NOT covered is never concluded removed
 */
function publishReminders({ reminders = [], complete = false, coveredLists = null, now = Date.now() } = {}) {
  try {
    const nowMs = now instanceof Date ? now.getTime() : now;
    let changed = 0;
    const seen = new Set();
    for (const r of Array.isArray(reminders) ? reminders : []) {
      if (!r || !r.id) continue;
      const p = reminderPayload(r);
      seen.add(p.recordId);
      const res = _publishTask(p, nowMs);
      if (res && !res.duplicate) changed += 1;
    }
    let removed = 0;
    if (complete === true && coveredLists instanceof Set) {
      for (const h of _held('eventkit-reminders')) {
        if (seen.has(h.record_id)) continue;
        let listKey = null;
        try {
          const row = db.get(`SELECT payload_json FROM wm_task_sources WHERE system = 'eventkit-reminders' AND record_id = ?`, [h.record_id]);
          const pl = row ? JSON.parse(row.payload_json) : null;
          listKey = pl && pl.list ? require('./source-classification').containerKey('reminder-list', { id: pl.list.id, title: pl.list.title }) : null;
        } catch { listKey = null; }
        if (!listKey || !coveredLists.has(listKey)) continue;
        const r = _publishRemoved('eventkit-reminders', h.record_id, h, nowMs,
          'no longer in its list (deleted, or completed beyond the window the phone sends)');
        if (r && !r.duplicate) removed += 1;
      }
    }
    return { observed: seen.size, changed, removed, complete: !!complete };
  } catch (e) {
    console.warn(`[ObligationSources] reminders not recorded: ${e.message}`);
    return { error: e.message };
  }
}

// ── the backstop ────────────────────────────────────────────────────────────

/** Publish the two NEURO-held stores. The durable job's body. */
function reconcile({ now = Date.now(), vaultRoot } = {}) {
  return { tasks: publishNeuroTasks({ now, vaultRoot }), waitingOn: publishWaitingOn({ now, vaultRoot }) };
}

// A write to either store schedules a publish a few seconds later, so the
// projection follows a tick in seconds rather than at the next reconcile.
// Debounced: a bulk import is one publish, not hundreds.
const timers = {};
function schedulePublish(which, delayMs = 4000) {
  // node --test marks its children with NODE_TEST_CONTEXT. A test that writes a
  // task must not get a stray publish four seconds later into its scratch DB.
  if (process.env.NODE_TEST_CONTEXT && !process.env.OBLIGATION_PUBLISH_IN_TESTS) return;
  if (timers[which]) return;
  timers[which] = setTimeout(() => {
    timers[which] = null;
    if (which === 'tasks') publishNeuroTasks();
    else if (which === 'waiting-on') publishWaitingOn();
  }, delayMs);
  if (timers[which].unref) timers[which].unref();
}

module.exports = {
  isMeetingNote, linkOccurrence, meetingLinkFor, fingerprintOf,
  neuroTaskPayload, waitingOnPayload, plannerPayload, todoPayload, reminderPayload,
  publishNeuroTasks, publishWaitingOn, publishMicrosoftTasks, publishReminders, reconcile, schedulePublish,
};
