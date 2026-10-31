'use strict';

/**
 * Next steps on Claude's returned work (31 Oct 2026). Real HTTP, real api-auth,
 * real authority guard, real task store, real prepared-actions + intent grants +
 * executor, a temp vault with People notes. Faked: the model (ai-routing.runTask),
 * the promise ledger's read, and the mail transport (one fake mailbox). Every other
 * outbound door throws.
 *
 *   - a valid model plan becomes validated steps (unknown kind → manual, the
 *     model's drop-time ignored, complete last); a second read buys nothing;
 *   - "Send it to Alex" prepares ONE compose_email from work with the result as a
 *     .docx (hash-bound), linked to the promise; a repeat press returns the same
 *     action; one press (intent grant → execute-direct) sends it and it verifies;
 *   - an unresolvable person leaves the address empty and the press needs a typed one;
 *   - a follow-up task is deduped against open tasks, else created;
 *   - the model failing gives the labelled fallback (send to the owed person → done);
 *   - drop-time appears only while a waiting prepared move exists, and goes on the press;
 *   - Rethink buys one fresh call; declared machines are refused.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-next-steps-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
process.env.NEURO_KIOSK_TOKEN = 'kiosk-9012';
for (const k of ['ANTHROPIC_API_KEY', 'HA_TOKEN', 'HA_URL', 'GOVERNED_EXECUTION_ENABLED', 'GOVERNED_CALENDAR_ENABLED']) delete process.env[k];
global.fetch = async () => { throw new Error('network blocked in task-next-steps test'); };

const put = (rel, text) => { const f = path.join(VAULT, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
put('People/Alex Reed.md', '---\nemail: alex.reed@nurtur.tech\n---\n# Alex Reed\n');
put('People/Sam Patel.md', '---\nemail: sam.patel@nurtur.tech\n---\n# Sam Patel\n');
fs.mkdirSync(path.join(VAULT, 'Projects', 'Working'), { recursive: true });
put('People/Pat Gray.md', '---\nrole: contractor\n---\n# Pat Gray\n');

// ── every real outbound door throws; one fake mailbox ────────────────────────
const doors = [];
function stub(rel, exportsObj) { const id = require.resolve(rel); require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj }; }
const boom = (what) => async () => { doors.push(what); throw new Error(`${what} reached from a task-next-steps test`); };
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
const agent = require('../services/task-agent');
const ns = require('../services/task-next-steps');
const pa = require('../services/prepared-actions');
const moveStore = require('../services/prepared-move-store');

// ── the model and the promise ledger, scripted ───────────────────────────────
const modelCalls = [];
let answer = null; // string | Error | function
require('../services/ai-routing').runTask = async (taskType, payload) => {
  modelCalls.push({ taskType, prompt: payload.prompt });
  const a = typeof answer === 'function' ? answer(payload) : answer;
  if (a instanceof Error) throw a;
  return { text: a, provider: 'test' };
};
let promises = [];
require('../services/promise-ledger').read = () => ({ promises, gaps: [] });

const NICK = { 'X-NEURO-PIN': 'pin-1234' };
const MCP = { 'X-NEURO-PIN': 'pin-1234', 'X-Neuro-Machine-Client': 'mcp-local' };
let server; let base;
const T = {};

test.before(async () => {
  await db.init();
  T.owed = taskStore.createTask({ text: 'Write the Q4 rota cover plan for Alex', source: 'test' });
  T.plain = taskStore.createTask({ text: 'Summarise the vendor contract terms', source: 'test' });
  T.fb = taskStore.createTask({ text: 'Draft the escalation guide for Alex', source: 'test' });
  T.dup = taskStore.createTask({ text: 'Book the Q4 rota review with the team leads', source: 'test' });
  promises = [
    { key: `promise:${T.owed.id}`, taskIds: [T.owed.id], open: true, owedTo: { people: [{ name: 'Alex Reed' }], ambiguous: [], resolved: 'Alex Reed' } },
    { key: `promise:${T.fb.id}`, taskIds: [T.fb.id], open: true, owedTo: { people: [{ name: 'Alex Reed' }], ambiguous: [], resolved: 'Alex Reed' } },
  ];
  require('../services/feature-flags').setEnabled('governed_execution', true);
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', require('../services/api-auth'));
  app.use('/api', require('../services/authority-guard').guard);
  app.use('/api/task-agent', require('./task-agent'));
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
const settle = () => Promise.all([...ns._inflight.values()]);
async function stepsFor(taskId) {
  let r = await call('GET', `/task-agent/tasks/${taskId}`);
  if (r.json.nextSteps && r.json.nextSteps.thinking) { await settle(); r = await call('GET', `/task-agent/tasks/${taskId}`); }
  return r.json.nextSteps;
}
const RESULT = '# Q4 Rota Cover Plan\n\n- Week 44: **early/late** split\n- Week 47: cover from Tier 2\n\nNext: book a review with the team leads.';

/** Read one entry back out of a zip buffer (central directory walk). */
function unzipEntry(buf, name) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let off = buf.readUInt32LE(end + 16);
  const count = buf.readUInt16LE(end + 10);
  for (let i = 0; i < count; i += 1) {
    const len = buf.readUInt16LE(off + 28); const extra = buf.readUInt16LE(off + 30); const comment = buf.readUInt16LE(off + 32);
    const fname = buf.slice(off + 46, off + 46 + len).toString('utf8');
    const local = buf.readUInt32LE(off + 42); const size = buf.readUInt32LE(off + 20);
    if (fname === name) { const ln = buf.readUInt16LE(local + 26); const le = buf.readUInt16LE(local + 28); return zlib.inflateRawSync(buf.slice(local + 30 + ln + le, local + 30 + ln + le + size)).toString('utf8'); }
    off += 46 + len + extra + comment;
  }
  return null;
}

test('a valid model plan becomes validated steps; a second read buys nothing', async () => {
  answer = JSON.stringify({ steps: [
    { kind: 'send', title: 'Send it to Alex', why: 'Alex asked for the cover plan.', params: { to: 'Alex Reed' } },
    { kind: 'follow-up-task', title: 'Book the rota review', why: 'The plan says to book a review.', params: { text: 'Book the Q4 rota review with the team leads', due: '2099-01-05' } },
    { kind: 'meeting', title: 'Walk Sam through it', why: 'Tier 2 covers week 47.', params: { with: ['Sam Patel'], subject: 'Rota walk-through', minutes: 30 } },
    { kind: 'phone-call', title: 'Ring the agency', why: 'Week 44 may need agency cover.', params: {} },
    { kind: 'drop-time', title: 'Drop it', params: {} },
    { kind: 'complete', title: 'Mark the task done', why: 'The plan is written.', params: {} },
  ] });
  assert.equal(agent.returnFromClaude(T.owed.id, { markdown: RESULT }).ok, true);
  const first = await call('GET', `/task-agent/tasks/${T.owed.id}`);
  assert.equal(first.json.nextSteps.thinking, true);
  await settle();
  const v = await stepsFor(T.owed.id);
  assert.equal(v.source, 'model');
  assert.deepEqual(v.steps.map((s) => s.kind), ['send', 'follow-up-task', 'meeting', 'manual', 'complete']);
  assert.equal(v.steps[3].title, 'Ring the agency');
  assert.deepEqual(v.steps[0].send.to, { name: 'Alex Reed', email: 'alex.reed@nurtur.tech' });
  assert.match(v.steps[0].send.body, /^Hi Alex,\n\nAttached is the write the Q4 rota cover plan for Alex you asked for\.\n\nNick$/);
  assert.equal(v.steps[0].send.attachmentName, 'Q4 Rota Cover Plan.docx');
  assert.deepEqual(v.steps[2].meeting.attendees, [{ name: 'Sam Patel', email: 'sam.patel@nurtur.tech' }]);
  assert.equal(v.steps[1].followUp.already.id, T.dup.id, 'an equivalent open task is named');
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].taskType, 'task_next_steps');
  assert.match(modelCalls[0].prompt, /Owed to: Alex Reed/);
  await stepsFor(T.owed.id);
  assert.equal(modelCalls.length, 1, 'the cached plan is reused');
});

test('Send prepares ONE compose_email with the .docx; a repeat press returns it; one press sends and verifies', async () => {
  const v = await stepsFor(T.owed.id);
  const r = await call('POST', `/task-agent/tasks/${T.owed.id}/next-steps/s1`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const a = r.json.action;
  assert.equal(a.actionType, 'compose_email');
  assert.equal(a.origin, 'task-claude-send');
  assert.deepEqual(a.draft.to.map((x) => x.email), ['alex.reed@nurtur.tech']);
  assert.equal(a.draft.attachments.length, 1);
  assert.equal(a.draft.attachments[0].name, 'Q4 Rota Cover Plan.docx');
  assert.match(a.draft.attachments[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(a.evidence.promiseKey, `promise:${T.owed.id}`);
  assert.equal(a.evidence.move, 'deliver-email');
  assert.equal(r.json.nextSteps.steps[0].send.action.actionId, a.actionId);

  const again = await call('POST', `/task-agent/tasks/${T.owed.id}/next-steps/s1`, {});
  assert.equal(again.json.already, true);
  assert.equal(again.json.action.actionId, a.actionId);
  assert.equal(db.all("SELECT action_id FROM prepared_actions WHERE action_type = 'compose_email'").length, 1);

  const g = await call('POST', `/prepared-actions/${a.actionId}/intent-grant`, { version: a.version, payloadHash: a.payloadHash, surface: 'neuro-web', sessionId: 'testsession0001' });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  const x = await call('POST', `/prepared-actions/${a.actionId}/execute-direct`, { grantId: g.json.grantId, payloadHash: a.payloadHash });
  assert.equal(x.status, 200, JSON.stringify(x.json));
  assert.ok(['executed', 'verified'].includes(x.json.status), x.json.status);
  assert.equal(sentItems.length, 1);
  assert.deepEqual(sentItems[0].files.map((f) => f.name), ['Q4 Rota Cover Plan.docx']);
  const docXml = unzipEntry(sentItems[0].files[0].content, 'word/document.xml');
  assert.match(docXml, /Q4 Rota Cover Plan/);
  assert.match(docXml, /early\/late/);
  assert.deepEqual(doors, []);
  void v;
});

test('an unresolvable person leaves the address empty; the press needs a typed one, which is used', async () => {
  answer = JSON.stringify({ steps: [{ kind: 'send', title: 'Send it to Pat', why: 'Pat owns the contract.', params: { to: 'Pat Gray' } }, { kind: 'complete', title: 'Mark the task done', params: {} }] });
  agent.returnFromClaude(T.plain.id, { markdown: 'Contract summary: 12-month term.' });
  const v = await stepsFor(T.plain.id);
  assert.equal(v.steps[0].send.to, null);
  assert.match(v.steps[0].send.why, /Pat Gray/);
  const refused = await call('POST', `/task-agent/tasks/${T.plain.id}/next-steps/s1`, {});
  assert.equal(refused.status, 409);
  assert.equal(refused.json.recipientNeeded, true);
  assert.equal((await call('POST', `/task-agent/tasks/${T.plain.id}/next-steps/s1`, { to: 'not-an-address' })).status, 400);
  const ok = await call('POST', `/task-agent/tasks/${T.plain.id}/next-steps/s1`, { to: 'pat@vendor.example' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(ok.json.action.draft.to.map((x) => x.email), ['pat@vendor.example']);
  assert.equal(ok.json.action.evidence.promiseKey, undefined, 'no promise, no promise link');
  assert.match(ok.json.action.draft.body, /^Hi,\n/);
});

test('a follow-up task is deduped against an open one, else created with its source', async () => {
  const r = await call('POST', `/task-agent/tasks/${T.owed.id}/next-steps/s2`, {});
  assert.equal(r.json.taskId, T.dup.id);
  assert.match(r.json.say, new RegExp(`Already on your list: #${T.dup.id}`));
  db.run("UPDATE tasks SET status = 'done' WHERE id = ?", [T.dup.id]);
  const plan = ns.loadPlan(T.owed.id, agent.claudeResults(T.owed.id)[0].id);
  plan.steps[1].state = null; plan.steps[1].params.text = 'Circulate the rota plan to the team leads'; db.setState(ns.PLAN_KEY(T.owed.id, plan.resultId), JSON.stringify(plan));
  const c = await call('POST', `/task-agent/tasks/${T.owed.id}/next-steps/s2`, {});
  assert.match(c.json.say, /^Task #\d+ created\.$/);
  const row = taskStore.getTask(c.json.taskId);
  assert.equal(row.source, 'task-claude-next-step');
  assert.equal(row.due_date, '2099-01-05');
  const v = await stepsFor(T.owed.id);
  assert.equal(v.steps[1].state.status, 'done', 'progress persists across reads');
});

test('a meeting step prepares a governed invite at the time Nick picks', async () => {
  const r = await call('POST', `/task-agent/tasks/${T.owed.id}/next-steps/s3`, { start: '2099-01-06T10:00' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.action.actionType, 'create_calendar_event');
  assert.equal(r.json.action.origin, 'task-claude-meeting');
  assert.equal(r.json.action.draft.end.slice(0, 16), '2099-01-06T10:30');
});

test('the model failing gives the labelled fallback: send to the owed person, then done', async () => {
  answer = new Error('no AI provider answered');
  agent.returnFromClaude(T.fb.id, { markdown: '# Escalation guide\n\nStep one.' });
  const v = await stepsFor(T.fb.id);
  assert.equal(v.source, 'fallback');
  assert.equal(v.label, ns.FALLBACK_LABEL);
  assert.deepEqual(v.steps.map((s) => s.kind), ['send', 'complete']);
  assert.equal(v.steps[0].send.to.email, 'alex.reed@nurtur.tech');
});

test('drop-time comes from the facts: present only while a waiting prepared move exists, and goes on the press', async () => {
  moveStore.ensure();
  const moveKey = `saim-move:v2:project-note:task:${T.fb.id}`;
  const packet = { contract: 'prepared-move-v2', selected: { moveKey, plan: 'draft', headline: 'Escalation guide draft', decision: { slots: [{ id: 'a', date: '2099-01-07', start: '10:30', end: '11:00' }], proposedWrites: [{ kind: 'calendar.solo' }] } } };
  db.run(`INSERT INTO prepared_moves (id, move_key, version, contract, packet_json, packet_hash, options_json, decided_at, evidence_expires_at, created_at) VALUES (?, ?, 1, 'prepared-move-v2', ?, 'h', '{}', ?, ?, ?)`,
    ['pm_test0001', moveKey, JSON.stringify(packet), new Date().toISOString(), new Date(Date.now() + 3600000).toISOString(), new Date().toISOString()]);
  let v = await stepsFor(T.fb.id);
  assert.deepEqual(v.steps.map((s) => s.kind), ['send', 'drop-time', 'complete']);
  const drop = v.steps[1];
  assert.match(drop.title, /Drop the suggested time \(Wed 7 Jan 10:30\)/);
  const r = await call('POST', `/task-agent/tasks/${T.fb.id}/next-steps/drop-time`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(moveStore.suppression(moveKey).response, 'declined');
  v = await stepsFor(T.fb.id);
  const d2 = v.steps.find((s) => s.kind === 'drop-time');
  assert.equal(d2.state.status, 'done');
  assert.equal((await call('POST', `/task-agent/tasks/${T.fb.id}/next-steps/drop-time`, {})).status, 409);
  // No move at all → no drop-time step, whatever the model said.
  assert.equal((await stepsFor(T.plain.id)).steps.some((s) => s.kind === 'drop-time'), false);
});

test('Mark the task done completes it', async () => {
  const v = await stepsFor(T.plain.id);
  const done = v.steps.find((s) => s.kind === 'complete');
  const r = await call('POST', `/task-agent/tasks/${T.plain.id}/next-steps/${done.id}`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(taskStore.getTask(T.plain.id).status, 'done');
  assert.equal(r.json.nextSteps.steps.find((s) => s.kind === 'complete').state.status, 'done');
});

test('Rethink buys one fresh call; machines are refused; junk is refused', async () => {
  answer = JSON.stringify({ steps: [{ kind: 'complete', title: 'Mark the task done', params: {} }] });
  const before = modelCalls.length;
  const r = await call('POST', `/task-agent/tasks/${T.fb.id}/next-steps/rethink`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(modelCalls.length, before + 1);
  assert.equal(r.json.nextSteps.source, 'model');
  assert.equal((await call('POST', `/task-agent/tasks/${T.fb.id}/next-steps/rethink`, {}, MCP)).status, 403);
  assert.equal((await call('POST', `/task-agent/tasks/${T.fb.id}/next-steps/s1`, {}, MCP)).status, 403);
  assert.equal((await call('POST', `/task-agent/tasks/${T.fb.id}/next-steps/s1`, { subject: 'x' })).status, 400);
  assert.equal((await call('POST', `/task-agent/tasks/${T.fb.id}/next-steps/s9`, {})).status, 404);
});
