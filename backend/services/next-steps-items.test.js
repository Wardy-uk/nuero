'use strict';

/**
 * Next steps rows carry what the shared row needs to act in place (7 Nov 2026):
 *  - a task row: Start = a focus session (`start.action: 'focus'`) and the task
 *    id; Done only for a NEURO task;
 *  - a 1-2-1 owed: Book proposes in place (`book-121`) and names the person;
 *  - the drafts row: each waiting draft with the exact version + payload hash a
 *    one-press Send binds to, and Send only where NEURO can execute it now.
 * The owners are stubbed; the composition is the real service.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'next-items-')), 'agent.db');
const db = require('../db/database');

function stub(name, exportsObj) {
  const file = require.resolve(`./${name}`);
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
}

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });

stub('focus-ranking', {
  rankedTodos: () => [
    { task_id: 12, text: 'Chase the Sandford reply', due_date: today, moscow: 'should', estimateMinutes: 20 },
    { task_id: null, text: 'Planner card about rotas', due_date: today, moscow: 'must' },
    { task_id: 13, text: 'Not due, not must', due_date: null, moscow: 'could' },
  ],
});
stub('team-roster', { directReports: () => [{ name: 'Zoe Rees', cadence: 'fortnightly' }, { name: 'Hope Goodall', cadence: 'monthly' }] });
stub('one-to-one-detect', {
  effectiveCadenceFields: (name) => ({ lastHeld: '2026-09-01', nextDue: '2026-09-15', booked: name === 'Hope Goodall' ? '2026-10-01' : null }),
  cadenceState: (s) => (s.booked ? { state: 'unwritten' } : { state: 'overdue', daysOverdue: 20 }),
  cadenceLabel: (s) => s.state,
});
stub('prepared-actions', {
  needsYou: () => ({ known: true, needsApproval: 2, needsReview: 1, say: 'Actions — one press sends each' }),
  listLive: () => [
    { actionId: 'pa_a', version: 2, payloadHash: 'h_a', actionType: 'compose_email', status: 'prepared', executes: true,
      draft: { to: [{ name: 'Chris Middleton', email: 'c@x' }], subject: 'Weekly numbers', body: '<p>Hi Chris,</p><p>Attached.</p>' }, sendsFrom: { address: 'nickw@x' } },
    { actionId: 'pa_b', version: 1, payloadHash: 'h_b', actionType: 'create_calendar_event', status: 'execution_uncertain', executes: true,
      draft: { title: '1-2-1 — Nick / Zoe', start: '2026-11-12T14:00:00', attendees: [{ email: 'z@x', name: 'Zoe Rees' }] } },
    { actionId: 'pa_c', version: 1, payloadHash: 'h_c', actionType: 'compose_email', status: 'approved', executes: true, draft: {} },
  ],
});

let ns;
test.before(async () => {
  if (db.init) await db.init();
  ns = require('./next-steps');
});

test('a task row starts a focus session and carries its id; Done only for a NEURO task', () => {
  const out = ns.read();
  const t = out.items.find((x) => x.id === 'task:12');
  assert.ok(t, 'the due task is listed');
  assert.equal(t.start.action, 'focus');
  assert.equal(t.start.label, 'Start');
  assert.deepEqual(t.task, { taskId: 12, text: 'Chase the Sandford reply', canComplete: true });
  const mirror = out.items.find((x) => x.kind === 'task' && x.title === 'Planner card about rotas');
  assert.equal(mirror.task.canComplete, false);
  assert.equal(mirror.task.taskId, null);
  assert.ok(!out.items.some((x) => x.id === 'task:13'), 'not due and not must stays off');
});

test('a 1-2-1 owed books in place and names the person; one to write up just opens', () => {
  const out = ns.read();
  const zoe = out.items.find((x) => x.id === '121:Zoe Rees');
  assert.equal(zoe.start.action, 'book-121');
  assert.equal(zoe.start.label, 'Book');
  assert.deepEqual(zoe.oneToOne, { person: 'Zoe Rees', state: 'overdue' });
  const hope = out.items.find((x) => x.id === '121:Hope Goodall');
  assert.equal(hope.start.label, 'Open');
  assert.equal(hope.start.action, undefined);
});

test('the drafts row lists each waiting draft with what a one-press Send binds to', () => {
  const out = ns.read();
  const d = out.items.find((x) => x.id === 'drafts:waiting');
  assert.equal(d.start.action, 'drafts');
  assert.equal(d.title, '3 drafted emails waiting on you');
  assert.deepEqual(d.drafts.map((x) => x.actionId), ['pa_a', 'pa_b'], 'only the set needsYou counts (approved is not waiting)');
  const a = d.drafts[0];
  assert.equal(a.version, 2);
  assert.equal(a.payloadHash, 'h_a');
  assert.equal(a.canSend, true);
  assert.deepEqual(a.to, ['Chris Middleton']);
  assert.equal(a.preview, 'Hi Chris, Attached.');
  assert.equal(a.from, 'nickw@x');
  const b = d.drafts[1];
  assert.equal(b.canSend, false, 'an uncertain send is never re-sent from here');
  assert.equal(b.subject, '1-2-1 — Nick / Zoe');
  assert.deepEqual(b.to, ['Zoe Rees']);
  assert.equal(b.when, '2026-11-12 14:00');
  assert.equal(d.draftsMore, 1);
});

test('draftRow: an unexecutable prepared draft offers no Send', () => {
  assert.equal(ns.draftRow({ actionId: 'x', payloadHash: 'h', status: 'prepared', executes: false, draft: { subject: 's' } }).canSend, false);
});
