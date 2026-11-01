'use strict';

/**
 * 1-2-1 auto-booking (1 Nov 2026): NOVA asks, NEURO BOOKS — under the
 * one_to_one_auto_book switch, and only when everything is certain.
 *
 * Real scratch DB, real one-to-one-requests → real one-to-one-booking (propose,
 * findSlot, book) → real prepared-actions (prepare, approve) → the real executor
 * (preflight, claim, ledger, read-back) → real afterGovernedCalendar, and the real
 * /api/1to1 + /api/prepared-actions routes over HTTP for Undo. Faked, one layer
 * below: the Graph TRANSPORT (action-calendar / calendar-read, and microsoft's
 * calendar read), People HR leave (team-availability), NOVA (nova-121-sync), the
 * People note writer (obsidian) and push (webpush — recorded).
 *
 *   run: node --test backend/services/one-to-one-auto-book.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-121-auto-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'auto.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
fs.mkdirSync(path.join(tmp, 'vault', 'People'), { recursive: true });
process.env.GOVERNED_CALENDAR_ENABLED = 'true';
for (const k of ['ONE_TO_ONE_AUTO_BOOK', 'GOVERNED_EXECUTION_ENABLED']) delete process.env[k];

function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}

// ── the fake calendar (transport only) ─────────────────────────────────────────
const CAL = { events: new Map(), calls: { create: 0, cancel: 0 } };
const minute = (s) => String(s || '').slice(0, 16);
const calApi = {
  createEvent: async (draft, { marker }) => {
    CAL.calls.create += 1;
    const id = `EV-${CAL.events.size + 1}`;
    const ev = { id, subject: draft.subject, start: minute(draft.start), end: minute(draft.end),
      attendees: draft.to.map((r) => r.email.toLowerCase()).sort(), location: draft.location || null,
      isOnline: !!draft.isOnline, isCancelled: false, isOrganizer: true, marker };
    CAL.events.set(id, ev);
    return { outcome: 'accepted', status: 201, event: ev };
  },
  findByMarker: async (marker) => ({ ok: true, events: [...CAL.events.values()].filter((e) => e.marker === marker) }),
  readEvent: async (id) => (CAL.events.has(id) ? { ok: true, exists: true, event: CAL.events.get(id) } : { ok: true, exists: false, event: null }),
  eventsAt: async (start) => (CAL.unreadable ? { ok: false } : { ok: true, events: [...CAL.events.values()].filter((e) => e.start === minute(start)) }),
  moveEvent: async () => ({ outcome: 'rejected', status: 400 }),
  cancelEvent: async (id) => { CAL.calls.cancel += 1; const e = CAL.events.get(id); if (e) e.isCancelled = true; return { outcome: e ? 'accepted' : 'rejected', status: e ? 202 : 404 }; },
};
stub('./action-calendar', calApi);
stub('./calendar-read', { readEvent: calApi.readEvent, eventsAt: calApi.eventsAt, findByMarker: calApi.findByMarker, normaliseEvent: (e) => e, TIMEZONE: 'Europe/London', MARKER_PROP: 'x' });
// What booking.propose / findOneToOne / findClash read: the same events, Graph-shaped.
stub('./microsoft', {
  fetchCalendarEvents: async (from, to) => [...CAL.events.values()]
    .filter((e) => !e.isCancelled && e.start.slice(0, 10) >= from && e.start.slice(0, 10) <= to)
    .map((e) => ({ id: e.id, subject: e.subject, start: `${e.start}:00`, end: `${e.end}:00`, date: e.start.slice(0, 10),
      showAs: 'busy', isAllDay: false, isOrganizer: true, attendees: e.attendees.map((a) => ({ email: a })) })),
});

// ── the people, their leave, NOVA, the vault stamp, push ──────────────────────
const PERSON = 'Luke Scaife';
const EMAIL = 'luke.scaife@nurtur.tech';
stub('./one-to-one-detect', {
  getIndex: () => ({ people: [{ name: PERSON, bookable: true }], byPerson: {} }),
  buildRoster: () => ({ people: [{ name: PERSON, email: EMAIL }] }),
});
const LEAVE = { person: true, self: true };
stub('./team-availability', {
  snapshot: () => ({ known: true }),
  daysOffFor: () => (LEAVE.person ? { known: true, dates: new Set(), coversTo: '2099-12-31' } : { known: false, reason: 'People HR not read', dates: new Set() }),
  selfDaysOff: () => (LEAVE.self ? { known: true, dates: new Set(), coversTo: '2099-12-31' } : { known: false, reason: 'People HR not read', dates: new Set() }),
});
const NOVA = [];
stub('./nova-121-sync', { pushBooking: async (...a) => { NOVA.push(a); return { ok: true }; }, pushCancel: async () => ({ ok: true }) });
const STAMPS = [];
stub('./obsidian', new Proxy({ updatePersonNote: (n, f) => STAMPS.push([n, f]) }, { get: (t, k) => (k in t ? t[k] : () => null) }));
const PUSHES = [];
stub('./webpush', { sendToAll: async (title, body, data) => { PUSHES.push({ title, body, data }); }, isConfigured: () => true });

const db = require('../db/database');
const flags = require('./feature-flags');
const pa = require('./prepared-actions');
const req = require('./one-to-one-requests');
const matrix = require('./authority-matrix');

const tick = () => new Promise((r) => setTimeout(r, 20));
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
// NOVA's due date. Each test asks for a different week (2..) so one test's booking
// never sits on the next test's slot; all inside findOneToOne's 21-day look-ahead
// is not needed — the Undo test uses the first week.
let week = 0;
let ASKED = ymd(new Date(Date.now() + 2 * 86400000));

let server; let base;
test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use((r, _res, next) => { if (r.headers['x-test-api-client']) r.apiClient = 'n8n'; next(); });
  app.use('/api/1to1', require('../routes/one-to-one'));
  app.use('/api/prepared-actions', require('../routes/prepared-actions'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

async function call(method, p, body, headers = {}) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
}
function reset({ near = false } = {}) {
  week += 1;
  ASKED = ymd(new Date(Date.now() + (near ? 2 : 2 + week * 7) * 86400000));
  CAL.events.clear(); CAL.calls.create = 0; CAL.calls.cancel = 0; CAL.unreadable = false;
  PUSHES.length = 0; NOVA.length = 0; STAMPS.length = 0;
  LEAVE.person = true; LEAVE.self = true;
  db.run("UPDATE prepared_actions SET status = 'superseded' WHERE status IN ('prepared','approved')");
  db.setState('one_to_one_auto_undone', '{}');
  db.setState('one_to_one_requests', '{}');
  flags.setEnabled('one_to_one_auto_book', true);
}
const autoRows = () => db.all("SELECT * FROM prepared_actions WHERE origin = '1to1-auto'");

// ── pure ─────────────────────────────────────────────────────────────────────

test('autoBlockedBy: every uncertainty is a reason; only the certain case is null', () => {
  const ok = { ok: true, start: '2099-11-03T14:00:00', end: '2099-11-03T14:30:00', awayCheck: 'checked', attendee: { email: EMAIL } };
  const on = { flagOn: true, calendarOn: true, undone: false };
  assert.equal(req.autoBlockedBy(ok, on), null, 'positive control');
  assert.equal(req.autoBlockedBy(ok, { ...on, flagOn: false }), 'switch-off');
  assert.equal(req.autoBlockedBy(ok, { ...on, calendarOn: false }), 'calendar-switch-off');
  assert.equal(req.autoBlockedBy(ok, { ...on, undone: true }), 'undone-recently');
  assert.equal(req.autoBlockedBy(ok, { ...on, undone: null }), 'undo-record-unreadable');
  assert.equal(req.autoBlockedBy({ ...ok, awayCheck: 'unknown' }, on), 'leave-unknown');
  assert.equal(req.autoBlockedBy({ ...ok, awayCheck: undefined }, on), 'leave-unknown');
  assert.equal(req.autoBlockedBy({ ...ok, attendee: { email: null } }, on), 'no-address');
  assert.equal(req.whenWords('2026-11-03T14:00:00'), 'Tue 3 Nov 14:00');
});

test('the switch is registered, defaults ON, and needs the calendar switch', () => {
  const row = flags.list().find((f) => f.key === 'one_to_one_auto_book');
  assert.ok(row);
  assert.equal(row.default, true);
  assert.equal(row.requires, 'governed_calendar');
  assert.ok(row.impact);
});

// ── the certain case ─────────────────────────────────────────────────────────

test('certain → BOOKED through the governed executor, read back, NOVA told, ONE push with Undo', async () => {
  reset();
  const r = await req.handleRequest({ agentName: PERSON, date: ASKED, sessionId: 501 });
  await tick();
  assert.equal(r.action, 'auto-booked', JSON.stringify(r));
  assert.equal(r.status, 'verified');
  assert.equal(CAL.calls.create, 1);
  const ev = [...CAL.events.values()][0];
  assert.deepEqual(ev.attendees, [EMAIL]);
  assert.ok(ev.start >= ASKED, 'never before the date NOVA asked for');
  assert.ok(['14:00', '14:30', '15:00', '15:30', '16:00', '10:00', '10:30', '11:00', '11:30'].includes(ev.start.slice(11)), 'on :00/:30 inside a window');

  const a = pa.get(r.actionId);
  assert.equal(a.origin, '1to1-auto');
  const row = db.get('SELECT initiated_by, authority_proof, approval_mechanism, approved_by FROM prepared_actions WHERE action_id = ?', [r.actionId]);
  assert.equal(row.initiated_by, 'neuro_autonomous', 'it never claims Nick pressed it');
  assert.equal(row.authority_proof, 'standing_switch');
  assert.equal(row.approval_mechanism, 'standing-switch');
  assert.match(row.approved_by, /one_to_one_auto_book/);
  const ch = db.get('SELECT issued_to, used_outcome FROM approval_challenges WHERE action_id = ?', [r.actionId]);
  assert.equal(ch.issued_to, 'switch:one_to_one_auto_book');

  // afterGovernedCalendar: the stamp and NOVA's date + the created event id.
  assert.deepEqual(STAMPS.at(-1), [PERSON, { booked121: ev.start.slice(0, 10) }]);
  assert.deepEqual(NOVA.at(-1), [PERSON, ev.start.slice(0, 10), { outlookEventId: ev.id }]);

  assert.equal(PUSHES.length, 1);
  assert.equal(PUSHES[0].title, `Booked your 1-2-1 with ${PERSON} — ${req.whenWords(ev.start)}`);
  assert.equal(PUSHES[0].data.type, '121');
  assert.deepEqual(PUSHES[0].data.undo, { actionId: r.actionId, person: PERSON });
});

test('the sweep asking twice books ONE event and pushes once', async () => {
  // Continues from the booking above: the event is in the diary.
  const again = await req.handleRequest({ agentName: PERSON, date: ASKED, sessionId: 501 });
  await tick();
  assert.equal(again.action, 'already-in-diary');
  assert.equal(CAL.calls.create, 1, 'no second event');
  assert.equal(PUSHES.length, 1, 'no second push');
});

test('even with the diary unreadable to findOneToOne, a live auto-booking is not booked twice', async () => {
  reset();
  const r1 = await req.handleRequest({ agentName: PERSON, date: ASKED, sessionId: 502 });
  assert.equal(r1.action, 'auto-booked');
  // Pretend the booking is executed but not yet visible: pendingBookingFor must catch 1to1-auto.
  const live = pa.listLive().concat([pa.get(r1.actionId)]);
  assert.ok(req.pendingBookingFor(live, PERSON), '1to1-auto counts as a booking already made');
});

test('a check that cannot be made leaves it APPROVED for the reconciler — said as pending, never as failed, never doubled', async () => {
  reset();
  CAL.unreadable = true;
  const r = await req.handleRequest({ agentName: PERSON, date: ASKED, sessionId: 503 });
  await tick();
  assert.equal(r.action, 'auto-approved-waiting', JSON.stringify(r));
  assert.equal(pa.get(r.actionId).status, 'approved');
  assert.equal(CAL.calls.create, 0);
  assert.match(PUSHES[0].title, /^Booking your 1-2-1/);
  const again = await req.handleRequest({ agentName: PERSON, date: ASKED, sessionId: 503 });
  await tick();
  assert.equal(again.action, 'already-prepared', 'the approved booking is the answer; nothing new');
  assert.equal(PUSHES.length, 1);
  CAL.unreadable = false;
});

// ── fallbacks ────────────────────────────────────────────────────────────────

test('leave unknown (theirs OR Nick\'s) → the tap card, unchanged; nothing sent', async () => {
  for (const which of ['person', 'self']) {
    reset();
    LEAVE[which] = false;
    const r = await req.handleRequest({ agentName: PERSON, date: ASKED, sessionId: `l-${which}` });
    await tick();
    assert.equal(r.action, 'prepared', which);
    assert.equal(r.autoBlockedBy, 'leave-unknown');
    assert.equal(pa.get(r.actionId).origin, '1to1-book');
    assert.equal(pa.get(r.actionId).status, 'prepared');
    assert.equal(CAL.calls.create, 0, 'nothing reached the calendar');
    assert.match(PUSHES[0].title, /^1-2-1 to book/);
  }
});

test('switch OFF → exactly today\'s behaviour: prepare + one push', async () => {
  reset();
  flags.setEnabled('one_to_one_auto_book', false);
  const autoBefore = autoRows().length;
  const r = await req.handleRequest({ agentName: PERSON, date: ASKED, sessionId: 600 });
  await tick();
  assert.equal(r.action, 'prepared');
  assert.equal(r.autoBlockedBy, 'switch-off');
  assert.equal(CAL.calls.create, 0);
  assert.equal(autoRows().length, autoBefore, 'no 1to1-auto action at all');
  assert.equal(PUSHES.length, 1);
  flags.setEnabled('one_to_one_auto_book', true);
});

test('calendar switch OFF → the auto switch reads off too → tap card', async () => {
  reset();
  process.env.GOVERNED_CALENDAR_ENABLED = 'false';
  try {
    assert.equal(flags.isEnabled('one_to_one_auto_book'), false);
    const r = await req.handleRequest({ agentName: PERSON, date: ASKED, sessionId: 601 });
    assert.equal(r.action, 'prepared');
    assert.equal(CAL.calls.create, 0);
  } finally { process.env.GOVERNED_CALENDAR_ENABLED = 'true'; }
});

// ── the switch is the ONLY non-human approval, for ONE origin ────────────────

test('a standing switch cannot approve a tap-card (1to1-book) action, nor approve while off', async () => {
  reset();
  flags.setEnabled('one_to_one_auto_book', false);
  const r = await req.handleRequest({ agentName: PERSON, date: ASKED, sessionId: 700 });
  const a = pa.get(r.actionId);
  flags.setEnabled('one_to_one_auto_book', true);
  const wrongOrigin = pa.approve(a.actionId, { payloadHash: a.payloadHash, standingSwitch: 'one_to_one_auto_book', approver: 'x' });
  assert.equal(wrongOrigin.ok, false);
  assert.equal(wrongOrigin.code, 403);
  assert.equal(pa.get(a.actionId).status, 'prepared');
  const wrongSwitch = pa.approve(a.actionId, { payloadHash: a.payloadHash, standingSwitch: 'leave_auto_decline', approver: 'x' });
  assert.equal(wrongSwitch.ok, false);

  // A 1to1-auto action with the switch turned off a moment ago: refused.
  const b = pa.prepareCalendarCreate({ title: '1-2-1 — Nick / Luke', start: `${ASKED}T10:00`, end: `${ASKED}T10:30`,
    attendees: [{ email: EMAIL, name: PERSON }], origin: '1to1-auto', context: { person: PERSON } }).action;
  flags.setEnabled('one_to_one_auto_book', false);
  const off = pa.approve(b.actionId, { payloadHash: b.payloadHash, standingSwitch: 'one_to_one_auto_book', approver: 'x' });
  assert.equal(off.ok, false);
  assert.equal(pa.get(b.actionId).status, 'prepared');
  flags.setEnabled('one_to_one_auto_book', true);
  const on = pa.approve(b.actionId, { payloadHash: b.payloadHash, standingSwitch: 'one_to_one_auto_book', approver: 'x' });
  assert.equal(on.ok, true, 'positive control');
});

test('the matrix: auto-book is A4 and machine-refused; Undo (cancel) is machine-refused', () => {
  assert.equal(matrix.CAPABILITIES['calendar.1to1-auto-book'].machine, 'refuse');
  assert.equal(matrix.CAPABILITIES['calendar.1to1-auto-book'].authority, 'A4');
  assert.equal(matrix.machineDecision('POST', '/api/1to1/cancel').allow, false);
});

// ── Undo ─────────────────────────────────────────────────────────────────────

test('Undo = the governed cancel, on Nick\'s press; then the next request is a tap card, not a re-book', async () => {
  reset({ near: true });
  const r = await req.handleRequest({ agentName: PERSON, date: ASKED, sessionId: 800 });
  await tick();
  assert.equal(r.action, 'auto-booked');

  const list = await call('GET', '/api/1to1/auto-booked');
  assert.equal(list.status, 200);
  const item = list.json.items.find((x) => x.actionId === r.actionId);
  assert.ok(item, 'the People board sees it');
  assert.equal(item.undone, false);
  assert.ok(item.eventId);

  // A machine cannot undo it.
  const machine = await call('POST', '/api/1to1/cancel', { person: PERSON, eventId: item.eventId }, { 'x-test-api-client': '1' });
  assert.equal(machine.status, 403);

  const prep = await call('POST', '/api/1to1/cancel', { person: PERSON, eventId: item.eventId, reason: 'undo' });
  assert.equal(prep.status, 200, JSON.stringify(prep.json));
  assert.equal(prep.json.action.origin, '1to1-cancel');
  const a = prep.json.action;
  const g = await call('POST', `/api/prepared-actions/${a.actionId}/intent-grant`, { version: a.version, payloadHash: a.payloadHash, surface: 'neuro-web', sessionId: 'sess0123456789' });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  const x = await call('POST', `/api/prepared-actions/${a.actionId}/execute-direct`, { grantId: g.json.grantId, payloadHash: a.payloadHash });
  assert.equal(x.json.executed, true, JSON.stringify(x.json));
  assert.equal(CAL.calls.cancel, 1);
  assert.equal(CAL.events.get(item.eventId).isCancelled, true);
  assert.deepEqual(STAMPS.at(-1), [PERSON, { booked121: '' }]);

  const after = await call('GET', '/api/1to1/auto-booked');
  assert.equal(after.json.items.find((y) => y.actionId === r.actionId).undone, true);

  // NOVA asks again: the undo is remembered — the tap card, never a quiet re-book.
  const again = await req.handleRequest({ agentName: PERSON, date: ASKED, sessionId: 800 });
  assert.equal(again.action, 'prepared', JSON.stringify(again));
  assert.equal(pa.get(again.actionId).origin, '1to1-book', 'a tap card');
  assert.ok(again.start.slice(0, 10) > item.start.slice(0, 10), 'never the day he just undid');
  assert.equal(again.autoBlockedBy, 'undone-recently');
  assert.equal(CAL.calls.create, 1, 'no second invite');
});
