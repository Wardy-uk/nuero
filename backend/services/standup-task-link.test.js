'use strict';

/**
 * A commitment made at standup is the TASK it already is (11 Sep 2026).
 *
 * Nick: "it's adding new tasks when I commit to doing things — the Krista to do
 * was on there three times. When I commit to doing something in standup, the
 * original task should be added to the time block I chose."
 *
 * Three things were true on the live system that morning, and each is pinned:
 *
 *   - Task #30 "Review the "Krista" issue first thing after Maria sends details"
 *     existed. The standup wrote its OWN wording into the daily note and nothing
 *     joined the two, so the task list showed both.
 *   - `#carried-2d` stripped to "-2d", so every day's copy of that line had a
 *     different text and the list showed one per daily note.
 *   - "Put it in 14:30 to 16:00" was answered "Done" by a standup with no tool
 *     that could book anything.
 *
 * Fixture wordings are copied from the live note and task, not invented.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-standup-link-'));
process.env.NEURO_DB_PATH = path.join(root, 'link.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Tasks'), { recursive: true });
fs.mkdirSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Daily'), { recursive: true });

const db = require('../db/database');
const session = require('./standup-session');
const taskStore = require('./task-store');
const accountability = require('./standup-accountability');

// The matcher weights a word by how RARE it is across the open list, so a pool
// of one task makes every shared word look common and no pair can score. The
// 0.6 hint was measured against a live pool of 94; these give the fixture a
// realistic spread of Nick's stock vocabulary (review, support, issue, team…)
// without putting real names in a public repo.
const POOL = [
  'Review the weekly SLA report and flag breaches to the team',
  'Respond to the escalation on the portal login issue',
  'Update the support rota for next month',
  'Review ticket ageing for Tier 2 and send details to the leads',
  'Chase development on the reporting issue',
  'Prepare the monthly support KPI pack',
  'Review QA scores with the team leads',
  'Send details of the new process to the support team',
  'Book 1-2-1s for the month',
  'Review customer complaint themes from last week',
  'Draft the knowledge base article on password resets',
  'Check overtime claims and approve',
  'Review the onboarding checklist for new starters',
  'Respond to HR about the team structure',
  'Plan the team meeting agenda',
  'Review open escalations with development',
];

test.before(async () => {
  await db.init();
  for (const text of POOL) taskStore.createTask({ text, source: 'manual', skipExport: true });
});

const KRISTA_TASK = 'Review the "Krista" issue first thing after Maria sends details';
const KRISTA_LINE = "Review the Krista issue and respond to Maria's details";
const KRISTA_KEY = accountability.commitmentKey(KRISTA_LINE);

let seq = 0;
function task(text) {
  // Unique wording per call so createTask's exact-text fold never merges fixtures.
  return taskStore.createTask({ text, source: 'manual', skipExport: true }).id;
}

function fixture(openCommitments, dateKey = `2026-10-${String(10 + (seq++ % 18)).padStart(2, '0')}`) {
  return session._emptySession('standup', { dateKey, accountability: { openCommitments }, musts: [] });
}

function withGraph(fn) {
  const microsoft = require('./microsoft');
  const real = { c: microsoft.createCalendarEvent, u: microsoft.updateCalendarEvent, d: microsoft.deleteCalendarEvent };
  let n = 0;
  microsoft.createCalendarEvent = async () => ({ created: true, event: { id: `evt-link-${++n}`, webLink: null } });
  microsoft.updateCalendarEvent = async () => ({ updated: true });
  microsoft.deleteCalendarEvent = async () => ({ deleted: true });
  const restore = () => Object.assign(microsoft, { createCalendarEvent: real.c, updateCalendarEvent: real.u, deleteCalendarEvent: real.d });
  return Promise.resolve().then(fn).then(r => { restore(); return r; }, e => { restore(); throw e; });
}

const focusLines = (note) => note.split('## Focus Today')[1].split('##')[0]
  .split('\n').filter(l => l.trim().startsWith('- '));

// ── The context names the task ───────────────────────────────────────────────

test('the context marks a carried line with the task it most likely is', () => {
  const id = task(KRISTA_TASK);
  const s = fixture([{ key: KRISTA_KEY, text: KRISTA_LINE, daysCarried: 3 }]);
  // buildContext is what runs the link; drive the same step on this fixture.
  session._linkCommitments(s.context.accountability.openCommitments);
  const rendered = session._renderContext(s.context);
  assert.match(rendered, new RegExp(`likely task #${id}`), rendered);
});

test('an unrelated carried line is NOT offered a task — the measured wrong match stays out', () => {
  task('Work with Mel on weekend support coverage plan and alerting/response process');
  const open = [{ key: 'prep admin work for the weekend', text: 'Prep admin work for the weekend', daysCarried: 1 }];
  session._linkCommitments(open);
  assert.equal(open[0].task, undefined, `0.427 in the measurement — got ${JSON.stringify(open[0].task)}`);
});

test('a line already linked to a FINISHED task tells SAiM not to chase it', () => {
  const id = task('Send the Guild MI pack to finance this week');
  taskStore.updateTask(id, { status: 'dropped' });
  const open = [{ key: 'send the guild mi pack', text: 'Send the Guild MI pack', daysCarried: 2, taskId: id }];
  session._linkCommitments(open);
  const rendered = session._renderContext({ accountability: { openCommitments: open } });
  assert.match(rendered, new RegExp(`TASK #${id}, ALREADY DROPPED`));
});

// ── Resolving a commitment ───────────────────────────────────────────────────

test('resolving with a task_id writes the marker onto the line, and the carry key does not move', async () => {
  const id = task('Review the Krista issue — linked fixture');
  const s = fixture([{ key: KRISTA_KEY, text: KRISTA_LINE, daysCarried: 3 }]);
  const r = await session.executeTool(s, 'resolve_commitment', { key: KRISTA_KEY, decision: 'today', task_id: id });
  assert.equal(r.ok, true, r.error);
  s.outcome.focus = ['Review Krista issue and respond to Maria'];

  const note = session._renderDailyNote(s);
  const lines = focusLines(note);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], new RegExp(`<!--task:${id}-->`));

  // Tomorrow reads the SAME key it read today, plus the link.
  const parsed = accountability.parseDailyNote(note);
  assert.equal(parsed.focus[0].key, KRISTA_KEY);
  assert.equal(parsed.focus[0].taskId, id);
});

test('an unknown task_id is refused rather than written into the note', async () => {
  const s = fixture([{ key: KRISTA_KEY, text: KRISTA_LINE, daysCarried: 3 }]);
  const r = await session.executeTool(s, 'resolve_commitment', { key: KRISTA_KEY, decision: 'today', task_id: 999999 });
  assert.equal(r.ok, false);
  assert.equal(s.outcome.commitments.length, 0);
});

test('"scheduled" on a linked commitment dates THAT task and creates nothing', async () => {
  const id = task('Chase the Sandford renewal paperwork');
  const before = db.listTaskRows({ status: 'all' }).length;
  const s = fixture([{ key: 'chase sandford', text: 'Chase Sandford', daysCarried: 4 }]);
  await session.executeTool(s, 'resolve_commitment', {
    key: 'chase sandford', decision: 'scheduled', due_date: '2026-10-20', note: 'Waiting on legal', task_id: id,
  });
  assert.equal(taskStore.getTask(id).due_date, '2026-10-20');
  assert.equal(db.listTaskRows({ status: 'all' }).length, before, 'a linked commitment must not breed a second task');
});

test('"scheduled" with no task names the new task after the COMMITMENT, never the reason', async () => {
  const s = fixture([{ key: 'draft the q4 rota', text: 'Draft the Q4 rota', daysCarried: 3 }]);
  await session.executeTool(s, 'resolve_commitment', {
    key: 'draft the q4 rota', decision: 'scheduled', due_date: '2026-10-21', note: 'Blocked until HR confirm leave',
  });
  const rows = db.listTaskRows({ status: 'all' });
  assert.ok(rows.some(t => t.text === 'Draft the Q4 rota' && t.due_date === '2026-10-21'));
  assert.equal(rows.some(t => /Blocked until HR/.test(t.text)), false, 'the reason became a task to do');
});

// ── create_task at a standup ─────────────────────────────────────────────────

test('create_task at standup refuses a copy of an existing task and names it', async () => {
  const id = task('Scope, build and deploy AI messaging workflow changes to NOVA');
  const before = db.listTaskRows({ status: 'all' }).length;
  const s = fixture([]);
  const r = await session.executeTool(s, 'create_task', { text: 'Build and deploy the AI messaging workflow changes in NOVA' });
  assert.equal(r.ok, false);
  assert.equal(r.existing.id, id);
  assert.equal(db.listTaskRows({ status: 'all' }).length, before);
});

test('create_task with force creates it anyway, once he has said it is different', async () => {
  task('Record the full support podcast with Ricky');
  const s = fixture([]);
  const r = await session.executeTool(s, 'create_task', { text: 'Record the full support podcast intro with Ricky', force: true });
  assert.equal(r.ok, true, r.error);
  assert.ok(taskStore.getTask(r.task_id));
});

test('create_task for genuinely new work still creates, and the note line points at it', async () => {
  const s = fixture([]);
  const r = await session.executeTool(s, 'create_task', { text: 'NDC data fixes for the dev review queue' });
  assert.equal(r.ok, true, r.error);
  s.outcome.focus = ['NDC data fixes for the dev review queue'];
  assert.match(focusLines(session._renderDailyNote(s))[0], new RegExp(`<!--task:${r.task_id}-->`));
});

// ── block_time ───────────────────────────────────────────────────────────────

test('block_time puts the ORIGINAL tasks in one block, moving one out of its dead window', async () => {
  const krista = task('Review the "Krista" issue — block fixture');
  const nova = task('NOVA messaging workflow — block fixture');
  const taskBlocks = require('./task-blocks');

  // Krista's earlier window came and went unworked, as it had on 9 Sep.
  const stale = await withGraph(() => taskBlocks.schedule([krista], { date: '2026-09-09', startTime: '12:35', minutes: 20 }));
  assert.equal(stale.ok, true, stale.error);

  const s = fixture([], '2026-09-11');
  const r = await withGraph(() => session.executeTool(s, 'block_time', { task_ids: [krista, nova], start: '14:30', end: '16:00' }));
  assert.equal(r.ok, true, r.error);
  assert.match(r.booked, /2026-09-11 14:30-16:00/);
  assert.equal(r.movedFrom.length, 1);

  const open = db.listTaskBlockRows({ taskId: krista, openOnly: true });
  assert.equal(open.length, 1, 'one task, one window');
  assert.equal(open[0].start_time, '14:30');
  assert.equal(db.listTaskRows({ status: 'all' }).filter(t => /block fixture/.test(t.text)).length, 2, 'no copies made');
});

test('block_time refuses a malformed time rather than guessing one', async () => {
  const id = task('Time-parsing fixture task');
  const s = fixture([]);
  assert.equal((await session.executeTool(s, 'block_time', { task_ids: [id], start: 'this afternoon' })).ok, false);
  assert.equal((await session.executeTool(s, 'block_time', { task_ids: [id], start: '16:00', end: '14:30' })).ok, false);
  assert.equal((await session.executeTool(s, 'block_time', { task_ids: [], start: '14:30' })).ok, false);
  assert.equal(db.listTaskBlockRows({ taskId: id, openOnly: true }).length, 0);
});

test('block_time is offered to the model', () => {
  assert.ok(session.toolDefinitions().some(t => t.name === 'block_time'));
});

// ── The task list ────────────────────────────────────────────────────────────

test('the task list shows a linked daily-note line ONCE — as its task', () => {
  const id = task('Review the "Krista" issue — task list fixture');
  const d = (n) => `2026-11-0${n}`;
  const daily = path.join(process.env.OBSIDIAN_VAULT_PATH, 'Daily');
  const line = "Review the Krista issue and respond to Maria's details (list fixture)";
  fs.writeFileSync(path.join(daily, `${d(1)}.md`), `## Focus Today\n- [ ] ${line} #focus #carried-1d <!--task:${id}-->\n`);
  fs.writeFileSync(path.join(daily, `${d(2)}.md`), `## Carry-Overs\n- [ ] ${line} #carried-2d <!--task:${id}-->\n`);
  fs.writeFileSync(path.join(daily, `${d(3)}.md`), `## Focus Today\n- [ ] ${line} #focus #carried-3d <!--task:${id}-->\n`);

  const { active } = require('./obsidian').parseVaultTodos();
  assert.equal(active.filter(t => /list fixture/.test(t.text) && !t.task_id).length, 0, 'the standup copy is still on the list');
  assert.equal(active.filter(t => t.task_id === id).length, 1);
});

test('an UNLINKED carried line folds across days — "#carried-2d" leaves no "-2d" behind', () => {
  const daily = path.join(process.env.OBSIDIAN_VAULT_PATH, 'Daily');
  const line = 'Finish the support podcast edit (unlinked fixture)';
  fs.writeFileSync(path.join(daily, '2026-12-01.md'), `## Focus Today\n- [ ] ${line} #focus #carried-1d\n`);
  fs.writeFileSync(path.join(daily, '2026-12-02.md'), `## Carry-Overs\n- [ ] ${line} #carried-2d\n`);
  fs.writeFileSync(path.join(daily, '2026-12-03.md'), `## Focus Today\n- [ ] ${line} #focus #carried-3d\n`);

  const { active } = require('./obsidian').parseVaultTodos();
  const copies = active.filter(t => /unlinked fixture/.test(t.text));
  assert.equal(copies.length, 1, copies.map(t => t.text).join(' | '));
  assert.equal(/-\dd\b/.test(copies[0].text), false, copies[0].text);
});

test('a line pointing at a task that no longer exists is KEPT, not lost', () => {
  const daily = path.join(process.env.OBSIDIAN_VAULT_PATH, 'Daily');
  fs.writeFileSync(path.join(daily, '2026-12-04.md'), '## Focus Today\n- [ ] Orphaned link fixture line #focus <!--task:888888-->\n');
  const { active } = require('./obsidian').parseVaultTodos();
  assert.equal(active.filter(t => /Orphaned link fixture/.test(t.text)).length, 1);
});
