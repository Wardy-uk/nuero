'use strict';

/**
 * Hike suggestions (1 Nov 2026).
 *
 * "Saturday looks good and you're 1 hike behind — plan one?" — offered on desktop
 * Now and Life → Outdoor, ONLY when all of these hold for the coming Saturday
 * (else Sunday):
 *   1. the forecast suitability is `favourable` (outdoor.weatherNear — the same
 *      rule Outdoor shows; mixed/poor/unknown never suggests);
 *   2. the hike goal is behind (goal-measures' hikes measure, else the hiking
 *      loop's current week with no confirmed hike);
 *   3. nothing already planned that day (a hike plan, an armed walk);
 *   4. the diary is free that day — no timed entry that is not `free` between
 *      08:00 and 18:00, and no all-day entry at all (a wedding is all-day and
 *      `free` on the phone). An unreadable diary is NOT a free day.
 * One suggestion per weekend; "Not this weekend" is remembered for that weekend.
 *
 * "Plan it" opens the hike-safety arm form PRE-FILLED (date, 09:30–14:30, the
 * last walk's name, party and Ember if she usually comes). Arming still needs
 * Nick's press. ⚠ NO PUSH — this is pull-only (a new interruption kind would
 * cost the budget every other push shares).
 */

const DISMISS_KEY = 'hike_suggestion_dismissed';
const SUGGEST_START = '09:30';
const SUGGEST_FINISH = '14:30';

function _db() { return require('../db/database'); }
function _json(key, d) { try { const v = JSON.parse(_db().getState(key) || 'null'); return v == null ? d : v; } catch { return d; } }
function _utc(d) { return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)); }
function addDays(d, n) { return new Date(_utc(d) + n * 86400000).toISOString().slice(0, 10); }
function dow(d) { return new Date(_utc(d)).getUTCDay(); }
const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** PURE. The coming weekend's candidate days and its key (the Saturday). */
function weekend(nowLocal) {
  const today = nowLocal.slice(0, 10);
  const hour = Number(nowLocal.slice(11, 13));
  const d = dow(today);
  const sat = d === 6 ? today : d === 0 ? addDays(today, -1) : addDays(today, 6 - d);
  const sun = addDays(sat, 1);
  // A day already under way by late morning is too late to plan a walk for.
  const days = [sat, sun].filter((x) => x > today || (x === today && hour < 10));
  return { key: sat, days };
}

/** PURE. Is the diary free for a day out? */
function dayFree(events, day) {
  if (!events) return { known: false, why: 'the calendar could not be read' };
  const busy = [];
  for (const e of events) {
    const subj = String(e.subject || '');
    if (/hik(e|ing)/i.test(subj)) continue; // a hike plan is handled as a plan, not a clash
    if (e.show_as === 'cancelled') continue;
    if (e.is_all_day) { if (String(e.start_time || '').slice(0, 10) <= day && String(e.end_time || '').slice(0, 10) > day) busy.push(subj || 'an all-day entry'); continue; }
    const s = String(e.start_time || ''); const en = String(e.end_time || '');
    if (s.slice(0, 10) > day || en.slice(0, 10) < day) continue;
    if (e.show_as === 'free') continue;
    const sMin = s.slice(0, 10) < day ? 0 : Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16));
    const eMin = en.slice(0, 10) > day ? 1440 : Number(en.slice(11, 13)) * 60 + Number(en.slice(14, 16));
    if (sMin < 18 * 60 && eMin > 8 * 60) busy.push(subj || 'an entry');
  }
  return busy.length ? { known: true, free: false, why: `${busy[0]} is in the diary` } : { known: true, free: true };
}

/**
 * PURE. The decision. Every gate reports itself so a missing suggestion can be
 * explained ("why is there no suggestion?") and tested.
 */
function decide({ nowLocal, goal, weather, plans = [], events = {}, dismissed = {}, lastTrips = [] }) {
  const wk = weekend(nowLocal);
  const gates = [];
  if (dismissed[wk.key]) return { suggestion: null, weekend: wk.key, gates: [{ gate: 'dismissed', ok: false, why: 'you said not this weekend' }] };
  if (!goal || !goal.known) return { suggestion: null, weekend: wk.key, gates: [{ gate: 'goal', ok: false, why: (goal && goal.why) || 'no hike goal to measure against' }] };
  if (!(goal.behindBy > 0)) return { suggestion: null, weekend: wk.key, gates: [{ gate: 'goal', ok: false, why: goal.why || 'the hike goal is not behind' }] };
  gates.push({ gate: 'goal', ok: true, why: goal.why });
  for (const day of wk.days) {
    const g = [];
    const w = weather(day);
    if (!w || w.state !== 'favourable') { gates.push({ gate: 'weather', day, ok: false, why: w ? w.line : 'no forecast' }); continue; }
    g.push({ gate: 'weather', day, ok: true, why: w.line });
    if (plans.some((p) => p.day === day)) { gates.push({ gate: 'planned', day, ok: false, why: 'a hike is already planned that day' }); continue; }
    const free = dayFree(events[day] === undefined ? null : events[day], day);
    if (!free.known || !free.free) { gates.push({ gate: 'diary', day, ok: false, why: free.why }); continue; }
    g.push({ gate: 'diary', day, ok: true, why: 'nothing in the diary' });
    gates.push(...g);
    const n = goal.behindBy;
    const last = lastTrips[0] || null;
    const emberUsual = lastTrips.length > 0 && lastTrips.filter((t) => t.ember).length * 2 >= lastTrips.length;
    return {
      weekend: wk.key, gates,
      suggestion: {
        id: `hike-suggestion:${wk.key}`, weekend: wk.key, day, dayName: DAY[dow(day)],
        line: `${DAY[dow(day)]} looks good and you're ${n} hike${n === 1 ? '' : 's'} behind — plan one?`,
        weather: w.line, goal: goal.why,
        prefill: {
          plannedStart: `${day}T${SUGGEST_START}`, plannedFinish: `${day}T${SUGGEST_FINISH}`,
          name: last ? last.name : '', emberPlanned: emberUsual,
          party: last && Array.isArray(last.party) ? last.party : [],
          note: last ? `Prefilled from your last walk ("${last.name}") — attach its GPX if it is the same route.` : 'Add the route’s GPX before arming.',
        },
      },
    };
  }
  return { suggestion: null, weekend: wk.key, gates };
}

// ── real inputs ──────────────────────────────────────────────────────────────

function _goal(nowMs) {
  try {
    const gm = require('./goal-measures').read({ now: nowMs, kinds: ['hikes'] });
    const g = (gm.goals || []).find((x) => !x.paused && x.progress && x.measure && x.measure.kind === 'hikes');
    if (g) {
      const p = g.progress;
      if (p.state === 'unknown') return { known: false, why: p.line };
      const behindBy = p.state === 'behind' ? Math.max(1, (p.target || 0) - (p.current || 0)) : 0;
      return { known: true, behindBy, why: p.line };
    }
  } catch { /* fall through to the loop */ }
  const loop = require('./hiking-loop').read({ now: nowMs, weeks: 1 });
  if (!loop.active) return { known: false, why: loop.why };
  const cur = loop.current;
  if (!cur) return { known: false, why: 'the hiking loop has no current week' };
  if ((cur.confirmed || []).length) return { known: true, behindBy: 0, why: cur.line };
  if (cur.recording === 'recording_gap') return { known: false, why: cur.line };
  return { known: true, behindBy: 1, why: cur.line };
}

function _events(days) {
  const out = {};
  for (const day of days) {
    out[day] = _db().all(`SELECT subject, start_time, end_time, is_all_day, show_as FROM calendar_cache
      WHERE substr(start_time, 1, 10) <= ? AND substr(end_time, 1, 10) >= ?`, [day, day]);
  }
  return out;
}

function _armedDays() {
  const lm = require('./world-model').localMinute;
  return _db().all("SELECT planned_start FROM hike_trips WHERE status IN ('armed','alerted')").map((r) => ({ day: lm(Date.parse(r.planned_start)).slice(0, 10), source: 'armed' }));
}

function _lastTrips() {
  try {
    return _db().all("SELECT name, ember, party_json FROM hike_trips WHERE status IN ('checked_in','armed','alerted') ORDER BY planned_start DESC LIMIT 5")
      .map((r) => { let party = []; try { party = JSON.parse(r.party_json || '[]') || []; } catch { party = []; } return { name: r.name, ember: !!r.ember, party }; });
  } catch { return []; }
}

function read({ now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const nowLocal = require('./world-model').localMinute(nowMs);
  const wk = weekend(nowLocal);
  const gaps = [];
  let goal = null;
  try { goal = _goal(nowMs); } catch (e) { goal = { known: false, why: e.message }; gaps.push({ input: 'goal', why: e.message }); }
  let plans = [];
  try { plans = [...require('./hiking-loop').plansAhead({ now: nowMs, days: 8 }), ..._armedDays()]; } catch (e) { gaps.push({ input: 'plans', why: e.message }); return { ok: true, suggestion: null, weekend: wk.key, gates: [], gaps }; }
  let events = {};
  try { events = _events(wk.days); } catch (e) { gaps.push({ input: 'calendar', why: e.message }); events = {}; }
  const od = require('./outdoor');
  const out = decide({ nowLocal, goal, weather: (d) => { try { return od.weatherNear(d, nowMs); } catch { return null; } }, plans, events, dismissed: _json(DISMISS_KEY, {}), lastTrips: _lastTrips() });
  return { ok: true, ...out, gaps };
}

function dismiss(weekendKey, { now = Date.now() } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(weekendKey || '')) || dow(weekendKey) !== 6) return { ok: false, status: 400, error: 'weekend must be the Saturday, YYYY-MM-DD' };
  const d = _json(DISMISS_KEY, {});
  const today = require('./world-model').localMinute(now).slice(0, 10);
  for (const k of Object.keys(d)) if (k < addDays(today, -14)) delete d[k];
  d[weekendKey] = new Date(now).toISOString();
  _db().setState(DISMISS_KEY, JSON.stringify(d));
  try { require('./personal-obligations').logEvent('hike-suggestion-dismissed', { actor: 'nick', subjectId: `weekend:${weekendKey}`, detail: { weekend: weekendKey }, dedupeKey: `hike-suggestion-dismissed:${weekendKey}`, now }); } catch { /* record only */ }
  return { ok: true, weekend: weekendKey };
}

module.exports = { read, decide, dismiss, weekend, dayFree, DISMISS_KEY };
