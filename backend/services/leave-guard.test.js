'use strict';

// Leave guard (21 Oct 2026). Graph and the NOVA leave feed are faked; the
// ledger, task store, flags and governed-action preparation are REAL.
// ⚠ Dates are derived from the clock — a literal fixture date becomes "the past".

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'leave-')), 'test.db');
delete process.env.LEAVE_AUTO_DECLINE;

const db = require('../db/database');
const guard = require('./leave-guard');
const availability = require('./team-availability');
const microsoft = require('./microsoft');
const cal = require('./action-calendar');
const flags = require('./feature-flags');
const detect = require('./one-to-one-detect');
const workingDays = require('./working-days');
const taskStore = require('./task-store');
const ext = require('./external-writes');

test.before(async () => { await db.init(); });

function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function plus(s, n) { const d = new Date(`${s}T12:00:00`); d.setDate(d.getDate() + n); return ymd(d); }

/** A Mon–Fri week at least two weeks out with every weekday a working day. */
function week() {
  let d = new Date(); d.setDate(d.getDate() + 14); d.setHours(12);
  for (;;) {
    while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
    const days = [0, 1, 2, 3, 4].map(i => { const x = new Date(d); x.setDate(x.getDate() + i); return x; });
    if (days.every(x => workingDays.isWorkingDay(x, []))) return days.map(ymd);
    d.setDate(d.getDate() + 7);
  }
}

const ev = (id, day, from, to, subject, extra = {}) => ({
  id, date: day, start: `${day}T${from}:00`, end: `${day}T${to}:00`, subject, showAs: 'busy', isAllDay: false,
  attendees: [], ...extra,
});

function stub(t, { leave, events = [] }) {
  t.mock.method(availability, 'snapshot', () => ({ known: true }));
  t.mock.method(availability, 'selfDaysOff', () => ({ known: true, dates: new Set(leave), coversTo: '2099-12-31' }));
  t.mock.method(availability, 'daysOffFor', () => ({ known: true, dates: new Set(), coversTo: '2099-12-31' }));
  t.mock.method(microsoft, 'fetchCalendarEvents', async (from, to) => events.filter(e => e.start.slice(0, 10) >= from && e.start.slice(0, 10) <= to));
  t.mock.method(microsoft, 'getSignedInAddress', async () => 'nick@x.test');
  t.mock.method(detect, 'buildRoster', () => ({ people: [{ name: 'Ann One', email: 'ann@x.test' }] }));
  t.mock.method(require('./webpush'), 'sendToAll', async () => {});
  t.mock.method(cal, 'invitesForEvent', async () => []);
}

// ── pure ─────────────────────────────────────────────────────────────────────

test('leave runs bridge a weekend but break on a working day', () => {
  const w = week();
  const next = plus(w[0], 7);
  const isWorking = (d) => ![0, 6].includes(new Date(`${d}T12:00:00`).getDay());
  const runs = guard.leavePeriods([w[3], w[4], next, w[1]], isWorking);
  assert.deepStrictEqual(runs.map(r => [r.from, r.to]), [[w[1], w[1]], [w[3], next]]);
});

test('classifyEvent: who organises decides — decline theirs, move/skip yours, solo left alone', () => {
  const re = /1-2-1/;
  const base = { attendees: [{ email: 'nick@x.test' }, { email: 'b@x.test' }] };
  assert.strictEqual(guard.classifyEvent({ ...base, isOrganizer: false }, { selfEmail: 'nick@x.test', oneToOne: re }).kind, 'decline');
  assert.strictEqual(guard.classifyEvent({ ...base, isOrganizer: true, type: 'occurrence', subject: 'Standup' }, { selfEmail: 'nick@x.test', oneToOne: re }).kind, 'cancel');
  assert.strictEqual(guard.classifyEvent({ ...base, isOrganizer: true, subject: '1-2-1 — Nick / B' }, { selfEmail: 'nick@x.test', oneToOne: re }).kind, 'move-121');
  assert.strictEqual(guard.classifyEvent({ attendees: [{ email: 'nick@x.test' }], isOrganizer: true }, { selfEmail: 'nick@x.test', oneToOne: re }).kind, 'solo');
  assert.strictEqual(guard.classifyEvent({ ...base, isOrganizer: false, responseStatus: 'declined' }, { selfEmail: 'x', oneToOne: re }), null);
  assert.strictEqual(guard.classifyEvent({ isAllDay: true, showAs: 'free', isOrganizer: false }, { selfEmail: 'x', oneToOne: re }), null, 'a birthday');
  assert.strictEqual(guard.classifyEvent({ ...base, isOrganizer: null }, { selfEmail: 'x', oneToOne: re }).kind, 'info', 'unknown is never acted on');
});

test('capacity: a task goes to the first day whose free time, less what is already due, holds it', () => {
  const [a, b] = week();
  const events = [ev('busy', a, '09:00', '17:00', 'All day workshop')]; // 30 min free on a
  const pick = guard.pickTaskDay(60, [a, b], { events, dueLoad: new Map() });
  assert.deepStrictEqual([pick.date, pick.fits], [b, true]);
  const full = guard.pickTaskDay(60, [a], { events, dueLoad: new Map() });
  assert.deepStrictEqual([full.date, full.fits], [a, false], 'nowhere fits → nearest, flagged');
  const loaded = guard.pickTaskDay(60, [b], { events: [], dueLoad: new Map([[b, 480]]) });
  assert.strictEqual(loaded.fits, false, 'a day already full of due work has no room');
});

test('auto-decline candidates: only someone else\'s UNANSWERED invite, on leave, still to come', () => {
  const [a, b] = week();
  const leave = new Set([a]);
  const evs = [
    ev('take', a, '10:00', '11:00', 'Theirs', { isOrganizer: false, responseStatus: 'notResponded' }),
    ev('accepted', a, '12:00', '13:00', 'Accepted', { isOrganizer: false, responseStatus: 'accepted' }),
    ev('mine', a, '14:00', '15:00', 'Mine', { isOrganizer: true, responseStatus: 'organizer' }),
    ev('otherday', b, '10:00', '11:00', 'Not leave', { isOrganizer: false, responseStatus: 'notResponded' }),
    ev('graph-x', a, '15:00', '16:00', 'Fallback id', { isOrganizer: false, responseStatus: 'notResponded' }),
  ];
  assert.deepStrictEqual(guard.autoDeclineCandidates(evs, leave, '2000-01-01T00:00:00').map(e => e.id), ['take']);
  assert.deepStrictEqual(guard.autoDeclineCandidates(evs, leave, `${a}T23:00:00`), [], 'past is never declined');
});

// ── auto-decline (real ledger) ───────────────────────────────────────────────

test('auto-decline does NOTHING while the switch is off', async (t) => {
  const [a] = week();
  stub(t, { leave: [a], events: [ev('E1', a, '10:00', '11:00', 'X', { isOrganizer: false, responseStatus: 'notResponded' })] });
  const sent = t.mock.method(cal, 'declineEvent', async () => ({ outcome: 'accepted', status: 202 }));
  const r = await guard.autoDecline();
  assert.strictEqual(r.skipped, 'switched off');
  assert.strictEqual(sent.mock.callCount(), 0);
});

test('auto-decline (switch on): declines once, reads it back, never repeats it', async (t) => {
  const [a] = week();
  stub(t, { leave: [a], events: [ev('E2', a, '10:00', '11:00', 'Quarterly review', { isOrganizer: false, responseStatus: 'notResponded', organizer: 'Chris' })] });
  t.mock.method(flags, 'isEnabled', (k) => k === guard.AUTO_FLAG);
  const sent = t.mock.method(cal, 'declineEvent', async () => ({ outcome: 'accepted', status: 202 }));
  t.mock.method(cal, 'responseOf', async () => 'gone');
  const r1 = await guard.autoDecline();
  assert.strictEqual(r1.declined.length, 1);
  const row = ext.byKey(`leave-decline:E2@${a}T10:00`);
  assert.strictEqual(row.status, 'confirmed');
  assert.strictEqual(row.initiatedBy, 'timer');
  const r2 = await guard.autoDecline();
  assert.strictEqual(r2.declined.length, 0, 'the ledger stops a second decline');
  assert.strictEqual(sent.mock.callCount(), 1);
});

test('a leave decline marks its invite email read and closes its triage card (30 Oct 2026)', async (t) => {
  const [a] = week();
  stub(t, { leave: [a], events: [ev('E9', a, '09:00', '10:00', 'Onboarding chat', { isOrganizer: false, responseStatus: 'notResponded' })] });
  t.mock.method(flags, 'isEnabled', (k) => k === guard.AUTO_FLAG);
  t.mock.method(cal, 'declineEvent', async () => ({ outcome: 'accepted', status: 202 }));
  t.mock.method(cal, 'responseOf', async () => 'declined');
  const found = t.mock.method(cal, 'invitesForEvent', async (id) => (id === 'E9' ? [{ id: 'MSG9', isRead: false }] : []));
  const read = t.mock.method(cal, 'markMessageRead', async () => ({ outcome: 'accepted', status: 200 }));
  const triage = require('./email-triage');
  triage._internals.storeTriage([{ id: 'MSG9', subject: 'Onboarding chat', isInvite: true, isRead: false, category: 'FYI', lane: 'fyi', received: new Date().toISOString() }]);

  const askedE9 = () => found.mock.calls.filter(c => c.arguments[0] === 'E9').length;
  await guard.autoDecline();
  assert.strictEqual(askedE9(), 1);
  assert.deepStrictEqual(read.mock.calls.map(c => c.arguments[0]), ['MSG9']);
  const card = triage.getStoredTriage().find(e => e.id === 'MSG9');
  assert.strictEqual(card.dismissed, true);
  assert.strictEqual(card.dismissReason, triage.INVITE_ANSWERED);

  // The catch-up does not ask Outlook again about a decline already tidied —
  // but does re-ask one whose email was never found (E2 from the test above).
  await guard.autoDecline();
  assert.strictEqual(askedE9(), 1);
  assert.ok(found.mock.calls.some(c => c.arguments[0] === 'E2'), 'no email found yet → asked again');
});

test('auto-decline refuses when Nick\'s own leave cannot be read', async (t) => {
  t.mock.method(flags, 'isEnabled', () => true);
  t.mock.method(availability, 'snapshot', () => ({ known: false }));
  t.mock.method(availability, 'selfDaysOff', () => ({ known: false, reason: 'roster empty', dates: new Set() }));
  const r = await guard.autoDecline();
  assert.strictEqual(r.ok, false);
  assert.match(r.skipped, /roster empty/);
});

// ── clash analysis + apply ───────────────────────────────────────────────────

test('analyse: commitment moves BEFORE the leave, own work AFTER, each to a day with room', async (t) => {
  const w = week(); // leave Wed+Thu
  const leave = [w[2], w[3]];
  stub(t, { leave, events: [ev('wall', w[1], '09:00', '17:30', 'Offsite all day')] }); // Tue full
  const c = taskStore.createTask({ text: 'Send Chris the risk register', source: 'test', due_date: w[2], origin: 'commitment', estimate_minutes: 60 });
  const own = taskStore.createTask({ text: 'Tidy the KB backlog spreadsheet', source: 'test', due_date: w[3], origin: 'improvement' });
  const a = await guard.refresh();
  const ci = a.items.find(i => i.taskId === c.id);
  const oi = a.items.find(i => i.taskId === own.id);
  assert.strictEqual(ci.proposed.date, w[0], 'Tuesday is full, so Monday — still before the leave');
  assert.strictEqual(ci.fits, true);
  assert.ok(oi.proposed.date > w[3], 'own work goes after');
  assert.strictEqual(a.periods[0].back, w[4]);

  const r = await guard.apply({ ids: [ci.id] });
  assert.strictEqual(r.results[0].ok, true);
  assert.strictEqual(db.getTaskRow(c.id).due_date.slice(0, 10), w[0]);
  assert.ok(!guard.stored().items.some(i => i.id === ci.id), 'applied items leave the card');
});

test('analyse: meetings — theirs declined, my 1-2-1 re-placed after, my standup skipped, my solo block left', async (t) => {
  const w = week();
  const leave = [w[1]];
  const nick = { email: 'nick@x.test' };
  stub(t, {
    leave,
    events: [
      ev('THEIRS', w[1], '10:00', '11:00', 'Product sync', { isOrganizer: false, responseStatus: 'accepted', attendees: [nick, { email: 'p@x.test' }] }),
      ev('ONE', w[1], '14:00', '14:30', '1-2-1 — Nick / Ann', { isOrganizer: true, attendees: [nick, { email: 'ann@x.test' }] }),
      ev('STAND', w[1], '09:30', '09:45', 'Team Standup', { isOrganizer: true, type: 'occurrence', attendees: [nick, { email: 'q@x.test' }] }),
      ev('SOLO', w[1], '16:00', '16:30', 'Focus', { isOrganizer: true, attendees: [nick] }),
    ],
  });
  const a = await guard.refresh();
  const by = Object.fromEntries(a.items.map(i => [i.eventId, i]));
  assert.strictEqual(by.THEIRS.action, 'decline');
  assert.strictEqual(by.ONE.action, 'move');
  assert.strictEqual(by.ONE.person, 'Ann One');
  assert.ok(by.ONE.proposed.start.slice(0, 10) > w[1], '1-2-1 lands after the leave');
  assert.strictEqual(by.STAND.action, 'cancel');
  assert.strictEqual(by.SOLO.action, 'info');

  // Declining from the card goes through the same ledgered writer, as Nick.
  t.mock.method(cal, 'declineEvent', async () => ({ outcome: 'accepted', status: 202 }));
  t.mock.method(cal, 'responseOf', async () => 'declined');
  const r = await guard.apply({ ids: [by.THEIRS.id] });
  assert.strictEqual(r.results[0].ok, true);
  assert.strictEqual(ext.byKey(`leave-decline:THEIRS@${w[1]}T10:00`).initiatedBy, 'nick');
});

test('analyse: unreadable leave is a named gap, never an empty all-clear', async (t) => {
  t.mock.method(availability, 'snapshot', () => ({ known: false }));
  t.mock.method(availability, 'selfDaysOff', () => ({ known: false, reason: 'never fetched', dates: new Set() }));
  const a = await guard.analyse();
  assert.strictEqual(a.leaveKnown, false);
  assert.match(a.gaps[0], /never fetched/);
});
