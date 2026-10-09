'use strict';

/**
 * The first personal loop: "Hike weekly" (Build 15S–X, 6 Oct 2026; the
 * confirmation rule REPLACED in Build 17A, 7 Oct 2026).
 *
 * It exists only while Nick has an ACTIVE goal that says so — no goal, no
 * loop. It helps him remember the goal, see the plan, and tell PLANNED from
 * RECORDED from UNKNOWN. It is not an exercise nag: it never says missed,
 * failed, should or behind (pinned by a forbidden-wording test), it pushes
 * nothing, and the one thing it may "prepare" late in a week is a line on the
 * loop's own screen.
 *
 * ── What confirms a hike (Build 17A — Nick's rule, 7 Oct 2026) ─────────────
 *
 *   confirmed      a valid GPS TRACK arrived within 24h of the activity, OR
 *                  Nick said so. Nothing else.
 *   not_hike       24h have passed, no valid track, and location recording
 *                  was WORKING that day — so the absence means something.
 *   recording_gap  24h have passed and the absence means nothing: location
 *                  recording was unavailable that day, or a hike workout
 *                  arrived without its route.
 *   planned        a hike is in the plan for a day still to come.
 *   unknown        ONLY while the 24h window after the activity is open.
 *
 * Nick's word wins both ways: a confirmation beats a missing track, and a
 * denial ("that wasn't a hike") beats a track.
 *
 * ⚠ STEPS, WALKING DISTANCE, DURATION AND ROUTE-LIKE MOVEMENT NEVER CONFIRM.
 * Build 15/16 called an 18,000-step day "likely" and the line persisted for
 * weeks; 19 Sep (18,122 steps, 8.3 km) was not a hike. A big day is now only
 * a question while its 24h window is open, and after that it is answered.
 *
 * ── What a GPS track IS (17B) ──────────────────────────────────────────────
 *
 * A route RECORDED WITH A WORKOUT (HealthKit's workout route, sent by NeuroKit
 * as a summary — point count and first/last timestamp, never coordinates) on a
 * Hiking workout, or a Walking workout of at least WALK_TRACK_MIN minutes:
 *   • at least MIN_TRACK_POINTS GPS fixes,
 *   • timestamped inside the workout (± TRACK_TIME_SLACK_MS),
 *   • RECEIVED by NEURO within 24h of the workout ending.
 * NOT a track: the phone's background location points (significant-change
 * fixes — 41 of them on 19 Sep, which was not a hike), a single fix, a
 * home/work transition, a geofence event, steps, distance, or a workout with
 * no route data.
 *
 * ── Whether the absence is meaningful (17A) ────────────────────────────────
 *
 * Location recording is WORKING for a day when the phone delivered at least
 * one location fix that day AND no non-quiet blindness episode for
 * location.neuro-ios overlaps it. Before the phone ever sent a fix (6 Sep
 * 2026) it was not working at all — so older days are recording gaps, never
 * "not a hike".
 */

const db = require('../db/database');

const LIKELY_STEPS = 18000;          // only ever asks a question inside the window
const LIKELY_WALK_MIN = 120;
const RELIABLE_MIN_RECORDED_90D = 3;
const CONFIRM_BACK_DAYS = 120;
const MIN_RECORDED_STEPS = 200;
const MAX_WEEKS = 26;
const PLAN_AHEAD_DAYS = 60;
// 17B — the track definition.
const CONFIRM_WINDOW_MIN = 24 * 60;
const MIN_TRACK_POINTS = 10;
const WALK_TRACK_MIN = 60;
const TRACK_TIME_SLACK_MS = 15 * 60 * 1000;
const LOCATION_SOURCE = 'location.neuro-ios';
const HIKE_WORDS = /\bhik(e|es|ing)\b/i;
const WEEKLY_WORDS = /\bweekly\b|\bevery week\b|\beach week\b|\ba week\b|\bper week\b/i;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const STATES = Object.freeze(['confirmed', 'not_hike', 'recording_gap', 'planned', 'unknown']);

// ── dates (wall clock, Europe/London; never re-zoned) ───────────────────────

function localMinute(ms) { return require('./world-model').localMinute(ms); }
function localDay(nowMs) { return localMinute(nowMs).slice(0, 10); }
function _utc(day) { return Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)); }
function addDays(day, n) { return new Date(_utc(day) + n * 86400000).toISOString().slice(0, 10); }
function dayName(day) { return DAYS[new Date(_utc(day)).getUTCDay()]; }
/** Monday of the week containing `day`. */
function weekStart(day) { const dow = new Date(_utc(day)).getUTCDay(); return addDays(day, -((dow + 6) % 7)); }
function weekDays(start) { return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(start, i)); }
/** A wall-clock minute string shifted by minutes (no zone involved). */
function shiftLocal(local, min) {
  const t = Date.UTC(+local.slice(0, 4), +local.slice(5, 7) - 1, +local.slice(8, 10), +local.slice(11, 13), +local.slice(14, 16)) + min * 60000;
  return new Date(t).toISOString().slice(0, 16);
}

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

/** Pure. How often hikes were recorded as workouts — reported, never a verdict. */
function reliability({ recorded90 = 0, plannedPast = [], recordedOnPlanned = 0 }) {
  if (recorded90 >= RELIABLE_MIN_RECORDED_90D && (!plannedPast.length || recordedOnPlanned / plannedPast.length >= 0.5)) {
    return { level: 'ok', why: `${recorded90} hikes recorded as workouts in the last 90 days` };
  }
  const parts = [`${recorded90} hike${recorded90 === 1 ? '' : 's'} recorded as a workout in the last 90 days`];
  if (plannedPast.length) parts.push(`${recordedOnPlanned} of ${plannedPast.length} planned hike days had one`);
  return { level: 'unreliable', why: parts.join(', and ') };
}

/**
 * Pure. Is this workout's route a valid GPS TRACK under 17B?
 * @param w { type, mins, startMs, endMs, track: { pointCount, firstMs, lastMs, receivedMs } | null }
 * @returns { valid, why }
 */
function trackVerdict(w) {
  if (!w || !w.track) return { valid: false, why: 'no route recorded with the workout' };
  const t = w.track;
  if (!/hik/i.test(w.type) && !(/walk/i.test(w.type) && (w.mins || 0) >= WALK_TRACK_MIN)) {
    return { valid: false, why: /walk/i.test(w.type) ? `a walk under ${WALK_TRACK_MIN} minutes is not a hike` : `a ${w.type} route is not a hike` };
  }
  if (!Number.isFinite(t.pointCount) || t.pointCount < MIN_TRACK_POINTS) return { valid: false, why: `only ${t.pointCount || 0} GPS fixes — not a track` };
  if (!Number.isFinite(w.startMs) || !Number.isFinite(w.endMs) || !Number.isFinite(t.firstMs) || !Number.isFinite(t.lastMs)) return { valid: false, why: 'the route has no usable timestamps' };
  if (t.firstMs < w.startMs - TRACK_TIME_SLACK_MS || t.lastMs > w.endMs + TRACK_TIME_SLACK_MS) return { valid: false, why: 'the route is timestamped outside the workout' };
  if (!Number.isFinite(t.receivedMs)) return { valid: false, why: 'when the route arrived is not known' };
  if (t.receivedMs > w.endMs + CONFIRM_WINDOW_MIN * 60000) return { valid: false, late: true, why: 'the route arrived more than 24 hours after the workout' };
  return { valid: true, why: `${t.pointCount} GPS fixes recorded with the workout` };
}

/**
 * Build 16N, kept: the bounded evidence for one day. Facts only — steps,
 * walking distance (km), and any hike/walk workouts with whether a track came.
 * Distance and steps are SHOWN; they confirm nothing. PURE.
 */
function evidenceFor(day, { steps = {}, distance = {}, workouts = [], location = {} } = {}) {
  const s = steps[day];
  const km = distance[day];
  const loc = location[day];
  return {
    day,
    steps: typeof s === 'number' ? Math.round(s) : null,
    distanceKm: typeof km === 'number' ? Math.round(km * 10) / 10 : null,
    workouts: workouts.filter((w) => w.day === day && /hik|walk/i.test(w.type))
      .map((w) => ({ type: w.type, minutes: w.mins || null, track: trackVerdict(w).valid })),
    location: loc ? loc.working : null,
    recorded: typeof s === 'number' && s >= MIN_RECORDED_STEPS,
  };
}

/** The local minute the 24h confirmation window for a day closes. PURE. */
function windowClosesAt(day, workoutsThatDay = []) {
  const dayEnd = `${addDays(day, 1)}T00:00`;
  const ends = workoutsThatDay.map((w) => w.endLocal).filter(Boolean);
  const latest = ends.length ? ends.sort().pop() : null;
  // The day's own end is the activity's end when no workout says otherwise.
  return shiftLocal(latest && latest > dayEnd ? latest : dayEnd, CONFIRM_WINDOW_MIN);
}

/**
 * Pure. One day, one verdict under 17A. Nick's word beats everything; a valid
 * track confirms; inside the window the honest answer is "unknown"; after it,
 * the absence is either meaningful (not_hike) or not (recording_gap).
 */
function judgeDay(day, { nowLocal, workouts = [], confirms = [], denials = [], location = {} }) {
  const denial = denials.find((d) => d.day === day);
  if (denial) return { day, state: 'not_hike', by: 'you', why: 'you said it was not a hike' };
  const confirm = confirms.find((c) => c.day === day);
  if (confirm) return { day, state: 'confirmed', by: 'you', why: 'you confirmed it', entryId: confirm.id || null };
  const ofDay = workouts.filter((w) => w.day === day);
  const tracked = ofDay.find((w) => trackVerdict(w).valid);
  if (tracked) return { day, state: 'confirmed', by: 'gps-track', why: trackVerdict(tracked).why, minutes: tracked.mins || null };
  const closesAt = windowClosesAt(day, ofDay);
  if (nowLocal < closesAt) return { day, state: 'unknown', closesAt, why: 'the 24-hour window for a GPS track is still open' };
  const hikeWithoutRoute = ofDay.find((w) => /hik/i.test(w.type) && !trackVerdict(w).valid);
  if (hikeWithoutRoute) {
    const v = trackVerdict(hikeWithoutRoute);
    return { day, state: 'recording_gap', why: v.late ? 'the hike workout\'s route arrived too late to count' : 'a hike workout arrived without its GPS route' };
  }
  const loc = location[day];
  if (!loc || loc.working !== true) return { day, state: 'recording_gap', why: (loc && loc.why) || 'location recording was unavailable' };
  return { day, state: 'not_hike', why: 'no GPS track within 24 hours, and location recording was working' };
}

/**
 * Pure. One week, one result.
 * @param i { start, today, nowLocal, plans:[{day,source}], workouts:[{day,type,mins,startMs,endMs,endLocal,track}],
 *            confirms:[{day,id}], denials:[{day,id}], steps, distance, location:{day:{working,why}}, rel }
 */
function weekState({ start, today, nowLocal = null, plans = [], workouts = [], confirms = [], denials = [], steps = {}, distance = {}, location = {}, rel = { level: 'unreliable' } }) {
  const now = nowLocal || `${today}T12:00`;
  const days = weekDays(start);
  const inWeek = (d) => d >= days[0] && d <= days[6];
  const closed = today > days[6];
  const planned = [...new Map(plans.filter((p) => inWeek(p.day)).map((p) => [`${p.day}:${p.source}`, p])).values()]
    .sort((a, b) => a.day.localeCompare(b.day));

  // Candidate days: anything that could have been a hike. Only elapsed days
  // (today included) are judged; a plan still to come is just a plan.
  const cand = new Set();
  // A plan for TODAY is still a plan until the day is over.
  for (const p of planned) if (p.day < today) cand.add(p.day);
  for (const c of confirms) if (inWeek(c.day)) cand.add(c.day);
  for (const d of denials) if (inWeek(d.day)) cand.add(d.day);
  for (const w of workouts) if (inWeek(w.day) && w.day <= today && /hik|walk/i.test(w.type)) cand.add(w.day);
  for (const d of days) {
    if (d > today) continue;
    if (typeof steps[d] === 'number' && steps[d] >= LIKELY_STEPS) cand.add(d);
  }
  const verdicts = [...cand].sort().map((d) => judgeDay(d, { nowLocal: now, workouts, confirms, denials, location }));
  // A big-step day only matters while its window is open; once answered as
  // not_hike it is an ordinary day and not worth a line of its own.
  const confirmed = verdicts.filter((v) => v.state === 'confirmed');
  const open = verdicts.filter((v) => v.state === 'unknown');
  const gaps = verdicts.filter((v) => v.state === 'recording_gap');
  const nextPlan = planned.find((p) => p.day >= today && !verdicts.some((v) => v.day === p.day)) || null;
  // Whole days with no location at all, when nothing points at a hike.
  const blindDays = days.filter((d) => d < today && !(location[d] && location[d].working === true));
  const dow = new Date(_utc(today)).getUTCDay(); // 0 Sun … 6 Sat
  const lateInWeek = !closed && (dow === 0 || dow >= 4);
  const bundle = (d) => evidenceFor(d, { steps, distance, workouts, location });

  let recording; let line; let needsNick = null; let result;
  if (confirmed.length) {
    const c = confirmed[0];
    recording = 'confirmed';
    line = `Hike confirmed — ${dayName(c.day)}${c.by === 'you' ? ' (you confirmed it)' : ' (GPS track)'}.`;
    result = 'done';
  } else if (open.length) {
    const o = open[0];
    recording = 'unknown';
    const closesDay = o.closesAt.slice(0, 10);
    line = `Was ${dayName(o.day)} a hike? A GPS track or your word settles it by ${dayName(closesDay)} ${o.closesAt.slice(11, 16)}.`;
    needsNick = { kind: 'confirm', day: o.day, why: 'inside the 24-hour window', evidence: bundle(o.day) };
    result = 'pending';
  } else if (nextPlan && !closed) {
    recording = 'planned';
    line = `${dayName(nextPlan.day)} hike planned.`;
    result = 'in-progress';
  } else if (gaps.length) {
    const g = gaps[gaps.length - 1];
    recording = 'recording_gap';
    line = /route/.test(g.why) ? `I can't tell — ${dayName(g.day)}'s hike workout came without its GPS route.` : "I can't tell — location recording was unavailable.";
    needsNick = { kind: 'confirm', day: g.day, why: g.why, evidence: bundle(g.day) };
    result = closed ? 'cant-tell' : 'in-progress';
  } else if (!verdicts.length && blindDays.length && blindDays.length === days.filter((d) => d < today).length) {
    // Nothing points at a hike, and the phone recorded no location at all.
    recording = 'recording_gap';
    line = "I can't tell — location recording was unavailable.";
    result = closed ? 'cant-tell' : 'in-progress';
  } else {
    recording = 'not_hike';
    if (closed) line = 'No hike recorded this week.';
    else if (verdicts.length) line = 'No hike recorded so far this week.';
    else line = 'No hike planned yet this week.';
    if (!closed && !planned.some((p) => p.day >= today) && lateInWeek) needsNick = { kind: 'plan', day: null, why: 'nothing planned and the weekend is close' };
    result = closed ? 'none-recorded' : 'in-progress';
  }
  return {
    start, end: days[6], closed, planned, days: verdicts, confirmed, gaps, recording, reliability: rel.level, line, needsNick, result,
    evidence: [...new Set([...planned.map((p) => p.day), ...verdicts.map((v) => v.day)])].filter((d) => d <= today).sort().map(bundle),
  };
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

/**
 * Build 29L: a HIKE route plan Nick dated (Life → Outdoor) is a plan exactly
 * like a calendar entry — a plan, never evidence. Cancelled plans are not
 * plans. No table (older DB) = no route plans.
 */
function _plansFromRoutes(fromDay, toDay) {
  try {
    return db.all(`SELECT route_id, name, planned_date FROM outdoor_routes WHERE kind = 'hike' AND status = 'planned'
                    AND planned_date >= ? AND planned_date <= ?`, [fromDay, toDay])
      .map((r) => ({ day: r.planned_date, source: 'route', routeId: r.route_id, name: r.name }));
  } catch { return []; }
}

function entries(goalId) {
  return db.all(`SELECT * FROM goal_loop_entries WHERE goal_id = ? AND withdrawn_at IS NULL ORDER BY day`, [goalId])
    .map((r) => ({ id: r.id, kind: r.kind, day: r.day, note: r.note, createdAt: r.created_at }));
}

function denials(goalId) {
  try {
    return db.all(`SELECT * FROM goal_loop_denials WHERE goal_id = ? AND withdrawn_at IS NULL ORDER BY day`, [goalId])
      .map((r) => ({ id: r.id, kind: 'deny', day: r.day, note: r.note, createdAt: r.created_at }));
  } catch { return []; }
}

/**
 * A timestamp in any of the shapes that reach here: SQLite UTC
 * ('2026-10-03 10:00:00'), ISO with Z, or NeuroKit's HAE shape
 * ('2026-10-03 10:00:00 +0100'). No zone means UTC. NaN when unreadable.
 */
function _sqlMs(s) {
  if (!s) return NaN;
  const m = String(s).trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return NaN;
  let zone = m[3] || 'Z';
  if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return Date.parse(`${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}${zone.toUpperCase()}`);
}

/** The workout's route summary from its payload (NeuroKit's `route`), or null. PURE. */
function routeFromPayload(payloadJson, createdAt) {
  let p = null;
  try { p = payloadJson ? JSON.parse(payloadJson) : null; } catch { p = null; }
  const r = p && p.route;
  if (!r || typeof r !== 'object') return null;
  return {
    pointCount: Number(r.pointCount),
    firstMs: _sqlMs(r.firstAt || r.startedAt),
    lastMs: _sqlMs(r.lastAt || r.endedAt),
    // When THIS route reached NEURO (stamped at ingest); the row's own insert
    // time only for a route stored before the stamp existed.
    receivedMs: _sqlMs(r.receivedAt || createdAt),
  };
}

function _workouts(fromDay, toDay) {
  return db.all(`SELECT activity_type, started_at, ended_at, duration_seconds, payload, created_at FROM health_workouts
                  WHERE substr(started_at,1,10) >= ? AND substr(started_at,1,10) <= ?`, [addDays(fromDay, -1), addDays(toDay, 1)])
    .map((w) => {
      const startMs = _sqlMs(w.started_at);
      const endMs = w.ended_at ? _sqlMs(w.ended_at) : (w.duration_seconds ? startMs + w.duration_seconds * 1000 : NaN);
      return {
        day: Number.isFinite(startMs) ? localDay(startMs) : String(w.started_at).slice(0, 10),
        type: w.activity_type || '',
        mins: w.duration_seconds ? Math.round(w.duration_seconds / 60) : (Number.isFinite(endMs) ? Math.round((endMs - startMs) / 60000) : null),
        startMs, endMs, endLocal: Number.isFinite(endMs) ? localMinute(endMs) : null,
        track: routeFromPayload(w.payload, w.created_at),
      };
    }).filter((w) => w.day >= fromDay && w.day <= toDay);
}

function _steps(fromDay, toDay) {
  const out = {};
  for (const r of db.all('SELECT day, steps FROM health_daily WHERE day >= ? AND day <= ?', [fromDay, toDay])) out[r.day] = r.steps == null ? null : Number(r.steps);
  return out;
}

/** Daily walking distance in km from NeuroKit's metric. Absent = not measured. */
function _distance(fromDay, toDay) {
  const out = {};
  try {
    for (const r of db.all(`SELECT substr(recorded_at,1,10) day, SUM(value) km FROM health_samples
                             WHERE metric = 'walking_running_distance' AND recorded_at >= ? AND recorded_at < ?
                             GROUP BY 1`, [fromDay, addDays(toDay, 1)])) out[r.day] = Number(r.km);
  } catch { /* unreadable: distance stays unknown */ }
  return out;
}

/**
 * Pure. Was location recording WORKING each day? A fix delivered that day,
 * and no non-quiet blindness episode overlapping it. Before the first fix ever
 * delivered, recording did not exist.
 * @param pointDays  Set of local days with at least one fix
 * @param firstDay   the first local day the phone ever sent a fix (or null)
 * @param episodes   [{ fromDay, toDay }] blindness episodes (quiet ones excluded)
 */
function locationByDay(days, { pointDays = new Set(), firstDay = null, episodes = [] } = {}) {
  const out = {};
  for (const d of days) {
    if (!firstDay || d < firstDay) { out[d] = { working: false, why: 'the phone was not recording location yet' }; continue; }
    const ep = episodes.find((e) => e.fromDay <= d && d <= e.toDay);
    if (ep) { out[d] = { working: false, why: 'the phone had stopped sending location' }; continue; }
    out[d] = pointDays.has(d) ? { working: true } : { working: false, why: 'the phone sent no location that day' };
  }
  return out;
}

function _location(fromDay, toDay) {
  const days = [];
  for (let d = fromDay; d <= toDay; d = addDays(d, 1)) days.push(d);
  let firstDay = null; const pointDays = new Set(); const episodes = [];
  try {
    const first = db.get('SELECT MIN(tst) t FROM location_points');
    firstDay = first && first.t ? localDay(first.t * 1000) : null;
    const lo = Math.floor(_utc(addDays(fromDay, -1)) / 1000); const hi = Math.floor(_utc(addDays(toDay, 2)) / 1000);
    for (const r of db.all('SELECT tst FROM location_points WHERE tst >= ? AND tst < ?', [lo, hi])) pointDays.add(localDay(r.tst * 1000));
  } catch { /* unreadable: every day reads as not working */ }
  try {
    for (const f of db.all(`SELECT basis_at, first_detected_at, resolved_at, resolution FROM source_blind_findings WHERE source_id = ?`, [LOCATION_SOURCE])) {
      if (f.resolution === 'transport-alive' || f.resolution === 'retired') continue;
      const from = Date.parse(f.basis_at || f.first_detected_at);
      const to = f.resolved_at ? Date.parse(f.resolved_at) : Date.now();
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      // A blindness episode means NOTHING arrived between its basis and its
      // recovery: only days wholly inside it lost their recording.
      episodes.push({ fromDay: addDays(localDay(from), 1), toDay: addDays(localDay(to), -1) });
    }
  } catch { /* no spine: points alone decide */ }
  return locationByDay(days, { pointDays, firstDay, episodes: episodes.filter((e) => e.fromDay <= e.toDay) });
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

/**
 * Build 29: hike plans from today up to `days` ahead, by the loop's OWN rule
 * (calendar entries titled hiking, dated hike route plans, Nick's manual
 * plans) — so Outdoor never re-implements what counts as a planned hike.
 */
function plansAhead({ now = Date.now(), days = 14 } = {}) {
  const today = localDay(now instanceof Date ? now.getTime() : now);
  const to = addDays(today, days);
  const goal = findGoal(_goals());
  const manual = goal ? entries(goal.goalId).filter((e) => e.kind === 'plan' && e.day >= today && e.day <= to)
    .map((e) => ({ day: e.day, source: 'manual', id: e.id })) : [];
  const all = [..._plansFromCalendar(today, to, today), ..._plansFromRoutes(today, to), ...manual];
  return [...new Map(all.map((p) => [`${p.day}:${p.source}:${p.routeId || ''}`, p])).values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** The loop, read now. `{ active:false }` when there is no explicit goal. */
function read({ now = Date.now(), weeks = 6 } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  weeks = Math.max(1, Math.min(MAX_WEEKS, Math.floor(Number(weeks)) || 6));
  const goal = findGoal(_goals());
  if (!goal) return { active: false, why: 'no active "hike weekly" goal — the loop only runs for an explicit goal' };
  const nowLocal = localMinute(nowMs);
  const today = nowLocal.slice(0, 10);
  const thisWeek = weekStart(today);
  const first = addDays(thisWeek, -7 * (weeks - 1));
  const last = addDays(thisWeek, 6);
  const rel = _reliability(today);
  const manual = entries(goal.goalId);
  const denied = denials(goal.goalId);
  const plans = [..._plansFromCalendar(first, last, today), ..._plansFromRoutes(first, last),
    ...manual.filter((e) => e.kind === 'plan').map((e) => ({ day: e.day, source: 'manual', id: e.id }))];
  const confirms = manual.filter((e) => e.kind === 'confirm');
  const workouts = _workouts(first, last);
  const steps = _steps(first, last);
  const distance = _distance(first, last);
  const location = _location(first, today);
  const out = [];
  for (let i = 0; i < weeks; i += 1) {
    const start = addDays(first, 7 * i);
    out.push(weekState({ start, today, nowLocal, plans, workouts, confirms, denials: denied, steps, distance, location, rel }));
  }
  const confirmedDays = out.flatMap((w) => w.confirmed.map((c) => c.day)).sort();
  const lastConfirmed = confirmedDays.length ? confirmedDays[confirmedDays.length - 1] : null;
  return {
    active: true, goal, today, weekStart: thisWeek,
    current: out[out.length - 1], weeks: out.slice().reverse(),
    reliability: rel, lastConfirmed, entries: [...manual, ...denied],
    confirmBackDays: CONFIRM_BACK_DAYS,
    rule: 'A hike is confirmed by a GPS track recorded with a workout and received within 24 hours, or by you. Steps and distance never confirm.',
  };
}

// ── transitions → goal_loop_events (what Activity shows) ───────────────────

function _event(goalId, week, kind, key, detail, at, actor = 'neuro') {
  return db.run(`INSERT OR IGNORE INTO goal_loop_events (goal_id, week_start, kind, dedupe_key, actor, at, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [goalId, week, kind, `${goalId}:${week}:${kind}:${key}`, actor, at, JSON.stringify(detail || {})]).changes;
}

/**
 * Record what CHANGED, once: a plan appearing, a day RESOLVED after its 24h
 * window (17W — one semantic resolution per day and verdict), a gentle prompt
 * being prepared. Idempotent — a rerun writes nothing. Never sends anything.
 * `weeks` reaches back so a migration can resolve history (17C).
 */
function refresh({ now = Date.now(), weeks = 2 } = {}) {
  const loop = read({ now, weeks });
  if (!loop.active) return { active: false, written: 0 };
  const at = new Date(now instanceof Date ? now.getTime() : now).toISOString();
  const gid = loop.goal.goalId;
  let written = 0;
  for (const w of loop.weeks) {
    for (const p of w.planned) written += _event(gid, w.start, 'planned', `${p.day}:${p.source}`, { day: p.day, source: p.source }, at);
    for (const v of w.days) {
      if (v.state === 'unknown') continue;
      // Nick's own statements are recorded by addEntry/deny themselves.
      if (v.by === 'you') continue;
      written += _event(gid, w.start, 'resolved', `${v.day}:${v.state}`, { day: v.day, state: v.state, by: v.by || null, why: v.why }, at);
    }
    if (w.needsNick && w.needsNick.kind === 'plan') written += _event(gid, w.start, 'reminder-prepared', 'plan', { why: w.needsNick.why }, at);
  }
  return { active: true, written };
}

/** Nick says a hike happened, plans one, or says a day was NOT a hike. A statement, recorded as his. */
function addEntry(kind, { day, note = null, now = Date.now() }) {
  if (!['confirm', 'plan', 'deny'].includes(kind)) return { ok: false, status: 400, error: 'kind must be confirm, plan or deny' };
  const goal = findGoal(_goals());
  if (!goal) return { ok: false, status: 409, error: 'There is no active "hike weekly" goal, so there is no loop to record against.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) || !Number.isFinite(_utc(day))) return { ok: false, status: 400, error: 'day must be YYYY-MM-DD' };
  const nowMs = now instanceof Date ? now.getTime() : now;
  const today = localDay(nowMs);
  if (kind !== 'plan' && (day > today || day < addDays(today, -CONFIRM_BACK_DAYS))) return { ok: false, status: 400, error: `a hike can be confirmed or ruled out for today or the last ${CONFIRM_BACK_DAYS} days` };
  if (kind === 'plan' && (day < today || day > addDays(today, PLAN_AHEAD_DAYS))) return { ok: false, status: 400, error: `a hike can be planned from today up to ${PLAN_AHEAD_DAYS} days ahead` };
  const at = new Date(nowMs).toISOString();
  const clean = note ? String(note).slice(0, 200) : null;
  if (kind === 'deny') {
    const held = db.get('SELECT id FROM goal_loop_denials WHERE goal_id = ? AND day = ? AND withdrawn_at IS NULL', [goal.goalId, day]);
    if (held) return { ok: true, already: true, id: held.id };
    // A denial replaces Nick's own earlier confirmation of the same day.
    for (const c of db.all(`SELECT id FROM goal_loop_entries WHERE goal_id = ? AND kind = 'confirm' AND day = ? AND withdrawn_at IS NULL`, [goal.goalId, day])) withdraw(c.id, { now: nowMs });
    const r = db.run('INSERT INTO goal_loop_denials (goal_id, day, note, created_at) VALUES (?, ?, ?, ?)', [goal.goalId, day, clean, at]);
    const id = r && (r.lastInsertRowid ?? r.lastID);
    _event(goal.goalId, weekStart(day), 'resolved', `${day}:not_hike:you:${id}`, { day, state: 'not_hike', by: 'you', why: 'you said it was not a hike' }, at, 'nick');
    return { ok: true, id: id == null ? null : Number(id) };
  }
  const held = db.get('SELECT id FROM goal_loop_entries WHERE goal_id = ? AND kind = ? AND day = ? AND withdrawn_at IS NULL', [goal.goalId, kind, day]);
  if (held) return { ok: true, already: true, id: held.id };
  if (kind === 'confirm') {
    for (const d of db.all('SELECT id FROM goal_loop_denials WHERE goal_id = ? AND day = ? AND withdrawn_at IS NULL', [goal.goalId, day])) withdrawDenial(d.id, { now: nowMs });
  }
  const r = db.run('INSERT INTO goal_loop_entries (goal_id, kind, day, note, created_at) VALUES (?, ?, ?, ?, ?)',
    [goal.goalId, kind, day, clean, at]);
  const id = r && (r.lastInsertRowid ?? r.lastID);
  if (kind === 'plan') _event(goal.goalId, weekStart(day), 'planned', `${day}:manual`, { day, source: 'manual' }, at, 'nick');
  if (kind === 'confirm') _event(goal.goalId, weekStart(day), 'achieved', `${day}:you:${id}`, { day, by: 'you' }, at, 'nick');
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

function withdrawDenial(id, { now = Date.now() } = {}) {
  const r = db.get('SELECT * FROM goal_loop_denials WHERE id = ?', [id]);
  if (!r) return { ok: false, status: 404, error: 'no such denial' };
  if (r.withdrawn_at) return { ok: true, already: true };
  const at = new Date(now instanceof Date ? now.getTime() : now).toISOString();
  db.run('UPDATE goal_loop_denials SET withdrawn_at = ? WHERE id = ?', [at, id]);
  _event(r.goal_id, weekStart(r.day), 'withdrawn', `deny:${r.id}`, { day: r.day, kind: 'deny' }, at, 'nick');
  return { ok: true };
}

function events({ since = null, limit = 200 } = {}) {
  return (since
    ? db.all('SELECT * FROM goal_loop_events WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?', [since, limit])
    : db.all('SELECT * FROM goal_loop_events ORDER BY at DESC, id DESC LIMIT ?', [limit]))
    .map((r) => ({ id: r.id, goalId: r.goal_id, weekStart: r.week_start, kind: r.kind, actor: r.actor, at: r.at, detail: JSON.parse(r.detail_json || '{}') }));
}

module.exports = {
  LIKELY_STEPS, LIKELY_WALK_MIN, RELIABLE_MIN_RECORDED_90D, HIKE_WORDS, CONFIRM_BACK_DAYS, MIN_RECORDED_STEPS, MAX_WEEKS,
  CONFIRM_WINDOW_MIN, MIN_TRACK_POINTS, WALK_TRACK_MIN, STATES,
  localDay, addDays, weekStart, weekDays, dayName, entryDay, findGoal, reliability, weekState, evidenceFor,
  trackVerdict, judgeDay, windowClosesAt, locationByDay, routeFromPayload, parseStamp: _sqlMs,
  read, refresh, addEntry, plansAhead, withdraw, withdrawDenial, entries, denials, events,
};
