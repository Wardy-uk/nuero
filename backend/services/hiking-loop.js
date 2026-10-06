'use strict';

/**
 * The first personal loop: "Hike weekly" (Build 15S–X, 6 Oct 2026).
 *
 * It exists only while Nick has an ACTIVE goal that says so — no goal, no
 * loop. It helps him remember the goal, see the plan, and tell PLANNED from
 * RECORDED from UNKNOWN. It is not an exercise nag: it never says missed,
 * failed, should or behind (pinned by a forbidden-wording test), it pushes
 * nothing, and the one thing it may "prepare" late in a week is a line on the
 * loop's own screen.
 *
 * ── Recording confidence (15U) — measured before written ──────────────────
 * On 6 Oct the store held 29 Hiking workouts, the last on 6 Aug — ONE in 90
 * days — while the personal calendar carried a repeating all-day "hiking"
 * entry every Saturday since 29 Aug. None of those planned Saturdays has a
 * workout. That is not evidence he did not hike: the Watch workout habit may
 * simply have stopped. So a missing workout is NEVER "did not hike":
 *
 *   confirmed     a Hiking workout that day, or Nick said so
 *   likely        no workout, but a day ≥ LIKELY_STEPS (18,000 — the 98th
 *                 percentile is 23,669 and 12 non-hike days in 14 months
 *                 reached it) or a walk workout ≥ 2h: worth asking, not a fact
 *   no-evidence   health data arrived and showed nothing hike-like
 *   recording-gap the health data itself did not arrive for that day
 *
 * And the habit is judged separately (`reliability`): with too few recorded
 * hikes, "no evidence" is phrased as "I can't tell", never as a gap in him.
 */

const db = require('../db/database');

const LIKELY_STEPS = 18000;
const LIKELY_WALK_MIN = 120;
const RELIABLE_MIN_RECORDED_90D = 3;
const CONFIRM_BACK_DAYS = 14;
const PLAN_AHEAD_DAYS = 60;
const HIKE_WORDS = /\bhik(e|es|ing)\b/i;
const WEEKLY_WORDS = /\bweekly\b|\bevery week\b|\beach week\b|\ba week\b|\bper week\b/i;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ── dates (wall clock, Europe/London; never re-zoned) ───────────────────────

function localDay(nowMs) { return require('./world-model').localMinute(nowMs).slice(0, 10); }
function _utc(day) { return Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)); }
function addDays(day, n) { return new Date(_utc(day) + n * 86400000).toISOString().slice(0, 10); }
function dayName(day) { return DAYS[new Date(_utc(day)).getUTCDay()]; }
/** Monday of the week containing `day`. */
function weekStart(day) { const dow = new Date(_utc(day)).getUTCDay(); return addDays(day, -((dow + 6) % 7)); }
function weekDays(start) { return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(start, i)); }

/**
 * An all-day entry pushed from the phone arrives as 23:00 the PREVIOUS day in
 * some builds (measured: "hiking" at 2026-09-12T23:00 AND 09-13T00:00, one
 * plan). Only for all-day entries, 23:00 means the next day.
 */
function entryDay(startTime, isAllDay) {
  const s = String(startTime || '');
  const day = s.slice(0, 10);
  return isAllDay && s.slice(11, 13) === '23' ? addDays(day, 1) : day;
}

// ── the goal ────────────────────────────────────────────────────────────────

/** Pure. The active goal this loop serves, or null — no goal, no loop. */
function findGoal(goals) {
  return (goals || []).find((g) => g && (g.status === 'active') && HIKE_WORDS.test(g.title || '') && WEEKLY_WORDS.test(g.title || '')) || null;
}

// ── the judgement (pure) ────────────────────────────────────────────────────

/** Pure. Is a missing workout informative? */
function reliability({ recorded90 = 0, plannedPast = [], recordedOnPlanned = 0 }) {
  if (recorded90 >= RELIABLE_MIN_RECORDED_90D && (!plannedPast.length || recordedOnPlanned / plannedPast.length >= 0.5)) {
    return { level: 'ok', why: `${recorded90} hikes recorded as workouts in the last 90 days` };
  }
  const parts = [`${recorded90} hike${recorded90 === 1 ? '' : 's'} recorded as a workout in the last 90 days`];
  if (plannedPast.length) parts.push(`${recordedOnPlanned} of ${plannedPast.length} planned hike days had one`);
  return { level: 'unreliable', why: `${parts.join(', and ')} — so a missing workout says nothing about whether you went` };
}

/**
 * Pure. One week, one result.
 * @param i { start, today, plans:[{day,source,id?}], workouts:[{day,type,mins}], confirms:[{day,id,note}],
 *            steps:{day:number|null|undefined}, rel }
 */
function weekState({ start, today, plans = [], workouts = [], confirms = [], steps = {}, rel }) {
  const days = weekDays(start);
  const inWeek = (d) => d >= days[0] && d <= days[6];
  const closed = today > days[6];
  const planned = [...new Map(plans.filter((p) => inWeek(p.day)).map((p) => [`${p.day}:${p.source}`, p])).values()]
    .sort((a, b) => a.day.localeCompare(b.day));
  const confirmed = [];
  for (const w of workouts) if (inWeek(w.day) && /hik/i.test(w.type)) confirmed.push({ day: w.day, by: 'workout', minutes: w.mins || null });
  for (const c of confirms) if (inWeek(c.day)) confirmed.push({ day: c.day, by: 'you', entryId: c.id || null });
  confirmed.sort((a, b) => a.day.localeCompare(b.day));
  const likely = [];
  if (!confirmed.length) {
    for (const w of workouts) if (inWeek(w.day) && /walk/i.test(w.type) && (w.mins || 0) >= LIKELY_WALK_MIN) likely.push({ day: w.day, by: 'long-walk', minutes: w.mins });
    for (const d of days) {
      if (d >= today) continue;
      const s = steps[d];
      if (typeof s === 'number' && s >= LIKELY_STEPS && !likely.some((x) => x.day === d)) likely.push({ day: d, by: 'steps', steps: Math.round(s) });
    }
  }
  // Health data that never arrived, on a day that matters (a planned day, or
  // any elapsed day when nothing is planned).
  const relevant = planned.length ? planned.map((p) => p.day) : days;
  const gaps = relevant.filter((d) => d < today && (steps[d] === null || steps[d] === undefined));

  const nextPlan = planned.find((p) => p.day >= today) || null;
  const pastPlan = [...planned].reverse().find((p) => p.day < today) || null;
  const dow = new Date(_utc(today)).getUTCDay(); // 0 Sun … 6 Sat
  const lateInWeek = !closed && (dow === 0 || dow >= 4);

  let recording; let line; let needsNick = null; let result;
  if (confirmed.length) {
    recording = 'confirmed';
    line = `Weekly hike done — ${dayName(confirmed[0].day)}${confirmed[0].by === 'you' ? ' (you confirmed it)' : ''}.`;
    result = 'done';
  } else if (likely.length) {
    recording = 'likely';
    const l = likely[0];
    line = l.by === 'steps'
      ? `${dayName(l.day)} had ${l.steps.toLocaleString('en-GB')} steps — was that a hike? It is not recorded as one.`
      : `A ${Math.round(l.minutes / 60 * 10) / 10}h walk on ${dayName(l.day)} — was that a hike?`;
    needsNick = { kind: 'confirm', day: l.day, why: 'likely but unconfirmed' };
    result = 'likely';
  } else if (gaps.length) {
    recording = 'recording-gap';
    line = `Health data didn't arrive for ${dayName(gaps[gaps.length - 1])}, so I can't tell whether this week's hike happened.`;
    if (pastPlan) needsNick = { kind: 'confirm', day: pastPlan.day, why: 'planned day with no health data' };
    result = closed ? 'cant-tell' : 'in-progress';
  } else {
    recording = 'no-evidence';
    if (nextPlan && !closed) {
      line = `${dayName(nextPlan.day)} hike planned.`;
      result = 'in-progress';
    } else if (pastPlan && rel.level !== 'ok') {
      line = `I can't tell whether ${dayName(pastPlan.day)}'s hike happened — it isn't recorded as a workout.`;
      needsNick = { kind: 'confirm', day: pastPlan.day, why: 'planned, not recorded, recording unreliable' };
      result = closed ? 'cant-tell' : 'in-progress';
    } else if (pastPlan) {
      line = `No hike recorded for ${dayName(pastPlan.day)}.`;
      needsNick = { kind: 'confirm', day: pastPlan.day, why: 'planned, not recorded' };
      result = closed ? 'none-recorded' : 'in-progress';
    } else if (closed) {
      line = rel.level === 'ok' ? 'No hike recorded that week.' : "No hike recorded that week — I can't tell whether that means there wasn't one.";
      result = rel.level === 'ok' ? 'none-recorded' : 'cant-tell';
    } else {
      line = 'No hike planned yet this week.';
      if (lateInWeek) needsNick = { kind: 'plan', day: null, why: 'nothing planned and the weekend is close' };
      result = 'in-progress';
    }
  }
  return { start, end: days[6], closed, planned, confirmed, likely, gaps, recording, reliability: rel.level, line, needsNick, result };
}

// ── readers ─────────────────────────────────────────────────────────────────

function _plansFromCalendar(fromDay, toDay, today) {
  const out = [];
  // Past days from history (a plan that was in the calendar then), today+ from
  // the live cache (a plan deleted since is gone).
  try {
    for (const r of db.all(`SELECT subject, start_time, is_all_day FROM calendar_history WHERE substr(start_time,1,10) >= ? AND substr(start_time,1,10) <= ?`, [addDays(fromDay, -1), toDay])) {
      if (!HIKE_WORDS.test(r.subject || '')) continue;
      const d = entryDay(r.start_time, r.is_all_day === 1);
      if (d >= fromDay && d <= toDay && d < today) out.push({ day: d, source: 'calendar' });
    }
  } catch { /* history unreadable: no past plans known */ }
  try {
    for (const r of db.all(`SELECT subject, start_time, is_all_day FROM calendar_cache WHERE substr(start_time,1,10) >= ? AND substr(start_time,1,10) <= ?`, [addDays(today, -1), toDay])) {
      if (!HIKE_WORDS.test(r.subject || '')) continue;
      const d = entryDay(r.start_time, r.is_all_day === 1);
      if (d >= today && d <= toDay) out.push({ day: d, source: 'calendar' });
    }
  } catch { /* cache unreadable */ }
  return out;
}

function entries(goalId) {
  return db.all(`SELECT * FROM goal_loop_entries WHERE goal_id = ? AND withdrawn_at IS NULL ORDER BY day`, [goalId])
    .map((r) => ({ id: r.id, kind: r.kind, day: r.day, note: r.note, createdAt: r.created_at }));
}

function _workouts(fromDay, toDay) {
  return db.all(`SELECT activity_type, started_at, ended_at, duration_seconds FROM health_workouts
                  WHERE substr(started_at,1,10) >= ? AND substr(started_at,1,10) <= ?`, [fromDay, toDay])
    .map((w) => ({ day: String(w.started_at).slice(0, 10), type: w.activity_type || '',
      mins: w.duration_seconds ? Math.round(w.duration_seconds / 60) : (w.ended_at ? Math.round((Date.parse(w.ended_at) - Date.parse(w.started_at)) / 60000) : null) }));
}

function _steps(fromDay, toDay) {
  const out = {};
  for (const r of db.all('SELECT day, steps FROM health_daily WHERE day >= ? AND day <= ?', [fromDay, toDay])) out[r.day] = r.steps == null ? null : Number(r.steps);
  return out;
}

function _reliability(today) {
  const from = addDays(today, -90);
  const recorded90 = db.get(`SELECT COUNT(*) n FROM health_workouts WHERE activity_type LIKE '%hik%' AND substr(started_at,1,10) >= ?`, [from]).n;
  const plannedPast = [...new Set(_plansFromCalendar(from, addDays(today, -1), today).map((p) => p.day))];
  const hikeDays = new Set(_workouts(from, today).filter((w) => /hik/i.test(w.type)).map((w) => w.day));
  const recordedOnPlanned = plannedPast.filter((d) => hikeDays.has(d)).length;
  const lastRecorded = db.get(`SELECT MAX(substr(started_at,1,10)) d FROM health_workouts WHERE activity_type LIKE '%hik%'`).d || null;
  return { ...reliability({ recorded90, plannedPast, recordedOnPlanned }), recorded90, plannedPastDays: plannedPast.length, recordedOnPlanned, lastRecorded };
}

function _goals() {
  try { return db.all(`SELECT goal_id, title, status, importance FROM goals`).map((g) => ({ goalId: g.goal_id, title: g.title, status: g.status, importance: g.importance })); } catch { return []; }
}

/** The loop, read now. `{ active:false }` when there is no explicit goal. */
function read({ now = Date.now(), weeks = 6 } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const goal = findGoal(_goals());
  if (!goal) return { active: false, why: 'no active "hike weekly" goal — the loop only runs for an explicit goal' };
  const today = localDay(nowMs);
  const thisWeek = weekStart(today);
  const first = addDays(thisWeek, -7 * (weeks - 1));
  const rel = _reliability(today);
  const manual = entries(goal.goalId);
  const plans = [..._plansFromCalendar(first, addDays(thisWeek, 6), today),
    ...manual.filter((e) => e.kind === 'plan').map((e) => ({ day: e.day, source: 'manual', id: e.id }))];
  const confirms = manual.filter((e) => e.kind === 'confirm');
  const workouts = _workouts(first, addDays(thisWeek, 6));
  const steps = _steps(first, addDays(thisWeek, 6));
  const out = [];
  for (let i = 0; i < weeks; i += 1) {
    const start = addDays(first, 7 * i);
    out.push(weekState({ start, today, plans, workouts, confirms, steps, rel }));
  }
  const confirmedDays = [...workouts.filter((w) => /hik/i.test(w.type)).map((w) => w.day), ...confirms.map((c) => c.day)].sort();
  const lastConfirmed = confirmedDays.length ? confirmedDays[confirmedDays.length - 1] : rel.lastRecorded;
  return {
    active: true, goal, today, weekStart: thisWeek,
    current: out[out.length - 1], weeks: out.slice().reverse(),
    reliability: rel, lastConfirmed: lastConfirmed || null, entries: manual,
  };
}

// ── transitions → goal_loop_events (what Activity shows) ───────────────────

function _event(goalId, week, kind, key, detail, at, actor = 'neuro') {
  return db.run(`INSERT OR IGNORE INTO goal_loop_events (goal_id, week_start, kind, dedupe_key, actor, at, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [goalId, week, kind, `${goalId}:${week}:${kind}:${key}`, actor, at, JSON.stringify(detail || {})]).changes;
}

/**
 * Record what CHANGED, once: a plan appearing, the week done, the week turning
 * uncertain, a gentle prompt being prepared. Idempotent — a rerun writes
 * nothing. Never sends anything.
 */
function refresh({ now = Date.now() } = {}) {
  const loop = read({ now, weeks: 2 });
  if (!loop.active) return { active: false, written: 0 };
  const at = new Date(now instanceof Date ? now.getTime() : now).toISOString();
  const gid = loop.goal.goalId;
  let written = 0;
  for (const w of loop.weeks) {
    for (const p of w.planned) written += _event(gid, w.start, 'planned', `${p.day}:${p.source}`, { day: p.day, source: p.source }, at);
    if (w.recording === 'confirmed') written += _event(gid, w.start, 'achieved', 'week', { day: w.confirmed[0].day, by: w.confirmed[0].by }, at, w.confirmed[0].by === 'you' ? 'nick' : 'neuro');
    if (w.recording === 'likely') written += _event(gid, w.start, 'likely', w.likely[0].day, { day: w.likely[0].day, by: w.likely[0].by }, at);
    if (w.needsNick && w.needsNick.kind === 'confirm' && w.recording !== 'likely') written += _event(gid, w.start, 'recording-uncertain', w.needsNick.day, { day: w.needsNick.day, why: w.needsNick.why, recording: w.recording }, at);
    if (w.needsNick && w.needsNick.kind === 'plan') written += _event(gid, w.start, 'reminder-prepared', 'plan', { why: w.needsNick.why }, at);
  }
  return { active: true, written };
}

/** Nick says a hike happened, or plans one. A statement, recorded as his. */
function addEntry(kind, { day, note = null, now = Date.now() }) {
  if (!['confirm', 'plan'].includes(kind)) return { ok: false, status: 400, error: 'kind must be confirm or plan' };
  const goal = findGoal(_goals());
  if (!goal) return { ok: false, status: 409, error: 'There is no active "hike weekly" goal, so there is no loop to record against.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) || !Number.isFinite(_utc(day))) return { ok: false, status: 400, error: 'day must be YYYY-MM-DD' };
  const nowMs = now instanceof Date ? now.getTime() : now;
  const today = localDay(nowMs);
  if (kind === 'confirm' && (day > today || day < addDays(today, -CONFIRM_BACK_DAYS))) return { ok: false, status: 400, error: `a hike can be confirmed for today or the last ${CONFIRM_BACK_DAYS} days` };
  if (kind === 'plan' && (day < today || day > addDays(today, PLAN_AHEAD_DAYS))) return { ok: false, status: 400, error: `a hike can be planned from today up to ${PLAN_AHEAD_DAYS} days ahead` };
  const held = db.get('SELECT id FROM goal_loop_entries WHERE goal_id = ? AND kind = ? AND day = ? AND withdrawn_at IS NULL', [goal.goalId, kind, day]);
  if (held) return { ok: true, already: true, id: held.id };
  const at = new Date(nowMs).toISOString();
  const r = db.run('INSERT INTO goal_loop_entries (goal_id, kind, day, note, created_at) VALUES (?, ?, ?, ?, ?)',
    [goal.goalId, kind, day, note ? String(note).slice(0, 200) : null, at]);
  const id = r && (r.lastInsertRowid ?? r.lastID);
  if (kind === 'plan') _event(goal.goalId, weekStart(day), 'planned', `${day}:manual`, { day, source: 'manual' }, at, 'nick');
  refresh({ now: nowMs });
  return { ok: true, id: id == null ? null : Number(id) };
}

function withdraw(id, { now = Date.now() } = {}) {
  const r = db.get('SELECT * FROM goal_loop_entries WHERE id = ?', [id]);
  if (!r) return { ok: false, status: 404, error: 'no such entry' };
  if (r.withdrawn_at) return { ok: true, already: true };
  const at = new Date(now instanceof Date ? now.getTime() : now).toISOString();
  db.run('UPDATE goal_loop_entries SET withdrawn_at = ? WHERE id = ?', [at, id]);
  // The earlier "done" / "planned" line is history and stays; this says it was taken back.
  _event(r.goal_id, weekStart(r.day), 'withdrawn', `${r.kind}:${r.id}`, { day: r.day, kind: r.kind }, at, 'nick');
  return { ok: true };
}

function events({ since = null, limit = 200 } = {}) {
  return (since
    ? db.all('SELECT * FROM goal_loop_events WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?', [since, limit])
    : db.all('SELECT * FROM goal_loop_events ORDER BY at DESC, id DESC LIMIT ?', [limit]))
    .map((r) => ({ id: r.id, goalId: r.goal_id, weekStart: r.week_start, kind: r.kind, actor: r.actor, at: r.at, detail: JSON.parse(r.detail_json || '{}') }));
}

module.exports = {
  LIKELY_STEPS, LIKELY_WALK_MIN, RELIABLE_MIN_RECORDED_90D, HIKE_WORDS,
  localDay, addDays, weekStart, weekDays, dayName, entryDay, findGoal, reliability, weekState,
  read, refresh, addEntry, withdraw, entries, events,
};
