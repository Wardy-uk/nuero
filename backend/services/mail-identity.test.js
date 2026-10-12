'use strict';

// Which address an email goes from (12 Oct 2026), and the SMTP transport that
// makes a personal address real. Real DB, real ledger, real hike tick; the SMTP
// network is faked BELOW the adapter (transport.smtpSend / findInSent), and one
// test drives the real nodemailer against a local SMTP server.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mailid-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'm.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.HA_TOKEN = '';
process.env.HA_URL = 'http://127.0.0.1:9';

const db = require('../db/database');
const pm = require('./personal-mail');
const mi = require('./mail-identity');
const smtpMail = require('./smtp-mail');
const transport = require('./personal-mail-transport');
const hike = require('./hike-safety');
const model = require('./hike-safety-model');
const ew = require('./external-writes');
const registry = require('./action-registry');

test.before(async () => { await db.init(); });

function resetMail() {
  db.setState(pm._internals.CRED_STATE, '');
  db.setState(pm._internals.CHECK_STATE, '');
  db.run('DELETE FROM smtp_outbox');
}

// ── who it goes from ────────────────────────────────────────────────────────

test('the work address is ONE fact: mail-identity owns it and it equals email-sender\'s', () => {
  assert.equal(mi.WORK_ADDRESS, require('./email-sender').OWN_ADDRESS);
  assert.equal(mi.workSender().from, '"Nick Ward" <nickw@nurtur.tech>');
});

test('every executable governed type sends as the work address — derived from the executor, so card and send agree', () => {
  for (const type of registry.executableTypes()) {
    const s = mi.forAction({ actionType: type });
    assert.equal(s.mailbox, 'work', type);
    assert.match(registry.policyFor(type).executor, /^microsoft\./, `${type}: if this executor changes, forAction must change with it`);
  }
  assert.equal(mi.forAction({ actionType: 'draft_update_email' }), null, 'a prepare-only type sends nothing, so claims no From');
  assert.equal(mi.forAction({ actionType: 'chase_agenda' }).kind, 'email');
  assert.equal(mi.forAction({ actionType: 'create_calendar_event' }).kind, 'invite');
});

test('who sees it decides: work → work, personal → nick@, a reply → its own mailbox, mixed or unknown → ASK', () => {
  const lookups = {
    person: (a) => ({ 'helen@example.com': { name: 'Helen', sphere: 'personal' }, 'pat@agency.com': { name: 'Pat', sphere: 'work' }, 'sam@x.com': { name: 'Sam', sphere: 'both' }, 'jo@x.com': { name: 'Jo', sphere: 'unknown' } }[a] || null),
    personalList: (a) => a === 'mum@example.org',
  };
  assert.equal(mi.decide({ recipients: ['chris.middleton@nurtur.tech', 'pat@agency.com'], lookups }).mailbox, 'work');
  assert.equal(mi.decide({ recipients: ['helen@example.com', 'mum@example.org'], lookups }).mailbox, 'nick');
  const mixed = mi.decide({ recipients: ['helen@example.com', 'chris.middleton@nurtur.tech'], lookups });
  assert.equal(mixed.ask, true); assert.match(mixed.why, /both work and personal/);
  assert.equal(mi.decide({ recipients: ['stranger@example.net'], lookups }).ask, true, 'nobody NEURO knows is asked about, never guessed');
  assert.equal(mi.decide({ recipients: ['sam@x.com'], lookups }).ask, true, 'both = cannot tell which hat');
  assert.equal(mi.decide({ recipients: ['jo@x.com'], lookups }).ask, true);
  assert.equal(mi.decide({ recipients: [], lookups }).ask, true);
  assert.deepEqual(mi.decide({ kind: 'reply', sourceMailbox: 'gmail' }).mailbox, 'gmail');
  assert.equal(mi.decide({ kind: 'reply' }).ask, true, 'a reply whose mailbox is unknown is asked about');
  assert.equal(mi.decide({ kind: 'neuro' }).mailbox, 'saim');
});

test('NEURO-written mail: saim@ when usable, else work — and it says why', () => {
  resetMail();
  let s = mi.forNeuroGenerated();
  assert.equal(s.mailbox, 'work');
  assert.match(s.why, /saim@nickward\.co\.uk has no password/);
  pm.setCredential('saim', { password: 'pw' });
  s = mi.forNeuroGenerated();
  assert.equal(s.mailbox, 'saim');
  assert.equal(s.from, '"SAiM (for Nick Ward)" <saim@nickward.co.uk>');
  assert.equal(s.replyTo, 'nick@nickward.co.uk');
  assert.equal(s.fallback.address, 'nickw@nurtur.tech');
  pm.recordCheck('saim', { at: 'x', ok: false, imap: { ok: true }, smtp: { ok: false, error: 'login refused' } });
  assert.equal(mi.forNeuroGenerated().mailbox, 'work', 'a mailbox that failed its check is not trusted with an alert');
});

// ── the SMTP adapter: same rules as the Graph one ──────────────────────────

test('classifySend: a server answer or a connect-phase failure is PROVEN unsent; silence after the message started is uncertain', () => {
  assert.equal(transport.classifySend(Object.assign(new Error('550 no such user'), { responseCode: 550, command: 'RCPT TO' })).outcome, 'rejected');
  assert.equal(transport.classifySend(Object.assign(new Error('Invalid login'), { code: 'EAUTH', command: 'AUTH PLAIN' })).outcome, 'rejected');
  assert.equal(transport.classifySend(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT', command: 'CONN' })).outcome, 'rejected');
  assert.equal(transport.classifySend(Object.assign(new Error('Connection closed'), { code: 'ECONNECTION', command: 'DATA' })).outcome, 'uncertain');
  assert.equal(transport.classifySend(Object.assign(new Error('socket hang up'), { code: 'ESOCKET' })).outcome, 'uncertain');
});

test('the adapter writes "sending" BEFORE the network, never resends an uncertain one, and a refusal stays a resendable draft', async () => {
  resetMail();
  pm.setCredential('saim', { password: 'pw' });
  let outcome = 'uncertain'; const calls = [];
  const adapter = smtpMail.forMailbox('saim', { transport: {
    smtpSend: async (key, msg) => {
      calls.push(msg.messageId);
      assert.equal(db.get('SELECT state FROM smtp_outbox WHERE message_id = ?', [msg.messageId]).state, 'sending', 'the ledger row says sending before anything leaves');
      return outcome === 'rejected' ? { outcome: 'rejected', status: 550 } : { outcome };
    },
    findInSent: async () => ({ ok: true, messages: [] }),
  } });
  const d = adapter.createDraft({ to: [{ email: 'helen@example.com', name: 'Helen' }], subject: 's', body: 'b' });
  assert.ok(d.ok); assert.match(d.internetMessageId, /^<neuro-[0-9a-f]+@nickward\.co\.uk>$/);
  assert.equal(await adapter.draftState(d.id), 'draft');
  assert.equal((await adapter.sendDraft(d.id)).outcome, 'uncertain');
  assert.equal(await adapter.draftState(d.id), 'unavailable', 'it MAY have gone');
  assert.equal((await adapter.sendDraft(d.id)).outcome, 'uncertain');
  assert.equal(calls.length, 1, 'an uncertain send is never sent again by the adapter');

  outcome = 'rejected';
  const d2 = adapter.createDraft({ to: [{ email: 'helen@example.com' }], subject: 's', body: 'b' });
  assert.equal((await adapter.sendDraft(d2.id)).outcome, 'rejected');
  assert.equal(await adapter.draftState(d2.id), 'draft', 'proven unsent');
  outcome = 'accepted';
  assert.equal((await adapter.sendDraft(d2.id)).outcome, 'accepted');
  assert.equal(await adapter.draftState(d2.id), 'not-draft');
  assert.equal((await adapter.sendDraft(d2.id)).outcome, 'accepted');
  assert.equal(calls.length, 3, 'a sent draft is never sent twice');
  assert.equal(adapter.createDraft.length >= 0, true);
  resetMail();
  assert.equal(smtpMail.forMailbox('saim').createDraft({ to: [], subject: '', body: '' }).ok, false, 'no password, no draft');
  assert.throws(() => smtpMail.forMailbox('neuro'), /not a sending mailbox/);
});

function fakeSmtp() {
  const received = [];
  const srv = net.createServer((sock) => {
    let data = false; let buf = '';
    sock.write('220 local ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (data) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end >= 0) { received.push(buf.slice(0, end)); buf = buf.slice(end + 5); data = false; sock.write('250 2.0.0 queued\r\n'); }
        return;
      }
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^(EHLO|HELO)/i.test(line)) sock.write('250-local\r\n250 8BITMIME\r\n');
        else if (/^DATA/i.test(line)) { data = true; sock.write('354 go\r\n'); break; }
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
  });
  return { srv, received };
}

test('the REAL smtpSend: SAiM\'s From and Reply-To, the stored Message-ID, and the IDENTICAL bytes filed in Fasthosts Sent', async () => {
  resetMail();
  pm.setCredential('saim', { password: 'pw' });
  const { srv, received } = fakeSmtp();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const appended = [];
  const realSmtp = transport.defaultDeps().smtp;
  try {
    const adapter = smtpMail.forMailbox('saim', { transportDeps: {
      smtp: (cfg) => { assert.equal(cfg.host, 'smtp.livemail.co.uk'); return realSmtp({ host: '127.0.0.1', port, secure: false, ignoreTLS: true }); },
      imap: () => ({ on() {}, async connect() {}, async logout() {}, async list() { return [{ path: 'Sent', specialUse: '\\Sent' }]; }, async append(p, raw, flags) { appended.push({ p, raw: String(raw), flags }); } }),
    } });
    const d = adapter.createDraft({ to: [{ email: 'helen@example.com', name: 'Helen' }], subject: 'Nick hasn’t checked in', body: 'Route card…', attachments: [{ name: 'walk.gpx', contentType: 'application/gpx+xml', text: '<gpx/>' }] });
    const s = await adapter.sendDraft(d.id);
    assert.equal(s.outcome, 'accepted');
    assert.equal(received.length, 1);
    const raw = received[0];
    assert.match(raw, /^From: "SAiM \(for Nick Ward\)" <saim@nickward\.co\.uk>/m);
    assert.match(raw, /^Reply-To: nick@nickward\.co\.uk/m);
    assert.match(raw, /^To: Helen <helen@example\.com>/m);
    assert.ok(raw.includes(d.internetMessageId), 'the Message-ID stored before sending is the one sent');
    assert.match(raw, /walk\.gpx/);
    assert.equal(appended.length, 1);
    assert.equal(appended[0].p, 'Sent');
    assert.ok(appended[0].raw.includes(d.internetMessageId));
    assert.equal(appended[0].raw.replace(/\r\n$/, ''), raw.replace(/\r\n$/, ''), 'the Sent copy is the bytes that were sent');
    assert.equal(db.get('SELECT appended FROM smtp_outbox WHERE id = ?', [d.id]).appended, 1);
  } finally { srv.close(); }
});

test('Fasthosts answers a Message-ID HEADER search with nothing (live, 12 Oct) — NEURO finds it by reading envelopes', async () => {
  resetMail();
  pm.setCredential('saim', { password: 'pw' });
  pm.setCredential('nick', { password: 'pw' });
  const id = 'neuro-b83066fcd9ed707c23193a01@nickward.co.uk';
  const queries = [];
  // The live server, as measured: the message is in the folder, header search says [].
  const fasthosts = () => ({
    on() {}, async connect() {}, async logout() {},
    async list() { return [{ path: 'INBOX', specialUse: '\\Inbox' }, { path: 'Sent', specialUse: '\\Sent' }, { path: 'Junk', specialUse: '\\Junk' }]; },
    async getMailboxLock() { return { release() {} }; },
    async search(q) { queries.push(q); return q.header ? [] : [11, 12]; },
    async *fetch() {
      yield { uid: 11, envelope: { messageId: '<someone-else@x>' } };
      yield { uid: 12, envelope: { messageId: `<${id}>` }, headers: Buffer.from('') };
    },
    async fetchOne() { return { headers: Buffer.from('Authentication-Results: mx.livemail.co.uk; spf=pass; dkim=pass header.d=nickward.co.uk; dmarc=pass\r\n') }; },
  });
  const sent = await transport.findInSent('saim', `<${id}>`, { imap: fasthosts });
  assert.equal(sent.ok, true);
  assert.equal(sent.messages.length, 1, 'found by envelope, not by the server search');
  assert.ok(queries.every((q) => !q.header), 'off Gmail the header search is never relied on');
  const inbox = await transport.findByMessageId('nick', pm.credentialFor('nick'), `<${id}>`, transport.defaultDeps && { ...transport.defaultDeps(), imap: fasthosts });
  assert.equal(inbox.found, true);
  assert.equal(inbox.folder, 'Inbox');
  const missing = await transport.findInSent('saim', '<not-there@x>', { imap: fasthosts });
  assert.deepEqual([missing.ok, missing.messages.length], [true, 0]);
});

// ── the hike alert goes from saim@, work as the fallback ────────────────────

const L = (s) => model.localToMs(s);
function hikeFakes({ smtp = () => ({ outcome: 'accepted' }), graph = () => 'accepted', inSent = () => [] } = {}) {
  const f = { graphDrafts: [], smtpSends: [], smtpLooks: [], pushes: [] };
  const smtpTransport = {
    smtpSend: async (key, msg) => { f.smtpSends.push({ key, msg }); return smtp(msg); },
    findInSent: async (key, mid) => { f.smtpLooks.push({ key, mid }); return { ok: true, messages: inSent(mid), evidence: 'NEURO’s own copy in Sent' }; },
  };
  f.deps = {
    mailReady: async () => true,
    fetchStates: async () => [],
    push: async (title, body, data) => { f.pushes.push({ title, body, data }); },
    smtpFor: (key) => smtpMail.forMailbox(key, { transport: smtpTransport }),
    mail: {
      createDraft: async (m) => { const id = `g${f.graphDrafts.length + 1}`; f.graphDrafts.push({ id, ...m, state: 'draft' }); return { ok: true, id, internetMessageId: `<${id}@graph>` }; },
      sendDraft: async (id) => { const o = graph(id); const d = f.graphDrafts.find((x) => x.id === id); if (o === 'accepted' && d) d.state = 'gone'; return { outcome: o, status: o === 'accepted' ? 202 : 400 }; },
      draftState: async (id) => { const d = f.graphDrafts.find((x) => x.id === id); return d ? d.state : 'unavailable'; },
      findSent: async () => { throw new Error('Graph Sent Items must not be asked about a saim@ send'); },
    },
  };
  return f;
}

async function armHike(f) {
  db.run('DELETE FROM hike_trips'); db.run('DELETE FROM hike_breadcrumbs');
  db.run("DELETE FROM external_write_ledger WHERE writer = 'hike.safety-alert'");
  hike.setContacts([{ name: 'Helen', email: 'helen@example.com' }]);
  const r = await hike.arm({ name: 'Catbells', plannedStart: '2026-10-11T09:30', plannedFinish: '2026-10-11T15:00' }, { now: L('2026-10-11T08:00'), deps: f.deps });
  assert.ok(r.ok, r.error);
  return r.trip.tripId;
}

test('with saim@ set up, the overdue alert and the all-clear go from SAiM, and the read says so', async () => {
  resetMail();
  pm.setCredential('saim', { password: 'pw' });
  const f = hikeFakes();
  const id = await armHike(f);
  const before = hike.read({ now: L('2026-10-11T10:00') });
  assert.equal(before.sendsFrom.from, '"SAiM (for Nick Ward)" <saim@nickward.co.uk>');
  assert.equal(before.sendsFrom.fallback, 'nickw@nurtur.tech');
  await hike.tick({ now: L('2026-10-11T16:00'), deps: f.deps });
  assert.equal(f.smtpSends.length, 1); assert.equal(f.graphDrafts.length, 0);
  assert.equal(f.smtpSends[0].msg.from, '"SAiM (for Nick Ward)" <saim@nickward.co.uk>');
  assert.equal(f.smtpSends[0].msg.replyTo, 'nick@nickward.co.uk');
  assert.match(f.smtpSends[0].msg.subject, /checked in from his walk/);
  const row = db.get('SELECT alert_mailbox, alert_status FROM hike_trips WHERE trip_id = ?', [id]);
  assert.deepEqual(row, { alert_mailbox: 'saim', alert_status: 'sent' });
  assert.equal(hike.read({ now: L('2026-10-11T16:01') }).active.alert.sentFrom, 'saim@nickward.co.uk');
  await hike.tick({ now: L('2026-10-11T16:01'), deps: f.deps });
  assert.equal(f.smtpSends.length, 1, 'never twice once accepted');
  const c = await hike.checkIn(id, { via: 'NEURO', now: L('2026-10-11T16:20'), deps: f.deps });
  assert.equal(c.allClear.outcome, 'sent'); assert.equal(c.allClear.mailbox, 'saim');
  assert.equal(f.smtpSends.length, 2); assert.match(f.smtpSends[1].msg.subject, /checked in/);
});

test('saim@ REFUSES the alert → the work address sends it in the SAME pass (a duplicate beats none)', async () => {
  resetMail();
  pm.setCredential('saim', { password: 'pw' });
  const f = hikeFakes({ smtp: () => ({ outcome: 'rejected', status: 535, category: 'auth' }) });
  const id = await armHike(f);
  await hike.tick({ now: L('2026-10-11T16:00'), deps: f.deps });
  assert.equal(f.smtpSends.length, 1);
  assert.equal(f.graphDrafts.length, 1, 'fell back to work at once');
  const row = db.get('SELECT alert_mailbox, alert_status FROM hike_trips WHERE trip_id = ?', [id]);
  assert.deepEqual(row, { alert_mailbox: 'work', alert_status: 'sent' });
  assert.equal(hike.read({ now: L('2026-10-11T16:01') }).active.alert.sentFrom, 'nickw@nurtur.tech', 'the page says where it actually went from');
});

test('an UNCERTAIN saim@ send is checked in saim@\'s Sent — never Graph\'s, never resent blind', async () => {
  resetMail();
  pm.setCredential('saim', { password: 'pw' });
  let mid = null;
  const f = hikeFakes({ smtp: (msg) => { mid = msg.messageId; return { outcome: 'uncertain' }; }, inSent: (m) => (m === mid ? [{ internetMessageId: m }] : []) });
  const id = await armHike(f);
  await hike.tick({ now: L('2026-10-11T16:00'), deps: f.deps });
  assert.equal(db.get('SELECT alert_status s FROM hike_trips WHERE trip_id = ?', [id]).s, 'uncertain');
  await hike.tick({ now: L('2026-10-11T16:01'), deps: f.deps });
  assert.deepEqual(f.smtpLooks.map((l) => l.key), ['saim']);
  assert.equal(f.smtpSends.length, 1, 'found in Sent, so not sent again');
  assert.equal(db.get('SELECT alert_status s FROM hike_trips WHERE trip_id = ?', [id]).s, 'confirmed');
  assert.match(ew.byKey(`hike-alert:${id}`).readback || '', /own copy in Sent/);
});

test('without saim@ the alert goes from work, exactly as before', async () => {
  resetMail();
  const f = hikeFakes();
  await armHike(f);
  await hike.tick({ now: L('2026-10-11T16:00'), deps: f.deps });
  assert.equal(f.smtpSends.length, 0); assert.equal(f.graphDrafts.length, 1);
  assert.match(hike.read({ now: L('2026-10-11T16:01') }).sendsFrom.why, /has no password/);
});

// ── the screens show it ─────────────────────────────────────────────────────

async function bundle(file) {
  const out = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', file)], bundle: true, write: false,
    format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      b.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl = p => p; export const apiFetch = () => Promise.resolve({ json: () => ({}) });', loader: 'js' }));
    } }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

test('the approval card shows From — taken from the shaped action the server sends', async () => {
  const { PreparedCard } = await bundle('PreparedActions.jsx');
  const pa = require('./prepared-actions');
  // A REAL prepared row, read back through the real shaping.
  const start = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 19);
  const prep = pa.prepareAgendaChase({ event: { id: 'evt-mailid-1', start, subject: 'Q4 planning', organizer: { email: 'chris.middleton@nurtur.tech', name: 'Chris Middleton' } }, body: 'Hi Chris, what is this one for?' });
  assert.ok(prep.ok, prep.error);
  const action = pa.get(prep.action.actionId);
  assert.equal(action.sendsFrom.address, 'nickw@nurtur.tech');
  assert.equal(action.sendsFrom.via, 'Microsoft (Outlook)');
  const html = renderToString(React.createElement(PreparedCard, { action, busy: false, onApprove() {}, onReject() {}, onEdit: async () => true }));
  assert.match(html, /data-testid="pa-sends-from"/);
  assert.match(html, /<dt>From<\/dt><dd class="mono">nickw@nurtur\.tech/);
  const invite = renderToString(React.createElement(PreparedCard, { action: { ...action, actionType: 'create_calendar_event', sendsFrom: mi.forAction({ actionType: 'create_calendar_event' }) }, busy: false, onApprove() {}, onReject() {}, onEdit: async () => true }));
  assert.match(invite, /<dt>Invite from<\/dt>/);
});

test('the hike page shows where the alert sends from, before and after', async () => {
  const { HikeSafetyView } = await bundle('canonical/HikeSafetyCard.jsx');
  resetMail();
  pm.setCredential('saim', { password: 'pw' });
  const f = hikeFakes();
  await armHike(f);
  const clean = (h) => h.replace(/<!-- -->/g, '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  let html = clean(renderToString(React.createElement(HikeSafetyView, { data: hike.read({ now: L('2026-10-11T10:00') }) })));
  assert.match(html, /Alert sends from <strong>"SAiM \(for Nick Ward\)" <saim@nickward\.co\.uk><\/strong> · replies to nick@nickward\.co\.uk · if that fails, from nickw@nurtur\.tech/);
  await hike.tick({ now: L('2026-10-11T16:00'), deps: f.deps });
  html = clean(renderToString(React.createElement(HikeSafetyView, { data: hike.read({ now: L('2026-10-11T16:05') }) })));
  assert.match(html, /\(from saim@nickward\.co\.uk\)/);
});
