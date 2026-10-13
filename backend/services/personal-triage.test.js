'use strict';

// Personal triage (13 Oct 2026): the work Inbox's sorting and verdicts for
// nick@ / contact@ / Gmail, kept APART from work mail. Real SQLite, real
// routes over HTTP; the model and the mailbox are the only things stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-ptriage-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'p.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
delete process.env.GOVERNED_EXECUTION_ENABLED;
delete process.env.TRIAGE_SHADOW_ENABLED;

function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
stub('./webpush', { sendToAll: async () => {}, isConfigured: () => true });
stub('./email-sender', { sendMail: async () => { throw new Error('email-sender reached'); }, OWN_ADDRESS: 'nickw@nurtur.tech' });
stub('./teams', { getSendStatus: async () => ({ available: false }) });

const db = require('../db/database');
const pm = require('./personal-mail');
const inbox = require('./personal-inbox');
const triage = require('./personal-triage');
const et = require('./email-triage');
const aiRouting = require('./ai-routing');
const aiProvider = require('./ai-provider');

let server; let base;
const realRead = inbox.readMessage;
const realMark = inbox.markRead;
const realRun = aiRouting.runTask;
const realTriage = aiProvider.triageEmails;

test.before(async () => {
  await db.init();
  assert.equal(db.get("SELECT 1 AS ok FROM pragma_table_info('personal_inbox') WHERE name = 'triage_json'").ok, 1, 'the scratch DB has the column');
  for (const k of ['nick', 'contact', 'saim']) pm.setCredential(k, { password: 'pw' });
  const express = require('express');
  const app = express(); app.use(express.json());
  app.use('/api/personal-inbox', require('../routes/personal-inbox'));
  server = http.createServer(app); await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api/personal-inbox`;
});
test.after(() => {
  inbox.readMessage = realRead; inbox.markRead = realMark; aiRouting.runTask = realRun; aiProvider.triageEmails = realTriage;
  server.closeAllConnections?.(); server.close();
});

const at = (min) => new Date(Date.now() - min * 60000).toISOString();
function seed(id, mailbox, over = {}) {
  db.run(`INSERT OR REPLACE INTO personal_inbox (id, mailbox, uid, uid_validity, message_id, from_email, from_name, subject, received, seen, preview, to_json, cc_json, ext_json, triage_json, fetched_at)
          VALUES (?, ?, 1, '5', ?, ?, ?, ?, ?, 0, ?, '[]', '[]', ?, ?, ?)`,
  [id, mailbox, `<${id}@x>`, over.from || 'sam@example.com', over.name || 'Sam', over.subject || `Subject ${id}`, over.received || at(30),
    over.preview || 'Hello', over.ext || null, over.triage ? JSON.stringify(over.triage) : null, at(0)]);
}
const tri = (id) => JSON.parse(db.get('SELECT triage_json FROM personal_inbox WHERE id = ?', [id]).triage_json || '{}');
const post = async (p, body) => { const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
const get = async (p) => { const r = await fetch(`${base}${p}`); return { status: r.status, body: await r.json() }; };
const reset = () => {
  db.run('DELETE FROM personal_inbox');
  for (const k of [triage.SENDER_RULES_KEY, triage.SUBJECT_RULES_KEY, triage.FEEDBACK_KEY]) db.setState(k, '{}');
};

test('the real classifier is asked the PERSONAL question, once per message: answers are reused, a failed batch stays unsorted (never FYI) and is retried', async () => {
  reset();
  seed('pmail:nick:5:1', 'nick', { subject: 'Your card expires' });
  seed('pmail:contact:5:2', 'contact', { subject: 'Newsletter' });
  seed('pmail:saim:5:3', 'saim', { subject: 'Delivery Status Notification' });
  const prompts = [];
  aiProvider.triageEmails = async (prompt) => {
    prompts.push(prompt);
    const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
    return { provider: 'stub', text: JSON.stringify(ids.map((i) => ({ index: i, category: i === 0 ? 'ACTION' : 'IGNORE', urgency: i === 0 ? 'high' : 'low', reason: 'stub' }))) };
  };
  let r = await triage.classifyPending();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /PERSONAL email/);
  assert.doesNotMatch(prompts[0], /Head of Technical Support/, 'not the work question');
  assert.doesNotMatch(prompts[0], /Delivery Status Notification/, 'saim@ is the bounce watch, never sorted');
  assert.equal(r.classified, 2);
  assert.equal(tri('pmail:nick:5:1').aiCategory, 'ACTION');
  assert.equal(triage.byLane().urgent.length, 1, 'ACTION + high is the urgent lane');

  // Dismissed or not, a sorted message is never sent to the model again.
  await post(`/triage/dismiss/${encodeURIComponent('pmail:contact:5:2')}`, { reason: 'done' });
  r = await triage.classifyPending();
  assert.equal(prompts.length, 1, 'nothing re-bought');
  assert.equal(r.reused, 3 - 1, 'both sorted rows reused');
  assert.equal(tri('pmail:contact:5:2').aiClassified, true, 'the verdict survives the dismissal');

  // A failed batch: no answer is NO answer.
  seed('pmail:nick:5:4', 'nick', { subject: 'Dinner Friday?' });
  aiProvider.triageEmails = async () => ({ provider: 'stub', text: '' });
  r = await triage.classifyPending();
  assert.equal(r.failedBatches, 1);
  assert.equal(tri('pmail:nick:5:4').aiClassified, false);
  const lanes = triage.byLane();
  assert.deepEqual(lanes.unsorted.map((e) => e.id), ['pmail:nick:5:4']);
  assert.equal(lanes.fyi.some((e) => e.id === 'pmail:nick:5:4'), false, 'never filed as FYI');
  aiProvider.triageEmails = async () => ({ provider: 'stub', text: '[{"index":0,"category":"ACTION","urgency":"medium","reason":"Helen asks about dinner"}]' });
  await triage.classifyPending();
  assert.equal(triage.byLane().reply[0].id, 'pmail:nick:5:4', 'retried next pass and sorted');
});

test('GET /triage: work mail never appears, saim@ never appears, one mailbox filters, and an unknown mailbox is 404', async () => {
  reset();
  db.setState('email_triage', JSON.stringify([{ id: 'AAMk-work-1', from: 'Chris', subject: 'Headcount', category: 'ACTION', lane: 'reply', dismissed: false }]));
  seed('pmail:nick:5:1', 'nick', { triage: { aiClassified: true, aiCategory: 'ACTION', aiUrgency: 'low', aiReason: 'asks a question' } });
  seed('gmail:9', 'gmail', { triage: { aiClassified: true, aiCategory: 'FYI', aiUrgency: 'low' }, ext: JSON.stringify({ uid: 9, uidValidity: 1, path: 'INBOX', reason: 'starred' }) });
  seed('pmail:saim:5:2', 'saim');
  const all = (await get('/triage')).body;
  const ids = [...all.action, ...all.fyi, ...all.delegate, ...all.ignore, ...all.unsorted].map((e) => e.id);
  assert.deepEqual(ids.sort(), ['gmail:9', 'pmail:nick:5:1']);
  assert.equal(all.fyi[0].why, 'Starred in Gmail', 'Gmail keeps its reason');
  assert.equal(all.action[0].reason, 'asks a question');
  const gm = (await get('/triage?mailbox=gmail')).body;
  assert.deepEqual([...gm.action, ...gm.fyi].map((e) => e.id), ['gmail:9']);
  assert.equal((await get('/triage?mailbox=work')).status, 404);
  assert.equal((await get('/triage?mailbox=saim')).status, 404);
  // …and the work store never sees personal mail.
  assert.deepEqual(et.getStoredTriage().map((e) => e.id), ['AAMk-work-1']);
});

test('dismiss: Done counts as a verdict; Read & dismiss marks it read on the server; a failed mark still dismisses and says so', async () => {
  reset();
  seed('pmail:nick:5:1', 'nick', { triage: { aiClassified: true, aiCategory: 'ACTION', aiUrgency: 'low' } });
  seed('pmail:nick:5:2', 'nick', { triage: { aiClassified: true, aiCategory: 'FYI', aiUrgency: 'low' } });
  const marked = [];
  inbox.markRead = async (id) => { marked.push(id); return id.endsWith(':2') ? { marked: false, reason: 'auth' } : { marked: true }; };
  let r = await post(`/triage/dismiss/${encodeURIComponent('pmail:nick:5:1')}`, { reason: 'done', markRead: true });
  assert.equal(r.body.ok, true); assert.equal(r.body.readError, undefined);
  assert.deepEqual(marked, ['pmail:nick:5:1']);
  r = await post(`/triage/dismiss/${encodeURIComponent('pmail:nick:5:2')}`, { reason: 'done', markRead: true });
  assert.equal(r.body.ok, true);
  assert.match(r.body.readError, /could not be marked read/);
  assert.equal(tri('pmail:nick:5:2').dismissed, true, 'the dismissal stands');
  assert.equal(triage.getFeedback().judged, 2);
  // Pressing it again adds no second verdict.
  await post(`/triage/dismiss/${encodeURIComponent('pmail:nick:5:2')}`, { reason: 'done' });
  assert.equal(triage.getFeedback().judged, 2);
  assert.equal((await post(`/triage/dismiss/${encodeURIComponent('pmail:nick:5:99')}`, { reason: 'done' })).status, 404);
  assert.equal(triage.byLane().action.length, 0);
});

test('mutes: subject by default, sender on request, in PERSONAL keys only; auto-filed mail is not a verdict; own addresses refused', async () => {
  reset();
  db.setState('email_triage_muted_senders', '{}'); db.setState('email_triage_muted_subjects', '{}');
  const t = { aiClassified: true, aiCategory: 'FYI', aiUrgency: 'low' };
  seed('pmail:nick:5:1', 'nick', { from: 'news@shop.com', subject: 'Weekly deals', triage: t });
  seed('pmail:contact:5:2', 'contact', { from: 'news@shop.com', subject: 'RE: Weekly deals', triage: t });
  seed('pmail:nick:5:3', 'nick', { from: 'news@shop.com', subject: 'Your order', triage: t });
  let r = await post(`/triage/dismiss/${encodeURIComponent('pmail:nick:5:1')}`, { reason: 'not-relevant' });
  assert.equal(r.body.muted.kind, 'subject');
  assert.equal(tri('pmail:contact:5:2').dismissReason, 'subject-muted', 'the same subject is filed');
  assert.equal(tri('pmail:nick:5:3').dismissed, undefined, 'the sender\'s other mail is untouched');
  assert.equal(triage.getFeedback().judged, 1, 'the auto-filed one is not a verdict');
  r = await post(`/triage/dismiss/${encodeURIComponent('pmail:nick:5:3')}`, { reason: 'not-relevant', mute: 'sender' });
  assert.equal(r.body.muted.kind, 'sender');
  assert.deepEqual(Object.keys(JSON.parse(db.getState(triage.SENDER_RULES_KEY))), ['news@shop.com']);
  assert.equal(db.getState('email_triage_muted_senders'), '{}', 'the WORK rules are untouched');
  assert.equal(db.getState('email_triage_muted_subjects'), '{}');
  // New mail from a muted sender is filed on the next pass.
  seed('pmail:nick:5:4', 'nick', { from: 'news@shop.com', subject: 'Flash sale', triage: t });
  await triage.classifyPending({ deps: { classifyBatch: async () => [] } });
  assert.equal(tri('pmail:nick:5:4').dismissReason, 'sender-muted');
  // Un-mute, both kinds, and the list.
  const m = (await get('/triage/muted')).body;
  assert.equal(m.senders.length, 1); assert.equal(m.subjects.length, 1);
  assert.equal((await post('/triage/muted/unmute', { address: 'news@shop.com' })).body.ok, true);
  assert.equal((await post('/triage/muted/unmute', { key: m.subjects[0].key })).body.ok, true);
  assert.equal((await post('/triage/muted/unmute', { address: 'news@shop.com' })).status, 404);
  // Nick's own address cannot be muted.
  seed('pmail:nick:5:5', 'nick', { from: 'nick@nickward.co.uk', subject: 'Note to self', triage: t });
  r = await post(`/triage/dismiss/${encodeURIComponent('pmail:nick:5:5')}`, { reason: 'not-relevant', mute: 'sender' });
  assert.equal(r.body.muted.ok, false); assert.match(r.body.muted.reason, /own/);
});

test('Needs action: promoted mail moves to Action, survives the next sorting pass, and is scored as under-ranked; a dismissed one is refused', async () => {
  reset();
  seed('pmail:nick:5:1', 'nick', { triage: { aiClassified: true, aiCategory: 'FYI', aiUrgency: 'low' } });
  let r = await post(`/triage/promote/${encodeURIComponent('pmail:nick:5:1')}`);
  assert.equal(r.body.promoted, true);
  await triage.classifyPending({ deps: { classifyBatch: async () => { throw new Error('should not be asked'); } } });
  const lanes = triage.byLane();
  assert.equal(lanes.action[0].id, 'pmail:nick:5:1');
  assert.match(lanes.action[0].reason, /promoted by Nick/);
  assert.equal(lanes.action[0].lane, 'reply', 'in the reply lane, like a work promotion — never back to its old one');
  assert.equal(lanes.reply.length, 1);
  assert.equal(triage.getFeedback().underRanked, 1);
  await post(`/triage/dismiss/${encodeURIComponent('pmail:nick:5:1')}`, { reason: 'done' });
  assert.equal((await post(`/triage/promote/${encodeURIComponent('pmail:nick:5:1')}`)).status, 409);
});

test('Clear all clears only the FYI section (FYI + IGNORE), and the dry run quotes the same number', async () => {
  reset();
  const t = (c) => ({ aiClassified: true, aiCategory: c, aiUrgency: 'low' });
  seed('pmail:nick:5:1', 'nick', { triage: t('FYI') });
  seed('pmail:nick:5:2', 'nick', { triage: t('IGNORE') });
  seed('pmail:nick:5:3', 'nick', { triage: t('ACTION') });
  seed('pmail:nick:5:4', 'nick', { triage: { ...t('FYI'), promoted: true } });
  seed('pmail:nick:5:5', 'nick', {});
  assert.equal((await post('/triage/clear-fyi', { dryRun: true })).body.cleared, 2);
  assert.equal(triage.byLane().fyi.length + triage.byLane().ignore.length, 2, 'nothing cleared by a dry run');
  assert.equal((await post('/triage/clear-fyi', {})).body.cleared, 2);
  const l = triage.byLane();
  assert.equal(l.action.length, 2, 'ACTION and the promoted one stay');
  assert.equal(l.unsorted.length, 1, 'unsorted stays');
  assert.equal(triage.getFeedback().judged, 0, 'a bulk clear is not N verdicts');
});

test('the card routes: detail in the work card shape (never marks read), AI summary + draft, reply prepared from the same mailbox with the card\'s recipients; saim@ refused', async () => {
  reset();
  seed('pmail:nick:5:7', 'nick', { triage: { aiClassified: true, aiCategory: 'ACTION', aiUrgency: 'low', aiReason: 'asks about lunch' } });
  let marked = 0;
  inbox.markRead = async () => { marked += 1; return { marked: true }; };
  inbox.readMessage = async () => ({
    ok: true, exists: true, mailbox: 'nick', from: 'sam@example.com', fromName: 'Sam', subject: 'Lunch?',
    to: [{ name: '', email: 'nick@nickward.co.uk' }, { name: 'Helen', email: 'helen@example.com' }], cc: [],
    body: 'Lunch Friday?', conversationId: '<p7@example.com>', internetMessageId: '<p7@example.com>', references: null, received: new Date().toISOString(),
  });
  const id = encodeURIComponent('pmail:nick:5:7');
  const d = (await get(`/triage/${id}`)).body;
  assert.equal(d.ok, true);
  assert.equal(d.email.sendsFrom.address, 'nick@nickward.co.uk');
  assert.deepEqual(d.email.replyDefaults.to, [{ name: 'Sam', email: 'sam@example.com' }]);
  assert.deepEqual(d.email.replyDefaults.replyAllCc.map((x) => x.email), ['helen@example.com'], 'everyone on it except Nick and the sender');
  assert.deepEqual(d.email.to, ['nick@nickward.co.uk', 'Helen <helen@example.com>']);
  assert.equal(marked, 0, 'opening does not mark read');

  const prompts = [];
  aiRouting.runTask = async (task, { prompt }) => { prompts.push({ task, prompt }); return { provider: 'stub', text: task === 'email_summary' ? '- Sam asks about lunch' : 'Friday works. Nick' }; };
  const s = (await post(`/triage/${id}/summary`)).body;
  assert.equal(s.summary, '- Sam asks about lunch');
  const dr = (await post(`/triage/${id}/draft`, { instruction: 'say yes' })).body;
  assert.equal(dr.draft, 'Friday works. Nick');
  assert.match(prompts[0].prompt, /PERSONAL email/);
  assert.match(prompts[1].prompt, /not as Head of Technical Support/);
  assert.match(prompts[1].prompt, /say yes/);
  aiRouting.runTask = async () => { throw new Error('down'); };
  assert.match((await post(`/triage/${id}/summary`)).body.summary, /Lunch\?/, 'falls back to the message itself');

  const rp = (await post(`/triage/${id}/reply`, { body: 'Friday works.', to: [{ email: 'sam@example.com' }], cc: [{ email: 'helen@example.com' }] })).body;
  assert.equal(rp.ok, true, rp.error);
  assert.equal(rp.action.target.mailbox, 'nick');
  assert.deepEqual(rp.action.draft.cc.map((x) => x.email), ['helen@example.com']);
  assert.equal(rp.action.origin, 'composer');
  assert.equal((await post(`/triage/${encodeURIComponent('pmail:saim:5:1')}/reply`, { body: 'x' })).status, 400, 'never from saim@');
  assert.equal((await get(`/triage/${encodeURIComponent('AAMk-work-1')}`)).status, 404, 'a work id is not personal mail');
});

test('a verified reply closes the PERSONAL entry, not the work one, and replies are listed per inbox', () => {
  reset();
  seed('pmail:nick:5:8', 'nick', { triage: { aiClassified: true, aiCategory: 'ACTION', aiUrgency: 'low' } });
  db.setState('email_triage', JSON.stringify([{ id: 'AAMk-work-2', subject: 'Work', category: 'ACTION', lane: 'reply', dismissed: false }]));
  const ex = require('./action-executor');
  const action = (emailId, mailbox) => ({ target: { emailId, mailbox, originalSubject: 's', from: 'a@b.c' }, draft: { to: [{ email: 'a@b.c' }], cc: [], body: 'hi', mode: 'reply' } });
  ex._defaultDeps.recordReply(action('pmail:nick:5:8', 'nick'));
  assert.equal(tri('pmail:nick:5:8').dismissReason, 'replied');
  assert.equal(et.getStoredTriage()[0].dismissed, false, 'the work entry is untouched');
  ex._defaultDeps.recordReply(action('AAMk-work-2', undefined));
  assert.equal(et.getStoredTriage().find((e) => e.id === 'AAMk-work-2').dismissed, true);
  const sr = require('./sent-replies');
  assert.deepEqual(sr.list({ scope: 'personal' }).replies.map((r) => r.emailId), ['pmail:nick:5:8']);
  assert.deepEqual(sr.list({ scope: 'work' }).replies.map((r) => r.emailId), ['AAMk-work-2']);
  assert.equal(sr.list({ scope: 'personal' }).total, 1);
});

test('the refresh sorts after reading, and a sorting failure never fails the refresh', async () => {
  reset();
  seed('pmail:nick:5:1', 'nick');
  const s = await inbox.refresh({ only: ['nick'], deps: { imap: () => { throw new Error('offline'); }, classifyBatch: async () => { throw new Error('model down'); }, extractTasks: async () => ({ created: 0, asked: 0 }) } });
  assert.equal(s.sorted.failedBatches, 1);
  assert.equal(s.sorted.unanswered, 1);
  assert.equal(triage.byLane().unsorted.length, 1);
});
