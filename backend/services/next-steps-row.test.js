'use strict';

/**
 * The ONE Next steps row (saim/shared-ui/NextStepRow.jsx, 7 Nov 2026), real
 * esbuild bundle + renderToString, plus its flows against a fake NEURO.
 *
 *  - a task's Start starts a focus session; another running is parked at once
 *    (no confirm) and named, so "Resume it" can put it back;
 *  - Done ticks a NEURO task and says what NEURO answered (repeats, refused, MS);
 *  - Book prepares through /api/1to1/book and sends with an intent grant;
 *  - a draft sends with one press;
 *  - both surfaces render THIS row (no private copies of rows, snoozes or reasons),
 *    and SAiM gains "Done for now".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');

async function load(file) {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, file)],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let R;
test.before(async () => { R = await load('saim/shared-ui/NextStepRow.jsx'); });

/** A fake NEURO: answers by path, records every call. */
function fakeNeuro(handlers) {
  const calls = [];
  const call = async (p, opts = {}) => {
    calls.push({ path: p, method: opts.method || 'GET', body: opts.body });
    for (const [re, fn] of handlers) if (re.test(p)) return fn(opts.body || {}, calls);
    return { status: 404, body: { ok: false, error: 'no such route' } };
  };
  return { call, calls };
}

const html = (props) => renderToString(React.createElement(R.default, props)).replace(/<!-- -->/g, '');

test('a NEURO task row offers Start, Done and Open; a mirror task gets no Done it cannot keep', () => {
  const item = { id: 'task:9', kind: 'task', group: 'today', title: 'Chase Sandford', why: 'Due today', minutes: 10,
    start: { label: 'Start', view: 'todos', context: { taskId: 9 }, action: 'focus' }, task: { taskId: 9, text: 'Chase Sandford', canComplete: true } };
  const h = html({ item });
  assert.match(h, />Start</);
  assert.match(h, />Done</);
  assert.match(h, />Open</);
  assert.match(h, /Snooze ▾/);
  assert.match(h, /Not today/);
  const mirror = html({ item: { ...item, id: 'task:text:x', task: { taskId: null, text: 'x', canComplete: false } } });
  assert.doesNotMatch(mirror, />Done</);
});

test('a garden row carries Done for now; a snoozed row only Bring it back, reason in the shared words', () => {
  const garden = { id: 'garden:a.md', kind: 'garden', group: 'week', title: 'Revisit “a”', why: '', minutes: 5, start: { label: 'Open', view: 'vault', context: { path: 'a.md' }, secondary: 'done-for-now' } };
  assert.match(html({ item: garden }), /Done for now/);
  const sn = html({ item: { ...garden, snoozedUntil: '2026-11-08T08:00:00Z', snoozeReason: 'waiting-on-someone' }, snoozed: true });
  assert.match(sn, /Bring it back/);
  assert.match(sn, /i&#x27;m blocked|i'm blocked/);
  assert.doesNotMatch(sn, /Snooze ▾/);
});

test('Start starts a focus session on THAT task — no navigation', async () => {
  const n = fakeNeuro([[/\/api\/session\/start$/, (b) => ({ status: 200, body: { ok: true, session: { taskId: b.taskId, text: 'Chase Sandford', plannedMinutes: 30, plannedAssumed: true } } })]]);
  const r = await R.startOnTask(n.call, { taskId: 9, text: 'Chase Sandford' });
  assert.equal(r.ok, true);
  assert.equal(r.parked, null);
  assert.equal(n.calls.length, 1);
  assert.equal(n.calls[0].body.taskId, 9);
  assert.ok(!n.calls[0].body.force, 'a free slot is never forced');
  assert.equal(R.startedLine(r.session, 'Chase Sandford'), 'Focus started on “Chase Sandford” — 30 min (assumed).');
});

test('another session running: switched straight away, and the parked one is named for Resume it', async () => {
  const n = fakeNeuro([
    [/\/api\/session\/start$/, (b) => (b.force
      ? { status: 200, body: { ok: true, session: { taskId: b.taskId, text: 'Chase Sandford' } } }
      : { status: 409, body: { ok: false, session: { taskId: 4, text: 'Monday report' } } })],
  ]);
  const r = await R.startOnTask(n.call, { taskId: 9, text: 'Chase Sandford' });
  assert.equal(r.ok, true);
  assert.equal(r.parked.taskId, 4);
  assert.equal(r.parked.text, 'Monday report');
  assert.deepEqual(n.calls.map((c) => [c.path, Boolean(c.body && c.body.force)]), [['/api/session/start', false], ['/api/session/start', true]]);
  // Resume it: the parked task goes back in focus, on its own id.
  const back = await R.startOnTask(n.call, r.parked, { resume: true });
  assert.equal(back.ok, true);
  assert.equal(n.calls[2].body.taskId, 4);
  // Already on this task: nothing parked, nothing forced.
  const same = fakeNeuro([[/\/api\/session\/start$/, () => ({ status: 409, body: { ok: false, session: { taskId: 9, text: 'Chase Sandford' } } })]]);
  const s = await R.startOnTask(same.call, { taskId: 9, text: 'Chase Sandford' });
  assert.equal(s.already, true);
  assert.equal(s.parked, null);
  assert.equal(same.calls.length, 1);
});

test('"It’s too big" starts 15 minutes on the smallest step he names — the task is never hidden', async () => {
  const n = fakeNeuro([
    [/\/api\/session\/start$/, (b) => ({ status: 200, body: { ok: true, session: { taskId: b.taskId, plannedMinutes: b.minutes } } })],
    [/\/api\/session\/shrink$/, (b) => ({ status: 200, body: { ok: true, session: { step: b.step } } })],
  ]);
  const r = await R.startSmallest(n.call, { taskId: 9, text: 'Chase Sandford', step: 'open the thread' });
  assert.equal(r.ok, true);
  assert.equal(r.text, '15 minutes on “open the thread” — started.');
  assert.equal(n.calls[0].body.minutes, 15);
  assert.equal(n.calls[1].body.step, 'open the thread');
  assert.ok(!n.calls.some((c) => /defer/.test(c.path)), 'nothing deferred');
  const empty = await R.startSmallest(fakeNeuro([]).call, { taskId: 9, text: 'x', step: '  ' });
  assert.equal(empty.ok, false);
});

test('Done says what NEURO answered: ticked, repeats, refused, Microsoft', () => {
  assert.deepEqual(R.doneOutcome({ status: 200, body: { ok: true, task: { status: 'done' } } }), { tone: 'ok', text: 'Done — ticked off.', keep: false });
  const rep = R.doneOutcome({ status: 200, body: { ok: true, task: { status: 'open' }, recurred: { notice: 'Done — next due Mon 9 Nov.', nextDue: '2026-11-09' } } });
  assert.equal(rep.text, 'Done — next due Mon 9 Nov.');
  assert.equal(rep.keep, true);
  const jira = R.doneOutcome({ status: 400, body: { error: 'NT-14855 closes this one — tick it in Jira' } });
  assert.equal(jira.tone, 'bad');
  assert.match(jira.text, /^Not ticked — NT-14855 closes this one/);
  assert.equal(R.doneOutcome({ status: 404, body: { error: 'Task not found' } }).tone, 'bad');
  const ms = R.doneOutcome({ status: 200, body: { ok: true, task: { status: 'done' }, msPush: { completed: false, reason: 'auth', held: true } } });
  assert.equal(ms.tone, 'warn');
  assert.match(ms.text, /Microsoft didn’t take it \(auth\) — NEURO will keep trying/);
  assert.equal(R.doneOutcome(null).tone, 'bad');
});

test('Book prepares through /api/1to1/book then sends with a one-use grant (neuro-web)', async () => {
  const n = fakeNeuro([
    [/\/api\/1to1\/book$/, () => ({ status: 200, body: { ok: true, action: { actionId: 'pa_1', version: 1, payloadHash: 'h1' } } })],
    [/intent-grant$/, () => ({ status: 200, body: { ok: true, grantId: 'g1' } })],
    [/execute-direct$/, () => ({ status: 200, body: { ok: true, executed: true, status: 'executed', action: { actionType: 'create_calendar_event' } } })],
  ]);
  const proposal = { start: '2026-11-12T14:00:00', end: '2026-11-12T14:30:00', date: '2026-11-12', durationMinutes: 30, subject: '1-2-1', attendee: { email: 'zoe@x' } };
  const r = await R.bookAndSend(n.call, { person: 'Zoe Rees', proposal });
  assert.equal(r.sent, true);
  assert.match(r.text, /^Invite sent for Thu 12 Nov, 14:00–14:30\./);
  assert.equal(n.calls[0].body.person, 'Zoe Rees');
  assert.equal(n.calls[0].body.email, 'zoe@x');
  assert.equal(n.calls[1].body.surface, 'neuro-web');
  assert.equal(n.calls[1].body.payloadHash, 'h1');
  // No address: nothing prepared, nothing sent, and it says why.
  const none = fakeNeuro([]);
  const r2 = await R.bookAndSend(none.call, { person: 'Zoe Rees', proposal: { ...proposal, attendee: { email: null } } });
  assert.equal(r2.sent, false);
  assert.match(r2.text, /No email address for Zoe Rees/);
  assert.equal(none.calls.length, 0);
  // Refused prepare: not sent, the server's words.
  const clash = fakeNeuro([[/\/api\/1to1\/book$/, () => ({ status: 200, body: { ok: false, error: 'That slot clashes with "Standup"' } })]]);
  const r3 = await R.bookAndSend(clash.call, { person: 'Zoe Rees', proposal });
  assert.equal(r3.sent, false);
  assert.match(r3.text, /clashes with "Standup"/);
});

test('a waiting draft sends with one press; a changed one asks to be pressed again', async () => {
  const n = fakeNeuro([
    [/intent-grant$/, () => ({ status: 200, body: { ok: true, grantId: 'g' } })],
    [/execute-direct$/, () => ({ status: 200, body: { ok: true, executed: true, status: 'verified', action: { actionType: 'compose_email' } } })],
  ]);
  const r = await R.sendDraftNow(n.call, { actionId: 'pa_9', version: 2, payloadHash: 'hh' });
  assert.equal(r.sent, true);
  assert.equal(r.text, 'Sent — checked in Sent Items.');
  assert.equal(n.calls[0].path, '/api/prepared-actions/pa_9/intent-grant');
  assert.equal(n.calls[0].body.version, 2);
  const moved = fakeNeuro([[/intent-grant$/, () => ({ status: 409, body: { ok: false, needsConfirm: true, error: 'changed' } })]]);
  const m = await R.sendDraftNow(moved.call, { actionId: 'pa_9', version: 2, payloadHash: 'hh' });
  assert.equal(m.sent, false);
  assert.match(m.text, /press again/);
});

test('a slot line is a calendar date, never shifted by a timezone', () => {
  assert.equal(R.slotLine({ start: '2026-11-12T14:00:00', end: '2026-11-12T14:30:00' }), 'Thu 12 Nov, 14:00–14:30');
  assert.equal(R.slotLine(null), '');
});

test('both surfaces render the shared row; neither keeps its own row, snoozes or reasons', () => {
  const page = fs.readFileSync(path.join(ROOT, 'frontend/src/components/NextStepsPage.jsx'), 'utf8');
  const saim = fs.readFileSync(path.join(ROOT, 'saim/app/src/views/NextSteps.jsx'), 'utf8');
  const row = fs.readFileSync(path.join(ROOT, 'saim/shared-ui/NextStepRow.jsx'), 'utf8');
  for (const src of [page, saim]) {
    assert.match(src, /import NextStepRow from '[./]+(saim\/)?shared-ui\/NextStepRow\.jsx'/);
    assert.doesNotMatch(src, /function NextStepRow/);
    assert.doesNotMatch(src, /NOT_TODAY_REASONS\s*=/);
    assert.doesNotMatch(src, /SNOOZES\s*=/);
  }
  assert.match(row, /import \{ NOT_TODAY_REASONS \} from '\.\/notTodayReasons\.mjs'/);
  assert.match(row, /sendPrepared/);
  assert.match(row, /startTaskSession/);
  // Positive control: the scan would see a private copy.
  assert.match('const SNOOZES = [', /SNOOZES\s*=/);
});

test('SAiM’s Next steps tab now carries Done for now and a task’s Done — the shared row, rendered by the view', async () => {
  const V = await load('saim/app/src/views/NextSteps.jsx');
  const data = { ok: true, complete: true, gaps: [], snoozed: [], items: [
    { id: 'garden:a.md', kind: 'garden', group: 'week', sphere: 'work', title: 'Revisit “a”', why: '', minutes: 5, start: { label: 'Open', view: 'vault', context: { path: 'a.md' }, secondary: 'done-for-now' } },
    { id: 'task:9', kind: 'task', group: 'today', sphere: 'work', title: 'Chase Sandford', why: 'Due today', minutes: 10, start: { label: 'Start', view: 'todos', context: { taskId: 9 }, action: 'focus' }, task: { taskId: 9, text: 'Chase Sandford', canComplete: true } },
  ] };
  const h = renderToString(React.createElement(V.NextStepsView, { data, filter: 'all' })).replace(/<!-- -->/g, '');
  assert.match(h, /Done for now/);
  assert.match(h, /id="ns-task:9"[\s\S]*>Done</);
});
