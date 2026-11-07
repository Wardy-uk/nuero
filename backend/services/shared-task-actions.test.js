'use strict';

/**
 * The ONE task-action helpers every surface uses (7 Nov 2026, audit F1/F3/F6/H):
 *   saim/shared-ui/completeTask.mjs   — owner order + what the tick did
 *   saim/shared-ui/startTask.mjs      — Start (parks without asking), smallest step
 *   saim/shared-ui/NotToday.jsx       — the four shared reasons; too-big asks for a step
 *
 * Driven against a fake `call` that records requests, so the exact routes and
 * bodies are pinned — and every outcome a surface must NOT paint as a tick.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');
const mjs = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

function fake(answers) {
  const calls = [];
  const call = async (p, o = {}) => {
    calls.push({ p, method: o.method || 'GET', body: o.body });
    const a = typeof answers === 'function' ? answers(p, o, calls.length) : answers.shift();
    if (a instanceof Error) throw a;
    return a;
  };
  return { call, calls };
}

test('completeTask: owner order — NEURO id, then Microsoft, then the vault line; none → refused in words', async () => {
  const { completeTask, ownerOf } = await mjs('saim/shared-ui/completeTask.mjs');
  assert.deepEqual(ownerOf({ task_id: 4, ms_id: 'X' }), { kind: 'neuro', taskId: 4 }, 'a linked NEURO row closes by id (the route pushes to Microsoft)');
  let f = fake([{ status: 200, body: { ok: true, task: { id: 4 } } }]);
  assert.equal((await completeTask(f.call, { task_id: 4, ms_id: 'X', text: 'a' })).kind, 'done');
  assert.deepEqual(f.calls.map((c) => c.p), ['/api/tasks/4/complete'], 'no second Microsoft push from the client');

  f = fake([{ status: 200, body: { ok: true, pushed: 'planner' } }]);
  assert.equal((await completeTask(f.call, { ms_id: 'M1', source: 'MS Planner', text: 'b' })).kind, 'done');
  assert.equal(f.calls[0].p, '/api/todos/complete-ms'); assert.equal(f.calls[0].body.msId, 'M1');

  f = fake([{ status: 200, body: { status: 'done' } }]);
  assert.equal((await completeTask(f.call, { filePath: '/v/Daily/x.md', lineNumber: 3, text: 'c' })).kind, 'done');
  assert.deepEqual(f.calls[0].body, { filePath: '/v/Daily/x.md', lineNumber: 3 });

  const none = await completeTask(fake([]).call, { text: 'no handle' });
  assert.equal(none.kind, 'refused'); assert.match(none.reason, /no handle/);
});

test('completeTask: repeated / rolled / held / refused are NOT done, and say why', async () => {
  const { completeTask, wentDone, outcomeLine } = await mjs('saim/shared-ui/completeTask.mjs');
  const rep = await completeTask(fake([{ status: 200, body: { ok: true, task: { id: 9 }, recurred: { nextDue: '2026-11-14', label: 'weekly', notice: 'Done — next due Fri 14 Nov' } } }]).call, { task_id: 9, text: 'r' });
  assert.equal(rep.kind, 'repeated'); assert.equal(wentDone(rep), false); assert.match(outcomeLine(rep), /next due Fri 14 Nov/);

  const rolled = await completeTask(fake([{ status: 200, body: { ok: true, rolled: { nextDue: 'x' }, notice: 'Microsoft rolled it to next month' } }]).call, { ms_id: 'M', text: 'r' });
  assert.equal(rolled.kind, 'rolled'); assert.equal(wentDone(rolled), false);

  const held = await completeTask(fake([{ status: 200, body: { ok: true, task: { id: 2, held: { reason: 'no write-up yet' } } } }]).call, { task_id: 2 });
  assert.equal(held.kind, 'held'); assert.match(outcomeLine(held), /no write-up yet/);

  const jira = await completeTask(fake([{ status: 400, body: { error: 'NT-123 closes this one — resolve it in Jira' } }]).call, { task_id: 3, jiraKey: 'NT-123' });
  assert.equal(jira.kind, 'refused'); assert.match(outcomeLine(jira), /Not closed — NT-123 closes this one/);

  const down = await completeTask(fake([new Error('network down')]).call, { task_id: 3 });
  assert.equal(down.kind, 'error'); assert.match(outcomeLine(down), /network down/);

  // A vault toggle that came back OPEN un-ticked something already ticked: say so, never "done".
  const flipped = await completeTask(fake([{ status: 200, body: { status: 'open' } }]).call, { filePath: 'f', lineNumber: 1 });
  assert.equal(flipped.kind, 'refused');
});

test('jiraHint names the ticket; a task Nick owns gets none', async () => {
  const { jiraHint } = await mjs('saim/shared-ui/completeTask.mjs');
  assert.match(jiraHint({ jiraKey: 'NT-7' }), /^NT-7 closes this one/);
  assert.equal(jiraHint({ task_id: 1 }), null);
});

test('startTaskSession: a busy slot is switched straight away (no question) and the old task reported as parked', async () => {
  const { startTaskSession, resumeParked, takeParked } = await mjs('saim/shared-ui/startTask.mjs');
  const f = fake([
    { status: 409, body: { ok: false, session: { taskId: 5, text: 'Weekly risk', elapsedMinutes: 20 } } },
    { status: 200, body: { ok: true, session: { taskId: 8 } } },
  ]);
  const r = await startTaskSession(f.call, { taskId: 8, text: 'Krista' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.parked, { taskId: 5, text: 'Weekly risk', elapsedMinutes: 20 });
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].body.force, true);
  assert.equal(takeParked().text, 'Weekly risk', 'the next screen can offer it back');
  assert.equal(takeParked(), null, 'once');
  const back = fake([{ status: 200, body: { ok: true, session: { taskId: 5 } } }]);
  assert.equal((await resumeParked(back.call, r.parked)).ok, true);
  assert.equal(back.calls[0].body.taskId, 5);
});

test('startSmallestStep: 15 minutes on the task, then the step — and no step, no start', async () => {
  const { startSmallestStep } = await mjs('saim/shared-ui/startTask.mjs');
  const empty = await startSmallestStep(fake([]).call, { taskId: 3, text: 'Big thing', step: '  ' });
  assert.equal(empty.ok, false);
  const f = fake([{ status: 200, body: { ok: true, session: { taskId: 3 } } }, { status: 200, body: { ok: true, session: { taskId: 3, nextStep: 'open the doc' } } }]);
  const r = await startSmallestStep(f.call, { taskId: 3, text: 'Big thing', step: 'open the doc' });
  assert.equal(r.ok, true); assert.equal(r.step, 'open the doc');
  assert.deepEqual(f.calls.map((c) => c.p), ['/api/session/start', '/api/session/shrink']);
  assert.equal(f.calls[0].body.minutes, 15); assert.equal(f.calls[0].body.taskId, 3);
  assert.deepEqual(f.calls[1].body, { step: 'open the doc' });
});

test('NotToday renders the four shared reasons; "too big" asks for a step instead of hiding the task', async () => {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'saim', 'shared-ui', 'NotToday.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node',
    jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  const closed = renderToString(React.createElement(mod.exports.default, { onDefer: async () => ({ ok: true }) }));
  assert.match(closed, />Not today</);
  const step = renderToString(React.createElement(mod.exports.SmallestStep, { call: async () => ({}), taskId: 3, text: 'x', onNotToday: () => {} }));
  assert.match(step, /Smallest first step\?/);
  assert.match(step, />Start 15 minutes</);
  assert.match(step, />Not today anyway</, 'the defer reason is recorded only if he chooses it');
  const { notTodayMinutes } = mod.exports;
  assert.equal(notTodayMinutes('waiting-on-someone'), 24 * 60);
  assert.equal(notTodayMinutes('not-now', new Date(2026, 10, 7, 23, 30)), 7 * 60 + 30, 'until 07:00 tomorrow');
  const parked = renderToString(React.createElement(mod.exports.ParkedNote, { parked: { taskId: 5, text: 'Weekly risk', elapsedMinutes: 12 }, call: async () => ({}) }));
  assert.match(parked.replace(/<!-- -->/g, ''), /Parked “Weekly risk” \(12 min in\)\. <button[^>]*>Resume it</);
});

test('"Tomorrow" on the older Surface layouts records not-now, never a context reason', async () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'saim', 'shared-ui', 'AttentionSurface.jsx'), 'utf8');
  assert.match(src, /\{ label: 'Tomorrow', minutes: 60 \* 20, reason: 'not-now' \}/);
});
