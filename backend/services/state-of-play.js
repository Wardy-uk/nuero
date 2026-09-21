'use strict';

/**
 * State of play — the one screen that answers "what shape is everything in?".
 *
 * NEURO had plenty of surfaces that each answer a slice (Tasks, Actions, People,
 * Pi Health) and nothing that answers the whole. The gap that motivated this: the
 * Jira cache had been stale since 3 July and nothing anywhere said so, because
 * every existing panel either reads the cache happily or doesn't read it at all.
 * A staleness only shows up when something is looking for it.
 *
 * Split like pi-health, and for the same reason: `snapshot()` reads, `assess()`
 * judges. The judgement is the part worth pinning in a test, and it must not need
 * a database to run — so it takes a snapshot object and returns a ranked list.
 *
 * Read-only throughout. This panel must never be the reason something changed.
 */

const db = require('../db/database');

// Watchdog's own thresholds, deliberately reused rather than re-picked — two
// different numbers for "this job has stopped" is how you get a dashboard that
// disagrees with the alert that woke you up.
const DAILY_STALE_DAYS = 3;
const WEEKLY_STALE_DAYS = 10;

// The jobs scheduler.js stamps. Listed here rather than derived, because the
// point is to notice one that has stopped stamping entirely — deriving the list
// from what exists in agent_state would make a vanished job invisible by
// construction, which is exactly the failure being watched for.
const TRACKED_JOBS = [
  { name: 'nightly-sweep', cadence: 'daily' },
  { name: 'nightly-rollup', cadence: 'daily' },
  { name: 'embeddings-rebuild', cadence: 'daily' },
  { name: 'weekly-review', cadence: 'weekly' },
  { name: 'weekly-hygiene', cadence: 'weekly' },
  { name: 'knowledge-reflection', cadence: 'weekly' },
  // Unlike bank-holidays — deliberately untracked because a missed week is
  // harmless — a missed weekly risk report is a missed PIP deliverable with a
  // named recipient and a midday deadline. This is the case the board exists for.
  { name: 'weekly-risk-report', cadence: 'weekly' },
];

// Local, not UTC. The Pi may run in UTC and a date built with toISOString()
// flips a day early every evening — the same trap the calendar code documents.
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Whole days between an ISO-ish timestamp and now. null when unparseable. */
function daysSince(value) {
  if (!value) return null;
  const t = Date.parse(String(value).replace(' ', 'T'));
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

function rows(sql, params) {
  try { return db.all(sql, params) || []; } catch { return []; }
}
function scalar(sql, params, field = 'c') {
  try { return db.get(sql, params)?.[field] ?? 0; } catch { return 0; }
}

/** Turn [{k,c}] into {k: c} so the frontend doesn't have to hunt through arrays. */
function tally(list, key, count = 'c') {
  const out = {};
  for (const r of list) out[r[key]] = r[count];
  return out;
}

/**
 * The date keys of the last `count` days ending on `today`, oldest first. PURE.
 *
 * The strip is a CALENDAR window, not "whatever rows exist". Rendering only the
 * rows that happen to be in `daily_summary` is what made a missing day invisible
 * rather than visibly missing — the same shape as reading an unread domain as a
 * zero, in the one panel built to catch exactly that.
 */
function lastDays(today, count) {
  const out = [];
  const [y, m, d] = String(today).split('-').map(Number);
  for (let i = count - 1; i >= 0; i -= 1) {
    // Constructed as a LOCAL date and formatted with local getters — never
    // toISOString(), which flips the day early every evening under BST.
    const dt = new Date(y, m - 1, d - i);
    out.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`);
  }
  return out;
}

/**
 * One cell per day, from the rollup where it exists and from the log where it
 * does not. PURE — the rule is the product, so it pins without a database.
 *
 * Three states per day, and keeping them apart is the whole point:
 *   * done      — the ritual happened;
 *   * not done  — we can see the day and nothing was logged;
 *   * unknown   — the day is outside what `activity_log` covers at all, so
 *                 nothing here may be read as a skipped ritual.
 *
 * ⚠ The denominator counts KNOWN days only. Counting an unknown day as a miss
 * would make a fresh install, or a pruned log, read as a man who stopped doing
 * his standups.
 */
function foldRituals({ dateKeys, rolled = [], live = [], logFrom = null }) {
  const byKey = new Map();
  for (const r of rolled) byKey.set(r.date_key, r);

  const liveByKey = new Map();
  for (const r of live) {
    const entry = liveByKey.get(r.date_key) || { standup: 0, eod: 0, captures: 0 };
    if (r.event_type === 'standup_done') entry.standup += r.c;
    else if (r.event_type === 'eod_done') entry.eod += r.c;
    else if (r.event_type === 'capture') entry.captures += r.c;
    liveByKey.set(r.date_key, entry);
  }

  const days = dateKeys.map((date_key) => {
    const row = byKey.get(date_key);
    if (row) {
      return {
        date_key,
        standup_done: row.standup_done ? 1 : 0,
        eod_done: row.eod_done ? 1 : 0,
        captures_count: row.captures_count || 0,
        // Rolled up: this is the stored answer, not one derived on the fly.
        rolled: true,
        known: true,
      };
    }
    const l = liveByKey.get(date_key);
    const known = !logFrom || date_key >= logFrom;
    return {
      date_key,
      // ⚠ null, never 0, when the day is outside the log — "I could not look"
      // and "he did not do it" are opposite facts and only one is a judgement.
      standup_done: known ? (l && l.standup ? 1 : 0) : null,
      eod_done: known ? (l && l.eod ? 1 : 0) : null,
      captures_count: known ? (l ? l.captures : 0) : null,
      rolled: false,
      known,
    };
  });

  const knownDays = days.filter((d) => d.known);
  return {
    days,
    standupDays: knownDays.filter((d) => d.standup_done).length,
    eodDays: knownDays.filter((d) => d.eod_done).length,
    window: knownDays.length,
    // Days the strip is showing from the log because the 22:00 rollup has not
    // reached them yet. Surfaced so the panel can say the figures are live
    // rather than silently presenting two different provenances as one.
    pendingRollup: days.filter((d) => d.known && !d.rolled).length,
    unknownDays: days.length - knownDays.length,
  };
}

/**
 * Every task Nick owes, from every source — NEURO's own rows, Microsoft's
 * mirrors and daily-note lines.
 *
 * ⚠⚠ IT GOES THROUGH `parseVaultTodos`, NEVER THE MIRROR FILE, because that is
 * the ONE place the NEURO↔Microsoft link is honoured. `task-dedupe` links a
 * pair so the Microsoft line is suppressed and NEURO's row carries it — measured
 * live, the raw mirror holds SIX dated Planner cards and the merged pool holds
 * FIVE, the missing one being "Succession plan", linked to NEURO #58. Counting
 * the file directly would have double-counted it, silently, on a chart whose
 * whole job is to say how much is due.
 *
 * ⚠⚠ AN UNREADABLE VAULT IS NOT AN EMPTY ONE, and this is the failure this read
 * introduces. `parseVaultTodos` returns `{active: [], done: []}` when the vault
 * is not configured — no throw, no warning — so a Syncthing hiccup or a missing
 * env var would quietly drop every Microsoft task and render a lighter week that
 * looks exactly like a real one. `known` is checked FIRST and travels onto the
 * payload, so the panel says "Microsoft could not be read" rather than showing
 * NEURO's half as though it were the whole.
 *
 * ⚠ Cost: measured on the Pi at 26ms cold, 10ms WARM (`vault-cache` holds it),
 * against a panel that polls every 60 seconds. That is what makes this
 * affordable at all; it is why `snapshot()` was pure SQL before, and the number
 * is written down so the next person can tell whether it still is.
 */
function taskPool(read) {
  const obsidian = read || (() => {
    const ob = require('./obsidian');
    if (!ob.isConfigured()) return { known: false, reason: 'vault not configured' };
    return { known: true, active: ob.parseVaultTodos().active };
  });

  try {
    const out = obsidian();
    if (!out || out.known === false) {
      return { known: false, reason: (out && out.reason) || 'vault unreadable', tasks: [] };
    }
    return { known: true, tasks: Array.isArray(out.active) ? out.active : [] };
  } catch (e) {
    return { known: false, reason: `vault unreadable (${e.message})`, tasks: [] };
  }
}

/**
 * Where a task came from, for the split on the chart. PURE.
 *
 * ⚠ Matched on the `MS ` PREFIX of `source`, which is what `task-dedupe` and
 * `parseVaultTodos` already use (`/^MS /.test(t.source)`) — borrowed rather
 * than re-derived, because a second opinion about what "a Microsoft task" is
 * would eventually disagree with the screen that suppresses its mirror line.
 */
function originOf(task) {
  const src = (task && task.source) || '';
  if (/^MS /.test(src)) return 'microsoft';
  if (/^Daily/.test(src)) return 'note';
  return 'neuro';
}

// The statuses a task can be in and still be OWED. ⚠ `in-progress` is included
// deliberately: `status = 'open'` is a literal column match, so a task Nick has
// actually STARTED was invisible to every figure in this block — which is
// backwards, and is the same trap `task-dedupe`'s pool had. It changes no
// number on the day it shipped (there were zero in-progress tasks), which is
// precisely the safest moment to widen it.
const ACTIVE_STATUSES = "status IN ('open','in-progress')";

/**
 * The next `count` days from `today`, as local date keys. PURE.
 *
 * ⚠ Built by stepping a local Date, never by adding 86.4e6 to a timestamp —
 * the day BST ends is 25 hours long and an arithmetic step lands at 23:00 the
 * previous day, silently duplicating a column and dropping another.
 */
function nextDays(today, count) {
  const [y, m, d] = String(today).split('-').map(Number);
  const out = [];
  for (let i = 0; i < count; i++) {
    const dt = new Date(y, m - 1, d + i);
    out.push({
      key: `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`,
      dow: dt.getDay(),
      weekend: dt.getDay() === 0 || dt.getDay() === 6,
      isToday: i === 0,
    });
  }
  return out;
}

/** The three origins a task can have, in the order they stack. */
const ORIGINS = ['neuro', 'microsoft', 'note'];

/**
 * How much is due on each of the next seven days, from EVERY source.
 *
 * ⚠ A ZERO HERE IS A REAL ZERO. Unlike the usage heatmap there is no
 * un-instrumented state — the pool knows every due date it holds — so a quiet
 * Saturday is a fact and is drawn as one. The one thing that is NOT a real zero
 * is a pool that could not be read, and that never reaches this function:
 * `taskPool` reports it and the panel renders the gap instead.
 *
 * ⚠⚠ WHAT IT CANNOT SHOW MUST TRAVEL WITH IT, or a light-looking week is a lie
 * by omission. Two things have no bar and both ride on the payload: work
 * ALREADY OVERDUE (it had a day and the day has gone) and work with NO DUE DATE
 * AT ALL. On the live store that is 7 undated against 55 open, so a week showing
 * 16 bars is not a week holding 16 jobs.
 *
 * ⚠ The split is carried PER DAY, not just as a total — "4 due Thursday, one of
 * them a Planner card someone else owns" is a different Thursday from four of
 * his own, and a stacked bar is the only place that fact fits.
 */
/** Count a list of tasks by where they came from. PURE. */
function tallyOrigins(list) {
  const out = { neuro: 0, microsoft: 0, note: 0 };
  for (const t of list) out[originOf(t)]++;
  return out;
}

function dueAhead(today, pool, days = 7) {
  const span = nextDays(today, days);
  const index = new Map(span.map((d, i) => [d.key, i]));

  const buckets = span.map(d => ({
    ...d,
    count: 0,
    by: { neuro: 0, microsoft: 0, note: 0 },
  }));

  for (const t of pool) {
    const due = t && t.due_date;
    if (!due) continue;
    const i = index.get(due);
    if (i === undefined) continue;
    buckets[i].count++;
    buckets[i].by[originOf(t)]++;
  }

  const byOrigin = { neuro: 0, microsoft: 0, note: 0 };
  for (const b of buckets) for (const o of ORIGINS) byOrigin[o] += b.by[o];

  return {
    days: buckets,
    origins: ORIGINS,
    byOrigin,
    total: buckets.reduce((n, b) => n + b.count, 0),
    busiest: buckets.reduce((m, b) => Math.max(m, b.count), 0),
    from: span[0].key,
    to: span[span.length - 1].key,
  };
}

/**
 * The newest knowledge reflection, and whether Insights has been opened since.
 *
 * ⚠ WHY THIS IS ON THIS PANEL AT ALL. Until 21 Sep 2026 a reflection's ENTIRE
 * reach was one web push. Its only other references were the vault write, this
 * file's TRACKED_JOBS entry (which notices the job STOPPING, never that a new
 * one is ready) and SAiM's tab routing. It is not a nudge type and raises no
 * action card — so on the morning both registered push endpoints turned out to
 * be the iPhone, the reflection was written, announced to a device Nick was not
 * holding, and invisible on the machine he was sitting at. A weekly artefact
 * whose only announcement is a single push to one device is one that does not
 * get read: zero notes have ever been promoted.
 *
 * ⚠ IT READS A STAMP, NOT THE VAULT. `generateReflection` records the write in
 * `agent_state`, so this costs one KV read and keeps `snapshot()` off the disk —
 * and, more to the point, the panel stays truthful when the vault is unreachable
 * instead of reporting "no reflection" at a Syncthing hiccup. mtime is no use
 * here for the reason `recentReflections` already documents: these are replicas.
 *
 * ⚠ `announcedAt: null` is NOT a gap and must not be reported as one. It means
 * nothing has been written since the stamp existed, which is the correct and
 * uninteresting state on a fresh install and for the first week after this
 * shipped.
 *
 * ⚠ The "seen" test is EXACTLY what it measures — Insights opened after the
 * reflection was written — and the wording downstream says that rather than
 * claiming he read it. Opening a panel is not reading a note, and this is the
 * closest honest proxy available without asking him to press a button, which is
 * friction on the one feature whose whole problem is that it gets skipped.
 */
function knowledgeReflection() {
  let stamp = null;
  try {
    const raw = db.getState('knowledge_reflection_last');
    if (raw) stamp = JSON.parse(raw);
  } catch {
    // An unreadable or malformed stamp is not a reflection that failed to
    // exist. Fall through to the null shape: this panel says nothing rather
    // than inventing either an alarm or an all-clear.
    stamp = null;
  }
  if (!stamp || !stamp.at || Number.isNaN(Date.parse(stamp.at))) {
    return { announcedAt: null, path: null, name: null, lastOpenedAt: null };
  }

  // A day early: `date_key` is UTC-stamped while `hour` is local, so a bound set
  // to the exact day can drop a genuine open made either side of midnight. It is
  // an index filter, and the timestamp comparison below is the real answer.
  const from = new Date(Date.parse(stamp.at) - 36 * 3600 * 1000)
    .toISOString().slice(0, 10);
  let lastOpenedAt = null;
  try {
    lastOpenedAt = db.getLastTabOpenAt('insights', from);
  } catch {
    lastOpenedAt = null;
  }

  return {
    announcedAt: stamp.at,
    path: stamp.path || null,
    name: stamp.name || null,
    lastOpenedAt,
  };
}

function snapshot(opts = {}) {
  const today = todayLocal();

  // ⚠ The DUE-DATE family counts EVERY task Nick owes — NEURO's rows,
  // Microsoft's cards and daily-note lines — because "what is due on Thursday"
  // is a question about his week, not about one table. The TRIAGE family below
  // (MoSCoW, priority, estimates, context, source) stays NEURO-only, because
  // Microsoft has no such fields and folding 9 of them into `unset` would
  // report a triage backlog that does not exist. The cards say which is which.
  const pool = taskPool(opts.readTasks);
  const active = pool.tasks;
  const openTasks = pool.known
    ? active.length
    : scalar(`SELECT COUNT(*) c FROM tasks WHERE ${ACTIVE_STATUSES}`);
  const tasks = {
    open: openTasks,
    done: scalar("SELECT COUNT(*) c FROM tasks WHERE status='done'"),
    moscow: tally(rows(`SELECT COALESCE(moscow,'unset') k, COUNT(*) c FROM tasks WHERE ${ACTIVE_STATUSES} GROUP BY k`), 'k'),
    // priority is 1-3 with NULL meaning never triaged; 0 is the unset bucket.
    unprioritised: scalar(`SELECT COUNT(*) c FROM tasks WHERE ${ACTIVE_STATUSES} AND priority IS NULL`),
    estimated: scalar(`SELECT COUNT(*) c FROM tasks WHERE ${ACTIVE_STATUSES} AND estimate_minutes IS NOT NULL`),
    overdue: pool.known
      ? active.filter(t => t.due_date && t.due_date < today).length
      : scalar(`SELECT COUNT(*) c FROM tasks WHERE ${ACTIVE_STATUSES} AND due_date IS NOT NULL AND due_date < ?`, [today]),
    dueToday: pool.known
      ? active.filter(t => t.due_date === today).length
      : scalar(`SELECT COUNT(*) c FROM tasks WHERE ${ACTIVE_STATUSES} AND due_date = ?`, [today]),
    noDueDate: pool.known
      ? active.filter(t => !t.due_date).length
      : scalar(`SELECT COUNT(*) c FROM tasks WHERE ${ACTIVE_STATUSES} AND due_date IS NULL`),
    byContext: rows(`SELECT COALESCE(context,'none') k, COUNT(*) c FROM tasks WHERE ${ACTIVE_STATUSES} GROUP BY k ORDER BY c DESC`),
    bySource: rows(`SELECT COALESCE(source,'unknown') k, COUNT(*) c FROM tasks WHERE ${ACTIVE_STATUSES} GROUP BY k ORDER BY c DESC LIMIT 6`),
    // The week ahead, for the chart at the top of the panel.
    // ⚠ `poolKnown` is what stops an unreadable vault rendering as a light
    // week. It is NOT the same as an empty pool, and the panel must say so.
    poolKnown: pool.known,
    poolReason: pool.known ? null : pool.reason,
    overdueByOrigin: pool.known ? tallyOrigins(active.filter(t => t.due_date && t.due_date < today)) : null,
    dueAhead: dueAhead(today, active),
  };

  const commitments = {
    open: scalar("SELECT COUNT(*) c FROM waiting_on WHERE status='open'"),
    people: scalar("SELECT COUNT(DISTINCT person) c FROM waiting_on WHERE status='open'"),
    top: rows(`SELECT person, COUNT(*) c, MIN(source_date) oldest
               FROM waiting_on WHERE status='open'
               GROUP BY person ORDER BY c DESC LIMIT 8`)
      .map(r => ({ person: r.person, count: r.c, oldest: r.oldest, ageDays: daysSince(r.oldest) })),
  };

  // What counts as outbound is action-presenter's call, never a list of type
  // names kept here. The first cut hardcoded one and got it wrong immediately:
  // `draft_reply` LOOKS outbound and is classified `write`, because approving it
  // sends nothing — it drafts the words and queues a separate reply_email for a
  // second approval. A dashboard claiming two things would leave the building
  // while the Actions panel says one is worse than no dashboard.
  //
  // getPendingSaimActions defaults to limit 10; passing a real bound matters,
  // since this queue has been 930 deep inside the last week.
  let pendingKinds = {};
  let pendingActions = [];
  try {
    const presenter = require('./action-presenter');
    pendingActions = db.getPendingSaimActions(2000) || [];
    for (const a of pendingActions) {
      const kind = presenter.describe(a)?.kind || 'unknown';
      pendingKinds[kind] = (pendingKinds[kind] || 0) + 1;
    }
  } catch { pendingKinds = {}; }

  const approvals = {
    pending: scalar("SELECT COUNT(*) c FROM saim_actions WHERE status='pending'"),
    pendingByType: tally(rows("SELECT type k, COUNT(*) c FROM saim_actions WHERE status='pending' GROUP BY k"), 'k'),
    pendingByKind: pendingKinds,
    outbound: pendingKinds.outbound || 0,
    lifetime: tally(rows("SELECT status k, COUNT(*) c FROM saim_actions GROUP BY k"), 'k'),
    recent: rows(`SELECT date(created_at) d, COUNT(*) c FROM saim_actions
                  WHERE created_at >= date('now','-13 day') GROUP BY d ORDER BY d`),
  };

  // ⚠ THIS READ WAS DEAD, AND THE PANEL RENDERED IT AS A FACT. It counted
  // `inbox_items`, the table whose writer (`inbox-scanner.js`) was DELETED on
  // 26 Aug 2026 when the two competing inbox triages were consolidated into one.
  // That cleanup removed the scanner's six `db` helpers — but this queried the
  // table with RAW SQL, so removing the helpers never touched it. The result was
  // a permanent `{open: 0, byUrgency: {}}` shown as "Inbox 0 · 0 high" at the top
  // of the sidebar, on the panel that exists BECAUSE "the Jira cache had been
  // stale since 3 July and nothing anywhere said so".
  //
  // It read 0 on the day it was found because there genuinely were no urgent
  // emails. It would have read 0 with thirty-seven.
  //
  // ⚠ `getUrgentEmails()` is THE ONE PREDICATE (`lane === 'urgent' &&
  // !dismissed`), asked for rather than re-derived here — the same rule that
  // keeps the panel, the nudge and the Inbox screen agreeing on what "urgent"
  // means. Re-implementing the filter is how the count on this panel comes to
  // disagree with the heading on that one.
  //
  // ⚠ AND AN UNREADABLE TRIAGE IS `null`, NEVER 0 — this panel's own rule, in
  // its own words: "null, never 0 ... I could not look". A zero here is a
  // positive claim that the inbox is clear, which is the most reassuring thing
  // this surface can say wrongly.
  let inbox;
  try {
    const urgent = require('./email-triage').getUrgentEmails();
    const byUrgency = {};
    for (const e of urgent) {
      const k = e.urgency || 'unknown';
      byUrgency[k] = (byUrgency[k] || 0) + 1;
    }
    inbox = { open: urgent.length, byUrgency, known: true };
  } catch (e) {
    inbox = { open: null, byUrgency: {}, known: false, why: e.message };
  }

  // 21 days is three weeks of habit — long enough to show a pattern, short
  // enough to fit a row of cells without scrolling on a phone.
  //
  // ⚠ `daily_summary` alone CANNOT answer this, and reading it alone was a lie
  // the panel told every day. `runNightlyRollup()` fires at 22:00 and builds the
  // summary for YESTERDAY, so a day's row does not exist until 22:00 the day
  // after it — the strip lagged by up to 46 hours and today's standup could
  // never appear however early it was done. Found 7 Sep 2026: `activity_log`
  // held `standup_done` at 07:54 that morning and the newest `daily_summary` row
  // was 5 Sep, so Rituals showed a gap where a completed ritual was.
  //
  // The un-rolled days are therefore filled from `activity_log` — deliberately
  // the SAME source `buildDailySummary()` reads, not a second derivation. This
  // is the rollup's own answer computed early, never a second opinion about it.
  const ritualRows = rows(`SELECT date_key, standup_done, eod_done, captures_count
                           FROM daily_summary ORDER BY date_key DESC LIMIT 21`);
  const dateKeys = lastDays(today, 21);
  const live = rows(
    `SELECT date_key, event_type, COUNT(*) c FROM activity_log
      WHERE date_key >= ? AND date_key <= ? GROUP BY date_key, event_type`,
    [dateKeys[0], today]
  );
  // How far back the log itself reaches. A window day earlier than this is
  // UNKNOWN, not a skipped ritual — absence of a log is not evidence of absence.
  const logFrom = db.get('SELECT MIN(date_key) m FROM activity_log')?.m || null;
  const rituals = foldRituals({ dateKeys, rolled: ritualRows, live, logFrom });

  const lastEmbed = db.get("SELECT MAX(embedded_at) m FROM vault_embeddings")?.m || null;
  const vault = {
    chunks: scalar("SELECT COUNT(*) c FROM vault_embeddings"),
    files: scalar("SELECT COUNT(DISTINCT relative_path) c FROM vault_embeddings"),
    entities: scalar("SELECT COUNT(*) c FROM extracted_entities"),
    links: scalar("SELECT COUNT(*) c FROM note_links"),
    lastEmbedAt: lastEmbed,
    lastEmbedDays: daysSince(lastEmbed),
  };

  const stamped = tally(
    rows("SELECT key k, value c FROM agent_state WHERE key LIKE 'scheduler_last_run:%'"), 'k'
  );
  const jobs = TRACKED_JOBS.map(job => {
    const lastRun = stamped[`scheduler_last_run:${job.name}`] || null;
    const age = daysSince(lastRun);
    const limit = job.cadence === 'daily' ? DAILY_STALE_DAYS : WEEKLY_STALE_DAYS;
    return {
      ...job,
      lastRun,
      ageDays: age,
      // Never stamped is its own state, not "very stale" — a job that has never
      // run may simply have been added since the last deploy.
      state: lastRun === null ? 'never' : (age > limit ? 'stale' : 'ok'),
    };
  });

  const calendar = {
    upcoming: rows(`SELECT subject, start_time, show_as FROM calendar_cache
                    WHERE start_time >= datetime('now') ORDER BY start_time LIMIT 5`),
    cached: scalar("SELECT COUNT(*) c FROM calendar_cache"),
  };

  // Completions Microsoft would not take. Read-only, and never allowed to break
  // the board: an unreadable queue reports zeroes rather than 500ing the panel.
  let msPush = { pending: 0, failed: 0, oldestHours: null };
  try {
    const q = require('./ms-push-queue').status();
    msPush = {
      pending: q.pendingCount,
      failed: q.failedCount,
      oldestHours: q.pending.reduce((m, i) => Math.max(m, i.ageHours || 0), 0) || null,
    };
  } catch { /* zeroes */ }

  return {
    generatedAt: new Date().toISOString(),
    tasks, commitments, approvals, inbox, rituals, vault, jobs, calendar, msPush,
    knowledge: knowledgeReflection(),
  };
}

/**
 * Rank what is actually wrong. Ordered worst-first; the panel renders the top of
 * this list as its focus band, so the ordering IS the product.
 *
 * Severity: critical (something is broken or silently lying) > warn (drifting)
 * > info (worth knowing, not wrong).
 */
/**
 * SQLite's CURRENT_TIMESTAMP is `YYYY-MM-DD HH:MM:SS` in UTC with no zone on it,
 * so `Date.parse` reads it as LOCAL and lands an hour out through BST — the bug
 * the calendar has already paid for twice. Tolerates a value that already
 * carries a zone, because appending a second `Z` turns a good timestamp into
 * NaN, and NaN here reads as "never opened" and relights the card.
 */
function _sqliteUtc(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  const iso = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(raw)
    ? raw.replace(' ', 'T')
    : `${raw.replace(' ', 'T')}Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

// Reflections are weekly, so a week is exactly how long one can still be the
// newest thing there is. Past that the next one has superseded it.
const REFLECTION_FRESH_DAYS = 7;

function assess(s) {
  const issues = [];
  const add = (severity, title, detail, view) => issues.push({ severity, title, detail, view });

  // The Jira queue card is gone (27 Aug 2026). It reported a cache with no
  // writer — the queue feature was deleted on 3 July and readers were later
  // reintroduced against the rows it left behind. Both halves are now finished:
  // the readers were removed with the cache, so there is no longer a decision
  // outstanding for this panel to chase. Escalations were never part of it and
  // remain live. See db/database.js.

  for (const job of s.jobs) {
    if (job.state === 'stale') {
      add('critical', `${job.name} has stopped`,
        `Last ran ${job.ageDays} days ago (${job.cadence}).`, 'admin');
    } else if (job.state === 'never') {
      // Deliberately info, not warn. Stamping arrived with the catch-up work, so
      // a job whose slot has not come round since that deploy has no stamp and is
      // not faulty — embeddings-rebuild read "never run" on day one while it was
      // demonstrably mid-rebuild. Unknown is not the same as broken, and a board
      // that opens with two false warnings is one nobody reads by week two.
      add('info', `${job.name} has no last-run stamp yet`,
        'Not yet seen since run-tracking was added — it becomes meaningful once its slot has passed once.', 'admin');
    }
  }

  // A task Nick ticked that Microsoft never accepted. `failed` is CRITICAL and
  // outranks a merely pending one: the retrying has stopped, so the task is
  // about to reappear in the mirror as open — work he believes is done, handed
  // back with no explanation unless this says so.
  const ms = s.msPush || {};
  if (ms.failed > 0) {
    add('critical', `${ms.failed} completion${ms.failed === 1 ? '' : 's'} never reached Microsoft`,
      'NEURO has stopped retrying, so these tasks will reappear as open. Reconnect 365, then drain the queue.', 'todos');
  }
  if (ms.pending > 0) {
    add('warn', `${ms.pending} completion${ms.pending === 1 ? ' is' : 's are'} held for Microsoft`,
      `Ticked here, not yet accepted by Graph${ms.oldestHours ? ` (oldest ${ms.oldestHours}h)` : ''}. Retrying every 10 minutes.`, 'todos');
  }

  if (s.approvals.pending > 0) {
    const outbound = s.approvals.outbound || 0;
    add(outbound > 0 ? 'warn' : 'info',
      `${s.approvals.pending} action${s.approvals.pending === 1 ? '' : 's'} awaiting approval`,
      outbound > 0
        ? `${outbound} would send something to a real person (email or Teams). The rest are internal.`
        : 'All internal — nothing here sends anything.',
      'actions');
  }

  if (s.tasks.overdue > 0) {
    add('warn', `${s.tasks.overdue} tasks overdue`,
      'Past their due date and still open.', 'todos');
  }

  // Coverage gaps. These are the fields that make ranking and time-fit work, so
  // an empty one silently degrades those features rather than breaking them.
  if (s.tasks.open > 0 && s.tasks.estimated === 0) {
    add('warn', 'No task has a time estimate',
      `All ${s.tasks.open} open tasks fall back to the assumed 30 minutes, so "what fits" is guessing.`,
      'todos');
  }
  if (s.tasks.open > 0 && s.tasks.noDueDate / s.tasks.open > 0.8) {
    add('info', `${s.tasks.noDueDate} of ${s.tasks.open} tasks have no due date`,
      'Nothing to sort them by but MoSCoW.', 'todos');
  }

  if (s.commitments.open > 0) {
    const worst = s.commitments.top[0];
    add(s.commitments.open > 100 ? 'warn' : 'info',
      `${s.commitments.open} commitments owed to you`,
      worst
        ? `Across ${s.commitments.people} people. Worst: ${worst.person} (${worst.count}, oldest ${worst.ageDays} days).`
        : `Across ${s.commitments.people} people.`,
      'people');
  }

  if (s.rituals.window > 0 && s.rituals.standupDays <= 1) {
    add('info', `Standup logged ${s.rituals.standupDays} day${s.rituals.standupDays === 1 ? '' : 's'} in ${s.rituals.window}`,
      'The accountability chain reads yesterday\'s note, so it has little to work from.', 'standup');
  }

  // A knowledge reflection Nick has not been back to. `view: 'insights'` is what
  // makes this ACTIONABLE — the focus band renders every issue as a button on to
  // its view, so the card opens the page the reflection is on rather than merely
  // announcing that one exists somewhere.
  //
  // ⚠ IT AGES OUT ON ITS OWN, and that bound is not optional. Reflections are
  // WEEKLY, so anything older than REFLECTION_FRESH_DAYS has already been
  // superseded by the next one and is no longer news. Without it this becomes a
  // line that is permanently lit — which is the failure this codebase has paid
  // for twice already (seven weeks of "partly live" over a healthy read, and the
  // always-on swap warning over a Pi that was working correctly). A warning that
  // is always on is one nobody reads, and it costs the real one.
  //
  // ⚠ INFO, NEVER WARN. Nothing is wrong. The focus band's own subtitle is
  // "worth knowing about", not "worth worrying about", and promoting this would
  // put a routine weekly artefact above a completion Microsoft rejected.
  //
  // ⚠ IT SAYS "not opened since", NEVER "unread". What is measured is whether
  // the Insights tab has been opened since the note was written; whether he read
  // it is not observable and must not be claimed. Pinned by a forbidden-wording
  // test, because the plausible tidy-up here is to shorten it to "unread".
  const k = s.knowledge;
  if (k && k.announcedAt) {
    const written = Date.parse(k.announcedAt);
    const ageDays = Math.floor((Date.parse(s.generatedAt) - written) / 86400000);
    const opened = _sqliteUtc(k.lastOpenedAt);
    const seen = opened != null && opened > written;
    // ⚠ A snapshot with no `generatedAt` cannot be aged, so it raises nothing —
    // and NaN comparisons are false in both directions, which would make that a
    // SILENT no-op. Stated here so it reads as a decision rather than an
    // accident of arithmetic.
    if (!seen && Number.isFinite(ageDays) && ageDays >= 0 && ageDays <= REFLECTION_FRESH_DAYS) {
      add('info', 'New knowledge reflection',
        `${k.name || 'This week’s reflection'} was written ${ageDays === 0 ? 'today' : `${ageDays} day${ageDays === 1 ? '' : 's'} ago`} and you have not opened Insights since.`,
        'insights');
    }
  }

  const severityRank = { critical: 0, warn: 1, info: 2 };
  return issues.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
}

/** Worst severity present, for the header band. */
function overall(issues) {
  if (issues.some(i => i.severity === 'critical')) return 'critical';
  if (issues.some(i => i.severity === 'warn')) return 'warn';
  return 'ok';
}

module.exports = {
  // PURE, exported so the week ahead pins without a database.
  nextDays,
  taskPool,
  dueAhead,
  originOf,
  tallyOrigins, snapshot, assess, overall, TRACKED_JOBS, foldRituals, _internals: { daysSince, todayLocal, lastDays, _sqliteUtc } };
