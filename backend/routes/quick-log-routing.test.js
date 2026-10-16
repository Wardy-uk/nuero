'use strict';

/**
 * Log done (16 Oct 2026) — ad-hoc work recorded as already completed, over a real
 * DB and the real /api/tasks router, plus the Alt dock's own functions.
 *
 *   1. Blank input writes nothing (route and dock).
 *   2. One completed record, source saim-quick-log, no due/estimate/block/session,
 *      audit detail saying it was logged after completion; never folds into an
 *      open task with the same words, even after a startup re-key.
 *   3. In completed history (GET /api/tasks?status=done&q=) and the wins activity;
 *      never in open tasks, SAiM's candidates or its waiting rail.
 *   4. Undo inside 30 s reverses ONLY that entry; repeated, expired, stale or
 *      someone else's undo is refused and changes nothing.
 *   5. Ask and Capture are unchanged (their code is byte-identical to before).
 *
 *   run: node --test backend/routes/quick-log-routing.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { execFileSync } = require('child_process');
const express = require('express');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-quicklog-')), 'a.db');

const db = require('../db/database');
const taskStore = require('../services/task-store');
const QL = require('../services/quick-log');
const NC = require('../services/neuro-candidates');
const POL = require('../../saim/policy/attention-policy.cjs');

const DOCK = path.resolve(__dirname, '..', '..', 'saim', 'app', 'alt-v2', 'Dock.jsx');
let server; let base; let UI;

const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  .then(async (r) => ({ status: r.status, json: await r.json() }));
const get = (p) => fetch(`${base}${p}`).then((r) => r.json());
const count = (sql, p = []) => db.get(sql, p).n;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', require('./tasks'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;

  const out = await esbuild.build({
    stdin: { contents: "export { runLogDone, runUndo, runCapture, UNDO_MS, default as Dock } from './Dock.jsx';", resolveDir: path.dirname(DOCK), loader: 'js' },
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /mobile\/outbox$|src\/api$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const enqueue=0,flush=0,outcomeFor=0,apiFetch=0,chatStream=0;', loader: 'js' }));
    } }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  UI = mod.exports;
});
test.after(() => server && server.close());

const tasksTotal = () => count('SELECT COUNT(*) AS n FROM tasks');

test('1. blank input writes nothing — route 400, dock never calls NEURO', async () => {
  const before = tasksTotal();
  for (const text of ['', '   ', null]) {
    const r = await post('/api/tasks/quick-log', { text });
    assert.equal(r.status, 400);
    assert.equal(r.json.reason, 'blank');
  }
  assert.equal(tasksTotal(), before);
  let called = 0;
  const r = await UI.runLogDone('   ', { apiFetch: async () => { called += 1; return {}; } });
  assert.equal(called, 0);
  assert.equal(r.clear, false);
  assert.match(r.note.msg, /Type what you did/);
});

test('2. one completed record with quick-log provenance, nothing scheduled — and never folded into an open task of the same words', async () => {
  const open = taskStore.createTask({ text: 'Sent the revised figures to Sarah', source: 'test' }).id;
  const before = tasksTotal();
  const r = await post('/api/tasks/quick-log', { text: 'Sent the revised figures to Sarah' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(tasksTotal(), before + 1, 'exactly one new row');
  const row = db.getTaskRow(r.json.taskId);
  assert.notEqual(row.id, open);
  assert.equal(db.getTaskRow(open).status, 'open', 'the open task with the same words is untouched');
  assert.equal(row.status, 'done');
  assert.ok(row.completed_at, 'completed-at stamped');
  assert.equal(row.source, 'saim-quick-log');
  assert.equal(row.due_date, null);
  assert.equal(row.estimate_minutes, null);
  const detail = JSON.parse(row.origin_detail);
  assert.equal(detail.kind, 'quick-log');
  assert.equal(detail.loggedAfterCompletion, true);
  assert.equal(count('SELECT COUNT(*) AS n FROM task_block_items WHERE task_id = ?', [row.id]), 0, 'no block');
  const s = db.getState('focus_session');
  assert.ok(!s || !String(s).includes(`"taskId":${row.id}`), 'no focus session');
  const act = db.all("SELECT * FROM activity_log WHERE event_type = 'task_done'").map((a) => JSON.parse(a.event_data)).filter((d) => d.taskId === row.id);
  assert.equal(act.length, 1);
  assert.equal(act[0].quickLog, true);
  // A startup re-key must not strip its key, or the next real task with these words would fold into a done row.
  taskStore.rekeyAll();
  const again = taskStore.createTask({ text: 'Sent the revised figures to Sarah', source: 'test' });
  assert.equal(again.id, open, 'a later sighting still finds the OPEN task, never the quick log');
  // And with NO open twin: after a re-key, a new task with those words is a new OPEN task, not the done log.
  const solo = await post('/api/tasks/quick-log', { text: 'Booked the venue for the offsite' });
  taskStore.rekeyAll();
  assert.match(db.getTaskRow(solo.json.taskId).dedupe_key, / #ql-/);
  const later = taskStore.createTask({ text: 'Booked the venue for the offsite', source: 'test' });
  assert.equal(later.created, true);
  assert.equal(db.getTaskRow(later.id).status, 'open');
});

test('3. in completed history and searchable; never open, never a SAiM candidate or waiting item', async () => {
  const r = await post('/api/tasks/quick-log', { text: 'Called Priya back about the renewal' });
  const id = r.json.taskId;
  const done = await get('/api/tasks?status=done&q=priya');
  assert.ok(done.tasks.some((t) => t.id === id && t.source === 'saim-quick-log'));
  const open = await get('/api/tasks?status=open&q=priya');
  assert.ok(!open.tasks.some((t) => t.id === id));
  assert.ok(!taskStore.activeTodos().some((t) => t.task_id === id));
  const now = Date.now();
  const g = NC.gather({ now });
  const payload = { poolAvailable: true, context: { activity: 'working', duty: { onDuty: true } }, primary: null, secondary: [], dropped: [], utterances: [], approvals: { known: true }, situation: { sections: { commitments: [] } }, home: { needsYou: [], exceptions: [] } };
  const candidates = NC.compose(payload, { rows: g.rows, session: g.session, block: g.block }, g.facts, { now });
  assert.ok(!JSON.stringify(candidates).includes('Called Priya back'), 'not a candidate');
  const decision = POL.decide(candidates, { surface: 'work-desktop', now });
  assert.ok(!JSON.stringify(decision).includes('Called Priya back'), 'not led, not in the waiting rail');
});

test('4. undo reverses only that entry within 30 s; repeated, stale, expired and mismatched undo are refused', async () => {
  const other = await post('/api/tasks/quick-log', { text: 'Approved the leave request' });
  const r = await post('/api/tasks/quick-log', { text: 'Forwarded the contract to legal' });
  const id = r.json.taskId;
  // Only the most recent entry can be undone.
  const wrong = await post(`/api/tasks/quick-log/${other.json.taskId}/undo`);
  assert.equal(wrong.status, 409);
  assert.equal(wrong.json.reason, 'not-latest');
  assert.equal(db.getTaskRow(other.json.taskId).status, 'done');
  // A wins row materialised from this entry's activity goes too; an unrelated one stays.
  db.run(`INSERT INTO wins (date_key, occurred_at, source, kind, text, evidence, count, dedupe_key, created_at) VALUES ('2026-10-16', datetime('now'), 'activity', 'task_done', 'x', ?, 1, ?, datetime('now'))`, [`activity:${r.json.activityId}`, `activity:${r.json.activityId}`]);
  db.run(`INSERT INTO wins (date_key, occurred_at, source, kind, text, evidence, count, dedupe_key, created_at) VALUES ('2026-10-16', datetime('now'), 'activity', 'task_done', 'y', ?, 1, ?, datetime('now'))`, [`activity:${other.json.activityId}`, `activity:${other.json.activityId}`]);
  const totalBefore = tasksTotal();
  const ok = await post(`/api/tasks/quick-log/${id}/undo`);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const row = db.getTaskRow(id);
  assert.equal(row.status, 'dropped');
  assert.equal(row.completed_at, null);
  assert.ok(JSON.parse(row.origin_detail).undoneAt, 'kept for audit, marked undone');
  assert.equal(tasksTotal(), totalBefore, 'nothing deleted from tasks');
  assert.equal(count('SELECT COUNT(*) AS n FROM activity_log WHERE id = ?', [r.json.activityId]), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM wins WHERE evidence = ?', [`activity:${r.json.activityId}`]), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM wins WHERE evidence = ?', [`activity:${other.json.activityId}`]), 1, 'unrelated win untouched');
  assert.equal(db.getTaskRow(other.json.taskId).status, 'done', 'unrelated quick log untouched');
  assert.ok(!(await get('/api/tasks?status=done&q=legal')).tasks.some((t) => t.id === id), 'gone from completed history');
  // Repeated undo.
  const again = await post(`/api/tasks/quick-log/${id}/undo`);
  assert.equal(again.status, 409);
  assert.equal(again.json.reason, 'already-undone');
  // Expired undo (service clock 31 s on).
  const late = await post('/api/tasks/quick-log', { text: 'Replied to the auditor' });
  const expired = QL.undo(late.json.taskId, { now: Date.now() + QL.UNDO_WINDOW_MS + 1000 });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'expired');
  assert.equal(db.getTaskRow(late.json.taskId).status, 'done');
  // The dock refuses an expired entry without calling NEURO.
  let called = 0;
  const d = await UI.runUndo({ taskId: late.json.taskId, until: Date.now() - 1 }, { apiFetch: async () => { called += 1; return { ok: true }; } });
  assert.equal(called, 0);
  assert.equal(d.ok, false);
  // A task reopened since is not undone behind Nick's back.
  taskStore.updateTask(late.json.taskId, { status: 'open' });
  assert.equal(QL.undo(late.json.taskId).reason, 'changed');
  assert.equal(db.getTaskRow(late.json.taskId).status, 'open');
});

test('dock: a successful log clears the box, says "Logged as done", and offers undo for 30 s; a NEURO refusal keeps the words', async () => {
  const ok = await UI.runLogDone('Sent the slides', { apiFetch: async (p, o) => { assert.equal(p, '/api/tasks/quick-log'); assert.deepEqual(JSON.parse(o.body), { text: 'Sent the slides' }); return { ok: true, taskId: 7 }; } }, 1000);
  assert.equal(ok.clear, true);
  assert.equal(ok.note.msg, 'Logged as done.');
  assert.deepEqual(ok.entry, { taskId: 7, text: 'Sent the slides', until: 1000 + UI.UNDO_MS });
  const bad = await UI.runLogDone('Sent the slides', { apiFetch: async () => { throw new Error('400 Bad Request — {"ok":false,"message":"Keep it under 500 characters — nothing was logged."}'); } });
  assert.equal(bad.clear, false);
  assert.match(bad.note.msg, /under 500 characters.*still here/);
  const u = await UI.runUndo(ok.entry, { apiFetch: async (p) => { assert.equal(p, '/api/tasks/quick-log/7/undo'); return { ok: true }; } }, 2000);
  assert.equal(u.msg, 'Undone — that entry was removed.');
});

test('5. Ask and Capture are unchanged — same buttons, and their code is byte-identical to before Log done', () => {
  const html = renderToString(React.createElement(UI.Dock, { variant: 'wk', utterances: [] }));
  const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
  assert.deepEqual(buttons, ['Ask', 'Capture', 'Log done']);
  let before;
  try { before = execFileSync('git', ['show', 'a0393526:saim/app/alt-v2/Dock.jsx'], { cwd: path.dirname(DOCK), encoding: 'utf8' }); } catch { before = null; }
  if (!before) return; // no history in this checkout (e.g. a shallow deploy copy)
  const now = fs.readFileSync(DOCK, 'utf8');
  const block = (src, start) => { const i = src.indexOf(start); assert.ok(i !== -1, start); const j = src.indexOf('\n  }\n', i); return src.slice(i, j); };
  for (const start of ['  async function capture() {', '  async function ask() {', 'export async function runCapture(', 'export function captureNote(']) {
    assert.equal(block(now, start), block(before, start), `${start.trim()} changed`);
  }
  const btn = (src, label) => src.split('\n').find((l) => l.includes(`>${label}</button>`));
  assert.equal(btn(now, 'Ask'), btn(before, 'Ask'));
  assert.equal(btn(now, 'Capture'), btn(before, 'Capture'));
});
