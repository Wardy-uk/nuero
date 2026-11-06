'use strict';

/**
 * Delegating tasks by hand (6 Nov 2026). Real DB, task-store, waiting-on and
 * ms-task-local; the roster, leave, Microsoft mirror and mail are injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-delegation-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });
for (const k of ['ANTHROPIC_API_KEY', 'HA_TOKEN', 'HA_URL']) delete process.env[k];

const db = require('../db/database');
const taskStore = require('./task-store');
const waitingOn = require('./waiting-on');
const msLocal = require('./ms-task-local');
const td = require('./task-delegation');

test.before(async () => { await db.init(); });

const NOW = Date.parse('2026-11-06T12:00:00Z');
let actions = new Map();
let seq = 0;
const MS = [{ ms_id: 'AAMk-1', text: 'Start the "known gaps" log', source: 'MS Planner', msPlan: 'Support - Improvement Plan', due_date: null }];
const deps = {
  reports: () => [
    { name: 'Nathan Rutland', email: 'nathan@nurtur.tech', group: '1st Line' },
    { name: 'Zoe Rees', email: null, group: '1st Line' },
  ],
  leaveFor: (name) => ({ known: true, dates: new Set(name === 'Zoe Rees' ? ['2026-11-09'] : []) }),
  msTasks: () => MS.filter((t) => !msLocal.delegatedMap().has(t.ms_id)),
  prepareCompose: (a) => { const id = `act${++seq}`; actions.set(id, { actionId: id, status: 'prepared', a }); return { ok: true, action: { actionId: id, payloadHash: 'h', version: 1 } }; },
  getAction: (id) => actions.get(id) || null,
  now: () => NOW,
};

test('the draft names every task, uses the earliest due date, and leaves the unknown as a gap', () => {
  const d = td.composeDraft({ person: 'Nathan Rutland', items: [
    { title: 'QA average check', due: '2026-11-20' }, { title: 'Known gaps log', due: '2026-11-12' }] });
  assert.match(d.subject, /\+ 1 more/);
  assert.match(d.body, /^Hi Nathan,/);
  assert.match(d.body, /- QA average check/);
  assert.match(d.body, /- Known gaps log/);
  assert.match(d.body, /By when: Thu 12 Nov/);
  assert.match(d.body, /\[details\]/);
});

test('items are refused, never repaired', () => {
  assert.equal(td.parseItems([]).ok, false);
  assert.equal(td.parseItems([{ kind: 'task', id: 'abc' }]).ok, false);
  assert.equal(td.parseItems([{ kind: 'jira', id: '1' }]).ok, false);
  assert.deepEqual(td.parseItems([{ kind: 'task', id: 5 }, { kind: 'task', id: '5' }]).items, [{ kind: 'task', id: '5' }]);
});

test('people: leave is said, never refused', () => {
  const p = td.people({ deps });
  assert.deepEqual(p.map((x) => x.name), ['Nathan Rutland', 'Zoe Rees']);
  assert.match(p[1].leave.say, /on leave Mon 9 Nov/);
  assert.equal(p[0].leave.say, null);
});

test('"told them": two tasks (NEURO + Microsoft) become ONE delegation, leave Tasks, and are labelled with their ids', () => {
  const id = taskStore.createTask({ text: 'Sort the macro library', source: 'manual' }).id;
  const r = td.delegate({ person: 'Nathan Rutland', items: [{ kind: 'task', id }, { kind: 'ms', id: 'AAMk-1' }], via: 'told', deps });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.status, 'delegated');
  // NEURO task dropped with a note; Microsoft task hidden privately.
  const after = taskStore.getTask(id);
  assert.equal(after.status, 'dropped');
  assert.match(after.notes, /Delegated to Nathan Rutland/);
  assert.equal(msLocal.delegatedMap().get('AAMk-1').to, 'Nathan Rutland');
  // ONE waiting-on row, owed by Nathan.
  const w = waitingOn.list({ status: 'open' }).find((x) => x.key === r.waitingKey);
  assert.ok(w, 'a waiting-on row');
  assert.match(w.text, /Sort the macro library; Start the "known gaps" log/);
  // Labelled with both ids.
  const lab = td.byWaitingKey({ deps }).get(r.waitingKey);
  assert.equal(lab.source, 'manual');
  assert.deepEqual(lab.items.map((i) => i.label), [`#${id}`, 'Planner']);
  // A second delegation of the same task is refused.
  const again = td.delegate({ person: 'Nathan Rutland', items: [{ kind: 'ms', id: 'AAMk-1' }], via: 'told', deps });
  assert.equal(again.ok, false);
});

test('take it back: task reopens, Microsoft marker clears, commitment closes', () => {
  const [key] = [...td.byWaitingKey({ deps }).keys()].filter((k) => td.byWaitingKey({ deps }).get(k).source === 'manual');
  const lab = td.byWaitingKey({ deps }).get(key);
  const r = td.takeBack(key, { deps });
  assert.equal(r.ok, true);
  assert.equal(taskStore.getTask(Number(lab.items[0].id)).status, 'open');
  assert.equal(msLocal.delegatedMap().has('AAMk-1'), false);
  assert.equal(waitingOn.list({ status: 'all' }).find((x) => x.key === key).status, 'dropped');
  assert.equal(td.byWaitingKey({ deps }).has(key), false);
});

test('email: nothing moves until the send is VERIFIED; a gap refuses; a failed send cancels', () => {
  const t = taskStore.createTask({ text: 'Review the escalation macro', source: 'manual' });
  const id = t.id;
  const gap = td.delegate({ person: 'Nathan Rutland', items: [{ kind: 'task', id }], via: 'email', deps });
  assert.equal(gap.ok, false);
  assert.deepEqual(gap.gaps, ['[details]', '[date]']);
  const noEmail = td.delegate({ person: 'Zoe Rees', items: [{ kind: 'task', id }], via: 'email', subject: 'x', body: 'y', deps });
  assert.equal(noEmail.ok, false);
  const r = td.delegate({ person: 'Nathan Rutland', items: [{ kind: 'task', id }], via: 'email', subject: 'Could you?', body: 'Please do it by Fri.', deps });
  assert.equal(r.ok, true, r.error);
  assert.equal(taskStore.getTask(id).status, 'open', 'not moved before the send');
  assert.equal(td.pending().length, 1);
  actions.get(r.action.actionId).status = 'executed';
  td.reconcile({ deps });
  assert.equal(taskStore.getTask(id).status, 'open', 'executed is not verified');
  actions.get(r.action.actionId).status = 'verified';
  assert.equal(td.reconcile({ deps }).delegated, 1);
  assert.equal(taskStore.getTask(id).status, 'dropped');
  assert.equal(td.pending().length, 0);
  // A rejected send cancels and moves nothing.
  const t2 = taskStore.createTask({ text: 'Chase the training plan', source: 'manual' });
  const id2 = (t2.task || t2).id;
  const r2 = td.delegate({ person: 'Nathan Rutland', items: [{ kind: 'task', id: id2 }], via: 'email', subject: 'S', body: 'B', deps });
  actions.get(r2.action.actionId).status = 'rejected';
  assert.equal(td.reconcile({ deps }).cancelled, 1);
  assert.equal(taskStore.getTask(id2).status, 'open');
});

test('a hand-over made through the SUGGESTION path is labelled the same way (Nathan, 6 Nov)', () => {
  require('./delegation').ensureTable();
  const t = taskStore.createTask({ text: 'QA average score check', source: 'manual' });
  const id = t.id;
  db.run(`INSERT INTO delegation_suggestions (item_kind, item_id, text_hash, judged_at, verdict, person, status, waiting_key)
    VALUES ('task', ?, 'h', ?, 'suggest', 'Nathan Rutland', 'sent', 'nathan::qa average score check')`, [String(id), new Date(NOW).toISOString()]);
  const lab = td.byWaitingKey({ deps }).get('nathan::qa average score check');
  assert.equal(lab.source, 'suggestion');
  assert.equal(lab.to, 'Nathan Rutland');
  assert.deepEqual(lab.items.map((i) => i.label), [`#${id}`]);
});

test('routes: machines are refused; the literal paths are not read as /:id', async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (req.get('X-Test-Machine')) req.apiClient = { name: 'mcp' }; next(); });
  app.use('/api/delegation', require('../routes/delegation'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api/delegation`;
  try {
    const m = await fetch(`${base}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-Machine': '1' }, body: '{}' });
    assert.equal(m.status, 403);
    const bad = await fetch(`${base}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ person: 'Nobody', items: [{ kind: 'task', id: '1' }], via: 'told' }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /not one of your current direct reports/);
    const tb = await fetch(`${base}/take-back`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'nope' }) });
    assert.equal(tb.status, 404);
    const pend = await fetch(`${base}/tasks/pending`);
    assert.equal(pend.status, 200);
    assert.ok(Array.isArray((await pend.json()).pending));
  } finally { server.close(); }
});
