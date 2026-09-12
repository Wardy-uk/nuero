'use strict';

// "While I'm in here, is there more like this?" (12 Sep 2026)
//
// PURE. No DB, no clock, no network. Takes a task and the open pool and returns
// the other tasks that share a SPECIFIC provenance with it.
//
// Nick's opening ask: *"if I'm working on a particular type of task, find more
// that are in the same category — eg if I'm working on a Jira ticket/complaint,
// are there any more Jira tickets while I'm there."* The value is batching: the
// expensive part of a task is loading the context, and a second task in the
// same context is nearly free.
//
// ⚠ A COHORT IS SHARED PROVENANCE, NOT SIMILAR WORDING. Every field used here
//   was already recorded when the task was created; nothing is inferred and no
//   classifier runs, so this is instant, free, identical every time and works
//   with the Pi offline. Text similarity is `task-dedupe`'s job and answers a
//   DIFFERENT question — "is this the same task" — and folding the two would
//   quietly turn "here is more of this kind" into "you wrote this down twice".
//
// ⚠ MEASURED ON THE LIVE STORE BEFORE ANY RULE WAS WRITTEN (93 open tasks):
//
//     source    master-todo-import 53 | meeting-promotion 23 | email-promotion 5
//               vantage-finding 4 | jira-assigned 4 | management-log 3 | nova-121 1
//     context   meeting-follow-up 23 | general 22 | project 21 | queue 18 | people 9
//     domain    work 93          <- ZERO discrimination
//     ms_plan   null 93          <- Microsoft tasks are file-backed mirrors,
//                                   they are not rows in this table at all
//     meetings  6, 3, 2, 2 tasks per note (23 meeting-sourced in total)
//
//   Three things follow, and none of them was guessable:
//
//   1. ⚠ THE MEETING NOTE IS THE RICHEST COHORT, not Jira. Six open commitments
//      came out of the 8 Sep meeting alone. That is exactly "more like this" and
//      it is the case worth building for.
//   2. ⚠ HIS OWN EXAMPLE IS THE SMALLEST ONE — 4 Jira-sourced tasks in the whole
//      store. Kept, because it is what he asked for and 4 is a perfectly good
//      answer, but it is not where the value is.
//   3. ⚠ `master-todo-import` IS 57% OF THE LIST AND IS NOT A COHORT. It is a
//      historical bulk import from `Tasks/Master Todo.md`. "Here are 52 more
//      tasks that also came from the big import" is the list he already has,
//      wearing a suggestion's clothes. Same for `context: general`, which is
//      the ABSENCE of a context rather than one, and `domain`, which is a single
//      value across every open task.
//
// ⚠ SO A COHORT MUST EARN ITS PLACE BY BEING SPECIFIC. `MAX_COHORT_FRACTION`
//   sits in the measured gap: the largest real cohort is 23 of 93 (25%) and the
//   junk one is 53 of 93 (57%). A third of the list is the cut. A cohort that
//   matches most of the pool has told you nothing, and offering it teaches him
//   to ignore the panel.
//
// ⚠ IT SUGGESTS AND NOTHING ELSE. No reordering of his list, no auto-starting,
//   nothing written. `rankTasks` stays the one place ordering is decided —
//   cohort membership is not a reason to promote work up the list, and letting
//   it would quietly turn this into the quick-wins list the codebase already
//   refuses to become.

// A cohort matching more than this share of the open pool is a CATEGORY, not a
// cohort. Measured: the largest real one is 25%, the junk one 57%.
const MAX_COHORT_FRACTION = 1 / 3;

// ⚠ THE FRACTION ALONE WAS TOO GENEROUS, and only the real OUTPUT showed it.
//   The distribution said the largest genuine cohort was 23 of 93, so a third
//   of the list looked like a safe cut. Run against the live store it then
//   offered "17 more in queue work" and "22 more things you committed to in
//   meetings" — both inside the fraction, both useless. That is a CATEGORY
//   LISTING, not "while you are in here", and it is the list he already has.
//
//   The product test is a SITTING: a cohort is worth naming when he could
//   plausibly clear it in the context he is already loaded into. Eight is the
//   line, and it separates the live data cleanly:
//
//     KEPT     meeting notes 6, 3, 2, 2 | Jira 4 | email 5 | VANTAGE 4 | mgmt log 3
//     REFUSED  people 9 | queue 18 | project 21 | meeting-follow-up 23
//
//   ⚠ A lesson worth keeping: the distribution of a field tells you which
//   values are RARE, and says nothing about whether the resulting suggestion
//   is USEFUL. Only reading the output does that.
const MAX_COHORT_SIZE = 8;

// Never offered as a cohort, each for a measured reason (see the header).
const NOT_A_COHORT = {
  source: new Set(['master-todo-import', 'manual', 'unattributed', 'capture', 'chat', 'mcp', 'watch']),
  context: new Set(['general']),
};

// How many tasks to name for one cohort. Beyond a handful this stops being
// "while you are here" and becomes a second task list.
const MAX_LISTED = 4;

function norm(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** The meeting note a task came out of, or null. */
function meetingOf(task) {
  const p = norm(task && task.origin_path);
  if (!p || !p.startsWith('Meetings/')) return null;
  return p;
}

/** A readable name for a meeting note path: the title, without date or folders. */
function meetingLabel(path) {
  const base = String(path).split('/').pop().replace(/\.md$/i, '');
  // "2026-09-08 – Meeting Support Team Performance, Scope…" → the title half.
  const m = base.match(/^\d{4}-\d{2}-\d{2}\s*[–-]\s*(.+)$/);
  const title = m ? m[1] : base;
  return title.length > 52 ? title.slice(0, 52).trimEnd() + '…' : title;
}

/**
 * The cohorts a task belongs to, strongest (most specific) first.
 *
 * `strength` is a rank, not a score: lower is more specific. It exists so the
 * caller can offer the sharpest cohort rather than the first one found.
 */
function cohortsFor(task) {
  if (!task) return [];
  const out = [];

  const meeting = meetingOf(task);
  if (meeting) {
    out.push({ kind: 'meeting', key: 'meeting:' + meeting, label: meetingLabel(meeting), strength: 0 });
  }

  // His own example. Small, and kept because he asked for it.
  if (norm(task.jiraKey)) {
    out.push({ kind: 'jira', key: 'jira', label: 'Jira tickets', strength: 1 });
  }

  const source = norm(task.source);
  if (source && !NOT_A_COHORT.source.has(source)) {
    out.push({ kind: 'source', key: 'source:' + source, label: sourceLabel(source), strength: 2 });
  }

  const context = norm(task.context);
  if (context && !NOT_A_COHORT.context.has(context)) {
    out.push({ kind: 'context', key: 'context:' + context, label: contextLabel(context), strength: 3 });
  }

  return out.sort((a, b) => a.strength - b.strength);
}

function sourceLabel(source) {
  return ({
    'meeting-promotion': 'things you committed to in meetings',
    'email-promotion': 'things that came out of email',
    'vantage-finding': 'VANTAGE findings',
    'jira-assigned': 'Jira tickets',
    'management-log': 'management log items',
    'nova-121': 'from a 1-2-1',
  })[source] || source;
}

function contextLabel(context) {
  return ({
    'meeting-follow-up': 'meeting follow-ups',
    queue: 'queue work',
    people: 'people work',
    project: 'project work',
    customer: 'customer work',
    admin: 'admin',
  })[context] || context;
}

/** Does `other` share this cohort with the task it was derived from? */
function inCohort(cohort, other) {
  if (!cohort || !other) return false;
  switch (cohort.kind) {
    case 'meeting': return meetingOf(other) === cohort.key.slice('meeting:'.length);
    case 'jira': return Boolean(norm(other.jiraKey));
    case 'source': return norm(other.source) === cohort.key.slice('source:'.length);
    case 'context': return norm(other.context) === cohort.key.slice('context:'.length);
    default: return false;
  }
}

function idOf(t) {
  return t && (t.task_id ?? t.id ?? null);
}

/**
 * "While you're in here" — the other open tasks worth doing alongside this one.
 *
 * @param {object} task  the task he is working on
 * @param {Array}  pool  the open tasks (INCLUDING the one he is on; it is excluded here)
 * @returns {{ cohorts, best, gaps }}
 */
function related(task, pool, opts = {}) {
  const gaps = [];
  if (!task) return { cohorts: [], best: null, gaps: ['no task to compare against'] };
  if (!Array.isArray(pool)) return { cohorts: [], best: null, gaps: ['the open task list could not be read — this is not "there is nothing else"'] };

  const maxFraction = opts.maxFraction ?? MAX_COHORT_FRACTION;
  const maxListed = opts.maxListed ?? MAX_LISTED;
  const maxSize = opts.maxSize ?? MAX_COHORT_SIZE;
  const here = idOf(task);
  const others = pool.filter(t => idOf(t) !== here || here === null);

  const cohorts = [];
  for (const c of cohortsFor(task)) {
    const members = others.filter(o => inCohort(c, o));
    if (!members.length) continue;
    // ⚠ Specificity check against the WHOLE pool, not against the matches: a
    // cohort is uninformative when it covers most of the list, and that is a
    // fact about the pool.
    const share = pool.length ? (members.length + 1) / pool.length : 0;
    if (share > maxFraction || members.length > maxSize) {
      gaps.push(c.label + ' is ' + members.length + ' tasks (' + Math.round(share * 100) + '% of your open list) — that is a category, not something to clear while you are here');
      continue;
    }
    cohorts.push({
      ...c,
      count: members.length,
      share,
      tasks: members.slice(0, maxListed).map(t => ({ id: idOf(t), text: t.text || null })),
      more: Math.max(0, members.length - maxListed),
    });
  }

  return { cohorts, best: cohorts[0] || null, gaps };
}

module.exports = {
  cohortsFor,
  related,
  inCohort,
  meetingOf,
  meetingLabel,
  sourceLabel,
  contextLabel,
  MAX_COHORT_FRACTION,
  MAX_COHORT_SIZE,
  MAX_LISTED,
  NOT_A_COHORT,
};
