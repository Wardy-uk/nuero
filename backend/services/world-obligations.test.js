'use strict';

/**
 * Tasks and Commitments in the world model (Build 4B/4C).
 *
 *   run: node --test backend/services/world-obligations.test.js
 *
 * Producers are driven from REAL rows in a scratch DB (tasks, waiting_on,
 * management_log, calendar_history) and a REAL temp vault for the write-up →
 * occurrence link, never from hand-built payloads — a stub of the producer
 * cannot test the producer (the 18 Sep readVantage lesson).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-obl-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'obl.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
const VAULT = path.join(tmp, 'vault');
process.env.OBSIDIAN_VAULT_PATH = VAULT;

const db = require('../db/database');
const bus = require('./event-bus');
const wm = require('./world-model');
const ws = require('./world-sources');
const src = require('./obligation-sources');
const wo = require('./world-obligations');

test.before(async () => { await db.init(); });

const NOW = Date.parse('2026-10-03T09:00:00Z');
let clock = NOW;
const tick = () => { clock += 60000; return clock; };
const pump = () => bus.pumpConsumer(wm.CONSUMER, { now: Date.now() });

function declare(name, fm = {}) {
  const p = ws.personPayload(name, `People/${name}.md`, fm);
  bus.publishEvent({ type: 'observation.person.declared', occurredAt: new Date(tick()).toISOString(), source: { system: 'vault' },
    idempotencyKey: `pd:${p.personId}:${p.fingerprint}`, payload: p });
}

let taskSeq = 0;
function addTask(fields) {
  const id = 1000 + (++taskSeq);
  const row = { id, text: `task ${id}`, status: 'open', source: 'manual', dedupe_key: `k${id}`, created_at: '2026-09-21 10:00:00', ...fields };
  const cols = Object.keys(row);
  db.run(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
  return id;
}
function setTask(id, fields) {
  const cols = Object.keys(fields);
  db.run(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => fields[c]), id]);
}
function addWaiting(fields) {
  const row = { status: 'open', first_seen: '2026-09-21T08:00:00.000Z', last_seen: '2026-09-22T08:00:00.000Z', sightings: 1, ...fields };
  const cols = Object.keys(row);
  db.run(`INSERT INTO waiting_on (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
}
function writeNote(rel, startAt) {
  const full = path.join(VAULT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `---\ntype: meeting\nstart_at: "${startAt}"\n---\n# note\n`);
}
function addOccurrence(id, subject, start, end) {
  db.run(`INSERT INTO calendar_history (event_id, start_time, end_time, subject, is_all_day, show_as, attendees_other, source, first_seen)
          VALUES (?, ?, ?, ?, 0, 'busy', 1, 'graph', '2026-09-21T00:00:00Z')`, [id, start, end, subject]);
}
async function reconcile() { src.reconcile({ now: tick() }); await pump(); }

const NOTE = 'Meetings/2026/09/2026-09-28 – Tech leadership weekly.md';

test.before(async () => {
  // Tech Leadership on Monday 28 Sep, 09:00–10:00 London (BST). PLAUD writes
  // start_at in UTC with no marker: 08:02Z is 09:02 local.
  addOccurrence('TL-0928', 'Tech Leadership', '2026-09-28T09:00:00.0000000', '2026-09-28T10:00:00.0000000');
  // A solo block the same morning — never a link target.
  db.run(`INSERT INTO calendar_history (event_id, start_time, end_time, subject, is_all_day, show_as, attendees_other, source, first_seen)
          VALUES ('BLOCK', '2026-09-28T09:00:00.0000000', '2026-09-28T09:30:00.0000000', 'Focus', 0, 'busy', 0, 'graph', 'x')`);
  writeNote(NOTE, '2026-09-28T08:02:11.000000');
});

// ── 1. a structured task source projects one Task ───────────────────────────

test('1. a NEURO task row projects ONE task, owned by Nick by the store\'s own rule', async () => {
  declare('Nick Ward', {});
  const id = addTask({ text: 'Buy dog food', source: 'manual' });
  await reconcile();
  const t = wo.getTask(`task:neuro:${id}`);
  assert.equal(t.status, 'open');
  assert.equal(t.owner.personId, 'person:nick-ward');
  assert.equal(t.owner.method, 'store-owner');
  assert.equal(t.provenance.kind, 'fact');
  assert.equal(wo.getCommitment(`commitment:task:${id}`), null, 'a task nobody is waiting on is NOT a commitment');
  await reconcile();
  assert.equal(db.all('SELECT * FROM wm_tasks WHERE task_id = ?', [`task:neuro:${id}`]).length, 1);
});

// ── 2. a meeting action projects one Commitment, linked to its meeting ─────

test('2. a meeting-promoted task projects ONE commitment linked to its write-up\'s calendar occurrence', async () => {
  declare('Chris Middleton', { email: 'chris.middleton@nurtur.tech' });
  const id = addTask({ text: 'Nick to send the support figures to Chris Middleton', source: 'meeting-promotion',
    origin_path: NOTE, origin_line: 40, due_date: '2026-10-05', created_at: '2026-09-28 11:00:00' });
  await reconcile();
  const c = wo.getCommitment(`commitment:task:${id}`);
  assert.equal(c.direction, 'by-nick');
  assert.equal(c.promisor.personId, 'person:nick-ward');
  assert.equal(c.promisor.method, 'named-in-text');
  assert.equal(c.beneficiary.kind, 'person');
  assert.equal(c.beneficiary.personId, 'person:chris-middleton', 'a delivery verb + an exact full name');
  assert.equal(c.meetingId, 'graph:TL-0928', 'linked to the occurrence, not the solo block beside it');
  assert.equal(c.meetingSeriesKey, 'tech leadership');
  assert.equal(c.relatedTaskId, `task:neuro:${id}`);
  assert.equal(c.due.basis, 'set', 'a date nobody stated in the text and not the 10-day default');
  const links = db.all(`SELECT * FROM wm_obligation_links WHERE a_id = ? AND relation = 'realised-by'`, [c.commitmentId]);
  assert.equal(links.length, 1);
});

test('2b. "what came out of the last Tech Leadership" is a projection query', async () => {
  const r = wo.fromPreviousOccurrence('Tech Leadership', { beforeLocal: '2026-10-05T09:00' });
  assert.equal(r.occurrence.meetingId, 'graph:TL-0928');
  assert.ok(r.commitments.length >= 1);
  assert.ok(r.commitments.every((c) => c.meetingId === 'graph:TL-0928'));
});

// ── 3. the same synced task does not duplicate ──────────────────────────────

test('3. a Microsoft task linked to a NEURO task by ms_id is ONE task with two sources', async () => {
  const id = addTask({ text: 'Renew the Zendesk contract', source: 'manual', ms_id: 'PL-1', ms_source: 'MS Planner' });
  await reconcile();
  src.publishMicrosoftTasks({ planner: [{ id: 'PL-1', title: 'Renew Zendesk contract', percentComplete: 0 }], todo: [], complete: false, now: tick() });
  await pump();
  const t = wo.getTask(`task:neuro:${id}`);
  assert.equal(t.sources.length, 2);
  assert.deepEqual(t.sources.map((s) => `${s.system}:${s.role}:${s.matchRule}`).sort(),
    ['ms-planner:synced:explicit-external-id', 'neuro:leading:own-id']);
  assert.equal(wo.getTask('task:ms-planner:PL-1'), null, 'no second current-state task for the synced copy');
});

test('3b. order does not matter: a Microsoft task seen FIRST is absorbed when the NEURO link arrives', async () => {
  src.publishMicrosoftTasks({ planner: [{ id: 'PL-2', title: 'Book the QBR', percentComplete: 0 }], todo: [], now: tick() });
  await pump();
  assert.ok(wo.getTask('task:ms-planner:PL-2'), 'on its own it is its own task');
  const id = addTask({ text: 'Book the QBR room', ms_id: 'PL-2', ms_source: 'MS Planner' });
  await reconcile();
  assert.equal(wo.getTask('task:ms-planner:PL-2'), null);
  assert.equal(wo.getTask(`task:neuro:${id}`).sources.length, 2);
});

// ── 4. uncertain similar wording does not auto-merge ───────────────────────

test('4. same wording, no shared id: two tasks, a POSSIBLE-same link, never a merge', async () => {
  const id = addTask({ text: 'Review the escalation matrix for Q4' });
  src.publishMicrosoftTasks({ planner: [{ id: 'PL-3', title: 'Review the escalation matrix for Q4', percentComplete: 0 }], todo: [], now: tick() });
  await reconcile();
  assert.ok(wo.getTask(`task:neuro:${id}`));
  assert.ok(wo.getTask('task:ms-planner:PL-3'));
  const link = db.get(`SELECT * FROM wm_obligation_links WHERE relation = 'possible-same' AND (a_id = ? OR b_id = ?)`, [`task:neuro:${id}`, `task:neuro:${id}`]);
  assert.ok(link, 'the relationship is exposed');
  assert.equal(link.rule, 'exact-normalised-title');
  // Inside ONE store identical wording is a recurring series, not a copy.
  src.publishMicrosoftTasks({ planner: [
    { id: 'PL-R1', title: 'End-of-day risk sweep', percentComplete: 100, completedDateTime: '2026-10-01T17:00:00Z' },
    { id: 'PL-R2', title: 'End-of-day risk sweep', percentComplete: 0 },
  ], todo: [], now: tick() });
  await pump();
  assert.equal(db.all(`SELECT * FROM wm_obligation_links WHERE relation = 'possible-same' AND (a_id = 'task:ms-planner:PL-R2' OR b_id = 'task:ms-planner:PL-R2')`).length, 0,
    'two instances of a recurring Planner card are not "possibly the same"');
  assert.equal(wo.getTask('task:ms-planner:PL-R2').possibleCompletion, null, 'and last week\'s completed instance does not hint this one is done');
  const near = addTask({ text: 'Review the escalation matrix for Q3' });
  await reconcile();
  assert.equal(db.all(`SELECT * FROM wm_obligation_links WHERE relation = 'possible-same' AND (a_id = ? OR b_id = ?)`,
    [`task:neuro:${near}`, `task:neuro:${near}`]).length, 0, 'similar is not the same — no link on near wording');
});

// ── 5/6/7. completion precedence ────────────────────────────────────────────

test('5. an authoritative completion closes the task — and the commitment that follows it', async () => {
  const id = addTask({ text: 'Nick to circulate the rota', source: 'meeting-promotion', origin_path: NOTE });
  await reconcile();
  setTask(id, { status: 'done', completed_at: '2026-10-03 10:00:00' });
  await reconcile();
  assert.equal(wo.getTask(`task:neuro:${id}`).status, 'completed');
  assert.equal(wo.getTask(`task:neuro:${id}`).completionAuthority, 'neuro');
  const c = wo.getCommitment(`commitment:task:${id}`);
  assert.equal(c.status, 'completed');
  assert.equal(c.completionAuthority, 'neuro');
  const h = db.all(`SELECT change FROM wm_obligation_history WHERE entity_id = ? ORDER BY id`, [c.commitmentId]).map((r) => r.change);
  assert.deepEqual(h, ['created', 'completed']);
});

test('5b. Planner\'s completedDateTime closes a linked task even while the NEURO row is still open', async () => {
  const id = addTask({ text: 'Send the board pack', ms_id: 'PL-4', ms_source: 'MS Planner' });
  await reconcile();
  src.publishMicrosoftTasks({ planner: [{ id: 'PL-4', title: 'Send the board pack', percentComplete: 100, completedDateTime: '2026-10-03T08:00:00Z' }], todo: [], now: tick() });
  await pump();
  const t = wo.getTask(`task:neuro:${id}`);
  assert.equal(t.status, 'completed');
  assert.equal(t.completionAuthority, 'ms-planner');
  // An unrelated edit to the NEURO row must NOT reopen it.
  setTask(id, { due_date: '2026-10-09' });
  await reconcile();
  assert.equal(wo.getTask(`task:neuro:${id}`).status, 'completed', 'only the source that closed it can reopen it');
});

test('6. an INFERRED completion never overrides an authoritative open state', async () => {
  const id = addTask({ text: 'Draft the onboarding checklist v2' });
  src.publishMicrosoftTasks({ planner: [{ id: 'PL-5', title: 'Draft the onboarding checklist v2', percentComplete: 100, completedDateTime: '2026-10-02T12:00:00Z' }], todo: [], now: tick() });
  await reconcile();
  const t = wo.getTask(`task:neuro:${id}`);
  assert.equal(t.status, 'open', 'wording is not identity');
  assert.ok(t.possibleCompletion, 'but the possible completion is visible');
  assert.equal(t.possibleCompletion.kind, 'inference');
});

test('6b. a To Do task leaving the open list is UNKNOWN, never completed — and only on a COMPLETE read', async () => {
  src.publishMicrosoftTasks({ planner: [], todo: [{ listName: 'Tasks', tasks: [{ id: 'TD-1', title: 'Call the bank', status: 'notStarted' }] }], complete: true, now: tick() });
  await pump();
  assert.equal(wo.getTask('task:ms-todo:TD-1').status, 'open');
  src.publishMicrosoftTasks({ planner: [], todo: [{ listName: 'Tasks', tasks: [] }], complete: false, now: tick() });
  await pump();
  assert.equal(wo.getTask('task:ms-todo:TD-1').status, 'open', 'absence from a partial read is not evidence');
  src.publishMicrosoftTasks({ planner: [], todo: [{ listName: 'Tasks', tasks: [] }], complete: true, now: tick() });
  await pump();
  assert.equal(wo.getTask('task:ms-todo:TD-1').status, 'unknown');
});

test('7. reopening works, and is recorded as a transition', async () => {
  const id = addTask({ text: 'Nick to update the SLA dashboard', source: 'meeting-promotion', origin_path: NOTE });
  await reconcile();
  setTask(id, { status: 'done' });
  await reconcile();
  setTask(id, { status: 'open' });
  await reconcile();
  const c = wo.getCommitment(`commitment:task:${id}`);
  assert.equal(c.status, 'open');
  const h = db.all(`SELECT change FROM wm_obligation_history WHERE entity_id = ? ORDER BY id`, [`task:neuro:${id}`]).map((r) => r.change);
  assert.deepEqual(h, ['created', 'completed', 'reopened']);
});

test('7b. a waiting-on item Nick marked done reopens when the store re-raises it', async () => {
  addWaiting({ key: 'chris::cross check urls', person: 'Chris', person_full: 'Chris Middleton', text: 'Chris Middleton: cross-check URLs', source_path: NOTE, source_date: '2026-09-28' });
  await reconcile();
  const id = wo.waitingCommitmentId('chris::cross check urls');
  db.run(`UPDATE waiting_on SET status = 'done', resolved_at = '2026-10-01T10:00:00Z' WHERE key = 'chris::cross check urls'`);
  await reconcile();
  assert.equal(wo.getCommitment(id).status, 'completed');
  assert.equal(wo.getCommitment(id).completionAuthority, 'nick-marked');
  db.run(`UPDATE waiting_on SET status = 'open', resolved_at = NULL, reopened_at = '2026-10-03T10:00:00Z', sightings = 2 WHERE key = 'chris::cross check urls'`);
  await reconcile();
  assert.equal(wo.getCommitment(id).status, 'open');
});

// ── 8. identity stays unresolved rather than guessed ───────────────────────

test('8. an unresolvable promisor stays UNRESOLVED, raw name kept, reason recorded', async () => {
  addWaiting({ key: 'georgie::crm export', person: 'Georgie', person_full: 'Georgie Guthrie', text: 'Georgie Guthrie: attempt a CRM export', source_path: NOTE });
  declare('Lucy Read', {});
  declare('Lucy Smith', {});
  addWaiting({ key: 'lucy::tpj report', person: 'Lucy', text: 'Lucy to send the TPJ report', source_path: NOTE });
  await reconcile();
  const g = wo.getCommitment(wo.waitingCommitmentId('georgie::crm export'));
  assert.equal(g.direction, 'to-nick');
  assert.equal(g.promisor.personId, null);
  assert.equal(g.promisor.raw, 'Georgie Guthrie');
  assert.match(g.promisor.unresolvedWhy, /no People note declares/);
  const l = wo.getCommitment(wo.waitingCommitmentId('lucy::tpj report'));
  assert.equal(l.promisor.personId, null, 'an ambiguous first name attributes nothing (the four-Lucys rule)');
  assert.match(l.promisor.unresolvedWhy, /belongs to 2 declared people/);
  const c = wo.getCommitment(wo.waitingCommitmentId('chris::cross check urls'));
  assert.equal(c.promisor.personId, 'person:chris-middleton');
  assert.equal(c.promisor.method, 'exact-name');
});

test('8b. a person declared LATER links the commitment then — and says so in the history', async () => {
  declare('Georgie Guthrie', {});
  await pump();
  const g = wo.getCommitment(wo.waitingCommitmentId('georgie::crm export'));
  assert.equal(g.promisor.personId, 'person:georgie-guthrie');
  const h = db.all(`SELECT change FROM wm_obligation_history WHERE entity_id = ?`, [g.commitmentId]).map((r) => r.change);
  assert.ok(h.includes('owner-linked'));
});

// ── 9/10/11. replay ─────────────────────────────────────────────────────────

const SNAP_SQL = {
  wm_tasks: 'SELECT task_id, title, status, completion_authority, due_date, due_basis, owner_person_id, meeting_id, possible_completion_json, evidence_json FROM wm_tasks ORDER BY task_id',
  wm_task_sources: 'SELECT system, record_id, task_id, role, match_rule, status, removed FROM wm_task_sources ORDER BY system, record_id',
  wm_commitments: 'SELECT commitment_id, direction, promisor_person_id, promisor_method, beneficiary_person_id, status, completion_authority, meeting_id, meeting_series_key, related_task_id FROM wm_commitments ORDER BY commitment_id',
  wm_obligation_links: 'SELECT a_id, b_id, relation, rule FROM wm_obligation_links ORDER BY a_id, b_id, relation',
};
const snapshot = () => Object.fromEntries(Object.entries(SNAP_SQL).map(([k, sql]) => [k, db.all(sql)]));

test('9/10/11. replay rebuilds IDENTICAL state — meeting links and person links included', async () => {
  const before = snapshot();
  assert.ok(before.wm_commitments.some((c) => c.meeting_id === 'graph:TL-0928'), 'precondition: a meeting link exists');
  assert.ok(before.wm_commitments.some((c) => c.promisor_person_id === 'person:georgie-guthrie'), 'precondition: a late person link exists');
  await bus.replayConsumer(wm.CONSUMER);
  assert.deepEqual(snapshot(), before);
  await bus.replayConsumer(wm.CONSUMER);
  assert.deepEqual(snapshot(), before, 'twice over');
});

// ── classification and due-basis rules ─────────────────────────────────────

test('a placeholder due date is `default`, a date the sentence states is `stated`', () => {
  assert.equal(wo.dueBasis({ dueDate: '2026-10-01', text: 'Nick to fix it', createdAt: '2026-09-21 10:00:00', promoted: true }), 'default');
  assert.equal(wo.dueBasis({ dueDate: '2026-09-30', text: 'Confirm the end date by 2026-09-30', createdAt: '2026-09-21 10:00:00', promoted: true }), 'stated');
  assert.equal(wo.dueBasis({ dueDate: null, text: 'x' }), 'none');
});

test('household and plain tasks are not commitments; declared and management-log ones are', () => {
  assert.equal(wo.commitmentKindOfTask({ system: 'neuro', source: 'capture:helen', household: true, origin: 'commitment' }), null);
  assert.equal(wo.commitmentKindOfTask({ system: 'neuro', source: 'manual' }), null);
  assert.equal(wo.commitmentKindOfTask({ system: 'neuro', source: 'manual', origin: 'commitment', originProposed: true }), null, 'a PROPOSED classification is not Nick\'s call');
  assert.equal(wo.commitmentKindOfTask({ system: 'neuro', source: 'manual', origin: 'commitment', originProposed: false }), 'declared-commitment');
  assert.equal(wo.commitmentKindOfTask({ system: 'neuro', source: 'management-log', managementLog: { owner: 'Nick', person: 'Hope Goodall' } }), 'management-log');
});

test('the write-up link refuses to guess when two occurrences START near the recording', () => {
  const occ = [
    { event_id: 'A', start_time: '2026-09-28T09:00:00', end_time: '2026-09-28T10:00:00', subject: 'A', source: 'graph', show_as: 'busy' },
    { event_id: 'B', start_time: '2026-09-28T09:15:00', end_time: '2026-09-28T09:45:00', subject: 'B', source: 'graph', show_as: 'busy' },
  ];
  const r = src.linkOccurrence('Meetings/2026/09/x.md', '2026-09-28T08:05:00', occ);
  assert.equal(r.occurrence, null);
  assert.match(r.why, /not guessing/);
  const one = src.linkOccurrence('Meetings/2026/09/x.md', '2026-09-28T08:05:00', occ.slice(0, 1));
  assert.equal(one.occurrence.meetingId, 'graph:A', 'UTC 08:05 is 09:05 in London (BST)');
  const mid = src.linkOccurrence('Meetings/2026/09/x.md', '2026-09-28T08:40:00', occ.slice(0, 1));
  assert.equal(mid.occurrence, null, 'a recording 40 minutes into a meeting is not taken to be that meeting');
});

test('a FREE entry, and the stale slots of a MOVED occurrence, are not candidates (live 3 Oct shapes)', () => {
  const occ = [
    { event_id: 'TL', start_time: '2026-09-14T09:00:00', end_time: '2026-09-14T10:00:00', subject: 'Tech Leadership', source: 'graph', show_as: 'tentative', first_seen: '2026-09-14T06:00:00Z' },
    { event_id: 'KPI', start_time: '2026-09-14T09:15:00', end_time: '2026-09-14T09:45:00', subject: 'KPI Meet', source: 'graph', show_as: 'free', first_seen: '2026-09-14T06:00:00Z' },
  ];
  assert.equal(src.linkOccurrence('n.md', '2026-09-14T08:03:00', occ).occurrence.meetingId, 'graph:TL', 'the free KPI slot does not make it ambiguous');
  // One 1-2-1 seen at 11:00 and then moved to 12:00: only the newest slot counts.
  const moved = [
    { event_id: 'HOPE', start_time: '2026-09-17T11:00:00', end_time: '2026-09-17T11:30:00', subject: '1-2-1 — Nick / Hope', source: 'graph', show_as: 'busy', first_seen: '2026-09-15T08:00:00Z' },
    { event_id: 'HOPE', start_time: '2026-09-17T12:00:00', end_time: '2026-09-17T12:30:00', subject: '1-2-1 — Nick / Hope', source: 'graph', show_as: 'busy', first_seen: '2026-09-16T08:00:00Z' },
    { event_id: 'STEPH', start_time: '2026-09-17T11:30:00', end_time: '2026-09-17T12:00:00', subject: '1-2-1 — Nick / Stephen', source: 'graph', show_as: 'busy', first_seen: '2026-09-15T08:00:00Z' },
  ];
  const r = src.linkOccurrence('n.md', '2026-09-17T10:57:00', moved);
  assert.equal(r.occurrence.meetingId, 'graph:HOPE');
  assert.equal(r.occurrence.start, '2026-09-17T12:00');
  // Positive control: with the ghost slot counted, Stephen's 11:30 start and
  // Hope's would both be candidates for an 11:40 recording.
  assert.equal(src.linkOccurrence('n.md', '2026-09-17T10:20:00', moved).occurrence.meetingId, 'graph:STEPH',
    '11:20 local is near Stephen only once Hope\'s stale 11:00 slot is ignored');
});
