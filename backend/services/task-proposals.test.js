'use strict';

/**
 * NEURO's suggested MoSCoW / estimate / due date (services/task-proposals.js).
 *
 * Real scratch DB through task-store.createTask / updateTask and the real
 * routes — the guarantee that a suggestion never becomes a value lives in the
 * STORAGE (its own column), so only the real writer can prove it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-proposals-'));
process.env.NEURO_DB_PATH = path.join(root, 'p.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Tasks'), { recursive: true });

const db = require('../db/database');
const taskStore = require('./task-store');
const proposals = require('./task-proposals');
const triage = require('../../shared/task-triage.cjs');

test.before(async () => { await db.init(); });

function pad(n) { return String(n).padStart(2, '0'); }
function key(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
const NOW = new Date();
const inDays = (n) => { const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate()); d.setDate(d.getDate() + n); return d; };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const words = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

test('a new task gets a proposed MoSCoW in its OWN column; the real field stays null', () => {
  const { id } = taskStore.createTask({ text: 'Brainstorm ideas for the team offsite', source: 'manual' });
  const row = db.getTaskRow(id);
  assert.equal(row.moscow, null, 'moscow is never written by a proposal');
  assert.equal(row.moscow_proposed, 0);
  const p = proposals.parse(row.proposals_json);
  assert.equal(p.moscow.value, 'could');
  // And it still counts as missing for triage.
  const shape = taskStore.toTodoShape(row, {});
  assert.deepEqual(shape.proposals.moscow.value, 'could');
  assert.ok(triage.missingFields(shape).includes('moscow'), 'a proposal is not triaged');
});

test('a due date stated behind a deadline cue is proposed, never written to due_date', () => {
  const target = inDays(9);
  const { id } = taskStore.createTask({ text: `Send the rota to Hope by ${words(target)}`, source: 'manual' });
  const row = db.getTaskRow(id);
  assert.equal(row.due_date, null);
  const p = proposals.parse(row.proposals_json);
  assert.equal(p.due.date, key(target));
  assert.equal(p.due.basis, 'stated');
  assert.ok(triage.missingFields(taskStore.toTodoShape(row, {})).includes('due'));
});

test('negatives: a past date, or a date with no deadline cue, is never proposed', () => {
  const past = inDays(-5);
  const a = taskStore.createTask({ text: `Chase the invoice by ${words(past)}`, source: 'manual' });
  assert.equal(proposals.parse(db.getTaskRow(a.id).proposals_json).due, undefined, 'past date refused');
  const future = inDays(6);
  const b = taskStore.createTask({ text: `Monitor ticket volumes starting ${words(future)}`, source: 'manual' });
  assert.equal(proposals.parse(db.getTaskRow(b.id).proposals_json).due, undefined, '"starting" is not a deadline');
});

test('a commitment with no stated date gets the ten-day default; an improvement gets nothing', () => {
  const c = taskStore.createTask({ text: 'Review the escalation template wording', source: 'manual', origin: 'commitment' });
  const p = proposals.parse(db.getTaskRow(c.id).proposals_json);
  assert.equal(p.due.basis, 'default');
  assert.equal(p.due.date, key(inDays(10)));
  const i = taskStore.createTask({ text: 'Tidy the knowledge base categories', source: 'manual', origin: 'improvement' });
  assert.equal(proposals.parse(db.getTaskRow(i.id).proposals_json).due, undefined);
});

test('no due proposal on a Microsoft-linked task', () => {
  const c = taskStore.createTask({ text: 'Agree the support rota with the board', source: 'manual', origin: 'commitment', ms_id: 'AAMk-linked-1' });
  assert.equal(proposals.parse(db.getTaskRow(c.id).proposals_json).due, undefined);
});

test('no estimate is invented without data — never the 30-minute assumption', () => {
  const { id } = taskStore.createTask({ text: 'Write up the vendor comparison for Chris', source: 'manual' });
  assert.equal(proposals.parse(db.getTaskRow(id).proposals_json).estimate, undefined);
  assert.equal(db.getTaskRow(id).estimate_minutes, null);
});

test('an estimate is proposed from Nick\'s finished focus sessions on a similar task, snapped up', () => {
  db.setState('focus_session_history', JSON.stringify([
    { taskId: 9991, text: 'Prepare the quarterly SLA breach summary for leadership', actualMinutes: 50, endedReason: 'completed' },
    { taskId: 9992, text: 'Prepare quarterly SLA breach summary leadership pack', actualMinutes: 70, endedReason: 'completed' },
    // An abandoned session is not the length of the job.
    { taskId: 9993, text: 'Prepare the quarterly SLA breach summary for leadership', actualMinutes: 400, endedReason: 'abandoned' },
  ]));
  const { id } = taskStore.createTask({ text: 'Prepare the quarterly SLA breach summary for leadership again', source: 'manual' });
  const p = proposals.parse(db.getTaskRow(id).proposals_json);
  assert.ok(p.estimate, 'proposed');
  assert.equal(p.estimate.basis, 'measured-similar');
  assert.equal(p.estimate.minutes, 60, 'median 60 snaps to the 60 bucket (abandoned excluded)');
  assert.equal(db.getTaskRow(id).estimate_minutes, null, 'never written to the real column');
  db.setState('focus_session_history', '[]');
});

test('a value Nick set is never overwritten, and setting a field drops its proposal', () => {
  const target = inDays(12);
  const { id } = taskStore.createTask({ text: `Brainstorm the onboarding ideas due ${words(target)}`, source: 'manual' });
  let p = proposals.parse(db.getTaskRow(id).proposals_json);
  assert.ok(p.moscow && p.due);
  taskStore.updateTask(id, { moscow: 'must' });
  let row = db.getTaskRow(id);
  assert.equal(row.moscow, 'must');
  p = proposals.parse(row.proposals_json);
  assert.equal(p.moscow, undefined, 'MoSCoW proposal dropped once Nick set it');
  assert.ok(p.due, 'the other proposal survives');
  // Answering "none" for the date is a decision too.
  taskStore.updateTask(id, { triageNone: ['due'] });
  row = db.getTaskRow(id);
  assert.equal(proposals.parse(row.proposals_json).due, undefined);
  // Re-proposing never touches what is set.
  proposals.proposeAndStore(id);
  row = db.getTaskRow(id);
  assert.equal(row.moscow, 'must');
  assert.equal(proposals.parse(row.proposals_json).moscow, undefined);
});

test('a task created WITH values gets no proposal for those fields', () => {
  const { id } = taskStore.createTask({ text: 'Brainstorm offsite agenda ideas', source: 'manual', moscow: 'wont', due_date: key(inDays(3)), estimateMinutes: 15 });
  assert.deepEqual(proposals.parse(db.getTaskRow(id).proposals_json), {});
});

test('pure: an existing proposal is not shown when the field is answered none', () => {
  const p = proposals.proposeFor({ text: 'Sort it out by tomorrow', triageNone: ['due', 'estimate'], now: NOW }, {});
  assert.equal(p.due, undefined);
  assert.equal(p.estimate, undefined);
});

// ── Real HTTP: PATCH is the confirm, and /api/todos carries the proposals ───

function request(server, method, url, body) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch { resolve({ status: res.statusCode, body: buf }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('routes: /api/todos carries proposals; PATCH with the proposed value confirms it', async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', require('../routes/tasks'));
  app.use('/api/todos', require('../routes/todos'));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const target = inDays(8);
    const { id } = taskStore.createTask({ text: `Capture the retro ideas before ${words(target)}`, source: 'manual' });
    const list = await request(server, 'GET', '/api/todos');
    assert.equal(list.status, 200);
    const row = (list.body.todos || []).find((t) => t.task_id === id);
    assert.ok(row, 'task listed');
    assert.equal(row.proposals.due.date, key(target));
    assert.ok(row.triage.missing.includes('due'), 'proposal still counted as missing');
    assert.ok(row.triage.missing.includes('moscow'));
    assert.equal(row.due_date, null, 'the list never shows a proposal as the date');

    const r = await request(server, 'PATCH', `/api/tasks/${id}`, { due_date: row.proposals.due.date, moscow: row.proposals.moscow.value });
    assert.equal(r.status, 200);
    const stored = db.getTaskRow(id);
    assert.equal(stored.due_date, key(target));
    assert.equal(stored.moscow_proposed, 0);
    assert.deepEqual(proposals.parse(stored.proposals_json), {}, 'confirmed → proposal gone');
  } finally {
    server.close();
  }
});
