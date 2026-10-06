'use strict';

/**
 * Build 6 — approval-gated execution of ONE action type (chase_commitment).
 *
 *   run: node --test backend/services/action-executor.test.js
 *
 * ⚠ The Microsoft transport is a FAKE built here (fakeMail). The real outbound
 * doors — web push, email-sender, Teams, Graph writes through microsoft.js —
 * are stubbed to THROW, so if anything in these flows reaches a real sender or
 * a notification, the suite fails rather than sending. "The executor cannot
 * push" and "nothing leaves through an unregistered door" are asserted, not
 * assumed.
 *
 * Numbers in test names refer to the Build 6 brief's test list.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b6-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'b6.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
delete process.env.GOVERNED_EXECUTION_ENABLED;
delete process.env.COMMITMENT_RISK_MODE;
delete process.env.MEETING_INTELLIGENCE_MODE;
delete process.env.SOURCE_BLIND_MODE;

const realDoors = [];
function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
const boom = (what) => async (...a) => { realDoors.push(what); throw new Error(`${what} reached from a governed-action flow`); };
stub('./webpush', { sendToAll: boom('webpush.sendToAll'), isConfigured: () => true });
stub('./email-sender', { sendMail: boom('email-sender.sendMail'), sendBriefEmail: boom('email-sender.sendBriefEmail'), OWN_ADDRESS: 'nickw@nurtur.tech' });
stub('./teams', { sendDm: boom('teams.sendDm'), getSendStatus: () => ({}) });
stub('./microsoft', {
  getSignedInAddress: async () => 'nickw@nurtur.tech',
  getAccessToken: async () => { realDoors.push('microsoft.getAccessToken'); return null; },
  fetchSentMail: boom('microsoft.fetchSentMail'),
  graphWrite: boom('microsoft.graphWrite'),
  sendMail: boom('microsoft.sendMail'),
});

const db = require('../db/database');
const registry = require('./action-registry');
const pa = require('./prepared-actions');
const ex = require('./action-executor');

test.before(async () => { await db.init(); });

// Saturday 3 Oct 2026, 10:00 London.
const NOW = Date.parse('2026-10-03T09:00:00Z');
const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();

// ── fixtures ─────────────────────────────────────────────────────────────────

const PERSON = { personId: 'person:chris-middleton', displayName: 'Chris Middleton', email: 'chris.middleton@nurtur.tech', method: 'exact-name' };
let k = 0;

function finding(id, status = 'active') {
  db.run(`INSERT OR REPLACE INTO commitment_risk_findings (finding_id, commitment_id, episode, status, level, triggers_json, summary, why,
          evidence_json, unavailable_json, checked_json, confidence, novelty, first_created_at, updated_at)
          VALUES (?, 'c', 1, ?, 'high', '[]', 's', 'w', '{}', '[]', '{}', 0.9, 'new', ?, ?)`, [id, status, iso(NOW), iso(NOW)]);
}

/** A prepared chase_commitment exactly as prepareFromRisk writes one. */
function makeChase({ target = PERSON, createdAt = NOW, type = 'chase_commitment' } = {}) {
  k += 1;
  const key = `send the rota ${k}`;
  const commitmentId = `commitment:waiting-on:${key}`;
  const findingId = `commitment-risk:${commitmentId}:1`;
  finding(findingId);
  const commitment = { commitmentId, description: `Chris Middleton to send the rota ${k}`, direction: 'to-nick', status: 'open',
    source: { ref: `waiting-on:${key}`, date: '2026-09-28' } };
  const draft = pa.draftFor(type, commitment, target);
  const evidence = { finding: { findingId }, commitment, target };
  const actionId = `pa_test_${k}`;
  db.run(`INSERT INTO prepared_actions (action_id, idempotency_key, finding_id, commitment_id, subject_ref, action_type, version,
          target_json, reason, evidence_json, evidence_hash, draft_json, payload_hash, authority_class, approval_required, status,
          created_at, expires_at, history_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'r', ?, ?, ?, ?, 'A4', 1, 'prepared', ?, ?, '[]', ?)`,
  [actionId, `prepared:${commitmentId}:1:${type}`, findingId, commitmentId, `waiting-on:${key}`, type,
    JSON.stringify(target), JSON.stringify(evidence), registry.evidenceHash(evidence), JSON.stringify(draft),
    registry.payloadHash({ actionType: type, version: 1, commitmentId, target, draft }),
    iso(createdAt), iso(createdAt + 72 * 60 * MIN), iso(createdAt)]);
  return { action: pa.get(actionId), commitment, key };
}

/** A fake Microsoft mailbox with Drafts and Sent Items. */
function fakeMail(opts = {}) {
  const drafts = new Map();
  const sentItems = [];
  const calls = { create: 0, send: 0, find: 0, deleted: [] };
  let clockMs = opts.clockMs ?? NOW;
  const moveToSent = (id) => {
    const d = drafts.get(id);
    sentItems.push({ id: `sent-${id}`, internetMessageId: d.imid, subject: d.subject, to: d.to.map((x) => x.email.toLowerCase()),
      cc: [], bcc: [], from: 'nickw@nurtur.tech', sentAt: iso(clockMs), bodyText: d.body });
    drafts.delete(id); // a sent draft moves, and its id changes
  };
  const api = {
    createDraft: async ({ to, subject, body }) => {
      calls.create += 1;
      if (opts.createFail) return { ok: false, category: 'http_5xx', status: 503 };
      const id = `draft-${calls.create}`;
      const imid = opts.noHandle ? null : `<m${calls.create}.${Math.random().toString(36).slice(2)}@nurtur.tech>`;
      drafts.set(id, { to, subject, body, imid });
      return { ok: true, id, internetMessageId: imid };
    },
    sendDraft: async (id) => {
      calls.send += 1;
      if (opts.onSend) opts.onSend(id);
      if (opts.sendGate) await opts.sendGate;
      const mode = opts.send || 'accept';
      if (mode === 'accept') { moveToSent(id); return { outcome: 'accepted', status: 202 }; }
      if (mode === 'reject') return { outcome: 'rejected', status: 403, category: 'scope' };
      if (mode === 'timeout-after-receipt') { moveToSent(id); return { outcome: 'uncertain', status: null, category: 'timeout' }; }
      return { outcome: 'uncertain', status: null, category: 'timeout' }; // timeout-before-receipt: still a draft
    },
    findSent: async (imid) => {
      calls.find += 1;
      if (opts.findUnavailable) return { ok: false, category: 'http_5xx' };
      const hits = sentItems.filter((m) => m.internetMessageId === imid);
      return { ok: true, messages: opts.duplicateSent && hits.length ? [hits[0], { ...hits[0], id: 'other' }] : hits };
    },
    draftState: async (id) => (drafts.has(id) ? 'draft' : 'gone'),
    deleteDraft: async (id) => { if (!drafts.has(id)) return false; drafts.delete(id); calls.deleted.push(id); return true; },
    sentToSince: async () => (opts.sentUnreadable ? null : { count: opts.alreadyEmailed ? 1 : 0 }),
    signedInAddress: async () => 'nickw@nurtur.tech',
  };
  return { api, calls, drafts, sentItems, setClock: (ms) => { clockMs = ms; } };
}

/** The world at execution time — open, unmoved, same person. Override per test. */
function world(fixture, mail, over = {}) {
  const chased = [];
  const deps = {
    mail: mail.api,
    enabled: () => true,
    commitment: () => ({ ...fixture.commitment }),
    progress: () => ({ state: 'no_evidence', reasons: [] }),
    counterparty: () => ({ personId: PERSON.personId, displayName: PERSON.displayName, emails: [PERSON.email], method: 'exact-name' }),
    waiting: () => ({ status: 'open', askedAt: null, snoozedUntil: null }),
    deferred: () => false,
    markChased: (key) => chased.push(key),
    ...over,
  };
  return { deps, chased };
}

// Build 7: an approval carries human proof — a challenge NEURO issued for this
// exact action, and the approval code. `sending: () => true` stands in for the
// Settings switch (now default OFF), which these executor tests are not about.
const proofs = require('./approval-proof');
const CODE = 'b6-test-approval-code';
test.before(() => { if (!proofs.codeStatus().set) assert.equal(proofs.setCode(CODE).ok, true); });
const approve = (a, at = NOW + MIN) => {
  const ch = proofs.issue({ actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, now: at });
  return pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, challengeId: ch.challengeId, approvalCode: CODE, now: at, sending: () => true });
};

// ── 6A AUTHORITY ────────────────────────────────────────────────────────────

test('1/4. chase_commitment is A4; the registry is an allow-list (Build 8: the four outbound email types) with ONE executor', () => {
  const p = registry.policyFor('chase_commitment');
  assert.equal(p.authority, 'A4');
  assert.equal(p.requiresApproval, true);
  assert.equal(p.executor, 'microsoft.mail');
  assert.equal(p.verification, 'sent-items');
  assert.equal(p.retryPolicy, 'human-review');
  // Build 8 widened this to every email NEURO can send; Build 11K adds the
  // three calendar changes other people are told about — and nothing else.
  assert.deepEqual(registry.executableTypes(), ['chase_commitment', 'reply_email', 'chase_agenda', 'send_weekly_risk_report', 'create_calendar_event', 'reschedule_calendar_event', 'cancel_calendar_event']);
  assert.deepEqual(Object.keys(ex.EXECUTORS), ['microsoft.mail', 'microsoft.calendar']);
  assert.deepEqual(registry.validateRegistry(), []);
  assert.equal(registry.policyFor('respond_meeting'), null, 'a retired legacy type is not in the governed registry');
  assert.equal(registry.policyFor('__proto__'), null, 'no prototype leak through the lookup');
  // Every A0–A4 level exists; A4 carries its requirements.
  assert.deepEqual(Object.keys(registry.AUTHORITY), ['A0', 'A1', 'A2', 'A3', 'A4']);
  assert.ok(registry.AUTHORITY.A4.requirements.length >= 10);
  // A malformed future entry is caught.
  assert.ok(registry.validateRegistry({ x: { type: 'x', authority: 'A4', requiresApproval: true, executable: true, executor: 'shell', verification: null, retryPolicy: 'auto' } }).length >= 3);
});

test('2. A4 cannot execute unapproved — the executor says already/prepared, and the database refuses the transition outright', async () => {
  const f = makeChase();
  const mail = fakeMail();
  const r = await ex.execute(f.action.actionId, { now: NOW + MIN, deps: world(f, mail).deps });
  assert.equal(r.status, 'prepared');
  assert.equal(mail.calls.create + mail.calls.send, 0);
  assert.throws(() => db.run(`UPDATE prepared_actions SET status = 'executing' WHERE action_id = ?`, [f.action.actionId]), /only an approved action/);
  // Two triggers refuse this (Build 6: the hash; Build 7: no human proof) — either message is the database refusing.
  assert.throws(() => db.run(`UPDATE prepared_actions SET status = 'approved', approved_by = 'x', approved_payload_hash = 'wrong' WHERE action_id = ?`, [f.action.actionId]), /must bind the exact payload|human-approval proof/);
});

test('3. an unknown action type cannot be approved or executed', async () => {
  const f = makeChase({ type: 'draft_chase_email' });
  // Build 5's name is registered but NOT executable: its approvals were given on "nothing sends" terms.
  const r = approve(f.action);
  assert.equal(r.ok, true);
  assert.equal(r.executable, false);
  const mail = fakeMail();
  const x = await ex.execute(f.action.actionId, { now: NOW + 2 * MIN, deps: world(f, mail).deps });
  assert.equal(x.code, 'not-executable');
  assert.equal(mail.calls.create, 0);
  // A wholly unregistered type is refused at approval.
  db.run(`INSERT INTO prepared_actions (action_id, idempotency_key, finding_id, commitment_id, action_type, target_json, reason,
          evidence_json, draft_json, payload_hash, authority_class, approval_required, status, created_at, history_json, updated_at)
          VALUES ('pa_unknown', 'unknown', 'f', 'c', 'run_shell', '{}', 'r', '{}', '{}', 'h', 'A4', 1, 'prepared', ?, '[]', ?)`, [iso(NOW), iso(NOW)]);
  assert.match(pa.approve('pa_unknown', { approver: 'nick', payloadHash: 'h' }).error, /not a registered action type/);
});

// ── 6B APPROVAL ─────────────────────────────────────────────────────────────

test('5/6. approval binds the exact payload hash, records approver and expiry, and the approved payload cannot change', () => {
  const f = makeChase();
  assert.match(pa.approve(f.action.actionId, { approver: 'nick', now: NOW }).error, /payloadHash/);
  assert.match(pa.approve(f.action.actionId, { approver: 'nick', payloadHash: 'stale', now: NOW }).error, /not the one you were shown/);
  assert.match(pa.approve(f.action.actionId, { payloadHash: f.action.payloadHash, now: NOW }).error, /approver/);
  const r = approve(f.action, NOW + MIN);
  assert.equal(r.ok, true);
  const a = pa.get(f.action.actionId);
  assert.equal(a.approval.payloadHash, f.action.payloadHash);
  assert.equal(a.approval.by, 'nick');
  assert.equal(a.approval.expiresAt, iso(NOW + MIN + 24 * 60 * MIN));
  assert.equal(a.approval.evidenceHash, f.action.evidenceHash);
  // The words, the recipient and the approval itself are immutable.
  assert.throws(() => db.run(`UPDATE prepared_actions SET draft_json = ? WHERE action_id = ?`, ['{"body":"different"}', a.actionId]), /immutable/);
  assert.throws(() => db.run(`UPDATE prepared_actions SET target_json = ? WHERE action_id = ?`, ['{"email":"x@y.z"}', a.actionId]), /immutable/);
  assert.throws(() => db.run(`UPDATE prepared_actions SET approved_payload_hash = 'x' WHERE action_id = ?`, [a.actionId]), /approval is immutable/);
  assert.throws(() => db.run(`DELETE FROM prepared_actions WHERE action_id = ?`, [a.actionId]), /never deleted/);
});

test('7. edit creates a NEW unapproved version; the old one is superseded and unchanged; an approved one cannot be edited', () => {
  const f = makeChase();
  const ed = pa.edit(f.action.actionId, { payloadHash: f.action.payloadHash, body: 'Hi Chris,\n\nWhere is the rota up to?\n\nThanks,\nNick', now: NOW + MIN });
  assert.equal(ed.ok, true, ed.error);
  const v2 = ed.action;
  assert.equal(v2.version, 2);
  assert.equal(v2.status, 'prepared');
  assert.equal(v2.approval, null, 'the new version carries no approval');
  assert.equal(v2.parentActionId, f.action.actionId);
  assert.notEqual(v2.payloadHash, f.action.payloadHash);
  assert.equal(v2.target.email, PERSON.email, 'recipient is not editable');
  const old = pa.get(f.action.actionId);
  assert.equal(old.status, 'superseded');
  assert.equal(old.draft.body, f.action.draft.body, 'the old words are untouched');
  // Approving the OLD hash on the new version is refused.
  assert.match(pa.approve(v2.actionId, { approver: 'nick', payloadHash: f.action.payloadHash }).error, /not the one you were shown/);
  assert.equal(approve(v2).ok, true);
  assert.match(pa.edit(v2.actionId, { payloadHash: v2.payloadHash, body: 'x' }).error, /only a prepared action/);
});

test('8. an expired approval cannot execute — it expires, nothing is sent', async () => {
  const f = makeChase();
  approve(f.action, NOW);
  const mail = fakeMail();
  const r = await ex.execute(f.action.actionId, { now: NOW + 25 * 60 * MIN, deps: world(f, mail).deps });
  assert.equal(r.code, 'approval-expired');
  assert.equal(pa.get(f.action.actionId).status, 'expired');
  assert.equal(mail.calls.create + mail.calls.send, 0);
  // And the sweep expires an approval nobody executed (the brake was on).
  const g = makeChase();
  approve(g.action, NOW);
  assert.equal(pa.sweep({ now: NOW + 25 * 60 * MIN }).approvalsExpired >= 1, true);
  assert.equal(pa.get(g.action.actionId).status, 'expired');
});

test('9. a rejected action cannot execute or be approved', async () => {
  const f = makeChase();
  assert.equal(pa.reject(f.action.actionId, { note: 'I will ask in person', now: NOW }).ok, true);
  assert.match(approve(f.action).error, /rejected/);
  const mail = fakeMail();
  const r = await ex.execute(f.action.actionId, { now: NOW + MIN, deps: world(f, mail).deps });
  assert.equal(r.status, 'rejected');
  assert.equal(mail.calls.send, 0);
});

// ── 6C ELIGIBILITY at execution ─────────────────────────────────────────────

async function blocked(over, mailOpts = {}) {
  const f = makeChase();
  approve(f.action);
  const mail = fakeMail(mailOpts);
  const r = await ex.execute(f.action.actionId, { now: NOW + 2 * MIN, deps: world(f, mail, over).deps });
  return { r, mail, status: pa.get(f.action.actionId).status, f };
}

test('10-15. eligibility is re-checked at execution: closed, likely done, ambiguous or changed target, snoozed, deferred, chased — none sends', async () => {
  const cases = [
    ['10 completed', { commitment: () => ({ status: 'done' }) }, 'commitment-closed'],
    ['11 likely fulfilled', { progress: () => ({ state: 'likely_fulfilled', reasons: ['sent mail'] }) }, 'likely-done'],
    ['12 ambiguous recipient', { counterparty: () => ({ personId: PERSON.personId, displayName: 'Chris', emails: [PERSON.email], method: 'unique-first-name' }) }, 'target-ambiguous'],
    ['12 two addresses', { counterparty: () => ({ ...PERSON, emails: [PERSON.email, 'chris@gmail.com'] }) }, 'target-address-ambiguous'],
    ['12 address changed', { counterparty: () => ({ ...PERSON, emails: ['chris.m@nurtur.tech'] }) }, 'target-address-changed'],
    ['13 no email', { counterparty: () => ({ ...PERSON, emails: [] }) }, 'target-address-ambiguous'],
    ['14 snoozed', { waiting: () => ({ status: 'open', snoozedUntil: iso(NOW + 3 * 24 * 60 * MIN) }) }, 'snoozed'],
    ['14 not today', { deferred: () => true }, 'deferred'],
    ['15 chased elsewhere since prepared', { waiting: () => ({ status: 'open', askedAt: iso(NOW + 30000) }) }, 'chased-elsewhere'],
    ['15 chased recently', { waiting: () => ({ status: 'open', askedAt: iso(NOW - 2 * 24 * 60 * MIN) }) }, 'chased-recently'],
  ];
  for (const [label, over, code] of cases) {
    const { r, mail, status } = await blocked(over);
    assert.equal(r.code, code, label);
    assert.equal(status, 'cancelled', `${label}: the world moved, so the approval is cancelled`);
    assert.equal(mail.calls.create + mail.calls.send, 0, `${label}: nothing created or sent`);
  }
  // Nick emailed them since it was prepared (a LIVE Sent Items read).
  const live = await blocked({}, { alreadyEmailed: true });
  assert.equal(live.r.code, 'already-emailed');
  assert.equal(live.status, 'cancelled');
  assert.equal(live.mail.calls.send, 0);
});

test('could-not-check leaves it APPROVED (transient), never sends and never cancels on an unknown', async () => {
  for (const [over, mailOpts, code] of [
    [{ progress: () => ({ state: 'unknown' }) }, {}, 'progress-unknown'],
    [{ deferred: () => null }, {}, 'deferral-unknown'],
    [{}, { sentUnreadable: true }, 'sent-mail-unreadable'],
  ]) {
    const { r, mail, status } = await blocked(over, mailOpts);
    assert.equal(r.code, code);
    assert.equal(r.transient, true);
    assert.equal(status, 'approved');
    assert.equal(mail.calls.send, 0);
  }
  // The brake.
  const { r, status } = await blocked({ enabled: () => false });
  assert.equal(r.code, 'switched-off');
  assert.equal(status, 'approved');
  // Isolation: reconcile is global, so leave no approved action behind for later tests.
  for (const x of pa.list({ status: 'approved', limit: 500 })) pa.reject(x.actionId, { note: 'test cleanup', now: NOW + 3 * MIN });
});

test('15b. a second governed chase for the same thing is refused while one is executed', async () => {
  const f = makeChase();
  approve(f.action);
  const mail = fakeMail();
  const w = world(f, mail);
  await ex.execute(f.action.actionId, { now: NOW + 2 * MIN, deps: w.deps });
  assert.equal(pa.get(f.action.actionId).status, 'verified');
  // A second action for the SAME subject (e.g. a new risk episode).
  const key = f.key;
  const g = makeChase();
  db.run('UPDATE prepared_actions SET subject_ref = ? WHERE action_id = ?', [`waiting-on:${key}`, g.action.actionId]);
  approve(g.action);
  const r = await ex.execute(g.action.actionId, { now: NOW + 3 * MIN, deps: world(g, mail).deps });
  assert.equal(r.code, 'duplicate');
  assert.equal(mail.calls.send, 1, 'still exactly one send');
  // And the legacy queue cannot chase it either.
  assert.ok(pa.governedChaseLive(`waiting-on:${key}`, { now: NOW + 3 * MIN }));
});

// ── 6C/6D EXECUTION + 6F VERIFICATION ───────────────────────────────────────

test('21/25/26. provider success → executed (transport) → verified by the provider message id in Sent Items', async () => {
  const f = makeChase();
  approve(f.action);
  // At the instant the send is requested, the ledger must ALREADY hold the
  // verification handle — that ordering is what makes a crash mid-send verifiable.
  const atSend = [];
  const mail = fakeMail({ onSend: () => atSend.push(db.get('SELECT internet_message_id, send_requested_at FROM action_attempts WHERE action_id = ?', [f.action.actionId])) });
  const w = world(f, mail);
  const r = await ex.execute(f.action.actionId, { now: NOW + 2 * MIN, deps: w.deps });
  assert.equal(r.status, 'verified');
  const a = pa.get(f.action.actionId);
  assert.equal(a.status, 'verified');
  const statuses = a.history.map((h) => h.to);
  assert.deepEqual(statuses, ['approved', 'executing', 'executed', 'verified'], 'EXECUTED and VERIFIED are separate, ordered transitions');
  const [att] = ex.attemptsFor(a.actionId);
  assert.equal(att.sendOutcome, 'accepted');
  assert.equal(att.sendHttpStatus, 202);
  assert.ok(att.internetMessageId, 'the provider message id is on the ledger');
  assert.equal(atSend.length, 1);
  assert.ok(atSend[0].internet_message_id, 'the handle was on the ledger BEFORE the send was requested');
  assert.ok(atSend[0].send_requested_at, 'and so was the fact that a send was about to be asked for');
  const [v] = ex.verificationsFor(a.actionId);
  assert.equal(v.outcome, 'verified');
  assert.equal(v.proof.checks.messageId, true);
  assert.equal(v.proof.checks.recipient, true);
  assert.equal(v.proof.checks.subject, true);
  assert.equal(v.proof.checks.sender, true);
  assert.equal(v.proof.checks.body, true);
  // The send went to exactly the approved recipient with the approved words, no CC.
  assert.equal(mail.sentItems.length, 1);
  assert.deepEqual(mail.sentItems[0].to, [PERSON.email]);
  assert.equal(mail.sentItems[0].bodyText, f.action.draft.body);
  // Bookkeeping: waiting-on told once; the commitment is NOT completed by a chase.
  assert.deepEqual(w.chased, [f.key]);
});

test('22. provider refusal → failed, proven unsent, retry-safe, draft removed; never retried', async () => {
  const f = makeChase();
  approve(f.action);
  const mail = fakeMail({ send: 'reject' });
  const r = await ex.execute(f.action.actionId, { now: NOW + 2 * MIN, deps: world(f, mail).deps });
  assert.equal(r.status, 'failed');
  const a = pa.get(f.action.actionId);
  assert.equal(a.retrySafe, true);
  assert.match(a.outcomeDetail, /nothing was sent/);
  assert.equal(mail.calls.deleted.length, 1, 'the stray draft is removed so it cannot be sent by hand');
  await ex.reconcile({ now: NOW + 30 * MIN, deps: world(f, mail).deps });
  assert.equal(ex.attemptsFor(a.actionId).length, 1, 'a failed action is never retried automatically');
  assert.equal(pa.get(a.actionId).status, 'failed');
  // A resend is a NEW version needing a NEW approval.
  const ed = pa.edit(a.actionId, { payloadHash: a.payloadHash, now: NOW + 31 * MIN });
  assert.equal(ed.ok, true, ed.error);
  assert.equal(ed.action.status, 'prepared');
  assert.equal(pa.get(a.actionId).status, 'failed', 'the failed version stays failed');
});

test('draft creation failure → failed before send, nothing sent; no handle → refused', async () => {
  for (const opts of [{ createFail: true }, { noHandle: true }]) {
    const f = makeChase();
    approve(f.action);
    const mail = fakeMail(opts);
    const r = await ex.execute(f.action.actionId, { now: NOW + 2 * MIN, deps: world(f, mail).deps });
    assert.equal(r.status, 'failed');
    assert.equal(mail.calls.send, 0, 'no verification handle, no send');
  }
});

test('23/24/19. timeout AFTER the provider received it → uncertain → verified; NEVER resent', async () => {
  const f = makeChase();
  approve(f.action);
  const mail = fakeMail({ send: 'timeout-after-receipt' });
  const r = await ex.execute(f.action.actionId, { now: NOW + 2 * MIN, deps: world(f, mail).deps });
  assert.equal(r.status, 'verified');
  const statuses = pa.get(f.action.actionId).history.map((h) => h.to);
  assert.deepEqual(statuses, ['approved', 'executing', 'execution_uncertain', 'verified']);
  await ex.reconcile({ now: NOW + 20 * MIN, deps: world(f, mail).deps });
  assert.equal(mail.calls.send, 1);
  assert.equal(mail.sentItems.length, 1);
});

test('24/27. timeout BEFORE receipt → uncertain; not found stays uncertain until it SETTLES; then failed (proven: still a draft); never resent', async () => {
  const f = makeChase();
  approve(f.action);
  const mail = fakeMail({ send: 'timeout-before-receipt' });
  const w = world(f, mail);
  await ex.execute(f.action.actionId, { now: NOW + 2 * MIN, deps: w.deps });
  assert.equal(pa.get(f.action.actionId).status, 'execution_uncertain');
  await ex.reconcile({ now: NOW + 5 * MIN, deps: w.deps });
  assert.equal(pa.get(f.action.actionId).status, 'execution_uncertain', 'not found inside the settle window is not proof');
  await ex.reconcile({ now: NOW + 20 * MIN, deps: w.deps });
  const a = pa.get(f.action.actionId);
  assert.equal(a.status, 'failed');
  assert.equal(a.retrySafe, true);
  assert.equal(mail.calls.send, 1, 'one send request, ever');
  assert.deepEqual(w.chased, [], 'an unsent chase is not recorded as a chase');
  const outcomes = ex.verificationsFor(a.actionId).map((v) => v.outcome);
  assert.deepEqual(outcomes, ['not_found'], 'a repeated identical answer is not appended again');
});

test('28. an ambiguous Sent Items match stays uncertain for Nick — never verified, never resent', async () => {
  const f = makeChase();
  approve(f.action);
  const mail = fakeMail({ duplicateSent: true });
  await ex.execute(f.action.actionId, { now: NOW + 2 * MIN, deps: world(f, mail).deps });
  const a = pa.get(f.action.actionId);
  assert.equal(a.status, 'execution_uncertain');
  assert.match(a.outcomeDetail, /will not be resent/);
  await ex.reconcile({ now: NOW + 30 * MIN, deps: world(f, mail).deps });
  assert.equal(pa.get(a.actionId).status, 'execution_uncertain');
  assert.equal(mail.calls.send, 1);
  // A single match with the WRONG recipient is ambiguous too (pure judge).
  const att = { started_at: iso(NOW), internet_message_id: '<x@y>' };
  const j = ex.judgeSentItem({ internetMessageId: '<x@y>', to: ['someone.else@nurtur.tech'], cc: [], bcc: [], subject: a.draft.subject,
    sentAt: iso(NOW + MIN), from: 'nickw@nurtur.tech', bodyText: a.draft.body }, { action: a, attempt: att, signedIn: 'nickw@nurtur.tech' });
  assert.equal(j.ok, false);
  assert.equal(j.checks.recipient, false);
  // A different sender is not ours.
  const j2 = ex.judgeSentItem({ internetMessageId: '<x@y>', to: [PERSON.email], cc: [], bcc: [], subject: a.draft.subject,
    sentAt: iso(NOW + MIN), from: 'someone@nurtur.tech', bodyText: a.draft.body }, { action: a, attempt: att, signedIn: 'nickw@nurtur.tech' });
  assert.equal(j2.ok, false);
});

test('29. a verification outage neither fails the action nor resends', async () => {
  const f = makeChase();
  approve(f.action);
  const mail = fakeMail({ findUnavailable: true });
  await ex.execute(f.action.actionId, { now: NOW + 2 * MIN, deps: world(f, mail).deps });
  assert.equal(pa.get(f.action.actionId).status, 'executed');
  await ex.reconcile({ now: NOW + 10 * MIN, deps: world(f, mail).deps });
  assert.equal(pa.get(f.action.actionId).status, 'executed');
  assert.equal(mail.calls.send, 1);
  assert.equal(ex.verificationsFor(f.action.actionId)[0].outcome, 'provider_unavailable');
});

// ── 6E IDEMPOTENCY ──────────────────────────────────────────────────────────

test('16/17. a double approval, a double click and two concurrent workers all send ONCE', async () => {
  const f = makeChase();
  let release;
  const gate = new Promise((r) => { release = r; });
  const mail = fakeMail({ sendGate: gate });
  const w = world(f, mail);
  assert.equal(approve(f.action).ok, true);
  assert.equal(approve(f.action).already, true, 'approving twice is the same decision');
  const runs = [
    ex.execute(f.action.actionId, { now: NOW + 2 * MIN, deps: w.deps }),
    ex.execute(f.action.actionId, { now: NOW + 2 * MIN, deps: w.deps }),
    ex.reconcile({ now: NOW + 2 * MIN, deps: w.deps }),
  ];
  await new Promise((r) => setTimeout(r, 30));
  release();
  await Promise.all(runs);
  assert.equal(mail.calls.create, 1);
  assert.equal(mail.calls.send, 1);
  assert.equal(ex.attemptsFor(f.action.actionId).length, 1);
  // The database refuses a second attempt for the same approved version, even from another process.
  assert.throws(() => db.run(`INSERT INTO action_attempts (attempt_id, action_id, attempt, execution_key, boot_id, started_at)
    VALUES (?, ?, 2, ?, 'another-process', ?)`, [`${f.action.actionId}#2`, f.action.actionId, `exec:${f.action.actionId}:${f.action.payloadHash}`, iso(NOW)]), /UNIQUE/);
});

test('18/30/31. restart: an interrupted claim is recovered FROM THE LEDGER — verified if it went, never resent', async () => {
  // Simulate another process that claimed, wrote the handle, asked to send, then died.
  const f = makeChase();
  approve(f.action);
  const mail = fakeMail();
  const imid = '<crashed@nurtur.tech>';
  pa.transition(f.action.actionId, 'executing', { now: NOW + 2 * MIN, allowedFrom: ['approved'] });
  db.run(`INSERT INTO action_attempts (attempt_id, action_id, attempt, execution_key, boot_id, started_at, draft_id, internet_message_id, draft_created_at, send_requested_at)
          VALUES (?, ?, 1, ?, 'dead-process', ?, 'draft-x', ?, ?, ?)`,
  [`${f.action.actionId}#1`, f.action.actionId, `exec:${f.action.actionId}:${f.action.payloadHash}`, iso(NOW + 2 * MIN), imid, iso(NOW + 2 * MIN), iso(NOW + 2 * MIN)]);
  mail.sentItems.push({ id: 'sent-x', internetMessageId: imid, subject: f.action.draft.subject, to: [PERSON.email], cc: [], bcc: [],
    from: 'nickw@nurtur.tech', sentAt: iso(NOW + 2 * MIN), bodyText: f.action.draft.body });
  const r = await ex.reconcile({ now: NOW + 10 * MIN, deps: world(f, mail).deps });
  assert.deepEqual(r.recovered.map((x) => x.as), ['uncertain']);
  assert.equal(pa.get(f.action.actionId).status, 'verified');
  assert.equal(mail.calls.send, 0, 'recovery verified; it did not send');

  // Interrupted BEFORE the send was requested: provably unsent → failed, retry-safe, not resent.
  const g = makeChase();
  approve(g.action);
  pa.transition(g.action.actionId, 'executing', { now: NOW + 2 * MIN, allowedFrom: ['approved'] });
  db.run(`INSERT INTO action_attempts (attempt_id, action_id, attempt, execution_key, boot_id, started_at)
          VALUES (?, ?, 1, ?, 'dead-process', ?)`, [`${g.action.actionId}#1`, g.action.actionId, `exec:${g.action.actionId}:${g.action.payloadHash}`, iso(NOW + 2 * MIN)]);
  await ex.reconcile({ now: NOW + 10 * MIN, deps: world(g, mail).deps });
  assert.equal(pa.get(g.action.actionId).status, 'failed');
  assert.equal(pa.get(g.action.actionId).retrySafe, true);
  assert.equal(mail.calls.send, 0);

  // 32. A verified action never executes again, however often it is reconciled.
  for (let i = 0; i < 3; i += 1) await ex.reconcile({ now: NOW + (20 + i) * MIN, deps: world(f, mail).deps });
  assert.equal(mail.calls.send, 0);
  assert.throws(() => db.run(`UPDATE prepared_actions SET status = 'approved' WHERE action_id = ?`, [f.action.actionId]), /terminal/);
});

test('20. repeated reconciliation is idempotent', async () => {
  const f = makeChase();
  approve(f.action);
  const mail = fakeMail();
  const w = world(f, mail);
  await ex.reconcile({ now: NOW + 2 * MIN, deps: w.deps });
  const snap = () => JSON.stringify({ a: pa.get(f.action.actionId).status, att: ex.attemptsFor(f.action.actionId).length,
    v: ex.verificationsFor(f.action.actionId).length, sends: mail.calls.send });
  const first = snap();
  for (let i = 0; i < 4; i += 1) await ex.reconcile({ now: NOW + (5 + i * 3) * MIN, deps: w.deps });
  assert.equal(snap(), first);
});

// ── AUDIT ───────────────────────────────────────────────────────────────────

test('33/34/35. every transition is retained; the event log carries references, never the address, subject or body; the ledger is append-only', async () => {
  const f = makeChase();
  approve(f.action);
  const mail = fakeMail();
  await ex.execute(f.action.actionId, { now: NOW + 2 * MIN, deps: world(f, mail).deps });
  const events = db.all(`SELECT type, payload FROM event_log WHERE subject_id = ? ORDER BY seq`, [f.action.actionId]);
  assert.deepEqual(events.map((e) => e.type), ['action.approved', 'action.execution.started', 'action.executed', 'action.verified']);
  for (const e of events) {
    assert.doesNotMatch(e.payload, /chris\.middleton@|@nurtur/i, 'no address');
    assert.ok(!e.payload.includes(f.action.draft.subject), 'no subject');
    assert.ok(!e.payload.includes('Could you let me know'), 'no body');
  }
  // The ledger refuses deletes and edits to finished records.
  const [att] = ex.attemptsFor(f.action.actionId);
  assert.throws(() => db.run('DELETE FROM action_attempts WHERE attempt_id = ?', [att.attemptId]), /append\/audit only/);
  assert.throws(() => db.run('UPDATE action_attempts SET send_outcome = ? WHERE attempt_id = ?', ['rejected', att.attemptId]), /immutable/);
  assert.throws(() => db.run('DELETE FROM action_verifications'), /append-only/);
  assert.throws(() => db.run('UPDATE action_verifications SET outcome = ?', ['not_found']), /append-only/);
});

// ── ATTENTION ───────────────────────────────────────────────────────────────

test('36/37. the executor cannot push: no notification door in its source, none reached; failures surface on the desk board', async () => {
  for (const f of ['services/action-executor.js', 'services/action-mail.js', 'services/action-registry.js', 'services/prepared-actions.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(src, /require\(['"][./]*(webpush|ambient-push|attention|nudges|teams|email-sender)['"]\)/, f);
    assert.doesNotMatch(src, /sendToAll|syncFactNudge/, f);
  }
  assert.doesNotMatch(realDoors.join(','), /webpush|email-sender|teams|graphWrite|sendMail/, 'no real outbound door was reached anywhere in this file');
  // Uncertainty and failure surface in State of Play — the desk board — not as a push.
  const sop = require('./state-of-play');
  const issues = sop.assess({ ...sop.snapshot(), governed: ex.status({ now: NOW + 30 * MIN }) });
  assert.ok(issues.some((i) => i.severity === 'critical' && /could not be confirmed/.test(i.title) && i.view === 'actions'));
  assert.ok(issues.some((i) => /did not send/.test(i.title)));
});

// ── REGRESSION ──────────────────────────────────────────────────────────────

test('39/40. every evaluator stays shadow; meeting-prep and the evaluators are untouched by the executor', () => {
  assert.equal(require('./commitment-risk').mode(), 'shadow');
  assert.equal(require('./source-blindness').mode(), 'shadow');
  const mi = require('./meeting-intelligence');
  if (typeof mi.mode === 'function') assert.equal(mi.mode(), 'shadow');
  for (const f of ['services/commitment-risk.js', 'services/meeting-intelligence.js', 'services/source-blindness.js', 'services/meeting-prep.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(src, /require\(['"][./]*(services\/)?(action-executor|action-mail)['"]\)/, `${f} must not reach the executor`);
  }
  // Preparing never calls a provider.
  const src = fs.readFileSync(path.join(__dirname, 'prepared-actions.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"][./]*(action-executor|action-mail)['"]\)/);
});

// ── migration ───────────────────────────────────────────────────────────────

test('the Build 6 migration rebuilds a Build 5 table, carries every row with a payload hash, and replaces the Build 5 triggers', () => {
  const Database = require('better-sqlite3');
  const old = new Database(path.join(tmp, 'b5.db'));
  old.exec(`CREATE TABLE prepared_actions (action_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, finding_id TEXT NOT NULL,
    commitment_id TEXT NOT NULL, action_type TEXT NOT NULL, target_json TEXT NOT NULL, reason TEXT NOT NULL, evidence_json TEXT NOT NULL,
    draft_json TEXT NOT NULL, authority_class TEXT NOT NULL CHECK (authority_class = 'A4'),
    approval_required INTEGER NOT NULL DEFAULT 1 CHECK (approval_required = 1),
    status TEXT NOT NULL CHECK (status IN ('prepared', 'approved', 'rejected', 'expired', 'cancelled', 'executed')),
    created_at TEXT NOT NULL, expires_at TEXT, decided_at TEXT, decision_note TEXT, history_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TRIGGER prepared_actions_never_executed_b5 BEFORE UPDATE OF status ON prepared_actions WHEN NEW.status = 'executed'
    BEGIN SELECT RAISE(ABORT, 'Build 5'); END;`);
  old.prepare(`INSERT INTO prepared_actions VALUES ('pa1', 'k1', 'f', 'c', 'draft_chase_email', ?, 'r', ?, ?, 'A4', 1, 'approved', 'n', NULL, 'n', NULL, '[]', 'n')`)
    .run(JSON.stringify(PERSON), JSON.stringify({ commitment: { source: { ref: 'waiting-on:x' } } }), JSON.stringify({ to: [{ email: PERSON.email }], subject: 's', body: 'b' }));
  const r = require('../db/migrate-build6-actions').migrate(old, { log: () => {} });
  assert.deepEqual(r, { rebuilt: true, rows: 1 });
  const row = old.prepare('SELECT * FROM prepared_actions').get();
  assert.equal(row.action_id, 'pa1');
  assert.equal(row.subject_ref, 'waiting-on:x');
  assert.equal(row.payload_hash, registry.payloadHash({ actionType: 'draft_chase_email', version: 1, commitmentId: 'c', target: PERSON, draft: { to: [{ email: PERSON.email }], subject: 's', body: 'b' } }));
  const triggers = old.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'prepared_actions'`).all().map((t) => t.name);
  assert.ok(!triggers.includes('prepared_actions_never_executed_b5'), 'the Build 5 trigger is gone');
  assert.ok(triggers.includes('prepared_actions_b6_execute_gate'));
  // A Build 5 approval (no bound hash, a non-executable type) can never execute.
  assert.throws(() => old.prepare(`UPDATE prepared_actions SET status = 'executing' WHERE action_id = 'pa1'`).run(), /only an approved action whose payload|not an executable/);
  // Idempotent.
  assert.deepEqual(require('../db/migrate-build6-actions').migrate(old, { log: () => {} }), { rebuilt: false, rows: 0 });
  old.close();
});

// ── the route ───────────────────────────────────────────────────────────────

test('the HTTP route: a machine client cannot approve or edit; Nick approving sends once and answers with the verified status', async () => {
  // ⚠ THE ROUTE READS THE WALL CLOCK (approve judges expiry against now), so
  // this one test is anchored to it. Built at the fixed NOW it was a date bomb:
  // the action expires 72h after creation, and the suite went red at 09:00 on
  // 6 Oct 2026 with nothing changed.
  const REAL = Date.now();
  const f = makeChase({ createdAt: REAL - MIN });
  const mail = fakeMail({ clockMs: REAL + 2 * MIN });
  const w = world(f, mail);
  // Point the executor's DEFAULT deps at the fake for this route test.
  const executorModule = require('./action-executor');
  const realExecute = executorModule.execute;
  executorModule.execute = (id, opts = {}) => realExecute(id, { ...opts, now: REAL + 2 * MIN, deps: w.deps });
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (req.headers['x-neuro-api-token']) req.apiClient = 'n8n'; next(); });
  app.use('/api/prepared-actions', require('../routes/prepared-actions'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api/prepared-actions`;
  const post = (p, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    const shown = (await (await fetch(`${base}/${f.action.actionId}`)).json()).action;
    assert.equal(shown.payloadHash, f.action.payloadHash);
    assert.equal(shown.executes, true);
    const machine = await post(`/${f.action.actionId}/approve`, { payloadHash: shown.payloadHash }, { 'x-neuro-api-token': 't' });
    assert.equal(machine.status, 403);
    assert.equal((await post(`/${f.action.actionId}/edit`, { payloadHash: shown.payloadHash, body: 'x' }, { 'x-neuro-api-token': 't' })).status, 403);
    assert.equal(pa.get(f.action.actionId).status, 'prepared');
    // Build 7: Nick's path is challenge → approval code, with sending switched on.
    require('./feature-flags').setEnabled('governed_execution', true);
    const challenge = async () => (await (await post(`/${f.action.actionId}/approval-challenge`, {})).json()).challengeId;
    const [c1, c2] = [await challenge(), await challenge()];
    const [a, b] = await Promise.all([
      post(`/${f.action.actionId}/approve`, { payloadHash: shown.payloadHash, challengeId: c1, approvalCode: CODE }),
      post(`/${f.action.actionId}/approve`, { payloadHash: shown.payloadHash, challengeId: c2, approvalCode: CODE }),
    ]);
    const bodies = [await a.json(), await b.json()];
    assert.ok(bodies.every((x) => x.ok), JSON.stringify(bodies));
    assert.equal(pa.get(f.action.actionId).status, 'verified');
    assert.equal(mail.calls.send, 1, 'two approve requests, one send');
    const detail = await (await fetch(`${base}/${f.action.actionId}`)).json();
    assert.equal(detail.attempts.length, 1);
    assert.equal(detail.verifications[0].outcome, 'verified');
    const st = await (await fetch(`${base}/status`)).json();
    assert.equal(st.ok, true);
    assert.deepEqual(st.executableTypes, ['chase_commitment', 'reply_email', 'chase_agenda', 'send_weekly_risk_report', 'create_calendar_event', 'reschedule_calendar_event', 'cancel_calendar_event']);
  } finally {
    server.close();
    executorModule.execute = realExecute;
  }
});
