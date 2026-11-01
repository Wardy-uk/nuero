'use strict';

/**
 * Delegation prompts (1 Nov 2026). Real HTTP, real api-auth + authority guard,
 * real task store, waiting-on, email triage store, prepared actions, intent
 * grants and executor; a temp vault of People notes read by the real
 * team-roster; NOVA's leave read from the real team-availability cache. Faked:
 * the model (ai-routing.runTask) and the mail transport (one fake mailbox).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
for (const k of ['ANTHROPIC_API_KEY', 'HA_TOKEN', 'HA_URL', 'GOVERNED_EXECUTION_ENABLED', 'GOVERNED_CALENDAR_ENABLED']) delete process.env[k];
global.fetch = async () => { throw new Error('network blocked in delegation test'); };

const put = (rel, text) => { const f = path.join(VAULT, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const person = (name, fm) => put(`People/${name}.md`, `---\ntype: person\n${fm}\n---\n# ${name}\n`);
person('Naomi Wentworth', 'role: Customer Service Agent (CSA)\nemail: naomi@nurtur.tech\nteam: Support\nline: 1st Line\ndirect-report: true\nowns:\n  - portal password resets\n  - macro library');
person('Abdi Mohamed', 'role: 2nd Line Support Analyst\nemail: abdi@nurtur.tech\nteam: Support\nline: 2nd Line\ndirect-report: true\nresponsibilities: [Tier 2 billing, knowledge articles]');
person('Luke Scaife', 'role: 2nd Line Support Analyst\nemail: luke@nurtur.tech\nteam: Support\nline: 2nd Line\ndirect-report: true');
person('Zoe Rees', 'role: Customer Service Agent (CSA)\nemail: zoe@nurtur.tech\nteam: Support\nline: 1st Line\ndirect-report: true');
person('Arman Shazad', 'role: 2nd Line Support Analyst\nemail: arman@nurtur.tech\nteam: Support\nline: 2nd Line\ndirect-report: false\narchived: true');

// ── every real outbound door throws; one fake mailbox ────────────────────────
function stub(rel, exportsObj) { const id = require.resolve(rel); require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj }; }
const boom = (what) => async () => { throw new Error(`${what} reached from the delegation test`); };
stub('../services/webpush', { sendToAll: boom('webpush.sendToAll'), isConfigured: () => true });
stub('../services/email-sender', { sendMail: boom('email-sender.sendMail'), sendBriefEmail: boom('email-sender.sendBriefEmail'), OWN_ADDRESS: 'nickw@nurtur.tech' });
stub('../services/teams', { getSendStatus: async () => ({ available: false }) });
const SELF = 'nickw@nurtur.tech';
const sentItems = []; const drafts = new Map(); let n = 0;
const mail = {
  createDraft: async ({ to, cc = [], subject, body }) => { n += 1; const id = `draft-${n}`; const imid = `<d${n}@nurtur.tech>`; drafts.set(id, { to, cc, subject, body, imid, files: [] }); return { ok: true, id, internetMessageId: imid }; },
  addAttachments: async (id, files) => { drafts.get(id).files.push(...files); return { ok: true }; },
  listAttachments: async (id) => ({ ok: true, names: drafts.get(id).files.map((f) => f.name) }),
  patchDraft: async () => ({ ok: false }),
  sendDraft: async (id) => {
    const d = drafts.get(id);
    sentItems.push({ id: `sent-${id}`, internetMessageId: d.imid, subject: d.subject, to: d.to.map((x) => String(x.email || x).toLowerCase()), cc: [], bcc: [], from: SELF, sentAt: new Date().toISOString(), bodyText: d.body, conversationId: `conv-${id}`, files: d.files });
    drafts.delete(id); return { outcome: 'accepted', status: 202 };
  },
  findSent: async (imid) => ({ ok: true, messages: sentItems.filter((m) => m.internetMessageId === imid) }),
  draftState: async (id) => (drafts.has(id) ? 'draft' : 'gone'),
  deleteDraft: async (id) => drafts.delete(id),
  readMessage: async () => ({ ok: true, exists: false }),
  readEvent: async () => ({ ok: false, category: 'unavailable' }),
  sentToSince: async () => ({ count: 0, subjects: [] }),
  sentInConversationSince: async () => ({ count: 0 }),
  signedInAddress: async () => SELF,
};
stub('../services/action-mail', { ...mail, DEFINITIVE_SEND_REFUSALS: new Set([400, 401, 403, 404, 409]) });
stub('../services/mail-read', { readMessage: mail.readMessage, signedInAddress: mail.signedInAddress });
stub('../services/microsoft', {
  getSignedInAddress: async () => SELF, getAccessToken: async () => null,
  graphWrite: boom('microsoft.graphWrite'), sendMail: boom('microsoft.sendMail'), fetchSentMail: boom('microsoft.fetchSentMail'),
  createCalendarEvent: boom('microsoft.createCalendarEvent'), markEmailRead: async () => ({ ok: true }),
});

const db = require('../db/database');
const taskStore = require('../services/task-store');
const delegation = require('../services/delegation');
const executor = require('../services/action-executor');

// ── the model, scripted by what the item says ───────────────────────────────
const prompts = [];
const RULES = [
  [/Billing query/, { person: 'Abdi Mohamed', why: 'he runs Tier 2 billing', confidence: 'high' }],
  [/CRM export/, { person: 'Arman Shazad', why: 'he did the last one', confidence: 'high' }],
  [/Rota swap/, { person: 'Zoe Rees', why: 'she manages the 1st line rota', confidence: 'high' }],
  [/macro wording/, { person: 'Naomi Wentworth', why: 'she keeps the macro library', confidence: 'medium' }],
  [/promotion case/, { person: 'none', why: '', confidence: 'high' }],
  [/portal password/, { person: 'Naomi Wentworth', why: 'she handles portal password resets', confidence: 'high' }],
  [/knowledge article/, { person: 'Abdi Mohamed', why: 'he owns the knowledge articles', confidence: 'high' }],
  [/refund ticket/, { person: 'Luke Scaife', why: 'he works refunds in 2nd line', confidence: 'high' }],
];
let failNext = false;
require('../services/ai-routing').runTask = async (taskType, payload, opts) => {
  assert.equal(taskType, 'delegation_suggest');
  assert.equal(opts.forceCloud, true);
  if (failNext) { failNext = false; throw new Error('provider down'); }
  const item = payload.prompt.split('DIRECT REPORTS:')[0];
  prompts.push(item);
  const hit = RULES.find(([re]) => re.test(item));
  return { text: JSON.stringify(hit ? hit[1] : { person: 'none', why: '', confidence: 'high' }), provider: 'test' };
};
const askedAbout = (re) => prompts.filter((p) => re.test(p)).length;

const NICK = { 'X-NEURO-PIN': 'pin-1234' };
const MCP = { 'X-NEURO-PIN': 'pin-1234', 'X-Neuro-Machine-Client': 'mcp-local' };
const londonDay = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
let server; let base;
const T = {};

test.before(async () => {
  await db.init();
  // Created in this order so the pass (newest task first) meets the refusals before the limit.
  T.c = taskStore.createTask({ text: 'Process the refund ticket for Lettings Co', source: 'test' });
  T.b = taskStore.createTask({ text: 'Chase the Tier 2 knowledge article on exports', source: 'test' });
  T.a = taskStore.createTask({ text: 'Reset the portal password for Acme Estates', source: 'test' });
  T.none = taskStore.createTask({ text: 'Write my promotion case', source: 'test' });
  T.low = taskStore.createTask({ text: 'Review the macro wording', source: 'test' });
  T.leave = taskStore.createTask({ text: 'Rota swap for next week', source: 'test' });
  T.arch = taskStore.createTask({ text: 'Update the CRM export', source: 'test' });
  T.commit = taskStore.createTask({ text: 'Send Chris the commitment deck', source: 'test', origin: 'commitment' });
  T.personal = taskStore.createTask({ text: 'Book the car service', source: 'test', domain: 'personal' });
  db.setState('email_triage', JSON.stringify([
    { id: 'mail-1', subject: 'Billing query on invoice 4411', from: 'Pat Client', fromEmail: 'pat@client.co.uk', preview: 'Our invoice looks wrong. Can someone check it?', category: 'DELEGATE', lane: 'delegate', received: new Date().toISOString() },
    { id: 'mail-2', subject: 'Lunch?', from: 'Ricky', fromEmail: 'ricky@nurtur.tech', preview: 'fancy it', category: 'FYI', lane: 'fyi' },
  ]));
  const tomorrow = londonDay(Date.now() + 86400000);
  db.setState('team_availability', JSON.stringify({
    fetchedAt: new Date().toISOString(), rosterCount: 4, to: londonDay(Date.now() + 60 * 86400000),
    roster: [
      { rosterId: 1, name: 'Naomi Wentworth', syncable: true }, { rosterId: 2, name: 'Abdi Mohamed', syncable: true },
      { rosterId: 3, name: 'Luke Scaife', syncable: true }, { rosterId: 4, name: 'Zoe Rees', syncable: true },
    ],
    absences: [{ rosterId: 4, date: tomorrow }],
  }));
  require('../services/feature-flags').setEnabled('governed_execution', true);
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require('../services/api-auth'));
  app.use('/api', require('../services/authority-guard').guard);
  app.use('/api/delegation', require('./delegation'));
  app.use('/api/prepared-actions', require('./prepared-actions'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

function call(method, route, body, headers = NICK) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/api${route}`, { method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s || '{}') }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const rowFor = (kind, id) => db.get('SELECT * FROM delegation_suggestions WHERE item_kind = ? AND item_id = ? ORDER BY id DESC', [kind, String(id)]);
async function send(action) {
  const g = await call('POST', `/prepared-actions/${action.actionId}/intent-grant`, { version: action.version, payloadHash: action.payloadHash, surface: 'neuro-web', sessionId: 'testsession0001' });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  const x = await call('POST', `/prepared-actions/${action.actionId}/execute-direct`, { grantId: g.json.grantId, payloadHash: action.payloadHash });
  assert.equal(x.status, 200, JSON.stringify(x.json));
  if (x.json.status === 'executed') await executor.verify(action.actionId);
}
const FILL = (body) => body.replace('[details]', 'the customer has been told the outcome').replace('[date]', 'Friday');

// ── pure ─────────────────────────────────────────────────────────────────────

test('candidates: DELEGATE or customer ACTION email; a task that is not a commitment, personal or owned elsewhere', () => {
  assert.equal(delegation.isCandidateEmail({ id: 'x', category: 'DELEGATE' }), true);
  assert.equal(delegation.isCandidateEmail({ id: 'x', category: 'ACTION', fromEmail: 'a@customer.com' }), true);
  assert.equal(delegation.isCandidateEmail({ id: 'x', category: 'ACTION', fromEmail: 'chris@nurtur.tech', subject: 'Budget' }), false);
  assert.equal(delegation.isCandidateEmail({ id: 'x', category: 'ACTION', fromEmail: 'chris@nurtur.tech', subject: 'NT-1234 needs a look' }), true);
  assert.equal(delegation.isCandidateEmail({ id: 'x', category: 'DELEGATE', dismissed: true }), false);
  assert.equal(delegation.isCandidateTask({ status: 'open', origin: 'commitment' }), false);
  assert.equal(delegation.isCandidateTask({ status: 'open', domain: 'personal' }), false);
  assert.equal(delegation.isCandidateTask({ status: 'open', ms_id: 'abc' }), false);
  assert.equal(delegation.isCandidateTask({ status: 'open', source: 'jira-assigned' }), false);
  assert.equal(delegation.isCandidateTask({ status: 'open', domain: 'work', origin: null }), true);
});

test('the draft commits Nick to nothing it does not hold: what done looks like and by when are gaps', () => {
  const d = delegation.composeDraft({ kind: 'task', item: { text: 'Do the thing' }, person: 'Naomi Wentworth' });
  assert.match(d.body, /^Hi Naomi,/);
  assert.match(d.body, /What done looks like: \[details\]/);
  assert.match(d.body, /By when: \[date\]/);
  const withDue = delegation.composeDraft({ kind: 'task', item: { text: 'Do the thing', due_date: '2026-11-06' }, person: 'Naomi Wentworth' });
  assert.match(withDue.body, /By when: Fri 6 Nov/);
});

// ── the pass ─────────────────────────────────────────────────────────────────

test('refusals: archived person, on leave, low confidence and "none" never open; at most 3 open; each item judged once', async () => {
  const s1 = await call('POST', '/delegation/scan', {});
  assert.equal(s1.status, 200, JSON.stringify(s1.json));
  assert.equal(s1.json.judged, 6);
  assert.equal(rowFor('task', T.arch.id).verdict, 'not-a-report', 'Arman is archived — not in the roster');
  assert.equal(rowFor('task', T.leave.id).verdict, 'refused');
  assert.match(rowFor('task', T.leave.id).reason, /on leave/);
  assert.equal(rowFor('task', T.low.id).verdict, 'low-confidence');
  assert.equal(rowFor('task', T.none.id).verdict, 'none');
  assert.equal(rowFor('task', T.a.id).status, 'open');
  assert.equal(rowFor('email', 'mail-1').status, 'open');
  assert.equal(askedAbout(/commitment deck|car service|Lunch/), 0, 'commitments, personal tasks and FYI mail are never asked about');
  assert.doesNotMatch(prompts.join('\n'), /Arman/, 'an archived report is never offered to the model');

  const s2 = await call('POST', '/delegation/scan', {});
  assert.equal(s2.json.judged, 1, 'the third opens and the pass stops');
  assert.equal(rowFor('task', T.b.id).status, 'open');
  assert.equal(rowFor('task', T.c.id), null, 'nothing beyond three is judged');

  const s3 = await call('POST', '/delegation/scan', {});
  assert.equal(s3.json.judged, 0);
  const g = await call('GET', '/delegation');
  assert.equal(g.json.suggestions.length, 3);
  assert.equal(prompts.length, 7);
  for (const re of [/CRM export/, /Rota swap/, /macro wording/, /promotion case/]) assert.equal(askedAbout(re), 1, `${re} judged once`);
});

test('"Not this one" is remembered for the item even when its wording changes; a failed call buys nothing', async () => {
  const a = rowFor('task', T.a.id);
  assert.equal((await call('POST', `/delegation/${a.id}/dismiss`, {})).status, 200);
  taskStore.updateTask(T.a.id, { text: 'Reset the portal password for Acme Estates Ltd' });
  failNext = true;
  const f = await call('POST', '/delegation/scan', {});
  assert.equal(f.json.failed, 1);
  assert.equal(rowFor('task', T.c.id), null, 'a failed call stores nothing');
  const s = await call('POST', '/delegation/scan', {});
  assert.equal(s.json.judged, 1);
  assert.equal(rowFor('task', T.c.id).status, 'open');
  assert.equal(askedAbout(/portal password/), 1, 'the dismissed item is not asked about again');
});

test('a gap blocks the send; a filled hand-over goes on one press and leaves a waiting-on row; the task is dropped as delegated', async () => {
  const g = await call('GET', '/delegation');
  const s = g.json.suggestions.find((x) => x.kind === 'task' && x.itemId === String(T.b.id));
  assert.equal(s.person, 'Abdi Mohamed');
  assert.equal(s.line, 'Could go to Abdi — he owns the knowledge articles');
  assert.match(s.draft.body, /\[details\]/);
  const blocked = await call('POST', `/delegation/${s.id}/hand-over`, {});
  assert.equal(blocked.status, 409);
  assert.deepEqual(blocked.json.gaps.sort(), ['[date]', '[details]']);
  assert.equal(sentItems.length, 0);

  const ok = await call('POST', `/delegation/${s.id}/hand-over`, { subject: s.draft.subject, body: FILL(s.draft.body) });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.action.origin, 'delegation');
  const again = await call('POST', `/delegation/${s.id}/hand-over`, { subject: s.draft.subject, body: FILL(s.draft.body) });
  assert.equal(again.json.already, true);
  assert.equal(again.json.action.actionId, ok.json.action.actionId);
  await send(ok.json.action);
  assert.equal(sentItems.length, 1);
  assert.deepEqual(sentItems[0].to, ['abdi@nurtur.tech']);

  await call('GET', '/delegation'); // reads back the send
  const w = db.get("SELECT * FROM waiting_on WHERE person = 'Abdi' AND text = ?", ['Chase the Tier 2 knowledge article on exports']);
  assert.ok(w, 'the hand-over is now what Abdi owes Nick');
  assert.equal(w.status, 'open');
  const t = taskStore.getTask(T.b.id);
  assert.equal(t.status, 'dropped');
  assert.match(t.notes, /Delegated to Abdi Mohamed/);
  assert.equal(rowFor('task', T.b.id).status, 'sent');
});

test('an email hand-over dismisses it from triage as delegated', async () => {
  const s = (await call('GET', '/delegation')).json.suggestions.find((x) => x.kind === 'email');
  const ok = await call('POST', `/delegation/${s.id}/hand-over`, { subject: s.draft.subject, body: FILL(s.draft.body) });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  await send(ok.json.action);
  await call('GET', '/delegation');
  const e = JSON.parse(db.getState('email_triage')).find((x) => x.id === 'mail-1');
  assert.equal(e.dismissed, true);
  assert.equal(e.dismissReason, 'delegated');
  assert.ok(db.get("SELECT 1 FROM waiting_on WHERE person = 'Abdi' AND text LIKE 'Handle the email%'"));
});

test('only a VERIFIED send counts: executed waits, a rejected one goes back to open', async () => {
  const row = rowFor('task', T.c.id);
  const s = (await call('GET', '/delegation')).json.suggestions.find((x) => x.id === row.id);
  const ok = await call('POST', `/delegation/${s.id}/hand-over`, { subject: s.draft.subject, body: FILL(s.draft.body) });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  delegation.reconcile({ deps: { getAction: () => ({ status: 'executed' }) } });
  assert.equal(rowFor('task', T.c.id).status, 'prepared');
  assert.equal(db.get("SELECT 1 FROM waiting_on WHERE person = 'Luke'"), null, 'nothing is recorded before Sent Items says so');
  assert.equal(taskStore.getTask(T.c.id).status, 'open');
  delegation.reconcile({ deps: { getAction: () => ({ status: 'rejected' }) } });
  assert.equal(rowFor('task', T.c.id).status, 'open');
  assert.equal(rowFor('task', T.c.id).action_id, null);
});

test('a machine client is refused every press', async () => {
  const s = (await call('GET', '/delegation')).json.suggestions[0];
  for (const [route, body] of [['/delegation/scan', {}], [`/delegation/${s.id}/hand-over`, {}], [`/delegation/${s.id}/dismiss`, {}]]) {
    const r = await call('POST', route, body, MCP);
    assert.equal(r.status, 403, route);
  }
  assert.equal(rowFor('task', T.c.id).status, 'open');
});
