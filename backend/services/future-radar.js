'use strict';

/**
 * Build 19H–19X — the Future Radar.
 *
 * "What is coming up in my life that may matter, and is there anything I
 * should do before it arrives?" — over the next 7, 14 or 30 days.
 *
 * It is a SYNTHESIS of what NEURO already knows, computed at read time. It is
 * not a calendar clone, not a task list and not a reminder dump: nothing is
 * stored except what CHANGED (for Activity), and nothing is created.
 *
 * ── Inputs (19J) ────────────────────────────────────────────────────────────
 *   personal calendar entries   the PHONE's calendars (EventKit). The Outlook
 *                               account is the work diary and is not an input
 *                               unless Nick classified it as something else.
 *                               Calendars he classified as work, and ones he
 *                               ignored, are out.
 *   personal dates              personal-dates (explicit birthdays/anniversaries)
 *   personal obligations        personal-obligations (explicit only)
 *   hikes                       calendar entries the Hike weekly loop counts as a
 *                               planned hike — said to be the LOOP'S rule, not a
 *                               link Nick made
 *   goal reviews                a review date Nick set on a goal
 *   companion care (Build 20)   care items Nick ADDED for Ember, by their own
 *                               date; and anything above he LINKED to her care
 *                               carries that link as context. Nothing is
 *                               scheduled for her — no assumed vet/flea cycles.
 * Out: telemetry, health readings, source diagnostics, the work backlog.
 *
 * ── Ordering (19I) ──────────────────────────────────────────────────────────
 *   needs-you first → then WHEN → then importance Nick stated on the item.
 * Importance inherited from a linked goal is CONTEXT and never ranks or
 * escalates anything (19Q). Work cannot dominate by volume: it is not an input.
 *
 * ── Dedupe (19M) — deterministic only ───────────────────────────────────────
 *   • an entry personal-dates already represents (same meeting id) is absorbed;
 *   • two calendar copies with the SAME normalised title on the same day at the
 *     same minute (or both all-day) are one item listing both sources;
 *   • a reminder and a calendar entry are NEVER merged — no deterministic link
 *     exists between them, so they stay separate.
 *
 * ── Actionability (19N) and attention (19O) ────────────────────────────────
 *   needs_you          explicit open preparation and the subject is ≤2 days
 *                      away, or a personal obligation's own date (stated or
 *                      set) is ≤1 day away or up to 14 days past
 *   preparation_open   preparation exists and is open; or an open dated
 *                      obligation further out
 *   planned            a planned hike
 *   none               nothing known to do (an appointment with no prep is none)
 *   unknown            the source stopped listing it
 * NOTHING here pushes. `attention.eligible` says whether the existing policy
 * may be asked; an upcoming date on its own is never eligible.
 *
 * The composer is pure; readers at the bottom gather inputs.
 */

const domainsLib = require('../../shared/life-domains.cjs');

const HORIZONS = Object.freeze([7, 14, 30]);
const PREP_ACTION_DAYS = 2;
const HIKE_WORDS = /\bhik(e|es|ing)\b/i;
const ACTION_STATES = Object.freeze(['none', 'planned', 'preparation_open', 'needs_you', 'unknown']);

const DAY_MS = 86400000;
const _utc = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const addDays = (d, n) => new Date(_utc(d) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((_utc(b) - _utc(a)) / DAY_MS);
const normTitle = (s) => String(s || '').normalize('NFKD').replace(/[‘’']/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayName = (d) => DAYS[new Date(_utc(d)).getUTCDay()];

/** "in 11 days" / "tomorrow" / "Saturday". PURE. */
function whenWords(today, day) {
  const n = daysBetween(today, day);
  if (n < 0) return `${-n} day${n === -1 ? '' : 's'} ago`;
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n < 7) return dayName(day);
  return `in ${n} days`;
}

/** Validate a horizon. Refused, never clamped. PURE. */
function parseHorizon(v, fallback = 14) {
  if (v === undefined || v === null || v === '') return { ok: true, days: fallback };
  const n = Number(v);
  return HORIZONS.includes(n) ? { ok: true, days: n } : { ok: false, error: `days must be one of ${HORIZONS.join(', ')}` };
}

function _isWorkOnly(domains) {
  const ds = (domains && domains.domains) || [];
  return (ds.length > 0 && ds.every((d) => d.domain === 'work')) || (!ds.length && domains && domains.sphere === 'work');
}

function _prepState(prep, away) {
  const open = prep.filter((p) => p.status === 'open');
  if (open.length && away <= PREP_ACTION_DAYS) return { actionState: 'needs_you', why: `"${open[0].title}" is still open and it is ${away === 0 ? 'today' : away === 1 ? 'tomorrow' : `${away} days away`}` };
  if (open.length) return { actionState: 'preparation_open', why: `preparation is open: "${open[0].title}"` };
  if (prep.length) return { actionState: 'none', why: `preparation done: "${prep[0].title}"` };
  return { actionState: 'none', why: 'nothing is known to need doing' };
}

/**
 * Compose the Radar. PURE.
 *
 *   today, horizonDays
 *   events       [{ meetingId, title, day, time, allDay, calendarName, calendarKey, domains, classification }]
 *   dates        personal-dates items
 *   obligations  personal-obligations items
 *   goals        active goals [{ id, title, reviewDate, links }]
 *   hikeGoal     { id, title } | null  (the Hike weekly loop's goal)
 *   prepBySubject Map subjectId → [{ taskId, title, status }]  EXPLICIT prep links
 *   goalsByEntity Map entityId → [{ id, title }]  EXPLICIT goal links
 *   coverage     { calendarAheadDays, calendarFresh, datesComplete, reasons:[] }
 *   undatedObligations, workExcluded  counts, reported
 */
function composeRadar({ today, horizonDays = 14, events = [], dates = [], obligations = [], goals = [], hikeGoal = null,
  prepBySubject = new Map(), goalsByEntity = new Map(), coverage = {}, undatedObligations = 0, workExcluded = 0,
  care = [], careByEntity = new Map(), leadReminders = {}, vehicles = [], finances = [], projects = [] } = {}) {
  const last = addDays(today, horizonDays);
  const inWindow = (d) => d && d >= today && d <= last;
  const items = [];
  const absorbed = new Set();
  const goalCtx = (id, extra = []) => [...(goalsByEntity.get(id) || []).map((g) => ({ goalId: g.id, title: g.title, basis: 'explicit' })), ...extra];

  // ── personal dates ──
  for (const d of dates) {
    for (const s of d.sources || []) if (s.meetingId) absorbed.add(s.meetingId);
    if (!inWindow(d.date)) continue;
    const away = daysBetween(today, d.date);
    const explicit = (prepBySubject.get(d.id) || []).map((p) => ({ ...p, link: 'linked by you' }));
    const named = (d.prep || []).filter((p) => !explicit.some((e) => e.taskId === p.taskId)).map((p) => ({ ...p, link: `linked by name (${p.link})` }));
    const prep = [...explicit, ...named];
    let st = _prepState(prep, away);
    // Lead reminders Nick set for this KIND of date (date-nags): context →
    // prompt → needs you. The same pure function decides the one push.
    const lead = require('./date-nags').reminderStage(d, { today, offsets: leadReminders[d.kind] || null, prep });
    if (lead && lead.stage === 'needs_you') st = { actionState: 'needs_you', why: lead.line };
    const src = (d.sources || [])[0] || {};
    const why = [src.basis === 'declared' ? `you declared it in ${src.note || 'your notes'}`
      : src.basis === 'birthdays-calendar' ? 'from your Birthdays calendar'
        : `your "${src.calendar || 'calendar'}" entry calls it ${d.kind === 'birthday' ? 'a birthday' : d.kind === 'anniversary' ? 'an anniversary' : 'this'}`];
    if (st.why) why.push(st.why);
    if (lead && lead.stage !== 'needs_you') why.push(lead.line);
    if (lead) why.push(`your ${d.kind} lead reminders: ${leadReminders[d.kind].join(', ')} days before`);
    items.push({
      reminder: lead ? { stage: lead.stage, line: lead.line, step: lead.step, push: lead.push } : null,
      id: d.id, title: d.title, date: d.date, time: null, window: null,
      domain: null, sphere: 'personal', kind: d.kind === 'birthday' || d.kind === 'anniversary' ? d.kind : 'personal-date',
      sourceRefs: (d.sources || []).map((s) => s.meetingId || s.note).filter(Boolean),
      linkedEntityRefs: d.person ? [`person:${d.person}`] : [],
      linkedTaskRefs: prep.map((p) => p.taskId),
      linkedGoals: goalCtx(d.id),
      importance: d.importance || null,
      actionState: st.actionState,
      confidence: named.length && !explicit.length ? 'medium' : 'high',
      whyVisible: why,
      when: whenWords(today, d.date),
    });
  }

  // ── calendar entries (and hikes) ──
  const folded = new Map();
  for (const e of events) {
    if (absorbed.has(e.meetingId)) continue;
    if (!inWindow(e.day)) continue;
    if (_isWorkOnly(e.domains)) continue;
    const hike = !!hikeGoal && HIKE_WORDS.test(e.title || '');
    const key = hike ? `hike|${e.day}` : `${e.day}|${normTitle(e.title)}|${e.allDay ? 'all' : e.time || ''}`;
    if (folded.has(key)) { folded.get(key).sourceRefs.push(e.meetingId); continue; }
    const away = daysBetween(today, e.day);
    const doms = (e.domains && e.domains.domains) || [];
    const calWhy = e.classification === 'classified' && doms.length
      ? `in your "${e.calendarName}" calendar, which you classified as ${doms.map((d) => domainsLib.domainLabel(d.domain)).join(' and ')}`
      : `in your "${e.calendarName || 'phone'}" calendar, which is not classified — what it is for is unknown`;
    let item;
    if (hike) {
      const explicitGoals = goalCtx(`meeting:${e.meetingId}`);
      item = {
        id: `radar:hike:${e.day}`, title: 'Hike planned', date: e.day, time: null, window: null,
        domain: null, sphere: 'personal', kind: 'hike', sourceRefs: [e.meetingId], linkedEntityRefs: [], linkedTaskRefs: [],
        linkedGoals: explicitGoals.length ? explicitGoals : [{ goalId: hikeGoal.id, title: hikeGoal.title, basis: 'hiking-loop-rule' }],
        importance: null, actionState: 'planned', confidence: explicitGoals.length ? 'high' : 'medium',
        whyVisible: [`a "${e.title}" entry ${calWhy}`, explicitGoals.length ? `you linked it to "${hikeGoal.title}"`
          : `the "${hikeGoal.title}" loop counts a calendar entry titled hiking as a planned hike (its rule — not a link you made)`],
        when: whenWords(today, e.day),
      };
    } else {
      const subj = `meeting:${e.meetingId}`;
      const st = _prepState(prepBySubject.get(subj) || [], away);
      item = {
        id: `radar:event:${e.meetingId}`, title: e.title, date: e.day, time: e.allDay ? null : e.time || null,
        window: e.allDay ? 'all-day' : null,
        domain: doms.length ? doms[0].domain : null, domains: doms.map((d) => d.domain), sphere: doms.length ? 'personal' : null,
        kind: 'event', sourceRefs: [e.meetingId], linkedEntityRefs: [], linkedTaskRefs: (prepBySubject.get(subj) || []).map((p) => p.taskId),
        linkedGoals: goalCtx(subj), importance: null, actionState: st.actionState, confidence: 'high',
        whyVisible: [calWhy, st.why], when: whenWords(today, e.day),
      };
    }
    folded.set(key, item);
    items.push(item);
  }

  // ── personal obligations with a date in the window (or needing him now) ──
  for (const o of obligations) {
    const due = o.due && o.due.date ? o.due.date : null;
    if (!(o.needsNow || inWindow(due))) continue;
    if (o.actionState === 'none') continue;
    items.push({
      id: o.id, title: o.what, date: due, time: o.due && o.due.time ? o.due.time : null, window: null,
      domain: o.domains[0] ? o.domains[0].domain : null, domains: o.domains.map((d) => d.domain), sphere: 'personal',
      kind: o.admin ? 'admin' : 'obligation', sourceRefs: [o.id], linkedEntityRefs: [], linkedTaskRefs: [o.id],
      linkedGoals: (o.linkedGoals || []).map((g) => ({ goalId: g.id, title: g.title, basis: 'explicit' })),
      importance: o.importance || null, actionState: o.actionState, confidence: o.actionState === 'unknown' ? 'low' : 'high',
      whyVisible: [`${o.admin ? 'personal-admin ' : ''}${o.kind} from ${o.source || 'NEURO'}${o.due ? `, ${o.due.label}` : ''}`, ...(o.whyPersonal || []), o.needsWhy].filter(Boolean),
      when: due ? whenWords(today, due) : 'no date',
    });
  }

  // ── Build 20J: companion care Nick added (companion-care.radarItems) ──
  for (const c of care) {
    if (!(inWindow(c.date) || c.actionState === 'needs_you')) continue;
    items.push({
      id: c.id, title: c.title, detail: c.detail || null, date: c.date, time: c.time || null, window: null,
      domain: 'ember', domains: ['ember'], sphere: 'personal', kind: 'care', careKind: c.careKind,
      sourceRefs: [c.id], linkedEntityRefs: c.companion ? [c.companion.id] : [], linkedTaskRefs: [], linkedGoals: [],
      importance: null, actionState: c.actionState, confidence: 'high', companion: c.companion || null,
      whyVisible: c.whyVisible, when: c.date ? whenWords(today, c.date) : 'no date',
    });
  }

  // ── Build 20G: anything Nick LINKED to a companion's care says so ──
  for (const it of items) {
    const refs = [it.id, ...(it.kind === 'event' || it.kind === 'hike' ? it.sourceRefs.map((m) => `meeting:${m}`) : [])];
    const links = refs.flatMap((r) => careByEntity.get(r) || []);
    if (!links.length || it.kind === 'care') continue;
    const l = links[0];
    it.companion = { id: l.companionId, name: l.name, careKind: l.careKind };
    if (!it.linkedEntityRefs.includes(l.companionId)) it.linkedEntityRefs.push(l.companionId);
    it.whyVisible.push(`you linked it to ${l.name}'s care (${l.careKind})`);
  }

  // ── Build 21AH: vehicle obligations Nick recorded (vehicle.radarItems) ──
  // A task or reminder he linked to one IS its action, so it folds into the
  // vehicle item instead of appearing twice; its state stays visible there.
  for (const v of vehicles) {
    const absorbedTasks = items.filter((it) => (it.kind === 'obligation' || it.kind === 'admin') && (v.linkedTaskRefs || []).includes(it.id));
    for (const t of absorbedTasks) items.splice(items.indexOf(t), 1);
    items.push({
      id: v.id, title: v.title, detail: v.detail || null, date: v.date || null, time: null, window: null,
      domain: 'travel', domains: ['travel'], sphere: 'personal', kind: 'vehicle', obligationType: v.obligationType,
      sourceRefs: [v.id], linkedEntityRefs: [v.vehicle.id], linkedTaskRefs: v.linkedTaskRefs || [], linkedGoals: [],
      importance: null, actionState: v.actionState, confidence: v.confidence || 'medium', vehicle: v.vehicle,
      whyVisible: [...v.whyVisible, ...absorbedTasks.map((t) => `your task "${t.title}" is its action (${t.actionState === 'preparation_open' ? 'open' : t.actionState})`)],
      when: v.date ? whenWords(today, v.date) : 'by mileage',
    });
  }

  // ── Build 23X: finance obligations Nick recorded (finance.radar) ──
  // Only explicit obligations — a routine Direct Debit is never a Radar item.
  // A task linked as the obligation's action folds into it, like a vehicle date.
  for (const f of finances) {
    const absorbedTasks = items.filter((it) => (it.kind === 'obligation' || it.kind === 'admin') && (f.linkedTaskRefs || []).includes(it.id));
    for (const t of absorbedTasks) items.splice(items.indexOf(t), 1);
    items.push({
      id: f.id, title: f.title, detail: f.detail || null, date: f.date || null, time: null, window: null,
      domain: 'finance', domains: ['finance'], sphere: 'personal', kind: 'finance', obligationType: f.obligationType,
      sourceRefs: [f.id], linkedEntityRefs: [], linkedTaskRefs: f.linkedTaskRefs || [], linkedGoals: [],
      importance: null, actionState: f.actionState, confidence: f.confidence || 'high',
      whyVisible: [...f.whyVisible, ...absorbedTasks.map((t) => `your task "${t.title}" is its action (${t.actionState === 'preparation_open' ? 'open' : t.actionState})`)],
      when: f.date ? whenWords(today, f.date) : 'no date',
    });
  }

  // ── Build 24R: personal projects — a stated deadline, or a dated task linked
  // explicitly. Never inactivity. A task that is already an obligation item is
  // the same thing: it folds into the project item rather than showing twice.
  for (const p of projects) {
    const absorbed = items.filter((it) => (it.kind === 'obligation' || it.kind === 'admin') && (p.linkedTaskRefs || []).includes(it.id));
    for (const t of absorbed) items.splice(items.indexOf(t), 1);
    items.push({
      id: p.id, title: p.title, detail: null, date: p.date, time: null, window: null,
      domain: null, domains: [], sphere: 'personal', kind: p.kind, projectId: p.projectId,
      sourceRefs: [p.projectId], linkedEntityRefs: [p.projectId], linkedTaskRefs: p.linkedTaskRefs || [], linkedGoals: [],
      importance: null, actionState: p.actionState, confidence: 'high',
      whyVisible: p.whyVisible, when: p.date ? whenWords(today, p.date) : 'no date',
    });
  }

  // ── goal reviews ──
  for (const g of goals) {
    if (!g.reviewDate || !inWindow(g.reviewDate)) continue;
    items.push({
      id: `radar:goal-review:${g.id}`, title: `Review "${g.title}"`, date: g.reviewDate, time: null, window: null,
      domain: null, sphere: 'personal', kind: 'goal-review', sourceRefs: [g.id], linkedEntityRefs: [], linkedTaskRefs: [],
      linkedGoals: [{ goalId: g.id, title: g.title, basis: 'explicit' }], importance: null, actionState: 'none', confidence: 'high',
      whyVisible: ['you set a review date on this goal'], when: whenWords(today, g.reviewDate),
    });
  }

  for (const it of items) {
    it.attention = { eligible: it.actionState === 'needs_you', rule: it.actionState === 'needs_you' ? 'open preparation or an own deadline is close' : 'upcoming on its own never interrupts' };
    if (!it.domains) it.domains = it.domain ? [it.domain] : [];
  }
  const rank = (it) => domainsLib.importanceRank(it.importance);
  items.sort((a, b) => (Number(b.actionState === 'needs_you') - Number(a.actionState === 'needs_you'))
    || String(a.date || '0000').localeCompare(String(b.date || '0000'))
    || String(a.time || '').localeCompare(String(b.time || ''))
    || rank(a) - rank(b)
    || String(a.id).localeCompare(String(b.id)));

  const count = (f) => items.filter(f).length;
  const summary = {
    horizonDays,
    personalDates: count((i) => i.kind === 'birthday' || i.kind === 'anniversary' || i.kind === 'personal-date'),
    obligations: count((i) => i.kind === 'obligation' || i.kind === 'admin'),
    admin: count((i) => i.kind === 'admin'),
    plannedHikes: count((i) => i.kind === 'hike'),
    events: count((i) => i.kind === 'event'),
    goalReviews: count((i) => i.kind === 'goal-review'),
    care: count((i) => i.kind === 'care' || !!i.companion),
    vehicle: count((i) => i.kind === 'vehicle'),
    finance: count((i) => i.kind === 'finance'),
    projects: count((i) => i.kind === 'project' || i.kind === 'project-task'),
    unknownDomain: count((i) => i.kind === 'event' && !i.domains.length),
    needsYou: count((i) => i.actionState === 'needs_you'),
    undatedObligations, workExcluded,
  };
  const n = (k, one, many) => `${summary[k]} ${summary[k] === 1 ? one : many}`;
  summary.lines = [
    n('personalDates', 'personal date', 'personal dates'),
    n('obligations', 'open personal obligation', 'open personal obligations'),
    n('plannedHikes', 'planned hike', 'planned hikes'),
    ...(summary.care ? [n('care', 'companion-care item', 'companion-care items')] : []),
    ...(summary.vehicle ? [n('vehicle', 'vehicle date', 'vehicle dates')] : []),
    ...(summary.finance ? [n('finance', 'finance date', 'finance dates')] : []),
    ...(summary.projects ? [n('projects', 'personal-project date', 'personal-project dates')] : []),
    n('events', 'other calendar entry', 'other calendar entries') + (summary.unknownDomain ? ` (${summary.unknownDomain} from calendars not yet classified)` : ''),
    `${summary.needsYou} thing${summary.needsYou === 1 ? '' : 's'} needing action now`,
  ];
  summary.title = `Next ${horizonDays} days`;

  const reasons = [...(coverage.reasons || [])];
  if (coverage.calendarAheadDays == null) reasons.push('the phone has not said how far ahead its calendar push reaches');
  else if (coverage.calendarAheadDays < horizonDays) reasons.push(`the phone's calendar push reaches ${coverage.calendarAheadDays} days ahead, less than ${horizonDays}`);
  if (coverage.calendarFresh === false) reasons.push('the phone calendar push is not fresh');
  if (coverage.datesComplete === false) reasons.push('personal-date coverage is incomplete');
  const complete = reasons.length === 0;
  return {
    horizonDays, from: today, to: last,
    heading: complete ? `Coming up in the next ${horizonDays} days` : `Known upcoming items — next ${horizonDays} days`,
    coverage: { complete, reasons, calendarAheadDays: coverage.calendarAheadDays ?? null },
    summary, items,
  };
}

/**
 * Goal progress (19R). PURE. Evidence-based, NEVER a percentage.
 *   hiking   hiking-loop read (for the hike goal) or null
 *   linked   [{ id, completedAt }] items explicitly linked to the goal
 */
function goalProgress(goal, { hikeGoalId = null, hiking = null, linked = [], today = null } = {}) {
  if (goal.status === 'paused') return { state: 'paused', why: 'you paused it' };
  if (goal.status === 'achieved') return { state: 'achieved', why: 'you marked it achieved' };
  if (goal.status === 'dropped') return { state: 'dropped', why: 'you dropped it' };
  if (hikeGoalId && goal.id === hikeGoalId) {
    if (!hiking || !hiking.active || !hiking.current) return { state: 'unknown', why: 'the hiking loop could not be read', period: 'this week' };
    const cur = hiking.current;
    if ((cur.confirmed || []).length) return { state: 'evidence-this-period', why: cur.line, period: 'this week', basis: 'confirmed hike (GPS track or you)' };
    return { state: 'no-evidence-yet', why: cur.line, period: 'this week', basis: 'only a GPS track or your confirmation counts' };
  }
  const since = today ? addDays(today, -7) : null;
  const done = (linked || []).filter((l) => l.completedAt && (!since || String(l.completedAt).slice(0, 10) >= since));
  if (done.length) return { state: 'evidence-this-period', why: `${done.length} linked item${done.length === 1 ? '' : 's'} completed in the last 7 days`, period: 'last 7 days', basis: 'explicitly linked items completed' };
  return { state: 'no-evidence-yet', why: (linked || []).length ? 'nothing linked to it was completed in the last 7 days' : 'nothing is linked to it, so NEURO has no evidence either way', period: 'last 7 days', basis: 'explicitly linked items only' };
}

// ── readers ─────────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }

function _events(today, last) {
  const db = _db();
  const sc = require('./source-classification');
  const calMap = sc.classificationMap('calendar');
  const rows = db.all(`SELECT meeting_id, provider, title, start_local, is_all_day, calendar_key, calendar_name FROM wm_meetings
                        WHERE status = 'scheduled' AND merged_into IS NULL AND substr(start_local, 1, 10) >= ? AND substr(start_local, 1, 10) <= ?`,
  [addDays(today, -1), last]);
  const hl = require('./hiking-loop');
  const out = [];
  for (const r of rows) {
    const key = r.provider === 'graph' ? sc.GRAPH_PRIMARY : r.calendar_key;
    const cls = key ? calMap.get(key) || null : null;
    // The Outlook account is the work diary: an input only if Nick classified it otherwise.
    if (r.provider === 'graph' && !(cls && (cls.domains || []).some((d) => d !== 'work'))) continue;
    if (cls && cls.tracked === false) continue;
    const claims = sc.claimsFor(cls, { label: r.calendar_name });
    out.push({
      meetingId: r.meeting_id, title: r.title, day: hl.entryDay(r.start_local, r.is_all_day === 1),
      time: r.is_all_day === 1 ? null : String(r.start_local).slice(11, 16), allDay: r.is_all_day === 1,
      calendarName: r.provider === 'graph' ? 'Outlook' : r.calendar_name, calendarKey: key,
      classification: claims.state, domains: domainsLib.resolveDomains(claims.claims),
    });
  }
  return out;
}

function _coverage(nowMs) {
  const reasons = [];
  let ahead = null;
  let fresh = null;
  try {
    const raw = _db().getState('apple_push_by_client');
    const all = raw ? JSON.parse(raw) : {};
    const recent = Object.values(all || {}).filter((p) => p && p.at && nowMs - Date.parse(p.at) < 36 * 3600000);
    fresh = recent.length > 0;
    ahead = recent.length ? Math.max(...recent.map((p) => Number(p.aheadDays) || 0)) : null;
  } catch { reasons.push('the phone calendar push record could not be read'); }
  return { calendarAheadDays: ahead, calendarFresh: fresh, reasons };
}

/** Explicit prep links, resolved to task titles and states. */
function _prepBySubject(bySubject, taskIndex) {
  const out = new Map();
  for (const [subj, ids] of bySubject) {
    out.set(subj, ids.map((id) => {
      const t = taskIndex.get(id);
      return { taskId: id, title: t ? t.title : id, status: t ? t.status : 'unknown' };
    }));
  }
  return out;
}

/** The live Radar for one horizon. */
function read({ now = Date.now(), horizonDays = 14 } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const today = require('./world-model').localMinute(nowMs).slice(0, 10);
  const last = addDays(today, horizonDays);
  const gaps = [];
  const cr = require('./canonical-read');
  const po = require('./personal-obligations');
  let events = []; try { events = _events(today, last); } catch (e) { gaps.push({ input: 'calendar', why: e.message }); }
  let pd = null; try { pd = require('./personal-dates').read({ now: nowMs }); } catch (e) { gaps.push({ input: 'personal-dates', why: e.message }); }
  let obl = null; try { obl = po.read({ now: nowMs }); } catch (e) { gaps.push({ input: 'obligations', why: e.message }); }
  let goals = []; try { goals = cr.listGoals({ status: 'active' }); } catch (e) { gaps.push({ input: 'goals', why: e.message }); }
  let hiking = null; try { hiking = require('./hiking-loop').read({ now: nowMs, weeks: 1 }); } catch (e) { gaps.push({ input: 'hiking', why: e.message }); }
  const hikeGoal = hiking && hiking.active && hiking.goal ? { id: hiking.goal.goalId, title: hiking.goal.title } : null;
  const goalsByEntity = new Map();
  for (const g of goals) for (const l of g.links || []) goalsByEntity.set(l.entityId, [...(goalsByEntity.get(l.entityId) || []), { id: g.id, title: g.title }]);
  let taskIndex = new Map();
  try { taskIndex = new Map(require('./world-obligations').listTasks({ status: 'all', limit: 2000 }).map((t) => [t.taskId, t])); } catch { taskIndex = new Map(); }
  const prep = po.prepLinkMap();
  const cov = _coverage(nowMs);
  if (pd && pd.coverage && pd.coverage.state !== 'complete') cov.datesComplete = false;
  if (!pd) cov.reasons.push('personal dates could not be read');
  for (const g of gaps) cov.reasons.push(`${g.input} could not be read`);
  const dates = pd ? [...(pd.active || []), ...(pd.later || [])] : [];
  const cc = require('./companion-care');
  const careRead = cc.radar({ today, last, now: nowMs });
  if (careRead.error) { gaps.push({ input: 'companion-care', why: careRead.error }); cov.reasons.push('companion care could not be read'); }
  const vehicleRead = require('./vehicle').radar({ today, last, now: nowMs });
  if (vehicleRead.error) { gaps.push({ input: 'vehicle', why: vehicleRead.error }); cov.reasons.push('vehicle dates could not be read'); }
  const financeRead = require('./finance').radar({ today, last, now: nowMs });
  if (financeRead.error) { gaps.push({ input: 'finance', why: financeRead.error }); cov.reasons.push('finance dates could not be read'); }
  const projectRead = require('./projects').radar({ today, last, now: nowMs });
  if (projectRead.error) { gaps.push({ input: 'projects', why: projectRead.error }); cov.reasons.push('personal-project dates could not be read'); }
  const radar = composeRadar({
    today, horizonDays, events, dates, obligations: obl ? obl.items : [], goals, hikeGoal,
    prepBySubject: _prepBySubject(prep.bySubject, taskIndex), goalsByEntity, coverage: cov,
    undatedObligations: obl ? obl.counts.undated : 0, workExcluded: obl ? obl.counts.workExcluded : 0,
    care: careRead.items, careByEntity: cc.linkMap(), leadReminders: require('./date-nags').cadences(),
    vehicles: vehicleRead.items, finances: financeRead.items, projects: projectRead.items,
  });
  const progress = goals.map((g) => {
    const linked = (g.links || []).map((l) => taskIndex.get(l.entityId)).filter(Boolean).map((t) => ({ id: t.taskId, completedAt: t.completedAt || null }));
    return { goalId: g.id, title: g.title, importance: g.importance, progress: goalProgress(g, { hikeGoalId: hikeGoal && hikeGoal.id, hiking, linked, today }) };
  });
  return {
    ok: true, contract: cr.CONTRACT, asOf: new Date(nowMs).toISOString(), today, ...radar, goals: progress, gaps,
    rule: 'Only what NEURO was explicitly told: phone calendars, birthdays and anniversaries, personal obligations, hikes and goal reviews. Nothing here interrupts on its own; nothing is created.',
  };
}

/**
 * The durable job body (19W): record what CHANGED — an obligation opened or
 * completed, a Radar item that started needing Nick. The first run is a
 * baseline and records nothing, so turning this on cannot flood Activity.
 */
function refresh({ now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const db = _db();
  const po = require('./personal-obligations');
  const KEY = 'personal_ops_state';
  let held = null;
  try { held = JSON.parse(db.getState(KEY) || 'null'); } catch { held = null; }
  const obl = po.read({ now: nowMs });
  const radar = read({ now: nowMs, horizonDays: 30 });
  const open = Object.fromEntries(obl.items.filter((o) => o.actionState !== 'unknown').map((o) => [o.id, { title: o.what, admin: o.admin, ...((o.domains || []).some((d) => d.domain === 'home') ? { home: true } : {}) }]));
  const needs = Object.fromEntries(radar.items.filter((i) => i.actionState === 'needs_you').map((i) => [i.id, { title: i.title, kind: i.kind, date: i.date }]));
  let logged = 0;
  if (held && held.baselined) {
    for (const [id, o] of Object.entries(open)) {
      if (!held.open[id]) logged += po.logEvent('obligation-opened', { subjectId: id, detail: o, dedupeKey: `obligation-opened:${id}:${nowMs}`, now: nowMs }) ? 1 : 0;
    }
    for (const [id, o] of Object.entries(held.open || {})) {
      if (open[id]) continue;
      // Gone from the open set: completed only when the world model SAYS so.
      let t = null; try { t = require('./world-obligations').getTask(id); } catch { t = null; }
      let c = null; if (!t) { try { c = require('./world-obligations').getCommitment(id); } catch { c = null; } }
      const status = (t && t.status) || (c && c.status) || null;
      if (status === 'completed' || status === 'done' || status === 'fulfilled') {
        logged += po.logEvent(o.admin ? 'admin-resolved' : 'obligation-completed', { subjectId: id, detail: o, dedupeKey: `obligation-done:${id}:${nowMs}`, now: nowMs }) ? 1 : 0;
      }
    }
    for (const [id, i] of Object.entries(needs)) {
      if (!held.needs[id]) logged += po.logEvent('radar-needs-you', { subjectId: id, detail: i, dedupeKey: `radar-needs-you:${id}:${nowMs}`, now: nowMs }) ? 1 : 0;
    }
  }
  db.setState(KEY, JSON.stringify({ baselined: true, at: new Date(nowMs).toISOString(), open, needs }));
  return { ok: true, baseline: !(held && held.baselined), logged, open: Object.keys(open).length, needsYou: Object.keys(needs).length };
}

module.exports = {
  HORIZONS, PREP_ACTION_DAYS, ACTION_STATES,
  // pure
  parseHorizon, whenWords, composeRadar, goalProgress, normTitle,
  // readers
  read, refresh,
};
