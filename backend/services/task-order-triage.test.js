'use strict';

/**
 * Drag-and-drop order + the triage run's "still missing" rule (20 Oct 2026).
 *
 * Pure halves first (no DB), then the real store: a "none" answer persists on
 * a NEURO task, a value clears it, a MoSCoW change forgets the dragged
 * position, and the order routes over real HTTP.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-ordertriage-')), 'a.db');

const triage = require('../../shared/task-triage.cjs');
const db = require('../db/database');
const taskOrder = require('./task-order');

// ── Pure: what is missing ────────────────────────────────────────────────

test('an empty NEURO row is missing every field', () => {
  assert.deepEqual(triage.missingFields({ task_id: 1 }), ['moscow', 'priority', 'estimate', 'due', 'origin']);
});

test('a GUESSED MoSCoW or origin is still missing — confirming it is the decision', () => {
  const m = triage.missingFields({
    moscow: 'should', moscowProposed: true, taskPriority: 2, estimateMinutes: 30,
    due_date: '2026-10-21', origin: 'commitment', originProposed: true,
  });
  assert.deepEqual(m, ['moscow', 'origin']);
});

test('"none" answers a field; MoSCoW cannot be answered none', () => {
  const m = triage.missingFields({
    moscow: null, triageNone: ['due', 'estimate', 'priority', 'origin', 'moscow'],
  });
  assert.deepEqual(m, ['moscow']);
  assert.deepEqual(triage.normNone(['due', 'moscow', 'due', 'junk']), ['due']);
});

test('pruneNone drops a field once it has a value', () => {
  assert.deepEqual(triage.pruneNone(['due', 'estimate'], { due: '2026-10-21', estimate: null }), ['estimate']);
});

test('only NEURO and Microsoft rows are triageable', () => {
  assert.equal(triage.triageable({ task_id: 3 }), true);
  assert.equal(triage.triageable({ ms_id: 'AAk' }), true);
  assert.equal(triage.triageable({ filePath: 'Daily/x.md', lineNumber: 3 }), false);
  assert.equal(triage.triageable({ task_id: 3, done: 1 }), false);
});

// ── Pure: slot-preserving order ──────────────────────────────────────────

const row = (id, moscow, score) => ({ task_id: id, moscow, _score: score });

test('his order wins inside a band and the bands keep their slots', () => {
  // Score order interleaves bands: must, should, must, should, must.
  const ranked = [row(1, 'must', 90), row(2, 'should', 80), row(3, 'must', 70), row(4, 'should', 60), row(5, 'must', 50)];
  const map = {
    'task:5': { rank: 1000, band: 'must' },
    'task:1': { rank: 2000, band: 'must' },
    'task:3': { rank: 3000, band: 'must' },
  };
  const out = taskOrder.applyOrder(ranked, map).map((r) => r.task_id);
  // Musts re-dealt into slots 0, 2, 4 as 5, 1, 3; Shoulds untouched in 1, 3.
  assert.deepEqual(out, [5, 2, 1, 4, 3]);
});

test('an unplaced row sits at the TOP of its band, in score order', () => {
  const ranked = [row(1, 'must', 90), row(2, 'must', 80), row(3, 'must', 70)];
  const map = { 'task:1': { rank: 1000, band: 'must' } };
  assert.deepEqual(taskOrder.applyOrder(ranked, map).map((r) => r.task_id), [2, 3, 1]);
});

test('a placement recorded in another band counts as unplaced', () => {
  const ranked = [row(1, 'must', 90), row(2, 'must', 80)];
  const map = { 'task:2': { rank: 1, band: 'should' }, 'task:1': { rank: 5, band: 'must' } };
  assert.deepEqual(taskOrder.applyOrder(ranked, map).map((r) => r.task_id), [2, 1]);
});

test('no stored order changes nothing', () => {
  const ranked = [row(1, 'must', 90), row(2, 'should', 80)];
  assert.equal(taskOrder.applyOrder(ranked, {}), ranked);
});

// ── Real store ───────────────────────────────────────────────────────────

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/todos', require('../routes/todos'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

const post = (url, body) => fetch(`${base}${url}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const patch = (url, body) => fetch(`${base}${url}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

test('a "no date" answer persists on a NEURO task, and a date clears it', () => {
  const taskStore = require('./task-store');
  const { task } = taskStore.createTask({ text: 'Triage fixture one with no date', source: 'test' });
  taskStore.updateTask(task.id, { triageNone: ['due', 'estimate'] });
  let shaped = taskStore.toTodoShape(db.getTaskRow(task.id), {});
  assert.deepEqual(shaped.triageNone, ['due', 'estimate']);
  assert.ok(!triage.missingFields(shaped).includes('due'));

  taskStore.updateTask(task.id, { due_date: '2026-11-01' });
  shaped = taskStore.toTodoShape(db.getTaskRow(task.id), {});
  assert.deepEqual(shaped.triageNone, ['estimate']);
});

test('changing MoSCoW forgets the dragged position', () => {
  const taskStore = require('./task-store');
  const { task } = taskStore.createTask({ text: 'Triage fixture two for ordering', source: 'test', moscow: 'must' });
  taskOrder.reorder({ band: 'must', keys: [`task:${task.id}`] });
  assert.ok(taskOrder.readMap()[`task:${task.id}`]);
  taskStore.updateTask(task.id, { moscow: 'should' });
  assert.equal(taskOrder.readMap()[`task:${task.id}`], undefined);
});

test('POST /order saves the band, and refuses junk', async () => {
  const ok = await post('/api/todos/order', { band: 'should', keys: ['ms:AAkALgAAA=', 'task:900', 'ms:Zx_9-b'] });
  assert.equal(ok.status, 200);
  const map = taskOrder.readMap();
  assert.ok(map['ms:AAkALgAAA='].rank < map['ms:Zx_9-b'].rank);
  assert.equal(map['ms:AAkALgAAA='].band, 'should');
  // A NEURO key with no row is pruned — DB status is the authority there.
  assert.equal(map['task:900'], undefined);

  assert.equal((await post('/api/todos/order', { band: 'urgent', keys: ['task:1'] })).status, 400);
  assert.equal((await post('/api/todos/order', { band: 'must', keys: ['DROP TABLE'] })).status, 400);

  const reset = await post('/api/todos/order/reset', { band: 'should' });
  assert.equal(reset.json.removed >= 1, true);
  assert.equal(taskOrder.readMap()['ms:AAkALgAAA='], undefined);
});

test('a Microsoft task holds estimate, origin and none privately', async () => {
  const msLocal = require('./ms-task-local');
  const res = await patch('/api/todos/ms/AAkTRIAGE/local', { moscow: 'could', estimateMinutes: 60, origin: 'improvement', none: ['priority'] });
  assert.equal(res.status, 200);
  const [annotated] = msLocal.annotate([{ ms_id: 'AAkTRIAGE', text: 'x' }]);
  assert.equal(annotated.estimateMinutes, 60);
  assert.equal(annotated.origin, 'improvement');
  assert.deepEqual(annotated.triageNone, ['priority']);
  assert.deepEqual(triage.missingFields({ ...annotated, due_date: null }), ['due']);

  // Refused, never normalised into a clear.
  assert.equal((await patch('/api/todos/ms/AAkTRIAGE/local', { origin: 'maybe' })).status, 400);
  assert.equal((await patch('/api/todos/ms/AAkTRIAGE/local', { none: ['moscow'] })).status, 400);
  assert.equal(msLocal.get('AAkTRIAGE').origin, 'improvement');
});
