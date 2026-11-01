'use strict';

/**
 * Focus blocks (1 Nov 2026) — real DB, real focus sessions, real routes, a fake
 * Graph transport and a fake push. The clock is walked by hand through one
 * block: ready → start → choose → 2 minutes → wind-down → end → Done.
 *
 * Pinned:
 *  - each moment fires ONCE, and a "restart" (calling tick again over the same
 *    minutes) fires nothing a second time
 *  - the start prompt pushes `block_start`; ready pushes nothing
 *  - the block carries no task until one is picked; picking writes it onto the
 *    block and the event, starts a session and the push hold
 *  - an ordinary push during the block is HELD (push_log 'held'), an escalation
 *    is not, and the held one is released as ONE summary at the end
 *  - no answer at the end ends the session with the block and completes NOTHING
 *  - "Stop there" after two minutes is archived as a start
 *  - a real meeting landing on a not-yet-started block slides it today; a solo
 *    event does not; a block Nick moved is never moved; a full day drops it
 *  - "Not now" twice on the same task → the next offer asks "Is this too big?"
 *  - the routes refuse machines, the kiosk and unknown fields
 *  - no wording about avoiding or failing anywhere it speaks
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-fblock-'));
process.env.NEURO_DB_PATH = path.join(root, 'fblock.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });
process.env.PUSH_QUIET_HOURS = 'off';
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

const db = require('../db/database');
const taskStore = require('./task-store');
const focusBlocks = require('./focus-blocks');
const focusSession = require('./focus-session');
const focusHold = require('./focus-hold');
const webpush = require('./webpush');

test.before(async () => { await db.init(); });

const DAY = '2026-11-02'; // a Monday
const at = (hh, mm, day = 2) => new Date(2026, 10, day, hh, mm, 0, 0);

function fakeGraph() {
  const calls = [];
  let n = 0;
  return {
    calls,
    create: async (ev) => { calls.push(['create', ev]); n++; return { created: true, event: { id: `ev-${n}-${Date.now()}`, webLink: null } }; },
    update: async (id, patch) => { calls.push(['update', id, patch]); return { updated: true }; },
    remove: async (id) => { calls.push(['remove', id]); return { deleted: true }; },
  };
}
function fakePush() {
  const sent = [];
  const fn = async (title, body, data) => { sent.push({ title, body, type: data && data.type }); };
  fn.sent = sent;
  return fn;
}

function reset() {
  for (const t of ['focus_block_state', 'focus_block_moments', 'focus_block_passes']) {
    try { db.run(`DELETE FROM ${t}`); } catch { /* not created yet */ }
  }
  db.run('DELETE FROM task_block_items');
  db.run('DELETE FROM task_blocks');
  db.run('DELETE FROM calendar_cache');
  db.run("UPDATE tasks SET status = 'dropped'");
  db.setState('focus_session', '');
  db.setState('focus_block_hold', '');
  db.setState('push_governor', '{}');
}

let seq = 0;
function task(text, moscow = 'must') {
  seq++;
  return taskStore.createTask({ text: `${text} ${seq}`, moscow, source: 'manual' }).id;
}

test('one block, walked by the clock: ready → start → choose → 2 min → wind-down → end → Done', async () => {
  reset();
  const a = task('Write the rota cover plan');
  const b = task('Review the escalation backlog');
  task('Tidy the KPI board', 'could');
  const graph = fakeGraph();
  const push = fakePush();
  const deps = { graph, push };

  const made = await focusBlocks.createOpenBlock({ date: DAY, startTime: '10:30', minutes: 45, basis: { multiplier: 2.5, learned: false, basis: 'no finished sessions yet — using the 2.5x default' }, deps });
  assert.equal(made.ok, true);
  const id = made.blockId;
  assert.equal(graph.calls[0][1].subject, 'Focus block', 'the event names the time, not a task');
  assert.deepEqual(graph.calls[0][1].attendees, []);
  assert.equal(db.listTaskBlockItems(id).length, 0, 'an open block carries no task until one is picked');

  // Nothing near yet: one query, idle.
  assert.equal((await focusBlocks.tick({ now: at(10, 10), deps })).idle, true);

  // Ready: context gathered, quiet "Up next", no push.
  let r = await focusBlocks.tick({ now: at(10, 26), deps });
  assert.deepEqual(r.fired, [`${id}:ready@10:30`]);
  assert.equal(push.sent.length, 0, 'ready never pushes');
  let v = focusBlocks.view({ now: at(10, 26) });
  assert.equal(v.phase, 'ready');
  assert.match(v.say, /^Up next at 10:30/);
  assert.equal(v.lengthLearned, false, 'the length says it is still the default');

  // A minute before: nothing — the start prompt is AT the start, never early.
  assert.deepEqual((await focusBlocks.tick({ now: at(10, 29), deps })).fired, []);

  // Start: the push and the lead.
  r = await focusBlocks.tick({ now: at(10, 30), deps });
  assert.deepEqual(r.fired, [`${id}:start@10:30`]);
  assert.equal(push.sent[0].type, 'block_start');
  assert.equal(push.sent[0].title, "It's 10:30 — your focus block.");
  v = focusBlocks.view({ now: at(10, 30) });
  assert.equal(v.phase, 'start');
  assert.equal(v.candidates.length, 2, 'top two');
  assert.deepEqual(v.candidates.map((c) => c.taskId).sort(), [a, b].sort());
  assert.equal(v.clock.running, true);
  assert.equal(v.clock.task, null);

  // Restart: the same minutes fire nothing twice.
  assert.deepEqual((await focusBlocks.tick({ now: at(10, 26), deps })).fired, []);
  assert.deepEqual((await focusBlocks.tick({ now: at(10, 30), deps })).fired, []);
  assert.equal(push.sent.length, 1);

  // Choose A, two-minute start.
  const c = await focusBlocks.choose(id, { taskId: a, twoMinute: true }, { now: at(10, 31), deps });
  assert.equal(c.ok, true, c.error);
  assert.equal(focusSession.current(at(10, 31).getTime()).taskId, a);
  assert.deepEqual(db.listTaskBlockItems(id).map((i) => i.task_id), [a], 'the chosen task is written onto the block');
  assert.match(graph.calls.find((x) => x[0] === 'update')[2].subject, /^Focus block: Write the rota cover plan/);
  assert.ok(focusHold.activeAt(focusHold.read(), at(10, 32)), 'the hold is explicit state, set by the choice');

  // An ordinary push during the block is HELD; an escalation is not.
  await webpush.sendToAll('Todo nag', 'Do the thing', { type: 'todo', key: 'todo:nag-1' });
  await webpush.sendToAll('New escalation', 'NT-1 broke', { type: 'escalation_alert', key: 'esc:NT-1' });
  const log = db.getPushLog(10);
  assert.equal(log.find((l) => l.title === 'Todo nag').outcome, 'held');
  assert.notEqual(log.find((l) => l.title === 'New escalation').outcome, 'held');

  // Two minutes in: one prompt.
  r = await focusBlocks.tick({ now: at(10, 33), deps });
  assert.ok(r.fired.some((m) => m.includes('two-minute@')));
  assert.equal(push.sent.at(-1).type, 'block_two_minute');
  assert.equal(focusBlocks.view({ now: at(10, 33) }).phase, 'two-minute');
  assert.equal((await focusBlocks.twoMinute(id, { answer: 'carry-on' }, { now: at(10, 34), deps })).ok, true);
  assert.equal(focusBlocks.view({ now: at(10, 35) }).phase, 'running');
  assert.deepEqual((await focusBlocks.tick({ now: at(10, 35), deps })).fired, [], 'the two-minute prompt fires once');

  // Wind-down.
  r = await focusBlocks.tick({ now: at(11, 10), deps });
  assert.deepEqual(r.fired, [`${id}:wind-down@11:15`]);
  assert.equal(push.sent.at(-1).type, 'block_wind_down');
  assert.equal(focusBlocks.view({ now: at(11, 11) }).phase, 'wind-down');
  assert.equal((await focusBlocks.windDown(id, { note: 'Drafted weeks 44–46' }, { now: at(11, 12) })).ok, true);

  // End: no answer → the session ends with the block, NOTHING completed; the
  // held push comes back as ONE summary; the check-in is pushed.
  r = await focusBlocks.tick({ now: at(11, 15), deps });
  assert.deepEqual(r.fired, [`${id}:end@11:15`]);
  assert.equal(focusSession.current(at(11, 15).getTime()), null, 'the session ended with the block');
  assert.equal(db.getTaskRow(a).status !== 'done', true, 'no answer completes nothing');
  const summary = push.sent.find((p) => p.type === 'block_summary');
  assert.ok(summary, 'held pushes released as one summary');
  assert.match(summary.body, /Todo nag/);
  assert.equal(push.sent.at(-1).type, 'block_end');
  assert.equal(focusHold.read(), null, 'the hold is gone');
  v = focusBlocks.view({ now: at(11, 16) });
  assert.equal(v.phase, 'end');
  assert.deepEqual(v.moreTime, [15, 30]);
  assert.equal(focusSession.history()[0].endedReason, 'block-ended');

  // Restart after the end: nothing again.
  assert.deepEqual((await focusBlocks.tick({ now: at(11, 15), deps })).fired, []);

  // Done: completes through task-store.
  const done = await focusBlocks.endAnswer(id, { answer: 'done' }, { now: at(11, 17), deps });
  assert.equal(done.ok, true);
  assert.equal(db.getTaskRow(a).status, 'done');
  assert.equal(db.getTaskBlockRow(id).status, 'complete');
  assert.equal(focusBlocks.view({ now: at(11, 18) }), null);
});

test('"Stop there" after two minutes is a START, archived cleanly — never a failure', async () => {
  reset();
  const a = task('Ring the agency');
  const deps = { graph: fakeGraph(), push: fakePush() };
  const { blockId } = await focusBlocks.createOpenBlock({ date: DAY, startTime: '13:00', minutes: 30, deps });
  await focusBlocks.tick({ now: at(13, 0), deps });
  await focusBlocks.choose(blockId, { taskId: a, twoMinute: true }, { now: at(13, 1), deps });
  const r = await focusBlocks.twoMinute(blockId, { answer: 'stop' }, { now: at(13, 3), deps });
  assert.equal(r.ok, true);
  assert.equal(r.say, 'Stopped after two minutes — that counts as a start.');
  const h = focusSession.history()[0];
  assert.equal(h.endedReason, 'two-minute-stop');
  const starts = require('./initiation-signals').startsFrom(focusSession.history(), null);
  assert.ok(starts.some((s) => s.id === h.id), 'initiation counts it as a start');
  assert.equal(db.getTaskRow(a).status === 'done', false);
});

test('a real meeting on a not-yet-started block slides it today; solo events and blocks Nick moved stay', async () => {
  reset();
  task('Something to do');
  const graph = fakeGraph();
  const deps = { graph, push: fakePush() };
  const one = await focusBlocks.createOpenBlock({ date: DAY, startTime: '14:00', minutes: 30, deps });
  const two = await focusBlocks.createOpenBlock({ date: DAY, startTime: '15:30', minutes: 30, deps });
  // A solo block over the first — not a meeting.
  db.upsertCalendarEvent({ id: 'solo', subject: 'Think', start: `${DAY}T14:00:00`, end: `${DAY}T14:20:00`, attendeesOther: false, showAs: 'busy' });
  let out = await focusBlocks.afterCalendarSync({ now: at(12, 0), deps });
  assert.equal(out.slid.length, 0, 'a solo event is not a meeting');

  // A real meeting over both; Nick moved the second himself.
  db.upsertCalendarEvent({ id: 'mtg', subject: 'Ops review', start: `${DAY}T14:10:00`, end: `${DAY}T14:40:00`, attendeesOther: true, showAs: 'busy' });
  db.upsertCalendarEvent({ id: 'mtg2', subject: 'Supplier call', start: `${DAY}T15:30:00`, end: `${DAY}T16:00:00`, attendeesOther: true, showAs: 'busy' });
  out = await focusBlocks.afterCalendarSync({ now: at(12, 0), moves: [{ id: two.blockId }], deps });
  assert.equal(out.slid.length, 1);
  assert.equal(out.slid[0].blockId, one.blockId);
  const moved = db.getTaskBlockRow(one.blockId);
  assert.notEqual(moved.start_time, '14:00');
  assert.equal(moved.date_key, DAY, 'today only');
  assert.equal(db.getTaskBlockRow(two.blockId).start_time, '15:30', 'a block Nick moved is never moved');
  assert.ok(graph.calls.some((x) => x[0] === 'update' && x[2].start), 'the Outlook event moved with it');
  assert.match(focusBlocks.view({ now: at(12, 1) }).notice.say, /Ops review/);
});

test('a bumped block with no room left today is dropped, and says so', async () => {
  reset();
  const deps = { graph: fakeGraph(), push: fakePush() };
  const b = await focusBlocks.createOpenBlock({ date: DAY, startTime: '16:00', minutes: 60, deps });
  db.upsertCalendarEvent({ id: 'late', subject: 'Exec catch-up', start: `${DAY}T15:30:00`, end: `${DAY}T17:30:00`, attendeesOther: true, showAs: 'busy' });
  const out = await focusBlocks.afterCalendarSync({ now: at(15, 0), deps });
  assert.equal(out.dropped.length, 1);
  assert.equal(db.getTaskBlockRow(b.blockId).status, 'dropped');
  assert.match(focusBlocks.view({ now: at(15, 1) }).notice.say, /dropped it/);
});

test('"Not now" twice on the same task → the next offer asks whether it is too big', async () => {
  reset();
  const a = task('Rewrite the onboarding guide');
  const deps = { graph: fakeGraph(), push: fakePush() };
  for (const [day, hh] of [[2, 10], [3, 10]]) {
    const dk = `2026-11-0${day}`;
    const { blockId } = await focusBlocks.createOpenBlock({ date: dk, startTime: `${hh}:00`, minutes: 30, deps });
    await focusBlocks.tick({ now: at(hh, 0, day), deps });
    const v = focusBlocks.view({ now: at(hh, 0, day) });
    assert.equal(v.candidates[0].taskId, a);
    assert.equal(v.candidates[0].tooBig, false, 'not yet');
    const r = await focusBlocks.notNow(blockId, { now: at(hh, 1, day), deps });
    assert.equal(r.ok, true);
  }
  const { blockId } = await focusBlocks.createOpenBlock({ date: '2026-11-04', startTime: '10:00', minutes: 30, deps });
  await focusBlocks.tick({ now: at(10, 0, 4), deps });
  const v = focusBlocks.view({ now: at(10, 0, 4) });
  const cand = v.candidates.find((c) => c.taskId === a);
  assert.equal(cand.tooBig, true);
  assert.equal(v.tooBigSay, 'Is this too big? Make it smaller.');
  // Choosing with a smaller first bit records it as a shrink on the session.
  const r = await focusBlocks.choose(blockId, { taskId: a, smallerStep: 'Outline section 1' }, { now: at(10, 1, 4), deps });
  assert.equal(r.ok, true);
  assert.equal(r.shrunk, true);
  assert.equal(focusSession.current(at(10, 2, 4).getTime()).nextStep, 'Outline section 1');
});

test('"Not now" slides the block later today, or lets it go', async () => {
  reset();
  task('Plan the week');
  const deps = { graph: fakeGraph(), push: fakePush() };
  const { blockId } = await focusBlocks.createOpenBlock({ date: DAY, startTime: '11:00', minutes: 30, deps });
  await focusBlocks.tick({ now: at(11, 0), deps });
  const r = await focusBlocks.notNow(blockId, { now: at(11, 1), deps });
  assert.equal(r.moved, true);
  assert.ok(db.getTaskBlockRow(blockId).start_time > '11:00');
  // Late in the day: nothing left — released, not completed.
  const late = await focusBlocks.createOpenBlock({ date: DAY, startTime: '17:00', minutes: 30, deps });
  await focusBlocks.tick({ now: at(17, 0), deps });
  const r2 = await focusBlocks.notNow(late.blockId, { now: at(17, 1), deps });
  assert.equal(r2.released, true);
  assert.equal(db.getTaskBlockRow(late.blockId).status, 'released');
});

test('More time extends only into a free diary; Stuck keeps the smaller step for next time', async () => {
  reset();
  const a = task('Draft the policy');
  const deps = { graph: fakeGraph(), push: fakePush() };
  const { blockId } = await focusBlocks.createOpenBlock({ date: DAY, startTime: '09:30', minutes: 30, deps });
  await focusBlocks.tick({ now: at(9, 30), deps });
  await focusBlocks.choose(blockId, { taskId: a }, { now: at(9, 31), deps });
  await focusBlocks.tick({ now: at(10, 0), deps });
  db.upsertCalendarEvent({ id: 'next', subject: 'Standup', start: `${DAY}T10:20:00`, end: `${DAY}T10:40:00`, attendeesOther: true, showAs: 'busy' });
  const tooLong = await focusBlocks.endAnswer(blockId, { answer: 'more', minutes: 30 }, { now: at(10, 1), deps });
  assert.equal(tooLong.extended, false);
  assert.match(tooLong.say, /Standup/);
  const ok = await focusBlocks.endAnswer(blockId, { answer: 'more', minutes: 15 }, { now: at(10, 1), deps });
  assert.equal(ok.extended, true);
  assert.equal(db.getTaskBlockRow(blockId).end_time, '10:15');
  assert.equal(focusSession.current(at(10, 2).getTime()).taskId, a);
  const st = await focusBlocks.endAnswer(blockId, { answer: 'stuck', step: 'List the three sections' }, { now: at(10, 15), deps });
  assert.equal(st.offer, 'make-smaller');
  const passes = focusBlocks.passesFor([a], at(10, 16));
  assert.equal(focusBlocks.smallerStepFrom(passes, a), 'List the three sections');
});

test('the planner books the TIME: open blocks, no task written on them', async () => {
  reset();
  task('Work item one');
  task('Work item two');
  const planner = require('./day-planner');
  const real = focusBlocks.createOpenBlock;
  const made = [];
  focusBlocks.createOpenBlock = async (args) => { made.push(args); return real({ ...args, deps: { graph: fakeGraph() } }); };
  try {
    const r = await planner.run('morning', { now: at(8, 0), apply: true, force: true });
    assert.equal(r.ok, true, r.error);
    assert.ok(r.created && r.created.length >= 1, JSON.stringify(r).slice(0, 400));
    assert.ok(made.length >= 1);
    for (const c of r.created) assert.equal(db.listTaskBlockItems(c.blockId).length, 0, 'no task fixed at 07:15');
    assert.ok(made[0].basis && 'learned' in made[0].basis, 'sized by the measured multiplier, which says if it is learned');
  } finally {
    focusBlocks.createOpenBlock = real;
  }
});

test('the routes refuse machines, the kiosk and unknown fields', async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (req.headers['x-kiosk']) req.attendedSurface = 'kiosk'; next(); });
  app.use('/api/focus-blocks', require('../routes/focus-blocks'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/focus-blocks`;
  try {
    const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await post('/1/not-now', {}, { 'X-Neuro-Machine-Client': 'mcp-local' })).status, 403);
    assert.equal((await post('/1/not-now', {}, { 'x-kiosk': '1' })).status, 403);
    assert.equal((await post('/1/choose', { taskId: 1, date: '2026-11-02' })).status, 400);
    assert.equal((await post('/1/end', { answer: 'maybe' })).status, 400, 'an unknown answer is refused');
    assert.equal((await post('/999/end', { answer: 'done' })).status, 404, 'no such block');
    const get = await (await fetch(base)).json();
    assert.equal(get.ok, true);
  } finally {
    server.close();
  }
});

test('no wording about avoiding or failing, anywhere it speaks', () => {
  const said = Object.values(focusBlocks.SAY).map((f) => f({ start_time: '10:30', end_time: '11:00' })).join(' ');
  const jsx = fs.readFileSync(path.join(__dirname, '..', '..', 'saim', 'shared-ui', 'FocusBlock.jsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const text of [said, jsx]) {
    assert.doesNotMatch(text, /\bavoid|procrastinat|lazy|excuse|\bfail(ed|ure|ing)?\b|again\?|dodg/i);
  }
  assert.ok(said.length > 50, 'positive control: the sentences were read');
});

test('PURE: candidates keep the ranked order, drop deferred / blocked / personal / done-today repeats', () => {
  const ranked = [
    { task_id: 1, text: 'one' },
    { task_id: 2, text: 'two', domain: 'personal' },
    { task_id: 3, text: 'three' },
    { task_id: 4, text: 'four', repeat: { kind: 'interval' }, due_date: '2026-11-09' },
    { task_id: 5, text: 'five' },
    { task_id: 6, text: 'six' },
  ];
  const out = focusBlocks.pickCandidates(ranked, {
    deferred: new Set(['todo:three']), deferredKey: (t) => `todo:${t.text}`,
    blocked: new Set([5]), today: '2026-11-02',
  });
  assert.deepEqual(out.map((c) => c.taskId), [1, 6]);
});
