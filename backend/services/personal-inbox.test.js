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
    assert.deepEqual(ov.mailboxes.map((m) => m.key), ['nick', 'contact', 'gmail', 'saim']);
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
  const { MessageList, MessageView, ComposeForm } = mod.exports;
  assert.ok(MessageList && MessageView && ComposeForm, 'positive control: the views are exported');
  const options = [{ key: 'work', address: 'nickw@nurtur.tech', via: 'Microsoft (Outlook)', ready: true }, { key: 'nick', address: 'nick@nickward.co.uk', via: 'Fasthosts', ready: true }, { key: 'gmail', address: 'n.example@gmail.com', via: 'Gmail', ready: false }];
  const compose = (suggestion, initialFrom = 'nick') => renderToString(React.createElement(ComposeForm, { options, suggestion, initialFrom, onRecipients() {}, onSend() {}, onCancel() {}, busy: false })).replace(/<!-- -->/g, '');
  let html = compose(null);
  assert.match(html, /<select id="pi-from"/);
  assert.match(html, /nickw@nurtur\.tech/); assert.match(html, /nick@nickward\.co\.uk/);
  assert.match(html, /n\.example@gmail\.com \(no password saved\)/);
  assert.match(html, /Sends from <strong>nick@nickward\.co\.uk<\/strong>/);
  html = compose({ mailbox: 'work', ask: false, why: 'Everyone on it is work.' });
  assert.match(html, /data-testid="pi-compose-mismatch"/, 'personal From to work people is called out');
  html = compose({ ask: true, why: 'NEURO cannot tell whether some of these people are work or personal.' });
  assert.match(html, /Check the From/);
  html = compose({ mailbox: 'nick', ask: false, why: 'Everyone on it is personal.' });
  assert.doesNotMatch(html, /pi-compose-mismatch/);
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
  // Gmail tab: each row says why it is here; the sender can be kept or hidden; the rule lists both, each undoable.
  const gl = renderToString(React.createElement(MessageList, { items: [{ id: 'gmail:1', from: 'Zilch', subject: 'Quick reminder', received: '2026-10-12T11:00:00Z', seen: false, why: 'On your always-show list' }], onOpen() {}, now })).replace(/<!-- -->/g, '');
  assert.match(gl, /pi-why[^>]*>On your always-show list/);
  const gv = renderToString(React.createElement(MessageView, { data, onRead() {}, onReply() {}, onSender() {}, busy: false, canReply: true })).replace(/<!-- -->/g, '');
  assert.match(gv, /Always show sam@example\.com/); assert.match(gv, /Stop showing sam@example\.com/);
  assert.doesNotMatch(renderToString(React.createElement(MessageView, { data, onRead() {}, onReply() {}, busy: false, canReply: true })), /Always show/, 'only the Gmail tab offers it');
  const rules = renderToString(React.createElement(mod.exports.GmailRules, { rules: { keep: ['@payzilch.com'], hide: ['info@account.netflix.com'], reasons: { important: 'Gmail marks it Important' }, correspondents: { count: 16 } }, onSet() {}, busy: false })).replace(/<!-- -->/g, '');
  assert.match(rules, /1 always shown, 1 hidden/); assert.match(rules, /@payzilch\.com <button[^>]*>Remove/); assert.match(rules, /info@account\.netflix\.com <button[^>]*>Show again/);
  assert.match(rules, /People you write to: 16/);
});

// ── Gmail moved here (Nick, 12 Oct 2026) ────────────────────────────────────

function gmailServer({ uidValidity = 7n, messages = [], sent = [], uidNext = null } = {}) {
  const s = { uidValidity, messages, sent, uidNext, moved: [], ranges: [], searches: [], connectFails: false };
  const folder = (cur) => (cur === '[Gmail]/Sent Mail' ? s.sent : s.messages);
  s.imap = () => {
    let cur = null;
    return {
      on() {}, async connect() { if (s.connectFails) throw Object.assign(new Error('Invalid credentials (Failure)'), { authenticationFailed: true }); }, async logout() {},
      get mailbox() { const f = folder(cur); return { uidValidity: s.uidValidity, uidNext: (cur === 'INBOX' && s.uidNext) || (f.at(-1) || { uid: 0 }).uid + 1, exists: f.length }; },
      async list() { return [{ path: 'INBOX', specialUse: '\\Inbox' }, { path: '[Gmail]/Important', specialUse: null, flags: new Set(['\\Important']) }, { path: '[Gmail]/Sent Mail', specialUse: '\\Sent' }, { path: '[Gmail]/Bin', specialUse: '\\Trash' }]; },
      async getMailboxLock(p) { cur = p; return { release() {} }; },
      async search(q) {
        s.searches.push({ folder: cur, q });
        let f = folder(cur);
        if (q.uid) f = f.filter((m) => m.uid >= Number(String(q.uid).split(':')[0]));
        if (q.gmraw === 'category:primary') f = f.filter((m) => m.primary);
        if (q.since) f = f.filter((m) => m.internalDate >= q.since);
        if (q.from) f = f.filter((m) => String(m.envelope.from[0].address).includes(q.from));
        return f.map((m) => m.uid);
      },
      async *fetch(range) {
        if (cur === 'INBOX') s.ranges.push(range);
        const f = folder(cur);
        if (String(range).includes(':')) {
          const from = Number(String(range).split(':')[0]);
          const hit = f.filter((m) => m.uid >= from);
          for (const m of (hit.length ? hit : f.slice(-1))) yield m; // n:* past the end → the highest
        } else {
          const want = String(range).split(',').map(Number);
          for (const m of f) if (want.includes(m.uid)) yield m;
        }
      },
      async fetchOne(uid) { return folder(cur).find((x) => String(x.uid) === String(uid)) || null; },
      async download(uid) { const m = folder(cur).find((x) => String(x.uid) === String(uid)); return { content: (async function* () { yield Buffer.from(m ? m.text : ''); })() }; },
      async messageMove(uid, to) { s.moved.push({ from: cur, uid, to }); s.messages = s.messages.filter((m) => String(m.uid) !== String(uid)); },
    };
  };
  return s;
}
const BULK_HEADERS = Buffer.from('List-Unsubscribe: <https://x.example/u>\r\n');
const gmsg = (uid, over = {}) => {
  const base = mail(uid);
  const { from, ...rest } = over;
  return {
    ...base, emailId: 2000n + BigInt(uid), threadId: 3000n + BigInt(uid), labels: new Set(), headers: Buffer.from(''), primary: false,
    envelope: { ...base.envelope, from: [{ name: 'Sender', address: from || 'news@shop.example' }], to: [{ address: 'n.example@gmail.com' }], messageId: `<g${uid}@example.com>` },
    ...rest,
  };
};

test('the Gmail tab: Gmail\'s INBOX judged by NEURO\'s rule — nothing read on first connect, each row says why, mailing lists stay out', async () => {
  pm.setCredential('gmail', { address: 'n.example@gmail.com', password: 'abcd efgh ijkl mnop' });
  const gi = require('./gmail-intake');
  const gr = require('./gmail-rule');
  db.setState(gi.WATERMARK_KEY, '');
  db.setState(gr.CORRESPONDENTS_KEY, '');
  const old = Date.parse('2026-09-20T09:00:00Z');
  const srv = gmailServer({
    messages: [gmsg(40, { internalDate: new Date(old), from: 'support@payzilch.com', headers: BULK_HEADERS }), gmsg(41, { internalDate: new Date(old + 60000), labels: new Set(['\\Important']) })],
    sent: [{ uid: 1, internalDate: new Date(), envelope: { to: [{ address: 'Lizzy@Example.com' }], cc: [] } }],
  });
  let r = await inbox.refreshMailbox('gmail', { deps: { imap: srv.imap } });
  assert.equal(r.watermarkSet, true);
  assert.equal(srv.ranges.length, 0, 'first connect reads NOTHING from the inbox');
  assert.equal(JSON.parse(db.getState(gi.WATERMARK_KEY)).scannedTo, 42);

  srv.uidNext = 43; // 42 arrived and was deleted: "42:*" hands back 41 (Important — it WOULD show), below the line
  await inbox.refreshMailbox('gmail', { deps: { imap: srv.imap } });
  assert.deepEqual(inbox.list('gmail'), []);
  srv.uidNext = null;

  srv.messages.push(
    gmsg(43, { headers: BULK_HEADERS }), // a mailing list
    gmsg(44, { headers: BULK_HEADERS, labels: new Set(['\\Important']) }),
    gmsg(45, { from: 'lizzy@example.com', headers: BULK_HEADERS }), // someone he writes to
    gmsg(46, { from: 'pal@example.com', primary: true }), // personal Primary mail
    gmsg(47, { from: 'robot@example.com', primary: true, headers: Buffer.from('Auto-Submitted: auto-generated\r\n') }),
    gmsg(48, { from: 'n.example@gmail.com', primary: true }), // his own
  );
  r = await inbox.refreshMailbox('gmail', { deps: { imap: srv.imap } });
  assert.equal(r.scanned, 6);
  const rows = inbox.list('gmail');
  assert.deepEqual(rows.map((m) => [m.id, m.why]), [
    ['gmail:2046', 'Personal-looking: Primary tab, not a mailing list'],
    ['gmail:2045', 'Someone you have written to'],
    ['gmail:2044', 'Gmail marks it Important'],
  ]);
  assert.equal(inbox.gmailEntry('gmail:2044').gmail.path, 'INBOX');
  assert.equal(gi.status().last.scanned, 6, 'Settings reads the pass');

  // Nothing re-read: the cursor moved past 48.
  srv.ranges.length = 0;
  await inbox.refreshMailbox('gmail', { deps: { imap: srv.imap } });
  assert.equal(srv.ranges.some((x) => x.includes(':')), false, 'no range scan when nothing is new');

  // The backfill Nick asked for: days are 1–90, refused not clamped; it judges the window once.
  for (const bad of [0, 91, 1.5, 'x', undefined]) assert.equal((await inbox.backfillGmail(bad, { deps: { imap: srv.imap } })).ok, false, String(bad));
  const b = await inbox.backfillGmail(30, { deps: { imap: srv.imap, now: () => Date.parse('2026-10-12T12:00:00Z') } });
  assert.equal(b.ok, true);
  assert.deepEqual(inbox.list('gmail').map((m) => m.id), ['gmail:2046', 'gmail:2045', 'gmail:2044', 'gmail:2041'], 'the old Important one comes in; the old Zilch mailing-list mail does not');
  assert.equal(JSON.parse(db.getState(gi.WATERMARK_KEY)).backfill.days, 30);

  // Always show: Zilch is pulled in from the last 30 days and kept from now on.
  const k = await inbox.setGmailSender('@payzilch.com', 'keep', { deps: { imap: srv.imap, now: () => Date.parse('2026-10-12T12:00:00Z') } });
  assert.equal(k.pulled, 1);
  assert.equal(inbox.list('gmail').find((m) => m.id === 'gmail:2040').why, 'On your always-show list');
  assert.equal((await inbox.setGmailSender('payzilch', 'keep')).ok, false, 'not an address or @domain');

  // Stop showing: gone at once and on every pass after, Gmail untouched.
  await inbox.setGmailSender('lizzy@example.com', 'hide');
  assert.equal(inbox.list('gmail').some((m) => m.id === 'gmail:2045'), false);
  await inbox.refreshMailbox('gmail', { deps: { imap: srv.imap } });
  assert.equal(inbox.list('gmail').some((m) => m.id === 'gmail:2045'), false);
  assert.equal(srv.messages.some((m) => m.uid === 45), true, 'still in Gmail');
  assert.deepEqual(inbox.gmailRules().hide, ['lizzy@example.com']);

  // Archived in Gmail (left the inbox) → leaves; read in Gmail → read here.
  srv.messages = srv.messages.filter((m) => m.uid !== 46);
  srv.messages.find((m) => m.uid === 44).flags = new Set(['\\Seen']);
  await inbox.refreshMailbox('gmail', { deps: { imap: srv.imap } });
  assert.equal(inbox.list('gmail').some((m) => m.id === 'gmail:2046'), false);
  assert.equal(inbox.list('gmail').find((m) => m.id === 'gmail:2044').seen, true);

  // Delete moves it to Gmail's Bin, from the inbox.
  const d = await inbox.trash('gmail:2044', { deps: { imap: srv.imap } });
  assert.deepEqual(d, { deleted: true, to: '[Gmail]/Bin' });
  assert.deepEqual(srv.moved, [{ from: 'INBOX', uid: '44', to: '[Gmail]/Bin' }]);

  // An unreadable Gmail is a recorded gap, never an empty tab.
  const before = inbox.list('gmail').length;
  srv.connectFails = true;
  r = await inbox.refreshMailbox('gmail', { deps: { imap: srv.imap } });
  assert.equal(r.ok, false);
  assert.equal(gi.status().last.ok, false);
  assert.equal(inbox.list('gmail').length, before);
  assert.equal(inbox.INBOXES.includes('gmail'), true);
});

test('delete MOVES to the mailbox\'s Trash (recoverable), and refuses when the folder was renumbered', async () => {
  const srv = fasthosts({ INBOX: { messages: [mail(1), mail(2)] }, Trash: { messages: [] } });
  const moves = [];
  const imap = () => { const c = srv.imap(); c.list = async () => [{ path: 'INBOX', specialUse: '\\Inbox' }, { path: 'Trash', specialUse: '\\Trash' }]; c.messageMove = async (uid, to) => { moves.push({ uid, to }); }; return c; };
  db.run("DELETE FROM personal_inbox WHERE mailbox = 'contact'");
  await inbox.refreshMailbox('contact', { deps: { imap } });
  let r = await inbox.trash('pmail:contact:5:2', { deps: { imap } });
  assert.deepEqual(r, { deleted: true, to: 'Trash' });
  assert.deepEqual(moves, [{ uid: '2', to: 'Trash' }]);
  assert.deepEqual(inbox.list('contact').map((m) => m.id), ['pmail:contact:5:1']);
  r = await inbox.trash('pmail:contact:4:1', { deps: { imap } });
  assert.deepEqual([r.deleted, r.reason], [false, 'renumbered'], 'a uid from an old numbering could name another message');
  assert.equal(moves.length, 1);
});

test('compose: refuses an unknown or unready From, empty fields and bad addresses; prepares with the chosen mailbox bound', () => {
  const pa = require('./prepared-actions');
  const registry = require('./action-registry');
  assert.equal(pa.prepareCompose({ from: 'saim', to: ['a@b.co'], subject: 's', body: 'b' }).ok, false, 'SAiM is NEURO\'s voice, not Nick\'s');
  assert.equal(pa.prepareCompose({ from: 'nick', to: [], subject: 's', body: 'b' }).ok, false);
  assert.equal(pa.prepareCompose({ from: 'nick', to: ['not-an-address'], subject: 's', body: 'b' }).ok, false);
  assert.equal(pa.prepareCompose({ from: 'nick', to: ['a@b.co'], subject: '', body: 'b' }).ok, false);
  const r = pa.prepareCompose({ from: 'nick', to: ['helen@example.com'], cc: ['mum@example.org'], subject: 'Saturday', body: 'See you at 10.' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.action.target.mailbox, 'nick');
  assert.equal(r.action.sendsFrom.address, 'nick@nickward.co.uk');
  assert.equal(r.action.origin, 'composer', 'sent on the click');
  assert.notEqual(r.action.payloadHash, registry.payloadHash({ actionType: 'compose_email', version: 1, commitmentId: r.action.commitmentId, target: { ...r.action.target, mailbox: 'contact' }, draft: r.action.draft }), 'the From is bound');
  const w = pa.prepareCompose({ from: 'work', to: ['chris.middleton@nurtur.tech'], subject: 'x', body: 'y' });
  assert.equal(w.action.sendsFrom.address, 'nickw@nurtur.tech');
  assert.ok(registry.canExecute('compose_email'));
});

test('a composed email from nick@: approved with the code, sent from nick@ over SMTP, verified in Sent — Graph untouched', async () => {
  const pa = require('./prepared-actions');
  const ex = require('./action-executor');
  const proofs = require('./approval-proof');
  const papi = require('./personal-mail-api');
  if (!proofs.codeStatus().set) assert.equal(proofs.setCode('pinbox approval code').ok, true);
  const NOW = Date.now();
  const r = pa.prepareCompose({ from: 'nick', to: ['helen@example.com'], subject: 'Saturday walk', body: 'Catbells at 10?', now: NOW });
  const a = r.action;
  const sent = [];
  const transport = {
    smtpSend: async (key, m) => { sent.push({ key, m }); return { outcome: 'accepted', status: 250 }; },
    findInSent: async (key, mid) => { const s = sent.find((x) => x.m.messageId === mid); return { ok: true, messages: s ? [{ id: '1', internetMessageId: mid, subject: s.m.subject, to: s.m.to.map((x) => x.address), cc: [], bcc: [], from: 'nick@nickward.co.uk', sentAt: new Date(NOW + 300000).toISOString(), conversationId: null, bodyText: null }] : [] }; },
    sentInThreadSince: async () => ({ count: 0 }),
  };
  const ch = proofs.issue({ actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, now: NOW + 60000 });
  assert.equal(pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, challengeId: ch.challengeId, approvalCode: 'pinbox approval code', now: NOW + 60000, sending: () => true }).ok, true);
  const graph = new Proxy({}, { get: (t, k) => async () => { throw new Error(`Graph mail.${String(k)} called for a nick@ compose`); } });
  const x = await ex.execute(a.actionId, { now: NOW + 120000, deps: { mail: graph, enabled: () => true, personalMail: (box) => papi.forMailbox(box, { smtp: { transport }, transport }) } });
  assert.equal(x.status, 'verified', JSON.stringify(x));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].m.from, '"Nick Ward" <nick@nickward.co.uk>');
  assert.deepEqual(sent[0].m.to.map((t) => t.address), ['helen@example.com']);
  assert.equal(sent[0].m.inReplyTo, undefined, 'a new email, not a reply');
});

test('compose routes: From options and a suggestion — a work recipient suggests work, a mix is ASKED about', async () => {
  const express = require('express');
  const app = express(); app.use(express.json()); app.use('/api/personal-inbox', require('../routes/personal-inbox'));
  const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await (await fetch(`${base}/api/personal-inbox/compose/options`)).json();
    assert.deepEqual(r.options.map((o) => o.key), ['work', 'nick', 'contact', 'gmail']);
    assert.equal(r.suggestion, null);
    r = await (await fetch(`${base}/api/personal-inbox/compose/options?to=${encodeURIComponent('chris.middleton@nurtur.tech')}`)).json();
    assert.equal(r.suggestion.mailbox, 'work');
    r = await (await fetch(`${base}/api/personal-inbox/compose/options?to=${encodeURIComponent('chris.middleton@nurtur.tech,stranger@example.net')}`)).json();
    assert.equal(r.suggestion.ask, true);
    r = await (await fetch(`${base}/api/personal-inbox/compose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'contact', to: ['x@y.co'], subject: 'Hi', body: 'Hello' }) })).json();
    assert.equal(r.ok, true); assert.equal(r.action.sendsFrom.address, 'contact@nickward.co.uk');
  } finally { server.closeAllConnections?.(); server.close(); }
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
