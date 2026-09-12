'use strict';

/**
 * "While I'm in here, is there more like this?"
 *
 * `related()` is pure, so what is under test is the product: which shared
 * provenance counts as a cohort, and — more importantly — which does NOT.
 *
 * Every fixture is shaped from the LIVE store as measured on 12 Sep 2026 (93
 * open tasks), because the two rules that matter both came out of measurement
 * rather than from reasoning:
 *
 *   - `master-todo-import` is 57% of the list and is not a cohort, it is the
 *     list he already has;
 *   - the richest cohort is the MEETING NOTE (6 open commitments from one
 *     meeting), not Jira — which is his own example and the smallest at 4.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cohort = require('./task-cohort');

const MEETING = 'Meetings/2026/09/2026-09-08 – Meeting Support Team Performance, Scope Definition, AI Adoption.md';
const MEETING_B = 'Meetings/2026/09/2026-09-07 – Tech Leadship Meeting Ticket Volume, SLAs, and TPJ Issues.md';

function task(over = {}) {
  return {
    task_id: over.task_id ?? 1,
    text: over.text ?? 'A task',
    source: 'meeting-promotion',
    context: 'meeting-follow-up',
    domain: 'work',
    origin_path: MEETING,
    jiraKey: null,
    ...over,
  };
}

// A pool shaped like the real one: mostly the historical import, a cluster from
// one meeting, a few from elsewhere.
function livePool() {
  const pool = [];
  let id = 1;
  for (let i = 0; i < 6; i++) pool.push(task({ task_id: id++, text: 'Meeting commitment ' + i, origin_path: MEETING }));
  for (let i = 0; i < 3; i++) pool.push(task({ task_id: id++, text: 'Other meeting ' + i, origin_path: MEETING_B }));
  for (let i = 0; i < 53; i++) {
    pool.push(task({ task_id: id++, text: 'Imported ' + i, source: 'master-todo-import', context: 'project', origin_path: 'Tasks/Master Todo.md' }));
  }
  for (let i = 0; i < 4; i++) {
    pool.push(task({ task_id: id++, text: 'Jira ' + i, source: 'jira-assigned', context: 'general', origin_path: null, jiraKey: 'NT-' + (100 + i) }));
  }
  return pool;
}

// ── The cohort that matters ──────────────────────────────────────────────────

test('the meeting note is the strongest cohort', () => {
  const pool = livePool();
  const { best } = cohort.related(pool[0], pool);
  assert.equal(best.kind, 'meeting');
  assert.equal(best.count, 5, 'the other five commitments from that meeting');
});

test('the cohort is named in words he would recognise, not a path', () => {
  const { best } = cohort.related(livePool()[0], livePool());
  assert.match(best.label, /Support Team Performance/);
  assert.doesNotMatch(best.label, /Meetings\//, 'no folder');
  assert.doesNotMatch(best.label, /2026-09-08/, 'no date — the title is the useful half');
});

test('a task from a different meeting is not in this cohort', () => {
  const pool = livePool();
  const { best } = cohort.related(pool[0], pool);
  const ids = best.tasks.map(t => t.id);
  const otherMeeting = pool.find(t => t.origin_path === MEETING_B);
  assert.equal(ids.includes(otherMeeting.task_id), false);
});

test('the task he is on is never offered back to him', () => {
  const pool = livePool();
  const { best } = cohort.related(pool[0], pool);
  assert.equal(best.tasks.some(t => t.id === pool[0].task_id), false);
});

// ── The rule that measurement produced ───────────────────────────────────────

test('⚠ NEGATIVE: `master-todo-import` is 57% of the list and is NOT a cohort', () => {
  const pool = livePool();
  const imported = pool.find(t => t.source === 'master-todo-import');
  const { cohorts } = cohort.related(imported, pool);
  assert.equal(cohorts.some(c => c.key === 'source:master-todo-import'), false);
});

test('⚠ a cohort covering most of the pool is REPORTED as too broad, not silently dropped', () => {
  const pool = livePool();
  const imported = pool.find(t => t.source === 'master-todo-import');
  const { gaps } = cohort.related(imported, pool);
  assert.ok(gaps.some(g => /category, not something to clear/.test(g)), 'it says why it offered nothing');
});

test('⚠ NEGATIVE: `context: general` is the ABSENCE of a context, never a cohort', () => {
  const pool = livePool();
  const jira = pool.find(t => t.source === 'jira-assigned');
  const { cohorts } = cohort.related(jira, pool);
  assert.equal(cohorts.some(c => c.key === 'context:general'), false);
});

test('⚠ NEGATIVE: `domain` is a single value across every open task and is never a cohort', () => {
  // 93 of 93 are `work`. A cohort of "everything" is not a suggestion.
  const all = cohort.cohortsFor(task({ domain: 'work' }));
  assert.equal(all.some(c => c.kind === 'domain'), false);
});

// ── His own example, kept because he asked for it ────────────────────────────

test('Jira is a cohort — small, and exactly what he asked for', () => {
  const pool = livePool();
  const jira = pool.find(t => t.jiraKey);
  const { cohorts } = cohort.related(jira, pool);
  const j = cohorts.find(c => c.kind === 'jira');
  assert.ok(j, 'a Jira ticket finds the other Jira tickets');
  assert.equal(j.count, 3, 'the other three');
});

test('a task with no Jira link finds no Jira cohort', () => {
  const pool = livePool();
  const { cohorts } = cohort.related(pool[0], pool);
  assert.equal(cohorts.some(c => c.kind === 'jira'), false);
});

// ── Honesty ──────────────────────────────────────────────────────────────────

test('⚠ an unreadable pool is a GAP, never "there is nothing else"', () => {
  const r = cohort.related(task(), null);
  assert.deepEqual(r.cohorts, []);
  assert.ok(r.gaps.some(g => /not "there is nothing else"/.test(g)));
});

test('no task to compare against is its own stated reason', () => {
  const r = cohort.related(null, livePool());
  assert.equal(r.best, null);
  assert.ok(r.gaps.length > 0);
});

test('a genuinely lone task offers nothing, and that is a real answer', () => {
  const lone = task({ task_id: 999, source: 'nova-121', context: 'people', origin_path: null });
  const { cohorts, gaps } = cohort.related(lone, [lone]);
  assert.deepEqual(cohorts, []);
  assert.deepEqual(gaps, [], 'nothing to explain — there simply is no-one else');
});

test('the listed tasks are capped, and the remainder is COUNTED not dropped', () => {
  // Eight in the cohort (the cap), four listed, so four counted. A number on
  // screen that silently omitted the rest would be a lie about the size of it.
  const pool = [];
  for (let i = 0; i < 9; i++) pool.push(task({ task_id: i + 1, origin_path: MEETING }));
  for (let i = 0; i < 200; i++) pool.push(task({ task_id: 1000 + i, source: 'email-promotion', context: 'queue', origin_path: null }));
  const { best } = cohort.related(pool[0], pool);
  assert.equal(best.count, 8, 'right at the cap');
  assert.equal(best.tasks.length, cohort.MAX_LISTED);
  assert.equal(best.more, 8 - cohort.MAX_LISTED);
});

test('⚠ a cohort ONE over the cap is refused, and says it is a category', () => {
  // The live failure this cap exists for: 17 "queue work" tasks sat inside the
  // fraction rule and were offered as if they were a sitting's worth.
  const pool = [];
  for (let i = 0; i < 10; i++) pool.push(task({ task_id: i + 1, origin_path: MEETING }));
  for (let i = 0; i < 200; i++) pool.push(task({ task_id: 1000 + i, source: 'email-promotion', context: 'queue', origin_path: null }));
  const r = cohort.related(pool[0], pool);
  assert.equal(r.cohorts.some(c => c.kind === 'meeting'), false);
  assert.ok(r.gaps.some(g => /category, not something to clear/.test(g)));
});

test('cohorts come back strongest first', () => {
  const pool = livePool();
  const { cohorts } = cohort.related(pool[0], pool);
  const strengths = cohorts.map(c => c.strength);
  assert.deepEqual(strengths, [...strengths].sort((a, b) => a - b));
});

test('⚠ the import denylist is load-bearing ON ITS OWN, not just via the size rule', () => {
  // Mutation-checking on 12 Sep 2026 showed the denylist entry for
  // `master-todo-import` failed NO test: the 57%-of-the-pool rule was excluding
  // it single-handed, so the deny entry was decoration. It is not decoration in
  // principle — on a SHORTER list the same junk provenance sails through the
  // size check, and "here are four more tasks that also came from the big
  // import" is meaningless. This pool is small enough that only the denylist
  // can refuse it.
  const pool = [];
  for (let i = 0; i < 4; i++) {
    pool.push(task({ task_id: i + 1, source: 'master-todo-import', context: 'project', origin_path: 'Tasks/Master Todo.md' }));
  }
  for (let i = 0; i < 40; i++) {
    pool.push(task({ task_id: 100 + i, source: 'email-promotion', context: 'queue', origin_path: null }));
  }
  const { cohorts, gaps } = cohort.related(pool[0], pool);
  // 4 of 44 is ~9%, comfortably inside the size rule — so if it is refused, the
  // denylist is what refused it.
  assert.equal(cohorts.some(c => c.key === 'source:source:master-todo-import'), false);
  assert.equal(cohorts.some(c => c.kind === 'source'), false, 'the import is not a cohort at any size');
  assert.equal(gaps.some(g => /category, not something to clear/.test(g)), false, 'and it was not the size rule that refused it');
});
