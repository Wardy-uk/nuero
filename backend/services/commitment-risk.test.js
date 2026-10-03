'use strict';

/**
 * Commitment at risk (Build 4D) — a SHADOW semantic evaluator.
 *
 *   run: node --test backend/services/commitment-risk.test.js
 *
 * Runs against the REAL projection (real tasks / waiting_on rows → producer →
 * event log → world-model fold), with the clock-bound readers injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-cr-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'cr.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
const VAULT = path.join(tmp, 'vault');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
delete process.env.COMMITMENT_RISK_MODE;

// ⚠ Anything reaching a phone fails the suite: shadow means nothing is sent.
const sent = [];
require.cache[require.resolve('./webpush')] = {
  id: require.resolve('./webpush'), filename: require.resolve('./webpush'), loaded: true,
  exports: { sendToAll: async (...a) => { sent.push(a); throw new Error('a shadow evaluator tried to send'); }, isConfigured: () => true },
};

const db = require('../db/database');
const bus = require('./event-bus');
const wm = require('./world-model');
const ws = require('./world-sources');
const src = require('./obligation-sources');
const wo = require('./world-obligations');
const cr = require('./commitment-risk');

test.before(async () => { await db.init(); });

// Friday 2 Oct 2026, 09:00 London (08:00Z).
const NOW = Date.parse('2026-10-02T08:00:00Z');
let seq = NOW;
const pump = () => bus.pumpConsumer(wm.CONSUMER, { now: Date.now() });
async function reconcile() { seq += 1000; src.reconcile({ now: seq }); await pump(); }

let n = 0;
function addTask(fields) {
  const id = 500 + (++n);
  const row = { id, text: `task ${id}`, status: 'open', source: 'manual', dedupe_key: `k${id}`, created_at: '2026-09-28 11:00:00', ...fields };
  const cols = Object.keys(row);
  db.run(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
  return id;
}
const setTask = (id, f) => db.run(`UPDATE tasks SET ${Object.keys(f).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...Object.values(f), id]);

const NOTE = 'Meetings/2026/09/2026-09-28 – Tech leadership.md';
const OLD_NOTE = 'Meetings/2026/09/2026-09-21 – Tech leadership.md';

function declare(name, email) {
  const p = ws.personPayload(name, `People/${name}.md`, email ? { email } : {});
  bus.publishEvent({ type: 'observation.person.declared', occurredAt: new Date(NOW).toISOString(), source: { system: 'vault' },
    idempotencyKey: `pd:${p.personId}:${p.fingerprint}`, payload: p });
}
function occurrence(id, start, end) {
  db.run(`INSERT INTO calendar_history (event_id, start_time, end_time, subject, is_all_day, show_as, attendees_other, source, first_seen)
          VALUES (?, ?, ?, 'Tech Leadership', 0, 'busy', 1, 'graph', 'x')`, [id, start, end]);
}
function note(rel, startAt) {
  fs.mkdirSync(path.dirname(path.join(VAULT, rel)), { recursive: true });
  fs.writeFileSync(path.join(VAULT, rel), `---\nstart_at: "${startAt}"\n---\n`);
}

test.before(async () => {
  declare('Nick Ward');
  declare('Hope Goodall', 'hope.goodall@nurtur.tech');
  declare('Chris Middleton', 'chris.middleton@nurtur.tech');
  occurrence('TL-0921', '2026-09-21T09:00:00', '2026-09-21T10:00:00');
  occurrence('TL-0928', '2026-09-28T09:00:00', '2026-09-28T10:00:00');
  note(OLD_NOTE, '2026-09-21T08:03:00');
  note(NOTE, '2026-09-28T08:03:00');
  // The NEXT Tech Leadership: Friday 2 Oct 16:00 (in 7h). Hope is in it.
  ws.publishCalendarWindow({ provider: 'graph', now: NOW, events: [{
    id: 'TL-1002', subject: 'Tech Leadership', start: '2026-10-02T16:00:00', end: '2026-10-02T17:00:00', showAs: 'busy',
    responseStatus: 'accepted', organizerEmail: 'chris.middleton@nurtur.tech', organizer: 'Chris Middleton',
    attendees: [{ name: 'Hope Goodall', email: 'hope.goodall@nurtur.tech', status: 'accepted' }], attendeesOther: true,
  }] });
  await pump();
});

const BASE_DEPS = {
  calendarFreshness: () => 'fresh',
  laneDeferral: () => null,
  readMoment: async () => ({ moment: { now: new Date(NOW), known: true, inMeeting: false, quiet: false, onDuty: true, focusMode: false,
    moving: false, driving: false, atLaptop: true, atDesk: true, inFocusSession: false, muted: [] } }),
};
const run = (over = {}, now = NOW) => cr.evaluate({ now, deps: { ...BASE_DEPS, ...over } });
const active = (cid) => db.get(`SELECT * FROM commitment_risk_findings WHERE commitment_id = ? AND status = 'active'`, [cid]);
const all = (cid) => db.all(`SELECT * FROM commitment_risk_findings WHERE commitment_id = ? ORDER BY episode`, [cid]);

// ── 12. explicit near-due open commitment ──────────────────────────────────

test('12. an open commitment with a STATED deadline tomorrow is a finding (elevated), today escalates it (high)', async () => {
  // A write-up with no calendar link: only the DEADLINE can trigger here.
  const id = addTask({ text: 'Nick to confirm the rota by 2026-10-03', source: 'meeting-promotion', origin_path: 'Meetings/2026/08/2026-08-03 – Unlinked.md',
    due_date: '2026-10-03', created_at: '2026-09-21 11:00:00' });
  await reconcile();
  const cid = `commitment:task:${id}`;
  assert.equal(wo.getCommitment(cid).due.basis, 'stated');
  await run();
  const f = active(cid);
  assert.ok(f, 'a finding exists');
  assert.equal(f.level, 'elevated');
  assert.equal(f.novelty, 'new');
  assert.match(f.summary, /still open/);
  assert.ok(JSON.parse(f.checked_json).includes('snooze'));
  assert.equal(f.attention_level, 'elevated', 'asked at once, at the level it had');
  // 18. a day later the same deadline is today: ONE finding, escalated, re-asked.
  await run({}, NOW + 24 * 3600 * 1000);
  const rows = all(cid);
  assert.equal(rows.length, 1, 'escalation updates the finding, it does not add one');
  assert.equal(rows[0].level, 'high');
  assert.equal(rows[0].novelty, 'escalated');
  assert.equal(rows[0].attention_level, 'high', 'the attention verdict was asked again at the new level');
});

// ── 13. prior-meeting commitment before the next occurrence ────────────────

test('13. Nick\'s commitment from the LAST Tech Leadership is a finding when the next one is within 24h', async () => {
  const id = addTask({ text: 'Nick to send the support figures', source: 'meeting-promotion', origin_path: NOTE,
    due_date: '2026-10-08', created_at: '2026-09-28 11:00:00' });
  await reconcile();
  const cid = `commitment:task:${id}`;
  assert.equal(wo.getCommitment(cid).due.basis, 'default', 'the 10-day placeholder is not a deadline');
  await run();
  const f = active(cid);
  assert.ok(f);
  const triggers = JSON.parse(f.triggers_json).map((t) => t.kind);
  assert.deepEqual(triggers, ['meeting-near']);
  assert.match(f.summary, /^Tech Leadership is Friday 2 Oct at 16:00\. You took on "send the support figures" at the last one \(28 Sep\)/);
  assert.equal(f.recommended_at, '2026-10-02T15:00', 'an hour before the meeting');
  const rel = JSON.parse(f.related_meeting_json);
  assert.equal(rel.meetingId, 'graph:TL-1002');
});

test('13b. what someone else owes from the last one is a finding only if THEY are in the next one', async () => {
  db.run(`INSERT INTO waiting_on (key, person, person_full, text, source_path, source_date, status, first_seen, last_seen)
          VALUES ('hope::qa figures', 'Hope', 'Hope Goodall', 'Hope Goodall: revise the QA figures', ?, '2026-09-28', 'open', '2026-09-28T08:00:00Z', '2026-09-28T08:00:00Z'),
                 ('ben::url check', 'Ben', 'Ben Methrington', 'Ben Methrington: cross-check URLs', ?, '2026-09-28', 'open', '2026-09-28T08:00:00Z', '2026-09-28T08:00:00Z')`, [NOTE, NOTE]);
  declare('Ben Methrington', 'ben.m@nurtur.tech');
  await reconcile();
  await run();
  const hope = active(wo.waitingCommitmentId('hope::qa figures'));
  assert.ok(hope, 'Hope is an attendee of the next one');
  assert.match(hope.summary, /Hope Goodall took on "revise the QA figures" at the last one/);
  assert.ok(wo.getCommitment(wo.waitingCommitmentId('ben::url check')).promisor.personId, 'precondition: Ben resolves');
  assert.ok(!active(wo.waitingCommitmentId('ben::url check')), 'Ben is not in the next one');
});

test('13c. a commitment from an OLDER occurrence is history, not the next meeting\'s agenda', async () => {
  const id = addTask({ text: 'Nick to tidy the wiki', source: 'meeting-promotion', origin_path: OLD_NOTE, created_at: '2026-09-21 11:00:00', due_date: '2026-10-01' });
  await reconcile();
  await run();
  assert.ok(!active(`commitment:task:${id}`));
});

// ── 14/15/16. what must NOT trigger ────────────────────────────────────────

test('14. a completed commitment is never a finding', async () => {
  const id = addTask({ text: 'Nick to ring the supplier by 2026-10-02', source: 'meeting-promotion', origin_path: OLD_NOTE,
    due_date: '2026-10-02', created_at: '2026-09-21 11:00:00', status: 'done' });
  await reconcile();
  await run();
  assert.equal(all(`commitment:task:${id}`).length, 0);
});

test('15. an OLD open commitment with no deadline and no meeting is not a finding', async () => {
  const id = addTask({ text: 'Nick to review the KB backlog', source: 'meeting-promotion', origin_path: 'Meetings/2026/06/2026-06-01 – Old.md',
    created_at: '2026-06-01 10:00:00' });
  await reconcile();
  await run();
  assert.equal(all(`commitment:task:${id}`).length, 0);
  const stale = addTask({ text: 'Nick to resend the pricing deck by 2026-08-01', source: 'meeting-promotion', origin_path: 'Meetings/2026/06/2026-06-01 – Old.md',
    created_at: '2026-06-01 10:00:00', due_date: '2026-08-01' });
  await reconcile();
  assert.equal(wo.getCommitment(`commitment:task:${stale}`).due.basis, 'stated', 'precondition: a STATED deadline, so only the horizon can hold it back');
  await run();
  assert.equal(all(`commitment:task:${stale}`).length, 0, 'overdue past the horizon is history, not risk');
  const placeholder = addTask({ text: 'Nick to refresh the macro library', source: 'meeting-promotion', origin_path: 'Meetings/2026/09/2026-09-23 – Unlinked.md',
    created_at: '2026-09-23 10:00:00', due_date: '2026-10-03' });
  await reconcile();
  assert.equal(wo.getCommitment(`commitment:task:${placeholder}`).due.basis, 'default', 'precondition: the 10-day placeholder');
  await run();
  assert.equal(all(`commitment:task:${placeholder}`).length, 0, 'a placeholder falling due tomorrow is not a deadline');
});

test('15a. a date SET later and since passed is a plan, not a broken promise — only a STATED one is overdue', async () => {
  const set = addTask({ text: 'Monitor Heidi’s productivity while WFH', source: 'meeting-promotion', origin_path: OLD_NOTE,
    due_date: '2026-09-29', created_at: '2026-09-16 12:29:48' });
  const stated = addTask({ text: 'Set and confirm the end date before 2026-09-30', source: 'meeting-promotion', origin_path: OLD_NOTE,
    due_date: '2026-09-30', created_at: '2026-09-21 11:25:58' });
  await reconcile();
  assert.equal(wo.getCommitment(`commitment:task:${set}`).due.basis, 'set');
  assert.equal(wo.getCommitment(`commitment:task:${stated}`).due.basis, 'stated');
  await run();
  assert.equal(all(`commitment:task:${set}`).length, 0, 'a passed plan is not raised');
  const f = active(`commitment:task:${stated}`);
  assert.ok(f, 'a passed STATED deadline is');
  assert.deepEqual(JSON.parse(f.triggers_json).map((t) => t.kind), ['overdue']);
});

test('the quote is the action: a leading name is stripped, a word that merely starts with one is not', () => {
  const c = { direction: 'by-nick', promisor: { raw: 'Nick' }, meeting: null };
  const a = { triggers: [{ kind: 'overdue' }], dueContext: 'due x', evidence: { progress: [] } };
  assert.match(cr.summarise({ ...c, description: 'Monitor Heidi’s productivity while WFH' }, a), /"Monitor Heidi/);
  assert.match(cr.summarise({ ...c, description: 'Nick to send the rota' }, a), /"send the rota"/);
  assert.match(cr.summarise({ ...c, description: 'Nick Ward: provide the counts' }, a), /"provide the counts"/);
});

test('15b. a plain TASK due today is not a commitment and never a finding', async () => {
  const id = addTask({ text: 'Buy dog food', due_date: '2026-10-02' });
  await reconcile();
  await run();
  assert.equal(wo.getCommitment(`commitment:task:${id}`), null);
  assert.equal(all(`commitment:task:${id}`).length, 0);
});

test('16. an unrelated urgent email from an attendee is not an input — nothing fires on it', async () => {
  // The evaluator has no email reader at all: there is nothing an urgent email
  // can trigger. Pinned so a future "add email" does not make it a trigger.
  const srcText = fs.readFileSync(path.join(__dirname, 'commitment-risk.js'), 'utf8');
  assert.ok(!/getFlaggedItems|email-triage/.test(srcText), 'no email reader in the evaluator');
  assert.ok(/commitments: \(\) =>/.test(srcText), 'positive control: the scan reads the real file');
});

// ── 17/18/19. dedupe, escalation, resolution ───────────────────────────────

test('17. an unchanged risk re-evaluated many times stays ONE finding, asked once', async () => {
  const id = addTask({ text: 'Nick to share the Q4 plan by 2026-10-03', source: 'meeting-promotion', origin_path: OLD_NOTE,
    due_date: '2026-10-03', created_at: '2026-09-21 11:00:00' });
  await reconcile();
  for (let i = 0; i < 5; i++) await run({}, NOW + i * 15 * 60000);
  const rows = all(`commitment:task:${id}`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decisions, 1, 'the attention policy was asked once, not five times');
});

test('19. completion resolves the finding; a risk that returns later is a NEW episode', async () => {
  const id = addTask({ text: 'Nick to send the minutes by 2026-10-03', source: 'meeting-promotion', origin_path: OLD_NOTE,
    due_date: '2026-10-03', created_at: '2026-09-21 11:00:00' });
  await reconcile();
  await run();
  const cid = `commitment:task:${id}`;
  assert.ok(active(cid));
  setTask(id, { status: 'done', completed_at: '2026-10-02 10:00:00' });
  await reconcile();
  await run();
  const done = all(cid);
  assert.equal(done[0].status, 'resolved');
  assert.equal(done[0].resolution, 'completed');
  setTask(id, { status: 'open', completed_at: null });
  await reconcile();
  await run();
  const again = all(cid);
  assert.equal(again.length, 2);
  assert.equal(again[1].episode, 2);
  assert.equal(again[1].novelty, 'new');
});

test('Nick\'s own "not today" and a snooze are honoured — held, not raised', async () => {
  const id = addTask({ text: 'Nick to chase the contract by 2026-10-02', source: 'meeting-promotion', origin_path: OLD_NOTE,
    due_date: '2026-10-02', created_at: '2026-09-21 11:00:00' });
  await reconcile();
  const r = await run({ laneDeferral: (title) => (/chase the contract/.test(title) ? { reason: 'too-big', until: '2026-10-03T09:00' } : null) });
  assert.equal(all(`commitment:task:${id}`).length, 0);
  assert.ok(r.skipped.some((s) => s.commitmentId === `commitment:task:${id}` && /deferred by Nick/.test(s.why)));
});

test('a stale calendar never feeds the meeting trigger', async () => {
  const id = addTask({ text: 'Nick to draft the hiring plan', source: 'meeting-promotion', origin_path: NOTE, created_at: '2026-09-28 11:00:00', due_date: '2026-10-08' });
  await reconcile();
  await run({ calendarFreshness: () => 'stale' });
  assert.equal(all(`commitment:task:${id}`).length, 0);
});

// ── 20/21. shadow only ─────────────────────────────────────────────────────

test('20/21. attention is asked and RECORDED as shadow; nothing reaches webpush; there is no live mode', async () => {
  const rows = db.all(`SELECT * FROM commitment_risk_findings WHERE attention_json IS NOT NULL`);
  assert.ok(rows.length >= 3, 'verdicts were recorded');
  for (const r of rows) {
    const a = JSON.parse(r.attention_json);
    assert.equal(a.shadow, true);
    assert.equal(a.sent, false);
    assert.equal(r.attention_mode, 'shadow');
  }
  assert.ok(rows.some((r) => JSON.parse(r.attention_json).push === true), 'the policy WOULD have pushed some — and still nothing was sent');
  assert.equal(sent.length, 0, 'nothing reached webpush');
  process.env.COMMITMENT_RISK_MODE = 'live';
  assert.equal(cr.mode(), 'shadow', '"live" is read as shadow on purpose');
  process.env.COMMITMENT_RISK_MODE = 'off';
  assert.equal(cr.mode(), 'off');
  delete process.env.COMMITMENT_RISK_MODE;
  const ap = require('./ambient-push');
  const src2 = fs.readFileSync(path.join(__dirname, 'ambient-push.js'), 'utf8');
  const deliverBody = src2.slice(src2.indexOf('async function deliver('), src2.indexOf('module.exports'));
  assert.ok(!/commitment-risk|commitmentRisk/.test(deliverBody), 'deliver() never offers a commitment-risk observation');
  assert.ok(ap.RULES['commitment-risk'], 'positive control: the rule exists, to be asked');
  assert.ok(!/sendToAll|webpush/.test(fs.readFileSync(path.join(__dirname, 'commitment-risk.js'), 'utf8')), 'the evaluator has no route to a send');
});

test('the policy\'s own vetoes decide the shadow verdict (in a meeting → would not push)', async () => {
  const id = addTask({ text: 'Nick to approve the budget by 2026-10-02', source: 'meeting-promotion', origin_path: OLD_NOTE,
    due_date: '2026-10-02', created_at: '2026-09-21 11:00:00' });
  await reconcile();
  await run({ readMoment: async () => ({ moment: { now: new Date(NOW), known: true, inMeeting: true, onDuty: true, muted: [] } }) });
  const f = active(`commitment:task:${id}`);
  const a = JSON.parse(f.attention_json);
  assert.equal(a.push, false);
  assert.equal(a.why, 'in a meeting');
});
