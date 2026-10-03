'use strict';

/**
 * The world model, part 2 — Tasks and Commitments (Build 4B, 3 Oct 2026).
 *
 * Folded inside the `world-model` consumer (world-model.js dispatches here),
 * not a consumer of its own, and that is deliberate: owners and beneficiaries
 * resolve against wm_people, and only the SAME ordered fold guarantees a
 * replay sees exactly the people an incremental pass saw at that point.
 *
 * ── Taxonomy (measured on the live Pi before writing this) ──────────────────
 *
 *   TASK         something to be done. NEURO's `tasks` (344 rows, implicitly
 *                Nick's), Microsoft Planner and To Do. A task is not a promise:
 *                "buy dog food" is a task and nobody is waiting on it.
 *   COMMITMENT   an obligation one person made to another or to a group:
 *                  • a task Nick took on IN A MEETING (meeting-promotion, 122
 *                    rows from Meetings/ write-ups) — promisor Nick
 *                  • a management-log action (owner + a named person)
 *                  • a task Nick himself classified origin='commitment'
 *                  • a waiting_on row (404, every one from a meeting write-up)
 *                    — promisor somebody else, Nick the waiting party
 *   WAITING-FOR  a commitment whose promisor is not Nick. A DIRECTION
 *                (`to-nick`), not a third table: the fields are identical and
 *                splitting them is how one of the two copies stops being read.
 *
 * A commitment realised by a task is LINKED to it (related_task_id + a
 * `realised-by` link), never merged into it, and its status FOLLOWS the task's.
 *
 * ── Identity and dedupe — merge only on explicit evidence ───────────────────
 *
 *   • One task per real-world record. A Microsoft task that a NEURO row names
 *     in `ms_id` (task-dedupe's confirmed link) is the SAME task: a synced
 *     source of it, rule `explicit-external-id`. Two NEURO rows claiming one
 *     Microsoft id is a conflict and merges NEITHER.
 *   • Same normalised title, different records, no explicit link → NOT merged.
 *     Recorded as a `possible-same` link. If the other one is completed, that
 *     is a POSSIBLE completion on this one — shown, never applied.
 *
 * ── Completion precedence ───────────────────────────────────────────────────
 *
 *   • A task is completed while ANY of its authoritative sources says it is
 *     (Nick's tick in NEURO; Planner's completedDateTime). Reopening needs the
 *     source that closed it to say open again — an unrelated edit on another
 *     source never reopens it.
 *   • `removed` (a source stopped listing it) is NEVER completion. To Do lists
 *     open tasks only, so a vanished To Do task is `unknown`, not `completed`.
 *   • A waiting-on item is completed when Nick marked it so (his statement),
 *     and REOPENS when the store re-raises it from a later write-up.
 *   • An inferred completion (a possible-same record closed) never changes
 *     status. Silence and absence from a note are never completion.
 *
 * ── Who ─────────────────────────────────────────────────────────────────────
 *
 *   Exact display name, an alias exactly one person claims, or a first name
 *   exactly one declared person carries (the roster rule, judged against the
 *   whole People folder). Anything else stays UNRESOLVED with the raw name
 *   kept and the reason recorded — never a guess.
 */

const crypto = require('crypto');
const db = require('../db/database');

const SELF = 'person:nick-ward';
const MAX_EVIDENCE = 10;

// ── small helpers ───────────────────────────────────────────────────────────

const lower = (s) => String(s || '').trim().toLowerCase();
const collapse = (s) => lower(s).replace(/\s+/g, ' ');
/** Title normalised for the possible-same rule: case, punctuation and spacing only. */
const titleKey = (s) => lower(s).replace(/[^a-z0-9]+/g, ' ').trim();
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

function _appendEvidence(json, eventId) {
  let list = [];
  try { list = JSON.parse(json || '[]'); } catch { list = []; }
  if (!list.includes(eventId)) list.push(eventId);
  return JSON.stringify(list.slice(-MAX_EVIDENCE));
}

function _history(entityId, change, from, to, authority, ev) {
  db.run(`INSERT INTO wm_obligation_history (entity_id, change, from_value, to_value, authority, evidence_event_id, at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, [entityId, change, from ?? null, to ?? null, authority ?? null, ev.eventId, ev.receivedAt]);
}

// ── people ──────────────────────────────────────────────────────────────────

function _peopleIndex() {
  const rows = db.all('SELECT person_id, display_name, aliases_json FROM wm_people');
  const byName = new Map();
  const byAlias = new Map();
  const byFirst = new Map();
  const add = (m, k, id) => { if (!k) return; if (!m.has(k)) m.set(k, new Set()); m.get(k).add(id); };
  for (const r of rows) {
    add(byName, collapse(r.display_name), r.person_id);
    add(byFirst, collapse(r.display_name).split(' ')[0], r.person_id);
    let aliases = [];
    try { aliases = JSON.parse(r.aliases_json || '[]'); } catch { aliases = []; }
    for (const a of aliases) {
      add(byAlias, collapse(a), r.person_id);
      // A one-word alias is also a first name for the uniqueness test (#38):
      // "Nath" listed on Nathan Button only is unique; "Chris" on two is not.
      if (!collapse(a).includes(' ')) add(byFirst, collapse(a), r.person_id);
    }
  }
  return { byName, byAlias, byFirst, has: (id) => rows.some((r) => r.person_id === id) };
}

/**
 * Resolve a raw name to ONE declared person. PURE over the index.
 * Returns { personId, method, confidence } or { personId: null, why }.
 */
function resolveName(raw, idx) {
  const name = collapse(raw);
  if (!name) return { personId: null, method: null, why: 'no name recorded' };
  const exact = idx.byName.get(name);
  if (exact && exact.size === 1) return { personId: [...exact][0], method: 'exact-name', confidence: 1 };
  if (exact && exact.size > 1) return { personId: null, method: null, why: `${exact.size} People notes share the name "${raw}"` };
  const alias = idx.byAlias.get(name);
  if (alias && alias.size === 1) return { personId: [...alias][0], method: 'exact-alias', confidence: 0.95 };
  if (alias && alias.size > 1) return { personId: null, method: null, why: `the alias "${raw}" is claimed by ${alias.size} people` };
  if (!name.includes(' ')) {
    const first = idx.byFirst.get(name);
    if (first && first.size === 1) return { personId: [...first][0], method: 'unique-first-name', confidence: 0.85 };
    if (first && first.size > 1) return { personId: null, method: null, why: `the first name "${raw}" belongs to ${first.size} declared people` };
  }
  return { personId: null, method: null, why: `no People note declares "${raw}"` };
}

// ── due dates ───────────────────────────────────────────────────────────────

/** Calendar days between two YYYY-MM-DD strings (b - a), no zone involved. */
function dayDiff(a, b) {
  const t = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((t(b) - t(a)) / 86400000);
}

/**
 * Where did this due date come from? An INFERENCE, recorded so the evaluator
 * can tell a deadline someone stated from one NEURO filled in.
 *
 *   stated   the task's own words state it (commitment-due's cue rule, judged
 *            as of the day the task was created)
 *   default  exactly the capture default (10 calendar days after creation) on
 *            a meeting/email promotion — NEURO's placeholder, not a promise
 *   set      anything else: somebody set it (Nick in triage, Jira, Planner)
 *   none     no due date
 */
function dueBasis({ dueDate, text, createdAt, promoted }) {
  if (!dueDate) return 'none';
  const created = createdAt ? String(createdAt).slice(0, 10) : null;
  if (created && /^\d{4}-\d{2}-\d{2}$/.test(created)) {
    try {
      const statedDue = require('./commitment-due').statedDue;
      const stated = statedDue(text, new Date(`${created}T12:00:00`));
      if (stated && stated.date === dueDate) return 'stated';
    } catch { /* fall through */ }
    if (promoted) {
      try {
        if (dayDiff(created, dueDate) === require('./commitment-due').DEFAULT_DUE_DAYS) return 'default';
      } catch { /* fall through */ }
    }
  }
  return 'set';
}

// ── tasks ───────────────────────────────────────────────────────────────────

function _norm(system, raw) {
  if (system === 'neuro') {
    if (raw === 'done') return 'completed';
    if (raw === 'dropped') return 'cancelled';
    if (raw === 'open' || raw === 'in-progress') return 'open';
    return 'unknown';
  }
  if (raw === 'completed') return 'completed';
  return 'open';
}

function _neuroClaimingMs(msId) {
  return db.all(`SELECT record_id FROM wm_task_sources WHERE system = 'neuro' AND removed = 0
                  AND json_extract(payload_json, '$.msId') = ? ORDER BY CAST(record_id AS INTEGER)`, [msId]);
}

/** Which task a source record belongs to — a pure function of what the sources say now. */
function _taskIdFor(system, recordId) {
  if (system === 'neuro') return `task:neuro:${recordId}`;
  const claimants = _neuroClaimingMs(recordId);
  if (claimants.length === 1) return `task:neuro:${claimants[0].record_id}`;
  return `task:${system}:${recordId}`;
}

function _originKind(p) {
  if (p.system !== 'neuro') return 'microsoft';
  const s = String(p.source || '');
  if (p.managementLog) return 'management-log';
  if (p.meeting || /^Meetings\//.test(p.originPath || '')) return 'meeting';
  if (s.startsWith('email') || /^email:/.test(p.originPath || '')) return 'email';
  if (s.startsWith('jira')) return 'jira';
  if (s.startsWith('vantage')) return 'vantage';
  if (s.startsWith('capture') || s === 'obsidian-capture' || s === 'neuro-mobile') return 'capture';
  return 'other';
}

/**
 * Recompute one task row from its sources. Writes wm_tasks (or removes the
 * row when no source points at it any more) and the transition history.
 */
function _recomputeTask(taskId, ev, idx) {
  const sources = db.all('SELECT * FROM wm_task_sources WHERE task_id = ? ORDER BY role, system, record_id', [taskId]);
  const prior = db.get('SELECT * FROM wm_tasks WHERE task_id = ?', [taskId]);
  if (!sources.length) {
    if (prior) db.run('DELETE FROM wm_tasks WHERE task_id = ?', [taskId]);
    return null;
  }
  const lead = sources.find((s) => s.role === 'leading') || sources[0];
  const p = JSON.parse(lead.payload_json);
  const live = sources.filter((s) => !s.removed);

  // Completion holds while any authoritative source says complete.
  let status; let authority = null; let completedAt = null;
  const closer = live.find((s) => s.status === 'completed');
  if (closer) { status = 'completed'; authority = closer.system; completedAt = closer.completed_at; }
  else if (!live.length) { status = 'unknown'; authority = lead.system; }
  else if (!lead.removed) { status = lead.status; authority = lead.system; }
  else { status = live[0].status; authority = live[0].system; }

  // Owner: NEURO's task list and Microsoft's /me queries are both Nick's by
  // construction — a fact about the store, not a guess about the words.
  let ownerRaw = null; let ownerMethod; let ownerPerson = null;
  if (p.system === 'neuro' && p.assignee) { ownerRaw = p.assignee; ownerMethod = 'assignee'; }
  else {
    ownerMethod = p.system === 'neuro' ? 'store-owner' : 'source-query-scope';
    ownerPerson = idx.has(SELF) ? SELF : null;
    ownerRaw = 'nick';
  }

  const meeting = p.meeting || null;
  const occ = meeting && meeting.occurrence ? meeting.occurrence : null;
  const promoted = /promotion$/.test(String(p.source || ''));
  const fields = {
    title: p.title,
    title_key: titleKey(p.title),
    status,
    raw_status: lead.raw_status,
    completion_authority: status === 'completed' ? authority : null,
    moscow: p.moscow || null,
    priority: p.priority || null,
    due_date: p.dueDate || null,
    due_basis: dueBasis({ dueDate: p.dueDate, text: p.title, createdAt: p.createdAt, promoted }),
    owner_person_id: ownerPerson,
    owner_raw: ownerRaw,
    owner_method: ownerMethod,
    origin_kind: _originKind(p),
    origin_path: p.originPath || null,
    origin_line: p.originLine == null ? null : p.originLine,
    meeting_json: meeting ? JSON.stringify(meeting) : null,
    meeting_id: occ ? occ.meetingId : null,
    meeting_series_key: occ ? occ.seriesKey : null,
    household: p.household ? 1 : 0,
    created_at: p.createdAt || null,
    updated_at: p.updatedAt || null,
    completed_at: status === 'completed' ? (completedAt || p.completedAt || null) : null,
    provenance_kind: 'fact',
    confidence: 1,
    observed_at: ev.occurredAt,
    received_at: ev.receivedAt,
    evidence_json: _appendEvidence(prior && prior.evidence_json, ev.eventId),
    fingerprint: p.fingerprint,
  };
  const cols = Object.keys(fields);
  db.run(`INSERT INTO wm_tasks (task_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
          ON CONFLICT(task_id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`,
  [taskId, ...cols.map((c) => fields[c])]);

  if (!prior) _history(taskId, 'created', null, status, lead.system, ev);
  else if (prior.status !== status) {
    const change = status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled'
      : status === 'unknown' ? 'unknown' : 'reopened';
    _history(taskId, change, prior.status, status, authority, ev);
  }
  if (prior && (prior.due_date || null) !== (fields.due_date || null)) _history(taskId, 'due-changed', prior.due_date, fields.due_date, lead.system, ev);
  if (prior && (prior.owner_person_id || null) !== (ownerPerson || null)) {
    _history(taskId, ownerPerson ? 'owner-linked' : 'owner-unlinked', prior.owner_person_id, ownerPerson, ownerMethod, ev);
  }
  _possibleSame(taskId, fields.title_key, ev);
  return fields;
}

/**
 * Same normalised title on another task that is NOT linked by an explicit id:
 * a POSSIBLE relationship, recorded and never merged. A closed counterpart is
 * a POSSIBLE completion here — visible, and never applied to status.
 */
function _possibleSame(taskId, key, ev) {
  db.run(`DELETE FROM wm_obligation_links WHERE relation = 'possible-same' AND rule = 'exact-normalised-title'
            AND (a_id = ? OR b_id = ?)`, [taskId, taskId]);
  if (!key || key.length < 8) { _refreshPossibleCompletion(taskId); return; }
  // ACROSS STORES only. The question is "is this an unlinked copy of the same
  // obligation in another system?". Inside one store, identical wording is
  // either task-dedupe's business (NEURO folds same text by dedupe_key) or a
  // RECURRING series — measured live on 3 Oct: 228 links, every one between
  // completed instances of recurring Planner cards ("Align With Nathan" ×14).
  const store = (id) => id.split(':').slice(0, 2).join(':');
  const others = db.all(`SELECT task_id, status FROM wm_tasks WHERE title_key = ? AND task_id != ?`, [key, taskId])
    .filter((o) => store(o.task_id) !== store(taskId));
  for (const o of others) {
    const [a, b] = [taskId, o.task_id].sort();
    db.run(`INSERT OR REPLACE INTO wm_obligation_links (a_id, b_id, relation, rule, confidence, evidence_event_id, at)
            VALUES (?, ?, 'possible-same', 'exact-normalised-title', 0.5, ?, ?)`, [a, b, ev.eventId, ev.receivedAt]);
    _refreshPossibleCompletion(o.task_id);
  }
  _refreshPossibleCompletion(taskId);
}

function _refreshPossibleCompletion(taskId) {
  const row = db.get('SELECT status FROM wm_tasks WHERE task_id = ?', [taskId]);
  if (!row) return;
  const links = db.all(`SELECT * FROM wm_obligation_links WHERE relation = 'possible-same' AND (a_id = ? OR b_id = ?)`, [taskId, taskId]);
  const closed = links.map((l) => (l.a_id === taskId ? l.b_id : l.a_id))
    .map((id) => db.get('SELECT task_id, status, completed_at, completion_authority FROM wm_tasks WHERE task_id = ?', [id]))
    .filter((t) => t && t.status === 'completed');
  const value = row.status === 'open' && closed.length
    ? JSON.stringify({ kind: 'inference', rule: 'exact-normalised-title', by: closed.map((t) => ({ taskId: t.task_id, completedAt: t.completed_at, authority: t.completion_authority })), note: 'a record with the same wording is closed — not applied: wording is not identity' })
    : null;
  db.run('UPDATE wm_tasks SET possible_completion_json = ? WHERE task_id = ?', [value, taskId]);
}

function applyTaskObserved(ev, idx = _peopleIndex()) {
  const p = ev.payload;
  const system = p.system;
  const recordId = String(p.recordId);
  const prior = db.get('SELECT * FROM wm_task_sources WHERE system = ? AND record_id = ?', [system, recordId]);
  const affected = new Set(prior ? [prior.task_id] : []);

  const taskId = _taskIdFor(system, recordId);
  const role = system === 'neuro' || taskId === `task:${system}:${recordId}` ? 'leading' : 'synced';
  const rule = role === 'leading' ? 'own-id' : 'explicit-external-id';
  db.run(`INSERT INTO wm_task_sources (system, record_id, task_id, role, match_rule, status, raw_status, completed_at,
            fingerprint, removed, payload_json, observed_at, evidence_event_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
          ON CONFLICT(system, record_id) DO UPDATE SET task_id = excluded.task_id, role = excluded.role,
            match_rule = excluded.match_rule, status = excluded.status, raw_status = excluded.raw_status,
            completed_at = excluded.completed_at, fingerprint = excluded.fingerprint, removed = 0,
            payload_json = excluded.payload_json, observed_at = excluded.observed_at, evidence_event_id = excluded.evidence_event_id`,
  [system, recordId, taskId, role, rule, _norm(system, p.status), p.status, p.completedAt || null, p.fingerprint,
    JSON.stringify(p), ev.occurredAt, ev.eventId]);
  affected.add(taskId);
  if (role === 'synced') {
    const [a, b] = [taskId, `task:${system}:${recordId}`];
    db.run(`INSERT OR REPLACE INTO wm_obligation_links (a_id, b_id, relation, rule, confidence, evidence_event_id, at)
            VALUES (?, ?, 'synced', 'explicit-external-id', 1, ?, ?)`, [a, b, ev.eventId, ev.receivedAt]);
  }

  // A NEURO row's ms_id decides which Microsoft records it leads. Re-point every
  // Microsoft source whose assignment may have changed: the one it names now,
  // and any it used to lead.
  if (system === 'neuro') {
    const msIds = new Set();
    if (p.msId) msIds.add(p.msId);
    for (const s of db.all(`SELECT system, record_id FROM wm_task_sources WHERE task_id = ? AND system != 'neuro'`, [taskId])) msIds.add(s.record_id);
    for (const msId of msIds) {
      for (const s of db.all(`SELECT * FROM wm_task_sources WHERE system IN ('ms-planner', 'ms-todo') AND record_id = ?`, [msId])) {
        const want = _taskIdFor(s.system, s.record_id);
        if (want === s.task_id) continue;
        const wantRole = want === `task:${s.system}:${s.record_id}` ? 'leading' : 'synced';
        db.run(`UPDATE wm_task_sources SET task_id = ?, role = ?, match_rule = ? WHERE system = ? AND record_id = ?`,
          [want, wantRole, wantRole === 'leading' ? 'own-id' : 'explicit-external-id', s.system, s.record_id]);
        if (wantRole === 'synced') {
          db.run(`INSERT OR REPLACE INTO wm_obligation_links (a_id, b_id, relation, rule, confidence, evidence_event_id, at)
                  VALUES (?, ?, 'synced', 'explicit-external-id', 1, ?, ?)`, [want, `task:${s.system}:${s.record_id}`, ev.eventId, ev.receivedAt]);
        } else {
          db.run(`DELETE FROM wm_obligation_links WHERE relation = 'synced' AND b_id = ?`, [`task:${s.system}:${s.record_id}`]);
        }
        affected.add(s.task_id);
        affected.add(want);
      }
    }
    if (_neuroClaimingMs(p.msId || '').length > 1) {
      db.run(`INSERT INTO wm_identity_log (kind, value, person_id, action, rule, evidence_event_id, detail_json, at)
              VALUES ('ms-task', ?, NULL, 'conflict', 'two-neuro-tasks-one-ms-id', ?, ?, ?)`,
      [p.msId, ev.eventId, JSON.stringify({ claimants: _neuroClaimingMs(p.msId).map((r) => r.record_id) }), ev.receivedAt]);
    }
  }
  for (const id of affected) _recomputeTask(id, ev, idx);
  if (system === 'neuro') _recomputeTaskCommitment(recordId, ev, idx);
}

function applyTaskRemoved(ev, idx = _peopleIndex()) {
  const p = ev.payload;
  const src = db.get('SELECT * FROM wm_task_sources WHERE system = ? AND record_id = ?', [p.system, String(p.recordId)]);
  // ⚠ Only about the version still held. A removal of an older fingerprint,
  // since re-observed, changes nothing.
  if (!src || src.removed || src.fingerprint !== p.lastFingerprint) return;
  db.run(`UPDATE wm_task_sources SET removed = 1, status = 'unknown', observed_at = ?, evidence_event_id = ?
          WHERE system = ? AND record_id = ?`, [ev.occurredAt, ev.eventId, p.system, String(p.recordId)]);
  _recomputeTask(src.task_id, ev, idx);
  if (p.system === 'neuro') _recomputeTaskCommitment(String(p.recordId), ev, idx);
}

// ── commitments ─────────────────────────────────────────────────────────────

const NAMED_SELF = /^\s*(?:nick(?:\s+ward)?)\b\s*(?:to\b|will\b|:|-|–|—)/i;
// "send the figures to Chris Middleton" — a DELIVERY verb, then "to <Name>".
// Only a name that resolves to ONE declared person is taken; "speak to Lucy"
// (not a delivery) names a counterparty, not a beneficiary, and is left alone.
const DELIVERY = /\b(?:send|sends|give|share|provide|forward|email|deliver|submit|report)\b[^.;:!?]*?\bto\s+([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+)?)/;

/** Is a task, as observed, a commitment — and of which kind? PURE. */
function commitmentKindOfTask(p) {
  if (p.system !== 'neuro' || p.household) return null;
  if (p.managementLog && /^nick\b/i.test(String(p.managementLog.owner || ''))) return 'management-log';
  if (/promotion$/.test(String(p.source || '')) && /^Meetings\//.test(String(p.originPath || ''))) return 'meeting-task';
  if (p.origin === 'commitment' && !p.originProposed) return 'declared-commitment';
  return null;
}

function _beneficiaryFromText(text, idx) {
  const m = String(text || '').match(DELIVERY);
  if (!m) return null;
  const r = resolveName(m[1], idx);
  return r.personId && r.method === 'exact-name' ? { personId: r.personId, raw: m[1], method: 'delivery-verb+exact-name' } : null;
}

function _writeCommitment(id, fields, ev) {
  const prior = db.get('SELECT * FROM wm_commitments WHERE commitment_id = ?', [id]);
  // A recompute that changes nothing writes nothing — a person declared
  // elsewhere must not stamp itself as evidence on four hundred commitments.
  const VOLATILE = new Set(['observed_at', 'received_at', 'evidence_json']);
  if (prior && Object.keys(fields).every((k) => VOLATILE.has(k) || (prior[k] ?? null) === (fields[k] ?? null))) return;
  fields.evidence_json = _appendEvidence(prior && prior.evidence_json, ev.eventId);
  const cols = Object.keys(fields);
  db.run(`INSERT INTO wm_commitments (commitment_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
          ON CONFLICT(commitment_id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`,
  [id, ...cols.map((c) => fields[c])]);
  if (!prior) _history(id, 'created', null, fields.status, fields.completion_authority || fields.source_kind, ev);
  else if (prior.status !== fields.status) {
    const change = fields.status === 'completed' ? 'completed' : fields.status === 'cancelled' ? 'cancelled'
      : fields.status === 'superseded' ? 'superseded' : fields.status === 'unknown' ? 'unknown' : 'reopened';
    _history(id, change, prior.status, fields.status, fields.completion_authority || fields.source_kind, ev);
  }
  if (prior && (prior.promisor_person_id || null) !== (fields.promisor_person_id || null)) {
    _history(id, fields.promisor_person_id ? 'owner-linked' : 'owner-unlinked', prior.promisor_person_id, fields.promisor_person_id, fields.promisor_method, ev);
  }
}

/** The commitment (if any) a NEURO task row carries, following the task's status. */
function _recomputeTaskCommitment(recordId, ev, idx) {
  const id = `commitment:task:${recordId}`;
  const src = db.get(`SELECT * FROM wm_task_sources WHERE system = 'neuro' AND record_id = ?`, [recordId]);
  const prior = db.get('SELECT * FROM wm_commitments WHERE commitment_id = ?', [id]);
  const p = src ? JSON.parse(src.payload_json) : null;
  const kind = p ? commitmentKindOfTask(p) : null;
  if (!kind) {
    // It used to be one and is not any more (reclassified, or the row went):
    // superseded, never deleted — "why did this stop being a commitment" keeps an answer.
    if (prior && prior.status !== 'superseded') {
      const { commitment_id: _id, ...rest } = prior;
      _writeCommitment(id, { ...rest, status: 'superseded', completion_authority: null, observed_at: ev.occurredAt, received_at: ev.receivedAt }, ev);
    }
    return;
  }
  const taskId = `task:neuro:${recordId}`;
  const task = db.get('SELECT * FROM wm_tasks WHERE task_id = ?', [taskId]);
  if (!task) return;

  const promisor = NAMED_SELF.test(p.title) || kind === 'management-log'
    ? { personId: idx.has(SELF) ? SELF : null, raw: 'Nick', method: kind === 'management-log' ? 'store-owner' : 'named-in-text', confidence: 1 }
    : { personId: idx.has(SELF) ? SELF : null, raw: 'Nick', method: 'accepted-into-task-list', confidence: 0.8 };

  let beneficiary = { kind: 'unknown', personId: null, raw: null, method: null };
  if (kind === 'management-log' && p.managementLog.person) {
    const r = resolveName(p.managementLog.person, idx);
    beneficiary = { kind: 'person', personId: r.personId, raw: p.managementLog.person, method: r.method || null };
  } else {
    const named = _beneficiaryFromText(p.title, idx);
    if (named) beneficiary = { kind: 'person', ...named };
    else if (task.meeting_id) beneficiary = { kind: 'meeting', personId: null, raw: null, method: 'meeting-attendees' };
  }

  const meeting = p.meeting || null;
  _writeCommitment(id, {
    description: p.title,
    direction: 'by-nick',
    promisor_person_id: promisor.personId,
    promisor_raw: promisor.raw,
    promisor_method: promisor.method,
    promisor_confidence: promisor.confidence,
    promisor_why: promisor.personId ? null : 'Nick\'s People note is not declared in the world model yet',
    beneficiary_kind: beneficiary.kind,
    beneficiary_person_id: beneficiary.personId || null,
    beneficiary_raw: beneficiary.raw || null,
    beneficiary_method: beneficiary.method || null,
    waiting_party: null,
    status: task.status,
    raw_status: task.raw_status,
    completion_authority: task.completion_authority,
    due_date: task.due_date,
    due_basis: task.due_basis,
    source_kind: kind,
    source_ref: `neuro-task:${recordId}`,
    source_path: p.originPath || null,
    source_line: p.originLine == null ? null : p.originLine,
    source_date: (String(p.originPath || '').match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null,
    meeting_json: meeting ? JSON.stringify(meeting) : null,
    meeting_id: task.meeting_id,
    meeting_series_key: task.meeting_series_key,
    related_task_id: taskId,
    created_at: p.createdAt || null,
    updated_at: p.updatedAt || null,
    completed_at: task.completed_at,
    last_progress_at: p.status === 'in-progress' ? (p.updatedAt || null) : null,
    // Promoted from a write-up and approved by Nick: what the meeting said is
    // an observation; that it is Nick's is his own act. Kind of the RECORD.
    provenance_kind: kind === 'meeting-task' ? 'observation' : 'fact',
    confidence: promisor.confidence,
    observed_at: ev.occurredAt,
    received_at: ev.receivedAt,
    fingerprint: p.fingerprint,
  }, ev);
  db.run(`INSERT OR REPLACE INTO wm_obligation_links (a_id, b_id, relation, rule, confidence, evidence_event_id, at)
          VALUES (?, ?, 'realised-by', 'task-is-the-record', 1, ?, ?)`, [id, taskId, ev.eventId, ev.receivedAt]);
}

function _waitingStatus(raw) {
  if (raw === 'done') return 'completed';
  if (raw === 'dropped') return 'cancelled';
  if (raw === 'open') return 'open';
  return 'unknown';
}

function _waitingFields(p, idx, ev) {
  const byFull = p.promisorFull ? resolveName(p.promisorFull, idx) : null;
  const r = byFull && byFull.personId ? byFull : resolveName(p.promisorFirstName, idx);
  const why = r.personId ? null : (byFull && byFull.why ? `${byFull.why}; ${r.why}` : r.why);
  const meeting = p.meeting || null;
  const occ = meeting && meeting.occurrence ? meeting.occurrence : null;
  const status = _waitingStatus(p.status);
  return {
    description: p.description,
    direction: 'to-nick',
    promisor_person_id: r.personId || null,
    promisor_raw: p.promisorFull || p.promisorFirstName || null,
    promisor_method: r.method || null,
    promisor_confidence: r.personId ? r.confidence : null,
    promisor_why: why,
    beneficiary_kind: occ ? 'meeting' : 'unknown',
    beneficiary_person_id: null,
    beneficiary_raw: null,
    beneficiary_method: occ ? 'meeting-attendees' : null,
    waiting_party: idx.has(SELF) ? SELF : 'nick',
    status,
    raw_status: p.status,
    completion_authority: status === 'completed' || status === 'cancelled' ? 'nick-marked' : null,
    due_date: null,
    due_basis: 'none',
    source_kind: 'meeting-waiting-on',
    source_ref: `waiting-on:${p.recordId}`,
    source_path: p.sourcePath || null,
    source_line: null,
    source_date: p.sourceDate || null,
    meeting_json: meeting ? JSON.stringify(meeting) : null,
    meeting_id: occ ? occ.meetingId : null,
    meeting_series_key: occ ? occ.seriesKey : null,
    related_task_id: null,
    created_at: p.firstSeen || null,
    updated_at: p.reopenedAt || p.resolvedAt || p.firstSeen || null,
    completed_at: status === 'completed' ? (p.resolvedAt || null) : null,
    last_progress_at: p.askedAt || null,
    provenance_kind: 'observation',
    confidence: r.personId ? Math.min(0.9, r.confidence) : 0.5,
    observed_at: ev.occurredAt,
    received_at: ev.receivedAt,
    fingerprint: p.fingerprint,
  };
}

function waitingCommitmentId(recordId) { return `commitment:waiting:${hash(recordId)}`; }

function applyCommitmentObserved(ev, idx = _peopleIndex()) {
  const p = ev.payload;
  if (p.system !== 'waiting-on') return;
  _writeCommitment(waitingCommitmentId(p.recordId), { ..._waitingFields(p, idx, ev), payload_json: JSON.stringify(p) }, ev);
}

/**
 * A person was declared or changed: re-resolve every owner and promisor that
 * names people, against the people as they stand NOW in the fold. Bounded
 * (hundreds of rows) and deterministic on replay because it runs at the same
 * point in the log.
 */
function relinkPeople(ev) {
  const idx = _peopleIndex();
  for (const t of db.all('SELECT task_id FROM wm_tasks')) {
    const before = db.get('SELECT owner_person_id FROM wm_tasks WHERE task_id = ?', [t.task_id]);
    const want = (() => {
      const row = db.get('SELECT owner_method FROM wm_tasks WHERE task_id = ?', [t.task_id]);
      return row && (row.owner_method === 'store-owner' || row.owner_method === 'source-query-scope') && idx.has(SELF) ? SELF : null;
    })();
    if ((before.owner_person_id || null) !== want) {
      db.run('UPDATE wm_tasks SET owner_person_id = ? WHERE task_id = ?', [want, t.task_id]);
      _history(t.task_id, want ? 'owner-linked' : 'owner-unlinked', before.owner_person_id, want, 'person-declared', ev);
    }
  }
  for (const s of db.all(`SELECT record_id FROM wm_task_sources WHERE system = 'neuro'`)) _recomputeTaskCommitment(s.record_id, ev, idx);
  for (const c of db.all(`SELECT * FROM wm_commitments WHERE source_kind = 'meeting-waiting-on'`)) {
    // The payload the fold last APPLIED, kept on the row — never re-read from
    // the log, which during a replay holds events this consumer has not reached.
    const p = _parse(c.payload_json);
    if (!p) continue;
    const fields = _waitingFields(p, idx, { occurredAt: c.observed_at, receivedAt: c.received_at });
    if ((c.promisor_person_id || null) === (fields.promisor_person_id || null) && c.waiting_party === fields.waiting_party) continue;
    db.run(`UPDATE wm_commitments SET promisor_person_id = ?, promisor_method = ?, promisor_confidence = ?, promisor_why = ?,
              waiting_party = ?, confidence = ? WHERE commitment_id = ?`,
    [fields.promisor_person_id, fields.promisor_method, fields.promisor_confidence, fields.promisor_why,
      fields.waiting_party, fields.confidence, c.commitment_id]);
    _history(c.commitment_id, fields.promisor_person_id ? 'owner-linked' : 'owner-unlinked', c.promisor_person_id,
      fields.promisor_person_id, fields.promisor_method || 'person-declared', ev);
  }
}

// ── projection management ───────────────────────────────────────────────────

const TABLES = ['wm_tasks', 'wm_task_sources', 'wm_commitments', 'wm_obligation_links', 'wm_obligation_history'];

function reset() { for (const t of TABLES) db.run(`DELETE FROM ${t}`); }

// ── reading ─────────────────────────────────────────────────────────────────

function _parse(json) { try { return json ? JSON.parse(json) : null; } catch { return null; } }

function _personName(id) {
  if (!id) return null;
  const r = db.get('SELECT display_name FROM wm_people WHERE person_id = ?', [id]);
  return r ? r.display_name : null;
}

function shapeCommitment(r) {
  if (!r) return null;
  return {
    commitmentId: r.commitment_id,
    description: r.description,
    direction: r.direction,
    promisor: { personId: r.promisor_person_id, displayName: _personName(r.promisor_person_id), raw: r.promisor_raw,
      method: r.promisor_method, confidence: r.promisor_confidence, unresolvedWhy: r.promisor_why },
    beneficiary: { kind: r.beneficiary_kind, personId: r.beneficiary_person_id, displayName: _personName(r.beneficiary_person_id),
      raw: r.beneficiary_raw, method: r.beneficiary_method },
    waitingParty: r.waiting_party,
    status: r.status,
    rawStatus: r.raw_status,
    completionAuthority: r.completion_authority,
    due: r.due_date ? { date: r.due_date, basis: r.due_basis } : null,
    source: { kind: r.source_kind, ref: r.source_ref, path: r.source_path, line: r.source_line, date: r.source_date },
    meeting: _parse(r.meeting_json),
    meetingId: r.meeting_id,
    meetingSeriesKey: r.meeting_series_key,
    relatedTaskId: r.related_task_id,
    createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at, lastProgressAt: r.last_progress_at,
    provenance: { kind: r.provenance_kind, confidence: r.confidence, evidence: _parse(r.evidence_json) || [] },
    observedAt: r.observed_at,
  };
}

function shapeTask(r) {
  if (!r) return null;
  const sources = db.all('SELECT system, record_id, role, match_rule, status, raw_status, removed, observed_at, evidence_event_id FROM wm_task_sources WHERE task_id = ? ORDER BY role, system', [r.task_id])
    .map((s) => ({ system: s.system, recordId: s.record_id, role: s.role, matchRule: s.match_rule, status: s.status,
      rawStatus: s.raw_status, removed: s.removed === 1, observedAt: s.observed_at, evidenceEventId: s.evidence_event_id }));
  return {
    taskId: r.task_id, title: r.title, status: r.status, rawStatus: r.raw_status, completionAuthority: r.completion_authority,
    moscow: r.moscow, priority: r.priority, due: r.due_date ? { date: r.due_date, basis: r.due_basis } : null,
    owner: { personId: r.owner_person_id, raw: r.owner_raw, method: r.owner_method },
    origin: { kind: r.origin_kind, path: r.origin_path, line: r.origin_line },
    meeting: _parse(r.meeting_json), meetingId: r.meeting_id, meetingSeriesKey: r.meeting_series_key,
    household: r.household === 1,
    createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at,
    possibleCompletion: _parse(r.possible_completion_json),
    sources,
    provenance: { kind: r.provenance_kind, confidence: r.confidence, evidence: _parse(r.evidence_json) || [] },
    observedAt: r.observed_at,
  };
}

function getTask(id) { return shapeTask(db.get('SELECT * FROM wm_tasks WHERE task_id = ?', [id])); }
function getCommitment(id) { return shapeCommitment(db.get('SELECT * FROM wm_commitments WHERE commitment_id = ?', [id])); }

function listCommitments({ status = 'open', direction = null, limit = 200 } = {}) {
  const where = []; const args = [];
  if (status && status !== 'all') { where.push('status = ?'); args.push(status); }
  if (direction) { where.push('direction = ?'); args.push(direction); }
  return db.all(`SELECT * FROM wm_commitments ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY COALESCE(due_date, '9999') , created_at DESC LIMIT ?`, [...args, Math.max(1, Math.min(2000, limit))])
    .map(shapeCommitment);
}

function listTasks({ status = 'open', limit = 200 } = {}) {
  return db.all(`SELECT * FROM wm_tasks ${status && status !== 'all' ? 'WHERE status = ?' : ''}
                 ORDER BY COALESCE(due_date, '9999'), task_id LIMIT ?`,
  [...(status && status !== 'all' ? [status] : []), Math.max(1, Math.min(2000, limit))]).map(shapeTask);
}

/**
 * "What came out of the last <meeting>?" Commitments from the newest write-up
 * linked to an occurrence of this series that started before `beforeLocal`.
 * Returns { occurrence, commitments } — occurrence null when no write-up of
 * any earlier occurrence has been linked (a real answer: nothing to show).
 */
function fromPreviousOccurrence(seriesKey, { beforeLocal } = {}) {
  const key = collapse(seriesKey);
  const rows = db.all(`SELECT * FROM wm_commitments WHERE meeting_series_key = ? AND meeting_id IS NOT NULL`, [key]);
  let best = null;
  for (const r of rows) {
    const m = _parse(r.meeting_json);
    const start = m && m.occurrence ? m.occurrence.start : null;
    if (!start || (beforeLocal && start >= beforeLocal)) continue;
    if (!best || start > best.start) best = { start, meetingId: r.meeting_id, occurrence: m.occurrence, notePath: m.notePath };
  }
  if (!best) return { occurrence: null, commitments: [] };
  return {
    occurrence: { ...best.occurrence, notePath: best.notePath },
    commitments: rows.filter((r) => r.meeting_id === best.meetingId).map(shapeCommitment),
  };
}

function summary() {
  const one = (sql) => db.all(sql);
  return {
    tasks: one('SELECT status, COUNT(*) n FROM wm_tasks GROUP BY status'),
    taskSources: one('SELECT system, role, removed, COUNT(*) n FROM wm_task_sources GROUP BY system, role, removed'),
    commitments: one('SELECT direction, status, COUNT(*) n FROM wm_commitments GROUP BY direction, status'),
    commitmentKinds: one('SELECT source_kind, COUNT(*) n FROM wm_commitments GROUP BY source_kind'),
    promisors: one(`SELECT direction, COALESCE(promisor_method, 'unresolved') method, COUNT(*) n FROM wm_commitments GROUP BY direction, method`),
    meetingLinked: one(`SELECT source_kind, SUM(meeting_id IS NOT NULL) linked, COUNT(*) n FROM wm_commitments GROUP BY source_kind`),
    links: one('SELECT relation, rule, COUNT(*) n FROM wm_obligation_links GROUP BY relation, rule'),
  };
}

module.exports = {
  SELF, TABLES, reset,
  applyTaskObserved, applyTaskRemoved, applyCommitmentObserved, relinkPeople,
  resolveName, dueBasis, commitmentKindOfTask, titleKey, waitingCommitmentId, _peopleIndex,
  getTask, getCommitment, listTasks, listCommitments, fromPreviousOccurrence, summary, shapeCommitment,
};
