'use strict';

/**
 * Task context and the Holding-the-week cards, rendered for real (esbuild +
 * renderToString) from the SAME components every shell mounts (22 Oct 2026).
 *
 *  - compact context renders NOTHING when a task has none (no noisy screens),
 *    shows at most `limit`, and withholds a restricted note's preview;
 *  - editable context shows pinned, suggestions (not pinned), stale, the scan's
 *    question and "Add context";
 *  - the task card mounts it for a NEURO task and not for a Microsoft mirror;
 *  - a prepared move hands its task id to the context slot;
 *  - Holding the week is THREE cards, each an honest answer with its route.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
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
    // The repo's node_modules, plus NODE_PATH (a worktree has none of its own).
    nodePaths: [path.join(ROOT, 'node_modules'), ...String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)],
    define: { 'import.meta.env': JSON.stringify({ VITE_API_URL: '', DEV: false, PROD: true, MODE: 'test' }) },
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const apiUrl = p => p;\nexport const authHeaders = () => ({});\nexport const apiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });\nexport default { apiUrl };',
          loader: 'js',
        }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const item = (id, over = {}) => ({
  id, taskId: 31, type: 'note', ref: `Projects/X/Note ${id}.md`, title: `Note ${id}`, preview: `Preview ${id}`, restricted: false,
  origin: 'nightly-scan', originLabel: 'Found automatically', automatic: true, state: 'pinned', reasons: [{ code: 'title', say: 'Its title matches the task.' }],
  reason: 'Its title matches the task.', scopeItems: null, open: { kind: 'note', path: `Projects/X/Note ${id}.md` }, ...over,
});
const data = (over = {}) => ({ ok: true, contract: 'task-context-v1', taskId: 31, task: { id: 31, text: 'T', status: 'open' }, pinned: [], suggestions: [], stale: [], question: null, lastScan: { ok: true }, ...over });

let TC; let KMW; let panel; let pm;
test.before(async () => {
  TC = await load('saim/shared-ui/TaskContext.jsx');
  KMW = await load('saim/shared-ui/presentation/KeepMyWord.jsx');
  panel = await load('frontend/src/components/TodoPanel.jsx');
  pm = await load('saim/app/src/components/PreparedMove.jsx');
  assert.ok(TC.default && TC.ContextItem && KMW.KmwReadout && panel.TodoItem && pm.PreparedMoveView, 'positive control: the real exports');
});
const html = (el) => renderToString(el).replace(/<!-- -->/g, '');
const call = async () => ({ status: 200, body: {} });

test('compact: nothing at all when a task has no context; at most `limit` otherwise', () => {
  assert.equal(html(React.createElement(TC.default, { taskId: 31, call, compact: true, initial: data() })), '');
  const out = html(React.createElement(TC.default, { taskId: 31, call, compact: true, limit: 3, initial: data({ pinned: [1, 2, 3, 4, 5].map((i) => item(i)) }) }));
  assert.equal((out.match(/class="tctx__item/g) || []).length, 3);
  assert.match(out, /2 more on the task/);
  assert.doesNotMatch(out, /Preview 1/, 'compact shows the reason, not the preview');
  assert.doesNotMatch(out, /Remove/, 'compact is read-only');
});

test('every item says what it is, why it is there and who put it there', () => {
  const out = html(React.createElement(TC.default, { taskId: 31, call, editable: true, onOpen: () => {}, initial: data({ pinned: [
    item(1),
    item(2, { origin: 'manual', originLabel: 'Linked by you', automatic: false, type: 'project', title: 'NOVA', ref: 'Projects/NOVA', reason: 'Linked by you.', scopeItems: [{ ref: 'Projects/NOVA/Plan.md', title: 'Plan', reason: 'Mentions leaderboard.' }] }),
    item(3, { restricted: true, preview: null, title: 'A 1-2-1', reason: 'This task was raised in this note.' }),
  ] }) }));
  assert.match(out, /Found automatically/);
  assert.match(out, /Linked by you/);
  assert.match(out, />Project</);
  assert.match(out, /Plan<\/button>/, 'a project shows a few notes within it');
  assert.match(out, /Restricted — preview withheld/);
  assert.equal((out.match(/>Remove</g) || []).length, 3);
  assert.match(out, /Add context/);
});

test('editable: suggestions are folded and NOT pinned; stale says why; the scan asks rather than guesses', () => {
  const out = html(React.createElement(TC.default, { taskId: 31, call, editable: true, initial: data({
    suggestions: [item(9, { state: 'suggested', title: 'Maybe related' })],
    stale: [item(8, { state: 'stale', staleSay: 'The note is no longer in the vault (moved or deleted).' })],
    question: { text: 'Which project is this task part of?', options: [{ type: 'project', ref: 'Projects/NOVA', title: 'NOVA' }, { type: 'project', ref: 'Projects/VANTAGE', title: 'VANTAGE' }] },
  }) }));
  assert.match(out, /1 suggestion — not pinned/);
  assert.match(out, /Pin it/);
  assert.match(out, /Not related/);
  assert.match(out, /1 no longer available/);
  assert.match(out, /no longer in the vault/);
  assert.match(out, /Which project is this task part of\?/);
  assert.match(out, />Neither</);
  assert.match(out, /No context pinned yet/, 'empty-but-read is said, not left blank');
});

test('search results follow the chosen type', () => {
  const r = { ok: true, notes: [{ type: 'note', ref: 'a.md' }], scopes: [{ type: 'project', ref: 'Projects/A' }, { type: 'area', ref: 'Areas/B' }] };
  assert.deepEqual(TC.searchResults(r, 'note').map((x) => x.ref), ['a.md']);
  assert.deepEqual(TC.searchResults(r, 'area').map((x) => x.ref), ['Areas/B']);
  assert.deepEqual(TC.searchResults({ ok: false }, 'note'), []);
});

test('the task card mounts context for a NEURO task, not for a Microsoft mirror', () => {
  const props = (todo) => ({ todo, toggling: {}, onToggle: () => {}, expanded: todo.task_id ? `task:${todo.task_id}` : `file:${todo.filePath}#${todo.lineNumber}`, onExpand: () => {}, onPatch: async () => {}, onRefresh: () => {} });
  const neuro = html(React.createElement(panel.TodoItem, props({ id: 1, task_id: 31, text: 'Finalise the triage checklist', priority: 'normal', moscow: 'should', source: 'NEURO', done: 0 })));
  assert.match(neuro, /class="todo-context"/);
  assert.match(neuro, /Reading context/);
  const ms = html(React.createElement(panel.TodoItem, props({ id: 2, ms_id: 'AAA', text: 'Board card', priority: 'normal', source: 'MS Planner', filePath: 'Tasks/Microsoft Tasks.md', lineNumber: 4, done: 0 })));
  assert.doesNotMatch(ms, /todo-context/);
});

test('a prepared move hands its task id to the context slot (and a move with no task does not)', () => {
  const seen = [];
  const move = { version: 2, recordId: 'pm1', kind: 'project-note', plan: 'draft', title: 'X', prepared: { headline: 'H' }, deliverable: {}, options: [], evidence: [], freshness: [], why: {}, taskId: 31 };
  const view = (m) => React.createElement(pm.PreparedMoveView, { state: { kind: 'ready', view: { move: m } }, renderContext: (id) => { seen.push(id); return React.createElement('div', { className: 'ctx-slot' }, `ctx ${id}`); } });
  assert.match(html(view(move)), /ctx-slot/);
  assert.deepEqual(seen, [31]);
  assert.doesNotMatch(html(view({ ...move, taskId: null })), /ctx-slot/);
});

// ── Holding the week ─────────────────────────────────────────────────────────

const readout = (over = {}) => ({ label: 'Holding the week', figure: '3 / 4', figureNote: null, line: 'Promises kept on time — each one read back as delivered.', trend: 'One more than last week.', reDated: '2 re-dated this week.', next: null,
  kept: { action: { label: 'See your promises', view: 'commitments' } },
  monday: { label: 'Monday report', line: 'Due Monday 26 October 2026, 12:00.', state: 'due', settled: false, receipt: null, action: { label: 'Write and send it', view: 'weekly-risk' } },
  judgement: { label: 'Needs your judgement', strong: '2 promises', line: 'Only you can say whether they were delivered.', more: 0, items: [
    { key: 'p1', taskId: 31, title: 'Send Kit the onboarding checklist', sensitive: false, why: 'Ticked, with no proof it was delivered.' },
    { key: 'p2', taskId: 44, title: null, sensitive: true, why: 'Ticked, with no proof it was delivered.' },
  ] }, ...over });
const cards = (r, onOpen = () => {}) => html(React.createElement(KMW.KmwReadout, { readout: r, workspace: true, onOpen }));

test('Holding the week is three distinct cards, each with its route', () => {
  const out = cards(readout());
  for (const t of ['Keeping my word', 'Monday report', 'Needs your judgement']) assert.match(out, new RegExp(`class="kmw__card-title">${t}<`));
  assert.equal((out.match(/class="kmw__card /g) || []).length, 3);
  assert.match(out, /3 \/ 4/);
  assert.match(out, /See your promises →/);
  assert.match(out, /Write and send it →/);
  assert.match(out, /Send Kit the onboarding checklist/);
  assert.match(out, /An employment matter — not named here/);
  assert.equal((out.match(/class="kmw__judge-item"/g) || []).length, 2, 'each promise opens its task');
});

test('honest states: unmeasured explains itself, a settled report shows its receipt, nothing waiting says so', () => {
  const out = cards(readout({ figure: null, figureNote: 'Not measured yet', line: 'Nothing records a delivery yet, so nothing is counted as kept.', trend: null, reDated: null,
    monday: { label: 'Monday report', line: 'Sent, and read back in Sent Items by the deadline.', state: 'sent-verified-on-time', settled: true, receipt: 'Read back in Sent Items Monday 19 October 2026, 11:42 (London).', action: null },
    judgement: null }));
  assert.match(out, /Not measured yet/);
  assert.match(out, /Nothing records a delivery yet/, 'the reason is shown, not folded away');
  assert.match(out, /Read back in Sent Items Monday/);
  assert.doesNotMatch(out, /Write and send/);
  assert.match(out, /Nothing is waiting on your judgement/);
  const none = cards(readout({ monday: null }));
  assert.match(none, /couldn’t read this week’s report/);
});

test('without a shell handler (a kiosk) the cards render with no buttons', () => {
  const out = html(React.createElement(KMW.KmwReadout, { readout: readout(), workspace: true }));
  assert.doesNotMatch(out, /<button/);
  assert.match(out, /Write and send it\./, 'the action is still stated');
});

test('the SAiM scenes keep the locked readout (not the workspace cards)', () => {
  const out = html(React.createElement(KMW.KmwReadout, { readout: readout() }));
  assert.doesNotMatch(out, /kmw__card/);
  assert.match(out, /kmw__week/);
});

test('Brain Health: automatic context linking is OFF and says it is waiting; enabling quotes the backfill and needs the tick', async () => {
  const act = await load('frontend/src/components/TaskContextActivation.jsx');
  const status = { ok: true, enabled: false, say: 'Automatic context linking is off — until you enable it here.', enableSay: 'Enabling scans every open task against the whole vault NOW (the backfill)…', schedule: 'Every night at 03:40' };
  const idle = html(React.createElement(act.ActivationView, { status }));
  assert.match(idle, /until you enable it here/);
  assert.match(idle, /Enable automatic context linking…/);
  assert.doesNotMatch(idle, /Run the backfill and enable/, 'one press never enables it');
  const confirm = html(React.createElement(act.ActivationView, { status, step: 'confirm', ticked: false }));
  assert.match(confirm, /What happens when you enable it:/);
  assert.match(confirm, /\(the backfill\)/);
  assert.match(confirm, /<button[^>]*disabled=""[^>]*>Run the backfill and enable/, 'disabled until the cleanup tick');
  assert.doesNotMatch(html(React.createElement(act.ActivationView, { status, step: 'confirm', ticked: true })), /disabled=""[^>]*>Run the backfill/);
  const on = html(React.createElement(act.ActivationView, { status: { ...status, enabled: true, say: 'Automatic context linking is on — every night at 03:40.' } }));
  assert.match(on, /Turn automatic linking off/);
});

test('the task card says WHY nothing is pinned while automatic linking is off', () => {
  const out = html(React.createElement(TC.default, { taskId: 31, call, editable: true, initial: data({ automatic: { enabled: false, say: 'x' } }) }));
  assert.match(out, /Automatic linking is off until you turn it on in NEURO → Brain Health — you can link context by hand/);
});

test('Drafts intro: never claims nothing is saved or booked while saved, booked work is on the page', async () => {
  const D = await load('saim/app/src/views/Drafts.jsx');
  const work = [{ moveKey: 'saim-move:v2:project-note:task:350', recordId: 'r1', title: 'Nova call metrics', kindLabel: 'Private working draft', path: 'Projects/Working/Nova (private draft).md',
    task: { id: 350, text: 'Nick to build call/productivity metrics in Nova', status: 'open' }, block: { date: '2026-10-23', start: '10:30', end: '11:00', label: 'Friday 23 October, 10:30–11:00' },
    status: 'Draft saved · scheduled for Friday 23 October, 10:30' }];
  const data = { ok: true, items: [], sections: { confirm: [], work, communication: [], history: [] }, gaps: [] };
  for (const readOnly of [false, true]) { // desktop/phone, and the kiosk
    const out = html(React.createElement(D.DraftsView, { data, readOnly, onOpen: () => {}, onClose: () => {}, renderItem: () => null }));
    assert.match(out, /Draft saved · scheduled for Friday 23 October/, 'positive control: saved, booked work is shown');
    assert.doesNotMatch(out, /until you confirm it/i);
    assert.doesNotMatch(out, /nothing is (saved|booked)[^.]*until/i, 'the contradiction cannot come back in other words');
    assert.match(out, /Nothing is saved, booked or sent without your confirmation\. Once confirmed, your draft and planned work stay here until you finish or abandon them\./);
  }
});
