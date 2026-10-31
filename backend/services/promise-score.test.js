'use strict';

/**
 * promise-score-v1 — counts, evidence classification, the London week across
 * both clock changes, re-dates, the Monday report, and the delivery-proof
 * reader against the REAL table definitions from schema.sql.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const s = require('./promise-score');

// Wednesday 21 Oct 2026, 15:00 London (BST, so 14:00 UTC).
const NOW = Date.parse('2026-10-21T14:00:00Z');

function promise(over = {}) {
  return {
    key: 'promise:1', taskIds: [1], leadTaskId: 1, text: 'Send Chris the revised SLA figures', open: true,
    tickedWithoutEvidence: [], records: [{ taskId: 1, status: 'open', completedAt: null }],
    due: '2026-10-22', statedDate: null,
    owedTo: { resolved: 'Chris Middleton', people: [{ name: 'Chris Middleton' }], ambiguous: [] },
    source: { title: '2026-10-15 SLM', path: 'Meetings/2026/10/2026-10-15 SLM.md', line: 'Nick will send Chris the revised SLA figures', readable: true },
    slips: { dueMoves: 0, lapsedBlocks: 0, statedDatePassed: false, dueMovesAt: [], recommitsAt: [] },
    sensitivity: { sensitive: false }, booked: [], nextMeeting: null,
    ...over,
  };
}
const proofOf = (provenBy, sentNotBefore = null) => ({ actionId: 'pa_1', provenBy, sentNotBefore, messageRef: 'abc' });
const CONNECTED = { status: 'connected' };
const run = (promises, extra = {}) => s.scoreWeek({ promises, proofSource: CONNECTED, now: NOW, ...extra });

// ── London week and DST ──────────────────────────────────────────────────────

test('the London week runs Monday 00:00 to the next Monday 00:00 London, across both clock changes', () => {
  const autumn = s.londonWeek(Date.parse('2026-10-25T12:00:00Z')); // clocks go back 25 Oct
  assert.equal(autumn.start, '2026-10-19');
  assert.equal(autumn.end, '2026-10-25');
  assert.equal(new Date(autumn.startMs).toISOString(), '2026-10-18T23:00:00.000Z'); // 00:00 BST
  assert.equal(new Date(autumn.endMs).toISOString(), '2026-10-26T00:00:00.000Z'); // 00:00 GMT
  assert.equal((autumn.endMs - autumn.startMs) / 3600000, 169);
  const spring = s.londonWeek(Date.parse('2026-03-29T12:00:00Z')); // clocks go forward 29 Mar
  assert.equal(spring.start, '2026-03-23');
  assert.equal((spring.endMs - spring.startMs) / 3600000, 167);
});

test('00:30 BST on a Monday is THAT Monday’s week, though it is still Sunday in UTC', () => {
  const w = s.londonWeek(Date.parse('2026-10-18T23:30:00Z'));
  assert.equal(w.start, '2026-10-19');
  const before = s.londonWeek(Date.parse('2026-10-18T22:59:00Z'));
  assert.equal(before.start, '2026-10-12');
});

test('a due point is the END of its London day: 23:59 BST is on time, 00:00 London the next day is not', () => {
  const p = promise({ due: '2026-10-21' });
  const due = s.duePoint(p, 'set');
  assert.equal(new Date(due.endsMs).toISOString(), '2026-10-21T23:00:00.000Z');
  assert.equal(s.classify(p, due, proofOf('2026-10-21T22:59:00Z'), NOW).outcome, 'kept-on-time');
  assert.equal(s.classify(p, due, proofOf('2026-10-21T23:30:00Z', '2026-10-21T23:00:00Z'), NOW).outcome, 'late');
});

test('in GMT the same rule uses a GMT midnight (no hour lost or gained after the clocks go back)', () => {
  const p = promise({ due: '2026-10-26' });
  const due = s.duePoint(p, 'set');
  assert.equal(new Date(due.endsMs).toISOString(), '2026-10-27T00:00:00.000Z');
});

// ── Evidence classification ──────────────────────────────────────────────────

test('kept on time ONLY with a verified delivery before the due point', () => {
  const r = run([promise({ open: false, records: [{ taskId: 1, status: 'done', completedAt: '2026-10-20' }], tickedWithoutEvidence: [1] })],
    { proofs: new Map([['promise:1', proofOf('2026-10-20T10:00:00Z', '2026-10-20T09:58:00Z')]]) });
  assert.equal(r.counts.keptOnTime, 1);
  assert.equal(r.entries[0].outcome, 'kept-on-time');
  assert.equal(r.entries[0].evidence[0].kind, 'verified-send');
  assert.equal(r.entries[0].evidence[0].rule, s.PROOF_RULE);
  assert.match(r.entries[0].rule, /read back in Sent Items before the due point/);
  assert.deepEqual(r.ratio, { kept: 1, of: 1 });
});

test('a tick IS delivery (Nick, 26 Oct 2026): ticked by the due day is kept, after it is late', () => {
  const onTime = run([promise({ open: false, due: '2026-10-21', records: [{ taskId: 1, status: 'done', completedAt: '2026-10-21' }], tickedWithoutEvidence: [1] })]);
  assert.equal(onTime.counts.keptOnTime, 1);
  assert.equal(onTime.entries[0].outcome, 'kept-on-time');
  assert.match(onTime.entries[0].rule, /ticked on or before its due day/);
  assert.deepEqual(onTime.entries[0].evidence, [{ kind: 'ticked', taskId: 1, at: '2026-10-21' }]);
  assert.deepEqual(onTime.ratio, { kept: 1, of: 1 });
  const late = run([promise({ open: false, due: '2026-10-20', records: [{ taskId: 1, status: 'done', completedAt: '2026-10-21' }], tickedWithoutEvidence: [1] })]);
  assert.equal(late.entries[0].outcome, 'late');
  assert.match(late.entries[0].rule, /ticked after its due day/);
});

test('delivery proven but straddling the due point is unverified for timing, and says so', () => {
  const p = promise({ due: '2026-10-21' });
  const due = s.duePoint(p, 'set');
  const v = s.classify(p, due, proofOf('2026-10-21T23:10:00Z', '2026-10-21T22:50:00Z'), NOW);
  assert.equal(v.outcome, 'unverified');
  assert.match(v.rule, /cannot place it before the due point/);
});

test('open past its due point with no evidence is late; open and not yet due is pending (not in the ratio)', () => {
  const r = run([promise({ key: 'promise:1', due: '2026-10-20' }), promise({ key: 'promise:2', taskIds: [2], due: '2026-10-23' })]);
  assert.equal(r.counts.late, 1);
  assert.equal(r.counts.pending, 1);
  assert.equal(r.counts.due, 2);
  assert.deepEqual(r.ratio, { kept: 0, of: 1 });
});

test('a dropped promise is listed but never counted as kept, late or due', () => {
  const r = run([promise({ open: false, records: [{ taskId: 1, status: 'dropped', completedAt: null }] })]);
  assert.equal(r.counts.dropped, 1);
  assert.equal(r.counts.due, 0);
  assert.equal(r.entries[0].outcome, 'dropped');
});

test('only promises due in THIS London week are counted', () => {
  const r = run([promise({ due: '2026-10-26' }), promise({ key: 'promise:2', taskIds: [2], due: '2026-10-18' })]);
  assert.equal(r.counts.due, 0);
  assert.equal(r.entries.length, 0);
});

test('the date in the promise’s own wording beats the task due date', () => {
  const due = s.duePoint(promise({ due: '2026-10-30', statedDate: { date: '2026-10-22', phrase: 'by Thursday' } }), 'set');
  assert.equal(due.date, '2026-10-22');
  assert.equal(due.basis, 'stated-in-wording');
});

test('the 10-day placeholder is not a promised date: undated, never due', () => {
  const r = run([promise({ due: '2026-10-22' })], { dueBases: new Map([['promise:1', 'default']]) });
  assert.equal(r.counts.due, 0);
  assert.equal(r.counts.undated, 1);
  assert.match(r.undated[0].why, /placeholder/);
});

test('a placeholder-dated promise never enters the score as due, late or kept — open, ticked, overdue or proven', () => {
  const ph = new Map([['promise:1', 'default'], ['promise:2', 'default'], ['promise:3', 'default']]);
  const r = run([
    promise({ key: 'promise:1', due: '2026-10-20' }), // overdue placeholder
    promise({ key: 'promise:2', taskIds: [2], open: false, records: [{ taskId: 2, status: 'done', completedAt: '2026-10-20' }], due: '2026-10-21' }),
    promise({ key: 'promise:3', taskIds: [3], due: '2026-10-22' }),
  ], { dueBases: ph, proofs: new Map([['promise:3', proofOf('2026-10-20T10:00:00Z')]]) });
  assert.equal(r.counts.due, 0);
  assert.equal(r.counts.late, 0);
  assert.equal(r.counts.keptOnTime, 0);
  assert.equal(r.counts.unverified, 0);
  assert.equal(r.entries.length, 0);
  assert.deepEqual(r.ratio, { kept: 0, of: 0 });
});

// ── Re-dates ─────────────────────────────────────────────────────────────────

test('re-dates are counted by when they happened in the London week, moves and re-commits told apart', () => {
  const p = promise({ slips: { dueMoves: 2, lapsedBlocks: 0, statedDatePassed: false,
    // 18 Oct 23:30 UTC is 00:30 BST Monday 19 Oct — inside; 18 Oct 22:30 UTC is Sunday — outside.
    dueMovesAt: ['2026-10-18T23:30:00', '2026-10-18T22:30:00'], recommitsAt: ['2026-10-20T09:00:00'] } });
  const r = run([p]);
  assert.equal(r.counts.reDated, 1);
  assert.deepEqual(r.reDated, { moved: 1, recommitted: 1 });
  assert.equal(r.reDatedEntries[0].moved, 1);
});

test('a re-commit alone is described as Nick’s choice, not a slip', () => {
  const r = run([promise({ slips: { dueMoves: 0, lapsedBlocks: 0, statedDatePassed: false, dueMovesAt: [], recommitsAt: ['2026-10-20T09:00:00'] } })]);
  assert.match(r.reDatedEntries[0].rule, /re-committed by you/);
});

// ── Honesty ──────────────────────────────────────────────────────────────────

test('the score is measured without any delivery-email source — ticks are enough', () => {
  const r = s.scoreWeek({ promises: [promise({ due: '2026-10-20' })], proofSource: { status: 'not-connected', why: 'x' }, now: NOW });
  assert.deepEqual(r.ratio, { kept: 0, of: 1 });
  assert.equal(r.measured, true);
  assert.equal(r.why, null);
  assert.equal(r.counts.late, 1);
});

test('an unreadable task list measures nothing', () => {
  const r = s.scoreWeek({ promises: [], proofSource: CONNECTED, now: NOW, gaps: [{ input: 'tasks', why: 'locked' }] });
  assert.equal(r.ratio, null);
  assert.match(r.why, /couldn’t read the task list/);
});

// ── The Monday report ────────────────────────────────────────────────────────

test('the Monday report is judged separately against midday London on its due day', () => {
  const base = { week: '2026-10-19', dueDay: '2026-10-19' };
  const due = s.mondayReport({ ...base, now: Date.parse('2026-10-19T10:00:00Z') });
  assert.equal(due.state, 'due');
  assert.equal(due.dueAt, '2026-10-19T11:00:00.000Z'); // 12:00 BST
  assert.equal(due.dueLabel, 'Monday 19 October 2026, 12:00 (London)');
  assert.equal(s.mondayReport({ ...base, now: NOW }).state, 'late');
  assert.equal(s.mondayReport({ ...base, published: { at: 'x' }, now: NOW }).state, 'written-no-send-record');
  const ok = s.mondayReport({ ...base, sent: { sentAt: '2026-10-19T10:40:00Z', actionId: 'pa_9' }, sendProof: { verified: true, provenBy: '2026-10-19T10:45:00Z' }, now: NOW });
  assert.equal(ok.state, 'sent-verified-on-time');
  const late = s.mondayReport({ ...base, sent: { sentAt: '2026-10-19T13:00:00Z', actionId: 'pa_9' }, sendProof: { verified: true, provenBy: '2026-10-19T13:02:00Z' }, now: NOW });
  assert.equal(late.state, 'sent-verified-late');
  const nick = s.mondayReport({ ...base, sent: { sentAt: '2026-10-19T10:00:00Z', actionId: null, reportedByNick: true }, now: NOW });
  assert.equal(nick.state, 'sent-unverified');
  assert.match(nick.rule, /your word, not a read-back/);
  assert.equal(s.mondayReport({ ...base, now: NOW, known: false }).state, 'unknown');
});

test('the Monday report never enters the promise counts', () => {
  const r = run([]);
  assert.deepEqual(r.counts, { due: 0, keptOnTime: 0, late: 0, unverified: 0, pending: 0, dropped: 0, reDated: 0, undated: 0, beforeProofSource: 0 });
});

// ── The proof reader, over the REAL table definitions ────────────────────────

function realActionDb() {
  const Database = require('better-sqlite3');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf-8');
  const db = new Database(':memory:');
  for (const t of ['prepared_actions', 'action_attempts', 'action_verifications']) {
    const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\n\\);`).exec(schema);
    assert.ok(m, `schema.sql defines ${t}`);
    db.exec(m[0]);
  }
  return {
    raw: db,
    all: (sql, p = []) => db.prepare(sql).all(...p),
    get: (sql, p = []) => db.prepare(sql).get(...p),
  };
}

function addAction(db, { id, status, evidence, verifications = [], attempt = {} }) {
  db.raw.prepare(`INSERT INTO prepared_actions (action_id, idempotency_key, finding_id, commitment_id, action_type, target_json, reason, evidence_json,
    draft_json, payload_hash, authority_class, status, created_at, history_json, updated_at)
    VALUES (?, ?, 'f', 'c', 'compose_email', '{}', 'r', ?, '{}', 'h', 'A4', ?, '2026-10-20T08:00:00Z', '[]', '2026-10-20T08:00:00Z')`)
    .run(id, `idem-${id}`, JSON.stringify(evidence), status);
  db.raw.prepare(`INSERT INTO action_attempts (attempt_id, action_id, attempt, execution_key, boot_id, started_at, send_requested_at, send_outcome)
    VALUES (?, ?, 1, ?, 'b', ?, ?, 'accepted')`).run(`${id}#1`, id, `exec:${id}`, attempt.started || '2026-10-20T09:00:00Z', attempt.sent || '2026-10-20T09:00:05Z');
  for (const v of verifications) {
    db.raw.prepare(`INSERT INTO action_verifications (action_id, attempt_id, checked_at, outcome, proof_json) VALUES (?, ?, ?, ?, ?)`)
      .run(id, `${id}#1`, v.at, v.outcome, JSON.stringify({ messageRef: 'm1' }));
  }
}

test('readProofs: only a VERIFIED deliver-email naming the promise, whose latest verification is verified, is proof', () => {
  const db = realActionDb();
  addAction(db, { id: 'pa_ok', status: 'verified', evidence: { promiseKey: 'promise:1', move: 'deliver-email' },
    verifications: [{ at: '2026-10-20T09:01:00Z', outcome: 'not_found' }, { at: '2026-10-20T09:03:00Z', outcome: 'verified' }] });
  addAction(db, { id: 'pa_chase', status: 'verified', evidence: { promiseKey: 'promise:2', move: 'chase-email' },
    verifications: [{ at: '2026-10-20T09:03:00Z', outcome: 'verified' }] });
  addAction(db, { id: 'pa_exec', status: 'executed', evidence: { promiseKey: 'promise:3', move: 'deliver-email' } });
  addAction(db, { id: 'pa_amb', status: 'verified', evidence: { promiseKey: 'promise:4', move: 'deliver-email' },
    verifications: [{ at: '2026-10-20T09:03:00Z', outcome: 'ambiguous' }] });
  const { proofs, source } = s.readProofs(db, { executionOn: true });
  assert.equal(source.status, 'connected');
  assert.equal(source.linkedActions, 3, 'a chase is not a delivery link');
  assert.equal(source.connectedSince, '2026-10-20T08:00:00Z');
  assert.deepEqual([...proofs.keys()], ['promise:1']);
  assert.deepEqual(proofs.get('promise:1'), { actionId: 'pa_ok', provenBy: '2026-10-20T09:03:00Z', sentNotBefore: '2026-10-20T09:00:05Z', messageRef: 'm1' });
});

test('readProofs: with “Send approved emails” off nothing is connected and NO proof is returned', () => {
  const db = realActionDb();
  addAction(db, { id: 'pa_ok', status: 'verified', evidence: { promiseKey: 'promise:1', move: 'deliver-email' }, verifications: [{ at: '2026-10-20T09:03:00Z', outcome: 'verified' }] });
  const r = s.readProofs(db, { executionOn: false });
  assert.equal(r.source.status, 'not-connected');
  assert.equal(r.proofs.size, 0);
  assert.match(r.source.why, /Send approved emails/);
});

test('a promise due before any delivery email existed is still judged — ticks need no proof source', () => {
  const src = { status: 'connected', connectedSince: '2026-10-21T09:00:00Z' };
  const r = run([promise({ key: 'promise:1', due: '2026-10-20' }), promise({ key: 'promise:2', taskIds: [2], due: '2026-10-21' })], { proofSource: src });
  assert.equal(r.counts.beforeProofSource, 0);
  assert.equal(r.counts.late, 1);
  assert.equal(r.counts.pending, 1);
});

test('readProofs: no action has ever named a promise → not-connected, and an unreadable table → unreadable', () => {
  const db = realActionDb();
  addAction(db, { id: 'pa_other', status: 'verified', evidence: { findingId: 'x' }, verifications: [{ at: '2026-10-20T09:03:00Z', outcome: 'verified' }] });
  assert.equal(s.readProofs(db, { executionOn: true }).source.status, 'not-connected');
  const broken = { all: () => { throw new Error('no such table'); }, get: () => null };
  assert.equal(s.readProofs(broken).source.status, 'unreadable');
});
