'use strict';

/**
 * Repeating tasks over REAL HTTP: POST /api/tasks with `recurrence`, PATCH
 * (omitted / null / object), complete → `recurred` with the reopened task,
 * /api/todos rows carry `repeat` + `recurrenceLabel`, history + undo routes,
 * and a bad rule answers 400 with nothing written.
 *
 * ⚠ Dates are built from the real clock: the routes use today, so a fixed
 * date here would be a date bomb.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-recur-http-'));
process.env.NEURO_DB_PATH = path.join(root, 'r.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Tasks'), { recursive: true });

const db = require('../db/database');
const { toDateStr } = require('../../shared/working-days.cjs');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', require('./tasks'));
  app.use('/api/todos', require('./todos'));
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) { server.closeAllConnections?.(); server.close(); }
});

const call = (method, url, body) => fetch(`${base}${url}`, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

function inDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

test('POST /api/tasks with recurrence → stored, labelled; complete → reopened at the next slot', async () => {
  const due = inDays(3);
  const created = await call('POST', '/api/tasks', {
    text: 'Water the plants (routing)', source: 'manual', due_date: due,
    recurrence: { kind: 'interval', every: 1, unit: 'week' },
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.equal(created.json.task.recurrenceLabel, 'Every week');
  assert.equal(created.json.task.recurrence.anchor, due);
  const id = created.json.id;

  const done = await call('POST', `/api/tasks/${id}/complete`);
  assert.equal(done.status, 200);
  assert.equal(done.json.task.status, 'open', 'a repeating task comes back open');
  assert.equal(done.json.task.due_date, inDays(10));
  assert.equal(done.json.recurred.nextDue, inDays(10));
  assert.match(done.json.recurred.notice, /^Done — next due /);

  const hist = await call('GET', `/api/tasks/${id}/recurrence`);
  assert.equal(hist.status, 200);
  assert.equal(hist.json.recurrenceLabel, 'Every week');
  assert.equal(hist.json.history.length, 1);
  assert.equal(hist.json.history[0].slotDue, due);
  assert.equal(hist.json.upcoming[0], inDays(10));

  const undo = await call('POST', `/api/tasks/${id}/recurrence/undo`);
  assert.equal(undo.status, 200, JSON.stringify(undo.json));
  assert.equal(undo.json.task.due_date, due);
  const again = await call('POST', `/api/tasks/${id}/recurrence/undo`);
  assert.equal(again.status, 409);
});

test('GET /api/todos rows carry repeat + recurrenceLabel (and NOT on `recurrence`, which is Microsoft\'s token)', async () => {
  const created = await call('POST', '/api/tasks', {
    text: 'Bins out (routing)', source: 'manual',
    recurrence: { kind: 'weekdays', days: ['thu'], anchor: inDays(1) },
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const list = await call('GET', '/api/todos');
  assert.equal(list.status, 200);
  const rows = list.json.todos || list.json.items || [];
  const row = rows.find(r => r.task_id === created.json.id);
  assert.ok(row, 'the task is on the list');
  assert.equal(row.recurrenceLabel, 'Every Thursday');
  assert.deepEqual(row.repeat.days, ['thu']);
  assert.equal(row.recurrence, null);
  const plain = await call('GET', '/api/tasks');
  assert.equal(plain.json.tasks.find(t => t.id === created.json.id).recurrenceLabel, 'Every Thursday');
});

test('PATCH: null stops it repeating; a rule sets it; omitted leaves it', async () => {
  const created = await call('POST', '/api/tasks', { text: 'Pay the window cleaner (routing)', source: 'manual', due_date: inDays(5) });
  const id = created.json.id;
  const set = await call('PATCH', `/api/tasks/${id}`, { recurrence: { kind: 'last-working-day' } });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.equal(set.json.task.recurrenceLabel, 'Last working day of the month');
  const untouched = await call('PATCH', `/api/tasks/${id}`, { notes: 'cash' });
  assert.equal(untouched.json.task.recurrenceLabel, 'Last working day of the month');
  const stop = await call('PATCH', `/api/tasks/${id}`, { recurrence: null });
  assert.equal(stop.json.task.recurrence, null);
});

test('a bad rule is a 400 and writes nothing', async () => {
  const before = db.get('SELECT COUNT(*) AS c FROM tasks').c;
  const bad = await call('POST', '/api/tasks', {
    text: 'Never created (routing)', source: 'manual', recurrence: { kind: 'interval', unit: 'fortnight' },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /recurrence\.unit/);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM tasks').c, before);
});
