'use strict';

// What is Nick working on, right now? (12 Sep 2026)
//
// The prerequisite for everything that adapts to the work rather than to the
// clock — the cohort panel ("more like this while you're here"), and later a
// launch button for the software a task needs. Nothing downstream can be honest
// without a single, stated answer to this question.
//
// `resolve()` is PURE: it takes the three readings and `now`, and returns one
// answer with its confidence and its reason. The stateful `current()` below
// just fetches the three and calls it.
//
// ⚠ THREE SOURCES, AND THEY ARE NOT THE SAME KIND OF FACT. That is the whole
//   design, and conflating them is the failure this file exists to prevent:
//
//     session  He PRESSED START on a named thing. A statement of intent, by
//              him, about a specific task. Highest confidence there is.
//     block    A window in his diary holding named tasks, live right now. He
//              PLANNED this, which is weaker than doing it — the block runs
//              whether or not he turned up.
//     app      The foreground process on the laptop. Real, current, and it
//              names a PROGRAM, never a task.
//
// ⚠ THE APP CAN NEVER YIELD A TASK. `task` stays null on that branch, always.
//   "VS Code is in the foreground" supports "he is coding" and supports nothing
//   whatever about WHICH of the 93 open tasks he is on. Promoting it would put
//   a confident wrong task name in front of him, and everything downstream —
//   a cohort, a launch button — would then be about the wrong work. The desktop
//   agent deliberately reports only a sanitised process name, so there is not
//   even a window title to be tempted by.
//
// ⚠ A PAUSED SESSION IS NOT CURRENT WORK. He stopped on purpose. It is
//   reported separately as `paused` so a surface can offer to resume, but it
//   must never answer "what is he working on" — suggesting cohort work for a
//   task he deliberately put down is the opposite of helpful.
//
// ⚠ A STALE SESSION IS NOT CURRENT WORK EITHER. `focus-session` already marks
//   a runaway or midnight-crossing session stale and ASKS rather than assuming;
//   treating one as live would have SARA reasoning all morning about a task he
//   abandoned last night.
//
// ⚠ `unknown` IS A FIRST-CLASS ANSWER WITH A REASON, and it is the normal one.
//   "I cannot tell what you are on" and "you are not working on anything" are
//   different facts, and a surface that conflates them either goes silent when
//   it should ask or invents work when it should be quiet.

// Ranked, so a caller can compare rather than re-derive the order.
const CONFIDENCE = { session: 'high', block: 'medium', app: 'low' };

function toMs(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// ⚠ AT THE LAPTOP is a separate fact from WHAT HE IS DOING, and it has to
// travel on every answer. A running focus session wins the `kind`, but he is
// still sitting at the machine — and anything that offers to OPEN something
// there needs to know that, or it queues an intent that expires unclaimed two
// minutes later and looks broken.
function deskFrom(desktop) {
  if (!desktop || desktop.known === false) {
    return { atDesk: false, deskKnown: false, host: null, canOpen: null };
  }
  return {
    atDesk: Boolean(desktop.app),
    deskKnown: true,
    host: desktop.host || null,
    // ⚠ WHAT THAT MACHINE SAID IT CAN OPEN, carried so a surface offers what
    //   this laptop actually has rather than a fixed list. `null` is 'it has
    //   not said' and is NOT an empty list - `desk-intents.offer` keeps the
    //   two apart, because one of them means show nothing and say why.
    canOpen: Array.isArray(desktop.canOpen) ? desktop.canOpen : null,
  };
}

function nothing(why, extra = {}) {
  return {
    known: true,
    kind: null,
    task: null,
    taskIds: [],
    app: null,
    confidence: null,
    source: null,
    why,
    ...extra,
  };
}

/**
 * @param {object} inputs
 *   session  focus-session.current() — or null
 *   blocks   [{ id, taskIds, tasks, startMs, endMs }] windows live NOW
 *   desktop  { app, host, active, known } from desktop-activity
 *   readable { session:bool, blocks:bool, desktop:bool } — what could be READ
 * @param {Date|number} now
 */
function resolve(inputs = {}, now = Date.now()) {
  const nowMs = toMs(now);
  const readable = inputs.readable || {};
  const paused = pausedFrom(inputs.session);
  const desk = deskFrom(inputs.desktop);

  // ⚠ Nothing readable at all is UNKNOWN, not "he is doing nothing".
  const anyRead = readable.session !== false || readable.blocks !== false || readable.desktop !== false;
  if (!anyRead) {
    return {
      known: false, kind: null, task: null, taskIds: [], app: null,
      confidence: null, source: null, paused, ...desk,
      why: 'none of the three sources could be read',
    };
  }

  // 1. An explicit, live focus session.
  const s = inputs.session;
  if (s && s.active && !s.paused && !s.stale) {
    return {
      known: true,
      kind: 'session',
      task: s.text || null,
      taskIds: s.taskId ? [s.taskId] : [],
      app: null,
      confidence: CONFIDENCE.session,
      source: 'focus-session',
      paused,
      ...desk,
      why: 'you started a session on this',
    };
  }

  // 2. A task block whose window is open right now.
  const live = (inputs.blocks || []).filter((b) => {
    const start = toMs(b && b.startMs);
    const end = toMs(b && b.endMs);
    return nowMs !== null && start !== null && end !== null && start <= nowMs && nowMs < end;
  });
  if (live.length) {
    // ⚠ The most recently STARTED window wins when two overlap. Overlapping
    // blocks should not exist (the planner refuses a task already blocked) but
    // a hand-made one can, and picking arbitrarily would be a silent coin toss.
    const block = live.sort((a, b) => toMs(b.startMs) - toMs(a.startMs))[0];
    const ids = Array.isArray(block.taskIds) ? block.taskIds.filter(Boolean) : [];
    return {
      known: true,
      kind: 'block',
      // A block holds MANY tasks, so there is no single one — naming the first
      // would be a guess dressed as a fact.
      task: ids.length === 1 ? (block.tasks && block.tasks[0]) || null : null,
      taskIds: ids,
      app: null,
      confidence: CONFIDENCE.block,
      source: 'task-block',
      paused,
      ...desk,
      why: ids.length === 1
        ? 'this is blocked out in your diary right now'
        : ids.length + ' tasks are blocked out in your diary right now',
    };
  }

  // 3. The laptop. An APP, and never a task.
  const d = inputs.desktop;
  if (d && d.known !== false && d.active && d.app) {
    return {
      known: true,
      kind: 'app',
      // ⚠ Deliberately null. See the header — this branch cannot name a task.
      task: null,
      taskIds: [],
      app: d.app,
      confidence: CONFIDENCE.app,
      source: 'desktop-activity',
      paused,
      ...desk,
      why: 'you are at the laptop in ' + d.app + ' — which says nothing about which task',
    };
  }

  // Nothing positive. Say which kind of nothing.
  if (paused) return nothing('you paused a session and have not picked it back up', { paused, ...desk });
  if (d && d.known === false) return nothing('the laptop has not reported recently, so I cannot tell', { paused, ...desk });
  if (d && d.active === false) return nothing('you are not at the laptop and nothing is running or blocked', { paused, ...desk });
  return nothing('nothing started, nothing blocked, and the laptop is quiet', { paused, ...desk });
}

/** A paused session, reported alongside — never AS — current work. */
function pausedFrom(session) {
  if (!session || !session.active) return null;
  if (!session.paused && !session.stale) return null;
  return { task: session.text || null, taskId: session.taskId || null, stale: Boolean(session.stale) };
}

// --- The stateful read ------------------------------------------------------

/**
 * Fetch the three sources and resolve. Each failure is isolated: one unreadable
 * source must not cost the answer the other two could still give.
 */
function current(now = new Date()) {
  const readable = { session: true, blocks: true, desktop: true };
  let session = null;
  let blocks = [];
  let desktop = null;

  try {
    session = require('./focus-session').current(toMs(now));
  } catch {
    readable.session = false;
  }

  try {
    blocks = liveBlocks(now);
  } catch {
    readable.blocks = false;
  }

  try {
    // ⚠ `run(now)` is the STATEFUL accessor. `runAcross(buckets, now)` is the
    // PURE one and takes the per-host sample buckets FIRST — calling it as
    // `runAcross(now)` passes a Date where the buckets go, which reads as an
    // empty object and answers "the laptop has never reported". That is exactly
    // what shipped on 12 Sep 2026: the agent had 400 samples and a live 14-minute
    // run in Code, and this said it could not tell. Nothing threw, because the
    // wrong answer is a perfectly well-formed one. Nick found it by asking what
    // the screen would show him while he was sitting there coding.
    const da = require('./desktop-activity');
    const r = da.run(now);
    desktop = {
      app: r.app || null,
      host: r.host || null,
      // "At the laptop and using it" is `present().at`, which is exactly
      // `app != null` — there is no `active` field on a run.
      active: r.app != null,
      known: r.known !== false,
      why: r.why || null,
    };
  } catch {
    readable.desktop = false;
  }

  return resolve({ session, blocks, desktop, readable }, now);
}

/** Task blocks whose window contains `now`, in the shape `resolve` expects. */
function liveBlocks(now = new Date()) {
  const tb = require('./task-blocks');
  const out = tb.listOutstanding({ now, includeUpcoming: true });
  if (out && out.error) throw new Error(out.error);
  const rows = (out && out.rows) || [];
  const day = String(now.getFullYear()) + '-'
    + String(now.getMonth() + 1).padStart(2, '0') + '-'
    + String(now.getDate()).padStart(2, '0');
  const blocks = [];
  for (const r of rows) {
    const b = r.block || r;
    if (!b || b.date_key !== day) continue;
    const start = hhmmToMs(day, b.start_time);
    const end = hhmmToMs(day, b.end_time);
    if (start === null || end === null) continue;
    const items = r.tasks || r.items || [];
    blocks.push({
      id: b.id,
      startMs: start,
      endMs: end,
      taskIds: items.map(t => t.task_id ?? t.id).filter(Boolean),
      tasks: items.map(t => t.text).filter(Boolean),
    });
  }
  return blocks;
}

function hhmmToMs(dayStr, hhmm) {
  if (typeof hhmm !== 'string' || !/^\d{1,2}:\d{2}/.test(hhmm)) return null;
  const [h, m] = hhmm.split(':').map(Number);
  const [Y, M, D] = dayStr.split('-').map(Number);
  const d = new Date(Y, M - 1, D, h, m, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

module.exports = { resolve, current, liveBlocks, pausedFrom, deskFrom, CONFIDENCE };
