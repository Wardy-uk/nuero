'use strict';

/**
 * A focus line is ONE job, and parking a line moves the REAL tasks (28 Oct 2026).
 *
 * 22 Oct: the standup folded #372, #334 and #322 into one focus line with no
 * link. 23 Oct: "park that for next week" minted #463 — a new task duplicating
 * three (one already done) — and was told back as "Monday" while being dated
 * Wednesday 28 Oct. Fixture wordings are the live ones.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-standup-bundle-'));
process.env.NEURO_DB_PATH = path.join(root, 'bundle.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Tasks'), { recursive: true });
fs.mkdirSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Daily'), { recursive: true });

const db = require('../db/database');
const session = require('./standup-session');
const taskStore = require('./task-store');
const accountability = require('./standup-accountability');

// A realistic spread, so rare words carry weight the way they do on the live list.
const POOL = [
  'Review the weekly SLA report and flag breaches to the team',
  'Respond to the escalation on the portal login issue',
  'Update the support rota for next month',
  'Review ticket ageing for Tier 2 and send details to the leads',
  'Chase development on the reporting issue',
  'Prepare the monthly support KPI pack',
  'Review QA scores with the team leads',
  'Book 1-2-1s for the month',
  'Review customer complaint themes from last week',
  'Draft the knowledge base article on password resets',
  'Check overtime claims and approve',
  'Plan the team meeting agenda',
];

const ROUND_ROBIN = 'Implement updated round-robin logic to keep client tickets with the same initial agent';
const STEPHEN = 'Nick to reply formally to Stephen’s flexible working request with a plan';
const HYBRID = 'Define achievable targets for hybrid/WFH incentive; agree plan on 2026-09-02';
const BUNDLE = "Round-robin logic, hybrid/WFH targets, and Stephen's flexible working reply";
const BUNDLE_KEY = accountability.commitmentKey(BUNDLE);

const ids = {};
test.before(async () => {
  await db.init();
  for (const text of POOL) taskStore.createTask({ text, source: 'manual', skipExport: true });
  ids.rr = taskStore.createTask({ text: ROUND_ROBIN, source: 'manual', skipExport: true }).id;
  ids.st = taskStore.createTask({ text: STEPHEN, source: 'manual', skipExport: true }).id;
  ids.hy = taskStore.createTask({ text: HYBRID, source: 'manual', skipExport: true }).id;
});

const fixture = (openCommitments = []) =>
  session._emptySession('standup', { dateKey: '2026-10-23', accountability: { openCommitments }, musts: [] });
const openCount = () => taskStore.activeTodos().length;

test('set_focus refuses a line that is several existing tasks, and names them', async () => {
  const s = fixture();
  const r = await session.executeTool(s, 'set_focus', { items: [BUNDLE] });
  assert.equal(r.ok, false);
  for (const id of [ids.rr, ids.st, ids.hy]) assert.match(r.error, new RegExp(`#${id}\\b`));
  assert.deepEqual(s.outcome.focus, [], 'nothing recorded');
});

test('set_focus takes one item per task and the note links each line to its task', async () => {
  const s = fixture();
  const r = await session.executeTool(s, 'set_focus', {
    items: [{ text: 'Round-robin logic', task_id: ids.rr }, { text: "Stephen's flexible working reply", task_id: ids.st }],
  });
  assert.equal(r.ok, true, r.error);
  const note = session._renderDailyNote(s);
  assert.match(note, new RegExp(`Round-robin logic.*<!--task:${ids.rr}-->`));
  assert.match(note, new RegExp(`flexible working reply.*<!--task:${ids.st}-->`));
});

test('a plain single focus line is still accepted', async () => {
  const s = fixture();
  const r = await session.executeTool(s, 'set_focus', { items: ['Finish the podcast draft'] });
  assert.equal(r.ok, true, r.error);
});

test('parking a bundled line without task ids makes NO new task and names the real ones', async () => {
  const s = fixture([{ key: BUNDLE_KEY, text: BUNDLE, daysCarried: 1 }]);
  const before = openCount();
  const r = await session.executeTool(s, 'resolve_commitment', { key: BUNDLE_KEY, decision: 'scheduled', due_date: '2026-10-26' });
  assert.equal(r.ok, false);
  assert.match(r.error, new RegExp(`#${ids.rr}\\b`));
  assert.equal(openCount(), before, 'no task minted');
});

test('parking it with task_ids re-dates every real task and says the weekday back', async () => {
  const s = fixture([{ key: BUNDLE_KEY, text: BUNDLE, daysCarried: 1 }]);
  const before = openCount();
  const r = await session.executeTool(s, 'resolve_commitment', {
    key: BUNDLE_KEY, decision: 'scheduled', due_date: '2026-10-26', task_ids: [ids.rr, ids.st],
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(openCount(), before, 'no task minted');
  assert.equal(taskStore.getTask(ids.rr).due_date.slice(0, 10), '2026-10-26');
  assert.equal(taskStore.getTask(ids.st).due_date.slice(0, 10), '2026-10-26');
  assert.equal(r.dated, 'Monday 26 October');
});

test('a scheduled date in the past is refused', async () => {
  const s = fixture([{ key: 'x line', text: 'Prep the room booking for the offsite', daysCarried: 1 }]);
  const r = await session.executeTool(s, 'resolve_commitment', { key: 'x line', decision: 'scheduled', due_date: '2026-10-01' });
  assert.equal(r.ok, false);
});

test('the context lists the dates ahead with their weekdays', () => {
  const sched = session.buildSchedule(new Date('2026-10-23T08:00:00'));
  const text = session._renderSchedule(sched);
  assert.match(text, /Mon 2026-10-26/);
  assert.match(text, /Wed 2026-10-28/);
  assert.match(text, /Sat 2026-10-24 \(off\)/);
});
