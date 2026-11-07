'use strict';

/**
 * Is this a good moment to push it? (Nick, 7 Nov 2026.)
 *
 *   "No good telling me to do a job on my laptop if I'm walking round the
 *    shops." — and, asked: "hold it till at desk, but an email can be sent from
 *    the phone app, so it's not just location, timing is important too.
 *    Outside work hours — bad. Driving — bad. Walking on my lunch break — fine.
 *    Hiking in the Peak District on a day off — bad."
 *
 * So every push type says what it NEEDS (the laptop, or just the phone) and
 * what SPHERE it is (work, personal, system), and the live moment decides:
 *
 *   1. Driving → hold everything but the hike check-in, until parked.
 *   2. An ALWAYS_DELIVER (critical) push that the phone can act on goes now.
 *   3. Work, outside work hours / a day off / booked leave → hold until on duty.
 *   4. Work, while a hike is armed and under way → hold until it is over.
 *   5. Needs the laptop, and he is away from home and work → hold until he is.
 *
 * ⚠ HELD, NEVER DROPPED — except when it has gone stale. A held push is kept and
 *   re-sent through the WHOLE pipeline when its reason clears, so a resolved
 *   card is still suppressed by the attention lifecycle on the way out. Too many
 *   at once become ONE summary. A held push older than its type's freshness
 *   window is not sent (it would describe a moment that has passed); it is
 *   logged, and the thing itself is still on Now.
 *
 * ⚠ UNKNOWN NEVER HOLDS. "I can't tell where you are" must not silence NEURO —
 *   every rule fires only on a POSITIVE reading (driving, away, off duty).
 *
 * `classify` and `decide` are PURE. `situation()` gathers; `hold()` and `tick()`
 * touch agent_state. Stored in KV (the focus-hold idiom): the backend restarts
 * several times a day and a hold that evaporated would lose the push.
 */

const db = require('../db/database');

const KEY = 'push_moment_held';
const MAX_HELD = 40;
const SUMMARY_OVER = 3;              // more than this released at once → one summary
const DEFAULT_STALE_MS = 16 * 3600 * 1000;
const SHORT_STALE_MS = 2 * 3600 * 1000;

// What each push type needs and which part of life it is. An unlisted type is
// treated as phone/personal — the least restrictive reading, so a type nobody
// classified can never be held by mistake. push-moment.test.js pins that every
// type in push-owner is listed here.
const L = 'laptop', P = 'phone';
const W = 'work', ME = 'personal', SYS = 'system';
const TYPES = Object.freeze({
  meeting_alert: [P, W], meeting_prep: [P, W],
  escalation_alert: [P, W], escalation: [P, W], sentiment_escalation: [P, W],
  watched_reply: [P, W], ticket_commitment: [P, W],
  email: [P, W],
  standup: [P, W], eod: [P, W],
  journal: [P, ME],
  todo: [L, W],
  '121': [P, W],
  day_plan: [P, W], brief: [P, W],
  hike_checkin: [P, ME], ambient: [P, ME], room_offer: [P, ME], router_restart: [P, ME],
  uat_volunteers: [P, W], meeting_followup: [P, W],
  capture_failed: [P, SYS],
  needs_you: [P, W], approvals: [P, W], teams_mention: [P, W], nudge_cleared: [P, W],
  plan_milestone: [L, W], team_cover: [P, W],
  block_start: [L, W], block_two_minute: [L, W], block_wind_down: [L, W], block_end: [L, W],
  block_summary: [P, W],
  held_summary: [P, ME],
  router_health: [P, SYS], system_alert: [P, SYS], sense_alert: [P, SYS],
  vault_hygiene: [L, SYS], knowledge_reflection: [L, SYS], capability_suggestions: [L, SYS],
  plaud: [L, W], sweep_complete: [L, SYS], journeys: [P, ME],
  overtime_signoff: [L, W], leave_declined: [P, W], leave_clashes: [P, W],
  energy_unusual: [P, ME],
  weekly_risk: [L, W], soap_report: [L, W], weekly_review: [L, ME],
});

// A push about a moment (a meeting starting, a focus block, a nudge) is useless
// hours later; everything else keeps for DEFAULT_STALE_MS.
const SHORT_LIVED = new Set([
  'meeting_alert', 'meeting_prep', 'block_start', 'block_two_minute', 'block_wind_down', 'block_end',
  'room_offer', 'ambient', 'day_plan', 'standup', 'eod', 'todo', 'journal', 'router_restart',
]);

// Never held while driving: the hike check-in is how a missing walker is caught.
const DRIVE_EXEMPT = new Set(['hike_checkin', 'test']);

function classify(type) {
  const c = TYPES[type];
  return c ? { needs: c[0], sphere: c[1], known: true } : { needs: P, sphere: ME, known: false };
}

/**
 * The decision. PURE.
 * @param {string} type
 * @param {{driving:'driving'|'not'|'unknown', atDesk:boolean|null, onDuty:boolean|null, hiking:boolean}} s
 * @param {{critical?:boolean, probe?:boolean}} opts
 * @returns {{hold:false}|{hold:true, until:'parked'|'on-duty'|'hike-over'|'desk', why:string}}
 */
function decide(type, s = {}, { critical = false, probe = false } = {}) {
  if (probe) return { hold: false };
  const c = classify(type);
  if (s.driving === 'driving' && !DRIVE_EXEMPT.has(type)) {
    return { hold: true, until: 'parked', why: 'you are driving' };
  }
  if (critical && c.needs !== L) return { hold: false };
  if (c.sphere === W && s.onDuty === false) {
    return { hold: true, until: 'on-duty', why: 'outside your work hours' };
  }
  if (c.sphere === W && s.hiking === true) {
    return { hold: true, until: 'hike-over', why: 'you are out on a walk' };
  }
  if (c.needs === L && s.atDesk === false) {
    return { hold: true, until: 'desk', why: 'it needs your laptop and you are out' };
  }
  return { hold: false };
}

function staleAfterMs(type) {
  return SHORT_LIVED.has(type) ? SHORT_STALE_MS : DEFAULT_STALE_MS;
}

// ── The live moment ───────────────────────────────────────────────────────────

function _inWindow(raw, now) {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(raw || ''));
  if (!m) return null;
  const s = Number(m[1]) * 60 + Number(m[2]);
  const e = Number(m[3]) * 60 + Number(m[4]);
  const mins = now.getHours() * 60 + now.getMinutes();
  return s <= e ? (mins >= s && mins < e) : (mins >= s || mins < e);
}

function _pad(n) { return String(n).padStart(2, '0'); }

/** On duty: a working day, inside work hours, not booked off. Null = can't tell. */
function _onDuty(now) {
  try {
    const wd = require('./working-days');
    if (!wd.isWorkingDay(now)) return false;
  } catch { return null; }
  let hours = '08:00-18:00';
  try { hours = require('./attention-settings').read().workingHours || hours; } catch { /* default */ }
  const inHours = _inWindow(hours, now);
  if (inHours === false) return false;
  try {
    const ta = require('./team-availability');
    const day = `${now.getFullYear()}-${_pad(now.getMonth() + 1)}-${_pad(now.getDate())}`;
    const off = ta.selfAbsenceOn(day, ta.snapshot());
    if (off && off.known && off.off) return false;
  } catch { /* leave unknown is not "off" */ }
  return inHours === null ? null : true;
}

/** A hike armed and already started (planned start passed). */
function _hiking(now) {
  try {
    const rows = db.all("SELECT planned_start FROM hike_trips WHERE status IN ('armed','alerted')");
    return rows.some((r) => { const t = Date.parse(r.planned_start || ''); return Number.isFinite(t) && t <= now.getTime(); });
  } catch { return false; }
}

/**
 * Where he is and what he is doing, as far as it affects a push. Never throws.
 * atDesk: the laptop is in use now → true; home or work → true; out/elsewhere
 * or walking/exercising → false; otherwise null.
 */
async function situation(now = new Date()) {
  const s = { driving: 'unknown', atDesk: null, onDuty: _onDuty(now), hiking: _hiking(now), evidence: [] };
  let phone = null;
  try { phone = await require('./ha').getPhoneStatus(); } catch { /* unknown */ }
  try {
    const d = require('./transport').drivingState(phone, now.getTime());
    s.driving = d.state === 'driving' ? 'driving' : (d.state === 'unknown' ? 'unknown' : 'not');
    if (d.state === 'driving') s.evidence.push(d.why);
  } catch { /* unknown */ }
  try {
    const r = require('./desktop-activity').run(now);
    if (r && r.known && r.app) { s.atDesk = true; s.evidence.push(`laptop in use (${r.label || r.app})`); }
  } catch { /* unknown */ }
  if (s.atDesk === null) {
    try {
      const life = await require('./life-state').read(now);
      if (life.doing === 'walking' || life.doing === 'exercising' || life.doing === 'driving') s.atDesk = false;
      else if (life.place && (life.place.kind === 'home' || life.place.kind === 'work')) s.atDesk = true;
      else if (life.place && (life.place.kind === 'out' || life.place.kind === 'elsewhere')) s.atDesk = false;
      if (life.place && life.place.kind !== 'unknown') s.evidence.push(`place: ${life.place.kind}${life.place.label ? ` (${life.place.label})` : ''}`);
    } catch { /* unknown */ }
  }
  return s;
}

// ── Holding and releasing ─────────────────────────────────────────────────────

function read() {
  try {
    const v = JSON.parse(db.getState(KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function _write(list) {
  try { db.setState(KEY, JSON.stringify(list.slice(-MAX_HELD))); } catch (e) { console.warn('[PushMoment] could not save held pushes:', e.message); }
}

function _slimData(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (v == null || typeof v === 'function') continue;
    if (typeof v === 'string' && v.length > 600) continue;
    out[k] = v;
  }
  try { if (JSON.stringify(out).length > 3000) return { type: out.type, tab: out.tab, url: out.url, key: out.key }; } catch { return { type: out.type }; }
  return out;
}

/**
 * Hold this push if the moment is wrong. Returns the decision when held, null
 * when it should go now. Never throws — a hold that cannot be decided sends.
 */
async function holdIfWrongMoment(title, body, data = {}, { critical = false, probe = false, now = new Date(), situationFn = null } = {}) {
  try {
    if (probe || data._momentReleased) return null;
    // ⚠ Under `node --test` the live moment is the clock the suite happens to
    // run at — a work push tested at 19:00 would be held. Tests that mean to
    // exercise this pass their own situationFn.
    if (!situationFn && process.env.NODE_TEST_CONTEXT) return null;
    situationFn = situationFn || situation;
    const s = await situationFn(now);
    const d = decide(data.type, s, { critical, probe });
    if (!d.hold) return null;
    const list = read();
    // The same alert re-sent while held replaces its earlier copy rather than stacking.
    const key = data.key || `${data.type || 'none'}|${title}`;
    const kept = list.filter((h) => h.key !== key);
    kept.push({ key, title: String(title || '').slice(0, 200), body: body == null ? null : String(body).slice(0, 600), data: _slimData(data), until: d.until, why: d.why, at: now.toISOString() });
    _write(kept);
    return d;
  } catch (e) {
    console.warn('[PushMoment] could not decide — sending:', e.message);
    return null;
  }
}

/** One push for many. PURE. */
function summaryOf(items) {
  const titles = items.slice(0, 4).map((h) => h.title).filter(Boolean);
  const more = items.length - titles.length;
  return {
    title: `While you were away — ${items.length} things`,
    body: titles.join(' · ') + (more > 0 ? ` · and ${more} more` : ''),
  };
}

/**
 * Release whatever the moment now allows. Called every minute by the scheduler.
 * Returns { released, stale, stillHeld }. Cheap when nothing is held.
 */
async function tick({ now = new Date(), push = null, situationFn = situation } = {}) {
  const list = read();
  if (!list.length) return { released: 0, stale: 0, stillHeld: 0 };
  const send = push || require('./webpush').sendToAll;
  const { ALWAYS_DELIVER } = require('./webpush');
  const s = await situationFn(now);
  const keep = [];
  const go = [];
  let stale = 0;
  for (const h of list) {
    const age = now.getTime() - Date.parse(h.at || '');
    const type = h.data && h.data.type;
    if (!Number.isFinite(age) || age > staleAfterMs(type)) {
      stale++;
      try {
        db.logPushOutcome({ type: type || null, title: h.title, body: h.body, app: null, outcome: 'suppressed', reason: `held (${h.why}) and gone stale — not sent; it is still on Now`, sentCount: 0, failedCount: 0 });
      } catch { /* bookkeeping only */ }
      continue;
    }
    const d = decide(type, s, { critical: ALWAYS_DELIVER.has(type) });
    if (d.hold) keep.push({ ...h, until: d.until, why: d.why });
    else go.push(h);
  }
  _write(keep);
  if (go.length > SUMMARY_OVER) {
    const sum = summaryOf(go);
    await send(sum.title, sum.body, { type: 'held_summary', tab: 'surface', key: `held_summary:${now.toISOString().slice(0, 16)}`, _momentReleased: true });
  } else {
    for (const h of go) await send(h.title, h.body, { ...(h.data || {}), _momentReleased: true });
  }
  return { released: go.length, stale, stillHeld: keep.length };
}

module.exports = {
  KEY, TYPES, SHORT_LIVED, DRIVE_EXEMPT, classify, decide, staleAfterMs, situation,
  read, holdIfWrongMoment, summaryOf, tick, _onDuty, _inWindow,
};
