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
    // One row per THREAD: the newest message stands for it, and the row says
    // how many in the thread are waiting. Urgent wins the group.
    const threads = new Map();
    for (const [group, e] of [...(t.urgent || []).map((e) => ['now', e]), ...(t.reply || []).map((e) => ['today', e])]) {
      if (e.dismissed) continue;
      const k = e.conversationId || e.id;
      const held = threads.get(k);
      if (!held) { threads.set(k, { group, e, n: 1 }); continue; }
      held.n++;
      if (group === 'now') held.group = 'now';
      if (String(e.received || '') > String(held.e.received || '')) held.e = e;
    }
    const rows = [...threads.values()].slice(0, MAX_EMAILS);
    for (const { group, e, n } of rows) {
      out.push({
        id: `email:${e.id}`,
        kind: 'email',
        group,
        sphere: 'work',
        title: `Reply to ${e.from || e.fromEmail || 'this email'} — ${e.subject || '(no subject)'}`,
        why: [group === 'now' ? 'Urgent' : 'Needs a reply', n > 1 ? `${n} messages in this thread` : null, e.reason || null].filter(Boolean).join(' · '),
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

/** PURE. One waiting governed draft, shaped for the row: what it is, who it
 * goes to, a short preview, and the exact version + payload hash a one-press
 * Send binds its grant to. The server re-checks every one of those on send. */
function draftRow(a) {
  const d = (a && a.draft) || {};
  const people = (list) => (Array.isArray(list) ? list : [])
    .map((x) => (x && (x.name || x.email)) || (typeof x === 'string' ? x : null)).filter(Boolean);
  const to = people(d.to).length ? people(d.to) : people(d.attendees);
  const text = String(d.body || d.bodyText || d.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    actionId: a.actionId,
    version: a.version || 1,
    payloadHash: a.payloadHash,
    actionType: a.actionType,
    status: a.status,
    subject: String(d.subject || d.title || a.actionType || 'Draft').slice(0, 140),
    to: to.slice(0, 3),
    toMore: Math.max(0, to.length - 3),
    when: d.start ? String(d.start).slice(0, 16).replace('T', ' ') : null,
    preview: text ? (text.length > 280 ? `${text.slice(0, 280)}…` : text) : null,
    from: a.sendsFrom && a.sendsFrom.address ? a.sendsFrom.address : null,
    // Send here only when NEURO can actually execute it now; an uncertain or
    // failed one needs the Actions screen, where its history is.
    canSend: a.status === 'prepared' && a.executes === true,
  };
}

function _drafts(gaps) {
  try {
    const pa = require('./prepared-actions');
    const ny = pa.needsYou();
    if (!ny || !ny.known) { gaps.push('drafts waiting: could not check'); return []; }
    const n = (ny.needsApproval || 0) + (ny.needsReview || 0);
    if (!n) return [];
    return [{
      id: 'drafts:waiting',
      kind: 'drafts',
      group: 'today',
      sphere: 'work',
      title: `${n} drafted email${n === 1 ? '' : 's'} waiting on your press`,
      why: ny.say || 'NEURO has prepared these; nothing is sent until you press.',
      minutes: Math.min(30, n * 3),
      // ONE line and a link (Nick, 7 Nov 2026): the drafts themselves live on
      // "Waiting on your press" only, so a draft never has two sets of buttons.
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
        // Start = a focus session on THIS task, in place (7 Nov 2026 audit: it
        // used to only navigate). `view` stays as the Open fallback.
        start: { label: 'Start', view: 'todos', context: t.task_id ? { taskId: t.task_id, fromFocus: true } : null, action: 'focus' },
        // What the row needs to start and tick it. Done is offered only for a
        // NEURO task (the one owner /api/tasks/:id/complete closes); the server
        // re-reads the task by id either way.
        task: { taskId: t.task_id || null, text: t.text, canComplete: Boolean(t.task_id) },
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
        // Book proposes a slot in place (POST /api/1to1/propose with this
        // person) and one press prepares + sends the invite — the governed path.
        start: s.state === 'unwritten'
          ? { label: 'Open', view: 'people', context: null }
          : { label: 'Book', view: 'people', context: null, action: 'book-121' },
        oneToOne: { person: p.name, state: s.state },
        card: { type: 'next_121', title: p.name, dedupeKey: `next:121:${p.name}` },
      });
    }
    return out;
  } catch (e) {
    gaps.push(`1-2-1s: ${e.message}`);
    return [];
  }
}

function _personalEmails(gaps) {
  try {
    const t = require('./personal-triage').byLane({ mailbox: 'all' });
    if (!t) return [];
    return [...(t.urgent || []).map((e) => ['now', e]), ...(t.reply || []).map((e) => ['today', e])].slice(0, MAX_EMAILS).map(([group, e]) => ({
      id: `pmail:${e.id}`,
      kind: 'email',
      group,
      sphere: 'life',
      title: `Reply to ${e.from || e.fromEmail || 'this email'} — ${e.subject || '(no subject)'}`,
      why: [group === 'now' ? 'Urgent' : 'Needs a reply', e.mailbox ? `in ${e.mailbox}` : null, e.reason || null].filter(Boolean).join(' · '),
      minutes: 10,
      start: { label: 'Open', view: 'personal-inbox', context: { emailId: e.id } },
      card: { type: 'next_pmail', title: e.subject || e.id, dedupeKey: `next:pmail:${e.id}` },
    }));
  } catch (e) {
    gaps.push(`personal email: ${e.message}`);
    return [];
  }
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/**
 * PURE. The first future date an email's subject or preview names, as
 * YYYY-MM-DD, or null. UK order only (8/11/2026, 8 Nov, Sunday 8th November).
 * A date with no year is the next one on or after today. Only within 90 days.
 */
function detectEventDate(text, today) {
  const s = String(text || '').toLowerCase();
  const found = [];
  for (const m of s.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b/g)) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    found.push([y, Number(m[2]), Number(m[1])]);
  }
  for (const m of s.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?\b/g)) {
    found.push([m[3] ? Number(m[3]) : null, MONTHS[m[2]], Number(m[1])]);
  }
  const [ty, tm, td] = today.split('-').map(Number);
  const limit = new Date(Date.UTC(ty, tm - 1, td + 90)).toISOString().slice(0, 10);
  for (const [y0, mo, d] of found) {
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) continue;
    for (const y of y0 ? [y0] : [ty, ty + 1]) {
      const dt = new Date(Date.UTC(y, mo - 1, d));
      if (dt.getUTCMonth() !== mo - 1) continue;
      const iso = dt.toISOString().slice(0, 10);
      if (iso >= today && iso <= limit) return iso;
    }
  }
  return null;
}

const NOT_AN_EVENT = /^\s*(invitation|updated invitation|accepted|declined|tentative|canceled|cancelled|automatic reply|auto[- ]?reply|out of office|re:|fw:|fwd:)\b|\bvote\b|\bsprint\b|\binvoice\b|\breceipt\b|\bstatement\b/i;
const TIME_RE = /\b([01]?\d|2[0-3])[:.][0-5]\d\b|\b\d{1,2}\s?(am|pm)\b|\b(start|starts|time)[:\s]+\d{3,4}\b/i;
const BOOKING_RE = /\b(appointment|booking|booked|reservation|course|reminder|confirmed|confirmation|tickets?)\b/i;

function _datedEmails(gaps, now) {
  const today = _todayStr(now);
  const out = [];
  let added = {};
  try { added = JSON.parse(require('../db/database').getState('email_calendar_added') || '{}') || {}; } catch { added = {}; }
  const consider = (source, e) => {
    if (out.length >= 5 || !e || e.dismissed || e.isInvite || e.category === 'IGNORE') return;
    if (added[`${source === 'work' ? 'outlook' : 'family'}:${e.id}`]) return;
    // Already a calendar thing, or not about an event Nick goes to.
    if (NOT_AN_EVENT.test(String(e.subject || ''))) return;
    const text = `${e.subject || ''} ${e.preview || ''}`;
    let date = detectEventDate(text, today);
    if (date && !TIME_RE.test(text)) date = null;
    // A personal email that reads like a booking: NEURO reads the date on Add.
    const booking = !date && source === 'personal' && BOOKING_RE.test(String(e.subject || ''));
    if (!date && !booking) return;
    out.push({
      id: `cal:${source}:${e.id}`,
      kind: 'calendar',
      group: date && date <= require('./life-loops').addDays(today, 7) ? 'today' : (booking ? 'today' : 'week'),
      sphere: source === 'work' ? 'work' : 'life',
      title: `Add “${e.subject || 'this'}” to ${source === 'work' ? 'Outlook' : 'the family calendar'}?`,
      why: date ? `The email from ${e.from || e.fromEmail || 'someone'} mentions ${date}.`
        : `Looks like a booking from ${e.from || e.fromEmail || 'someone'} — NEURO reads the date when you press Add.`,
      minutes: 2,
      start: { label: 'Add', view: source === 'work' ? 'inbox' : 'personal-inbox', context: { emailId: e.id }, action: 'add-to-calendar' },
      calendar: { source, emailId: e.id },
      card: { type: 'next_cal', title: e.subject || e.id, dedupeKey: `next:cal:${e.id}` },
    });
  };
  try {
    const t = require('./email-triage').getStoredTriage();
    for (const e of t.slice().sort((a, b) => String(b.received || '').localeCompare(String(a.received || '')))) consider('work', e);
  } catch (e) { gaps.push(`dated work email: ${e.message}`); }
  try {
    const t = require('./personal-triage').byLane({ mailbox: 'all' });
    if (t) for (const e of [...(t.urgent || []), ...(t.reply || []), ...(t.fyi || []), ...(t.unsorted || [])]) consider('personal', e);
  } catch (e) { gaps.push(`dated personal email: ${e.message}`); }
  return out;
}

function _lifeLoops(gaps, now) {
  const L = require('./life-loops');
  const out = [];
  try {
    for (const d of L.decisionsDue(now).slice(0, 5)) {
      out.push({
        id: `decision:${d.id}`, kind: 'decision', group: 'week', sphere: 'work',
        title: `How did “${d.text.length > 90 ? `${d.text.slice(0, 90)}…` : d.text}” go?`,
        why: `Decided ${d.madeOn || 'earlier'} · you chose to look back on ${d.lookBackOn}`,
        minutes: 2,
        start: { label: 'Look back', view: 'future-me', context: { decisionId: d.id } },
        card: { type: 'next_decision', title: d.text, dedupeKey: `next:decision:${d.id}` },
      });
    }
  } catch (e) { gaps.push(`decisions: ${e.message}`); }
  try {
    for (const p of L.listRhythm(now).filter((x) => x.due)) {
      out.push({
        id: `rhythm:${p.name}`, kind: 'family', group: p.daysOverdue >= Math.ceil(p.everyDays / 2) ? 'today' : 'week', sphere: 'life',
        title: `See or message ${p.name}`,
        why: [p.lastAt ? `last caught up ${p.lastAt}` : 'no catch-up recorded yet', `every ${p.everyDays} days`, p.askAbout ? `ask about: ${p.askAbout}` : null].filter(Boolean).join(' · '),
        minutes: 15,
        start: { label: 'Caught up', view: 'family', context: null, action: 'caught-up' },
        card: { type: 'next_rhythm', title: p.name, dedupeKey: `next:rhythm:${p.name}` },
      });
    }
  } catch (e) { gaps.push(`people rhythm: ${e.message}`); }
  try {
    for (const l of L.lettersArrived(now)) {
      out.push({
        id: `letter:${l.id}`, kind: 'letter', group: 'today', sphere: 'life',
        title: 'A letter from past you has arrived',
        why: `Written ${l.writtenOn}`,
        minutes: 2,
        start: { label: 'Read it', view: 'future-me', context: { letterId: l.id } },
        card: { type: 'next_letter', title: l.id, dedupeKey: `next:letter:${l.id}` },
      });
    }
  } catch (e) { gaps.push(`letters: ${e.message}`); }
  try {
    const g = L.garden({ now });
    if (!g.ok) gaps.push(`garden: ${g.why}`);
    for (const n of (g.picks || []).filter((x) => !x.done)) {
      out.push({
        id: `garden:${n.path}`, kind: 'garden', group: 'week', sphere: 'work',
        title: `Revisit “${n.title}”`,
        why: `From ${n.folder} · untouched for 90+ days — keep it, link it, or archive it`,
        minutes: 5,
        start: { label: 'Open', view: 'vault', context: { path: n.path }, secondary: 'done-for-now' },
        card: { type: 'next_garden', title: n.path, dedupeKey: `next:garden:${g.week}:${n.path}` },
      });
    }
  } catch (e) { gaps.push(`garden: ${e.message}`); }
  return out;
}

/** Every item, before snoozes are applied. */
function _collect(now) {
  const gaps = [];
  const items = [
    ..._weeklyReport(gaps),
    ..._emails(gaps),
    ..._personalEmails(gaps),
    ..._datedEmails(gaps, now),
    ..._drafts(gaps),
    ..._tasks(gaps, now),
    ..._oneToOnes(gaps),
    ..._lifeLoops(gaps, now),
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
    // The page opens on Work (6 Nov 2026); the sidebar badge counts that side.
    counts: {
      work: live.filter((x) => x.sphere !== 'life').length,
      life: live.filter((x) => x.sphere === 'life').length,
    },
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

/** An in-place action a row offers: caught-up (rhythm) or done-for-now (garden). */
function act(id, action, { now = Date.now() } = {}) {
  const item = _find(id, now);
  if (!item) return { ok: false, status: 404, error: 'That item is no longer pending.' };
  const L = require('./life-loops');
  if (action === 'caught-up' && item.kind === 'family') return L.caughtUp(id.slice('rhythm:'.length), { now });
  if (action === 'done-for-now' && item.kind === 'garden') return L.gardenDone(id.slice('garden:'.length));
  return { ok: false, status: 400, error: `“${action}” isn’t something this item does.` };
}

/** Tomorrow 08:00 London, in minutes from now — what "Not today" means. */
function minutesUntilTomorrowMorning(now = Date.now()) {
  const d = new Date(now);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return Math.max(60, (24 - h) * 60 - m + 8 * 60);
}

module.exports = { read, defer, undefer, act, detectEventDate, arrange, draftRow, minutesUntilTomorrowMorning, GROUP_ORDER };
