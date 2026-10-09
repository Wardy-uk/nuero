'use strict';

/**
 * Build 7 — action convergence and human approval.
 *
 *   run: node --test backend/services/build7-convergence.test.js
 *
 * One chase path (the Chase button now prepares a governed chase_commitment),
 * the legacy sender retired, one active chase per commitment, and approval that
 * needs a human-origin proof no NEURO credential can produce.
 *
 * ⚠ Real outbound doors are stubbed to THROW (web push, email-sender, Teams,
 * Graph writes), so a flow that reaches one fails the suite instead of sending.
 * The governed executor runs against a FAKE mailbox, as in Build 6.
 *
 * Numbers in test names are the Build 7 brief's test list.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b7-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'b7.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
for (const k of ['GOVERNED_EXECUTION_ENABLED', 'COMMITMENT_RISK_MODE', 'MEETING_INTELLIGENCE_MODE', 'SOURCE_BLIND_MODE']) delete process.env[k];

const realDoors = [];
function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
const boom = (what) => async () => { realDoors.push(what); throw new Error(`${what} reached from a Build 7 flow`); };
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
const proofs = require('./approval-proof');
const flags = require('./feature-flags');
const waitingOn = require('./waiting-on');

const CODE = 'correct horse battery';
const T0 = Date.now();
const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();

test.before(async () => {
  await db.init();
  assert.equal(proofs.setCode(CODE).ok, true);
});

// ── fixtures ─────────────────────────────────────────────────────────────────

const PERSON = { personId: 'person:chris-middleton', displayName: 'Chris Middleton', email: 'chris.middleton@nurtur.tech', method: 'exact-name' };

function person(p = PERSON) {
  db.run(`INSERT OR IGNORE INTO wm_people (person_id, display_name, aliases_json, provenance_kind, first_observed_at, last_observed_at, evidence_json, updated_at)
          VALUES (?, ?, '[]', 'fact', ?, ?, '[]', ?)`, [p.personId, p.displayName, iso(T0), iso(T0), iso(T0)]);
  db.run(`INSERT OR IGNORE INTO wm_person_identities (kind, value, person_id, method, evidence_event_id, observed_at)
          VALUES ('email', ?, ?, 'vault-declared', 'e', ?)`, [p.email.toLowerCase(), p.personId, iso(T0)]);
}

let n = 0;
/** A REAL waiting-on item and the world-model commitment that mirrors it. */
function owed({ text, method = 'exact-name', status = 'open', promisor = PERSON } = {}) {
  n += 1;
  const what = text || `Chris to send the rota ${n}`;
  waitingOn.record({ person: 'Chris', text: what, sourcePath: `Meetings/2026/09/Ops ${n}.md`, sourceDate: '2026-09-28' });
  const item = waitingOn.list({ status: 'all' }).find((i) => i.text === what);
  assert.ok(item, 'positive control: the waiting-on item exists');
  const commitmentId = `commitment:waiting:t${n}`;
  db.run(`INSERT INTO wm_commitments (commitment_id, description, direction, promisor_person_id, promisor_raw, promisor_method,
            beneficiary_kind, status, source_kind, source_ref, source_date, provenance_kind, observed_at, received_at, evidence_json, created_at, updated_at)
          VALUES (?, ?, 'to-nick', ?, 'Chris', ?, 'person', ?, 'meeting-waiting-on', ?, '2026-09-28', 'fact', ?, ?, '[]', ?, ?)`,
  [commitmentId, what, method ? promisor.personId : null, method, status, `waiting-on:${item.key}`, iso(T0), iso(T0), iso(T0), iso(T0)]);
  return { key: item.key, commitmentId, ref: `waiting-on:${item.key}`, description: what };
}

/** A fake Microsoft mailbox with Drafts and Sent Items (Build 6's shape). */
function fakeMail(opts = {}) {
  const drafts = new Map();
  const sentItems = [];
  const calls = { create: 0, send: 0, find: 0 };
  const moveToSent = (id) => {
    const d = drafts.get(id);
    sentItems.push({ id: `sent-${id}`, internetMessageId: d.imid, subject: opts.sentSubject || d.subject, to: d.to.map((x) => x.email.toLowerCase()),
      cc: [], bcc: [], from: 'nickw@nurtur.tech', sentAt: iso(Date.now()), bodyText: d.body });
    drafts.delete(id);
  };
  const api = {
    createDraft: async ({ to, subject, body }) => {
      calls.create += 1;
      const id = `draft-${calls.create}`;
      drafts.set(id, { to, subject, body, imid: `<b7.${calls.create}.${Math.random().toString(36).slice(2)}@nurtur.tech>` });
      return { ok: true, id, internetMessageId: drafts.get(id).imid };
    },
    sendDraft: async (id) => {
      calls.send += 1;
      if (opts.sendGate) await opts.sendGate;
      if ((opts.send || 'accept') === 'accept') { moveToSent(id); return { outcome: 'accepted', status: 202 }; }
      return { outcome: 'uncertain', status: null, category: 'timeout' };
    },
    findSent: async (imid) => { calls.find += 1; return { ok: true, messages: sentItems.filter((m) => m.internetMessageId === imid) }; },
    draftState: async (id) => (drafts.has(id) ? 'draft' : 'gone'),
    deleteDraft: async (id) => drafts.delete(id),
    sentToSince: async () => ({ count: 0 }),
    signedInAddress: async () => 'nickw@nurtur.tech',
  };
  return { api, calls, sentItems };
}

/** The world at execution time — open, unmoved, same person. */
function world(fx, mail, over = {}) {
  const chased = [];
  return {
    chased,
    deps: {
      mail: mail.api,
      enabled: () => true,
      commitment: () => ({ commitmentId: fx.commitmentId, description: fx.description, direction: 'to-nick', status: 'open',
        promisor: { personId: PERSON.personId, method: 'exact-name' }, source: { ref: fx.ref, date: '2026-09-28' } }),
      progress: () => ({ state: 'no_evidence', reasons: [] }),
      counterparty: () => ({ personId: PERSON.personId, displayName: PERSON.displayName, emails: [PERSON.email], method: 'exact-name' }),
      waiting: () => ({ status: 'open', askedAt: null, snoozedUntil: null }),
      deferred: () => false,
      markChased: (key) => chased.push(key),
      ...over,
    },
  };
}

/** Button deps that do not depend on progress/deferral reads, for service-level tests. */
const BUTTON = { progress: () => ({ state: 'no_evidence', reasons: [] }), deferred: () => false };

const challengeFor = (a, now = Date.now()) => proofs.issue({ actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, now });
function approveWithProof(a, { now = Date.now(), code = CODE, sending = () => true } = {}) {
  const ch = challengeFor(a, now);
  assert.equal(ch.ok, true, ch.error);
  return pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, challengeId: ch.challengeId, approvalCode: code, now, sending });
}

// ── an HTTP app with NEURO's auth split: PIN, or the API token ───────────────

async function app() {
  const express = require('express');
  const a = express();
  a.use(express.json());
  a.use('/api', (req, res, next) => {
    if (req.headers['x-neuro-api-token'] === 'tok') { req.apiClient = 'n8n'; return next(); }
    if (req.headers['x-neuro-pin'] === 'pin') return next();
    return res.status(401).json({ error: 'Authentication required' });
  });
  a.use('/api/waiting-on', require('../routes/waiting-on'));
  a.use('/api/prepared-actions', require('../routes/prepared-actions'));
  a.use('/api/actions', require('../routes/actions'));
  const server = http.createServer(a);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, p, body, headers = { 'x-neuro-pin': 'pin' }) => {
    const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, body: json };
  };
  return { server, call };
}

test.before(() => person());

// ── LEGACY MIGRATION ─────────────────────────────────────────────────────────

test('1/2. the old Chase button creates a Build 6 prepared action and sends nothing', async () => {
  const fx = owed();
  const { server, call } = await app();
  try {
    const before = db.get(`SELECT COUNT(*) n FROM saim_actions WHERE type = 'chase_commitment'`).n;
    const r = await call('POST', `/waiting-on/${encodeURIComponent(fx.key)}/chase`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.sent, false);
    const a = pa.get(r.body.actionId);
    assert.equal(a.actionType, 'chase_commitment');
    assert.equal(a.status, 'prepared');
    assert.equal(a.origin, 'chase-button');
    assert.equal(a.commitmentId, fx.commitmentId);
    assert.equal(a.subjectRef, fx.ref);
    assert.equal(a.target.email, PERSON.email, 'the address came from the world model, through the default dependencies');
    assert.equal(a.draft.to[0].email, PERSON.email);
    assert.equal(registry.payloadHash({ actionType: a.actionType, version: 1, commitmentId: a.commitmentId, target: a.target, draft: a.draft }), a.payloadHash);
    assert.equal(db.get(`SELECT COUNT(*) n FROM saim_actions WHERE type = 'chase_commitment'`).n, before, 'nothing went into the old queue');
    assert.equal(db.get('SELECT COUNT(*) n FROM action_attempts WHERE action_id = ?', [a.actionId]).n, 0, 'no attempt — preparing sends nothing');
    assert.deepEqual(realDoors, []);
  } finally { server.close(); }
});

test('3. the legacy sender cannot send: executeAction refuses a complete old chase, and its source reaches no sender', async () => {
  const se = require('./suggestion-engine');
  const r = await se.executeAction({ id: 9001, type: 'chase_commitment', payload: { waitingKey: 'chris::x', person: 'Chris', to: { email: 'c@nurtur.tech', status: 'resolved', source: 'manual' }, body: 'hi' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LEGACY_CHASE_RETIRED');
  assert.deepEqual(realDoors, [], 'no sender was reached');
  const src = fs.readFileSync(path.join(__dirname, 'suggestion-engine.js'), 'utf8');
  const start = src.indexOf("case 'chase_commitment': {");
  const end = src.indexOf("case 'schedule_focus_block': {", start);
  assert.ok(start > 0 && end > start, 'positive control: the case is found');
  const body = src.slice(start, end);
  assert.doesNotMatch(body, /sendMail|sendDm|email-sender|teams|graphWrite|resolveName|markChased/);
  assert.match(body, /LEGACY_CHASE_RETIRED/);
  // No flag can turn it back on.
  assert.doesNotMatch(body, /isEnabled|process\.env/);
});

test('4. no endpoint reaches the legacy sender: old approve answers 410, the retargeting doors 410, a pending old chase is superseded at boot', async () => {
  const { server, call } = await app();
  try {
    const id = db.run(`INSERT INTO saim_actions (type, payload, confidence, reason, status) VALUES ('chase_commitment', ?, 0.8, 'old', 'pending')`,
      [JSON.stringify({ waitingKey: 'chris::y', person: 'Chris', to: { email: 'c@nurtur.tech' }, body: 'hi' })]).lastInsertRowid;
    const r = await call('POST', `/actions/${id}/approve`);
    assert.equal(r.status, 410);
    const batch = await call('POST', '/actions/batch', { ids: [id], verb: 'approve' });
    assert.equal(batch.body.succeeded.length, 0);
    assert.equal(batch.body.failed[0].status, 410);
    assert.equal(db.getSaimAction(id).status, 'pending', 'refused before anything ran');
    assert.equal((await call('POST', `/waiting-on/chase/${id}/recipient`, { email: 'x@y.z' })).status, 410);
    assert.equal((await call('POST', `/waiting-on/chase/${id}/channel`, { channel: 'teams' })).status, 410);
  } finally { server.close(); }
  // The boot migration over the real connection.
  const Database = require('better-sqlite3');
  const raw = new Database(process.env.NEURO_DB_PATH);
  try {
    require('../db/migrate-build7-actions').migrate(raw, { log: () => {} });
  } finally { raw.close(); }
  const pending = db.all(`SELECT status FROM saim_actions WHERE type = 'chase_commitment' AND status = 'pending'`);
  assert.equal(pending.length, 0, 'no legacy chase is left approvable');
  assert.deepEqual(realDoors, []);
});

test('5/30. legacy history: the old queue\'s sent chases are recorded legacy_unverified, never as verified, with no ledger invented', async () => {
  const sent = db.run(`INSERT INTO saim_actions (type, payload, confidence, reason, status, created_at, resolved_at)
                       VALUES ('chase_commitment', ?, 0.8, 'old', 'executed', '2026-08-15 15:45:53', '2026-08-15 15:49:39')`,
  [JSON.stringify({ waitingKey: 'naomi::clear tickets', person: 'Naomi', to: { email: 'nickw@nurtur.tech', source: 'manual' }, channel: 'teams', body: 'secret words' })]).lastInsertRowid;
  const Database = require('better-sqlite3');
  const raw = new Database(process.env.NEURO_DB_PATH);
  let first; let again;
  try {
    first = require('../db/migrate-build7-actions').importLegacy(raw, { log: () => {} });
    again = require('../db/migrate-build7-actions').importLegacy(raw, { log: () => {} });
  } finally { raw.close(); }
  assert.ok(first >= 1);
  assert.equal(again, 0, 'idempotent');
  const h = pa.legacyHistory().find((x) => x.legacyRef === `saim_actions:${sent}`);
  assert.ok(h, 'positive control: the legacy chase is visible');
  assert.equal(h.status, 'legacy_unverified');
  assert.equal(h.provenance, 'old_actions_queue');
  assert.equal(h.actionType, 'legacy_chase');
  assert.equal(h.verified, false);
  assert.equal(h.target.source, 'manual');
  assert.match(h.note, /NOT verified/);
  assert.match(h.note, /Teams was requested/);
  assert.doesNotMatch(JSON.stringify(h), /secret words/, 'the body is not copied into the history');
  assert.equal(db.get(`SELECT COUNT(*) n FROM action_attempts WHERE action_id LIKE 'saim_actions:%'`).n, 0);
  assert.equal(db.get(`SELECT COUNT(*) n FROM prepared_actions WHERE action_id LIKE 'saim_actions:%'`).n, 0, 'not dressed up as a governed action');
  assert.throws(() => db.run('DELETE FROM action_legacy_history'), /kept for audit/);
  assert.throws(() => db.run(`INSERT INTO action_legacy_history (legacy_ref, action_type, status, provenance, imported_at, note)
                              VALUES ('x', 'legacy_chase', 'verified', 'old_actions_queue', 'now', 'n')`), /CHECK/);
  // The reconciler never touches it.
  const mail = fakeMail();
  await ex.reconcile({ deps: world({ commitmentId: 'c', description: 'd', ref: 'r' }, mail).deps });
  assert.equal(pa.legacyHistory().find((x) => x.legacyRef === `saim_actions:${sent}`).status, 'legacy_unverified');
});

// ── CONVERGENCE ──────────────────────────────────────────────────────────────

test('6/8. one commitment, one active chase episode — pressing twice shows the same one, and the database refuses a second', () => {
  const fx = owed();
  const a = pa.prepareFromWaitingOn(fx.key, { deps: BUTTON });
  assert.equal(a.ok, true, a.error);
  const b = pa.prepareFromWaitingOn(fx.key, { deps: BUTTON });
  assert.equal(b.ok, true);
  assert.equal(b.already, true);
  assert.equal(b.action.actionId, a.action.actionId);
  assert.equal(db.get('SELECT COUNT(*) n FROM prepared_actions WHERE commitment_id = ?', [fx.commitmentId]).n, 1);
  // The index — a caller that forgot to check is still refused.
  const r = db.get('SELECT * FROM prepared_actions WHERE action_id = ?', [a.action.actionId]);
  assert.throws(() => db.run(`INSERT INTO prepared_actions (action_id, idempotency_key, finding_id, commitment_id, subject_ref, action_type, version,
      target_json, reason, evidence_json, draft_json, payload_hash, authority_class, approval_required, status, created_at, history_json, updated_at)
      VALUES ('pa_dup', 'dup', 'f', ?, ?, 'chase_commitment', 1, ?, 'r', '{}', ?, 'h', 'A4', 1, 'prepared', ?, '[]', ?)`,
  [r.commitment_id, r.subject_ref, r.target_json, r.draft_json, iso(T0), iso(T0)]), /UNIQUE/);
});

test('7. the risk path and the button converge on one table and one contract, and each blocks the other', () => {
  const fx = owed();
  const finding = { findingId: `risk:${fx.commitmentId}`, status: 'active', level: 'high', confidence: 0.9, commitmentId: fx.commitmentId, episode: 1, why: 'due', summary: 's', triggers: [] };
  db.run(`INSERT INTO commitment_risk_findings (finding_id, commitment_id, episode, status, level, triggers_json, summary, why, evidence_json, unavailable_json, checked_json, confidence, novelty, first_created_at, updated_at)
          VALUES (?, ?, 1, 'active', 'high', '[]', 's', 'w', '{}', '[]', '{}', 0.9, 'new', ?, ?)`, [finding.findingId, fx.commitmentId, iso(T0), iso(T0)]);
  const riskDeps = {
    findings: () => [finding],
    progress: () => ({ state: 'no_evidence', reasons: [], coverage: { sentMail: 'ok' } }),
    snoozedUntil: () => null, deferred: () => false,
  };
  const r = pa.prepareFromRisk({ deps: riskDeps });
  assert.equal(r.prepared, 1, JSON.stringify(r.declined));
  const risk = pa.forCommitment(fx.commitmentId)[0];
  assert.equal(risk.origin, 'risk');
  // The button finds the risk one rather than making a second.
  const b = pa.prepareFromWaitingOn(fx.key, { deps: BUTTON });
  assert.equal(b.already, true);
  assert.equal(b.action.actionId, risk.actionId);
  // Same contract: identical draft shape and payload-hash function.
  const fx2 = owed();
  const btn = pa.prepareFromWaitingOn(fx2.key, { deps: BUTTON }).action;
  assert.deepEqual(Object.keys(btn.draft).sort(), Object.keys(risk.draft).sort());
  assert.equal(btn.authorityClass, risk.authorityClass);
  // And a live button chase stops the risk path preparing another.
  const f2 = { ...finding, findingId: `risk:${fx2.commitmentId}`, commitmentId: fx2.commitmentId };
  const r2 = pa.prepareFromRisk({ deps: { ...riskDeps, findings: () => [f2] } });
  assert.equal(r2.prepared, 0);
  assert.match(r2.declined[0].why, /already prepared/);
});

test('9. a recently verified chase blocks another, through the real executor — each rule on its own', async () => {
  // (a) The VERIFIED rule alone: the chase is not recorded on the waiting-on
  // item (markChased is a no-op), so only the governed ledger can block it.
  const fx = owed();
  const a = pa.prepareFromWaitingOn(fx.key, { deps: BUTTON }).action;
  assert.equal(approveWithProof(a).ok, true);
  const mail = fakeMail();
  const x = await ex.execute(a.actionId, { deps: world(fx, mail, { markChased: () => {} }).deps });
  assert.equal(x.status, 'verified', x.detail);
  assert.equal(waitingOn.list({ status: 'all' }).find((i) => i.key === fx.key).askedAt, null, 'positive control: asked_at was not set');
  const again = pa.prepareFromWaitingOn(fx.key, { deps: BUTTON });
  assert.equal(again.ok, false);
  assert.match(again.error, /chased on .*confirmed in Sent Items/);
  // (b) The ASKED-AT rule alone: no governed chase, but the item was asked about.
  const fx2 = owed();
  waitingOn.markChased(fx2.key, { now: Date.now() - 2 * 86400000 });
  const b = pa.prepareFromWaitingOn(fx2.key, { deps: BUTTON });
  assert.equal(b.ok, false);
  assert.match(b.error, /chased 2 day\(s\) ago/);
  assert.equal(mail.calls.send, 1);
});

test('10. an edit makes a new version of the SAME episode, never a parallel chase', () => {
  const fx = owed();
  const a = pa.prepareFromWaitingOn(fx.key, { deps: BUTTON }).action;
  const e = pa.edit(a.actionId, { payloadHash: a.payloadHash, body: `${a.draft.body}\nP.S. thanks.`, editor: 'nick' });
  assert.equal(e.ok, true, e.error);
  assert.equal(e.action.version, 2);
  assert.equal(e.action.origin, 'chase-button');
  assert.equal(pa.get(a.actionId).status, 'superseded');
  const live = db.all(`SELECT action_id FROM prepared_actions WHERE commitment_id = ? AND status = 'prepared'`, [fx.commitmentId]);
  assert.deepEqual(live.map((x) => x.action_id), [e.action.actionId]);
});

test('the tone rule the old chase carried survives in the governed draft: it asks, gives the out, never accuses', () => {
  const d = pa.draftFor('chase_commitment', { description: 'Heidi to send the training matrix', source: { date: '2026-08-01' } },
    { displayName: 'Heidi Power', email: 'h@nurtur.tech' });
  assert.match(d.body, /^Hi Heidi,/);
  assert.match(d.body, /where it's got to/);
  assert.match(d.body, /No rush/);
  assert.doesNotMatch(d.body, /you (still )?(haven't|have not|failed|promised)|chasing you|overdue|as agreed/i);
});

test('the button refuses what the executor would cancel, and says why', () => {
  const unresolved = owed({ method: null });
  assert.match(pa.prepareFromWaitingOn(unresolved.key, { deps: BUTTON }).error, /cannot tell who/);
  const firstName = owed({ method: 'unique-first-name' });
  assert.match(pa.prepareFromWaitingOn(firstName.key, { deps: BUTTON }).error, /unique-first-name/);
  const done = owed();
  assert.match(pa.prepareFromWaitingOn(done.key, { deps: { ...BUTTON, progress: () => ({ state: 'likely_fulfilled', reasons: ['a later note'] }) } }).error, /may already be done/);
  const snoozed = owed();
  waitingOn.snooze(snoozed.key, new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10));
  assert.match(pa.prepareFromWaitingOn(snoozed.key, { deps: BUTTON }).error, /snoozed/);
  assert.equal(pa.prepareFromWaitingOn('nobody::nothing', { deps: BUTTON }).code, 404);
  assert.deepEqual(realDoors, []);
});

// ── HUMAN APPROVAL ───────────────────────────────────────────────────────────

test('11. the human path — challenge, then the approval code — approves, and records its provenance', () => {
  const fx = owed();
  const a = pa.prepareFromWaitingOn(fx.key, { deps: BUTTON }).action;
  const ch = challengeFor(a);
  const r = pa.approve(a.actionId, { approver: 'nick (approval code)', payloadHash: a.payloadHash, challengeId: ch.challengeId, approvalCode: CODE, sending: () => true });
  assert.equal(r.ok, true, r.error);
  const got = pa.get(a.actionId);
  assert.equal(got.status, 'approved');
  assert.equal(got.approval.mechanism, proofs.MECHANISM);
  assert.equal(got.approval.challengeId, ch.challengeId);
  assert.equal(got.approval.payloadHash, a.payloadHash);
  assert.equal(got.approval.by, 'nick (approval code)');
  assert.ok(got.approval.at);
  assert.equal(proofs.challenge(ch.challengeId).used_outcome, 'accepted');
  // The event carries the mechanism and a challenge REFERENCE, never the code.
  const ev = db.get(`SELECT payload FROM event_log WHERE type = 'action.approved' AND subject_id = ?`, [a.actionId]);
  assert.match(ev.payload, /approval-code\+challenge/);
  assert.doesNotMatch(ev.payload, new RegExp(CODE));
});

test('12/14/15. the API token, a PIN with no code, and forged headers cannot approve', async () => {
  const fx = owed();
  const a = pa.prepareFromWaitingOn(fx.key, { deps: BUTTON }).action;
  flags.setEnabled('governed_execution', true);
  const { server, call } = await app();
  try {
    const tok = { 'x-neuro-api-token': 'tok' };
    assert.equal((await call('POST', `/prepared-actions/${a.actionId}/approval-challenge`, {}, tok)).status, 403);
    assert.equal((await call('POST', `/prepared-actions/${a.actionId}/approve`, { payloadHash: a.payloadHash }, tok)).status, 403);
    assert.equal((await call('POST', `/prepared-actions/${a.actionId}/reject`, {}, tok)).status, 403);
    // The local MCP server holds the PIN: without the code it gets nowhere.
    const pinOnly = await call('POST', `/prepared-actions/${a.actionId}/approve`, { payloadHash: a.payloadHash });
    assert.equal(pinOnly.status, 403, JSON.stringify(pinOnly.body));
    const ch = (await call('POST', `/prepared-actions/${a.actionId}/approval-challenge`, {})).body;
    assert.equal(ch.ok, true, 'a PIN holder may ask for a challenge — it is useless without the code');
    const noCode = await call('POST', `/prepared-actions/${a.actionId}/approve`, { payloadHash: a.payloadHash, challengeId: ch.challengeId });
    assert.equal(noCode.status, 403);
    // Headers a client can set prove nothing.
    const forged = { 'x-neuro-pin': 'pin', 'user-agent': 'Mozilla/5.0 (Macintosh) Safari', 'x-forwarded-for': '127.0.0.1', 'x-human': 'true', 'x-neuro-approval': CODE, 'tailscale-user-login': 'nickw@nurtur.tech' };
    const ch2 = (await call('POST', `/prepared-actions/${a.actionId}/approval-challenge`, {})).body;
    const f = await call('POST', `/prepared-actions/${a.actionId}/approve`, { payloadHash: a.payloadHash, challengeId: ch2.challengeId }, forged);
    assert.equal(f.status, 403);
    assert.equal(pa.get(a.actionId).status, 'prepared');
    assert.equal(db.get('SELECT COUNT(*) n FROM action_attempts WHERE action_id = ?', [a.actionId]).n, 0);
  } finally { server.close(); flags.setEnabled('governed_execution', false); }
});

test('the database refuses an approval with no accepted challenge, whatever a caller writes', () => {
  const fx = owed();
  const a = pa.prepareFromWaitingOn(fx.key, { deps: BUTTON }).action;
  const ch = challengeFor(a); // issued but never accepted
  assert.throws(() => db.run(`UPDATE prepared_actions SET status = 'approved', approved_by = 'x', approved_payload_hash = payload_hash,
      approval_mechanism = 'approval-code+challenge', approval_challenge_id = ? WHERE action_id = ?`, [ch.challengeId, a.actionId]), /human-approval proof/);
  assert.throws(() => db.run(`UPDATE prepared_actions SET status = 'approved', approved_by = 'x', approved_payload_hash = payload_hash WHERE action_id = ?`, [a.actionId]), /human-approval proof/);
  assert.equal(pa.get(a.actionId).status, 'prepared');
});

test('16/17/18. a challenge expires, binds to one action/version/hash, and is single-use; wrong codes lock approval', () => {
  const fx = owed();
  const a = pa.prepareFromWaitingOn(fx.key, { deps: BUTTON }).action;
  const s = () => true;
  // 16. expired
  const old = challengeFor(a, Date.now() - 6 * MIN);
  assert.match(pa.approve(a.actionId, { approver: 'n', payloadHash: a.payloadHash, challengeId: old.challengeId, approvalCode: CODE, sending: s }).error, /expired/);
  // 17. bound to the action: a challenge for B does not approve A
  const fxB = owed();
  const b = pa.prepareFromWaitingOn(fxB.key, { deps: BUTTON }).action;
  const forB = challengeFor(b);
  assert.match(pa.approve(a.actionId, { approver: 'n', payloadHash: a.payloadHash, challengeId: forB.challengeId, approvalCode: CODE, sending: s }).error, /different action/);
  // 17. bound to the version: a v1 challenge does not approve v2
  const v1ch = challengeFor(a);
  const v2 = pa.edit(a.actionId, { payloadHash: a.payloadHash, subject: 'Quick one: the rota' }).action;
  assert.match(pa.approve(v2.actionId, { approver: 'n', payloadHash: v2.payloadHash, challengeId: v1ch.challengeId, approvalCode: CODE, sending: s }).error, /different action/);
  // 18. single-use: an accepted challenge cannot approve again, nor can a burned wrong one
  const ok = challengeFor(v2);
  assert.equal(pa.approve(v2.actionId, { approver: 'n', payloadHash: v2.payloadHash, challengeId: ok.challengeId, approvalCode: CODE, sending: s }).ok, true);
  const replay = proofs.consume({ challengeId: ok.challengeId, approvalCode: CODE, actionId: v2.actionId, version: v2.version, payloadHash: v2.payloadHash });
  assert.equal(replay.ok, false);
  assert.match(replay.error, /already been used/);
  assert.throws(() => db.run(`UPDATE approval_challenges SET used_at = NULL WHERE challenge_id = ?`, [ok.challengeId]), /spent approval challenge/);
  // Lockout: five wrong codes in a window lock approval, persisted.
  const c = owed();
  const ca = pa.prepareFromWaitingOn(c.key, { deps: BUTTON }).action;
  for (let i = 0; i < proofs.MAX_FAILURES; i += 1) {
    const w = challengeFor(ca);
    assert.equal(w.ok, true);
    assert.match(pa.approve(ca.actionId, { approver: 'n', payloadHash: ca.payloadHash, challengeId: w.challengeId, approvalCode: `wrong-${i}`, sending: s }).error, /Wrong approval code/);
  }
  assert.equal(proofs.lockStatus().locked, true);
  assert.equal(challengeFor(ca).ok, false, 'no challenge while locked');
  db.setState('approval_code_failures', '');
  assert.equal(pa.get(ca.actionId).status, 'prepared');
});

test('13. the remote MCP gateway offers no approve, challenge or reject on either queue; preparing a chase stays available', async () => {
  const policy = await import(pathToFileURL(path.join(__dirname, '..', '..', 'mcp-server', 'remote', 'api-policy.js')).href);
  for (const id of ['post_prepared_actions_by_id_approve', 'post_prepared_actions_by_id_approval_challenge', 'post_prepared_actions_by_id_reject',
    'post_prepared_actions_by_id_edit', 'post_actions_by_id_approve', 'post_actions_batch']) {
    assert.ok(policy.interactive[id], `${id} must be interactive-only on the gateway`);
    assert.equal(policy.classify({ id, method: 'POST', route: '/x', domain: 'x', query: [] }), 'admin');
  }
  assert.equal(policy.interactive.post_waiting_on_by_key_chase, undefined, 'preparing is A1 and stays callable');
  // The local MCP tool refuses anything not internal, and fails closed.
  const local = fs.readFileSync(path.join(__dirname, '..', '..', 'mcp-server', 'index.js'), 'utf8');
  const tool = local.slice(local.indexOf("server.tool('approve_action'"), local.indexOf("server.tool('approve_action'") + 1500);
  assert.match(tool, /\['write', 'navigate'\]\.includes\(action\.presentation\.kind\)/);
  assert.match(tool, /if \(!action\) return/);
  assert.doesNotMatch(local, /prepared-actions\/\$\{[^}]+\}\/approve/, 'the local MCP has no route to a governed approval');
});

test('outbound legacy approvals refuse the API token', async () => {
  const { server, call } = await app();
  try {
    const id = db.run(`INSERT INTO saim_actions (type, payload, confidence, reason, status) VALUES ('reply_email', ?, 0.8, 'r', 'pending')`,
      [JSON.stringify({ emailId: 'AAA', body: 'hi', subject: 'Re: x' })]).lastInsertRowid;
    const r = await call('POST', `/actions/${id}/approve`, undefined, { 'x-neuro-api-token': 'tok' });
    assert.equal(r.status, 403);
    assert.equal(db.getSaimAction(id).status, 'pending');
    assert.deepEqual(realDoors, []);
  } finally { server.close(); }
});

// ── SETTINGS ─────────────────────────────────────────────────────────────────

test('19/20. with sending off, a chase is still prepared and editable, but cannot be approved or executed', async () => {
  db.setState('feature_flag:governed_execution', '');
  assert.equal(flags.isEnabled('governed_execution'), false);
  const fx = owed();
  const a = pa.prepareFromWaitingOn(fx.key, { deps: BUTTON });
  assert.equal(a.ok, true, 'preparation works with sending off');
  const ch = challengeFor(a.action);
  const r = pa.approve(a.action.actionId, { approver: 'n', payloadHash: a.action.payloadHash, challengeId: ch.challengeId, approvalCode: CODE });
  assert.equal(r.ok, false);
  assert.match(r.error, /switched off/);
  assert.equal(proofs.challenge(ch.challengeId).used_at, null, 'refused before the code was asked for — the challenge is not burned');
  const { server, call } = await app();
  try {
    assert.equal((await call('POST', `/prepared-actions/${a.action.actionId}/approval-challenge`, {})).status, 409);
  } finally { server.close(); }
  // Approved earlier, switch turned off since: the executor holds it.
  approveWithProof(a.action);
  const mail = fakeMail();
  const x = await ex.execute(a.action.actionId, { deps: world(fx, mail, { enabled: () => false }).deps });
  assert.equal(x.code, 'switched-off');
  assert.equal(mail.calls.create + mail.calls.send, 0);
});

test('21/22. an explicit stored choice is preserved; with no choice and no env, sending defaults OFF', () => {
  const flag = flags.FLAGS.find((f) => f.key === 'governed_execution');
  assert.equal(flag.default, false);
  db.setState('feature_flag:governed_execution', '');
  assert.equal(flags.isEnabled('governed_execution'), false, 'uninitialised = off');
  db.setState('feature_flag:governed_execution', 'true');
  assert.equal(flags.isEnabled('governed_execution'), true, 'his explicit ON survives the new default');
  db.setState('feature_flag:governed_execution', 'false');
  assert.equal(flags.isEnabled('governed_execution'), false);
  process.env.GOVERNED_EXECUTION_ENABLED = 'true';
  assert.equal(flags.isEnabled('governed_execution'), true, 'the environment still wins');
  delete process.env.GOVERNED_EXECUTION_ENABLED;
  db.setState('feature_flag:governed_execution', '');
});

// ── EXECUTION + VERIFICATION ─────────────────────────────────────────────────

test('23/24/28. a Chase-button action approved over HTTP executes ONCE through the Build 6 executor and verifies in Sent Items', async () => {
  const fx = owed();
  const mail = fakeMail();
  const w = world(fx, mail);
  const realExecute = ex.execute;
  ex.execute = (id, opts = {}) => realExecute(id, { ...opts, deps: w.deps });
  flags.setEnabled('governed_execution', true);
  const { server, call } = await app();
  try {
    const prep = await call('POST', `/waiting-on/${encodeURIComponent(fx.key)}/chase`, {});
    const id = prep.body.actionId;
    const shown = (await call('GET', `/prepared-actions/${id}`)).body.action;
    const ch = (await call('POST', `/prepared-actions/${id}/approval-challenge`, {})).body;
    const r = await call('POST', `/prepared-actions/${id}/approve`, { payloadHash: shown.payloadHash, challengeId: ch.challengeId, approvalCode: CODE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const a = pa.get(id);
    assert.equal(a.origin, 'chase-button');
    assert.equal(a.status, 'verified');
    assert.equal(mail.calls.send, 1);
    const att = ex.attemptsFor(id);
    assert.equal(att.length, 1);
    assert.ok(att[0].internetMessageId);
    assert.equal(ex.verificationsFor(id).at(-1).outcome, 'verified');
    assert.deepEqual(w.chased, [fx.key], 'the chase is recorded on the waiting-on item');
    // Sending a chase does not complete the commitment.
    assert.equal(db.get('SELECT status FROM wm_commitments WHERE commitment_id = ?', [fx.commitmentId]).status, 'open');
    assert.equal(waitingOn.list({ status: 'all' }).find((i) => i.key === fx.key).status, 'open');
    // 26. Executing again and reconciling (a restart) sends nothing new FOR
    // THIS ACTION. (The reconcile also runs other approved actions left by
    // earlier tests in this scratch DB — so count by this action's message id.)
    const imid = att[0].internetMessageId;
    await realExecute(id, { deps: w.deps });
    await ex.reconcile({ deps: w.deps });
    assert.equal(ex.attemptsFor(id).length, 1);
    assert.equal(mail.sentItems.filter((m) => m.internetMessageId === imid).length, 1, 'this chase is in Sent Items exactly once');
    assert.equal(pa.get(id).status, 'verified');
    const listed = (await call('GET', '/prepared-actions')).body;
    assert.ok(listed.buckets.history.includes(id));
    assert.equal(listed.approvalCode.set, true);
    assert.equal(listed.sending.enabled, true);
  } finally {
    server.close();
    ex.execute = realExecute;
    flags.setEnabled('governed_execution', false);
  }
});

test('25. two workers racing one approved action make exactly one attempt', async () => {
  const fx = owed();
  const a = pa.prepareFromWaitingOn(fx.key, { deps: BUTTON }).action;
  assert.equal(approveWithProof(a).ok, true);
  let release;
  const gate = new Promise((r) => { release = r; });
  const mail = fakeMail({ sendGate: gate });
  const w = world(fx, mail);
  const runs = [ex.execute(a.actionId, { deps: w.deps }), ex.execute(a.actionId, { deps: w.deps }), ex.reconcile({ deps: w.deps })];
  setTimeout(release, 20);
  await Promise.all(runs);
  assert.equal(mail.calls.send, 1);
  assert.equal(ex.attemptsFor(a.actionId).length, 1);
});

test('27/29. an uncertain send is only ever verified, never resent; a Sent Items mismatch is left for review', async () => {
  const fx = owed();
  const a = pa.prepareFromWaitingOn(fx.key, { deps: BUTTON }).action;
  approveWithProof(a);
  const mail = fakeMail({ send: 'timeout' });
  const w = world(fx, mail);
  const x = await ex.execute(a.actionId, { deps: w.deps });
  assert.equal(x.status, 'execution_uncertain');
  await ex.reconcile({ deps: w.deps });
  await ex.reconcile({ deps: w.deps });
  assert.equal(mail.calls.send, 1, 'never resent');

  const fx2 = owed();
  const b = pa.prepareFromWaitingOn(fx2.key, { deps: BUTTON }).action;
  approveWithProof(b);
  const off = fakeMail({ sentSubject: 'Something else entirely' });
  const y = await ex.execute(b.actionId, { deps: world(fx2, off).deps });
  assert.equal(y.status, 'execution_uncertain');
  assert.match(pa.get(b.actionId).outcomeDetail, /does not cleanly match|Review it/);
  assert.equal(off.calls.send, 1);
});

// ── SECURITY ─────────────────────────────────────────────────────────────────

test('31/32. an approved payload and its provenance are immutable; every Build 6 and Build 7 guard is installed', () => {
  const fx = owed();
  const a = pa.prepareFromWaitingOn(fx.key, { deps: BUTTON }).action;
  approveWithProof(a);
  assert.throws(() => db.run(`UPDATE prepared_actions SET draft_json = '{}' WHERE action_id = ?`, [a.actionId]), /immutable/);
  assert.throws(() => db.run(`UPDATE prepared_actions SET approval_mechanism = 'forged' WHERE action_id = ?`, [a.actionId]), /immutable/);
  assert.throws(() => db.run(`UPDATE prepared_actions SET approval_challenge_id = 'ch_x' WHERE action_id = ?`, [a.actionId]), /immutable/);
  const triggers = db.all(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).map((r) => r.name);
  for (const t of ['prepared_actions_b6_born_prepared', 'prepared_actions_b6_no_delete', 'prepared_actions_b6_payload_immutable',
    'prepared_actions_b6_approval_immutable', 'prepared_actions_b6_approve_binds', 'prepared_actions_b6_execute_gate',
    'prepared_actions_b6_executable_types', 'prepared_actions_b6_lifecycle', 'prepared_actions_b6_terminal',
    'prepared_actions_b7_approval_needs_proof', 'prepared_actions_b7_provenance_immutable', 'approval_challenges_b7_spent']) {
    assert.ok(triggers.includes(t), `missing trigger ${t}`);
  }
  assert.ok(db.get(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ux_prepared_actions_one_active_chase'`));
});

test('33. no send path exists outside the governed executor', () => {
  const root = path.join(__dirname, '..');
  const files = [...fs.readdirSync(path.join(root, 'services')).map((f) => `services/${f}`), ...fs.readdirSync(path.join(root, 'routes')).map((f) => `routes/${f}`)]
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
  assert.ok(files.length > 50, 'positive control: the scan sees the codebase');
  const draftSend = files.filter((f) => /\bsendDraft\s*\(|createDraft\s*\(/.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepEqual(draftSend.sort(), ['services/action-executor.js', 'services/action-mail.js']);
  // The chase surfaces import no sender of any kind.
  for (const f of ['services/prepared-actions.js', 'routes/prepared-actions.js', 'services/waiting-on.js', 'routes/waiting-on.js', 'services/approval-proof.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(src, /require\(['"][./]*(services\/)?(webpush|email-sender|teams|microsoft|action-mail)['"]\)/, f);
    assert.doesNotMatch(src, /sendToAll|sendMail\(|sendDm\(|graphWrite|executeAction|queueAction/, f);
  }
  // The only caller of the executor's execute() outside it is the prepared-
  // actions route: approve (code) and, since 9 Oct 2026, execute-direct
  // (a one-use intent grant — services/intent-grants.js).
  const callers = files.filter((f) => f !== 'services/action-executor.js' && /executor\(\)\.execute\(|action-executor'\)\.execute\(/.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepEqual(callers, ['routes/prepared-actions.js']);
});

test('34. the event log carries ids and mechanisms — never a body, subject, address or code', () => {
  const rows = db.all(`SELECT type, payload FROM event_log WHERE type LIKE 'action.%'`);
  assert.ok(rows.length > 10, 'positive control: the flows above wrote action events');
  const all = rows.map((r) => r.payload).join('\n');
  assert.doesNotMatch(all, /chris\.middleton@nurtur\.tech|Following up|Hi Chris|No rush/);
  assert.doesNotMatch(all, new RegExp(CODE));
  assert.doesNotMatch(all, /"hash":|"salt":/);
});

// ── REGRESSION ───────────────────────────────────────────────────────────────

test('36/37/38. evaluators stay shadow; meeting-prep parity and the executor/reconciler jobs are still registered', () => {
  assert.equal(require('./commitment-risk').mode(), 'shadow');
  assert.equal(require('./meeting-intelligence').mode ? require('./meeting-intelligence').mode() : 'shadow', 'shadow');
  assert.equal(require('./source-blindness').mode(), 'shadow');
  const sched = fs.readFileSync(path.join(__dirname, 'scheduler.js'), 'utf8');
  for (const job of ["name: 'action-executor'", "name: 'meeting-intelligence'", "name: 'commitment-risk'"]) assert.ok(sched.includes(job), job);
  assert.match(fs.readFileSync(path.join(__dirname, 'meeting-prep.js'), 'utf8'), /meeting_prep_comparisons/);
  assert.deepEqual(registry.executableTypes(), ['chase_commitment', 'reply_email', 'chase_agenda', 'send_weekly_risk_report', 'create_calendar_event', 'reschedule_calendar_event', 'cancel_calendar_event'], 'Build 8: the four outbound email types; Build 11K: the three calendar changes');
});

// ═══ 9 Oct 2026: the Chase button's draft sends on Nick's click ═════════════

test('G7. a Chase-button draft sends on a one-use grant (human_assisted); a risk-prepared chase still needs the code', async () => {
  const grants = require('./intent-grants');
  const mint = (x) => grants.mint({ actionId: x.actionId, version: x.version, payloadHash: x.payloadHash, surface: 'neuro-web', sessionId: 'sess0123456789', caller: {} });
  const fx = owed({ text: 'Send the grant-flow figures' });
  const a = pa.prepareFromWaitingOn(fx.key, { deps: BUTTON }).action;
  assert.equal(a.origin, 'chase-button');
  const g = mint(a);
  assert.equal(g.ok, true, g.error);
  const r = pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, intentGrantId: g.grantId, sending: () => true });
  assert.equal(r.ok, true, r.error);
  const x = await ex.execute(a.actionId, { deps: world(fx, fakeMail()).deps });
  assert.equal(x.status, 'verified', x.detail);
  const row = db.get('SELECT initiated_by, authority_proof FROM prepared_actions WHERE action_id = ?', [a.actionId]);
  assert.equal(row.initiated_by, 'human_assisted');
  assert.equal(row.authority_proof, 'intent_grant');
  // NEURO's own chase (origin risk) cannot take a grant.
  const fx2 = owed({ text: 'Risk-path grant check' });
  const finding = { findingId: `risk:${fx2.commitmentId}`, status: 'active', level: 'high', confidence: 0.9, commitmentId: fx2.commitmentId, episode: 1, why: 'due', summary: 's', triggers: [] };
  db.run(`INSERT INTO commitment_risk_findings (finding_id, commitment_id, episode, status, level, triggers_json, summary, why, evidence_json, unavailable_json, checked_json, confidence, novelty, first_created_at, updated_at)
          VALUES (?, ?, 1, 'active', 'high', '[]', 's', 'w', '{}', '[]', '{}', 0.9, 'new', ?, ?)`, [finding.findingId, fx2.commitmentId, iso(T0), iso(T0)]);
  pa.prepareFromRisk({ deps: { findings: () => [finding], progress: () => ({ state: 'no_evidence', reasons: [], coverage: { sentMail: 'ok' } }), snoozedUntil: () => null, deferred: () => false } });
  const risk = pa.forCommitment(fx2.commitmentId)[0];
  assert.equal(risk.origin, 'risk', 'positive control: a risk-prepared chase exists');
  const rg = mint(risk);
  assert.equal(rg.ok, false);
  assert.equal(rg.reason, 'origin');
});
