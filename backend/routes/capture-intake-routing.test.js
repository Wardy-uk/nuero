'use strict';

/**
 * Brief 005 rework — the Tasks "Spotted" exception, enforced on the SERVER.
 *
 * The phone may add or dismiss a capture_todo suggestion and decide nothing
 * else on the older queue (D-012 clarification). Two server pieces:
 *   1. THE BOUNDARY — `/api/todos/suggestions/:actionId/{add,dismiss}` and
 *      `/suggestions/batch` look up each action's STORED type and refuse anything
 *      that is not a pending capture_todo, before writing. No header, PIN or body
 *      field widens it.
 *   2. DEFENCE IN DEPTH — the generic `/api/actions` decide routes refuse a
 *      request that identifies as an iOS app. Downgrade-only: a client that
 *      hides its identity is the desktop PIN holder it already was.
 *
 * Real HTTP through real SQLite, with `executeAction` SPIED so a refusal can be
 * proven to have reached no executor at all (no email, calendar, Microsoft).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-capture-intake-'));
process.env.NEURO_DB_PATH = path.join(root, 'intake.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const express = require('express');
const db = require('../db/database');
const suggestionEngine = require('../services/suggestion-engine');
const taskStore = require('../services/task-store');

let server, base;
const executed = [];

async function req(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

let n = 0;
const capture = (text) => db.createSaimAction('capture_todo', { text: `${text} ${++n}`, metadata: {} }, 0.8, 'spotted');
// Non-capture types the exception must never reach. Payloads are minimal on
// purpose: if a refusal ever leaked through, the spy below would record it.
const other = (type) => db.createSaimAction(type, { text: `other ${type} ${++n}`, emailId: 'm1', to: { email: 'x@example.com' } }, 0.8, 'test');
const PHONE = { 'X-Neuro-Client': 'neuro-ios' };

test.before(async () => {
  await db.init();
  const real = suggestionEngine.executeAction;
  suggestionEngine.executeAction = async (action) => { executed.push(action.type); return real(action); };
  const app = express();
  app.use(express.json());
  app.use('/api/todos', require('./todos'));
  app.use('/api/actions', require('./actions'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

// ── 1. the capture_todo intake works, and is internal and undoable ──────────

test('add: a capture_todo becomes ONE internal NEURO task, which can be dropped again', async () => {
  const id = capture('Nick to compile the escalation stats');
  const r = await req('POST', `/api/todos/suggestions/${id}/add`, undefined, PHONE);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(db.getSaimAction(id).status, 'executed');
  const taskId = Number(String(r.json.detail).match(/#(\d+)/)[1]);
  const row = taskStore.getTask(taskId);
  assert.ok(row && row.status === 'open', 'an open NEURO task was created');
  // Undoable: the task can be dropped like any other.
  taskStore.updateTask(taskId, { status: 'dropped' });
  assert.equal(taskStore.getTask(taskId).status, 'dropped');
});

test('dismiss: a capture_todo is rejected and NO executor runs', async () => {
  const id = capture('Nick to read the roadmap');
  const before = executed.length;
  const r = await req('POST', `/api/todos/suggestions/${id}/dismiss`, undefined, PHONE);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(db.getSaimAction(id).status, 'rejected');
  assert.equal(executed.length, before, 'dismissing executes nothing');
});

test('batch add + dismiss over capture_todo ids', async () => {
  const a = capture('Nick to book the review'), b = capture('Nick to send the plan');
  const r = await req('POST', '/api/todos/suggestions/batch', { ids: [a, b], verb: 'add' }, PHONE);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.succeeded.sort(), [a, b].sort());
  const c = capture('Nick duplicate');
  const d = await req('POST', '/api/todos/suggestions/batch', { ids: [c], verb: 'dismiss' }, PHONE);
  assert.deepEqual(d.json.succeeded, [c]);
  assert.equal(db.getSaimAction(c).status, 'rejected');
});

// ── 2. NEGATIVE: the exception cannot reach anything else ───────────────────

test('NEGATIVE: add/dismiss refuse every non-capture_todo type, write nothing, execute nothing', async () => {
  for (const type of ['reply_email', 'chase_agenda', 'schedule_focus_block', 'complete_task', 'open_task', 'escalate_ticket', 'vantage_suggestion']) {
    const id = other(type);
    const before = executed.length;
    for (const verb of ['add', 'dismiss']) {
      // Even claiming to be the desktop changes nothing: the stored type decides.
      for (const headers of [PHONE, {}, { 'X-Neuro-Client': 'neuro-desktop' }]) {
        const r = await req('POST', `/api/todos/suggestions/${id}/${verb}`, { type: 'capture_todo' }, headers);
        assert.equal(r.status, 403, `${type} ${verb} ${JSON.stringify(headers)}: ${JSON.stringify(r.json)}`);
      }
    }
    assert.equal(db.getSaimAction(id).status, 'pending', `${type} left untouched`);
    assert.equal(executed.length, before, `${type}: no executor ran`);
  }
});

test('NEGATIVE: a batch with one non-capture_todo id is refused WHOLE — the capture_todo in it stays pending', async () => {
  const good = capture('Nick to tidy the board');
  const bad = other('reply_email');
  const before = executed.length;
  for (const verb of ['add', 'dismiss']) {
    const r = await req('POST', '/api/todos/suggestions/batch', { ids: [good, bad], verb }, PHONE);
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.ok(r.json.refused.some((x) => Number(x.id) === bad));
  }
  assert.equal(db.getSaimAction(good).status, 'pending', 'nothing in a refused batch is decided');
  assert.equal(db.getSaimAction(bad).status, 'pending');
  assert.equal(executed.length, before);
});

test('NEGATIVE: junk is refused — unknown verb, empty ids, non-numeric id, missing action', async () => {
  assert.equal((await req('POST', '/api/todos/suggestions/batch', { ids: [capture('x')], verb: 'approve' })).status, 400);
  assert.equal((await req('POST', '/api/todos/suggestions/batch', { ids: [], verb: 'add' })).status, 400);
  assert.equal((await req('POST', '/api/todos/suggestions/abc/add')).status, 400);
  assert.equal((await req('POST', '/api/todos/suggestions/999999/add')).status, 404);
});

test('NEGATIVE: no approval-code or switch state is touched by the intake', async () => {
  db.setState('approval_code', 'scrypt$sentinel');
  const id = capture('Nick to check the code is untouched');
  await req('POST', `/api/todos/suggestions/${id}/add`, undefined, PHONE);
  await req('POST', `/api/todos/suggestions/${other('reply_email')}/add`, undefined, PHONE);
  assert.equal(db.getState('approval_code'), 'scrypt$sentinel');
});

// ── 3. the generic queue refuses a phone; the desktop still works ───────────

test('NEGATIVE: the generic decide routes refuse a request identifying as an iOS app', async () => {
  const id = other('schedule_focus_block');
  const cap = capture('Nick phone generic');
  const before = executed.length;
  for (const headers of [PHONE, { 'X-Neuro-Client': 'saim-ios' }, { 'User-Agent': 'Saim/1 CFNetwork/1' }, { 'User-Agent': 'Neuro/1 CFNetwork/1' }]) {
    for (const [method, url, body] of [
      ['POST', `/api/actions/${id}/approve`], ['POST', `/api/actions/${cap}/approve`],
      ['POST', `/api/actions/${id}/reject`], ['POST', '/api/actions/batch', { ids: [id], verb: 'approve' }],
      ['POST', '/api/actions/bulk-reject', { type: 'schedule_focus_block' }],
      ['POST', `/api/actions/${id}/snooze`, { minutes: 60 }], ['DELETE', `/api/actions/${id}/snooze`],
    ]) {
      const r = await req(method, url, body, headers);
      assert.equal(r.status, 403, `${method} ${url} ${JSON.stringify(headers)} → ${r.status}`);
      assert.equal(r.json.phone, true);
    }
  }
  assert.equal(db.getSaimAction(id).status, 'pending');
  assert.equal(db.getSaimAction(cap).status, 'pending');
  assert.equal(executed.length, before);
});

test('POSITIVE: the authorised desktop paths still work (no phone identity)', async () => {
  // Desktop approve of a capture_todo through the generic route (TodoPanel).
  const cap = capture('Nick desktop approve');
  const a = await req('POST', `/api/actions/${cap}/approve`);
  assert.equal(a.status, 200, JSON.stringify(a.json));
  // Desktop reject of another type (ActionsPanel).
  const o = other('schedule_focus_block');
  assert.equal((await req('POST', `/api/actions/${o}/reject`)).status, 200);
  assert.equal(db.getSaimAction(o).status, 'rejected');
  // Desktop batch (TodoPanel "Add all") and snooze still answer.
  const b1 = capture('Nick desktop batch');
  const b = await req('POST', '/api/actions/batch', { ids: [b1], verb: 'reject' });
  assert.deepEqual(b.json.succeeded, [b1]);
  // The list read is not a decide route, even for the phone.
  assert.equal((await req('GET', '/api/actions', undefined, PHONE)).status, 200);
  // A browser user agent is not an iOS app.
  const c2 = capture('Nick browser');
  assert.equal((await req('POST', `/api/actions/${c2}/reject`, undefined, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0)' })).status, 200);
});
