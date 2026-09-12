'use strict';

/**
 * "While you're in here", over real HTTP against a real database.
 *
 * The two service suites are pure and prove the judgement. This proves the
 * chain nobody else covers: task rows out of SQLite, through the Jira link
 * ledger, into the matcher, and out of a mounted route in the shape a screen
 * will read. A green service suite says nothing about routing, and a green
 * routing suite says nothing about a field dropped by a response whitelist —
 * both of which have cost this repo a shipped bug.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-cw-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const db = require('../db/database');
const taskStore = require('../services/task-store');
const currentWork = require('../services/current-work');

let server;
let base;
const MEETING = 'Meetings/2026/09/2026-09-08 – Support Team Performance.md';

// What the resolver will say. Stubbed, because what is under test here is the
// DATABASE chain, not the precedence rules — those are pinned pure elsewhere.
let working = null;
const realCurrent = currentWork.current;

test.before(async () => {
  await db.init();

  // A cluster from one meeting, plus unrelated work, shaped like the live store.
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const t = taskStore.createTask({
      text: 'Meeting commitment number ' + i,
      source: 'meeting-promotion',
      origin_path: MEETING,
      context: 'meeting-follow-up',
    });
    ids.push(t.id ?? t.task_id);
  }
  for (let i = 0; i < 20; i++) {
    taskStore.createTask({ text: 'Unrelated work item ' + i, source: 'email-promotion', context: 'queue' });
  }
  working = { known: true, kind: 'session', task: 'Meeting commitment number 0', taskIds: [ids[0]], app: null, confidence: 'high', source: 'focus-session', paused: null, why: 'you started a session on this' };
  currentWork.current = () => working;

  const app = express();
  app.use(express.json());
  app.use('/api/current-work', require('./current-work'));
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
});

test.after(() => {
  currentWork.current = realCurrent;
  return new Promise(r => server.close(r));
});

async function get(p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
}

test('GET /api/current-work returns what he is on', async () => {
  const { status, body } = await get('/api/current-work');
  assert.equal(status, 200);
  assert.equal(body.kind, 'session');
  assert.equal(body.confidence, 'high');
});

test('⚠ /while-here is a LITERAL path, not a parameter', async () => {
  const { status, body } = await get('/api/current-work/while-here');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.cohorts), 'the cohort payload, not something else');
});

test('the real DB chain produces the meeting cohort', async () => {
  const { body } = await get('/api/current-work/while-here');
  assert.ok(body.best, 'a cohort was found through SQLite, not a fixture');
  assert.equal(body.best.kind, 'meeting');
  assert.equal(body.best.count, 3, 'the other three commitments from that meeting');
});

test('every suggested task carries an id and its wording', async () => {
  const { body } = await get('/api/current-work/while-here');
  for (const t of body.best.tasks) {
    assert.ok(Number.isFinite(t.id), 'an id a screen can act on');
    assert.ok(typeof t.text === 'string' && t.text.length > 0, 'and words he will recognise');
  }
});

test('⚠ the payload SAYS what the suggestion is based on', async () => {
  // A cohort presented without its premise is a fact from nowhere. The screen
  // has to be able to say "because you started a session on X".
  const { body } = await get('/api/current-work/while-here');
  assert.ok(body.working, 'the resolver answer travels with the suggestion');
  assert.equal(body.working.kind, 'session');
  assert.ok(body.working.why);
});

test('⚠ the task he is on is never suggested back to him', async () => {
  const { body } = await get('/api/current-work/while-here');
  assert.equal(body.best.tasks.some(t => t.id === working.taskIds[0]), false);
});

test('⚠ the LAPTOP branch offers no cohort, and that is by construction', async () => {
  const saved = working;
  working = { known: true, kind: 'app', task: null, taskIds: [], app: 'Code', confidence: 'low', source: 'desktop-activity', paused: null, why: 'you are at the laptop in Code — which says nothing about which task' };
  const { body } = await get('/api/current-work/while-here');
  working = saved;
  assert.deepEqual(body.cohorts, []);
  assert.equal(body.best, null);
  assert.deepEqual(body.gaps, [], 'not a failure — there is simply nothing to match on');
  assert.match(body.working.why, /says nothing about which task/);
});

test('⚠ an unknown answer offers nothing and still says why', async () => {
  const saved = working;
  working = { known: false, kind: null, task: null, taskIds: [], app: null, confidence: null, source: null, paused: null, why: 'none of the three sources could be read' };
  const { body } = await get('/api/current-work/while-here');
  working = saved;
  assert.equal(body.best, null);
  assert.equal(body.working.known, false);
});

test('a block with several tasks merges their cohorts rather than picking one', async () => {
  const rows = db.listTaskRows({ includeDone: false }).filter(r => r.origin_path === MEETING);
  const saved = working;
  working = { ...saved, kind: 'block', task: null, taskIds: [rows[0].id, rows[1].id], confidence: 'medium', source: 'task-block' };
  const { body } = await get('/api/current-work/while-here');
  working = saved;
  const meeting = body.cohorts.find(c => c.kind === 'meeting');
  assert.ok(meeting, 'both tasks share the meeting, and it appears once');
  assert.equal(body.cohorts.filter(c => c.kind === 'meeting').length, 1, 'merged by key, not duplicated');
});

test('⚠ NEGATIVE: a done task is never offered as more-like-this', async () => {
  const rows = db.listTaskRows({ includeDone: false }).filter(r => r.origin_path === MEETING);
  const victim = rows[rows.length - 1];
  taskStore.updateTask(victim.id, { status: 'done' });
  const { body } = await get('/api/current-work/while-here');
  assert.equal(body.best.tasks.some(t => t.id === victim.id), false, 'finished work is not more of this');
  assert.equal(body.best.count, 2, 'and the count drops with it');
});
