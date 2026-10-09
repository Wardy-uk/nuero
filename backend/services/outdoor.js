'use strict';

/**
 * Outdoor Life — store and reader (Build 29, 9 Oct 2026). Contract `outdoor-v1`.
 *
 *   read()        Life → Outdoor: this week, the Hike weekly goal, confirmed
 *                 hikes, walks, what NEURO refused to call a hike, route plans,
 *                 the next outing and its weather, outdoor source health.
 *   nowBlock()    the compact block on canonical Now — quiet unless relevant.
 *   refresh()     the ONLY network call: Home Assistant's daily forecast, cached
 *                 for the read. Run by the personal-ops durable job.
 *   createRoute / updateRoute / linkRoute / unlinkRoute / addCompanion /
 *   removeCompanion   Nick's explicit statements; each one audited in
 *                 personal_ops_events (append-only).
 *
 * ⚠ Reads WRITE NOTHING — not a movement log, not a cache. Pinned.
 * ⚠ No activity table. Activities are composed at read time from the workouts
 *   Apple Health already sent and the hiking loop's verdicts; NEURO keeps only
 *   Nick's links and his route plans. No coordinates of where he WENT are
 *   stored or returned — a plan's geometry is stored, never returned.
 * ⚠ The hike verdict is hiking-loop.js's. Nothing here can make a day a hike.
 */

const model = require('./outdoor-model');
const loop = require('./hiking-loop');

const CONTRACT = 'outdoor-v1';
const FORECAST_KEY = 'outdoor_daily_forecast';
const FORECAST_MAX_AGE_MS = 12 * 3600 * 1000;
const ROUTE_ROLE_DAYS_BACK = 120;
const ROUTE_ROLE_DAYS_AHEAD = 180;
const DIFFICULTIES = ['easy', 'moderate', 'hard'];
const AHEAD_DAYS = 14;

function _db() { return require('../db/database'); }
function _localMinute(ms) { return require('./world-model').localMinute(ms); }
function _isDay(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s; }
function _json(s, d) { try { return s ? JSON.parse(s) : d; } catch { return d; } }

/** A wall-clock hour on a local day → epoch ms (Europe/London), via the world model's own zone rule. */
function _localToMs(day, hh) {
  const guess = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), hh);
  const shown = _localMinute(guess);
  const shownMs = Date.UTC(+shown.slice(0, 4), +shown.slice(5, 7) - 1, +shown.slice(8, 10), +shown.slice(11, 13), +shown.slice(14, 16));
  return guess - (shownMs - guess);
}

// ── weather (read-only, never a forecast engine) ───────────────────────────

function _dailyCache(nowMs) {
  let c = null;
  try { c = _json(_db().getState(FORECAST_KEY), null); } catch { c = null; }
  if (!c || !c.fetchedAt) return { known: false, why: 'no daily forecast fetched yet' };
  const age = nowMs - Date.parse(c.fetchedAt);
  if (!(age >= 0) || age > FORECAST_MAX_AGE_MS) return { known: false, why: 'the daily forecast is more than 12 hours old', fetchedAt: c.fetchedAt };
  return c.known ? { known: true, days: c.days || [], fetchedAt: c.fetchedAt } : { known: false, why: c.why || 'unreadable', fetchedAt: c.fetchedAt };
}

/** The day's weather context: the forecast NEURO already keeps (hourly, daytime) + HA's daily answer. */
function weatherFor(day, { nowMs, daily = null } = {}) {
  let hourly = [];
  try {
    const wf = require('./weather-forecast');
    hourly = wf.standingBetween(_localToMs(day, 8), _localToMs(day, 18), nowMs).points
      .map((p) => ({ precipMm: p.precipMm, precipProb: p.precipProb, tempC: p.temperatureC }));
  } catch { hourly = []; }
  const d = daily && daily.known ? (daily.days || []).find((x) => x.date === day) || null : null;
  return { day, ...model.suitability({ hourly, daily: d }), sources: [hourly.length ? 'hourly forecast (Open-Meteo)' : null, d ? "Home Assistant's daily forecast" : null].filter(Boolean) };
}

/** Weather context for a day, from what NEURO already holds (no network). */
function weatherNear(day, nowMs = Date.now()) { return weatherFor(day, { nowMs, daily: _dailyCache(nowMs) }); }

// ── source health (29AC) ───────────────────────────────────────────────────

function _sourceRows(prefixes) {
  try {
    return _db().all(`SELECT source_id, state, freshness, last_success_at, lifecycle FROM source_health WHERE ${prefixes.map(() => 'source_id = ?').join(' OR ')}`, prefixes);
  } catch { return []; }
}

function _verdict(rows) {
  const live = rows.filter((r) => r.lifecycle !== 'retired');
  if (!live.length) return 'unknown';
  if (live.some((r) => r.state !== 'failing' && r.freshness === 'fresh')) return 'healthy';
  if (live.every((r) => r.state === 'failing')) return 'failing';
  return 'stale';
}

function sourceHealth({ nowMs = Date.now() } = {}) {
  const db = _db();
  const out = [];
  const hk = _sourceRows(['healthkit.neuro-ios', 'healthkit.saim-ios']);
  let lastWorkout = null;
  try { lastWorkout = db.get(`SELECT MAX(substr(started_at,1,10)) d FROM health_workouts WHERE activity_type LIKE '%hik%' OR activity_type LIKE '%alk%'`).d || null; } catch { lastWorkout = null; }
  const hkState = _verdict(hk);
  out.push({ id: 'workouts', label: 'Workouts (Apple Health)', state: hkState,
    line: hkState === 'healthy' ? `Apple Health is delivering. Last hike or walk workout: ${lastWorkout || 'none'}.`
      : hkState === 'failing' ? 'Apple Health deliveries are failing — open NEURO on the phone so it can send again.'
        : `Apple Health is ${hkState}. Last hike or walk workout: ${lastWorkout || 'none'}.` });
  let declared = false; let routes = 0;
  try { declared = db.all('SELECT capabilities_json FROM native_builds').some((r) => _json(r.capabilities_json, []).includes('workout-route-summary')); } catch { declared = false; }
  try { routes = db.get("SELECT COUNT(*) n FROM health_workouts WHERE json_extract(payload,'$.route') IS NOT NULL").n; } catch { routes = 0; }
  out.push({ id: 'gps-track', label: 'GPS track with a workout', state: routes > 0 ? 'proven' : declared ? 'unproven' : 'unavailable',
    line: routes > 0 ? `${routes} workout route${routes === 1 ? '' : 's'} received — a track can confirm a hike.`
      : declared ? 'The phone build can send a workout route, but none has arrived yet — until one does, only your word can confirm a hike.'
        : 'No phone build that sends workout routes has reported — only your word can confirm a hike.' });
  const loc = _sourceRows(['location.neuro-ios']);
  const locState = _verdict(loc);
  out.push({ id: 'location', label: 'Location recording', state: locState,
    line: locState === 'healthy' ? 'Working — so a day with no track and no word from you is answered as "not a hike".'
      : 'Not working — a day with no track is answered "can\'t tell", never "not a hike".' });
  let issued = null;
  try { issued = db.get("SELECT MAX(issued_at) t FROM weather_forecast_points WHERE provider = 'open-meteo'").t; } catch { issued = null; }
  const daily = _dailyCache(nowMs);
  const hourlyFresh = Number.isFinite(issued) && nowMs - issued < 6 * 3600 * 1000;
  out.push({ id: 'weather', label: 'Weather (context only)', state: hourlyFresh && daily.known ? 'healthy' : hourlyFresh || daily.known ? 'partial' : 'unavailable',
    line: `${hourlyFresh ? 'Hourly forecast fresh' : 'Hourly forecast not fresh'}; ${daily.known ? `daily forecast from ${String(daily.fetchedAt).slice(11, 16)}` : `daily forecast: ${daily.why}`}. Weather never confirms or rules out an activity.` });
  const cal = _sourceRows(['eventkit.neuro-ios', 'eventkit.saim-ios']);
  const calState = _verdict(cal);
  out.push({ id: 'calendar', label: 'Plans (phone calendar)', state: calState, line: calState === 'healthy' ? 'Hike plans from the calendar are current.' : `The phone calendar is ${calState} — plans may be out of date.` });
  let plans = 0; let links = 0;
  try { plans = db.get("SELECT COUNT(*) n FROM outdoor_routes WHERE status = 'planned'").n; } catch { plans = 0; }
  try { links = db.get("SELECT COUNT(*) n FROM outdoor_activity_links WHERE relation = 'companion'").n; } catch { links = 0; }
  out.push({ id: 'routes', label: 'Route plans (GPX / by hand)', state: 'manual', line: `${plans} planned route${plans === 1 ? '' : 's'} you added. Plans are never activity.` });
  out.push({ id: 'alltrails', label: 'AllTrails', state: 'not-connected', line: 'No AllTrails source is connected to NEURO. Export a route as GPX and add it here; AllTrails is never completion evidence.' });
  out.push({ id: 'ember', label: 'Ember on activities', state: 'manual', line: `${links} activit${links === 1 ? 'y' : 'ies'} you marked Ember on. Never inferred from your walking.` });
  return out;
}

// ── composition ────────────────────────────────────────────────────────────

function _links() {
  const by = new Map();
  try {
    for (const r of _db().all('SELECT activity_id, relation, target_id, label, set_at FROM outdoor_activity_links ORDER BY set_at')) {
      by.set(r.activity_id, [...(by.get(r.activity_id) || []), { relation: r.relation, target: r.target_id, label: r.label, setAt: r.set_at }]);
    }
  } catch { /* no table: no links */ }
  return by;
}

function _workouts(fromDay, toDay) {
  return _db().all(`SELECT id, activity_type, started_at, ended_at, duration_seconds, distance_m, elevation_m, payload, created_at FROM health_workouts
                     WHERE (activity_type LIKE '%hik%' OR activity_type LIKE '%alk%') AND substr(started_at,1,10) >= ? AND substr(started_at,1,10) <= ?`,
  [loop.addDays(fromDay, -1), loop.addDays(toDay, 1)]).map((w) => {
    const startMs = loop.parseStamp(w.started_at);
    const endMs = w.ended_at ? loop.parseStamp(w.ended_at) : (w.duration_seconds ? startMs + w.duration_seconds * 1000 : NaN);
    const mins = w.duration_seconds ? Math.round(w.duration_seconds / 60) : null;
    const track = loop.routeFromPayload(w.payload, w.created_at);
    return {
      id: w.id, type: w.activity_type, day: Number.isFinite(startMs) ? loop.localDay(startMs) : String(w.started_at).slice(0, 10),
      mins, distanceKm: w.distance_m != null ? Number(w.distance_m) / 1000 : null, elevationM: w.elevation_m != null ? Number(w.elevation_m) : null,
      startLocal: Number.isFinite(startMs) ? _localMinute(startMs) : null, endLocal: Number.isFinite(endMs) ? _localMinute(endMs) : null,
      hasRoute: !!track, trackValid: loop.trackVerdict({ type: w.activity_type, mins, startMs, endMs, track }).valid,
    };
  }).filter((w) => w.day >= fromDay && w.day <= toDay);
}

function _routeRows() {
  try { return _db().all('SELECT * FROM outdoor_routes ORDER BY COALESCE(planned_date, \'9999\'), created_at'); } catch { return []; }
}

function shapeRoute(r, { linkedBy = [], activities = new Map(), today }) {
  const confirmedLink = linkedBy.find((id) => { const a = activities.get(id); return a && a.state === 'confirmed'; });
  const outcome = r.status === 'cancelled' ? 'cancelled' : confirmedLink ? 'completed'
    : r.planned_date && r.planned_date < today ? 'not-linked' : null;
  return {
    routeId: r.route_id, name: r.name, kind: r.kind, status: r.status, outcome,
    outcomeWhy: outcome === 'completed' ? 'you linked it to a confirmed activity' : outcome === 'not-linked' ? 'its date has passed and no activity is linked to it — unanswered, which says nothing about whether you went' : null,
    plannedDate: r.planned_date, distanceKm: r.distance_km, elevationGainM: r.elevation_gain_m, region: r.region, difficulty: r.difficulty,
    notes: r.notes, emberPlanned: r.ember_planned === 1, source: r.source, pointCount: r.point_count, hasGeometry: !!r.geometry_json,
    sourceLink: r.route_ref || null, linkedActivities: linkedBy,
  };
}

/** The Outdoor Life read. Writes nothing. */
function read({ now = Date.now(), weeks = 4 } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  weeks = Math.max(1, Math.min(loop.MAX_WEEKS, Math.floor(Number(weeks)) || 4));
  const gaps = [];
  const today = loop.localDay(nowMs);
  const thisWeek = loop.weekStart(today);
  const weekEnd = loop.addDays(thisWeek, 6);
  const first = loop.addDays(thisWeek, -7 * (weeks - 1));
  let hiking = null;
  try { hiking = loop.read({ now: nowMs, weeks }); } catch (e) { gaps.push({ input: 'hiking-loop', why: e.message }); }
  const loopActive = !!(hiking && hiking.active);
  const verdictByDay = new Map();
  if (loopActive) for (const w of hiking.weeks) for (const v of w.days) verdictByDay.set(v.day, v);
  const links = _links();
  let workouts = [];
  try { workouts = _workouts(first, weekEnd); } catch (e) { gaps.push({ input: 'workouts', why: e.message }); }

  const activities = workouts.map((w) => model.shapeWorkout(w, { verdict: verdictByDay.get(w.day) || null, links: links.get(`workout:${w.id}`) || [], trackValid: w.trackValid }));
  if (loopActive) {
    for (const e of hiking.entries.filter((x) => x.kind === 'confirm' && x.day >= first)) {
      if (activities.some((a) => a.day === e.day && a.kind === 'hike' && a.state === 'confirmed')) continue;
      activities.push(model.shapeConfirmedDay(e.day, { links: links.get(`hike-day:${e.day}`) || [], note: e.note }));
    }
  }
  activities.sort((a, b) => (b.day + (b.startTime || '')).localeCompare(a.day + (a.startTime || '')));
  const byId = new Map(activities.map((a) => [a.activityId, a]));

  // Route plans, each with what Nick linked to it.
  const linkedByRoute = new Map();
  for (const [aid, ls] of links) for (const l of ls) if (l.relation === 'route') linkedByRoute.set(l.target, [...(linkedByRoute.get(l.target) || []), aid]);
  const routes = _routeRows().map((r) => shapeRoute(r, { linkedBy: linkedByRoute.get(r.route_id) || [], activities: byId, today }));
  for (const a of activities) if (a.route) { const r = routes.find((x) => x.routeId === a.route.routeId); if (r) a.route.name = r.name; }

  // Days NEURO refused to call a hike, with why and the facts it saw.
  const refused = [];
  if (loopActive) {
    for (const w of hiking.weeks) {
      for (const v of w.days) {
        if (v.state !== 'not_hike' && v.state !== 'recording_gap') continue;
        const ev = (w.evidence || []).find((x) => x.day === v.day) || null;
        refused.push({ day: v.day, state: v.state, by: v.by || null, why: v.why,
          saw: ev ? { steps: ev.steps, distanceKm: ev.distanceKm, workouts: ev.workouts } : null });
      }
    }
    refused.sort((a, b) => b.day.localeCompare(a.day));
  }

  // Plans ahead, with weather for the near ones (context only).
  const daily = _dailyCache(nowMs);
  let ahead = [];
  try { ahead = loop.plansAhead({ now: nowMs, days: AHEAD_DAYS }); } catch (e) { gaps.push({ input: 'plans', why: e.message }); }
  const routeById = new Map(routes.map((r) => [r.routeId, r]));
  for (const r of routes) {
    if (r.kind === 'walk' && r.status === 'planned' && r.plannedDate && r.plannedDate >= today && r.plannedDate <= loop.addDays(today, AHEAD_DAYS)) {
      ahead.push({ day: r.plannedDate, source: 'route', routeId: r.routeId, name: r.name });
    }
  }
  const byDay = new Map();
  for (const p of ahead.sort((a, b) => a.day.localeCompare(b.day))) {
    const cur = byDay.get(p.day) || { day: p.day, sources: [], routes: [], kind: 'hike' };
    cur.sources.push(p.source);
    if (p.routeId) { const r = routeById.get(p.routeId); cur.routes.push({ routeId: p.routeId, name: p.name || (r && r.name), emberPlanned: !!(r && r.emberPlanned) }); if (r && r.kind === 'walk' && !cur.sources.some((s) => s !== 'route')) cur.kind = 'walk'; }
    byDay.set(p.day, cur);
  }
  const plans = [...byDay.values()].map((p) => {
    const away = model.daysBetween(today, p.day);
    const label = p.routes.length ? `${p.kind === 'walk' ? 'Walk' : 'Hike'}: ${p.routes.map((r) => r.name).join(', ')}` : 'Hike';
    return { ...p, label, when: model.whenWords(today, p.day), weather: away <= 7 ? weatherFor(p.day, { nowMs, daily }) : null };
  });
  const nextPlan = plans[0] || null;

  const goal = loopActive ? model.goalState(hiking.current) : { state: 'unknown', why: hiking ? hiking.why : 'the hiking loop could not be read' };
  const sources = sourceHealth({ nowMs });
  const src = (id) => sources.find((s) => s.id === id);
  const sourcesHealthy = src('workouts').state === 'healthy' && src('location').state === 'healthy';
  const atRisk = loopActive ? model.goalAtRisk({ goal, today, weekEnd, plans, sourcesHealthy }) : { atRisk: false, why: 'no active hike goal' };
  let daylight = null;
  try {
    const rows = _db().all('SELECT day, daylight_minutes FROM health_daily WHERE day >= ? AND day <= ?', [thisWeek, today]).map((r) => ({ day: r.day, minutes: r.daylight_minutes == null ? null : Number(r.daylight_minutes) }));
    daylight = model.daylightWeek(rows, { start: thisWeek, today });
  } catch (e) { gaps.push({ input: 'daylight', why: e.message }); }
  const thisWeekActs = activities.filter((a) => a.day >= thisWeek && a.day <= weekEnd);
  const sourceGaps = sources.filter((s) => ['failing', 'stale', 'unavailable', 'unproven'].includes(s.state)).map((s) => ({ source: s.label, line: s.line }));
  const summary = model.weeklySummary({ goal, activities: thisWeekActs, nextPlan: nextPlan ? { day: nextPlan.day, when: nextPlan.when, label: nextPlan.label, weather: nextPlan.weather } : null, daylight, gaps: sourceGaps });
  const openQuestion = loopActive && hiking.current.needsNick && hiking.current.needsNick.kind === 'confirm' && goal.state === 'unknown'
    ? { day: hiking.current.needsNick.day, line: hiking.current.line } : null;
  const relevance = model.nowRelevance({ today, goal, plans, atRisk, openQuestion, workoutSource: src('workouts') });
  const companions = (() => { try { return require('./personal-world').listCompanions().map((c) => ({ id: c.id, name: c.name })); } catch { return []; } })();

  return {
    ok: true, contract: CONTRACT, asOf: new Date(nowMs).toISOString(), today, weekStart: thisWeek, weekEnd, weeksShown: weeks,
    week: { convention: 'Monday to Sunday, local time — the hiking loop\'s own week', start: thisWeek, end: weekEnd },
    goal: loopActive ? { goalId: hiking.goal.goalId, title: hiking.goal.title, importance: hiking.goal.importance, ...goal, line: hiking.current.line,
      lastConfirmed: hiking.lastConfirmed, reliability: hiking.reliability, needsNick: hiking.current.needsNick } : null,
    loopActive, atRisk, summary,
    hikes: activities.filter((a) => a.kind === 'hike' && a.state === 'confirmed'),
    hikeGaps: activities.filter((a) => a.kind === 'hike' && a.state !== 'confirmed'),
    walks: activities.filter(model.isMeaningfulWalk),
    shortWalks: activities.filter((a) => ['walk', 'dog_walk'].includes(a.kind) && !model.isMeaningfulWalk(a)).length,
    refused, plans, nextPlan, routes, sources, companions, now: relevance,
    evidence: model.EVIDENCE,
    rule: 'A hike is confirmed by a GPS track recorded with a Hiking workout, or a 60+ minute Walking workout, received within 24 hours — or by you. Steps, distance, routes, plans, weather and Ember never confirm one.',
    gaps,
  };
}

/** Compact Now block. No network, no write. */
function nowBlock({ now = Date.now() } = {}) {
  const r = read({ now, weeks: 1 });
  return {
    relevant: r.now.relevant, items: r.now.items, needsYou: r.now.needsYou,
    goalState: r.goal ? r.goal.state : null, goalLine: r.goal ? r.goal.line : null,
    nextPlan: r.nextPlan ? { day: r.nextPlan.day, when: r.nextPlan.when, label: r.nextPlan.label, weather: r.nextPlan.weather ? { state: r.nextPlan.weather.state, severe: r.nextPlan.weather.severe, line: r.nextPlan.weather.line } : null } : null,
  };
}

/** The durable job body: the one network call — HA's daily forecast — cached for reads. */
async function refresh({ now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  let f;
  try { f = await require('./ha-rooms').readDailyForecast(); } catch (e) { f = { known: false, why: e.message }; }
  const days = f && f.known ? (f.days || []).slice(0, 10) : [];
  _db().setState(FORECAST_KEY, JSON.stringify({ fetchedAt: new Date(nowMs).toISOString(), known: !!(f && f.known), days, why: f && !f.known ? f.why : null }));
  return { ok: true, forecast: !!(f && f.known), days: days.length };
}

// ── Nick's statements ──────────────────────────────────────────────────────

function _log(kind, subjectId, detail, nowMs) {
  return require('./personal-obligations').logEvent(kind, { subjectId, actor: 'nick', detail, dedupeKey: `${kind}:${subjectId}:${nowMs}:${Math.random().toString(36).slice(2, 8)}`, now: nowMs });
}

function _validRouteFields(b, { today, partial = false }) {
  const out = {};
  const err = (e) => ({ error: e });
  if (b.name !== undefined || !partial) {
    if (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 120)) return err('name must be 1–120 characters');
    if (b.name !== undefined) out.name = b.name.trim();
  }
  if (b.kind !== undefined) { if (!['hike', 'walk'].includes(b.kind)) return err('kind must be hike or walk'); out.kind = b.kind; }
  if (b.plannedDate !== undefined) {
    if (b.plannedDate === null) out.planned_date = null;
    else if (!_isDay(b.plannedDate)) return err('plannedDate must be YYYY-MM-DD');
    else if (b.plannedDate < loop.addDays(today, -ROUTE_ROLE_DAYS_BACK) || b.plannedDate > loop.addDays(today, ROUTE_ROLE_DAYS_AHEAD)) return err(`plannedDate must be within ${ROUTE_ROLE_DAYS_BACK} days back and ${ROUTE_ROLE_DAYS_AHEAD} days ahead`);
    else out.planned_date = b.plannedDate;
  }
  const num = (key, col, lo, hi) => {
    if (b[key] === undefined) return null;
    if (b[key] === null) { out[col] = null; return null; }
    const n = Number(b[key]);
    if (!Number.isFinite(n) || n < lo || n > hi) return `${key} must be a number from ${lo} to ${hi}`;
    out[col] = n; return null;
  };
  const e1 = num('distanceKm', 'distance_km', 0.1, 300) || num('elevationGainM', 'elevation_gain_m', 0, 10000);
  if (e1) return err(e1);
  for (const [key, col, max] of [['region', 'region', 80], ['notes', 'notes', 500]]) {
    if (b[key] === undefined) continue;
    if (b[key] !== null && (typeof b[key] !== 'string' || b[key].length > max)) return err(`${key} must be text up to ${max} characters`);
    out[col] = b[key] ? b[key].trim() : null;
  }
  if (b.difficulty !== undefined) { if (b.difficulty !== null && !DIFFICULTIES.includes(b.difficulty)) return err(`difficulty must be one of ${DIFFICULTIES.join(', ')}`); out.difficulty = b.difficulty; }
  if (b.emberPlanned !== undefined) { if (typeof b.emberPlanned !== 'boolean') return err('emberPlanned must be true or false'); out.ember_planned = b.emberPlanned ? 1 : 0; }
  if (b.status !== undefined) { if (!['planned', 'cancelled'].includes(b.status)) return err('status must be planned or cancelled (a route is completed only by linking it to a confirmed activity)'); out.status = b.status; }
  return { fields: out };
}

/** Nick adds a route plan — by hand, or from a GPX file. Never activity. */
function createRoute(body = {}, { now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const today = loop.localDay(nowMs);
  const v = _validRouteFields(body, { today });
  if (v.error) return { ok: false, status: 400, error: v.error };
  const f = { kind: 'hike', status: 'planned', ember_planned: 0, ...v.fields, source: 'manual' };
  if (body.status === 'cancelled') return { ok: false, status: 400, error: 'a new route is planned, not cancelled' };
  if (body.gpx !== undefined && body.gpx !== null) {
    const g = model.parseGpx(body.gpx);
    if (!g.ok) return { ok: false, status: 400, error: g.error };
    f.source = 'gpx'; f.point_count = g.pointCount; f.geometry_json = JSON.stringify(g.geometry); f.route_ref = g.sourceLink;
    if (f.distance_km == null) f.distance_km = g.distanceKm;
    if (f.elevation_gain_m == null && g.elevationGainM != null) f.elevation_gain_m = g.elevationGainM;
    if (!f.name && g.name) f.name = g.name.slice(0, 120);
  }
  if (!f.name) return { ok: false, status: 400, error: 'a route needs a name (or a GPX file that has one)' };
  const id = `route:${require('crypto').randomUUID()}`;
  const at = new Date(nowMs).toISOString();
  const cols = ['route_id', 'created_at', 'updated_at', ...Object.keys(f)];
  _db().run(`INSERT INTO outdoor_routes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, [id, at, at, ...Object.values(f)]);
  _log('outdoor-route-planned', id, { name: f.name, kind: f.kind, plannedDate: f.planned_date || null, source: f.source, distanceKm: f.distance_km || null }, nowMs);
  return { ok: true, routeId: id, route: shapeRoute(_db().get('SELECT * FROM outdoor_routes WHERE route_id = ?', [id]), { today }) };
}

function updateRoute(routeId, body = {}, { now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const today = loop.localDay(nowMs);
  const r = _db().get('SELECT * FROM outdoor_routes WHERE route_id = ?', [routeId]);
  if (!r) return { ok: false, status: 404, error: 'no such route' };
  if (body.gpx !== undefined) return { ok: false, status: 400, error: 'a route\'s GPX cannot be replaced — add the new file as a new route' };
  const v = _validRouteFields(body, { today, partial: true });
  if (v.error) return { ok: false, status: 400, error: v.error };
  const keys = Object.keys(v.fields);
  if (!keys.length) return { ok: false, status: 400, error: 'nothing to change' };
  _db().run(`UPDATE outdoor_routes SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE route_id = ?`, [...Object.values(v.fields), new Date(nowMs).toISOString(), routeId]);
  const kind = v.fields.status === 'cancelled' && r.status !== 'cancelled' ? 'outdoor-route-cancelled'
    : v.fields.status === 'planned' && r.status === 'cancelled' ? 'outdoor-route-planned' : 'outdoor-route-updated';
  _log(kind, routeId, { name: v.fields.name || r.name, fields: keys.filter((k) => k !== 'status'), plannedDate: v.fields.planned_date !== undefined ? v.fields.planned_date : r.planned_date }, nowMs);
  return { ok: true, route: shapeRoute(_db().get('SELECT * FROM outdoor_routes WHERE route_id = ?', [routeId]), { today }) };
}

/** Does this activity exist as something Nick can link to? */
function _activity(activityId) {
  const db = _db();
  let m = /^workout:(\d+)$/.exec(String(activityId || ''));
  if (m) {
    const w = db.get('SELECT id, activity_type, started_at FROM health_workouts WHERE id = ?', [Number(m[1])]);
    if (!w || !/hik|walk/i.test(w.activity_type || '')) return null;
    return { activityId, day: loop.localDay(loop.parseStamp(w.started_at)), label: `${w.activity_type} on ${String(w.started_at).slice(0, 10)}` };
  }
  m = /^hike-day:(\d{4}-\d{2}-\d{2})$/.exec(String(activityId || ''));
  if (m) {
    const goal = loop.findGoal((() => { try { return db.all('SELECT goal_id, title, status FROM goals').map((g) => ({ goalId: g.goal_id, title: g.title, status: g.status })); } catch { return []; } })());
    if (!goal || !loop.entries(goal.goalId).some((e) => e.kind === 'confirm' && e.day === m[1])) return null;
    return { activityId, day: m[1], label: `the hike you confirmed on ${m[1]}` };
  }
  return null;
}

function linkRoute(activityId, routeId, { now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const a = _activity(activityId);
  if (!a) return { ok: false, status: 404, error: 'no such activity (a recorded hike or walk workout, or a hike you confirmed)' };
  const r = _db().get('SELECT route_id, name, status, planned_date, distance_km, region FROM outdoor_routes WHERE route_id = ?', [routeId]);
  if (!r) return { ok: false, status: 404, error: 'no such route' };
  if (r.status === 'cancelled') return { ok: false, status: 409, error: 'that route is cancelled — re-plan it first' };
  const held = _db().get("SELECT target_id FROM outdoor_activity_links WHERE activity_id = ? AND relation = 'route'", [activityId]);
  if (held && held.target_id === routeId) return { ok: true, already: true };
  const at = new Date(nowMs).toISOString();
  if (held) { _db().run("DELETE FROM outdoor_activity_links WHERE activity_id = ? AND relation = 'route'", [activityId]); _log('outdoor-route-unlinked', activityId, { routeId: held.target_id, replaced: true }, nowMs); }
  _db().run("INSERT INTO outdoor_activity_links (activity_id, relation, target_id, label, set_at) VALUES (?, 'route', ?, ?, ?)", [activityId, routeId, r.name, at]);
  _log('outdoor-route-linked', activityId, { routeId, route: r.name, activity: a.label, basis: model.matchRoute(r, a, { explicit: true }).basis }, nowMs);
  return { ok: true, link: { activityId, routeId, basis: 'explicit' } };
}

function unlinkRoute(activityId, { now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const held = _db().get("SELECT target_id, label FROM outdoor_activity_links WHERE activity_id = ? AND relation = 'route'", [activityId]);
  if (!held) return { ok: true, already: true };
  _db().run("DELETE FROM outdoor_activity_links WHERE activity_id = ? AND relation = 'route'", [activityId]);
  _log('outdoor-route-unlinked', activityId, { routeId: held.target_id, route: held.label }, nowMs);
  return { ok: true };
}

function _companion(companionId) {
  try { return require('./personal-world').listCompanions().find((c) => c.id === companionId) || null; } catch { return null; }
}

function addCompanion(activityId, companionId, { now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const a = _activity(activityId);
  if (!a) return { ok: false, status: 404, error: 'no such activity (a recorded hike or walk workout, or a hike you confirmed)' };
  const c = _companion(companionId);
  if (!c) return { ok: false, status: 404, error: 'no such companion' };
  const r = _db().run("INSERT OR IGNORE INTO outdoor_activity_links (activity_id, relation, target_id, label, set_at) VALUES (?, 'companion', ?, ?, ?)", [activityId, companionId, c.name, new Date(nowMs).toISOString()]);
  if (!(r && r.changes)) return { ok: true, already: true };
  _log('outdoor-companion-added', activityId, { companion: c.name, activity: a.label }, nowMs);
  return { ok: true };
}

function removeCompanion(activityId, companionId, { now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const r = _db().run("DELETE FROM outdoor_activity_links WHERE activity_id = ? AND relation = 'companion' AND target_id = ?", [activityId, companionId]);
  if (!(r && r.changes)) return { ok: true, already: true };
  const c = _companion(companionId);
  _log('outdoor-companion-removed', activityId, { companion: c ? c.name : companionId }, nowMs);
  return { ok: true };
}

/** Radar input (29Z): dated route plans in the window. Plans only. */
function radar({ today, last } = {}) {
  try {
    return { items: _db().all("SELECT route_id, name, kind, planned_date, ember_planned FROM outdoor_routes WHERE status = 'planned' AND planned_date >= ? AND planned_date <= ?", [today, last])
      .map((r) => ({ routeId: r.route_id, name: r.name, kind: r.kind, day: r.planned_date, emberPlanned: r.ember_planned === 1 })) };
  } catch (e) { return { items: [], error: e.message }; }
}

const TABLES = ['outdoor_routes', 'outdoor_activity_links'];

module.exports = {
  CONTRACT, FORECAST_KEY, TABLES,
  read, nowBlock, refresh, sourceHealth, weatherFor, weatherNear, shapeRoute, radar,
  createRoute, updateRoute, linkRoute, unlinkRoute, addCompanion, removeCompanion,
};
