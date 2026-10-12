'use strict';

// The personal inbox (12 Oct 2026): nick@ / contact@ newest first, no AI; saim@
// watched for bounces; replies from the SAME mailbox through the governed
// executor. The fake Fasthosts server answers SEARCH with [] for everything —
// exactly as the live one does — so anything that searches fails here first.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-pinbox-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'p.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
delete process.env.GOVERNED_EXECUTION_ENABLED;

function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
const pushes = [];
stub('./webpush', { sendToAll: async (title, body, data) => { pushes.push({ title, body, data }); }, isConfigured: () => true });
stub('./email-sender', { sendMail: async () => { throw new Error('email-sender reached'); }, OWN_ADDRESS: 'nickw@nurtur.tech' });
stub('./teams', { getSendStatus: async () => ({ available: false }) });

const db = require('../db/database');
const pm = require('./personal-mail');
const inbox = require('./personal-inbox');

test.before(async () => {
  await db.init();
  for (const k of ['nick', 'contact', 'saim']) pm.setCredential(k, { password: 'pw' });
});

// ── a Fasthosts server, as measured ─────────────────────────────────────────

function fasthosts(folders) {
  const s = { folders, searches: 0, flagged: [] };
  s.imap = () => {
    let cur = null;
    return {
      on() {}, async connect() {}, async logout() {},
      get mailbox() { const f = s.folders[cur] || { messages: [] }; return { uidValidity: f.uidValidity || 5n, exists: f.messages.length, uidNext: (f.messages.at(-1) || { uid: 0 }).uid + 1 }; },
      async list() { return Object.keys(s.folders).map((p) => ({ path: p, specialUse: p === 'INBOX' ? '\\Inbox' : p === 'Sent' ? '\\Sent' : null })); },
      async getMailboxLock(p) { cur = p; return { release() {} }; },
      async search() { s.searches += 1; return []; },
      async *fetch(range) {
        const msgs = (s.folders[cur] || { messages: [] }).messages;
        const from = Number(String(range).split(':')[0]);
        for (let i = from - 1; i < msgs.length; i += 1) yield { ...msgs[i], seq: i + 1 };
      },
      async fetchOne(uid, q) {
        const m = (s.folders[cur] || { messages: [] }).messages.find((x) => String(x.uid) === String(uid));
        if (!m) return null;
        return q && q.source ? { source: Buffer.from(m.source || '') } : m;
      },
      async download(uid) { const m = (s.folders[cur] || { messages: [] }).messages.find((x) => String(x.uid) === String(uid)); return { content: (async function* () { yield Buffer.from(m ? m.text : ''); })() }; },
      async messageFlagsAdd(uid, flags) { s.flagged.push({ uid, flags }); },
    };
  };
  return s;
}

const mail = (uid, over = {}) => ({
  uid, flags: new Set(), internalDate: new Date(Date.parse('2026-10-12T09:00:00Z') + uid * 60000),
  envelope: { subject: `Hello ${uid}`, from: [{ name: 'Sam', address: 'sam@example.com' }], to: [{ address: 'nick@nickward.co.uk' }], cc: [], messageId: `<p${uid}@example.com>` },
  bodyStructure: { type: 'text/plain', part: '1' }, text: `Text ${uid}`, ...over,
});

test('the inbox MIRRORS the newest messages, newest first, never searching; read flags follow; a deleted message leaves', async () => {
  const srv = fasthosts({ INBOX: { messages: [mail(1), mail(2, { flags: new Set(['\\Seen']) }), mail(3)] } });
  let r = await inbox.refreshMailbox('nick', { deps: { imap: srv.imap } });
  assert.equal(r.ok, true); assert.equal(r.added, 3);
  let list = inbox.list('nick');
  assert.deepEqual(list.map((m) => m.subject), ['Hello 3', 'Hello 2', 'Hello 1'], 'newest first');
  assert.deepEqual(list.map((m) => m.seen), [false, true, false]);
  assert.equal(list[0].preview, 'Text 3');
  assert.equal(list[0].id, 'pmail:nick:5:3');
  srv.folders.INBOX.messages = [mail(1, { flags: new Set(['\\Seen']) }), mail(3)];
  r = await inbox.refreshMailbox('nick', { deps: { imap: srv.imap } });
  list = inbox.list('nick');
  assert.deepEqual(list.map((m) => m.subject), ['Hello 3', 'Hello 1'], 'message 2 was deleted in the mailbox, so it left');
  assert.equal(list[1].seen, true, 'read elsewhere → read here');
  assert.equal(srv.searches, 0, 'Fasthosts answers no SEARCH — none is asked');
  srv.folders.INBOX.uidValidity = 6n;
  await inbox.refreshMailbox('nick', { deps: { imap: srv.imap } });
  assert.ok(inbox.list('nick').every((m) => m.id.startsWith('pmail:nick:6:')), 'renumbered: the old rows are replaced');
  assert.equal(inbox.list('nope'), null);
});

test('saim@: what a bounce and an auto-reply are', () => {
  assert.equal(inbox.classifyWatched({ fromEmail: 'MAILER-DAEMON@gmail.com', subject: 'Delivery Status Notification (Failure)' }), 'bounce');
  assert.equal(inbox.classifyWatched({ fromEmail: 'postmaster@outlook.com', subject: 'Undeliverable: x' }), 'bounce');
  assert.equal(inbox.classifyWatched({ fromEmail: 'x@y.com', subject: 'x', contentType: 'multipart/report' }), 'bounce');
  assert.equal(inbox.classifyWatched({ fromEmail: 'helen@example.com', subject: 'Re: walk', headers: 'Auto-Submitted: auto-replied\r\n' }), 'auto-reply');
  assert.equal(inbox.classifyWatched({ fromEmail: 'helen@example.com', subject: 'Out of office: away' }), 'auto-reply');
  assert.equal(inbox.classifyWatched({ fromEmail: 'helen@example.com', subject: 'Re: walk', headers: 'Auto-Submitted: no\r\n' }), 'reply', 'Auto-Submitted: no is a person');
  assert.equal(inbox.bouncedMessageId('Message-ID: <own@x>\r\n...\r\nMessage-ID: <neuro-abc@nickward.co.uk>\r\n', '<own@x>'), '<neuro-abc@nickward.co.uk>');
});

test('a bounced HIKE ALERT from saim@ is noticed: noted on the walk and pushed ONCE', async () => {
  const tripId = 'hike:test-bounce';
  db.run(`INSERT INTO hike_trips (trip_id, name, status, planned_start, planned_finish, grace_minutes, recipients_json, card_text, card_hash, armed_at,
            alert_status, alert_message_id, alert_mailbox) VALUES (?, 'Catbells', 'alerted', ?, ?, 60, '[]', 'card', 'h', ?, 'sent', ?, 'saim')`,
  [tripId, '2026-10-12T09:00:00Z', '2026-10-12T15:00:00Z', '2026-10-12T08:00:00Z', '<neuro-alert1@nickward.co.uk>']);
  const bounce = mail(9, {
    envelope: { subject: 'Delivery Status Notification (Failure)', from: [{ address: 'mailer-daemon@googlemail.com' }], to: [{ address: 'saim@nickward.co.uk' }], cc: [], messageId: '<bounce9@google.com>' },
    bodyStructure: { type: 'multipart/report', childNodes: [{ type: 'text/plain', part: '1' }] },
    text: 'Address not found', source: 'Message-ID: <bounce9@google.com>\r\n\r\n...\r\nMessage-ID: <neuro-alert1@nickward.co.uk>\r\nSubject: Nick hasn\'t checked in\r\n',
  });
  const srv = fasthosts({ INBOX: { messages: [bounce] } });
  pushes.length = 0;
  const noticed = await inbox.refresh({ deps: { imap: srv.imap }, only: ['saim'] });
  assert.equal(noticed.hikeBounces, 1);
  const row = inbox.list('saim')[0];
  assert.equal(row.kind, 'bounce'); assert.equal(row.bounceOf, '<neuro-alert1@nickward.co.uk>'); assert.equal(row.hikeTripId, tripId);
  assert.match(db.get('SELECT alert_error FROM hike_trips WHERE trip_id = ?', [tripId]).alert_error, /BOUNCED/);
  assert.equal(pushes.length, 1); assert.match(pushes[0].title, /Hike alert bounced/); assert.equal(pushes[0].data.type, 'hike_checkin');
  await inbox.refresh({ deps: { imap: srv.imap }, only: ['saim'] });
  assert.equal(pushes.length, 1, 'the same bounce is not pushed again');
});

test('reading never imports a sender: personal-inbox loads the IMAP library, not the transport, SMTP or Microsoft', () => {
  const src = fs.readFileSync(path.join(__dirname, 'personal-inbox.js'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.match(src, /require\('imapflow'\)/, 'positive control');
  assert.doesNotMatch(src, /require\(['"][./]*(personal-mail-transport|smtp-mail|personal-mail-api|nodemailer|action-mail|microsoft|email-sender)['"]\)/);
});

// ── the screen's routes ─────────────────────────────────────────────────────

test('routes: open (never marks read), mark read, and a reply PREPARED from nick@ with nick@ as From', async () => {
  const real = { read: inbox.readMessage, mark: inbox.markRead };
  const orig = { ok: true, exists: true, mailbox: 'nick', from: 'sam@example.com', fromName: 'Sam', subject: 'Lunch?', to: [{ name: '', email: 'nick@nickward.co.uk' }], cc: [],
    body: 'Lunch Friday?', conversationId: '<p7@example.com>', internetMessageId: '<p7@example.com>', references: null, received: new Date().toISOString() };
  let marked = 0;
  inbox.readMessage = async () => orig;
  inbox.markRead = async () => { marked += 1; return { marked: true }; };
  const express = require('express');
  const app = express(); app.use(express.json()); app.use('/api/personal-inbox', require('../routes/personal-inbox'));
  const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const id = encodeURIComponent('pmail:nick:5:7');
  try {
    let r = await (await fetch(`${base}/api/personal-inbox/message/${id}`)).json();
    assert.equal(r.ok, true); assert.equal(r.sendsFrom.address, 'nick@nickward.co.uk');
    assert.equal(marked, 0, 'opening does not mark it read');
    r = await (await fetch(`${base}/api/personal-inbox/message/${id}/read`, { method: 'POST' })).json();
    assert.equal(r.marked, true); assert.equal(marked, 1);
    r = await (await fetch(`${base}/api/personal-inbox/message/${id}/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'Friday works.' }) })).json();
    assert.equal(r.ok, true, r.error);
    assert.equal(r.action.target.mailbox, 'nick');
    assert.equal(r.action.target.conversationId, '<p7@example.com>');
    assert.equal(r.action.sendsFrom.address, 'nick@nickward.co.uk', 'the card says nick@');
    assert.deepEqual(r.action.draft.to.map((x) => x.email), ['sam@example.com']);
    assert.equal(r.action.origin, 'composer', 'sent on the click, like an Inbox reply');
    const ov = await (await fetch(`${base}/api/personal-inbox`)).json();
    assert.deepEqual(ov.mailboxes.map((m) => m.key), ['nick', 'contact', 'saim']);
    assert.equal(ov.mailboxes.find((m) => m.key === 'saim').watchedOnly, true);
  } finally {
    server.closeAllConnections?.(); server.close();
    inbox.readMessage = real.read; inbox.markRead = real.mark;
  }
});

test('the screen, really rendered: newest first with unread marked, saim@ labels, and the reply says which address it goes from', async () => {
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'PersonalInboxPanel.jsx')], bundle: true, write: false,
    format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      b.onResolve({ filter: /(^|\/)(api|directAction)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl = p => p; export const executeDirect = async () => ({}); export const directOutcome = () => ({});', loader: 'js' }));
    } }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  const { MessageList, MessageView } = mod.exports;
  assert.ok(MessageList && MessageView, 'positive control: the views are exported');
  const now = Date.parse('2026-10-12T12:00:00Z');
  const items = [
    { id: 'a', from: 'Sam', subject: 'Newer', received: '2026-10-12T11:30:00Z', seen: false, preview: 'p' },
    { id: 'b', from: 'mailer-daemon@googlemail.com', subject: 'Delivery failed', received: '2026-10-12T09:00:00Z', seen: true, kind: 'bounce', hikeTripId: 'hike:x' },
  ];
  const list = renderToString(React.createElement(MessageList, { items, onOpen() {}, now })).replace(/<!-- -->/g, '');
  assert.ok(list.indexOf('Newer') < list.indexOf('Delivery failed'), 'in the order given — newest first');
  assert.match(list, /pi-row pi-unread/);
  assert.match(list, /Bounced/); assert.match(list, /hike alert/);
  assert.match(list, /30m/);
  const data = { message: { subject: 'Lunch?', from: 'sam@example.com', fromName: 'Sam', body: 'Lunch Friday?', cc: [] }, sendsFrom: { address: 'nick@nickward.co.uk' } };
  const view = renderToString(React.createElement(MessageView, { data, onRead() {}, onReply() {}, busy: false, canReply: true })).replace(/<!-- -->/g, '');
  assert.match(view, /From <strong>nick@nickward\.co\.uk<\/strong> → sam@example\.com/);
  assert.match(view, /Mark read/);
  const watched = renderToString(React.createElement(MessageView, { data, onRead() {}, onReply() {}, busy: false, canReply: false }));
  assert.doesNotMatch(watched, /Your reply/, 'saim@ is watched, never replied from');
  assert.equal(renderToString(React.createElement(MessageList, { items: [], onOpen() {} })).includes('Nothing in this mailbox'), true);
});

// ── a nick@ reply through the governed executor ─────────────────────────────

test('a nick@ reply: approved with the code, sent from nick@, verified in Sent by In-Reply-To — Graph untouched', async () => {
  const pa = require('./prepared-actions');
  const ex = require('./action-executor');
  const proofs = require('./approval-proof');
  const papi = require('./personal-mail-api');
  if (!proofs.codeStatus().set) assert.equal(proofs.setCode('pinbox approval code').ok, true);
  const NOW = Date.now();
  const orig = { ok: true, exists: true, mailbox: 'contact', from: 'form@site.example', fromName: 'Website form', subject: 'Enquiry', to: [{ name: '', email: 'contact@nickward.co.uk' }], cc: [],
    body: 'Do you do talks?', conversationId: '<f1@site.example>', internetMessageId: '<f1@site.example>', references: null, received: new Date(NOW - 3600000).toISOString() };
  const reader = { readMessage: async () => orig };
  const prep = await pa.prepareReply({ emailId: 'pmail:contact:5:11', body: 'Yes — happy to.', origin: 'composer', now: NOW,
    deps: { personal: () => ({ readMessage: async () => ({ ...orig, receivedAt: orig.received }), signedInAddress: async () => 'contact@nickward.co.uk' }) } });
  assert.equal(prep.ok, true, prep.error);
  const a = prep.action;
  assert.equal(a.target.mailbox, 'contact');
  const sent = [];
  const transport = {
    smtpSend: async (key, m) => { sent.push({ key, m }); return { outcome: 'accepted', status: 250, appended: true }; },
    findInSent: async (key, mid) => {
      const s = sent.find((x) => x.m.messageId === mid);
      return { ok: true, messages: s ? [{ id: '3', internetMessageId: mid, subject: s.m.subject, to: s.m.to.map((x) => x.address), cc: [], bcc: [], from: 'contact@nickward.co.uk', sentAt: new Date(NOW + 300000).toISOString(), conversationId: s.m.inReplyTo, bodyText: null }] : [] };
    },
    sentInThreadSince: async () => ({ count: 0 }),
  };
  const ch = proofs.issue({ actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, now: NOW + 60000 });
  assert.equal(pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, challengeId: ch.challengeId, approvalCode: 'pinbox approval code', now: NOW + 60000, sending: () => true }).ok, true);
  const graph = new Proxy({}, { get: (t, k) => async () => { throw new Error(`Graph mail.${String(k)} called for a contact@ reply`); } });
  const r = await ex.execute(a.actionId, { now: NOW + 120000, deps: { mail: graph, enabled: () => true, personalMail: (box) => papi.forMailbox(box, { reader, smtp: { transport }, transport }) } });
  assert.equal(r.status, 'verified', JSON.stringify(r));
  assert.equal(sent[0].key, 'contact');
  assert.equal(sent[0].m.from, '"Nick Ward" <contact@nickward.co.uk>');
  assert.equal(sent[0].m.inReplyTo, '<f1@site.example>');
});

test('Fasthosts "already replied in this thread?" scans Sent envelopes for In-Reply-To — and never searches', async () => {
  const t = require('./personal-mail-transport');
  const sentFolder = { messages: [
    { uid: 1, internalDate: new Date('2026-10-12T08:00:00Z'), envelope: { inReplyTo: '<f1@site.example>' } },
    { uid: 2, internalDate: new Date('2026-10-12T11:00:00Z'), envelope: { inReplyTo: '<f1@site.example>' } },
    { uid: 3, internalDate: new Date('2026-10-12T11:30:00Z'), envelope: { inReplyTo: '<other@x>' } },
  ] };
  const srv = fasthosts({ INBOX: { messages: [] }, Sent: sentFolder });
  const r = await t.sentInThreadSince('contact', '<f1@site.example>', '2026-10-12T10:00:00Z', { imap: srv.imap });
  assert.deepEqual(r, { count: 1 }, 'only the reply sent since it was prepared');
  // The REAL Sent lookup the executor verifies with: found by envelope, and its
  // "thread" is the message it replies to (In-Reply-To).
  sentFolder.messages.push({ uid: 4, internalDate: new Date('2026-10-12T12:00:00Z'), envelope: { messageId: '<neuro-r1@nickward.co.uk>', inReplyTo: '<f1@site.example>', subject: 'RE: Enquiry', to: [{ address: 'form@site.example' }], cc: [], from: [{ address: 'contact@nickward.co.uk' }], date: new Date('2026-10-12T12:00:00Z') } });
  const found = await t.findInSent('contact', '<neuro-r1@nickward.co.uk>', { imap: srv.imap });
  assert.equal(found.ok, true);
  assert.equal(found.messages.length, 1);
  assert.equal(found.messages[0].conversationId, '<f1@site.example>');
  assert.deepEqual(found.messages[0].to, ['form@site.example']);
  assert.equal(found.messages[0].from, 'contact@nickward.co.uk');
  assert.equal(srv.searches, 0);
  const registry = require('./action-registry');
  assert.deepEqual([...registry.policyFor('reply_email').personalMailboxes], ['gmail', 'nick', 'contact']);
  assert.equal(require('./mail-identity').forAction({ actionType: 'reply_email', target: { mailbox: 'saim' } }), null, 'SAiM never replies as itself');
});
