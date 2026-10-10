'use strict';

/**
 * Outdoor Life — the pure half (Build 29, 9 Oct 2026).
 *
 * Weather knows the conditions. Routes know where Nick planned to go. Workouts
 * and GPS know what actually happened. This module decides, from what each of
 * those says, whether he really got outside and whether that matters — and
 * nothing here reads a database, a clock or the network.
 *
 * ⚠ IT DOES NOT JUDGE A HIKE. hiking-loop.js (Builds 15–17) is the one place a
 * day becomes confirmed / not_hike / recording_gap / planned / unknown, and its
 * rule is kept exactly: a Hiking workout or a Walking workout of 60+ minutes
 * counts only with its GPS route (>=10 fixes, received within 24h), or by
 * Nick's word. This module reads those verdicts and never re-derives them.
 *
 * ⚠ The brief's shorthand "a Hiking workout confirms a hike" is LOOSER than the
 * deployed Build 17 rule (a Hiking workout without its route is a recording
 * gap). The brief also says preserve Build 17 and never loosen it, so the
 * stricter rule stands. Live history is the argument: five "Hiking" workouts
 * between 25 Feb and 2 Mar 2026 lasted 13–25 minutes and covered about 1 km.
 */

const STATES = Object.freeze(['confirmed', 'not_hike', 'recording_gap', 'planned', 'unknown']);
const KINDS = Object.freeze(['hike', 'walk', 'dog_walk', 'outdoor_time', 'route_plan', 'unknown']);
const GOAL_STATES = Object.freeze(['achieved', 'planned', 'not_yet', 'recording_gap', 'unknown']);
const SUITABILITY = Object.freeze(['favourable', 'mixed', 'poor', 'unknown']);

/** A walk shorter than this is not a "meaningful" outing — a nip to the shop. */
const MEANINGFUL_WALK_MIN = 20;
/** How near a planned hike must be for Now to mention it (days ahead, inclusive). */
const NOW_PLAN_AHEAD_DAYS = 1;
/** Weather context and a severe-weather decision apply only this close in. */
const DECISION_AHEAD_DAYS = 2;
/** The daylight read covers a week only when this many of its elapsed days carry a reading. */
const DAYLIGHT_MIN_DAYS = 4;

/**
 * The evidence hierarchy (29B), as DATA so the page and the record say the same
 * thing. Nothing in NOT_SUFFICIENT changes a hike's state on its own.
 */
const EVIDENCE = Object.freeze({
  strong: [
    { id: 'hike-workout-with-route', label: 'A Hiking workout with its GPS route (at least 10 fixes, received within 24 hours)' },
    { id: 'walk-60-with-route', label: 'A Walking workout of 60 minutes or more with its GPS route (at least 10 fixes, received within 24 hours)' },
    { id: 'nick', label: 'You saying it was a hike' },
  ],
  notSufficient: [
    'steps', 'distance on its own', 'time outdoors or in daylight', 'a route file (GPX) or a planned route', 'a saved AllTrails route',
    'a calendar entry or plan', 'the weather', 'Ember coming along', 'driving to a hiking area', 'photos', 'a generic walk',
    'a Hiking workout without its GPS route (a recording gap, never a hike)',
  ],
  nickWins: 'Your word beats everything both ways: "it was a hike" beats a missing track, "it was not" beats a track.',
});

// ── dates (wall-clock strings, never re-zoned) ─────────────────────────────

function _utc(day) { return Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)); }
function addDays(day, n) { return new Date(_utc(day) + n * 86400000).toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((_utc(b) - _utc(a)) / 86400000); }
function dow(day) { return new Date(_utc(day)).getUTCDay(); } // 0 Sun … 6 Sat
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function dayName(day) { return DAY_NAMES[dow(day)]; }
function whenWords(today, day) {
  const n = daysBetween(today, day);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  if (n > 1 && n < 7) return dayName(day);
  return day;
}

// ── activities (29C/29D/29H/29I) ───────────────────────────────────────────

/**
 * Pure. One recorded workout as an outdoor activity.
 * @param w       { id, type, day, mins, distanceKm, elevationM }
 * @param verdict the hiking loop's judgement for w.day, or null if the loop never looked at that day
 * @param links   [{ relation: 'companion'|'route', target, label }]  Nick's explicit links for this activity
 * @param trackValid  whether THIS workout's route is a valid track (hiking-loop.trackVerdict)
 *
 * `state` answers "is this activity established, as this kind" from the bounded
 * set. A recorded walk is established as a walk (`confirmed`) and carries
 * `hike: not_hike` — a walk stays a walk. A Hiking workout without its route
 * is kind hike, state recording_gap: the loop's own answer.
 */
function shapeWorkout(w, { verdict = null, links = [], trackValid = false } = {}) {
  const isHikeType = /hik/i.test(w.type || '');
  const isWalkType = /walk/i.test(w.type || '');
  const companions = links.filter((l) => l.relation === 'companion').map((l) => ({ id: l.target, name: l.label || l.target, basis: 'you' }));
  const routeLink = links.find((l) => l.relation === 'route') || null;
  const base = {
    activityId: `workout:${w.id}`, day: w.day, startTime: w.startLocal || null, endTime: w.endLocal || null,
    durationMin: Number.isFinite(w.mins) ? w.mins : null,
    distanceKm: Number.isFinite(w.distanceKm) ? Math.round(w.distanceKm * 10) / 10 : null,
    elevationM: Number.isFinite(w.elevationM) ? Math.round(w.elevationM) : null,
    workoutType: w.type || null, source: 'Apple Health workout', sourceRef: `health_workouts:${w.id}`,
    gpsEvidence: trackValid ? 'valid track' : (w.hasRoute ? 'route below the track rule' : 'no route with this workout'),
    companions, route: routeLink ? { routeId: routeLink.target, name: routeLink.label || null, basis: 'you' } : null,
    privacyLevel: 'summary',
  };
  // The loop's word on the day decides a hike. A Nick confirmation or denial is
  // about the DAY; a GPS-track confirmation is about the workout that carried it.
  if (verdict && verdict.state === 'confirmed' && (verdict.by === 'you' || trackValid)) {
    return { ...base, kind: 'hike', state: 'confirmed', confidence: 'high',
      evidence: [verdict.by === 'you' ? 'you confirmed it' : verdict.why], hike: { state: 'confirmed', by: verdict.by, why: verdict.why } };
  }
  if (verdict && verdict.state === 'not_hike' && verdict.by === 'you') {
    const kind = isWalkType ? (companions.length ? 'dog_walk' : 'walk') : 'walk';
    return { ...base, kind, state: 'confirmed', confidence: 'high', evidence: ['a recorded workout', 'you said it was not a hike'],
      hike: { state: 'not_hike', by: 'you', why: verdict.why } };
  }
  if (isHikeType) {
    const st = verdict ? verdict.state : 'unknown';
    return { ...base, kind: 'hike', state: st === 'not_hike' ? 'recording_gap' : st, confidence: st === 'unknown' ? 'low' : 'medium',
      evidence: ['a Hiking workout', base.gpsEvidence], hike: { state: st, by: verdict ? verdict.by || null : null, why: verdict ? verdict.why : 'not judged yet' } };
  }
  if (isWalkType) {
    const hikeState = verdict && verdict.state === 'unknown' ? 'unknown' : 'not_hike';
    const why = hikeState === 'unknown' ? 'its 24-hour window for a GPS track is still open'
      : (w.mins || 0) < 60 ? 'a walk under 60 minutes is not a hike' : 'no valid GPS track came with it';
    return { ...base, kind: companions.length ? 'dog_walk' : 'walk', state: 'confirmed', confidence: 'high',
      evidence: ['a recorded Walking workout'], hike: { state: hikeState, by: null, why } };
  }
  return { ...base, kind: 'unknown', state: 'unknown', confidence: 'low', evidence: [`a ${w.type || 'workout'}`], hike: null };
}

/** Pure. A day Nick confirmed as a hike with no recorded workout. */
function shapeConfirmedDay(day, { links = [], note = null } = {}) {
  return {
    activityId: `hike-day:${day}`, day, startTime: null, endTime: null, durationMin: null, distanceKm: null, elevationM: null,
    workoutType: null, source: 'your confirmation', sourceRef: null, gpsEvidence: 'none recorded',
    companions: links.filter((l) => l.relation === 'companion').map((l) => ({ id: l.target, name: l.label || l.target, basis: 'you' })),
    route: (() => { const r = links.find((l) => l.relation === 'route'); return r ? { routeId: r.target, name: r.label || null, basis: 'you' } : null; })(),
    kind: 'hike', state: 'confirmed', confidence: 'high', evidence: ['you confirmed it'], note,
    hike: { state: 'confirmed', by: 'you', why: 'you confirmed it' }, privacyLevel: 'summary',
  };
}

/** Pure. A walk worth a line: recorded, at least MEANINGFUL_WALK_MIN, or one Nick linked Ember to. */
function isMeaningfulWalk(a) {
  if (!a || !['walk', 'dog_walk'].includes(a.kind)) return false;
  if (a.companions && a.companions.length) return true;
  return Number.isFinite(a.durationMin) && a.durationMin >= MEANINGFUL_WALK_MIN;
}

// ── the weekly goal (29E/29F/29G) ──────────────────────────────────────────

/**
 * Pure. The loop's week → the goal's state. The week is the loop's own:
 * Monday to Sunday, local (hiking-loop.weekStart) — the system convention, not
 * a new one.
 */
function goalState(week) {
  if (!week) return { state: 'unknown', why: 'the hiking loop could not be read' };
  const confirmed = week.confirmed || [];
  if (confirmed.length) return { state: 'achieved', why: week.line, days: confirmed.map((c) => c.day) };
  switch (week.recording) {
    case 'unknown': return { state: 'unknown', why: week.line };
    case 'planned': return { state: 'planned', why: week.line };
    case 'recording_gap': return { state: 'recording_gap', why: week.line };
    case 'not_hike': return { state: 'not_yet', why: week.line };
    default: return { state: 'unknown', why: week.line || 'no answer from the loop' };
  }
}

// ── weather (29P/29Q) ──────────────────────────────────────────────────────

const SEVERE_CONDITIONS = new Set(['lightning', 'lightning-rainy', 'hail', 'exceptional']);
const POOR_CONDITIONS = new Set(['pouring', 'snowy', 'snowy-rainy']);
const MIXED_CONDITIONS = new Set(['rainy', 'fog']);
const RANK = { favourable: 0, mixed: 1, poor: 2 };

/**
 * Pure. A bounded planning context for one day — never a universal "good
 * hiking weather" score. Each input states what it said and what it moved.
 *
 * @param hourly  daytime (08:00–18:00) standing forecast points for the day:
 *                [{ precipMm, precipProb, tempC }] from the forecast NEURO
 *                already keeps (weather-forecast). Empty = not known.
 * @param daily   Home Assistant's daily forecast for the day (condition,
 *                tempHighC, tempLowC, precipitationMm, windKmh) or null.
 *
 * Thresholds are NEURO's stated rule for a day out on foot, not a forecast
 * engine: rain over the day (mm), the wettest hour's chance, sustained wind,
 * temperature extremes, and HA's own condition word.
 */
function suitability({ hourly = [], daily = null } = {}) {
  const inputs = [];
  const add = (input, said, level) => inputs.push({ input, said, level });
  const pts = (hourly || []).filter((p) => p && (Number.isFinite(p.precipMm) || Number.isFinite(p.precipProb) || Number.isFinite(p.tempC)));
  let rainMm = null; let maxProb = null; let hi = null; let lo = null;
  if (pts.length) {
    const mm = pts.map((p) => p.precipMm).filter(Number.isFinite);
    const pr = pts.map((p) => p.precipProb).filter(Number.isFinite);
    const t = pts.map((p) => p.tempC).filter(Number.isFinite);
    rainMm = mm.length ? Math.round(mm.reduce((a, b) => a + b, 0) * 10) / 10 : null;
    maxProb = pr.length ? Math.max(...pr) : null;
    hi = t.length ? Math.max(...t) : null; lo = t.length ? Math.min(...t) : null;
  }
  if (daily) {
    if (rainMm === null && Number.isFinite(daily.precipitationMm)) rainMm = Math.round(daily.precipitationMm * 10) / 10;
    if (hi === null && Number.isFinite(daily.tempHighC)) hi = daily.tempHighC;
    if (lo === null && Number.isFinite(daily.tempLowC)) lo = daily.tempLowC;
  }
  if (rainMm !== null) {
    // A likely shower is "mixed" even when the amount is small: live 10 Oct 2026
    // read 0.8 mm with a 72% wettest hour, and "favourable" was the wrong word.
    const level = rainMm >= 25 ? 'severe' : rainMm >= 8 || (maxProb !== null && maxProb >= 80 && rainMm >= 3) ? 'poor'
      : rainMm >= 1 || (maxProb !== null && maxProb >= 60) ? 'mixed' : 'favourable';
    add('rain', `${rainMm} mm expected in the day${maxProb !== null ? `, wettest hour ${Math.round(maxProb)}% chance` : ''}`, level);
  } else if (maxProb !== null) {
    add('rain', `wettest hour ${Math.round(maxProb)}% chance`, maxProb >= 60 ? 'mixed' : 'favourable');
  }
  if (daily && Number.isFinite(daily.windKmh)) {
    const w = daily.windKmh;
    add('wind', `${Math.round(w)} km/h sustained`, w >= 65 ? 'severe' : w >= 45 ? 'poor' : w >= 30 ? 'mixed' : 'favourable');
  }
  if (hi !== null) {
    const level = hi >= 30 || hi <= -5 ? 'severe' : hi >= 27 || hi <= 2 ? 'poor' : 'favourable';
    add('temperature', `${Math.round(lo !== null ? lo : hi)}–${Math.round(hi)} °C`, level);
  }
  if (daily && daily.condition) {
    const c = String(daily.condition);
    add('condition', `Home Assistant says "${c}"`, SEVERE_CONDITIONS.has(c) ? 'severe' : POOR_CONDITIONS.has(c) ? 'poor' : MIXED_CONDITIONS.has(c) ? 'mixed' : 'favourable');
  }
  const missing = [];
  if (!inputs.some((i) => i.input === 'rain')) missing.push('rain');
  if (!inputs.some((i) => i.input === 'wind')) missing.push('wind');
  if (!inputs.some((i) => i.input === 'temperature')) missing.push('temperature');
  if (!inputs.length) return { state: 'unknown', severe: false, inputs, missing, line: 'No forecast for that day yet.' };
  const severe = inputs.some((i) => i.level === 'severe');
  let state = 'favourable';
  for (const i of inputs) {
    const lv = i.level === 'severe' ? 'poor' : i.level;
    if (RANK[lv] > RANK[state]) state = lv;
  }
  const drivers = inputs.filter((i) => i.level !== 'favourable').map((i) => i.said);
  const line = state === 'favourable'
    ? `Looks favourable — ${inputs.map((i) => i.said).join('; ')}.`
    : `${state === 'mixed' ? 'Mixed' : severe ? 'Severe' : 'Poor'} — ${drivers.join('; ')}.`;
  return { state, severe, inputs, missing, line: missing.length ? `${line} Not known: ${missing.join(', ')}.` : line };
}

// ── goal at risk (29X) and Now (29Y) ───────────────────────────────────────

/**
 * Pure. "Goal at risk" exists only when ALL of: no confirmed hike, no viable
 * plan left this week (a plan whose weather is severe is not viable), the
 * sources are healthy enough that "nothing yet" means nothing yet, no 24-hour
 * window is still open, and it is late enough in the week (Thursday onwards —
 * the loop's own lateInWeek) that acting is still possible. Never Monday.
 */
function goalAtRisk({ goal, today, weekEnd, plans = [], sourcesHealthy }) {
  const d = dow(today);
  const late = d === 0 || d >= 4;
  if (!goal || goal.state === 'achieved') return { atRisk: false, why: 'a hike is confirmed this week' };
  if (goal.state === 'unknown') return { atRisk: false, why: 'a day is still waiting on its 24-hour window' };
  if (goal.state === 'recording_gap') return { atRisk: false, why: 'NEURO cannot tell this week, so it cannot say anything is at risk' };
  if (!late) return { atRisk: false, why: 'too early in the week to say' };
  if (!sourcesHealthy) return { atRisk: false, why: 'the sources are not healthy enough to say' };
  const viable = plans.filter((p) => p.day >= today && p.day <= weekEnd && !(p.weather && p.weather.severe));
  if (viable.length) return { atRisk: false, why: `${dayName(viable[0].day)} is still planned` };
  return { atRisk: true, why: plans.some((p) => p.day >= today && p.weather && p.weather.severe)
    ? 'the only plan left this week has severe weather forecast'
    : 'no hike confirmed or planned, and the week ends Sunday' };
}

/**
 * Pure. Whether Outdoor earns a place on Now, and what it says. Quiet unless:
 * a hike is planned today/tomorrow (with its weather), a severe forecast
 * threatens a plan within two days, the goal is genuinely at risk, a 24-hour
 * window is asking a question, or the workout source is failing.
 * `needsYou` follows existing rules only: severe weather on an imminent plan,
 * or an activity source that has to be reconnected. Never "you haven't hiked".
 */
function nowRelevance({ today, goal, plans = [], atRisk, openQuestion = null, workoutSource = null }) {
  const items = []; const needsYou = [];
  for (const p of plans) {
    const away = daysBetween(today, p.day);
    if (away < 0 || away > DECISION_AHEAD_DAYS) continue;
    const severe = !!(p.weather && p.weather.severe);
    if (away > NOW_PLAN_AHEAD_DAYS && !severe) continue;
    const w = p.weather ? ` · ${p.weather.line}` : '';
    items.push({ kind: 'plan', day: p.day, line: `${p.label || 'Hike'} planned ${whenWords(today, p.day)}${w}`, weather: p.weather || null });
    if (severe) needsYou.push({ kind: 'severe-weather', day: p.day, line: `Severe weather is forecast for ${whenWords(today, p.day)}'s planned ${String(p.label || 'hike').toLowerCase()} — keep it, move it or drop it?` });
  }
  if (openQuestion) items.push({ kind: 'question', day: openQuestion.day, line: openQuestion.line });
  if (atRisk && atRisk.atRisk) items.push({ kind: 'goal-at-risk', day: null, line: `Hike weekly: ${atRisk.why}.` });
  if (workoutSource && workoutSource.state === 'failing') {
    items.push({ kind: 'source', day: null, line: workoutSource.line });
    needsYou.push({ kind: 'reconnect', day: null, line: workoutSource.line });
  }
  return { relevant: items.length > 0, items, needsYou, goalState: goal ? goal.state : 'unknown' };
}

// ── outdoor time (29J) ─────────────────────────────────────────────────────

/**
 * Pure. Time in daylight this week — Apple Watch's own measure (its ambient
 * light sensor), the one bounded outdoor signal NEURO already holds. It is
 * labelled as that and never as "outdoor activity", and it never touches a
 * hike. Coverage is stated: a day with no reading is not a day indoors.
 */
function daylightWeek(rows, { start, today }) {
  const days = []; let total = 0; let withReading = 0;
  for (let i = 0; i < 7; i += 1) {
    const d = addDays(start, i);
    if (d > today) break;
    const r = (rows || []).find((x) => x.day === d);
    const m = r && Number.isFinite(r.minutes) ? r.minutes : null;
    days.push({ day: d, minutes: m, partial: d === today });
    if (m !== null) { total += m; withReading += 1; }
  }
  const elapsed = days.length;
  const covered = withReading >= Math.min(DAYLIGHT_MIN_DAYS, elapsed);
  return {
    known: withReading > 0, minutes: withReading ? Math.round(total) : null, daysWithReading: withReading, daysElapsed: elapsed, covered,
    label: 'Time in daylight (Apple Watch estimate)',
    line: !withReading ? 'No daylight reading this week.'
      : `${Math.round(total)} min in daylight across ${withReading} of ${elapsed} day${elapsed === 1 ? '' : 's'} (Apple Watch's estimate; today is partial).`,
  };
}

// ── weekly summary (29V) ───────────────────────────────────────────────────

function weeklySummary({ goal, activities = [], nextPlan = null, daylight = null, gaps = [] }) {
  const hikes = activities.filter((a) => a.kind === 'hike' && a.state === 'confirmed');
  const walks = activities.filter(isMeaningfulWalk);
  const sessions = [...hikes, ...walks];
  const mins = sessions.map((a) => a.durationMin).filter(Number.isFinite);
  const allTimed = sessions.length > 0 && mins.length === sessions.length;
  return {
    goalState: goal.state, goalLine: goal.why,
    confirmedHikes: hikes.length, meaningfulWalks: walks.length, outdoorSessions: sessions.length,
    // A total is only stated when every session has a recorded duration —
    // a Nick-confirmed day has none, and adding nothing for it understates.
    knownDurationMin: allTimed ? mins.reduce((a, b) => a + b, 0) : null,
    durationWhy: allTimed || !sessions.length ? null : 'at least one session has no recorded duration, so no total is given',
    daylight, nextPlan, gaps,
  };
}

// ── GPX (29L/29M) ──────────────────────────────────────────────────────────

const MAX_GPX_CHARS = 3 * 1024 * 1024;
const MAX_STORED_POINTS = 300;

function haversineM(a, b) {
  const R = 6371000; const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad; const dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function _attr(tag, name) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return m ? Number(m[1]) : NaN;
}

/**
 * Pure. A GPX file → what a PLAN needs: its points, distance, ascent and name.
 * It never proves completion. Track points are used if present, else route
 * points. Refuses rather than guesses on anything unreadable.
 */
function parseGpx(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'the GPX file is empty' };
  if (text.length > MAX_GPX_CHARS) return { ok: false, error: 'the GPX file is larger than 3 MB' };
  if (!/<gpx[\s>]/i.test(text)) return { ok: false, error: 'that is not a GPX file' };
  const read = (tagName) => {
    const out = [];
    const re = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)</${tagName}>|<${tagName}\\b([^>]*)/>`, 'gi');
    let m;
    while ((m = re.exec(text)) !== null) {
      const attrs = m[1] || m[3] || '';
      const lat = _attr(attrs, 'lat'); const lon = _attr(attrs, 'lon');
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      const em = (m[2] || '').match(/<ele>\s*([-0-9.]+)\s*<\/ele>/i);
      out.push({ lat, lon, ele: em ? Number(em[1]) : null });
    }
    return out;
  };
  let pts = read('trkpt');
  if (pts.length < 2) pts = read('rtept');
  if (pts.length < 2) return { ok: false, error: 'the GPX file has fewer than two usable points' };
  let dist = 0; let ascent = 0; let lastEle = null;
  for (let i = 1; i < pts.length; i += 1) dist += haversineM(pts[i - 1], pts[i]);
  // Ascent with a 3 m hysteresis, so GPS jitter on the flat is not "climbing".
  for (const p of pts) {
    if (!Number.isFinite(p.ele)) continue;
    if (lastEle === null) { lastEle = p.ele; continue; }
    if (p.ele - lastEle >= 3) { ascent += p.ele - lastEle; lastEle = p.ele; } else if (lastEle - p.ele >= 3) lastEle = p.ele;
  }
  const nameM = text.match(/<(?:trk|rte|metadata)>[\s\S]*?<name>\s*([^<]{1,120}?)\s*<\/name>/i);
  const linkM = text.match(/<link\s+href=["']([^"']{1,300})["']/i);
  const step = Math.max(1, Math.ceil(pts.length / MAX_STORED_POINTS));
  const geometry = pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map((p) => [Math.round(p.lat * 1e5) / 1e5, Math.round(p.lon * 1e5) / 1e5]);
  // The highest point, for a hike's route card (where to look first). null when the file carries no elevation.
  let highest = null;
  for (const p of pts) if (Number.isFinite(p.ele) && (!highest || p.ele > highest.ele)) highest = p;
  return {
    ok: true, name: nameM ? nameM[1].trim() : null, sourceLink: linkM ? linkM[1] : null,
    pointCount: pts.length, distanceKm: Math.round(dist / 100) / 10,
    elevationGainM: pts.some((p) => Number.isFinite(p.ele)) ? Math.round(ascent) : null,
    highest: highest ? { lat: Math.round(highest.lat * 1e5) / 1e5, lon: Math.round(highest.lon * 1e5) / 1e5, ele: Math.round(highest.ele) } : null,
    geometry,
  };
}

// ── plan ↔ actual (29N) ────────────────────────────────────────────────────

const MATCH_RADIUS_M = 150;
const MATCH_SHARE = 0.8;

function _nearest(p, line) {
  let best = Infinity;
  for (const q of line) { const d = haversineM({ lat: p[0], lon: p[1] }, { lat: q[0], lon: q[1] }); if (d < best) best = d; }
  return best;
}

/**
 * Pure. May this actual activity be linked to this planned route? Only on:
 *   explicit  — Nick linked them;
 *   route-id  — the activity carries the plan's own route reference;
 *   geometry  — both have geometry, and at least 80% of each lies within 150 m
 *               of the other (the actual followed the plan AND covered it).
 * Never on the same area, a similar distance, or the same day — each of those
 * is reported as the reason it did NOT link.
 */
function matchRoute(plan, activity, { explicit = false } = {}) {
  if (!plan || !activity) return { linked: false, basis: null, why: 'nothing to compare' };
  if (explicit) return { linked: true, basis: 'explicit', why: 'you linked them' };
  if (plan.routeRef && activity.routeRef && plan.routeRef === activity.routeRef) return { linked: true, basis: 'route-id', why: 'the activity carries the plan\'s route reference' };
  const a = activity.geometry; const p = plan.geometry;
  if (Array.isArray(a) && a.length >= 10 && Array.isArray(p) && p.length >= 10) {
    const along = a.filter((pt) => _nearest(pt, p) <= MATCH_RADIUS_M).length / a.length;
    const covered = p.filter((pt) => _nearest(pt, a) <= MATCH_RADIUS_M).length / p.length;
    if (along >= MATCH_SHARE && covered >= MATCH_SHARE) return { linked: true, basis: 'geometry', why: `${Math.round(along * 100)}% of the track follows the plan and it covers ${Math.round(covered * 100)}% of it` };
    return { linked: false, basis: null, why: `the tracks differ (${Math.round(along * 100)}% follows, ${Math.round(covered * 100)}% covered — needs 80% both ways)` };
  }
  const weak = [];
  if (plan.plannedDate && activity.day === plan.plannedDate) weak.push('same day');
  if (Number.isFinite(plan.distanceKm) && Number.isFinite(activity.distanceKm) && Math.abs(plan.distanceKm - activity.distanceKm) <= Math.max(1, plan.distanceKm * 0.15)) weak.push('similar distance');
  if (plan.region && activity.region && plan.region === activity.region) weak.push('same area');
  return { linked: false, basis: null, why: weak.length ? `${weak.join(', ')} — not enough to say it was this route` : 'no actual track geometry or route reference to compare' };
}

module.exports = {
  STATES, KINDS, GOAL_STATES, SUITABILITY, EVIDENCE, MEANINGFUL_WALK_MIN, NOW_PLAN_AHEAD_DAYS, DECISION_AHEAD_DAYS,
  MATCH_RADIUS_M, MATCH_SHARE, MAX_GPX_CHARS,
  addDays, daysBetween, dayName, whenWords,
  shapeWorkout, shapeConfirmedDay, isMeaningfulWalk, goalState, suitability, goalAtRisk, nowRelevance,
  daylightWeek, weeklySummary, parseGpx, matchRoute, haversineM,
};
