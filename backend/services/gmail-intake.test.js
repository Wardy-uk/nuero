'use strict';

// Gmail's Important mail in the work triage (12 Oct 2026): nothing historical,
// a source on each entry (never a second store), every Graph-only path routed by
// source, and a Gmail reply that goes from Gmail through the SAME governed
// executor — approval proof, one-attempt ledger, read-back, Sent verification.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-gmail-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'g.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
delete process.env.GOVERNED_EXECUTION_ENABLED;

function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
const boom = (what) => async () => { throw new Error(`${what} reached from a Gmail test`); };
stub('./webpush', { sendToAll: async () => {}, isConfigured: () => true });
stub('./email-sender', { sendMail: boom('email-sender.sendMail'), sendBriefEmail: boom('email-sender.sendBriefEmail'), OWN_ADDRESS: 'nickw@nurtur.tech' });
stub('./teams', { getSendStatus: async () => ({ available: false }) });

const db = require('../db/database');
const pm = require('./personal-mail');
const gi = require('./gmail-intake');
require('./ai-routing').runTask = async (t) => { throw new Error(`a model was reached (${t})`); };

const GMAIL = 'n.example@gmail.com';
test.before(async () => {
  await db.init();
  pm.setCredential('gmail', { address: GMAIL, password: 'abcd efgh ijkl mnop' });
});

// ── a Gmail server, as imapflow presents it ─────────────────────────────────

function gmailServer({ uidValidity = 7n, messages = [] } = {}) {
  const s = { uidValidity, messages, flagged: [], ranges: [] };
  s.imap = () => ({
    on() {}, async connect() {}, async logout() {},
    get mailbox() { return { uidValidity: s.uidValidity, uidNext: s.uidNext || s.messages.reduce((m, x) => Math.max(m, x.uid), 0) + 1, exists: s.messages.length }; },
    async list() { return [{ path: 'INBOX', specialUse: '\\Inbox' }, { path: '[Gmail]/Important', specialUse: null, flags: new Set(['\\Important']) }, { path: '[Gmail]/Sent Mail', specialUse: '\\Sent' }]; },
    async getMailboxLock() { return { release() {} }; },
    async *fetch(range) {
      s.ranges.push(range);
      const from = Number(String(range).split(':')[0]);
      const hit = s.messages.filter((m) => m.uid >= from);
      // IMAP: `n:*` with n past the end returns the HIGHEST message anyway.
      const out = hit.length ? hit : s.messages.slice(-1);
      for (const m of out) yield m;
    },
    async download(uid) { const m = s.messages.find((x) => String(x.uid) === String(uid)); return { content: (async function* () { yield Buffer.from(m ? m.text : ''); })() }; },
    async fetchOne(uid) { return s.messages.find((x) => String(x.uid) === String(uid)) || null; },
    async messageFlagsAdd(uid, flags) { s.flagged.push({ uid, flags }); },
  });
  return s;
}

const msg = (uid, over = {}) => ({
  uid, emailId: 1000n + BigInt(uid), threadId: 5000n + BigInt(uid), flags: new Set(), internalDate: new Date(),
  envelope: { subject: `Important ${uid}`, from: [{ name: 'Helen', address: 'helen@example.com' }], to: [{ address: GMAIL }], cc: [], messageId: `<m${uid}@example.com>`, date: new Date() },
  bodyStructure: { type: 'text/plain', part: '1' }, text: `Body of ${uid}`,
  ...over,
});

test('first connect marks the line and reads NOTHING; later passes read only above it; the n:* quirk is filtered', async () => {
  db.setState(gi.WATERMARK_KEY, '');
  const srv = gmailServer({ messages: [msg(448), msg(449), msg(450)] });
  let r = await gi.fetchNew({ deps: { imap: srv.imap } });
  assert.equal(r.ok, true); assert.deepEqual(r.emails, []);
  assert.equal(JSON.parse(db.getState(gi.WATERMARK_KEY)).uidNext, 451, 'the line is the folder\'s UIDNEXT at connect');
  assert.equal(srv.ranges.length, 0, 'nothing fetched on the first connect — not even once');

  r = await gi.fetchNew({ deps: { imap: srv.imap } });
  assert.deepEqual(r.emails, []);
  assert.equal(srv.ranges.length, 0, 'nothing new → nothing fetched');

  // Mail 451 arrived and was deleted: UIDNEXT moved to 452, so "451:*" IS asked
  // for, and an IMAP server answers it with the highest message it has — 450,
  // which is below the line.
  srv.uidNext = 452;
  r = await gi.fetchNew({ deps: { imap: srv.imap } });
  assert.equal(srv.ranges.length, 1, 'positive control: the range was fetched');
  assert.deepEqual(r.emails, [], 'uid 450 came back for "451:*" — below the line, dropped');
  srv.uidNext = null;

  srv.messages.push(msg(451, { flags: new Set(['\\Seen']) }), msg(452));
  r = await gi.fetchNew({ deps: { imap: srv.imap } });
  assert.deepEqual(r.emails.map((e) => e.id), ['gmail:1451', 'gmail:1452']);
  const e = r.emails[0];
  assert.equal(e.source, 'gmail');
  assert.equal(e.fromEmail, 'helen@example.com');
  assert.equal(e.isRead, true);
  assert.equal(e.preview, 'Body of 451');
  assert.deepEqual(e.gmail, { uid: 451, uidValidity: '7', path: '[Gmail]/Important', threadId: '5451', messageId: '<m451@example.com>', emailId: '1451' });
});

test('Gmail renumbering the folder re-marks the line at its current end — the past is still never read', async () => {
  db.setState(gi.WATERMARK_KEY, JSON.stringify({ uidValidity: '7', uidNext: 451, setAt: 'x' }));
  const srv = gmailServer({ uidValidity: 9n, messages: [msg(1), msg(2), msg(3)] });
  const r = await gi.fetchNew({ deps: { imap: srv.imap } });
  assert.deepEqual(r.emails, []);
  assert.equal(r.reset, true);
  const wm = JSON.parse(db.getState(gi.WATERMARK_KEY));
  assert.deepEqual([wm.uidValidity, wm.uidNext], ['9', 4]);
  assert.equal(srv.ranges.length, 0);
});

test('an unreadable Gmail is a recorded gap, never an empty inbox and never a thrown triage', async () => {
  const r = await gi.fetchNew({ deps: { imap: () => ({ on() {}, async connect() { throw Object.assign(new Error('Invalid credentials (Failure)'), { authenticationFailed: true }); } }) } });
  assert.equal(r.ok, false);
  assert.match(r.why, /refused the login/);
  assert.deepEqual(r.emails, []);
  assert.equal(gi.status().last.ok, false);
});

test('reading never imports a sender: gmail-intake loads the IMAP library, not the transport or nodemailer', () => {
  const src = fs.readFileSync(path.join(__dirname, 'gmail-intake.js'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.match(src, /require\('imapflow'\)/, 'positive control: it does load an IMAP client');
  assert.doesNotMatch(src, /require\(['"][./]*(personal-mail-transport|smtp-mail|personal-mail-api|nodemailer|action-mail|microsoft)['"]\)/);
});

// ── the triage merge ────────────────────────────────────────────────────────

test('runTriage: Gmail mail joins the SAME store as a source, and is never closed as "left the inbox" for being absent', async () => {
  const microsoft = require('./microsoft');
  const triage = require('./email-triage');
  const real = { fetch: microsoft.fetchRecentEmailsDetailed, auth: microsoft.isAuthenticated, gmail: gi.fetchNew };
  const work = (id) => ({ id, subject: `Work ${id}`, from: 'Sam', fromEmail: 'sam@nurtur.tech', received: new Date(Date.now() - 3600000).toISOString(), isRead: true, preview: 'p' });
  let graph = [work('AAMk-1'), work('AAMk-2')];
  let gmail = [gi.toTriageEmail(msg(460), { path: '[Gmail]/Important', uidValidity: 7n, text: 'hello' })];
  microsoft.isAuthenticated = async () => true;
  microsoft.fetchRecentEmailsDetailed = async () => ({ emails: graph, complete: true });
  gi.fetchNew = async () => ({ ok: true, emails: gmail });
  try {
    db.setState('email_triage', '[]'); db.setState('email_triage_input', '');
    await triage.runTriage({ force: true });
    let stored = JSON.parse(db.getState('email_triage'));
    assert.equal(stored.length, 3, 'one store');
    const g = stored.find((e) => e.id === 'gmail:1460');
    assert.equal(g.source, 'gmail'); assert.ok(g.lane, 'triaged into a lane like work mail');
    // Next pass: Gmail returns nothing new (incremental) and AAMk-2 left Outlook.
    graph = [work('AAMk-1')]; gmail = [];
    await triage.runTriage({ force: true });
    stored = JSON.parse(db.getState('email_triage'));
    assert.equal(stored.find((e) => e.id === 'AAMk-2').dismissReason, 'left-inbox', 'positive control: a work email that left IS closed');
    assert.equal(stored.find((e) => e.id === 'gmail:1460').dismissed, false, 'the Gmail entry is carried, not closed');
  } finally {
    microsoft.fetchRecentEmailsDetailed = real.fetch; microsoft.isAuthenticated = real.auth; gi.fetchNew = real.gmail;
  }
});

// ── the routes: a Gmail id never reaches Graph ──────────────────────────────

test('dismiss marks it read in GMAIL and detail reads it from GMAIL — Graph is never asked; From shows the Gmail address', async () => {
  const microsoft = require('./microsoft');
  const real = { mark: microsoft.markEmailRead, byId: microsoft.fetchEmailById, me: microsoft.getSignedInAddress, read: gi.readMessage, markG: gi.markRead };
  const graphCalls = [];
  microsoft.markEmailRead = async (id) => { graphCalls.push(['markRead', id]); return { marked: true }; };
  microsoft.fetchEmailById = async (id) => { graphCalls.push(['fetch', id]); return null; };
  microsoft.getSignedInAddress = async () => 'nickw@nurtur.tech';
  const marked = [];
  gi.markRead = async (id) => { marked.push(id); return { marked: true }; };
  gi.readMessage = async () => ({ ok: true, exists: true, from: 'helen@example.com', fromName: 'Helen', subject: 'Important 460',
    to: [{ name: '', email: GMAIL }], cc: [{ name: 'Mum', email: 'mum@example.org' }], body: 'the body', conversationId: '5460', internetMessageId: '<m460@example.com>', received: new Date().toISOString() });
  db.setState('email_triage', JSON.stringify([{ ...gi.toTriageEmail(msg(460), { path: '[Gmail]/Important', uidValidity: 7n, text: 'x' }), lane: 'reply', category: 'ACTION', dismissed: false }]));
  const express = require('express');
  const app = express(); app.use(express.json()); app.use('/api/email', require('../routes/email-triage'));
  const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(`${base}/api/email/triage/${encodeURIComponent('gmail:1460')}`);
    let b = await r.json();
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal(b.email.source, 'gmail');
    assert.equal(b.email.sendsFrom.address, GMAIL);
    assert.equal(b.email.body, 'the body');
    assert.deepEqual(b.email.replyDefaults.replyAllCc.map((x) => x.email), ['mum@example.org'], 'your own Gmail address is not cc\'d back to you');
    r = await fetch(`${base}/api/email/triage/dismiss/${encodeURIComponent('gmail:1460')}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'done', markRead: true }) });
    b = await r.json();
    assert.equal(b.markedRead, true);
    assert.deepEqual(marked, ['gmail:1460']);
    assert.deepEqual(graphCalls, [], 'Graph was never asked about a Gmail id');
  } finally {
    server.closeAllConnections?.(); server.close();
    Object.assign(microsoft, { markEmailRead: real.mark, fetchEmailById: real.byId, getSignedInAddress: real.me });
    gi.readMessage = real.read; gi.markRead = real.markG;
  }
});

// ── a Gmail reply through the governed executor ─────────────────────────────

test('a Gmail reply: prepared from Gmail, bound to the mailbox, approved with the code, sent from Gmail over SMTP, verified in Gmail Sent — Graph untouched', async () => {
  const registry = require('./action-registry');
  const pa = require('./prepared-actions');
  const ex = require('./action-executor');
  const proofs = require('./approval-proof');
  const papi = require('./personal-mail-api');
  if (!proofs.codeStatus().set) assert.equal(proofs.setCode('gmail approval code').ok, true);
  const NOW = Date.now();
  const orig = { ok: true, exists: true, from: 'helen@example.com', fromName: 'Helen', subject: 'Saturday?', to: [{ name: '', email: GMAIL }], cc: [],
    body: 'Are we still on for Saturday?', conversationId: '5470', internetMessageId: '<m470@example.com>', references: '<m469@example.com>', received: new Date(NOW - 3600000).toISOString() };
  const reader = { readMessage: async () => orig };
  const prep = await pa.prepareReply({ emailId: 'gmail:1470', body: 'Yes — see you at 10.', mode: 'reply', origin: 'composer', now: NOW,
    deps: { gmail: { readMessage: async () => ({ ...orig, receivedAt: orig.received }), signedInAddress: async () => GMAIL } } });
  assert.equal(prep.ok, true, prep.error);
  const a = prep.action;
  assert.equal(a.target.mailbox, 'gmail');
  assert.equal(a.sendsFrom.address, GMAIL, 'the card says Gmail');
  assert.notEqual(a.payloadHash, registry.payloadHash({ actionType: a.actionType, version: a.version, commitmentId: a.commitmentId, target: { ...a.target, mailbox: undefined }, draft: a.draft }),
    'the sending mailbox is bound into the approval');

  const sent = [];
  const transport = {
    smtpSend: async (key, m) => { sent.push({ key, m }); return { outcome: 'accepted', status: 250 }; },
    findInSent: async (key, mid) => {
      const s = sent.find((x) => x.m.messageId === mid);
      return { ok: true, evidence: 'filed by Gmail in Sent Mail', messages: s ? [{ id: '9', internetMessageId: mid, subject: s.m.subject, to: s.m.to.map((x) => x.address), cc: [], bcc: [], from: GMAIL, sentAt: new Date(NOW + 5 * 60000).toISOString(), conversationId: '5470', bodyText: null }] : [] };
    },
    sentInThreadSince: async () => ({ count: 0 }),
  };
  const ch = proofs.issue({ actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, now: NOW + 60000 });
  const ap = pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, challengeId: ch.challengeId, approvalCode: 'gmail approval code', now: NOW + 60000, sending: () => true });
  assert.equal(ap.ok, true, ap.error);
  const graph = new Proxy({}, { get: (t, k) => async () => { throw new Error(`Graph mail.${String(k)} called for a Gmail reply`); } });
  const r = await ex.execute(a.actionId, { now: NOW + 2 * 60000, deps: {
    mail: graph, enabled: () => true, reportLocked: () => false,
    personalMail: (box) => papi.forMailbox(box, { reader, smtp: { transport }, transport }),
  } });
  assert.equal(r.status, 'verified', JSON.stringify(r));
  assert.equal(sent.length, 1);
  const m = sent[0].m;
  assert.equal(sent[0].key, 'gmail');
  assert.equal(m.from, `"Nick Ward" <${GMAIL}>`);
  assert.deepEqual(m.to.map((x) => x.address), ['helen@example.com']);
  assert.equal(m.inReplyTo, '<m470@example.com>');
  assert.equal(m.references, '<m469@example.com> <m470@example.com>');
  assert.match(m.text, /^Yes — see you at 10\.\n\nOn .*Helen <helen@example\.com> wrote:\n> Are we still on for Saturday\?/);
  assert.equal(m.subject, 'RE: Saturday?');
  assert.match(pa.get(a.actionId).history.map((h) => h.note || '').join(' '), /Gmail accepted the send \(SMTP 250\)/);
  // Re-running never sends twice.
  await ex.execute(a.actionId, { now: NOW + 3 * 60000, deps: { mail: graph, enabled: () => true, personalMail: (box) => papi.forMailbox(box, { reader, smtp: { transport }, transport }) } });
  assert.equal(sent.length, 1);
});

test('the registry allows a personal mailbox only where it says so: a reply from nick@ is refused before anything is drafted', () => {
  const ex = require('./action-executor');
  const registry = require('./action-registry');
  assert.deepEqual([...registry.policyFor('reply_email').personalMailboxes], ['gmail']);
  const action = { actionType: 'reply_email', version: 1, target: { emailId: 'x', mailbox: 'nick' }, draft: { to: [{ email: 'a@b.co' }], subject: 's', body: 'b', mode: 'reply' } };
  action.payloadHash = registry.payloadHash({ ...action, commitmentId: undefined });
  action.approval = { payloadHash: action.payloadHash, expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const r = ex.commonChecks({ action, policy: registry.policyFor('reply_email'), nowMs: Date.now() });
  assert.equal(r.code, 'mailbox-not-allowed');
  assert.equal(require('./mail-identity').forAction({ actionType: 'reply_email', target: { mailbox: 'nick' } }), null, 'and the card claims no From for it');
  assert.equal(require('./mail-identity').forAction({ actionType: 'chase_commitment', target: { mailbox: 'gmail' } }), null);
});

test('work replies hash exactly as before: no mailbox in the target, no change to the bind', () => {
  const registry = require('./action-registry');
  const b = registry.bindFor('reply_email', { emailId: 'AAMk', conversationId: 'C' }, { mode: 'reply' });
  assert.equal(registry.canonical(b), registry.canonical({ emailId: 'AAMk', conversationId: 'C', mode: 'reply' }));
});
