'use strict';

/**
 * Next steps (3 Nov 2026) — everything pending, in one list, with the same
 * three choices on every row: Start, Snooze, Not today.
 *
 * Nick: SAiM stays the thing that comes to him; this is a second way into the
 * same work — "see what else is pending and let me choose". Its own page for
 * now (Option 2 of the mock-ups); it may fold into Now later.
 *
 * ⚠ IT OWNS NOTHING. Every row is read from the module that already owns the
 * thing — email triage, the weekly report tracker, the task ranking, the 1-2-1
 * cadence, the governed drafts — and "Start" sends Nick to that module's own
 * screen. Snooze / Not today are attention-lifecycle deferrals, and a task's
 * row uses the SAME key the Must Move lane and Now use, so putting a task off
 * here puts it off everywhere.
 *
 * ⚠ A source that could not be read is a NAMED gap, never an empty section:
 * "nothing pending" and "I couldn't look" are different answers.
 *
 * Groups: `now` (needs him now), `today`, `week`. Ordered within a group by the
 * owning module's own order — nothing is re-ranked here.
 *
 * CommonJS — NEURO backend convention.
 */

const lifecycle = require('./attention-lifecycle');

const GROUP_ORDER = { now: 0, today: 1, week: 2 };
const MAX_TASKS = 8;
const MAX_EMAILS = 8;

function _todayStr(now) {
  return new Date(now).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}

function _emails(gaps) {
  const out = [];
  try {
    const t = require('./email-triage').getTriageByCategory();
    const rows = [...(t.urgent || []).map((e) => ['now', e]), ...(t.reply || []).map((e) => ['today', e])]
      .filter(([, e]) => !e.dismissed)
      .slice(0, MAX_EMAILS);
    for (const [group, e] of rows) {
      out.push({
        id: `email:${e.id}`,
        kind: 'email',
        group,
        sphere: 'work',
        title: `Reply to ${e.from || e.fromEmail || 'this email'} — ${e.subject || '(no subject)'}`,
        why: e.reason ? `${group === 'now' ? 'Urgent' : 'Needs a reply'} · ${e.reason}` : (group === 'now' ? 'Urgent' : 'Needs a reply'),
        minutes: 10,
        start: { label: 'Open', view: 'inbox', context: { emailId: e.id } },
        card: { type: 'next_email', title: e.subject || e.id, dedupeKey: `next:email:${e.id}` },
      });
    }
  } catch (e) {
    gaps.push(`work email: ${e.message}`);
  }
  return out;
}

function _weeklyReport(gaps) {
  try {
    const [r] = require('./decision-engine').collectWeeklyReport();
    if (!r) return [];
    return [{
      id: `report:${r.meta.week}`,
      kind: 'report',
      group: r.meta.state === 'late' ? 'now' : 'today',
      sphere: 'work',
      title: r.meta.built ? 'Send the Monday report to Chris' : 'Write and send the Monday report to Chris',
      why: `${r.meta.state === 'late' ? 'Past the midday deadline. ' : 'Due by midday. '}${r.reason}`,
      minutes: r.meta.built ? 5 : 20,
      start: { label: 'Start', view: 'weekly-risk', context: null },
      card: { type: 'weekly_risk', title: r.title, dedupeKey: r.dedupeKey },
    }];
  } catch (e) {
    gaps.push(`weekly report: ${e.message}`);
    return [];
  }
}

function _drafts(gaps) {
  try {
    const ny = require('./prepared-actions').needsYou();
    if (!ny || !ny.known) { gaps.push('drafts waiting: could not check'); return []; }
    const n = (ny.needsApproval || 0) + (ny.needsReview || 0);
    if (!n) return [];
    return [{
      id: 'drafts:waiting',
      kind: 'drafts',
      group: 'today',
      sphere: 'work',
      title: `${n} drafted email${n === 1 ? '' : 's'} waiting on you`,
      why: ny.say || 'NEURO has prepared these; nothing is sent until you press.',
      minutes: Math.min(30, n * 3),
      start: { label: 'Open', view: 'actions', context: null },
      card: { type: 'next_drafts', title: 'Drafts waiting', dedupeKey: 'next:drafts' },
    }];
  } catch (e) {
    gaps.push(`drafts waiting: ${e.message}`);
    return [];
  }
}

function _tasks(gaps, now) {
  try {
    const today = _todayStr(now);
    const all = require('./focus-ranking').rankedTodos('all');
    const out = [];
    for (const t of all) {
      if (out.length >= MAX_TASKS) break;
      if (t.done || t.myPartDone) continue;
      const due = t.due_date ? String(t.due_date).slice(0, 10) : null;
      const overdue = due && due < today;
      const dueToday = due === today;
      const must = (t.moscowSet || t.moscow) === 'must';
      if (!overdue && !dueToday && !must) continue;
      const group = overdue && must ? 'now' : (overdue || dueToday) ? 'today' : 'week';
      const why = [
        overdue ? 'Overdue' : dueToday ? 'Due today' : 'Must',
        t.estimateMinutes ? `sized at ${t.estimateMinutes >= 60 ? `${Math.round(t.estimateMinutes / 6) / 10}h` : `${t.estimateMinutes} min`}` : null,
      ].filter(Boolean).join(' · ');
      out.push({
        id: t.task_id ? `task:${t.task_id}` : `task:text:${t.text}`,
        kind: 'task',
        group,
        sphere: t.domain === 'personal' ? 'life' : 'work',
        title: t.text,
        why,
        minutes: t.estimateMinutes || null,
        start: { label: 'Start', view: 'todos', context: t.task_id ? { taskId: t.task_id, fromFocus: true } : null },
        // The SAME key the Must Move lane and Now use for a task card.
        card: { type: 'todo', title: t.text },
      });
    }
    return out;
  } catch (e) {
    gaps.push(`tasks: ${e.message}`);
    return [];
  }
}

function _oneToOnes(gaps) {
  try {
    const roster = require('./team-roster');
    const detect = require('./one-to-one-detect');
    const out = [];
    for (const p of roster.directReports()) {
      const cadence = String(p.cadence || '').toLowerCase();
      if (!p.cadence || cadence === 'none' || cadence === 'n/a') continue;
      const folded = detect.effectiveCadenceFields(p.name, {
        'last-1-2-1': p.last121 || '', 'next-1-2-1-due': p.next121Due || '',
        '1-2-1-booked': p.booked121 || '', cadence: p.cadence || '',
      });
      const s = detect.cadenceState({ lastHeld: folded.lastHeld || null, nextDue: folded.nextDue || null, booked: folded.booked || null, bookable: true });
      if (s.state !== 'overdue' && s.state !== 'unwritten') continue;
      out.push({
        id: `121:${p.name}`,
        kind: 'people',
        group: s.state === 'overdue' && (s.daysOverdue || 0) > 7 ? 'today' : 'week',
        sphere: 'work',
        title: s.state === 'unwritten' ? `Write up ${p.name}'s 1-2-1` : `Book ${p.name}'s 1-2-1`,
        why: detect.cadenceLabel(s),
        minutes: s.state === 'unwritten' ? 10 : 2,
        start: { label: s.state === 'unwritten' ? 'Open' : 'Book', view: 'people', context: null },
        card: { type: 'next_121', title: p.name, dedupeKey: `next:121:${p.name}` },
      });
    }
    return out;
  } catch (e) {
    gaps.push(`1-2-1s: ${e.message}`);
    return [];
  }
}

/** Every item, before snoozes are applied. */
function _collect(now) {
  const gaps = [];
  const items = [
    ..._weeklyReport(gaps),
    ..._emails(gaps),
    ..._drafts(gaps),
    ..._tasks(gaps, now),
    ..._oneToOnes(gaps),
  ];
  return { items, gaps };
}

function _keyOf(item) {
  return lifecycle.dedupeKeyFor(item.card);
}

/** PURE: split into live and snoozed, and order by group (stable within). */
function arrange(items, deferred) {
  const live = [];
  const snoozed = [];
  for (const it of items) {
    const d = deferred.get(it._key);
    if (d) snoozed.push({ ...it, snoozedUntil: d.until, snoozeReason: d.reason });
    else live.push(it);
  }
  live.sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group]);
  return { live, snoozed };
}

function _public(it) {
  const { card, _key, ...rest } = it;
  return rest;
}

function read({ now = Date.now() } = {}) {
  const { items, gaps } = _collect(now);
  for (const it of items) it._key = _keyOf(it);
  let deferred = new Map();
  try { deferred = lifecycle.deferredKeys(new Date(now)); } catch (e) { gaps.push(`snoozes: ${e.message}`); }
  const { live, snoozed } = arrange(items, deferred);
  return {
    ok: true,
    contract: 'next-steps-v1',
    count: live.length,
    items: live.map(_public),
    snoozed: snoozed.map(_public),
    gaps,
    complete: gaps.length === 0,
  };
}

function _find(id, now) {
  const { items } = _collect(now);
  return items.find((x) => x.id === id) || null;
}

/** Snooze or "not today". The item is re-read from its owner, never trusted from the client. */
function defer(id, { minutes, reason = 'not-now', now = Date.now() } = {}) {
  if (reason && !lifecycle.DEFER_REASONS.has(reason)) {
    return { ok: false, status: 400, error: `Unknown reason — expected one of ${[...lifecycle.DEFER_REASONS].join(', ')}.` };
  }
  const mins = Number(minutes);
  if (!Number.isFinite(mins) || mins <= 0 || mins > 60 * 24 * 14) return { ok: false, status: 400, error: 'minutes must be between 1 and 20160' };
  const item = _find(id, now);
  if (!item) return { ok: false, status: 404, error: 'That item is no longer pending.' };
  const record = lifecycle.upsert({ ...item.card, reason: item.why, tab: item.start.view });
  if (!record) return { ok: false, status: 400, error: 'Could not open a record for that item.' };
  const r = lifecycle.act(record.id, 'defer', { minutes: mins, reason: reason || 'unspecified', now: new Date(now) });
  if (!r.ok) return { ok: false, status: 400, error: r.error };
  return { ok: true, id, until: new Date(now + mins * 60000).toISOString() };
}

function undefer(id, { now = Date.now() } = {}) {
  const item = _find(id, now);
  if (!item) return { ok: false, status: 404, error: 'That item is no longer pending.' };
  const row = require('../db/database').getOpenAttentionRecord(_keyOf(item));
  if (!row) return { ok: false, status: 404, error: 'Nothing is snoozed for that item.' };
  const r = lifecycle.act(row.id, 'undefer', {});
  if (!r.ok) return { ok: false, status: 400, error: r.error };
  return { ok: true, id };
}

/** Tomorrow 08:00 London, in minutes from now — what "Not today" means. */
function minutesUntilTomorrowMorning(now = Date.now()) {
  const d = new Date(now);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return Math.max(60, (24 - h) * 60 - m + 8 * 60);
}

module.exports = { read, defer, undefer, arrange, minutesUntilTomorrowMorning, GROUP_ORDER };
