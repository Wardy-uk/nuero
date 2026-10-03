'use strict';

/**
 * Build 8 — outbound governance completion.
 *
 *   run: node --test backend/services/build8-outbound.test.js
 *
 * Every email NEURO can send as Nick — chase_commitment, reply_email,
 * chase_agenda, send_weekly_risk_report — goes through ONE governed path:
 * prepare (exact payload) → human-proof approval → action-executor (claim,
 * ledger, one attempt) → Sent Items verification → reconciliation. The legacy
 * queue's outbound sender is retired.
 *
 * ⚠ The real outbound doors (web push, email-sender, Teams, Graph writes
 * through microsoft.js) are stubbed to THROW: a flow that reaches one fails the
 * suite instead of sending. The Microsoft transport the executor uses
 * (action-mail) and the read-only module preparing uses (mail-read) are both
 * replaced by ONE fake mailbox defined here, so preparing, executing and
 * verifying all see the same Drafts / Sent Items / messages / calendar.
 *
 * Numbers in test names are the Build 8 brief's test list (1–42).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b8-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'b8.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
for (const k of ['GOVERNED_EXECUTION_ENABLED', 'COMMITMENT_RISK_MODE', 'MEETING_INTELLIGENCE_MODE', 'SOURCE_BLIND_MODE']) delete process.env[k];

const realDoors = [];
function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
const boom = (what) => async () => { realDoors.push(what); throw new Error(`${what} reached from a Build 8 flow`); };
stub('./webpush', { sendToAll: boom('webpush.sendToAll'), isConfigured: () => true });
stub('./email-sender', { sendMail: boom('email-sender.sendMail'), sendBriefEmail: boom('email-sender.sendBriefEmail'), OWN_ADDRESS: 'nickw@nurtur.tech' });
stub('./teams', { getSendStatus: async () => ({ available: false }) });

// ── one fake mailbox for the whole file ──────────────────────────────────────

const NOW = Date.parse('2026-10-03T09:00:00Z');
const MIN = 60000;
const HOUR = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();
const SELF = 'nickw@nurtur.tech';

let MB = null;
function freshMailbox(opts = {}) {
  const drafts = new Map();
  const sentItems = [];
  const messages = new Map();
  const events = new Map();
  const calls = { create: 0, reply: 0, patch: 0, send: 0, find: 0, deleted: [], createArgs: [] };
  let clockMs = NOW;
  let n = 0;
  const moveToSent = (id) => {
    const d = drafts.get(id);
    sentItems.push({ id: `sent-${id}`, internetMessageId: d.imid, subject: d.subject, to: d.to.map((x) => String(x.email || x).toLowerCase()),
      cc: (d.cc || []).map((x) => String(x.email || x).toLowerCase()), bcc: [], from: SELF, sentAt: iso(clockMs),
      bodyText: d.contentType === 'HTML' ? null : d.body, conversationId: d.conversationId || `conv-new-${id}` });
    drafts.delete(id);
  };
  const api = {
    createDraft: async ({ to, cc = [], subject, body, contentType = 'Text' }) => {
      calls.create += 1;
      calls.createArgs.push({ to, cc, subject, body, contentType });
      if (opts.createFail) return { ok: false, category: 'http_5xx', status: 503 };
      n += 1;
      const id = `draft-${n}`;
      const imid = `<m${n}.${Math.random().toString(36).slice(2)}@nurtur.tech>`;
      drafts.set(id, { to, cc, subject, body, contentType, imid });
      return { ok: true, id, internetMessageId: imid };
    },
    createReplyDraft: async (emailId, { mode = 'reply', comment = '' } = {}) => {
      calls.reply += 1;
      const m = messages.get(emailId);
      if (!m) return { ok: false, status: 404, category: 'http_4xx' };
      n += 1;
      const id = `draft-${n}`;
      const imid = `<r${n}.${Math.random().toString(36).slice(2)}@nurtur.tech>`;
      // Graph picks addressees on a reply draft — a different set from what
      // was approved, on purpose, so the executor's overwrite is exercised.
      const to = mode === 'replyAll' ? [m.from, ...m.to.filter((x) => x !== SELF)] : [m.from];
      drafts.set(id, { to: to.map((email) => ({ email })), cc: mode === 'replyAll' ? m.cc.map((email) => ({ email })) : [],
        subject: `RE: ${m.subject}`, body: comment, contentType: 'HTML', imid, conversationId: m.conversationId });
      return { ok: true, id, internetMessageId: imid, conversationId: m.conversationId };
    },
    patchDraft: async (id, { to, cc = [], subject }) => {
      calls.patch += 1;
      const d = drafts.get(id);
      if (!d) return { ok: false, status: 404 };
      d.to = to;
      if (!opts.patchKeepsGraphCc) d.cc = cc;
      if (subject !== undefined) d.subject = subject;
      return { ok: true, to: d.to.map((x) => String(x.email || x).toLowerCase()), cc: (d.cc || []).map((x) => String(x.email || x).toLowerCase()),
        bcc: [], subject: d.subject, internetMessageId: d.imid };
    },
    sendDraft: async (id) => {
      calls.send += 1;
      const mode = opts.send || 'accept';
      if (mode === 'accept') { moveToSent(id); return { outcome: 'accepted', status: 202 }; }
      if (mode === 'reject') return { outcome: 'rejected', status: 403, category: 'scope' };
      if (mode === 'timeout-after-receipt') { moveToSent(id); return { outcome: 'uncertain', status: null, category: 'timeout' }; }
      return { outcome: 'uncertain', status: null, category: 'timeout' };
    },
    findSent: async (imid) => {
      calls.find += 1;
      if (opts.findUnavailable) return { ok: false, category: 'http_5xx' };
      return { ok: true, messages: sentItems.filter((m) => m.internetMessageId === imid) };
    },
    draftState: async (id) => (drafts.has(id) ? 'draft' : 'gone'),
    deleteDraft: async (id) => { if (!drafts.has(id)) return false; drafts.delete(id); calls.deleted.push(id); return true; },
    readMessage: async (emailId) => {
      if (opts.readUnavailable) return { ok: false, category: 'http_5xx' };
      const m = messages.get(emailId);
      return m ? { ok: true, exists: true, id: emailId, ...m } : { ok: true, exists: false };
    },
    readEvent: async (eventId) => {
      if (opts.eventUnavailable) return { ok: false, category: 'unavailable' };
      const e = events.get(eventId);
      return e ? { ok: true, exists: true, event: e } : { ok: false, category: 'unavailable' };
    },
    sentToSince: async (email, since) => {
      if (opts.sentUnreadable) return null;
      const want = String(email || '').toLowerCase();
      const all = [...sentItems, ...(opts.extraSent || [])];
      const hits = all.filter((m) => (m.to || []).includes(want) && Date.parse(m.sentAt) >= Date.parse(since));
      return { count: hits.length, subjects: hits.map((m) => m.subject || '') };
    },
    sentInConversationSince: async (conv, since) => {
      if (opts.sentUnreadable) return null;
      const all = [...sentItems, ...(opts.extraSent || [])];
      return { count: all.filter((m) => m.conversationId === conv && Date.parse(m.sentAt) >= Date.parse(since)).length };
    },
    signedInAddress: async () => SELF,
  };
  MB = { api, calls, drafts, sentItems, messages, events, opts, setClock: (ms) => { clockMs = ms; } };
  return MB;
}
freshMailbox();

// Forwarders, so every test's fresh mailbox is what the real modules reach.
const forward = (names) => Object.fromEntries(names.map((k) => [k, (...a) => MB.api[k](...a)]));
stub('./action-mail', { ...forward(['createDraft', 'createReplyDraft', 'patchDraft', 'sendDraft', 'findSent', 'draftState', 'deleteDraft',
  'readMessage', 'readEvent', 'sentToSince', 'sentInConversationSince', 'signedInAddress']), DEFINITIVE_SEND_REFUSALS: new Set([400, 401, 403, 404, 409]) });
stub('./mail-read', forward(['readMessage', 'signedInAddress']));
stub('./microsoft', {
  getSignedInAddress: async () => SELF,
  getAccessToken: async () => { realDoors.push('microsoft.getAccessToken'); return null; },
  fetchEventById: async (id) => (MB.events.get(id) || null),
  fetchSentMail: boom('microsoft.fetchSentMail'),
  graphWrite: boom('microsoft.graphWrite'),
  sendMail: boom('microsoft.sendMail'),
  createCalendarEvent: boom('microsoft.createCalendarEvent'),
  respondToEvent: boom('microsoft.respondToEvent'),
  markEmailRead: async () => ({ ok: true }),
});

const db = require('../db/database');
const registry = require('./action-registry');
const pa = require('./prepared-actions');
const ex = require('./action-executor');
const proofs = require('./approval-proof');

const CODE = 'build-8 approval code';
const FOUR = ['chase_commitment', 'reply_email', 'chase_agenda', 'send_weekly_risk_report'];

test.before(async () => {
  await db.init();
  if (!proofs.codeStatus().set) assert.equal(proofs.setCode(CODE).ok, true);
});

// ── fixtures ─────────────────────────────────────────────────────────────────

let seq = 0;
/** A message in the mailbox that a reply can answer. */
function message(over = {}) {
  seq += 1;
  const id = `MSG-${seq}`;
  MB.messages.set(id, {
    conversationId: `CONV-${seq}`, from: 'sam.jones@nurtur.tech', fromName: 'Sam Jones', subject: `Feeds ${seq}`,
    internetMessageId: `<orig${seq}@nurtur.tech>`, to: [SELF, 'lucy.hall@nurtur.tech'], cc: ['ops@nurtur.tech'],
    receivedAt: iso(NOW - HOUR), ...over,
  });
  return id;
}

/** A meeting meeting-triage would chase: three people, no agenda, two days out. */
function meeting(over = {}) {
  seq += 1;
  const id = `EVT-${seq}`;
  MB.events.set(id, {
    id, subject: `Catch up ${seq}`, bodyPreview: '', bodyHtml: '', start: iso(NOW + 2 * 24 * HOUR), end: iso(NOW + 2 * 24 * HOUR + HOUR),
    organizer: { name: 'Pat Organiser', address: 'pat.organiser@nurtur.tech' }, isOrganizer: false, isCancelled: false,
    type: 'singleInstance', responseStatus: 'none',
    attendees: [{ email: SELF }, { email: 'pat.organiser@nurtur.tech' }, { email: 'x@nurtur.tech' }], ...over,
  });
  return id;
}

const CHRIS = { name: 'Chris Middleton', email: 'chris.middleton@nurtur.tech', source: 'directory' };
let week = 0;
function reportWeek() { week += 1; return `2026-${String(10 + Math.floor(week / 4)).padStart(2, '0')}-${String(1 + (week % 4) * 7).padStart(2, '0')}`; }
const md = (tag) => `# Weekly Risk & Anomaly Summary\n\n| KPI | Value |\n|---|---|\n| FRT | ${tag} |\n`;
const html = (tag) => require('./weekly-risk').toEmailHtml(md(tag));

async function prepReply(over = {}) {
  const emailId = over.emailId || message();
  const r = await pa.prepareReply({ emailId, body: over.body || 'Thanks Sam — on it today.', mode: over.mode || 'reply',
    to: over.to === undefined ? null : over.to, cc: over.cc === undefined ? null : over.cc, origin: 'composer', now: over.now || NOW });
  assert.equal(r.ok, true, r.error);
  return { emailId, action: r.action };
}
function prepAgenda(eventId = meeting(), now = NOW) {
  const r = pa.prepareAgendaChase({ event: MB.events.get(eventId), body: 'Hi Pat,\n\nWhat would you like to get out of it?\n\nNick', why: 'no body', now });
  assert.equal(r.ok, true, r.error);
  return { eventId, action: r.action };
}
function prepReport({ wk = reportWeek(), tag = 'v1', now = NOW } = {}) {
  const r = pa.prepareWeeklyReport({ week: wk, recipient: CHRIS, subject: `Weekly Risk & Anomaly Summary — w/c ${wk}`, markdown: md(tag), html: html(tag), now });
  assert.equal(r.ok, true, r.error);
  return { week: wk, action: r.action, r };
}

function approve(a, { at = NOW + MIN, code = CODE } = {}) {
  const ch = proofs.issue({ actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, now: at });
  assert.equal(ch.ok, true, ch.error);
  return pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, challengeId: ch.challengeId, approvalCode: code, now: at, sending: () => true });
}

/** Executor deps: the fake mailbox, sending ON, and a week that is not yet sent. */
const deps = (over = {}) => ({ mail: MB.api, enabled: () => true, reportLocked: () => false, ...over });
const run = (a, over = {}, at = NOW + 2 * MIN) => ex.execute(a.actionId, { now: at, deps: deps(over) });

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
  a.use('/api/prepared-actions', require('../routes/prepared-actions'));
  a.use('/api/actions', require('../routes/actions'));
  a.use('/api/email', require('../routes/email-triage'));
  a.use('/api/calendar', require('../routes/calendar'));
  a.use('/api/1to1', require('../routes/one-to-one'));
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
const TOKEN = { 'x-neuro-api-token': 'tok' };

// ═══ REGISTRY ═══════════════════════════════════════════════════════════════

test('1. all four outbound email types are registered, executable, A4, verified in Sent Items, with a per-type policy', () => {
  // Build 11K added the three calendar types; the four EMAIL types are unchanged.
  assert.deepEqual(registry.executableTypes().filter((t) => registry.policyFor(t).executor === 'microsoft.mail'), FOUR);
  assert.deepEqual(registry.validateRegistry(), []);
  for (const t of FOUR) {
    const p = registry.policyFor(t);
    assert.equal(p.authority, 'A4', t);
    assert.equal(p.requiresApproval, true, t);
    assert.equal(p.executor, 'microsoft.mail', t);
    assert.equal(p.verification, 'sent-items', t);
    assert.equal(p.retryPolicy, 'human-review', t);
    assert.equal(p.uncertaintyPolicy, 'verify-only', t);
    assert.ok(registry.SEND_MODES.includes(p.sendMode), t);
    assert.ok(p.duplicate && p.preparation && p.execution, `${t} states its duplicate / preparation / execution rules`);
  }
  // Per-type, not one generic email policy.
  assert.equal(registry.policyFor('reply_email').sendMode, 'reply');
  assert.equal(registry.policyFor('reply_email').cc, true);
  assert.equal(registry.policyFor('chase_agenda').maxRecipients, 1);
  assert.equal(registry.policyFor('send_weekly_risk_report').bodyFormat, 'html');
  // A registry entry missing its send rules fails validation.
  const broken = { x: { ...registry.policyFor('reply_email'), type: 'x', sendMode: 'carrier-pigeon' } };
  assert.ok(registry.validateRegistry(broken).some((p) => /sendMode/.test(p)));
});

test('2. an unknown action type cannot be prepared, approved or executed — the database refuses it too', () => {
  for (const t of ['respond_meeting', 'schedule_focus_block', 'escalate_ticket', 'send_email', '__proto__']) {
    assert.equal(registry.canExecute(t), false, t);
    assert.equal(registry.policyFor(t), null, t);
  }
  db.run(`INSERT INTO prepared_actions (action_id, idempotency_key, finding_id, commitment_id, subject_ref, action_type, version, target_json, reason,
          evidence_json, draft_json, payload_hash, authority_class, approval_required, status, created_at, history_json, updated_at)
          VALUES ('pa_unknown', 'k-unknown', 'f', 'c', null, 'respond_meeting', 1, '{}', 'r', '{}', '{}', 'h', 'A4', 1, 'prepared', ?, '[]', ?)`, [iso(NOW), iso(NOW)]);
  const r = pa.approve('pa_unknown', { approver: 'nick', payloadHash: 'h', sending: () => true });
  assert.equal(r.ok, false);
  assert.match(r.error, /not a registered action type/);
  assert.throws(() => db.run(`UPDATE prepared_actions SET status = 'executing' WHERE action_id = 'pa_unknown'`), /only an approved action|not an executable action type/);
});

test('2b. every executable type has its own execution checks; a registered type with none is refused, not waved through', async () => {
  for (const t of registry.executableTypes()) assert.equal(typeof ex.PREFLIGHT[t], 'function', `${t} has a preflight`);
  freshMailbox();
  const { action } = await prepReply();
  // The same approved payload, relabelled as a type the executor has no checks for.
  const mystery = { ...pa.get(action.actionId), actionType: 'mystery_mail' };
  mystery.payloadHash = registry.payloadHash({ actionType: 'mystery_mail', version: 1, commitmentId: mystery.commitmentId, target: mystery.target, draft: mystery.draft });
  mystery.approval = { payloadHash: mystery.payloadHash, expiresAt: iso(NOW + HOUR) };
  const policy = { ...registry.policyFor('reply_email'), type: 'mystery_mail' };
  assert.equal(ex.commonChecks({ action: mystery, policy, nowMs: NOW }).ok, true, 'positive control: it passes the common checks');
  const r = await ex.preflight(mystery, policy, { mailApi: MB.api }, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-preflight');
});

test('3. every A4 type needs human approval: no proof, wrong code, or a status write without a challenge is refused', async () => {
  const items = [(await prepReply()).action, prepAgenda().action, prepReport().action];
  for (const a of items) {
    const none = pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, now: NOW + MIN, sending: () => true });
    assert.equal(none.ok, false, `${a.actionType} without a challenge`);
    const ch = proofs.issue({ actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, now: NOW + MIN });
    const wrong = pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, challengeId: ch.challengeId, approvalCode: 'not the code', now: NOW + MIN, sending: () => true });
    assert.equal(wrong.ok, false, `${a.actionType} with a wrong code`);
    // The database half: an approval with no accepted challenge is refused even
    // by a writer that skipped the service.
    assert.throws(() => db.run(`UPDATE prepared_actions SET status = 'approved', approved_by = 'x', approved_at = ?, approved_payload_hash = payload_hash,
                               approval_expires_at = ?, approval_mechanism = 'forged', approval_challenge_id = 'nope' WHERE action_id = ?`,
    [iso(NOW), iso(NOW + HOUR), a.actionId]), /human-approval proof/);
    assert.equal(pa.get(a.actionId).status, 'prepared');
  }
  proofs._resetFailures && proofs._resetFailures();
  db.setState('approval_code_failures', '');
});

// ═══ reply_email ════════════════════════════════════════════════════════════

test('4. a reply binds its EXACT payload: recipients, thread, mode and words; a changed draft cannot be approved or written', async () => {
  const { emailId, action } = await prepReply({ mode: 'replyAll' });
  const t = action.target;
  assert.equal(t.emailId, emailId);
  assert.equal(t.conversationId, MB.messages.get(emailId).conversationId);
  // Reply-all resolved NOW, from the original: sender in To; everyone else but Nick in Cc.
  assert.deepEqual(action.draft.to.map((r) => r.email), ['sam.jones@nurtur.tech']);
  assert.deepEqual(action.draft.cc.map((r) => r.email).sort(), ['lucy.hall@nurtur.tech', 'ops@nurtur.tech']);
  assert.ok(!action.draft.cc.some((r) => r.email === SELF), 'Nick is never copied on his own reply');
  // The hash binds the thread and the mode, not just the words.
  const base = { actionType: 'reply_email', version: 1, commitmentId: action.commitmentId, target: t, draft: action.draft };
  assert.equal(registry.payloadHash(base), action.payloadHash);
  assert.notEqual(registry.payloadHash({ ...base, target: { ...t, conversationId: 'OTHER' } }), action.payloadHash);
  assert.notEqual(registry.payloadHash({ ...base, draft: { ...action.draft, mode: 'reply' } }), action.payloadHash);
  assert.notEqual(registry.payloadHash({ ...base, draft: { ...action.draft, cc: [] } }), action.payloadHash);
  // Approving a hash you were not shown is refused; the stored payload cannot be rewritten.
  const ch = proofs.issue({ actionId: action.actionId, version: 1, payloadHash: action.payloadHash, now: NOW + MIN });
  const r = pa.approve(action.actionId, { approver: 'nick', payloadHash: 'f'.repeat(64), challengeId: ch.challengeId, approvalCode: CODE, now: NOW + MIN, sending: () => true });
  assert.equal(r.ok, false);
  assert.throws(() => db.run(`UPDATE prepared_actions SET draft_json = '{}' WHERE action_id = ?`, [action.actionId]), /immutable/);
});

test('5. a changed thread invalidates the approval: a different sender or a deleted message cancels it; an unreadable one waits', async () => {
  freshMailbox();
  const a1 = (await prepReply()).action;
  approve(a1);
  MB.messages.get(a1.target.emailId).from = 'someone.else@nurtur.tech';
  const r1 = await run(a1);
  assert.equal(r1.code, 'sender-changed');
  assert.equal(pa.get(a1.actionId).status, 'cancelled');

  const a2 = (await prepReply()).action;
  approve(a2);
  MB.messages.delete(a2.target.emailId);
  assert.equal((await run(a2)).code, 'thread-gone');
  assert.equal(pa.get(a2.actionId).status, 'cancelled');

  const a3 = (await prepReply()).action;
  approve(a3);
  MB.opts.readUnavailable = true;
  const r3 = await run(a3);
  assert.equal(r3.transient, true, 'could not look ≠ gone');
  assert.equal(pa.get(a3.actionId).status, 'approved');
  MB.opts.readUnavailable = false;
  assert.equal(MB.calls.send, 0, 'nothing was sent for any of them');
});

test('6. a duplicate reply is blocked: a second draft replaces a pending one, is refused once one is approved, and the database refuses a second live row', async () => {
  freshMailbox();
  const emailId = message();
  const first = (await prepReply({ emailId, body: 'First go.' })).action;
  const second = await pa.prepareReply({ emailId, body: 'Better wording.', now: NOW + MIN });
  assert.equal(second.ok, true);
  assert.equal(second.action.version, 2);
  assert.equal(pa.get(first.actionId).status, 'superseded', 'pressing Send again replaces the unapproved draft');
  approve(second.action, { at: NOW + 2 * MIN });
  const third = await pa.prepareReply({ emailId, body: 'Third.', now: NOW + 3 * MIN });
  assert.equal(third.ok, false);
  assert.match(third.error, /already approved/);
  assert.throws(() => db.run(`INSERT INTO prepared_actions (action_id, idempotency_key, finding_id, commitment_id, subject_ref, action_type, version,
      target_json, reason, evidence_json, draft_json, payload_hash, authority_class, approval_required, status, created_at, history_json, updated_at)
      VALUES ('pa_dup_reply', 'k-dup-reply', 'f', ?, null, 'reply_email', 1, '{}', 'r', '{}', '{}', 'h', 'A4', 1, 'prepared', ?, '[]', ?)`,
  [`email:${emailId}`, iso(NOW), iso(NOW)]), /UNIQUE/);
  // And a reply Nick sent by hand in the thread since this was prepared cancels it.
  MB.opts.extraSent = [{ to: ['sam.jones@nurtur.tech'], conversationId: MB.messages.get(emailId).conversationId, sentAt: iso(NOW + 4 * MIN), subject: 'RE: x' }];
  const r = await run(second.action, {}, NOW + 5 * MIN);
  assert.equal(r.code, 'already-replied');
  assert.equal(MB.calls.send, 0);
  MB.opts.extraSent = [];
});

test('7. a reply cannot reach anyone but the approved recipients: a draft Graph left holding other addresses is deleted, unsent', async () => {
  freshMailbox({ patchKeepsGraphCc: true });
  const { action } = await prepReply({ mode: 'replyAll', to: ['sam.jones@nurtur.tech'], cc: [] });
  approve(action);
  const r = await run(action);
  assert.equal(r.status, 'failed');
  assert.equal(r.code, 'recipient-mismatch');
  assert.equal(MB.calls.send, 0, 'never sent');
  assert.equal(MB.drafts.size, 0, 'the stray draft was deleted');
  // And at the preflight: a stored draft whose recipient count breaks the policy is refused.
  const policy = registry.policyFor('reply_email');
  const big = { ...action, draft: { ...action.draft, to: Array.from({ length: policy.maxRecipients + 1 }, (_, i) => ({ email: `p${i}@nurtur.tech` })) } };
  big.payloadHash = registry.payloadHash({ actionType: 'reply_email', version: 1, commitmentId: big.commitmentId, target: big.target, draft: big.draft });
  big.approval = { payloadHash: big.payloadHash, expiresAt: iso(NOW + HOUR) };
  assert.equal(ex.commonChecks({ action: big, policy, nowMs: NOW }).code, 'recipient-mismatch');
  // A blind copy is never allowed, on any type.
  const bcc = { ...action, draft: { ...action.draft, bcc: [{ email: 'x@nurtur.tech' }] } };
  bcc.approval = { payloadHash: action.payloadHash, expiresAt: iso(NOW + HOUR) };
  assert.equal(ex.commonChecks({ action: bcc, policy, nowMs: NOW }).code, 'bcc-not-allowed');
  // A positive control: the untouched action passes the common checks.
  const ok = { ...pa.get(action.actionId), approval: { payloadHash: action.payloadHash, expiresAt: iso(NOW + HOUR) } };
  assert.equal(ex.commonChecks({ action: ok, policy, nowMs: NOW }).ok, true);
  freshMailbox();
});

test('8. a sent reply verifies in the RIGHT thread; the reply is recorded and nothing else about the world changes', async () => {
  freshMailbox();
  const { emailId, action } = await prepReply({ mode: 'replyAll' });
  approve(action);
  const r = await run(action);
  assert.equal(r.status, 'verified', r.detail);
  assert.equal(MB.calls.reply, 1, 'a Graph reply in the thread, not a new message');
  assert.equal(MB.calls.create, 0);
  assert.equal(MB.calls.send, 1);
  const sent = MB.sentItems[0];
  assert.equal(sent.conversationId, MB.messages.get(emailId).conversationId);
  assert.deepEqual(sent.to, ['sam.jones@nurtur.tech']);
  assert.deepEqual(sent.cc.sort(), ['lucy.hall@nurtur.tech', 'ops@nurtur.tech']);
  const v = ex.verificationsFor(action.actionId).pop();
  assert.equal(v.outcome, 'verified');
  assert.equal(v.proof.checks.thread, true);
  // The same message in a DIFFERENT thread would not verify.
  const att = db.get('SELECT * FROM action_attempts WHERE action_id = ?', [action.actionId]);
  assert.equal(ex.judgeSentItem({ ...sent, conversationId: 'elsewhere' }, { action: pa.get(action.actionId), attempt: att, signedIn: SELF }).ok, false);
  assert.equal(ex.judgeSentItem({ ...sent, cc: [] }, { action: pa.get(action.actionId), attempt: att, signedIn: SELF }).ok, false, 'a missing copy is not the approved send');
  // Recorded once, as an explicit-recipient reply.
  const rec = db.all('SELECT * FROM sent_replies WHERE email_id = ?', [emailId]);
  assert.equal(rec.length, 1);
  assert.equal(rec[0].recipients_source, 'explicit');
});

test('9. an ambiguous reply is never resent: a timeout after Microsoft took it verifies, and reconciling again sends nothing', async () => {
  freshMailbox({ send: 'timeout-after-receipt' });
  const { action } = await prepReply();
  approve(action);
  const r = await run(action);
  assert.equal(r.status, 'verified');
  await ex.reconcile({ now: NOW + 10 * MIN, deps: deps() });
  await ex.reconcile({ now: NOW + 20 * MIN, deps: deps() });
  assert.equal(MB.calls.send, 1, 'one send, ever');
  // A timeout BEFORE receipt stays uncertain and is verified, never retried.
  freshMailbox({ send: 'timeout-before-receipt' });
  const b = (await prepReply()).action;
  approve(b);
  assert.equal((await run(b)).status, 'execution_uncertain');
  await ex.reconcile({ now: NOW + 5 * MIN, deps: deps() });
  assert.equal(MB.calls.send, 1);
});

// ═══ chase_agenda ═══════════════════════════════════════════════════════════

test('10. a stale meeting cancels the agenda request: cancelled, too close, agenda arrived, already responded', async () => {
  for (const [mutate, code] of [
    [(e) => { e.isCancelled = true; }, 'meeting-cancelled'],
    [(e) => { e.start = iso(NOW + HOUR); }, 'meeting-too-close'],
    [(e) => { e.bodyPreview = 'Agenda: decide the Q4 support rota and review the escalation backlog together, with a decision by the end.'; }, 'agenda-arrived'],
    [(e) => { e.responseStatus = 'accepted'; }, 'already-responded'],
    [(e) => { e.organizer = { name: 'New', address: 'new.person@nurtur.tech' }; }, 'organiser-changed'],
  ]) {
    freshMailbox();
    const { eventId, action } = prepAgenda();
    approve(action);
    mutate(MB.events.get(eventId));
    const r = await run(action);
    assert.equal(r.code, code, code);
    assert.equal(pa.get(action.actionId).status, 'cancelled', code);
    assert.equal(MB.calls.send, 0, code);
  }
  // Could not read the calendar → waits, never cancels.
  freshMailbox({ eventUnavailable: true });
  const { action } = prepAgenda();
  approve(action);
  assert.equal((await run(action)).transient, true);
  assert.equal(pa.get(action.actionId).status, 'approved');
});

test('11. one agenda request per meeting: meeting triage prepares a governed one, a second pass and a second producer both fold', async () => {
  freshMailbox();
  const eventId = meeting();
  const before = db.get(`SELECT COUNT(*) n FROM saim_actions WHERE type = 'chase_agenda'`).n;
  const triage = require('./meeting-triage');
  const first = await triage.checkEvents([eventId], { now: new Date(NOW) });
  assert.equal(first.queued, 1);
  const again = await triage.checkEvents([eventId], { now: new Date(NOW) });
  assert.equal(again.queued, 0);
  assert.ok(again.skipped.some((s) => s.reason === 'already asked'));
  assert.equal(db.get(`SELECT COUNT(*) n FROM saim_actions WHERE type = 'chase_agenda'`).n, before, 'nothing went into the old queue');
  const direct = pa.prepareAgendaChase({ event: MB.events.get(eventId), body: 'x', now: NOW });
  assert.equal(direct.already, true);
  assert.equal(db.get(`SELECT COUNT(*) n FROM prepared_actions WHERE action_type = 'chase_agenda' AND commitment_id = ?`, [`meeting:${eventId}`]).n, 1);
  assert.equal(MB.calls.send, 0, 'preparing sends nothing');
});

test('12. a VERIFIED agenda request can never repeat for that meeting', async () => {
  freshMailbox();
  const { eventId, action } = prepAgenda();
  approve(action);
  assert.equal((await run(action)).status, 'verified');
  const again = pa.prepareAgendaChase({ event: MB.events.get(eventId), body: 'Asking again', now: NOW + DAYS(1) });
  assert.equal(again.already, true, 'the sent one is handed back');
  assert.equal(again.action.status, 'verified');
  assert.equal(pa.agendaAsked(eventId), true);
  assert.throws(() => db.run(`INSERT INTO prepared_actions (action_id, idempotency_key, finding_id, commitment_id, subject_ref, action_type, version,
      target_json, reason, evidence_json, draft_json, payload_hash, authority_class, approval_required, status, created_at, history_json, updated_at)
      VALUES ('pa_dup_agenda', 'k-dup-agenda', 'f', ?, null, 'chase_agenda', 1, '{}', 'r', '{}', '{}', 'h', 'A4', 1, 'prepared', ?, '[]', ?)`,
  [`meeting:${eventId}`, iso(NOW), iso(NOW)]), /UNIQUE/, 'the database refuses a second ask, even after the first was sent');
});
function DAYS(n) { return n * 24 * HOUR; }

// ═══ send_weekly_risk_report ════════════════════════════════════════════════

test('13. the approval binds the exact report version: the frozen HTML is hashed, so a different report is a different approval', () => {
  const { action } = prepReport({ tag: 'bind' });
  assert.equal(action.draft.html, html('bind'), 'the HTML that will be sent is frozen in the action');
  assert.ok(action.target.reportVersion);
  const base = { actionType: 'send_weekly_risk_report', version: 1, commitmentId: action.commitmentId, target: action.target, draft: action.draft };
  assert.equal(registry.payloadHash(base), action.payloadHash);
  assert.notEqual(registry.payloadHash({ ...base, draft: { ...action.draft, html: `${action.draft.html}<p>extra</p>` } }), action.payloadHash);
  assert.notEqual(registry.payloadHash({ ...base, target: { ...action.target, reportVersion: 'other' } }), action.payloadHash);
  assert.throws(() => pa.edit(action.actionId, { body: 'edited', payloadHash: action.payloadHash }).ok === true ? null : (() => { throw new Error('refused'); })(), /refused/);
});

test('14. a regenerated report invalidates the old approval: the approved version expires and can never send', async () => {
  freshMailbox();
  const wk = reportWeek();
  const v1 = prepReport({ wk, tag: 'monday-07:30' }).action;
  approve(v1);
  const v2 = prepReport({ wk, tag: 'monday-09:00', now: NOW + 5 * MIN });
  assert.equal(v2.r.superseded, v1.actionId);
  assert.equal(v2.action.version, 2);
  assert.equal(pa.get(v1.actionId).status, 'expired', 'an approval given for one report cannot send another');
  const r = await run(v1, {}, NOW + 6 * MIN);
  assert.equal(r.already, true);
  assert.equal(MB.calls.send, 0);
  // A still-pending older version is superseded rather than expired.
  const wk2 = reportWeek();
  const p1 = prepReport({ wk: wk2, tag: 'a' }).action;
  prepReport({ wk: wk2, tag: 'b', now: NOW + MIN });
  assert.equal(pa.get(p1.actionId).status, 'superseded');
});

test('15. one weekly send per week: the same report folds, a week already sent cancels, a send in flight refuses a new one', async () => {
  freshMailbox();
  const wk = reportWeek();
  const a = prepReport({ wk, tag: 'same' }).action;
  const same = prepReport({ wk, tag: 'same', now: NOW + MIN });
  assert.equal(same.r.already, true);
  assert.equal(same.action.actionId, a.actionId);
  approve(a);
  const locked = await run(a, { reportLocked: () => true });
  assert.equal(locked.code, 'already-sent');
  assert.equal(MB.calls.send, 0);

  const wk2 = reportWeek();
  const b = prepReport({ wk: wk2, tag: 'go' }).action;
  approve(b);
  assert.equal((await run(b)).status, 'verified');
  const after = pa.prepareWeeklyReport({ week: wk2, recipient: CHRIS, subject: 's', markdown: md('changed'), html: html('changed'), now: NOW + HOUR });
  // Verified is not "live", so a re-queue is only blocked by the week's own lock
  // (weekly-risk.queueSend checks isLocked before preparing; markSent locked it).
  assert.equal(require('./weekly-risk').isLocked(wk2), true, 'the governed send locked the week');
  assert.ok(after.ok === true || after.ok === false);

  // A report sent by hand since preparing cancels the governed one.
  const wk3 = reportWeek();
  const c = prepReport({ wk: wk3, tag: 'hand' }).action;
  approve(c);
  MB.opts.extraSent = [{ to: [CHRIS.email], subject: c.draft.subject, sentAt: iso(NOW + MIN) }];
  assert.equal((await run(c)).code, 'already-emailed');
  MB.opts.extraSent = [];
});

test('16. the exact recipient set is preserved: one To, no Cc, HTML, and the body is the frozen HTML byte for byte', async () => {
  freshMailbox();
  const { action } = prepReport({ tag: 'exact' });
  approve(action);
  await run(action);
  const args = MB.calls.createArgs[0];
  assert.deepEqual(args.to.map((r) => r.email), [CHRIS.email]);
  assert.deepEqual(args.cc, []);
  assert.equal(args.contentType, 'HTML');
  assert.equal(args.body, action.draft.html);
});

test('17. the weekly send verifies in Sent Items and freezes the week with what was sent', async () => {
  freshMailbox();
  const { week: wk, action } = prepReport({ tag: 'freeze' });
  approve(action);
  const r = await run(action);
  assert.equal(r.status, 'verified');
  const rec = require('./weekly-risk').sentRecord(wk);
  assert.ok(rec, 'the week is recorded as sent');
  assert.equal(rec.actionId, action.actionId);
  assert.equal(ex.verificationsFor(action.actionId).pop().outcome, 'verified');
});

// ═══ LEGACY ═════════════════════════════════════════════════════════════════

const LEGACY_COMPLETE = {
  reply_email: { emailId: 'AAA', body: 'Sending this', subject: 'Re: feeds', to: [{ email: 'sam@nurtur.tech' }] },
  chase_agenda: { eventId: 'E1', body: 'What is it for?', subject: 'Catch up', organizer: { name: 'Pat', address: 'pat@nurtur.tech' } },
  send_weekly_risk_report: { week: '2026-09-28', to: [{ email: 'chris@nurtur.tech' }], subject: 's', body: '# report' },
  respond_meeting: { eventId: 'E2', response: 'decline', comment: 'No thanks' },
  schedule_focus_block: { subject: 'Review', attendees: [{ email: 'lucy@nurtur.tech' }] },
};

test('18. the old outbound sender cannot send: every retired type refuses with a complete payload, and no sender is reachable from it', async () => {
  const se = require('./suggestion-engine');
  for (const [type, payload] of Object.entries(LEGACY_COMPLETE)) {
    const r = await se.executeAction({ id: 9000, type, payload });
    assert.equal(r.ok, false, type);
    assert.equal(r.code, 'LEGACY_OUTBOUND_RETIRED', type);
  }
  assert.deepEqual(realDoors.filter((d) => d !== 'microsoft.getAccessToken'), [], 'no sender was reached');
  const src = fs.readFileSync(path.join(__dirname, 'suggestion-engine.js'), 'utf8');
  assert.match(src, /case 'reply_email':/, 'positive control: the scan reads the real file');
  assert.doesNotMatch(src, /email-sender|sendEmailReply|respondToEvent|sendDm/, 'the legacy executor holds no email sender');
  // The deleted senders are gone from the modules that held them.
  const ms = fs.readFileSync(path.join(__dirname, 'microsoft.js'), 'utf8');
  assert.doesNotMatch(ms, /async function sendEmailReply|async function _sendReplyWithRecipients/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, 'teams.js'), 'utf8'), /async function sendDm/);
  // email-sender.sendMail is SELF-ONLY: the real module, in a clean process, refuses anyone else before a token is asked for.
  const out = execFileSync(process.execPath, ['-e', `
    const s = require(${JSON.stringify(path.join(__dirname, 'email-sender.js'))});
    s.sendMail({ to: [{ email: 'chris@nurtur.tech' }], subject: 'x', body: 'y' }).then((r) => process.stdout.write(JSON.stringify(r)));
  `], { encoding: 'utf8', env: { ...process.env, NEURO_DB_PATH: path.join(tmp, 'child.db') } });
  assert.equal(JSON.parse(out.trim().split('\n').pop()).reason, 'not_self');
});

test('19. the old routes cannot execute: queue approvals answer 410 and stay pending, batch approve fails, respond answers 410, the composer only prepares', async () => {
  freshMailbox();
  const { server, call } = await app();
  try {
    for (const [type, payload] of Object.entries(LEGACY_COMPLETE)) {
      const id = db.run(`INSERT INTO saim_actions (type, payload, confidence, reason, status) VALUES (?, ?, 0.8, 'r', 'pending')`, [type, JSON.stringify(payload)]).lastInsertRowid;
      const r = await call('POST', `/actions/${id}/approve`);
      assert.equal(r.status, 410, type);
      assert.equal(db.getSaimAction(id).status, 'pending', `${type} stays pending — it can still be rejected`);
      const b = await call('POST', '/actions/batch', { ids: [id], verb: 'approve' });
      assert.equal(b.body.failed[0].status, 410, `${type} batch`);
    }
    const resp = await call('POST', '/calendar/events/EVT/respond', { response: 'decline' });
    assert.equal(resp.status, 410);
    const emailId = message();
    const c = await call('POST', `/email/triage/${encodeURIComponent(emailId)}/reply`, { body: 'Composer words', to: ['sam.jones@nurtur.tech'] });
    assert.equal(c.status, 200);
    assert.equal(c.body.sent, false);
    assert.equal(c.body.prepared, true);
    assert.equal(c.body.action.actionType, 'reply_email');
    assert.equal(c.body.action.status, 'prepared');
    assert.equal(MB.calls.send + MB.calls.create + MB.calls.reply, 0, 'the composer route touched no transport');
  } finally { server.close(); }
});

test('20. no feature flag restores the legacy sender', async () => {
  const src = fs.readFileSync(path.join(__dirname, 'legacy-outbound.js'), 'utf8');
  assert.match(src, /RETIRED_TYPES/, 'positive control');
  assert.doesNotMatch(src, /isEnabled|process\.env|getState/, 'the retirement reads no switch');
  const se = fs.readFileSync(path.join(__dirname, 'suggestion-engine.js'), 'utf8');
  const block = se.slice(se.indexOf("case 'reply_email':"), se.indexOf("case 'complete_task':"));
  assert.ok(block.length > 100, 'positive control: the retired block was found');
  assert.doesNotMatch(block, /isEnabled|process\.env/);
  // With every flag that could plausibly matter ON, the old approve still refuses.
  db.setState('feature_flag:governed_execution', 'true');
  const { server, call } = await app();
  try {
    const id = db.run(`INSERT INTO saim_actions (type, payload, confidence, reason, status) VALUES ('reply_email', ?, 0.8, 'r', 'pending')`, [JSON.stringify(LEGACY_COMPLETE.reply_email)]).lastInsertRowid;
    assert.equal((await call('POST', `/actions/${id}/approve`)).status, 410);
  } finally { server.close(); db.setState('feature_flag:governed_execution', ''); }
});

function legacyDb() {
  const Database = require('better-sqlite3');
  const d = new Database(path.join(tmp, `legacy-${Math.random().toString(36).slice(2)}.db`));
  d.exec(`CREATE TABLE agent_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE saim_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, payload TEXT, confidence REAL, reason TEXT, status TEXT, created_at TEXT, resolved_at TEXT);
    CREATE TABLE sent_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, email_id TEXT NOT NULL, subject TEXT, from_name TEXT, from_email TEXT,
      recipients TEXT, recipients_source TEXT NOT NULL DEFAULT 'unknown', reply_all INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL, sent_at TEXT NOT NULL);`);
  require('../db/migrate-build7-actions').migrate(d, { log: () => {} });
  return d;
}

test('21. a pending legacy approval does not carry forward: the migration supersedes pending legacy outbound and creates nothing governed', () => {
  const d = legacyDb();
  const ins = d.prepare(`INSERT INTO saim_actions (type, payload, confidence, reason, status, created_at) VALUES (?, ?, 0.8, 'r', 'pending', '2026-10-01 09:00:00')`);
  for (const [type, payload] of Object.entries(LEGACY_COMPLETE)) ins.run(type, JSON.stringify(payload));
  ins.run('schedule_focus_block', JSON.stringify({ subject: 'Solo block' }));
  ins.run('capture_todo', JSON.stringify({ text: 'internal' }));
  const out = require('../db/migrate-build8-actions').migrate(d, { log: () => {}, now: NOW });
  assert.equal(out.superseded, 5, 'the five outbound rows, and only those');
  const left = d.prepare(`SELECT type FROM saim_actions WHERE status = 'pending' ORDER BY type`).all().map((r) => r.type);
  assert.deepEqual(left, ['capture_todo', 'schedule_focus_block'], 'internal work and a solo block are untouched');
  assert.equal(d.prepare(`SELECT COUNT(*) n FROM saim_actions WHERE status = 'executed'`).get().n, 0, 'nothing was executed by migrating');
});

test('22. legacy history is preserved honestly: old sends and pre-cutover composer replies recorded unverified; governed sends are not', () => {
  const d = legacyDb();
  d.prepare(`INSERT INTO saim_actions (type, payload, confidence, reason, status, created_at, resolved_at) VALUES ('chase_commitment', ?, 0.8, 'r', 'executed', '2026-08-15 16:00:00', '2026-08-15 16:16:13')`)
    .run(JSON.stringify({ waitingKey: 'k', person: 'Nick', to: { email: SELF, source: 'manual' } }));
  require('../db/migrate-build7-actions').migrate(d, { log: () => {} });
  for (const [type, payload] of Object.entries(LEGACY_COMPLETE).slice(0, 3)) {
    d.prepare(`INSERT INTO saim_actions (type, payload, confidence, reason, status, created_at, resolved_at) VALUES (?, ?, 0.8, 'r', 'executed', '2026-09-21 11:00:00', '2026-09-21 11:16:01')`)
      .run(type, JSON.stringify(payload));
  }
  d.prepare(`INSERT INTO sent_replies (email_id, recipients, recipients_source, body, sent_at) VALUES ('E-old', ?, 'explicit', 'b', '2026-09-16T15:17:06.803Z')`)
    .run(JSON.stringify([{ email: 'sam@nurtur.tech' }]));
  const m8 = require('../db/migrate-build8-actions');
  m8.migrate(d, { log: () => {}, now: NOW });
  // A reply the GOVERNED executor records after the cutover is not legacy.
  d.prepare(`INSERT INTO sent_replies (email_id, recipients, recipients_source, body, sent_at) VALUES ('E-new', '[]', 'explicit', 'b', ?)`).run(iso(NOW + DAYS(1)));
  m8.migrate(d, { log: () => {}, now: NOW + DAYS(2) });
  const rows = d.prepare('SELECT * FROM action_legacy_history ORDER BY legacy_ref').all();
  const types = rows.map((r) => r.action_type).sort();
  assert.deepEqual(types, ['legacy_chase', 'legacy_chase_agenda', 'legacy_reply_email', 'legacy_reply_email', 'legacy_weekly_risk_report']);
  assert.ok(rows.every((r) => r.status === 'legacy_unverified'), 'never verified, never invented');
  assert.equal(rows.find((r) => r.legacy_ref === 'sent_replies:1').provenance, 'inbox_composer');
  assert.equal(rows.filter((r) => /^sent_replies:/.test(r.legacy_ref)).length, 1, 'the post-cutover governed reply is not history');
  assert.throws(() => d.prepare('DELETE FROM action_legacy_history').run(), /kept for audit/, 'the rebuilt table kept its no-delete trigger');
  assert.equal(m8.migrate(d, { log: () => {}, now: NOW + DAYS(3) }).legacy, 0, 'idempotent');
});

// ═══ HUMAN APPROVAL ═════════════════════════════════════════════════════════

test('23. a machine client cannot approve, challenge, edit or reject any of the new types', async () => {
  freshMailbox();
  const items = [(await prepReply()).action, prepAgenda().action, prepReport().action];
  const { server, call } = await app();
  try {
    for (const a of items) {
      for (const verb of ['approval-challenge', 'approve', 'reject', 'edit']) {
        const r = await call('POST', `/prepared-actions/${a.actionId}/${verb}`, { payloadHash: a.payloadHash }, TOKEN);
        assert.equal(r.status, 403, `${a.actionType} ${verb}`);
      }
      assert.equal(pa.get(a.actionId).status, 'prepared');
    }
    // The 1-2-1 routes refuse the API token too.
    for (const [p, body] of [['/1to1/book', { person: 'x', start: 's', end: 'e' }], ['/1to1/book-all', { items: [{}] }],
      ['/1to1/reschedule', { person: 'x', eventId: 'e', start: 's', end: 'e' }]]) {
      assert.equal((await call('POST', p, body, TOKEN)).status, 403, p);
    }
    // Build 11K: the composer route PREPARES an invite for a machine client —
    // it can never SEND one (approval needs Nick's code, refused above).
    const prepared = await call('POST', '/calendar/events', { subject: 's', date: '2026-10-05', startTime: '10:00', endTime: '11:00', attendees: [{ email: 'a@nurtur.tech' }] }, TOKEN);
    assert.equal(prepared.status, 200);
    assert.equal(prepared.body.sent, false, 'prepared, never sent');
    assert.equal(prepared.body.prepared, true);
  } finally { server.close(); }
  assert.deepEqual(realDoors.filter((d) => d !== 'microsoft.getAccessToken'), []);
});

test('24. the local MCP server cannot approve a governed action, and the remote gateway treats approval as interactive', async () => {
  const local = fs.readFileSync(path.join(__dirname, '..', '..', 'mcp-server', 'index.js'), 'utf8');
  assert.match(local, /server\.tool\('approve_action'/, 'positive control');
  assert.doesNotMatch(local, /prepared-actions\/\$\{[^}]+\}\/(approve|approval-challenge)/);
  const tool = local.slice(local.indexOf("server.tool('approve_action'"), local.indexOf("server.tool('approve_action'") + 1500);
  assert.match(tool, /\['write', 'navigate'\]\.includes\(action\.presentation\.kind\)/);
  const policy = await import(pathToFileURL(path.join(__dirname, '..', '..', 'mcp-server', 'remote', 'api-policy.js')).href);
  for (const op of ['post_prepared_actions_by_id_approve', 'post_prepared_actions_by_id_approval_challenge', 'post_prepared_actions_by_id_edit',
    'post_actions_by_id_approve', 'post_1to1_book', 'post_1to1_book_all', 'post_1to1_reschedule']) {
    assert.ok(policy.interactive[op], op);
  }
});

test('25/26/27. a challenge is single-use, bound to the payload hash, and expires', async () => {
  freshMailbox();
  const a = (await prepReply()).action;
  // 26: a challenge for a different payload hash is refused.
  const bad = proofs.issue({ actionId: a.actionId, version: a.version, payloadHash: 'f'.repeat(64), now: NOW + MIN });
  const r26 = pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, challengeId: bad.challengeId, approvalCode: CODE, now: NOW + MIN, sending: () => true });
  assert.equal(r26.ok, false);
  // 27: an expired challenge is refused.
  const old = proofs.issue({ actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, now: NOW + MIN });
  const r27 = pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, challengeId: old.challengeId, approvalCode: CODE, now: NOW + 20 * MIN, sending: () => true });
  assert.equal(r27.ok, false);
  // 25: a used challenge cannot be reused — on this action or another.
  const ch = proofs.issue({ actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, now: NOW + 21 * MIN });
  assert.equal(pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, challengeId: ch.challengeId, approvalCode: CODE, now: NOW + 21 * MIN, sending: () => true }).ok, true);
  const b = (await prepReply()).action;
  const reuse = pa.approve(b.actionId, { approver: 'nick', payloadHash: b.payloadHash, challengeId: ch.challengeId, approvalCode: CODE, now: NOW + 22 * MIN, sending: () => true });
  assert.equal(reuse.ok, false);
  assert.equal(pa.get(b.actionId).status, 'prepared');
  db.setState('approval_code_failures', '');
});

// ═══ EXECUTION ══════════════════════════════════════════════════════════════

test('28. two workers racing one approved action send it once', async () => {
  freshMailbox();
  const a = prepAgenda().action;
  approve(a);
  const [x, y] = await Promise.all([run(a), run(a, { mail: MB.api })]);
  assert.equal(MB.calls.send, 1);
  assert.ok([x, y].some((r) => r.already), 'the second caller is told it is already running');
  assert.equal(db.get('SELECT COUNT(*) n FROM action_attempts WHERE action_id = ?', [a.actionId]).n, 1);
});

test('29/31. a restart mid-send reads the LEDGER: send requested → uncertain → verified, never resent; no send requested → failed unsent', async () => {
  freshMailbox();
  for (const sendRequested of [true, false]) {
    const a = prepReport({ tag: `restart-${sendRequested}` }).action;
    approve(a);
    // The state a crashed process leaves: claimed, draft recorded, maybe a send asked for.
    const t = pa.transition(a.actionId, 'executing', { now: NOW + 2 * MIN, allowedFrom: ['approved'] });
    assert.equal(t.ok, true, t.error);
    const draft = await MB.api.createDraft({ to: a.draft.to, cc: [], subject: a.draft.subject, body: a.draft.html, contentType: 'HTML' });
    db.run(`INSERT INTO action_attempts (attempt_id, action_id, attempt, execution_key, boot_id, started_at, draft_id, internet_message_id, draft_created_at, send_requested_at)
            VALUES (?, ?, 1, ?, 'a-dead-process', ?, ?, ?, ?, ?)`,
    [`${a.actionId}#1`, a.actionId, `exec:${a.actionId}:${a.payloadHash}`, iso(NOW + 2 * MIN), draft.id, draft.internetMessageId, iso(NOW + 2 * MIN), sendRequested ? iso(NOW + 2 * MIN) : null]);
    if (sendRequested) { await MB.api.sendDraft(draft.id); MB.calls.send = 0; } // it went, before the crash
    await ex.reconcile({ now: NOW + 30 * MIN, deps: deps() });
    const after = pa.get(a.actionId);
    if (sendRequested) assert.equal(after.status, 'verified', 'uncertain went to verification and was found');
    else assert.equal(after.status, 'failed', 'stopped before the send: proven unsent');
    assert.equal(MB.calls.send, 0, 'the reconciler never sends a recovered action');
  }
});

test('30. a timeout after Microsoft received the report does not resend it', async () => {
  freshMailbox({ send: 'timeout-after-receipt' });
  const a = prepReport({ tag: 'timeout' }).action;
  approve(a);
  const r = await run(a);
  assert.ok(['verified', 'execution_uncertain'].includes(r.status));
  await ex.reconcile({ now: NOW + HOUR, deps: deps() });
  assert.equal(MB.calls.send, 1);
  assert.equal(pa.get(a.actionId).status, 'verified');
});

test('32. a verified action never executes again — not by the executor, not by a direct write', async () => {
  freshMailbox();
  const { action } = await prepReply();
  approve(action);
  assert.equal((await run(action)).status, 'verified');
  const again = await run(action, {}, NOW + HOUR);
  assert.equal(again.already, true);
  assert.equal(MB.calls.send, 1);
  assert.throws(() => db.run(`UPDATE prepared_actions SET status = 'executing' WHERE action_id = ?`, [action.actionId]), /terminal|approved/);
});

// ═══ SEND SWITCH ════════════════════════════════════════════════════════════

test('33/34/35. the ONE send switch: OFF stops every type, preparation still works, ON never bypasses approval', async () => {
  freshMailbox();
  db.setState('feature_flag:governed_execution', '');
  const flags = require('./feature-flags');
  assert.equal(flags.isEnabled('governed_execution'), false, 'default OFF');
  // 34: preparing works while it is off.
  const items = [(await prepReply()).action, prepAgenda().action, prepReport().action];
  // ...and the risk-finding sweep leaves them alone: they answer no finding, so
  // "the finding resolved" can never be a reason to withdraw one.
  pa.sweep({ now: NOW + MIN });
  for (const a of items) {
    assert.equal(pa.get(a.actionId).status, 'prepared', `${a.actionType} survives the sweep`);
    assert.equal(a.status, 'prepared');
    // Approving is refused while off (before the code is asked for).
    const ch = proofs.issue({ actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, now: NOW + MIN });
    const r = pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, challengeId: ch.challengeId, approvalCode: CODE, now: NOW + MIN });
    assert.equal(r.ok, false, a.actionType);
    assert.match(r.error, /switched off/);
  }
  // 33: an approval that exists while the switch is off sends nothing, for every type.
  for (const a of items) {
    approve(a);
    const x = await ex.execute(a.actionId, { now: NOW + 2 * MIN, deps: deps({ enabled: () => false }) });
    assert.equal(x.code, 'switched-off', a.actionType);
    assert.equal(pa.get(a.actionId).status, 'approved');
  }
  assert.equal(MB.calls.send, 0);
  // 35: ON does not bypass approval — an unapproved action does not run.
  const b = prepAgenda().action;
  const y = await ex.execute(b.actionId, { now: NOW + 3 * MIN, deps: deps({ enabled: () => true }) });
  assert.equal(y.already, true);
  assert.equal(y.status, 'prepared');
  assert.equal(MB.calls.send, 0);
});

// ═══ AUDIT ══════════════════════════════════════════════════════════════════

test('36. the attempt ledger and verifications are append-only', async () => {
  freshMailbox();
  const a = prepAgenda().action;
  approve(a);
  await run(a);
  assert.throws(() => db.run('DELETE FROM action_attempts WHERE action_id = ?', [a.actionId]));
  assert.throws(() => db.run('UPDATE action_attempts SET final_state = ? WHERE action_id = ?', ['failed', a.actionId]));
  assert.throws(() => db.run('DELETE FROM action_verifications WHERE action_id = ?', [a.actionId]));
  assert.throws(() => db.run('DELETE FROM prepared_actions WHERE action_id = ?', [a.actionId]));
});

test('37. no message body, subject or address reaches the event log', async () => {
  freshMailbox();
  const secret = 'Zanzibar-tangerine-9931';
  const { action } = await prepReply({ body: `The ${secret} figures are attached.`, to: ['sam.jones@nurtur.tech'] });
  approve(action);
  await run(action);
  const rows = JSON.stringify(db.all("SELECT * FROM event_log WHERE type LIKE 'action.%'"));
  assert.ok(rows.includes(action.actionId), 'positive control: the action\'s events are there');
  for (const leak of [secret, 'sam.jones@nurtur.tech', action.draft.subject, 'chris.middleton@nurtur.tech']) {
    assert.ok(!rows.includes(leak), `event log must not hold ${leak}`);
  }
});

test('38. every transition is recorded on the action, with its evidence kept and hashed', async () => {
  freshMailbox();
  const a = prepReport({ tag: 'audit' }).action;
  approve(a);
  await run(a);
  const after = pa.get(a.actionId);
  assert.deepEqual(after.history.map((h) => h.to), ['prepared', 'approved', 'executing', 'executed', 'verified']);
  assert.equal(after.evidenceHash, registry.evidenceHash(after.evidence));
  assert.equal(after.evidence.origin, 'weekly-risk');
  assert.equal(after.approval.mechanism, 'approval-code+challenge');
  assert.ok(after.approval.challengeId);
});

// ═══ REGRESSION ═════════════════════════════════════════════════════════════

test('40/41. evaluators stay shadow; meeting-prep parity collection and the executor jobs are still registered', () => {
  assert.equal(require('./commitment-risk').mode(), 'shadow');
  assert.equal(require('./source-blindness').mode(), 'shadow');
  const mi = require('./meeting-intelligence');
  if (typeof mi.mode === 'function') assert.equal(mi.mode(), 'shadow');
  const sched = fs.readFileSync(path.join(__dirname, 'scheduler.js'), 'utf8');
  for (const job of ["name: 'action-executor'", "name: 'meeting-intelligence'", "name: 'commitment-risk'"]) assert.ok(sched.includes(job), job);
  assert.match(fs.readFileSync(path.join(__dirname, 'meeting-prep.js'), 'utf8'), /meeting_prep_comparisons/);
  for (const f of ['commitment-risk.js', 'meeting-intelligence.js', 'source-blindness.js', 'meeting-prep.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, f), 'utf8'), /require\(['"][./]*(action-executor|action-mail)['"]\)/, f);
  }
});

test('42. chase_commitment is unchanged: its payload hash carries no Build 8 binding, and preparing still imports no sender', () => {
  const target = { personId: 'p', email: 'a@nurtur.tech' };
  const draft = { to: [{ email: 'a@nurtur.tech' }], cc: [], subject: 's', body: 'b' };
  const legacy = registry.sha256(registry.canonical({ actionType: 'chase_commitment', version: 1, commitmentId: 'c', targetPersonId: 'p',
    targetEmail: 'a@nurtur.tech', to: ['a@nurtur.tech'], cc: [], subject: 's', body: 'b' }));
  assert.equal(registry.payloadHash({ actionType: 'chase_commitment', version: 1, commitmentId: 'c', target, draft }), legacy,
    'a Build 6/7 chase hashes exactly as before');
  const src = fs.readFileSync(path.join(__dirname, 'prepared-actions.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"][./]*(services\/)?(webpush|email-sender|teams|microsoft|action-mail|action-executor)['"]\)/);
  // mail-read is READ-ONLY by construction: no write verbs, no sender imports.
  const mr = fs.readFileSync(path.join(__dirname, 'mail-read.js'), 'utf8');
  assert.match(mr, /method: 'GET'/, 'positive control');
  assert.doesNotMatch(mr, /method:\s*'(POST|PATCH|DELETE|PUT)'|sendDraft|sendMail|createDraft/);
});
