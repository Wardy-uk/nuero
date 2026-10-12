'use strict';

// Personal mailboxes: credentials never come out, a test only ever goes to
// Nick's own mailboxes, and the verdict is the receiver's own words.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const http = require('http');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-pmail-')), 'a.db');

const db = require('../db/database');
const pm = require('./personal-mail');
const transport = require('./personal-mail-transport');

const SECRET = 'Correct-Horse-Battery-9!';
const GMAIL_APP = 'abcd efgh ijkl mnop';

// A real Gmail Authentication-Results block, folded as Gmail folds it.
const GMAIL_HEADERS = [
  'Delivered-To: nick.example@gmail.com',
  'Authentication-Results: mx.google.com;',
  '       dkim=pass header.i=@nickward.co.uk header.s=livemail1 header.b=Qx1;',
  '       spf=pass (google.com: domain of saim@nickward.co.uk designates 212.227.24.136 as permitted sender) smtp.mailfrom=saim@nickward.co.uk;',
  '       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=nickward.co.uk',
  'Authentication-Results: forged.example; dkim=fail',
  'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=nickward.co.uk; s=livemail1; h=from:to;',
  'From: "SAiM (for Nick Ward)" <saim@nickward.co.uk>',
  '',
].join('\r\n');

test.before(async () => { await db.init(); });

test('the registry: five mailboxes, verified hosts, each with one job', () => {
  assert.deepEqual(pm.KEYS, ['nick', 'saim', 'contact', 'neuro', 'gmail']);
  // ⚠ imap.livemail.co.uk resolves but times out — the live host is mail.livemail.co.uk.
  assert.equal(pm.PROVIDERS.fasthosts.imap.host, 'mail.livemail.co.uk');
  assert.equal(pm.PROVIDERS.fasthosts.smtp.host, 'smtp.livemail.co.uk');
  assert.equal(pm.PROVIDERS.gmail.imap.host, 'imap.gmail.com');
  for (const b of pm.MAILBOXES) assert.ok(b.job && b.job.length > 10, `${b.key} states its job`);
  assert.equal(pm.box('neuro').sends, false, 'neuro@ is a capture box, never a sender');
});

test('saim@ sends as SAiM with Reply-To nick@; nick@ as Nick; neuro@ sends as nobody', () => {
  const s = pm.senderFor('saim');
  assert.equal(s.from, '"SAiM (for Nick Ward)" <saim@nickward.co.uk>');
  assert.equal(s.replyTo, 'nick@nickward.co.uk');
  assert.equal(pm.senderFor('nick').from, '"Nick Ward" <nick@nickward.co.uk>');
  assert.equal(pm.senderFor('nick').replyTo, null);
  assert.equal(pm.senderFor('neuro'), null);
  assert.equal(pm.senderFor('gmail'), null, 'Gmail has no address until Nick gives one');
});

test('credential shape checks: Gmail needs a Gmail address and a 16-letter app password', () => {
  assert.equal(pm.validateCredential('nick', { password: '' }).ok, false);
  assert.equal(pm.validateCredential('nick', { password: 'a\nb' }).ok, false);
  assert.equal(pm.validateCredential('nick', { password: SECRET }).ok, true);
  assert.equal(pm.validateCredential('gmail', { address: 'nick@outlook.com', password: GMAIL_APP }).ok, false);
  assert.match(pm.validateCredential('gmail', { address: 'n@gmail.com', password: 'myNormalPassword1' }).error, /app password/);
  const ok = pm.validateCredential('gmail', { address: ' N.Example@GMail.com ', password: GMAIL_APP });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { address: 'n.example@gmail.com', password: 'abcdefghijklmnop' });
  assert.equal(pm.validateCredential('bogus', { password: 'x' }).ok, false);
});

test('test targets: only Nick\'s own configured mailboxes, never the sender, never neuro@, Gmail first', () => {
  assert.deepEqual(pm.testTargets('saim', ['nick', 'saim', 'contact', 'neuro', 'gmail']), ['gmail', 'nick', 'contact']);
  assert.deepEqual(pm.testTargets('nick', ['nick', 'saim']), ['saim']);
  assert.deepEqual(pm.testTargets('saim', ['saim']), []);
});

test('the verdict is the RECEIVER\'s Authentication-Results (the first), not a later forged one', () => {
  const v = pm.parseAuthResults(GMAIL_HEADERS);
  assert.equal(v.receiver, 'mx.google.com');
  assert.equal(v.spf, 'pass');
  assert.equal(v.dkim, 'pass');
  assert.equal(v.dkimDomain, 'nickward.co.uk');
  assert.equal(v.dmarc, 'pass');
  assert.equal(v.signedDomain, 'nickward.co.uk');
  assert.match(pm.verdictSummary(v), /all pass/);
  const none = pm.parseAuthResults('From: x\r\nTo: y\r\n');
  assert.equal(none.present, false);
  assert.match(pm.verdictSummary(none), /no verdict/);
  const fail = pm.parseAuthResults('Authentication-Results: mx.google.com; dkim=none; spf=softfail; dmarc=fail\r\n');
  assert.doesNotMatch(pm.verdictSummary(fail), /all pass/);
});

test('errors are classified without echoing a password', () => {
  const e = Object.assign(new Error(`Invalid login: 535 5.7.8 Authentication failed`), { code: 'EAUTH' });
  assert.equal(pm.classifyError(e).kind, 'auth');
  assert.equal(pm.classifyError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })).kind, 'timeout');
  assert.equal(pm.classifyError(Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' })).kind, 'network');
});

// ── Real HTTP: the password never comes back out ────────────────────────────

let server; let base;
test('routes: save, status, delete — and no response ever contains the password', async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/mail', require('../routes/personal-mail'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  const bodies = [];
  const req = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); bodies.push(text);
    return { status: r.status, body: JSON.parse(text) };
  };
  try {
    let r = await req('GET', '/api/mail/accounts');
    assert.equal(r.status, 200);
    assert.equal(r.body.mailboxes.length, 5);
    assert.ok(r.body.mailboxes.every((m) => m.configured === false), 'nothing configured is a normal state');
    assert.equal(r.body.mailboxes.find((m) => m.key === 'saim').sender.from, '"SAiM (for Nick Ward)" <saim@nickward.co.uk>', 'Settings shows who it sends as before anything is set');

    r = await req('POST', '/api/mail/accounts/nick/credential', { password: SECRET });
    assert.equal(r.status, 200);
    assert.equal(r.body.mailboxes.find((m) => m.key === 'nick').configured, true);
    r = await req('POST', '/api/mail/accounts/gmail/credential', { address: 'n.example@gmail.com', password: GMAIL_APP });
    assert.equal(r.status, 200);
    const g = r.body.mailboxes.find((m) => m.key === 'gmail');
    assert.equal(g.address, 'n.example@gmail.com');
    assert.equal(g.sender.address, 'n.example@gmail.com');

    r = await req('POST', '/api/mail/accounts/gmail/credential', { address: 'n@gmail.com', password: 'short' });
    assert.equal(r.status, 400);
    r = await req('POST', '/api/mail/accounts/bogus/credential', { password: 'x' });
    assert.equal(r.status, 404);

    // Refusals happen BEFORE the network.
    r = await req('POST', '/api/mail/accounts/saim/test-send', {});
    assert.equal(r.status, 409, 'saim@ has no password: refused');
    r = await req('POST', '/api/mail/accounts/nick/test-send', { to: 'stranger@example.com' });
    assert.equal(r.status, 400, 'a test never goes to anyone else');
    r = await req('POST', '/api/mail/accounts/nick/test-send', { to: 'neuro' });
    assert.equal(r.status, 400);
    r = await req('POST', '/api/mail/accounts/neuro/test-send', {});
    assert.equal(r.status, 400, 'neuro@ does not send');
    r = await req('POST', '/api/mail/accounts/contact/check', {});
    assert.equal(r.status, 409);

    r = await req('DELETE', '/api/mail/accounts/nick/credential');
    assert.equal(r.body.mailboxes.find((m) => m.key === 'nick').configured, false);
    r = await req('GET', '/api/mail/tests');
    assert.deepEqual(r.body.tests, []);

    const all = bodies.join('\n');
    assert.ok(all.includes('saim@nickward.co.uk'), 'positive control: responses were captured');
    assert.ok(!all.includes(SECRET) && !all.includes('abcdefghijklmnop') && !all.includes(GMAIL_APP), 'no password in any response');
    assert.ok(!all.includes(SECRET.slice(0, 8)));
  } finally {
    server.closeAllConnections?.(); server.close();
  }
});

// ── The real nodemailer against a local SMTP server ─────────────────────────

function fakeSmtp() {
  const received = [];
  const srv = net.createServer((sock) => {
    let data = false; let buf = '';
    sock.write('220 local ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (data) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end >= 0) { received.push(buf.slice(0, end)); buf = buf.slice(end + 5); data = false; sock.write('250 2.0.0 queued as T1\r\n'); }
        return;
      }
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^(EHLO|HELO)/i.test(line)) sock.write('250-local\r\n250 8BITMIME\r\n');
        else if (/^MAIL|^RCPT|^RSET|^NOOP/i.test(line)) sock.write('250 OK\r\n');
        else if (/^DATA/i.test(line)) { data = true; sock.write('354 go\r\n'); break; }
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
  });
  return { srv, received };
}

test('sendTest: the REAL nodemailer sends saim@ → Gmail with the right From/Reply-To/Message-ID, then reads the verdict back', async () => {
  pm.setCredential('saim', { password: SECRET });
  pm.setCredential('gmail', { address: 'n.example@gmail.com', password: GMAIL_APP });
  const { srv, received } = fakeSmtp();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  let searched = null;
  const fakeImap = () => ({
    on() {}, async connect() {}, async logout() {},
    async list() { return [{ path: '[Google Mail]/All Mail', specialUse: '\\All' }, { path: '[Google Mail]/Spam', specialUse: '\\Junk' }]; },
    async getMailboxLock() { return { release() {} }; },
    async search(q) { searched = q; return q.gmraw ? [42] : []; },
    async fetchOne() { return { headers: Buffer.from(GMAIL_HEADERS), labels: new Set(['\\Inbox']) }; },
  });
  try {
    const realSmtp = transport.defaultDeps().smtp;
    const r = await transport.sendTest('saim', null, {
      smtp: (cfg) => {
        // The provider config the real path would use — then pointed at the local server.
        assert.equal(cfg.host, 'smtp.livemail.co.uk');
        assert.equal(cfg.auth.user, 'saim@nickward.co.uk');
        return realSmtp({ host: '127.0.0.1', port, secure: false, ignoreTLS: true, auth: undefined });
      },
      imap: fakeImap, sleep: async () => {}, awaitReadback: true,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.test.to, 'n.example@gmail.com', 'Gmail is the default target');
    assert.equal(received.length, 1);
    const raw = received[0];
    assert.match(raw, /^From: "SAiM \(for Nick Ward\)" <saim@nickward\.co\.uk>/m);
    assert.match(raw, /^Reply-To: nick@nickward\.co\.uk/m);
    assert.match(raw, /^To: n\.example@gmail\.com/m);
    assert.ok(raw.includes(r.test.messageId), 'the Message-ID sent is the one read back');
    assert.ok(!raw.includes(SECRET));
    assert.deepEqual(searched, { gmraw: `rfc822msgid:${r.test.messageId.replace(/[<>]/g, '')}` });
    const t = pm.tests()[0];
    assert.equal(t.readback, 'found');
    assert.equal(t.folder, 'Inbox');
    assert.equal(t.verdict.dkim, 'pass');
    assert.match(t.summary, /all pass/);
  } finally { srv.close(); }
});

test('a test that never arrives is "not-found", never a pass', async () => {
  pm.setCredential('nick', { password: SECRET });
  const entry = { id: 'x1', messageId: '<neuro-test-x1@nickward.co.uk>' };
  pm.recordTest({ ...entry, readback: 'pending' });
  await transport.readBack(entry, 'nick', {
    imap: () => ({ on() {}, async connect() {}, async logout() {}, async list() { return []; }, async getMailboxLock() { return { release() {} }; }, async search() { return []; } }),
    sleep: async () => {},
  });
  const t = pm.tests().find((x) => x.id === 'x1');
  assert.equal(t.readback, 'not-found');
  assert.equal(t.verdict, undefined);
});

test('Gmail Important is found by its \\Important FLAG — imapflow leaves specialUse null for it (live list, 12 Oct 2026)', () => {
  const live = [
    { path: 'INBOX', specialUse: '\\Inbox', flags: new Set(['\\HasNoChildren']) },
    { path: '[Gmail]/All Mail', specialUse: '\\All', flags: new Set(['\\All', '\\HasNoChildren']) },
    { path: '[Gmail]/Important', specialUse: null, flags: new Set(['\\HasNoChildren', '\\Important']) },
    { path: 'Helen', specialUse: null, flags: new Set(['\\HasNoChildren']) },
  ];
  assert.equal(transport.importantFolder(live), '[Gmail]/Important');
  assert.equal(transport.importantFolder(live.filter((m) => m.path !== '[Gmail]/Important')), null);
});

test('a read-back a restart killed is reported interrupted, never pending for ever (read-time only)', () => {
  const sentAt = '2026-10-12T10:00:00.000Z';
  pm.recordTest({ id: 'stale1', messageId: '<x@y>', sentAt, readback: 'pending' });
  const at = (min) => Date.parse(sentAt) + min * 60000;
  assert.equal(pm.tests(at(2)).find((t) => t.id === 'stale1').readback, 'pending');
  const late = pm.tests(at(11)).find((t) => t.id === 'stale1');
  assert.equal(late.readback, 'interrupted');
  assert.doesNotMatch(late.readbackError, /pass/);
  assert.equal(pm.tests(at(2)).find((t) => t.id === 'stale1').readback, 'pending', 'nothing was stored by reading');
});

test('defaultDeps are the real libraries and construct offline', () => {
  const d = transport.defaultDeps();
  const t = d.smtp({ host: '127.0.0.1', port: 1, secure: false });
  assert.equal(typeof t.sendMail, 'function');
  const c = d.imap({ host: '127.0.0.1', port: 1, secure: false, logger: false, auth: { user: 'a', pass: 'b' } });
  assert.equal(typeof c.connect, 'function');
  assert.equal(transport.smtpConfig('saim', { address: 'saim@nickward.co.uk', password: 'p' }).port, 465);
  assert.equal(transport.imapConfig('gmail', { address: 'a@gmail.com', password: 'p' }).host, 'imap.gmail.com');
});
