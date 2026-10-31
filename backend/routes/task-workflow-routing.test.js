'use strict';

/**
 * GET /api/promises/workflow (31 Oct 2026) — the Task workflow screen's one
 * read, over real HTTP through the real api-auth and authority guard, against a
 * scratch DB. The promise ledger is stubbed (the live one needs meeting notes);
 * everything after it — the workbench for ONE key, keep-my-word's threadFrom,
 * the task row — is the real code.
 *
 * Pins: a promise beyond the workbench's horizon (not in the top two) still
 * composes, as "not due yet"; by taskId or by key; a task that is not a promise
 * has its row and no thread; an unknown key is 404; nothing named is 400; the
 * API token can read it (a read); nothing is written.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-workflow-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
for (const k of ['HA_TOKEN', 'HA_URL']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'vault', 'People'), { recursive: true });

const db = require('../db/database');
const ledger = require('../services/promise-ledger');

const PROMISE_TEXT = 'Send Hope the onboarding checklist';
const PLAIN_TEXT = 'Tidy the support macros';
let promiseTask; let plainTask;
const FAR = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);

let server; let base;
test.before(async () => {
  await db.init();
  const ts = require('../services/task-store');
  ts.createTask({ text: PROMISE_TEXT, source: 'manual' });
  promiseTask = db.get('SELECT id FROM tasks WHERE text = ?', [PROMISE_TEXT]).id;
  ts.createTask({ text: PLAIN_TEXT, source: 'manual' });
  plainTask = db.get('SELECT id FROM tasks WHERE text = ?', [PLAIN_TEXT]).id;
  ledger.read = () => ({
    readAt: new Date().toISOString(), gaps: [],
    promises: [{
      key: `promise:${promiseTask}`, text: PROMISE_TEXT, open: true, taskIds: [promiseTask], leadTaskId: promiseTask,
      due: FAR, statedDate: null,
      owedTo: { people: [{ name: 'Hope Goodall' }], ambiguous: [], fromNote: null, resolved: 'Hope Goodall' },
      source: { readable: true, title: 'Leadership', path: 'Meetings/2026/10/Leadership.md', line: 'Nick will send Hope the onboarding checklist.' },
    }],
  });
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require('../services/api-auth'));
  app.use('/api', require('../services/authority-guard').guard);
  app.use('/api/promises', require('./promise-delivery'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

async function get(p, { token = false } = {}) {
  const r = await fetch(`${base}${p}`, { headers: token ? { 'X-NEURO-API-TOKEN': 'tok-5678' } : { 'X-NEURO-PIN': 'pin-1234' } });
  return { status: r.status, body: await r.json() };
}
const count = (t) => { try { return db.get(`SELECT COUNT(*) n FROM ${t}`).n; } catch { return 0; } };

test('a promise beyond the top two still composes — the same thread object, as "not due yet"', async () => {
  const before = { actions: count('prepared_actions'), tasks: count('tasks') };
  const r = await get(`/api/promises/workflow?taskId=${promiseTask}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.contract, 'task-workflow-v1');
  assert.equal(r.body.key, `promise:${promiseTask}`);
  const t = r.body.thread;
  assert.ok(t, 'thread composed');
  assert.equal(t.title, PROMISE_TEXT);
  assert.equal(t.taskId, promiseTask);
  assert.equal(t.label, 'Keeping your word');
  assert.equal(t.owedTo, 'Hope Goodall');
  assert.equal(t.due.say, 'not due yet');
  assert.ok(Array.isArray(t.evidence) && t.evidence.some((e) => /Nick will send Hope/.test(e.fact)), 'evidence carried');
  assert.ok(t.preparation && t.preparation.state, 'preparation carried');
  assert.equal(t.others, undefined, 'no "more at risk" on the screen');
  assert.equal(r.body.task.id, promiseTask);
  assert.equal(r.body.task.text, PROMISE_TEXT);
  assert.deepEqual({ actions: count('prepared_actions'), tasks: count('tasks') }, before, 'a read writes nothing');
});

test('by key alone: the thread, and its task row', async () => {
  const r = await get(`/api/promises/workflow?key=${encodeURIComponent(`promise:${promiseTask}`)}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.thread.key, `promise:${promiseTask}`);
  assert.equal(r.body.task.id, promiseTask);
});

test('a task that is not a promise: its row, no thread', async () => {
  const r = await get(`/api/promises/workflow?taskId=${plainTask}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.thread, null);
  assert.equal(r.body.key, null);
  assert.equal(r.body.task.text, PLAIN_TEXT);
});

test('an unknown key is 404; nothing named is 400', async () => {
  assert.equal((await get('/api/promises/workflow?key=promise%3A99999')).status, 404);
  assert.equal((await get('/api/promises/workflow?taskId=99999')).status, 404);
  assert.equal((await get('/api/promises/workflow')).status, 400);
});

test('a read: the API token may read it', async () => {
  const r = await get(`/api/promises/workflow?taskId=${promiseTask}`, { token: true });
  assert.equal(r.status, 200);
  assert.ok(r.body.thread);
});
