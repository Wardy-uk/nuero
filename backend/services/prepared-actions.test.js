'use strict';

/**
 * Prepared actions (Build 5E/5F; contract updated by Build 6).
 *
 * ⚠ Build 6 CHANGED what approval means for ONE type (chase_commitment, which
 * now sends after approval — see action-executor.test.js). Everything this file
 * prepares is still unsendable here: every outbound door below throws, and the
 * one executable type is exercised against mocks in the executor's own suite.
 *
 *   run: node --test backend/services/prepared-actions.test.js
 *
 * ⚠ EVERY outbound door is stubbed to THROW: web push, mail, Teams and Graph
 * writes. Prepared actions may draft and may record a decision; if anything
 * in this file's flow reaches a sender, the suite fails — "nothing is sent" is
 * asserted, not assumed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-pa-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'pa.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
const VAULT = path.join(tmp, 'vault');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
delete process.env.COMMITMENT_RISK_MODE;

const sends = [];
function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
const boom = (what) => async (...a) => { sends.push([what, a]); throw new Error(`${what} reached from a prepared-action flow`); };
stub('./webpush', { sendToAll: boom('webpush.sendToAll'), isConfigured: () => true });
stub('./email-sender', { sendMail: boom('email-sender.sendMail'), sendBriefEmail: boom('email-sender.sendBriefEmail') });
stub('./teams', { sendDm: boom('teams.sendDm'), getSendStatus: () => ({}) });
stub('./microsoft', {
  getSignedInAddress: async () => 'nickw@nurtur.tech',
  getAccessToken: async () => null,
  fetchSentMail: async () => ({ messages: [], complete: true }),
  graphWrite: boom('microsoft.graphWrite'),
  replyToEmail: boom('microsoft.replyToEmail'),
  sendMail: boom('microsoft.sendMail'),
});

const db = require('../db/database');
const bus = require('./event-bus');
const wm = require('./world-model');
const ws = require('./world-sources');
const src = require('./obligation-sources');
const wo = require('./world-obligations');
const pe = require('./progress-evidence');
const cr = require('./commitment-risk');
const pa = require('./prepared-actions');

test.before(async () => { await db.init(); });

// Saturday 3 Oct 2026, 10:00 London (09:00Z).
const NOW = Date.parse('2026-10-03T09:00:00Z');
let seq = NOW;
const pump = () => bus.pumpConsumer(wm.CONSUMER, { now: Date.now() });
async function reconcile() { seq += 1000; src.reconcile({ now: seq }); await pump(); }

let n = 0;
function addTask(fields) {
  const id = 900 + (++n);
  const row = { id, text: `task ${id}`, status: 'open', source: 'meeting-promotion', dedupe_key: `k${id}`, created_at: '2026-09-28 11:00:00',
    origin_path: 'Meetings/2026/09/2026-09-28 – Support leadership.md', ...fields };
  const cols = Object.keys(row);
  db.run(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
  return id;
}
function declare(name, email) {
  const p = ws.personPayload(name, `People/${name}.md`, email ? { email } : {});
  bus.publishEvent({ type: 'observation.person.declared', occurredAt: new Date(NOW).toISOString(), source: { system: 'vault' },
    idempotencyKey: `pd:${p.personId}:${p.fingerprint}`, payload: p });
}

const DEPS = {
  calendarFreshness: () => 'fresh',
  laneDeferral: () => null,
  // Sent mail WAS checked (and held nothing), so coverage is honest.
  refreshProgress: (nowMs) => pe.refresh({ now: nowMs, force: true, deps: { selfEmails: async () => ['nickw@nurtur.tech'],
    fetchSent: async () => ({ messages: [], complete: true }), vaultRoot: VAULT } }),
  readMoment: async () => ({ moment: { now: new Date(NOW), known: true, inMeeting: false, quiet: false, onDuty: true, focusMode: false,
    moving: false, driving: false, atLaptop: true, atDesk: true, inFocusSession: false, muted: [] } }),
};
const run = (over = {}) => cr.evaluate({ now: NOW, deps: { ...DEPS, ...over } });

test.before(async () => {
  fs.mkdirSync(path.join(VAULT, 'Meetings', '2026', '09'), { recursive: true });
  declare('Nick Ward');
  declare('Chris Middleton', 'chris.middleton@nurtur.tech');
  declare('Chris Smith', 'chris.smith@nurtur.tech');
  declare('Hope Goodall', 'hope.goodall@nurtur.tech');
  await pump();
});

let STRONG;
test('22/27/28. a strong risk prepares ONE approval-required A4 draft, with its evidence and reason', async () => {
  STRONG = addTask({ text: 'Nick to send the overtime report to Chris Middleton by 2026-10-03', due_date: '2026-10-03' });
  await reconcile();
  const r = await run();
  assert.equal(r.prepared.prepared, 1, JSON.stringify(r.prepared.declined));
  const f = db.get(`SELECT * FROM commitment_risk_findings WHERE commitment_id = ? AND status = 'active'`, [`commitment:task:${STRONG}`]);
  assert.equal(f.level, 'high');
  const a = pa.forFinding(f.finding_id);
  assert.equal(a.status, 'prepared');
  assert.equal(a.actionType, 'draft_update_email');
  assert.equal(a.authorityClass, 'A4');
  assert.equal(a.approvalRequired, true);
  assert.equal(a.executes, false);
  assert.equal(a.target.email, 'chris.middleton@nurtur.tech');
  assert.equal(a.draft.to[0].email, 'chris.middleton@nurtur.tech');
  assert.match(a.draft.body, /send the overtime report to Chris Middleton by 2026-10-03/);
  assert.match(a.draft.body, /\[date\]/, 'a date nobody stated is a visible placeholder, never invented');
  assert.deepEqual(a.draft.placeholders, ['date']);
  assert.equal(a.draft.generatedBy, 'template (no model call)');
  // 27. evidence and reason travel with it
  assert.match(a.reason, /at risk/);
  assert.equal(a.evidence.finding.findingId, f.finding_id);
  assert.equal(a.evidence.progress.state, 'no_evidence');
  assert.equal(a.evidence.progress.coverage.sentMail, 'ok');
  // 5F. the attention record knows a draft is ready — and still sent nothing
  const att = JSON.parse(f.attention_json);
  assert.equal(att.preparedAction.actionId, a.actionId);
  assert.equal(att.sent, false);
  // 28. the table refuses an action that does not require approval, or is not A4
  assert.throws(() => db.run(`INSERT INTO prepared_actions (action_id, idempotency_key, finding_id, commitment_id, action_type, target_json,
      reason, evidence_json, draft_json, payload_hash, authority_class, approval_required, status, created_at, history_json, updated_at)
      VALUES ('x', 'x', 'f', 'c', 't', '{}', 'r', '{}', '{}', 'h', 'A4', 0, 'prepared', 'n', '[]', 'n')`), /CHECK/);
  assert.throws(() => db.run(`INSERT INTO prepared_actions (action_id, idempotency_key, finding_id, commitment_id, action_type, target_json,
      reason, evidence_json, draft_json, payload_hash, authority_class, approval_required, status, created_at, history_json, updated_at)
      VALUES ('y', 'y', 'f', 'c', 't', '{}', 'r', '{}', '{}', 'h', 'A2', 1, 'prepared', 'n', '[]', 'n')`), /CHECK/);
});

test('25. a repeated evaluator pass prepares nothing new', async () => {
  await run(); await run();
  assert.equal(db.get(`SELECT COUNT(*) n FROM prepared_actions WHERE commitment_id = ?`, [`commitment:task:${STRONG}`]).n, 1);
});

test('23. an ambiguous target prepares nothing — owed to "the meeting", or to a first name two people share', async () => {
  // Owed to nobody named (the Heidi shape: "set and confirm her end date").
  const a = addTask({ text: 'Set and confirm the contractor end date before 2026-10-03', due_date: '2026-10-03' });
  // A waiting-for from "Chris" — two Chrises are declared.
  db.run(`INSERT INTO waiting_on (key, person, person_full, text, source_path, source_date, status, first_seen, last_seen, sightings)
          VALUES ('chris::chris to send the rota', 'Chris', NULL, 'Chris to send the rota', NULL, '2026-09-28', 'open',
                  '2026-09-28T09:00:00Z', '2026-09-28T09:00:00Z', 1)`);
  await reconcile();
  const r = await run();
  const why = (cid) => (r.prepared.declined.find((d) => d.commitmentId === cid) || {}).why;
  assert.equal(pa.forCommitment(`commitment:task:${a}`).length, 0);
  assert.match(why(`commitment:task:${a}`) || '', /nobody named|the meeting/);
  const chris = pa.shouldPrepare({
    finding: { status: 'active', level: 'high', confidence: 0.9, findingId: 'f' },
    commitment: { status: 'open', direction: 'to-nick', promisor: { unresolvedWhy: 'the first name "Chris" belongs to 2 declared people' } },
    progress: { state: 'no_evidence', coverage: { sentMail: 'ok' } }, person: null, context: {} });
  assert.equal(chris.prepare, false);
  assert.match(chris.why, /unresolved/);
  // A first-name-only resolution is not unambiguous enough to write to.
  const firstOnly = pa.shouldPrepare({
    finding: { status: 'active', level: 'high', confidence: 0.9, findingId: 'f' },
    commitment: { status: 'open', direction: 'to-nick', promisor: {} },
    progress: { state: 'no_evidence', coverage: { sentMail: 'ok' } },
    person: { personId: 'person:hope-goodall', displayName: 'Hope Goodall', emails: ['hope.goodall@nurtur.tech'], method: 'unique-first-name' }, context: {} });
  assert.equal(firstOnly.prepare, false);
  assert.match(firstOnly.why, /unique-first-name/);
});

const BASE = {
  finding: { status: 'active', level: 'high', confidence: 0.9, findingId: 'f1' },
  commitment: { status: 'open', direction: 'by-nick', beneficiary: { kind: 'person' }, promisor: {} },
  progress: { state: 'no_evidence', coverage: { sentMail: 'ok' } },
  person: { personId: 'person:chris-middleton', displayName: 'Chris Middleton', emails: ['chris.middleton@nurtur.tech'], method: 'delivery-verb+exact-name' },
};

test('24. a likely-fulfilled commitment prepares nothing; neither does one whose sent mail could not be checked', () => {
  assert.equal(pa.shouldPrepare(BASE).prepare, true, 'positive control');
  const likely = pa.shouldPrepare({ ...BASE, progress: { state: 'likely_fulfilled', reasons: ['sent'], coverage: { sentMail: 'ok' } } });
  assert.equal(likely.prepare, false);
  assert.match(likely.why, /likely_fulfilled/);
  const blind = pa.shouldPrepare({ ...BASE, progress: { state: 'no_evidence', coverage: { sentMail: 'unavailable' } } });
  assert.equal(blind.prepare, false);
  assert.match(blind.why, /could not be checked/);
});

test('26. snoozed, deferred "not today", recently chased or already queued prepares nothing', () => {
  const nowMs = NOW;
  assert.match(pa.shouldPrepare({ ...BASE, context: { deferred: true, nowMs } }).why, /not today/);
  assert.match(pa.shouldPrepare({ ...BASE, context: { snoozedUntil: '2026-10-10T09:00:00Z', nowMs } }).why, /snoozed/);
  assert.match(pa.shouldPrepare({ ...BASE, commitment: { ...BASE.commitment, lastProgressAt: '2026-10-01T09:00:00Z' }, context: { nowMs } }).why, /chased/);
  // Build 7: the central chaseBlock's answer, handed in as recentChase.
  assert.match(pa.shouldPrepare({ ...BASE, context: { recentChase: 'chased 2 day(s) ago — wait 7 days between chases', nowMs } }).why, /chased 2 day/);
  assert.match(pa.shouldPrepare({ ...BASE, context: { existing: [{ status: 'rejected', findingId: 'f1' }], nowMs } }).why, /rejected/);
  // And through the real pass: Nick's "not today" on the strong one stops a new episode preparing.
  assert.equal(pa.shouldPrepare({ ...BASE, finding: { ...BASE.finding, level: 'elevated' } }).prepare, false, 'elevated is not enough');
});

test('29/31. (Build 6 contract) a NON-executable type is approval-recorded only; approval binds the payload hash; no sender is reachable', async () => {
  const a = pa.list({ status: 'prepared' }).find((x) => x.actionType === 'draft_update_email');
  assert.ok(a, 'positive control: a prepared holding note exists');
  assert.equal(a.executes, false, 'draft_update_email has no executor in Build 6');
  // No hash, a wrong hash, and an unfilled [date] are each refused.
  assert.match(pa.approve(a.actionId, { approver: 'nick', now: NOW + 1000 }).error, /payloadHash/);
  assert.match(pa.approve(a.actionId, { approver: 'nick', payloadHash: 'nope', now: NOW + 1000 }).error, /not the one you were shown/);
  assert.match(pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, now: NOW + 1000 }).error, /placeholder/);
  assert.equal(pa.get(a.actionId).status, 'prepared');
  // Edit fills the date: a NEW version, the old one superseded and untouched.
  const ed = pa.edit(a.actionId, { payloadHash: a.payloadHash, body: a.draft.body.replace('[date]', 'Friday'), now: NOW + 1500 });
  assert.equal(ed.ok, true, ed.error);
  assert.equal(pa.get(a.actionId).status, 'superseded');
  assert.equal(ed.action.version, 2);
  // Build 7: approval needs human proof — a challenge for this exact version and the code.
  const proofs = require('./approval-proof');
  if (!proofs.codeStatus().set) proofs.setCode('b5-test-approval-code');
  const ch = proofs.issue({ actionId: ed.action.actionId, version: ed.action.version, payloadHash: ed.action.payloadHash, now: NOW + 2000 });
  const r = pa.approve(ed.action.actionId, { approver: 'nick', payloadHash: ed.action.payloadHash, challengeId: ch.challengeId, approvalCode: 'b5-test-approval-code', note: 'looks right', now: NOW + 2000 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.executable, false);
  assert.match(r.notice, /nothing has been sent/);
  assert.equal(pa.get(ed.action.actionId).status, 'approved');
  assert.equal(pa.approve(ed.action.actionId, { approver: 'nick', payloadHash: ed.action.payloadHash }).already, true, 'approving twice is the same decision');
  // The database refuses to execute a type the registry does not mark executable.
  assert.throws(() => db.run(`UPDATE prepared_actions SET status = 'executing' WHERE action_id = ?`, [ed.action.actionId]), /not an executable action type|only an approved/);
  assert.throws(() => db.run(`UPDATE prepared_actions SET status = 'executed' WHERE action_id = ?`, [ed.action.actionId]), /not an executable action type|illegal execution transition/);
  assert.equal(pa.get(ed.action.actionId).status, 'approved');
  assert.deepEqual(sends, [], 'nothing reached web push, mail, Teams or a Graph write');
  // Structural: the PREPARE/APPROVE module imports no sender. (The executor is a separate module.)
  for (const f of ['services/prepared-actions.js', 'routes/prepared-actions.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(src, /require\(['"][./]*(services\/)?(webpush|email-sender|teams|microsoft|suggestion-engine|action-mail)['"]\)/, f);
    assert.doesNotMatch(src, /sendToAll|sendMail|sendDm|graphWrite|executeAction|queueAction/, f);
  }
  assert.match(fs.readFileSync(path.join(__dirname, 'prepared-actions.js'), 'utf8'), /function approve/, 'positive control');
});

test('30. rejected and expired actions remain, with their history', async () => {
  const id = addTask({ text: 'Nick to share the QA rubric with Hope Goodall by 2026-10-03', due_date: '2026-10-03' });
  // "with" names a counterparty, not a beneficiary — make it a delivery to Hope.
  db.run('UPDATE tasks SET text = ? WHERE id = ?', ['Nick to send the QA rubric to Hope Goodall by 2026-10-03', id]);
  await reconcile();
  await run();
  const a = pa.forCommitment(`commitment:task:${id}`)[0];
  assert.ok(a, 'a second strong risk prepared its own draft');
  const rj = pa.reject(a.actionId, { note: 'I will do it in person', now: NOW + 2000 });
  assert.equal(rj.ok, true);
  const kept = pa.get(a.actionId);
  assert.equal(kept.status, 'rejected');
  assert.equal(kept.decisionNote, 'I will do it in person');
  assert.equal(kept.history.length, 2);
  // Nick said no for this episode: the next pass does not prepare another.
  await run();
  assert.equal(pa.forCommitment(`commitment:task:${id}`).length, 1);
  // Expiry: a prepared action nobody decides ages out, and is kept.
  const t3 = addTask({ text: 'Nick to send the rota changes to Chris Middleton by 2026-10-03', due_date: '2026-10-03' });
  await reconcile(); await run();
  const b = pa.forCommitment(`commitment:task:${t3}`)[0];
  const swept = pa.sweep({ now: Date.parse(b.expiresAt) + 1 });
  assert.equal(swept.expired >= 1, true);
  assert.equal(pa.get(b.actionId).status, 'expired');
  assert.equal(pa.get(b.actionId).history.length, 2);
  assert.equal(db.get('SELECT COUNT(*) n FROM prepared_actions').n >= 3, true, 'nothing is ever deleted');
});

test('the HTTP route refuses an approval without the displayed payload hash, and executes nothing', async () => {
  addTask({ text: 'Nick to send the leave planner to Hope Goodall by 2026-10-03', due_date: '2026-10-03' });
  await reconcile(); await run();
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/prepared-actions', require('../routes/prepared-actions'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api/prepared-actions`;
  try {
    const list = await (await fetch(base)).json();
    assert.deepEqual(list.executableTypes, ['chase_commitment', 'reply_email', 'chase_agenda', 'send_weekly_risk_report', 'create_calendar_event', 'reschedule_calendar_event', 'cancel_calendar_event'], 'the registry allow-list, as published (Build 8 + Build 11K)');
    assert.ok(list.actions.every((x) => x.executes === (x.actionType === 'chase_commitment')), 'executes is per type, from the registry');
    const target = list.actions.find((x) => x.status === 'prepared');
    assert.ok(target, 'positive control: this test needs a PREPARED action to reach the hash rule');
    const res = await fetch(`${base}/${target.actionId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: 'ok' }) });
    const body = await res.json();
    assert.equal(res.status, 400, 'no payloadHash: the approval cannot bind to what was shown');
    assert.equal(body.executed, false);
    assert.equal(list.actions.find((x) => x.actionId === target.actionId).status, (await (await fetch(`${base}/${target.actionId}`)).json()).action.status, 'unchanged');
    const missing = await fetch(`${base}/nope/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(missing.status, 404);
  } finally { server.close(); }
  assert.deepEqual(sends, []);
});
