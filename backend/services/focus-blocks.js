'use strict';

/**
 * Focus blocks — a block in the diary that helps Nick START (1 Nov 2026).
 *
 * WHY. In the 30 days before this, the planner booked 70 blocks: 1 was
 * finished, 59 aged out unused, 10 were dropped. A block with a task fixed at
 * 07:15 is diary clutter by 10:30 — the morning has moved and the task picked
 * for it is rarely still the right one. Nick's difficulty is STARTING, so the
 * block's job is to make the start easy, at the moment it arrives.
 *
 * WHAT CHANGED (every point is Nick's choice):
 *  1. At the block's start SAiM pushes `block_start` and the block leads on Now
 *     and SAiM: "It's 10:30 — your focus block."
 *  2. The planner books the TIME only. The task is picked when the block starts,
 *     from the ranked list at that moment. A block Nick made by hand keeps its
 *     tasks — those are his choice — and its prompt offers them.
 *  3. TWO candidates (plus "something else"). Choosing starts a focus session
 *     and writes the task onto the block and its Outlook event.
 *  4. "Just open it for 2 minutes" — one prompt after two minutes: carry on, or
 *     stop there. Stopping is a START, logged as one, never a failure.
 *  5. Five minutes before, the context for the top two is gathered (pinned
 *     notes, a saved draft, the Jira key, the Microsoft board) and a quiet
 *     "Up next at 10:30" sits on Now. No push for that.
 *  6. A real meeting landing on a not-yet-started block slides it to the next
 *     free slot TODAY, or drops it and says so. A block Nick moved in Outlook
 *     is never moved by NEURO.
 *  7. "Not now" slides it too (or releases it). A task offered and passed over
 *     twice in seven days is next offered with "Is this too big? Make it
 *     smaller".
 *  8. Block length comes from the planner's measured multiplier, and says when
 *     it is still the default. Never written back as a task estimate.
 *  9. While a chosen block runs, ordinary pushes are HELD (focus-hold) and
 *     delivered as one summary at the end.
 * 10. The block clock rides on the attention payload (`focusBlock.clock`) for
 *     every surface, iOS included.
 * 11. Five minutes before the end: "note where you got to" — optional.
 * 12. At the end: Done / More time / Stuck. No answer: the session ends with
 *     the block and NOTHING is completed.
 *
 * THE TIMING ENGINE is `tick()`, a durable runtime job every minute. Each
 * moment is CLAIMED in `focus_block_moments` (INSERT OR IGNORE) before anything
 * is sent, keyed with the time it is about (`start@10:30`, `end@11:15`), so a
 * restart never fires a prompt twice and a moved or extended block re-arms on
 * its own. With no block within reach it is ONE indexed query and returns.
 *
 * ⚠ NOTHING HERE COMPLETES WORK ON ITS OWN. Only "Done" (Nick's press) closes a
 * task, through task-store, so it counts in wins like every other completion.
 * ⚠ NO WORDING ABOUT AVOIDANCE OR FAILURE — pinned by a forbidden-wording test.
 * ⚠ Solo blocks are attendee-free direct writes, as task-blocks' always were.
 */

const db = require('../db/database');
const taskBlocks = require('./task-blocks');
const timeFit = require('./time-fit');
const focusHold = require('./focus-hold');

const CONTRACT = 'focus-block-v1';
const READY_MINUTES = 5;          // context gathered, "Up next" on Now
const WIND_DOWN_MINUTES = 5;      // "5 minutes left — note where you got to"
const TWO_MINUTES = 2;
const END_PROMPT_MINUTES = 30;    // how long the end check-in stays on screen
const PASS_WINDOW_DAYS = 7;
const PASSES_FOR_TOO_BIG = 2;
const CANDIDATES = 2;
const MORE_TIME = [15, 30];
const OPEN_SUBJECT = 'Focus block';

// ── time helpers ─────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
function toMin(s) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(s || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function dateKeyOf(now) { return require('../../shared/working-days.cjs').toDateStr(now); }
function nowMinOf(now) { return now.getHours() * 60 + now.getMinutes(); }

// ── storage (lazy side tables, never a rebuild of task_blocks) ──────────────

let ensured = false;
function ensure() {
  if (ensured) return;
  db.getDb().exec(`
    CREATE TABLE IF NOT EXISTS focus_block_state (
      block_id        INTEGER PRIMARY KEY,
      kind            TEXT NOT NULL CHECK(kind IN ('open','manual')),
      chosen_task_id  INTEGER,
      chosen_at       TEXT,
      session_id      TEXT,
      offered_json    TEXT,
      ready_json      TEXT,
      two_min_until   TEXT,
      two_min_answer  TEXT,
      wind_note       TEXT,
      end_answer      TEXT,
      user_moved      INTEGER NOT NULL DEFAULT 0,
      slides          INTEGER NOT NULL DEFAULT 0,
      basis_json      TEXT,
      notice          TEXT,
      notice_at       TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS focus_block_moments (
      block_id  INTEGER NOT NULL,
      moment    TEXT NOT NULL,
      fired_at  TEXT NOT NULL,
      detail    TEXT,
      PRIMARY KEY (block_id, moment)
    );
    CREATE TABLE IF NOT EXISTS focus_block_passes (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id   INTEGER NOT NULL,
      block_id  INTEGER,
      reason    TEXT NOT NULL,
      step      TEXT,
      at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_focus_block_passes_task ON focus_block_passes(task_id, at);
  `);
  ensured = true;
}

/**
 * Do the side tables exist? READS never create them: canonical Now has a
 * read-only mode (the promise shadow) that must leave the schema untouched.
 */
let present = false;
function has() {
  if (present || ensured) return true;
  try {
    present = Boolean(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'focus_block_state'"));
  } catch { present = false; }
  return present;
}

function getState(blockId) {
  if (!has()) return null;
  return db.get('SELECT * FROM focus_block_state WHERE block_id = ?', [blockId]) || null;
}

function putState(blockId, fields = {}) {
  ensure();
  const now = new Date().toISOString();
  const existing = getState(blockId);
  if (!existing) {
    const kind = fields.kind || 'manual';
    db.run('INSERT OR IGNORE INTO focus_block_state (block_id, kind, created_at, updated_at) VALUES (?, ?, ?, ?)', [blockId, kind, now, now]);
  }
  const cols = Object.keys(fields).filter((k) => k !== 'kind' || existing);
  if (cols.length) {
    db.run(`UPDATE focus_block_state SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE block_id = ?`,
      [...cols.map((c) => fields[c]), now, blockId]);
  }
  return getState(blockId);
}

/** Claim a moment for a block. True only for the FIRST caller, ever. */
function claimMoment(blockId, moment, detail = null, now = new Date()) {
  ensure();
  const r = db.run('INSERT OR IGNORE INTO focus_block_moments (block_id, moment, fired_at, detail) VALUES (?, ?, ?, ?)',
    [blockId, moment, now.toISOString(), detail ? JSON.stringify(detail).slice(0, 2000) : null]);
  return r.changes === 1;
}

function firedMoments(blockId) {
  if (!has()) return new Set();
  return new Set(db.all('SELECT moment FROM focus_block_moments WHERE block_id = ?', [blockId]).map((r) => r.moment));
}

function recordPass(taskId, blockId, reason, step = null, now = new Date()) {
  ensure();
  db.run('INSERT INTO focus_block_passes (task_id, block_id, reason, step, at) VALUES (?, ?, ?, ?, ?)',
    [Number(taskId), blockId ?? null, reason, step ? String(step).slice(0, 200) : null, now.toISOString()]);
}

function passesFor(taskIds, now = new Date()) {
  if (!has()) return [];
  const ids = [...new Set((taskIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return [];
  const since = new Date(now.getTime() - PASS_WINDOW_DAYS * 86400000).toISOString();
  return db.all(`SELECT * FROM focus_block_passes WHERE at >= ? AND task_id IN (${ids.map(() => '?').join(',')}) ORDER BY at DESC`, [since, ...ids]);
}

// ── PURE judgements ──────────────────────────────────────────────────────────

/** The block's window as local Dates, or null. */
function windowOf(block) { return taskBlocks.blockWindow(block); }

/**
 * PURE. Offered-and-passed-over twice in seven days: the next offer asks
 * whether it is too big. A pass is a "not now" on the offer, or a block that
 * ended with it offered and nothing picked. The reason is the WORK's size,
 * never anything about Nick.
 */
function tooBigFrom(passes = [], taskId, now = new Date()) {
  const since = now.getTime() - PASS_WINDOW_DAYS * 86400000;
  const mine = passes.filter((p) => Number(p.task_id) === Number(taskId)
    && Date.parse(p.at) >= since && (p.reason === 'not-now' || p.reason === 'missed'));
  return mine.length >= PASSES_FOR_TOO_BIG;
}

/** PURE. The last smaller step Nick named for a task (from "Stuck"), if any. */
function smallerStepFrom(passes = [], taskId) {
  const p = passes.find((x) => Number(x.task_id) === Number(taskId) && x.reason === 'stuck' && x.step);
  return p ? p.step : null;
}

/**
 * PURE. The top candidates from a RANKED todo list. Never re-sorted: the order
 * is rankWithOrder's (Nick's MoSCoW and drag order). Excludes what is not
 * NEURO's to block, personal work, what he deferred, what another open block
 * already holds, and a repeating task whose occurrence for today is done.
 */
function pickCandidates(ranked = [], {
  limit = CANDIDATES, deferredKey = () => null, deferred = new Set(), blocked = new Set(),
  today = null, exclude = new Set(),
} = {}) {
  const { isPersonal } = require('../../shared/task-domain.cjs');
  const out = [];
  for (const t of ranked || []) {
    if (out.length >= limit) break;
    if (!t || !Number.isInteger(t.task_id) || t.done) continue;
    if (isPersonal(t)) continue;
    if (exclude.has(t.task_id) || blocked.has(t.task_id)) continue;
    const key = deferredKey(t);
    if (key && deferred.has(key)) continue;
    // A repeating task reopens at its next slot once ticked; a due date in the
    // future on one means today's occurrence is already done.
    if (t.repeat && today && t.due_date && t.due_date > today) continue;
    if (t.repeat && today && t.dueDate && t.dueDate > today) continue;
    out.push({ taskId: t.task_id, text: t.text, estimateMinutes: t.estimateMinutes ?? null });
  }
  return out;
}

/**
 * PURE. Where a block is, for the screen. One of:
 *   upcoming (more than 5 min away) | ready | start | two-minute | running |
 *   wind-down | end | done | over
 */
function phaseOf(block, state, session, now, fired = new Set()) {
  const win = windowOf(block);
  if (!win) return 'over';
  const t = now.getTime();
  const start = win.start.getTime();
  const end = win.end.getTime();
  const st = state || {};
  if (st.end_answer === 'done' || block.status === 'complete') return 'done';
  const chosen = st.chosen_task_id != null;
  const live = chosen && session && session.taskId != null && Number(session.taskId) === Number(st.chosen_task_id)
    && !['done', 'abandoned'].includes(session.status);
  if (t < start - READY_MINUTES * 60000) return 'upcoming';
  if (t < start) return 'ready';
  if (t < end) {
    if (!chosen || !live) return 'start';
    if (st.two_min_until && !st.two_min_answer && t >= Date.parse(st.two_min_until)) return 'two-minute';
    if (t >= end - WIND_DOWN_MINUTES * 60000) return 'wind-down';
    return 'running';
  }
  if (chosen && !st.end_answer && t < end + END_PROMPT_MINUTES * 60000 && fired.has(`end@${block.end_time}`)) return 'end';
  return 'over';
}

/**
 * PURE. The moments the engine owes at `now`, as [{ moment, kind }]. Each is
 * keyed with the time it is about, so the ledger fires it once and a slide or
 * an extension re-arms it.
 */
function dueMoments(block, state, session, now) {
  const win = windowOf(block);
  if (!win || !['scheduled', 'awaiting-writeup'].includes(block.status)) return [];
  const t = now.getTime();
  const start = win.start.getTime();
  const end = win.end.getTime();
  const st = state || {};
  const out = [];
  const chosen = st.chosen_task_id != null;
  const live = chosen && session && Number(session.taskId) === Number(st.chosen_task_id)
    && !['done', 'abandoned'].includes(session.status);
  if (t >= start - READY_MINUTES * 60000 && t < start) out.push({ kind: 'ready', moment: `ready@${block.start_time}` });
  // The start prompt is for a block nobody has picked yet; once it is late in
  // the window there is no point announcing it.
  if (t >= start && t < end - WIND_DOWN_MINUTES * 60000 && !chosen) out.push({ kind: 'start', moment: `start@${block.start_time}` });
  if (live && st.two_min_until && !st.two_min_answer && t >= Date.parse(st.two_min_until) && t < end) {
    out.push({ kind: 'two-minute', moment: `two-minute@${st.session_id || st.two_min_until}` });
  }
  if (live && t >= end - WIND_DOWN_MINUTES * 60000 && t < end) out.push({ kind: 'wind-down', moment: `wind-down@${block.end_time}` });
  if (t >= end && t < end + END_PROMPT_MINUTES * 60000) out.push({ kind: 'end', moment: `end@${block.end_time}` });
  return out;
}

/**
 * PURE. The block clock — the stable field iOS reads for the Watch complication
 * and a lock-screen countdown. Instants are ISO UTC; seconds are whole.
 */
function clockOf(block, state, session, now, phase) {
  const win = windowOf(block);
  if (!win) return null;
  const t = now.getTime();
  const st = state || {};
  const taskId = st.chosen_task_id != null ? Number(st.chosen_task_id) : null;
  let taskText = null;
  if (taskId != null) taskText = (session && Number(session.taskId) === taskId && session.text) || st.chosen_text || null;
  return {
    blockId: block.id,
    phase,
    startsAt: win.start.toISOString(),
    endsAt: win.end.toISOString(),
    startsInSeconds: Math.max(0, Math.round((win.start.getTime() - t) / 1000)),
    remainingSeconds: Math.max(0, Math.round((win.end.getTime() - Math.max(t, win.start.getTime())) / 1000)),
    running: t >= win.start.getTime() && t < win.end.getTime(),
    task: taskId != null ? { id: taskId, text: taskText } : null,
  };
}

const SAY = {
  start: (b) => `It's ${b.start_time} — your focus block.`,
  ready: (b) => `Up next at ${b.start_time} — your focus block.`,
  twoMinute: () => 'Two minutes in. Carry on, or stop there?',
  windDown: () => '5 minutes left — note where you got to.',
  end: (b) => `Your ${b.start_time} block is over. How did it go?`,
  tooBig: () => 'Is this too big? Make it smaller.',
  stopped: () => 'Stopped after two minutes — that counts as a start.',
};

// ── reads ────────────────────────────────────────────────────────────────────

function todaysOpenBlocks(now) {
  return db.all(
    `SELECT * FROM task_blocks WHERE date_key = ? AND status IN ('scheduled','awaiting-writeup') ORDER BY start_time ASC`,
    [dateKeyOf(now)],
  );
}

function sessionNow(deps, now) {
  try { return (deps.session || require('./focus-session')).current(now.getTime()); } catch { return null; }
}

function rankedTodos(now) {
  const taskStore = require('./task-store');
  return require('./task-order').rankWithOrder(taskStore.activeTodos(), dateKeyOf(now));
}

/** The candidates for a block at `now`, with their too-big flag and smaller step. */
function candidatesFor(block, now, { deps = {} } = {}) {
  const items = db.listTaskBlockItems(block.id);
  let list;
  if (items.length) {
    // Nick's own block: his tasks, as he picked them (unticked first).
    list = items.filter((i) => !i.awaiting && i.task_status !== 'done' && i.task_status !== 'dropped')
      .map((i) => ({ taskId: i.task_id, text: i.text, estimateMinutes: i.allotted_minutes ?? null }))
      .slice(0, 3);
  } else {
    const lifecycle = require('./attention-lifecycle');
    let deferred = new Set();
    try { deferred = lifecycle.deferredKeys(now); } catch { /* unknown never hides work */ }
    const blocked = taskBlocks.blockedTaskIds() || new Set();
    const ranked = deps.ranked ? deps.ranked() : rankedTodos(now);
    list = pickCandidates(ranked, {
      deferred,
      deferredKey: (t) => lifecycle.dedupeKeyFor({ type: 'todo', title: t.text }),
      blocked,
      today: dateKeyOf(now),
    });
  }
  const passes = passesFor(list.map((c) => c.taskId), now);
  return list.map((c) => ({
    ...c,
    tooBig: tooBigFrom(passes, c.taskId, now),
    smallerStep: smallerStepFrom(passes, c.taskId),
  }));
}

/** Pinned notes, a saved draft, the Jira key and the Microsoft board, per task. Never throws. */
function prepareContext(taskIds) {
  const out = {};
  const ids = (taskIds || []).map(Number).filter(Number.isInteger);
  for (const id of ids) out[id] = { notes: [], draft: null, jira: null, microsoft: null };
  if (!ids.length) return out;
  try {
    const pinned = require('./task-context').pinnedFor(ids, { limit: 2 });
    for (const [id, rows] of pinned) {
      if (out[id]) out[id].notes = rows.map((r) => ({ title: r.title || r.ref, open: r.open || null }));
    }
  } catch { /* context is a help, never a gate */ }
  try {
    const keys = require('./jira-tasks').keysByTaskId();
    for (const id of ids) if (keys[id]) out[id].jira = keys[id];
  } catch {}
  try {
    for (const id of ids) {
      const row = db.getTaskRow(id);
      if (row && row.ms_id) out[id].microsoft = { source: row.ms_source || 'Microsoft', plan: row.ms_plan || null };
    }
  } catch {}
  try {
    const work = require('./prepared-drafts').savedWork().work || [];
    for (const w of work) {
      const id = w.task && Number(w.task.id);
      if (out[id] && !out[id].draft) out[id].draft = { title: w.title, path: w.path || null, obsidianUrl: w.obsidianUrl || null };
    }
  } catch {}
  return out;
}

/**
 * What Now and SAiM show. One block: the one running, else the one about to
 * start (inside 5 min), else one whose end check-in is waiting. Plus a notice
 * when a block was moved or dropped today. Null most of the day.
 */
function view({ now = new Date(), deps = {} } = {}) {
  // Only live blocks: a released or dropped one is over, and a completed one
  // said so itself ("Done").
  const pool = todaysOpenBlocks(now);
  const session = sessionNow(deps, now);
  let chosen = null;
  for (const b of pool) {
    const st = getState(b.id);
    const phase = phaseOf(b, st, session, now, firedMoments(b.id));
    if (['upcoming', 'over', 'done'].includes(phase)) continue;
    if (!chosen || rankPhase(phase) > rankPhase(chosen.phase)) chosen = { block: b, state: st, phase };
  }
  const notice = latestNotice(now);
  if (!chosen) return notice ? { contract: CONTRACT, phase: 'notice', notice } : null;
  return composeView(chosen.block, chosen.state, session, now, chosen.phase, notice);
}

function rankPhase(p) {
  return ({ end: 6, 'two-minute': 5, 'wind-down': 4, running: 3, start: 2, ready: 1 })[p] || 0;
}

function latestNotice(now) {
  if (!has()) return null;
  const since = new Date(now.getTime() - 3 * 3600000).toISOString();
  const row = db.get(
    `SELECT notice, notice_at, block_id FROM focus_block_state WHERE notice IS NOT NULL AND notice_at >= ? ORDER BY notice_at DESC LIMIT 1`,
    [since],
  );
  return row ? { say: row.notice, at: row.notice_at, blockId: row.block_id } : null;
}

function composeView(block, state, session, now, phase, notice = null) {
  const st = state || {};
  let offered = [];
  try { offered = JSON.parse(st.offered_json || '[]'); } catch { offered = []; }
  let ready = {};
  try { ready = JSON.parse(st.ready_json || '{}'); } catch { ready = {}; }
  let basis = null;
  try { basis = st.basis_json ? JSON.parse(st.basis_json) : null; } catch { basis = null; }
  // At "ready" and "start" the candidates are what would be offered NOW; once
  // chosen, the offer is history.
  let candidates = offered;
  if ((phase === 'ready' || phase === 'start') && !offered.length) {
    try { candidates = candidatesFor(block, now); } catch { candidates = []; }
  }
  candidates = candidates.map((c) => ({ ...c, context: (ready.context || {})[c.taskId] || null }));
  const say = phase === 'ready' ? SAY.ready(block)
    : phase === 'start' ? (st.two_min_answer === 'stop' ? SAY.stopped() : SAY.start(block))
      : phase === 'two-minute' ? SAY.twoMinute()
        : phase === 'wind-down' ? SAY.windDown()
          : phase === 'end' ? SAY.end(block)
            : null;
  const clock = clockOf(block, { ...st, chosen_text: chosenText(st) }, session, now, phase);
  const hold = focusHold.read();
  return {
    contract: CONTRACT,
    blockId: block.id,
    kind: st.kind || (db.listTaskBlockItems(block.id).length ? 'manual' : 'open'),
    phase,
    say,
    dateKey: block.date_key,
    startTime: block.start_time,
    endTime: block.end_time,
    minutes: block.minutes,
    // #87 + point 8: a length NEURO assumed says so, and says why.
    minutesAssumed: Boolean(block.minutes_assumed),
    minutesBasis: basis ? basis.basis || null : null,
    lengthLearned: basis ? Boolean(basis.learned) : null,
    candidates: phase === 'ready' || phase === 'start' ? candidates : [],
    tooBigSay: SAY.tooBig(),
    chosen: clock && clock.task ? clock.task : null,
    windNote: st.wind_note || null,
    moreTime: phase === 'end' ? MORE_TIME : [],
    held: hold && Number(hold.blockId) === Number(block.id) ? (hold.held || []).length + (hold.overflow || 0) : 0,
    clock,
    notice,
  };
}

function chosenText(st) {
  if (!st || st.chosen_task_id == null) return null;
  try { return (db.getTaskRow(st.chosen_task_id) || {}).text || null; } catch { return null; }
}

// ── the engine ───────────────────────────────────────────────────────────────

function defaultPush(title, body, data) {
  return require('./webpush').sendToAll(title, body, data);
}

/**
 * Every minute. ONE query when nothing is near; otherwise each due moment is
 * claimed in the ledger first and only then acted on.
 */
async function tick({ now = new Date(), deps = {} } = {}) {
  ensure();
  deps = { ...deps, push: deps.push || defaultPush };
  const out = { blocks: 0, fired: [], released: null };

  // A hold whose block is over is drained here even if the block's own end
  // moment never ran (a restart across the end, a manual drop).
  const hold = focusHold.read();
  if (hold && !focusHold.activeAt(hold, now)) out.released = await releaseHeld(deps, now);

  const t = now.getTime();
  const near = todaysOpenBlocks(now).filter((b) => {
    const win = windowOf(b);
    if (!win) return false;
    return t >= win.start.getTime() - (READY_MINUTES + 1) * 60000 && t < win.end.getTime() + END_PROMPT_MINUTES * 60000;
  });
  if (!near.length) return { ...out, idle: true };

  const session = sessionNow(deps, now);
  for (const block of near) {
    out.blocks++;
    let st = getState(block.id);
    if (!st) st = putState(block.id, { kind: db.listTaskBlockItems(block.id).length ? 'manual' : 'open' });
    for (const m of dueMoments(block, st, session, now)) {
      if (!claimMoment(block.id, m.moment, null, now)) continue;
      out.fired.push(`${block.id}:${m.moment}`);
      try {
        await fire(m.kind, block, st, session, now, deps);
      } catch (e) {
        console.warn(`[FocusBlocks] ${m.moment} on block #${block.id} failed: ${e.message}`);
      }
      st = getState(block.id);
    }
  }
  return out;
}

async function fire(kind, block, st, session, now, deps) {
  const key = (k) => `block:${block.id}:${k}`;
  if (kind === 'ready') {
    const cands = candidatesFor(block, now, { deps });
    putState(block.id, { ready_json: JSON.stringify({ at: now.toISOString(), taskIds: cands.map((c) => c.taskId), context: prepareContext(cands.map((c) => c.taskId)) }) });
    return; // a quiet "Up next" on Now — no push for this
  }
  if (kind === 'start') {
    const cands = candidatesFor(block, now, { deps });
    let ready = {};
    try { ready = JSON.parse(st.ready_json || '{}'); } catch {}
    if (!ready.context) putState(block.id, { ready_json: JSON.stringify({ at: now.toISOString(), taskIds: cands.map((c) => c.taskId), context: prepareContext(cands.map((c) => c.taskId)) }) });
    putState(block.id, { offered_json: JSON.stringify(cands) });
    const names = cands.map((c) => (c.tooBig ? `${c.text} (maybe smaller?)` : c.text)).join(' · ');
    await deps.push(SAY.start(block), names ? `Pick one: ${names}` : 'Pick something to start on.',
      { type: 'block_start', tab: 'surface', key: key(`start@${block.start_time}`), blockId: block.id });
    return;
  }
  if (kind === 'two-minute') {
    await deps.push(SAY.twoMinute(), chosenText(st) || 'Your focus block',
      { type: 'block_two_minute', tab: 'surface', key: key(`two-minute@${st.session_id}`), blockId: block.id });
    return;
  }
  if (kind === 'wind-down') {
    await deps.push(SAY.windDown(), `Optional — a line on ${chosenText(st) || 'the task'}.`,
      { type: 'block_wind_down', tab: 'surface', key: key(`wind-down@${block.end_time}`), blockId: block.id });
    return;
  }
  if (kind === 'end') {
    const sess = deps.session || require('./focus-session');
    const live = st.chosen_task_id != null && session && Number(session.taskId) === Number(st.chosen_task_id)
      && !['done', 'abandoned'].includes(session.status);
    // No answer: the session ends with the block. Nothing is completed.
    if (live) { try { sess.endWith('block-ended', now.getTime()); } catch (e) { console.warn('[FocusBlocks] end session:', e.message); } }
    await releaseHeld(deps, now);
    if (st.chosen_task_id == null) {
      // Offered and nothing picked: a pass for each candidate on screen.
      let offered = [];
      try { offered = JSON.parse(st.offered_json || '[]'); } catch {}
      for (const c of offered) recordPass(c.taskId, block.id, 'missed', null, now);
      return;
    }
    await deps.push(SAY.end(block), `${chosenText(st) || 'Your task'} — Done, more time, or stuck?`,
      { type: 'block_end', tab: 'surface', key: key(`end@${block.end_time}`), blockId: block.id });
  }
}

/** Drain the hold and send its ONE summary. Never throws. */
async function releaseHeld(deps, now = new Date()) {
  deps = { ...deps, push: (deps && deps.push) || defaultPush };
  const drained = focusHold.drain();
  const sum = focusHold.summaryOf(drained.held, drained.overflow);
  if (!sum) return { held: 0 };
  try {
    await deps.push(sum.title, sum.body, { type: 'block_summary', tab: 'surface', key: `block_summary:${drained.blockId}:${now.toISOString().slice(0, 16)}` });
  } catch (e) {
    console.warn('[FocusBlocks] summary push failed:', e.message);
  }
  return { held: drained.held.length + (drained.overflow || 0) };
}

// ── creating an open block (the planner) ────────────────────────────────────

function graphOf(deps) {
  if (deps.graph) return deps.graph;
  const ms = require('./microsoft');
  return { create: ms.createCalendarEvent, update: ms.updateCalendarEvent, remove: ms.deleteCalendarEvent };
}

function openNotePath(dateKey, startTime) {
  const [y, m] = String(dateKey).split('-');
  return `${taskBlocks.OUTCOMES_DIR}/${y}/${m}/${dateKey} Focus block ${String(startTime).replace(':', '')}.md`;
}

/**
 * Book the TIME. No task. The row is written FIRST (the unique slot is the only
 * guard against a duplicate event), then the attendee-free event.
 */
async function createOpenBlock({ date, startTime, minutes, basis = null, now = new Date(), deps = {} } = {}) {
  ensure();
  const start = toMin(startTime);
  if (!date || start == null || !(minutes > 0)) return { ok: false, error: 'date, startTime and minutes are required' };
  const endTime = hhmm(start + minutes);
  let blockId;
  try {
    blockId = db.createTaskBlockRow({
      date_key: date, start_time: startTime, end_time: endTime, minutes,
      minutes_assumed: basis && basis.learned ? 0 : 1,
      note_path: openNotePath(date, startTime), status: 'scheduled',
    });
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return { ok: false, duplicate: true, error: `Something is already blocked at ${startTime} on ${date}` };
    throw e;
  }
  putState(blockId, { kind: 'open' });
  putState(blockId, { basis_json: basis ? JSON.stringify({ multiplier: basis.multiplier, learned: Boolean(basis.learned), basis: basis.basis || null }) : null });
  const graph = graphOf(deps);
  const res = await graph.create({
    subject: OPEN_SUBJECT,
    start: `${date}T${startTime}:00`,
    end: `${date}T${endTime}:00`,
    attendees: [],
    body: 'NEURO will offer two tasks when this starts — pick one then.',
  });
  if (!res || !res.created) {
    return { ok: false, blockId, error: `Booked in NEURO but Outlook refused it (${res && res.reason})` };
  }
  db.updateTaskBlockRow(blockId, { event_id: res.event.id, event_web_link: res.event.webLink || null });
  return { ok: true, blockId, slot: { date, startTime, endTime }, minutes };
}

// ── Nick's presses ───────────────────────────────────────────────────────────

function liveBlock(blockId) {
  const block = db.getTaskBlockRow(blockId);
  if (!block) return { error: `No block #${blockId}`, code: 404 };
  if (!['scheduled', 'awaiting-writeup'].includes(block.status)) return { error: `Block #${blockId} is ${block.status}`, code: 409 };
  return { block };
}

function minutesLeft(block, now) {
  const win = windowOf(block);
  if (!win) return null;
  return Math.max(1, Math.round((win.end.getTime() - Math.max(now.getTime(), win.start.getTime())) / 60000));
}

/**
 * Choose a task. Starts a focus session on it (planned to the block's end),
 * writes the task onto the block and its event, and starts the push hold.
 * `twoMinute` adds the one check two minutes in; `smallerStep` records the
 * smaller first bit as a shrink on the session.
 */
async function choose(blockId, { taskId, twoMinute = false, smallerStep = null, force = false } = {}, { now = new Date(), deps = {} } = {}) {
  ensure();
  const { block, error, code } = liveBlock(blockId);
  if (error) return { ok: false, error, code };
  const id = Number(taskId);
  const task = Number.isInteger(id) ? db.getTaskRow(id) : null;
  if (!task) return { ok: false, error: `No task #${taskId}`, code: 404 };
  if (task.status === 'done' || task.status === 'dropped') return { ok: false, error: `Task #${id} is ${task.status}`, code: 409 };
  const win = windowOf(block);
  if (!win || now.getTime() >= win.end.getTime()) return { ok: false, error: 'That block has already ended', code: 409 };

  const sess = deps.session || require('./focus-session');
  const started = sess.start({ taskId: id, text: task.text, minutes: minutesLeft(block, now), force: Boolean(force), source: 'manual' }, now.getTime());
  if (!started.ok) return { ok: false, code: 409, reason: started.reason, session: started.session, error: 'Another focus session is running — switch to this one?' };
  let shrunk = null;
  const step = String(smallerStep || '').trim();
  if (step) {
    shrunk = sess.shrink({ step }, now.getTime());
    recordPass(id, blockId, 'shrunk', step, now);
  }

  // Onto the block: membership (unless another open block holds it — one task,
  // one window) and the event's subject.
  const items = db.listTaskBlockItems(blockId);
  const elsewhere = (taskBlocks.blockedTaskIds() || new Set()).has(id) && !items.some((i) => Number(i.task_id) === id);
  if (!items.some((i) => Number(i.task_id) === id) && !elsewhere) db.addTaskBlockItem(blockId, id, null);
  let eventUpdate = null;
  if (block.event_id) {
    try {
      eventUpdate = await graphOf(deps).update(block.event_id, {
        subject: `${OPEN_SUBJECT}: ${task.text}`.slice(0, 200),
        body: `• ${task.text}  (NEURO #${id})\n\nPicked at ${hhmm(nowMinOf(now))}.`,
      });
    } catch (e) { eventUpdate = { updated: false, reason: e.message }; }
  }

  putState(blockId, {
    chosen_task_id: id,
    chosen_at: now.toISOString(),
    session_id: started.session && started.session.id,
    two_min_until: twoMinute ? new Date(now.getTime() + TWO_MINUTES * 60000).toISOString() : null,
    two_min_answer: null,
  });
  focusHold.set({ blockId, until: win.end, taskText: task.text });
  return { ok: true, blockId, task: { id, text: task.text }, session: started.session, twoMinute: Boolean(twoMinute), shrunk: Boolean(shrunk && shrunk.ok), eventUpdate, view: view({ now, deps }) };
}

/** Two minutes in: carry on, or stop there (a start, ended cleanly). */
async function twoMinute(blockId, { answer } = {}, { now = new Date(), deps = {} } = {}) {
  ensure();
  if (!['carry-on', 'stop'].includes(answer)) return { ok: false, code: 400, error: 'answer must be carry-on or stop' };
  const block = db.getTaskBlockRow(blockId);
  if (!block) return { ok: false, code: 404, error: `No block #${blockId}` };
  const st = getState(blockId);
  if (!st || !st.two_min_until) return { ok: false, code: 409, error: 'This block was not opened for two minutes' };
  if (answer === 'carry-on') {
    putState(blockId, { two_min_answer: 'carry-on' });
    return { ok: true, answer, say: 'Carrying on to the end of the block.' };
  }
  const sess = deps.session || require('./focus-session');
  const ended = sess.endWith('two-minute-stop', now.getTime());
  putState(blockId, { two_min_answer: 'stop', chosen_task_id: null, session_id: null });
  await releaseHeld(deps, now);
  return { ok: true, answer, say: SAY.stopped(), ended: Boolean(ended && ended.ok) };
}

/** Find the next free slot TODAY for this block, or null. */
function slotToday(block, now) {
  const today = dateKeyOf(now);
  const rows = [];
  try {
    for (const r of db.getCalendarEvents(`${today}T00:00:00`, `${today}T23:59:59`)) {
      if (block.event_id && r.event_id === block.event_id) continue;
      rows.push({ date: today, start: r.start_time, end: r.end_time, isAllDay: Boolean(r.is_all_day), showAs: r.show_as || 'busy' });
    }
  } catch { return { known: false, slot: null }; }
  for (const b of db.listTaskBlockRows({ statuses: ['scheduled', 'awaiting-writeup', 'complete'] })) {
    if (b.date_key !== today || b.id === block.id) continue;
    rows.push({ date: today, start: `${today}T${b.start_time}:00`, end: `${today}T${b.end_time}:00`, isAllDay: false, showAs: 'busy' });
  }
  const slot = taskBlocks.findSlot({ minutes: block.minutes, events: rows, now });
  if (slot.reason || slot.date !== today) return { known: true, slot: null };
  return { known: true, slot };
}

async function slide(block, now, deps, why) {
  const found = slotToday(block, now);
  if (!found.known) return { moved: false, reason: 'the diary could not be read' };
  if (!found.slot) return { moved: false, reason: 'no free slot left today' };
  const { slot } = found;
  db.updateTaskBlockRow(block.id, { start_time: slot.startTime, end_time: slot.endTime });
  const st = getState(block.id) || {};
  putState(block.id, { slides: (st.slides || 0) + 1, notice: `${why} — moved your ${block.start_time} focus block to ${slot.startTime}.`, notice_at: now.toISOString() });
  if (block.event_id) {
    try { await graphOf(deps).update(block.event_id, { start: `${slot.date}T${slot.startTime}:00`, end: `${slot.date}T${slot.endTime}:00` }); }
    catch (e) { console.warn('[FocusBlocks] slide event update:', e.message); }
  }
  return { moved: true, startTime: slot.startTime, endTime: slot.endTime };
}

/** "Not now": slide it to the next free slot today, else release it. */
async function notNow(blockId, { now = new Date(), deps = {} } = {}) {
  ensure();
  const { block, error, code } = liveBlock(blockId);
  if (error) return { ok: false, error, code };
  const st = getState(blockId) || putState(blockId, { kind: db.listTaskBlockItems(blockId).length ? 'manual' : 'open' });
  if (st.chosen_task_id != null) return { ok: false, code: 409, error: 'You picked a task for this block — finish or stop it instead' };
  let offered = [];
  try { offered = JSON.parse(st.offered_json || '[]'); } catch {}
  if (!offered.length) { try { offered = candidatesFor(block, now, { deps }); } catch { offered = []; } }
  for (const c of offered) recordPass(c.taskId, blockId, 'not-now', null, now);
  putState(blockId, { offered_json: null, ready_json: null });
  const moved = await slide(block, now, deps, 'Not now');
  if (moved.moved) return { ok: true, moved: true, startTime: moved.startTime, say: `Moved to ${moved.startTime}.` };
  taskBlocks.release(blockId, `Not now — ${moved.reason}`, { completeTask: false });
  putState(blockId, { notice: `Not now — ${moved.reason}, so the ${block.start_time} block is let go.`, notice_at: now.toISOString() });
  if (block.event_id) { try { await graphOf(deps).remove(block.event_id); } catch {} }
  return { ok: true, moved: false, released: true, say: `Let go — ${moved.reason}.` };
}

/** "Note where you got to" — optional, one line, kept on the block. */
async function windDown(blockId, { note } = {}, { now = new Date() } = {}) {
  ensure();
  const text = String(note || '').trim().slice(0, 300);
  if (!text) return { ok: false, code: 400, error: 'Nothing to save — the note is optional, so just carry on.' };
  const block = db.getTaskBlockRow(blockId);
  if (!block) return { ok: false, code: 404, error: `No block #${blockId}` };
  putState(blockId, { wind_note: text });
  const savedTo = appendToOutcomeNote(block, text, now);
  return { ok: true, saved: true, savedTo, say: savedTo ? 'Saved to the block’s note.' : 'Saved on the block.' };
}

function appendToOutcomeNote(block, text, now) {
  try {
    const fs = require('fs');
    const path = require('path');
    const root = process.env.OBSIDIAN_VAULT_PATH;
    if (!root || !path.isAbsolute(root) || !block.note_path || taskBlocks.isArchivedNote(block.note_path)) return null;
    const full = path.join(root, block.note_path);
    if (!fs.existsSync(full)) return null;
    const raw = fs.readFileSync(full, 'utf8');
    const line = `- ${hhmm(nowMinOf(now))} — where I got to: ${text}`;
    const updated = raw.includes('## What came of it')
      ? raw.replace('## What came of it\n', `## What came of it\n${line}\n`)
      : `${raw.replace(/\s*$/, '')}\n\n${line}\n`;
    fs.writeFileSync(full, updated, 'utf8');
    return block.note_path;
  } catch { return null; }
}

/**
 * The end check-in. Done completes the task (task-store → wins); More time
 * extends the block by 15 or 30 if the diary is free; Stuck offers to make it
 * smaller and keeps the smaller step for the next offer.
 */
async function endAnswer(blockId, { answer, minutes = null, step = null } = {}, { now = new Date(), deps = {} } = {}) {
  ensure();
  if (!['done', 'more', 'stuck'].includes(answer)) return { ok: false, code: 400, error: 'answer must be done, more or stuck' };
  const block = db.getTaskBlockRow(blockId);
  if (!block) return { ok: false, code: 404, error: `No block #${blockId}` };
  const st = getState(blockId);
  if (!st || st.chosen_task_id == null) return { ok: false, code: 409, error: 'No task was picked for this block' };
  const taskId = Number(st.chosen_task_id);

  if (answer === 'done') {
    const sess = deps.session || require('./focus-session');
    const live = sess.current(now.getTime());
    if (live && Number(live.taskId) === taskId) { try { sess.finish({ completeTask: false }, now.getTime()); } catch {} }
    require('./task-store').setStatus(taskId, 'done');
    db.updateTaskBlockRow(blockId, { status: 'complete', completed_at: now.toISOString() });
    putState(blockId, { end_answer: 'done' });
    await releaseHeld(deps, now);
    let win = null;
    try {
      const wins = require('./wins');
      try { wins.sync({}); } catch {}
      win = wins.headline(wins.summary(now));
    } catch { win = null; }
    return { ok: true, answer, taskCompleted: true, win };
  }

  if (answer === 'stuck') {
    const s = String(step || '').trim();
    recordPass(taskId, blockId, 'stuck', s || null, now);
    putState(blockId, { end_answer: 'stuck' });
    return {
      ok: true, answer, offer: 'make-smaller',
      say: s ? `Kept “${s}” — that’s what I’ll offer next time.` : 'What is the smallest next bit? I’ll offer that next time.',
    };
  }

  // More time.
  const by = Number(minutes);
  if (!MORE_TIME.includes(by)) return { ok: false, code: 400, error: `minutes must be ${MORE_TIME.join(' or ')}` };
  const endMin = toMin(block.end_time);
  const events = [];
  try {
    for (const r of db.getCalendarEvents(`${block.date_key}T00:00:00`, `${block.date_key}T23:59:59`)) {
      if (block.event_id && r.event_id === block.event_id) continue;
      events.push({ start: r.start_time, end: r.end_time, subject: r.subject, isAllDay: Boolean(r.is_all_day), showAs: r.show_as || 'busy' });
    }
  } catch { return { ok: true, answer, extended: false, say: 'I can’t read the diary, so I haven’t extended it.' }; }
  for (const b of db.listTaskBlockRows({ statuses: ['scheduled', 'awaiting-writeup'] })) {
    if (b.date_key === block.date_key && b.id !== block.id) events.push({ start: `${b.date_key}T${b.start_time}:00`, end: `${b.date_key}T${b.end_time}:00`, subject: 'a focus block', showAs: 'busy' });
  }
  const limit = taskBlocks.latestEndFor(block, events, { known: true });
  if (!limit.known || limit.latestEndMin < endMin + by) {
    return { ok: true, answer, extended: false, say: limit.blockedBy ? `The diary isn’t free — ${limit.blockedBy} is next.` : 'The diary isn’t free for that long.' };
  }
  const newEnd = hhmm(endMin + by);
  db.updateTaskBlockRow(blockId, { end_time: newEnd, minutes: block.minutes + by });
  putState(blockId, { end_answer: null });
  if (block.event_id) {
    try { await graphOf(deps).update(block.event_id, { start: `${block.date_key}T${block.start_time}:00`, end: `${block.date_key}T${newEnd}:00` }); } catch {}
  }
  const task = db.getTaskRow(taskId);
  const sess = deps.session || require('./focus-session');
  const started = sess.start({ taskId, text: task && task.text, minutes: by, force: true, source: 'manual' }, now.getTime());
  putState(blockId, { session_id: started.session && started.session.id });
  const win = windowOf(db.getTaskBlockRow(blockId));
  if (win) focusHold.set({ blockId, until: win.end, taskText: task && task.text });
  return { ok: true, answer, extended: true, endTime: newEnd, say: `Extended to ${newEnd}.` };
}

// ── the diary moving under a block ──────────────────────────────────────────

/** PURE. Does a real meeting (other people in it) overlap this block? */
function bumpedBy(block, rows = []) {
  const win = windowOf(block);
  if (!win) return null;
  const s = toMin(block.start_time);
  const e = toMin(block.end_time);
  for (const r of rows) {
    if (!r || r.is_all_day) continue;
    if (block.event_id && r.event_id === block.event_id) continue;
    if (r.attendees_other !== 1) continue;            // a real meeting, and only one we KNOW is
    if (r.show_as === 'cancelled') continue;
    const day = String(r.start_time || '').slice(0, 10);
    if (day !== block.date_key) continue;
    const rs = timeFit.minutesIntoDay(r.start_time);
    const re = timeFit.minutesIntoDay(r.end_time);
    if (rs == null || re == null) continue;
    if (rs < e && re > s) return { subject: r.subject || 'a meeting', start: String(r.start_time).slice(11, 16) };
  }
  return null;
}

/**
 * After a calendar sync: a not-yet-started block a real meeting now overlaps is
 * slid to the next free slot today, or dropped and said so. A block Nick moved
 * in Outlook (`moves` from followCalendar) is remembered and never moved again.
 */
async function afterCalendarSync({ now = new Date(), moves = [], deps = {} } = {}) {
  ensure();
  for (const m of moves || []) putState(m.id, { user_moved: 1 });
  const out = { slid: [], dropped: [] };
  const today = dateKeyOf(now);
  let rows = [];
  try { rows = db.getCalendarEvents(`${today}T00:00:00`, `${today}T23:59:59`); } catch { return out; }
  for (const block of todaysOpenBlocks(now)) {
    const win = windowOf(block);
    if (!win || now.getTime() >= win.start.getTime()) continue;   // not-yet-started only
    const st = getState(block.id);
    if (st && (st.user_moved || st.chosen_task_id != null)) continue;
    const hit = bumpedBy(block, rows);
    if (!hit) continue;
    const moved = await slide(block, now, deps, `${hit.subject} at ${hit.start}`);
    if (moved.moved) { out.slid.push({ blockId: block.id, to: moved.startTime }); continue; }
    db.updateTaskBlockRow(block.id, { status: 'dropped' });
    putState(block.id, { notice: `${hit.subject} at ${hit.start} took your ${block.start_time} focus block, and there was ${moved.reason === 'no free slot left today' ? 'no free slot left today' : 'no way to read the diary'} — dropped it.`, notice_at: now.toISOString() });
    if (block.event_id) { try { await graphOf(deps).remove(block.event_id); } catch {} }
    out.dropped.push({ blockId: block.id });
  }
  return out;
}

/** The block a running session belongs to, for the Tasks chip. Null when none. */
function activeFor(now = new Date()) {
  try {
    const hold = focusHold.read();
    if (!focusHold.activeAt(hold, now)) return null;
    const st = getState(hold.blockId);
    const block = db.getTaskBlockRow(hold.blockId);
    if (!st || !block || st.chosen_task_id == null) return null;
    return { taskId: Number(st.chosen_task_id), blockId: block.id, until: block.end_time };
  } catch { return null; }
}

module.exports = {
  CONTRACT,
  READY_MINUTES,
  WIND_DOWN_MINUTES,
  TWO_MINUTES,
  PASSES_FOR_TOO_BIG,
  MORE_TIME,
  OPEN_SUBJECT,
  SAY,
  // pure
  pickCandidates,
  tooBigFrom,
  smallerStepFrom,
  phaseOf,
  dueMoments,
  clockOf,
  bumpedBy,
  // reads
  view,
  activeFor,
  candidatesFor,
  prepareContext,
  // engine + presses
  tick,
  createOpenBlock,
  choose,
  twoMinute,
  notNow,
  windDown,
  endAnswer,
  afterCalendarSync,
  // storage (tests)
  ensure,
  getState,
  putState,
  claimMoment,
  recordPass,
  passesFor,
};
