'use strict';

// "While you're in here." (12 Sep 2026)
//
// Joins the two halves: `current-work` says what he is on, `task-cohort` says
// what else shares its provenance. This file is the only thing that reads the
// database for either, so both stay pure and pin without one.
//
// Nick's opening ask, in his words: *"if I'm working in a particular type of
// task, find more that are in the same category — eg if I'm working on a Jira
// ticket/complaint, are there any more Jira tickets while I'm there."* The
// value is batching: loading the context is the expensive part, and a second
// task in a context already loaded is nearly free.
//
// ⚠ IT SUGGESTS AND CHANGES NOTHING. No reordering, no starting, no writing.
//   `rankTasks` stays the one place order is decided — being in a cohort is not
//   a reason to move work up the list, and letting it would turn this into the
//   quick-wins list the codebase already refuses to become.
//
// ⚠ THE LAPTOP BRANCH YIELDS NO COHORT, BY CONSTRUCTION. `current-work` returns
//   `taskIds: []` when the only evidence is the foreground app, so there is
//   nothing to match on and this correctly offers nothing. That is not a gap to
//   be filled later by guessing from the app name — "he is in Outlook, so show
//   him the email tasks" is exactly the confident wrong answer the resolver
//   refuses to produce.
//
// ⚠ A BLOCK HOLDS MANY TASKS, so cohorts are computed for EACH and merged by
//   key, strongest kept. Taking only the first task's cohort would make the
//   answer depend on the order rows came back in.

const cohort = require('./task-cohort');
const taskLinks = require('../../shared/task-links.cjs');
const currentWork = require('./current-work');

/** Open tasks in the shape `task-cohort` reads, with Jira keys folded in. */
function openPool() {
  const db = require('../db/database');
  const rows = db.listTaskRows({ includeDone: false });
  // ⚠ `listTaskRows` IGNORES `includeDone` when status is 'all' (documented
  // trap that has already put done rows into a live pool once). No status is
  // passed here, so the default open/in-progress clause applies — but filter
  // anyway rather than trusting it, because a `done` task offered as "more like
  // this" is work he has already finished.
  const open = rows.filter(r => r.status === 'open' || r.status === 'in-progress');

  let keys = {};
  try {
    keys = require('./jira-tasks').keysByTaskId();
  } catch {
    // A missing ledger costs the Jira cohort and nothing else.
    keys = {};
  }

  return open.map(r => ({
    task_id: r.id,
    text: r.text,
    source: r.source,
    context: r.context,
    domain: r.domain,
    origin_path: r.origin_path,
    jiraKey: keys[r.id] || null,
  }));
}

/**
 * @returns {{ working, cohorts, best, gaps }}
 *   `working` is `current-work`'s answer, verbatim, so a surface can say what
 *   it is basing the suggestion on rather than presenting it as a fact from
 *   nowhere.
 */
function whileHere({ now = new Date() } = {}) {
  const gaps = [];
  let working;
  try {
    working = currentWork.current(now);
  } catch (e) {
    return { working: null, cohorts: [], best: null, gaps: ['could not tell what you are working on: ' + e.message] };
  }

  if (!working.taskIds.length) {
    // Not a gap: it is the correct answer for "at the laptop" and for "nothing
    // running". `working.why` already says which.
    return { working, cohorts: [], best: null, gaps };
  }

  let pool;
  try {
    pool = openPool();
  } catch (e) {
    // ⚠ Unreadable pool is a NAMED gap, never an empty suggestion list — "there
    // is nothing else like this" and "I could not look" license opposite moves.
    return { working, cohorts: [], best: null, gaps: ['could not read your open tasks: ' + e.message] };
  }

  const byId = new Map(pool.map(t => [t.task_id, t]));
  const merged = new Map();
  for (const id of working.taskIds) {
    const task = byId.get(id);
    if (!task) continue;
    const r = cohort.related(task, pool);
    for (const g of r.gaps) if (!gaps.includes(g)) gaps.push(g);
    for (const c of r.cohorts) {
      const existing = merged.get(c.key);
      // Keep the stronger (lower rank) sighting of the same cohort.
      if (!existing || c.strength < existing.strength) merged.set(c.key, { ...c, forTaskId: id });
    }
  }

  const cohorts = [...merged.values()].sort((a, b) => a.strength - b.strength || a.count - b.count);

  // ⚠ Links are attached UNFILTERED, carrying their `desktopOnly` flag, and the
  // CLIENT decides what to show. Whether `obsidian://` can be opened is a fact
  // about the surface doing the rendering — the desktop app runs in a browser on
  // the machine with Obsidian on it, the phone does not — and the server cannot
  // know which one is asking. Filtering here would either hide the note link on
  // the desktop or offer a dead one on the phone.
  const opts = { jiraBaseUrl: process.env.JIRA_BASE_URL || null };
  if (process.env.OBSIDIAN_VAULT_NAME) opts.vaultName = process.env.OBSIDIAN_VAULT_NAME;
  for (const c of cohorts) {
    for (const t of c.tasks) {
      const row = byId.get(t.id);
      const { links, refused } = taskLinks.linksFor(row, opts);
      t.links = links;
      // Named rather than dropped: "this came from an email and cannot be
      // linked" is worth saying, and is not the same as having no provenance.
      if (refused.length) t.noLink = refused[0].why;
    }
  }

  return { working, cohorts, best: cohorts[0] || null, gaps };
}

module.exports = { whileHere, openPool };
