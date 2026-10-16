'use strict';

// Attachments on a governed email (16 Oct 2026). The bytes are stored by
// content hash, the draft carries references, payloadHash binds them, and the
// executor re-hashes, attaches, READS BACK and only then sends.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mailatt-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'a.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
delete process.env.GOVERNED_EXECUTION_ENABLED;

function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
stub('./webpush', { sendToAll: async () => {}, isConfigured: () => true });
stub('./email-sender', { sendMail: async () => { throw new Error('email-sender reached'); }, OWN_ADDRESS: 'nickw@nurtur.tech' });
stub('./teams', { getSendStatus: async () => ({ available: false }) });

const db = require('../db/database');
const att = require('./mail-attachments');
const pm = require('./personal-mail');
const registry = require('./action-registry');

const CODE = 'mailatt approval code';
const b64 = (s) => Buffer.from(s).toString('base64');
const sha = (s) => crypto.createHash('sha256').update(Buffer.from(s)).digest('hex');

test.before(async () => {
  await db.init();
  pm.setCredential('nick', { password: 'pw' });
  const proofs = require('./approval-proof');
  if (!proofs.codeStatus().set) assert.equal(proofs.setCode(CODE).ok, true);
});

test('validate: names cleaned, programs refused, limits refused not trimmed, junk refused, nothing is fine', () => {
  assert.deepEqual(att.validate(undefined), { ok: true, files: [] });
  assert.deepEqual(att.validate([]), { ok: true, files: [] });
  const ok = att.validate([{ name: 'C:\\Users\\x\\Quote.pdf', contentType: 'application/pdf', dataBase64: `data:application/pdf;base64,${b64('%PDF')}` }]);
  assert.equal(ok.ok, true);
  assert.equal(ok.files[0].name, 'Quote.pdf', 'no path survives');
  assert.equal(ok.files[0].buf.toString(), '%PDF', 'a data: prefix is stripped');
  assert.match(att.validate([{ name: 'run.exe', dataBase64: b64('MZ') }]).error, /program or script/);
  assert.match(att.validate([{ name: 'x.txt', dataBase64: '***' }]).error, /could not be read/);
  assert.match(att.validate([{ name: 'x.txt', dataBase64: '' }]).error, /could not be read/);
  assert.match(att.validate(Array.from({ length: 11 }, (_, i) => ({ name: `${i}.txt`, dataBase64: b64('x') }))).error, /at most 10/);
  const big = Buffer.alloc(att.MAX_TOTAL_BYTES + 1, 1).toString('base64');
  assert.match(att.validate([{ name: 'big.bin', dataBase64: big }]).error, /at most 20 MB/);
  assert.equal(att.validate([{ name: 'x.bin', contentType: 'nonsense type', dataBase64: b64('x') }]).files[0].contentType, 'application/octet-stream');
});

test('store + load: content-addressed, re-hashed on read; altered bytes are NOT returned', () => {
  const [ref] = att.store(att.validate([{ name: 'a.txt', contentType: 'text/plain', dataBase64: b64('hello') }]).files);
  assert.equal(ref.sha256, sha('hello'));
  assert.equal(att.load(ref).toString(), 'hello');
  db.run('UPDATE mail_attachments SET content = ? WHERE sha256 = ?', [Buffer.from('tampered'), ref.sha256]);
  assert.equal(att.load(ref), null, 'a file that no longer matches its hash is never sent');
  assert.equal(att.load({ sha256: 'nope' }), null);
});

test('prepare: the draft carries references (never bytes) and the hash BINDS them; no files = the old hash', () => {
  const pa = require('./prepared-actions');
  const NOW = Date.now();
  const plain = pa.prepareCompose({ from: 'nick', to: ['helen@example.com'], subject: 'Plain', body: 'No files', now: NOW });
  assert.equal(plain.ok, true);
  assert.equal('attachments' in plain.action.draft, false, 'no key at all when nothing is attached');

  const r = pa.prepareCompose({ from: 'nick', to: ['helen@example.com'], subject: 'Quote', body: 'Attached.', now: NOW,
    attachments: [{ name: 'quote.pdf', contentType: 'application/pdf', dataBase64: b64('PDFBYTES') }] });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.action.draft.attachments, [{ sha256: sha('PDFBYTES'), name: 'quote.pdf', contentType: 'application/pdf', size: 8 }]);
  assert.doesNotMatch(JSON.stringify(r.action), /UERGQllURVM=/, 'the base64 is not in the action');
  const a = r.action;
  const same = registry.payloadHash({ actionType: a.actionType, version: a.version, commitmentId: a.commitmentId, target: a.target, draft: a.draft });
  assert.equal(same, a.payloadHash);
  const swapped = registry.payloadHash({ actionType: a.actionType, version: a.version, commitmentId: a.commitmentId, target: a.target,
    draft: { ...a.draft, attachments: [{ ...a.draft.attachments[0], sha256: sha('OTHER') }] } });
  assert.notEqual(swapped, a.payloadHash, 'a different file is a different approval');

  const refused = pa.prepareCompose({ from: 'nick', to: ['helen@example.com'], subject: 'x', body: 'y', attachments: [{ name: 'evil.ps1', dataBase64: b64('x') }] });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /program or script/);
});

function approve(a, nowMs) {
  const pa = require('./prepared-actions');
  const proofs = require('./approval-proof');
  const ch = proofs.issue({ actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, now: nowMs });
  const r = pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, challengeId: ch.challengeId, approvalCode: CODE, now: nowMs, sending: () => true });
  assert.equal(r.ok, true, r.error);
}

test('nick@ over SMTP: the stored row holds a REFERENCE; the bytes reach the transport only at send; verified', async () => {
  const pa = require('./prepared-actions');
  const ex = require('./action-executor');
  const papi = require('./personal-mail-api');
  const NOW = Date.now();
  const a = pa.prepareCompose({ from: 'nick', to: ['helen@example.com'], subject: 'Photos', body: 'Two attached.', now: NOW,
    attachments: [{ name: 'one.jpg', contentType: 'image/jpeg', dataBase64: b64('JPEG-ONE') }, { name: 'two.jpg', contentType: 'image/jpeg', dataBase64: b64('JPEG-TWO') }] }).action;
  approve(a, NOW + 60000);
  const sent = [];
  const transport = {
    smtpSend: async (key, m) => {
      // At this point the outbox row must still hold only references.
      const row = db.get('SELECT message_json FROM smtp_outbox WHERE message_id = ?', [m.messageId]);
      assert.doesNotMatch(row.message_json, /SlBFRy1PTkU=/, 'no bytes in the outbox row');
      sent.push(m); return { outcome: 'accepted', status: 250 };
    },
    findInSent: async (key, mid) => { const s = sent.find((x) => x.messageId === mid); return { ok: true, messages: s ? [{ id: '1', internetMessageId: mid, subject: s.subject, to: s.to.map((x) => x.address), cc: [], bcc: [], from: 'nick@nickward.co.uk', sentAt: new Date(NOW + 300000).toISOString(), conversationId: null, bodyText: null }] : [] }; },
    sentInThreadSince: async () => ({ count: 0 }),
  };
  const graph = new Proxy({}, { get: (t, k) => async () => { throw new Error(`Graph ${String(k)} called`); } });
  const x = await ex.execute(a.actionId, { now: NOW + 120000, deps: { mail: graph, enabled: () => true, personalMail: (box) => papi.forMailbox(box, { smtp: { transport }, transport }) } });
  assert.equal(x.status, 'verified', JSON.stringify(x));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].attachments.map((f) => [f.filename, f.contentType, f.content.toString()]),
    [['one.jpg', 'image/jpeg', 'JPEG-ONE'], ['two.jpg', 'image/jpeg', 'JPEG-TWO']]);
});

// A Microsoft mailbox, faked at the transport interface the executor uses.
function fakeGraph({ dropAttachment = false, NOW }) {
  const drafts = new Map();
  const sent = [];
  let n = 0;
  return {
    sent, drafts,
    async createDraft(m) { n += 1; const id = `d${n}`; drafts.set(id, { ...m, files: [], imid: `<m${n}@x>` }); return { ok: true, id, internetMessageId: `<m${n}@x>`, status: 201 }; },
    async addAttachments(id, files) { const d = drafts.get(id); for (const f of files) d.files.push(f); return { ok: true }; },
    async listAttachments(id) { const names = drafts.get(id).files.map((f) => f.name); return { ok: true, names: dropAttachment ? names.slice(1) : names }; },
    async sendDraft(id) { sent.push(drafts.get(id)); return { outcome: 'accepted', status: 202 }; },
    async deleteDraft(id) { drafts.delete(id); return true; },
    async draftState(id) { return drafts.has(id) ? 'draft' : 'gone'; },
    async findSent(mid) { const s = sent.find((d) => d.imid === mid); return { ok: true, messages: s ? [{ id: 's', internetMessageId: mid, subject: s.subject, to: s.to.map((r) => r.email), cc: [], bcc: [], from: 'nickw@nurtur.tech', sentAt: new Date(NOW + 300000).toISOString(), conversationId: null, bodyText: null }] : [] }; },
    async signedInAddress() { return 'nickw@nurtur.tech'; },
    async sentToSince() { return { count: 0, subjects: [] }; },
  };
}

test('work (Graph): the exact bytes are attached and READ BACK before the send; verified', async () => {
  const pa = require('./prepared-actions');
  const ex = require('./action-executor');
  const NOW = Date.now();
  const a = pa.prepareCompose({ from: 'work', to: ['chris.middleton@nurtur.tech'], subject: 'Deck', body: 'Attached.', now: NOW,
    attachments: [{ name: 'deck.pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', dataBase64: b64('PPTX') }] }).action;
  approve(a, NOW + 60000);
  const mail = fakeGraph({ NOW });
  const x = await ex.execute(a.actionId, { now: NOW + 120000, deps: { mail, enabled: () => true } });
  assert.equal(x.status, 'verified', JSON.stringify(x));
  assert.equal(mail.sent.length, 1);
  assert.deepEqual(mail.sent[0].files.map((f) => [f.name, f.content.toString()]), [['deck.pptx', 'PPTX']]);
});

test('work (Graph): a draft that does NOT hold exactly the approved files is deleted and NOTHING is sent', async () => {
  const pa = require('./prepared-actions');
  const ex = require('./action-executor');
  const NOW = Date.now();
  const a = pa.prepareCompose({ from: 'work', to: ['chris.middleton@nurtur.tech'], subject: 'Two files', body: 'Both attached.', now: NOW,
    attachments: [{ name: 'a.txt', dataBase64: b64('A') }, { name: 'b.txt', dataBase64: b64('B') }] }).action;
  approve(a, NOW + 60000);
  const mail = fakeGraph({ dropAttachment: true, NOW });
  const x = await ex.execute(a.actionId, { now: NOW + 120000, deps: { mail, enabled: () => true } });
  assert.equal(x.status, 'failed');
  assert.equal(x.code, 'attachment-mismatch');
  assert.equal(mail.sent.length, 0, 'nothing sent');
  assert.equal(mail.drafts.size, 0, 'the half-attached draft was deleted');
});

test('a file that is no longer held stops the send BEFORE any draft exists', async () => {
  const pa = require('./prepared-actions');
  const ex = require('./action-executor');
  const NOW = Date.now();
  const a = pa.prepareCompose({ from: 'work', to: ['chris.middleton@nurtur.tech'], subject: 'Gone', body: 'Attached.', now: NOW,
    attachments: [{ name: 'gone.txt', dataBase64: b64('WILL-VANISH') }] }).action;
  approve(a, NOW + 60000);
  db.run('DELETE FROM mail_attachments WHERE sha256 = ?', [sha('WILL-VANISH')]);
  const mail = fakeGraph({ NOW });
  const x = await ex.execute(a.actionId, { now: NOW + 120000, deps: { mail, enabled: () => true } });
  assert.equal(x.status, 'failed');
  assert.equal(x.code, 'attachment-missing');
  assert.equal(mail.drafts.size, 0);
  assert.equal(mail.sent.length, 0);
});

test('commonChecks: attachments on a type that may not carry them are refused', () => {
  const ex = require('./action-executor');
  const NOW = Date.now();
  const mk = (actionType, attachments) => {
    const action = { actionType, version: 1, commitmentId: 'c', target: { kind: 'compose', mailbox: 'work' },
      draft: { to: [{ email: 'a@b.co' }], cc: [], subject: 's', body: 'b', attachments } };
    action.payloadHash = registry.payloadHash(action);
    action.approval = { payloadHash: action.payloadHash, expiresAt: new Date(NOW + 3600000).toISOString() };
    return ex.commonChecks({ action, policy: { ...registry.policyFor(actionType), executable: true }, nowMs: NOW });
  };
  // Positive control: the same shape passes on a type that allows them.
  assert.equal(mk('compose_email', [{ sha256: 'x', name: 'n', contentType: 't', size: 1 }]).ok, true);
  const policy = { ...registry.policyFor('compose_email'), attachments: false };
  const action = { actionType: 'compose_email', version: 1, commitmentId: 'c', target: { kind: 'compose', mailbox: 'work' },
    draft: { to: [{ email: 'a@b.co' }], cc: [], subject: 's', body: 'b', attachments: [{ sha256: 'x', name: 'n', contentType: 't', size: 1 }] } };
  action.payloadHash = registry.payloadHash(action);
  action.approval = { payloadHash: action.payloadHash, expiresAt: new Date(NOW + 3600000).toISOString() };
  const r = ex.commonChecks({ action, policy, nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'attachments-not-allowed');
});

test('prune: old bytes no live action needs are dropped; ones a live action needs are kept', () => {
  const pa = require('./prepared-actions');
  const NOW = Date.now();
  const live = pa.prepareCompose({ from: 'nick', to: ['helen@example.com'], subject: 'Keep', body: 'x', now: NOW, attachments: [{ name: 'keep.txt', dataBase64: b64('KEEP-ME') }] });
  assert.equal(live.ok, true);
  att.store(att.validate([{ name: 'old.txt', dataBase64: b64('ORPHAN') }]).files, { now: NOW });
  const old = new Date(NOW - 30 * 86400000).toISOString();
  db.run('UPDATE mail_attachments SET created_at = ? WHERE sha256 IN (?, ?)', [old, sha('KEEP-ME'), sha('ORPHAN')]);
  att.prune({ now: NOW });
  assert.ok(att.load({ sha256: sha('KEEP-ME') }), 'a prepared email still needs it');
  assert.equal(att.load({ sha256: sha('ORPHAN') }), null);
});
