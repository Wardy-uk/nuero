'use strict';

/**
 * Calendar care (1 Nov 2026): protect a full week, agendas for meetings Nick
 * organises, and leaving a series he never attends. Real scratch DB, the real
 * prepared-actions / executor / ledger, a FAKE calendar transport (never Graph).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-calcare-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'cc.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
for (const k of ['GOVERNED_EXECUTION_ENABLED', 'GOVERNED_CALENDAR_ENABLED']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'vault', 'Meetings'), { recursive: true });

function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
stub('./webpush', { sendToAll: async () => { throw new Error('no push from calendar care'); }, isConfigured: () => true });

// ── one fake calendar transport ─────────────────────────────────────────────
const CAL = { events: new Map(), calls: { body: 0, move: 0, cancel: 0, decline: 0 } };
const view = (e) => ({ ...e, attendees: [...e.attendees] });
const calApi = {
  readEvent: async (id) => (CAL.events.has(id) ? { ok: true, exists: true, event: view(CAL.events.get(id)) } : { ok: true, exists: false, event: null }),
  readEventBody: async (id) => (CAL.events.has(id) ? { ok: true, exists: true, event: view(CAL.events.get(id)), html: CAL.events.get(id).html } : { ok: true, exists: false, event: null, html: null }),
  updateEventBody: async (id, { html }) => {
    CAL.calls.body += 1;
    const e = CAL.events.get(id);
    if (!e) return { outcome: 'rejected', status: 404 };
    e.html = html; // ONLY the body
    return { outcome: 'accepted', status: 200 };
  },
  moveEvent: async () => { CAL.calls.move += 1; return { outcome: 'rejected', status: 400 }; },
  cancelEvent: async (id) => { CAL.calls.cancel += 1; const e = CAL.events.get(id); if (e) e.isCancelled = true; return { outcome: e ? 'accepted' : 'rejected', status: e ? 202 : 404 }; },
  declineEvent: async (id) => { CAL.calls.decline += 1; const e = CAL.events.get(id); if (!e) return { outcome: 'rejected', status: 404 }; e.response = 'declined'; return { outcome: 'accepted', status: 202 }; },
  responseOf: async (id) => (CAL.events.has(id) ? CAL.events.get(id).response || 'none' : 'gone'),
  findByMarker: async () => ({ ok: true, events: [] }),
  eventsAt: async () => ({ ok: true, events: [] }),
};
stub('./action-calendar', calApi);
stub('./calendar-read', { readEvent: calApi.readEvent, readEventBody: calApi.readEventBody, eventsAt: calApi.eventsAt, findByMarker: calApi.findByMarker, normaliseEvent: (e) => e, TIMEZONE: 'Europe/London', MARKER_PROP: 'x' });

const db = require('../db/database');
const M = require('./calendar-care-model');
const care = require('./calendar-care');
const pa = require('./prepared-actions');
const ex = require('./action-executor');
const proofs = require('./approval-proof');
const registry = require('./action-registry');
const finish = require('./meeting-finish');

const CODE = 'calendar-care approval code';
// Sunday 1 Nov 2026, 17:00 GMT.
const NOW = Date.parse('2026-11-01T17:00:00Z');
const MIN = 60000;

let server; let base;
test.before(async () => {
  await db.init();
  if (!proofs.codeStatus().set) assert.equal(proofs.setCode(CODE).ok, true);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { if (req.headers['x-test-api-client']) req.apiClient = true; next(); });
  app.use('/api/calendar-care', require('../routes/calendar-care'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); });

function post(p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: t ? JSON.parse(t) : null }));
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

// ── fixtures ────────────────────────────────────────────────────────────────

const row = (id, subject, start, end, o = {}) => ({ event_id: id, subject, start_time: `${start}:00`, end_time: `${end}:00`, is_all_day: 0,
  show_as: o.showAs || 'busy', attendees_other: o.ao === undefined ? 1 : o.ao, is_organizer: o.org === undefined ? 0 : o.org, source: 'graph' });

// The current Teams invite body, in the HTML Graph returns (structure copied
// from a real Outlook invite; ids and links replaced).
const TEAMS_NEW = `<html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
</head>
<body>
<div><br></div>
<div style="width:100%"><span style="white-space:nowrap;color:#5F5F5F;opacity:.36">________________________________________________________________________________</span></div>
<div class="me-email-text" lang="en-GB" style="color:#252424;font-family:'Segoe UI','Helvetica Neue',Helvetica,Arial,sans-serif">
<div style="margin-top:24px;margin-bottom:20px"><span style="font-size:24px;color:#252424">Microsoft Teams</span> <a href="https://aka.ms/JoinTeamsMeeting?omkt=en-GB" class="me-email-link">Need help?</a></div>
<div style="margin-bottom:20px"><a href="https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZDk1%40thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d" class="me-email-headline">Join the meeting now</a></div>
<div style="margin-bottom:20px;margin-top:20px"><div style="margin-bottom:4px"><span class="me-email-text-secondary">Meeting ID: </span><span class="me-email-text">354 671 829 017 4</span></div><div style="font-size:14px;margin-bottom:20px"><span class="me-email-text-secondary">Passcode: </span><span class="me-email-text">gB2Sw9hJ</span></div><div style="width:100%"><span style="white-space:nowrap;color:#5F5F5F;opacity:.36">________________________________</span></div></div>
<div style="font-size:14px;margin-bottom:4px">For organizers: <a href="https://teams.microsoft.com/meetingOptions/?organizerId=x" class="me-email-link">Meeting options</a></div>
<div style="font-size:14px;margin-bottom:20px"></div></div>
<div style="font-size:12px"></div>
<div style="width:100%"><span style="white-space:nowrap;color:#5F5F5F;opacity:.36">________________________________________________________________________________</span></div>
<div></div>
</body></html>`;

// The older Teams block (2021–23), as Outlook renders it in a text body.
const TEAMS_OLD = `
________________________________________________________________________________
Microsoft Teams meeting
Join on your computer, mobile app or room device
Click here to join the meeting<https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0>
Meeting ID: 378 921 112 334
Passcode: ufZ7mR
Download Teams<https://www.microsoft.com/en-us/microsoft-teams/download-app> | Join on the web<https://www.microsoft.com/microsoft-teams/join-a-meeting>
Or call in (audio only)
+44 20 3443 8435,,123456789#<tel:+442034438435,,123456789#>   United Kingdom, London
Phone Conference ID: 123 456 789#
Find a local number<https://dialin.teams.microsoft.com/x> | Reset PIN<https://mysettings.lync.com/pstnconferencing>
Learn More<https://aka.ms/JoinTeamsMeeting> | Meeting options<https://teams.microsoft.com/meetingOptions/?x>
________________________________________________________________________________
`;

// ═══ 1. protect time ═══════════════════════════════════════════════════════

test('1. week load: real meetings over 09:00–17:30, leave and bank holidays excluded, NEURO blocks never counted, overlaps once', () => {
  const week = M.weekDays('2026-11-02');
  assert.deepEqual(week, ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
  const events = [
    row('A', 'Board', '2026-11-04T09:00', '2026-11-04T12:00'),
    row('B', 'Overlapping', '2026-11-04T11:00', '2026-11-04T13:00'),             // union: 09:00–13:00 = 240
    row('C', 'Early bird', '2026-11-05T08:00', '2026-11-05T10:00'),              // clipped to 09:00–10:00 = 60
    row('D', 'Team Standup', '2026-11-05T10:00', '2026-11-05T10:30', { showAs: 'free', org: 1 }), // free but his, with others = 30
    row('E', 'Following: LSL', '2026-11-05T12:00', '2026-11-05T13:00', { showAs: 'free' }),       // free, not his: not a meeting
    row('F', 'Plaud admin — Board', '2026-11-05T13:00', '2026-11-05T13:05', { ao: 1, org: 1 }),   // NEURO's block by name
    row('G', 'Solo work', '2026-11-05T14:00', '2026-11-05T16:00', { ao: 0, org: 1 }),            // no attendees
    row('H', 'Task block', '2026-11-06T09:00', '2026-11-06T12:00', { ao: 1, org: 1 }),            // a task block by id
    row('I', 'On leave day', '2026-11-03T09:00', '2026-11-03T17:00'),
  ];
  const load = M.weekLoad({ events: events.map(M.rowToEvent), week, leave: new Set(['2026-11-03']), holidays: new Set(['2026-11-02']), neuroIds: new Set(['H']) });
  assert.deepEqual(load.days.map((d) => [d.date, d.working, d.meetingMinutes]), [
    ['2026-11-02', false, 0], ['2026-11-03', false, 0], ['2026-11-04', true, 240], ['2026-11-05', true, 90], ['2026-11-06', true, 0]]);
  assert.equal(load.available, 3 * 510);
  assert.equal(load.meetingMinutes, 330);
  assert.equal(Math.round(load.share * 1000), Math.round((330 / 1530) * 1000));
  // A week with no working days left divides by nothing: null, never 0.
  assert.equal(M.weekLoad({ events: [], week, leave: new Set(week) }).share, null);
});

test('2. protect slot: a whole free afternoon first (fewest own blocks, earliest), else the longest ≥2h stretch, else none', () => {
  const ev = (rows) => rows.map(M.rowToEvent);
  const days = ['2026-11-04', '2026-11-05'];
  let s = M.chooseProtectSlot({ events: ev([row('a', 'M', '2026-11-04T14:00', '2026-11-04T15:00'), row('b', 'Solo', '2026-11-05T14:00', '2026-11-05T15:00', { ao: 0 })]), days });
  assert.deepEqual([s.date, s.start, s.end, s.kind], ['2026-11-05', '2026-11-05T13:30', '2026-11-05T17:00', 'afternoon']);
  s = M.chooseProtectSlot({ events: ev([row('a', 'M', '2026-11-04T14:00', '2026-11-04T15:00'), row('b', 'M2', '2026-11-05T13:00', '2026-11-05T14:00'), row('c', 'M3', '2026-11-05T16:30', '2026-11-05T17:30')]), days });
  assert.deepEqual([s.date, s.start, s.end, s.kind], ['2026-11-04', '2026-11-04T09:00', '2026-11-04T14:00', 'stretch']);
  const packed = [];
  for (const d of days) for (let h = 9; h < 17; h += 2) packed.push(row(`${d}${h}`, 'M', `${d}T${String(h).padStart(2, '0')}:30`, `${d}T${String(h + 1).padStart(2, '0')}:45`));
  assert.equal(M.chooseProtectSlot({ events: ev(packed), days }), null);
});

function seedCalendar(rows) {
  db.run("DELETE FROM calendar_cache WHERE source = 'graph'");
  for (const r of rows) {
    db.run(`INSERT INTO calendar_cache (event_id, subject, start_time, end_time, is_all_day, show_as, attendees_other, is_organizer, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'graph')`, [r.event_id, r.subject, r.start_time, r.end_time, r.is_all_day, r.show_as, r.attendees_other, r.is_organizer]);
  }
}
const busyWeek = () => {
  const rows = [];
  for (const d of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']) rows.push(row(`full-${d}`, 'All day workshop', `${d}T09:00`, `${d}T17:30`));
  rows.push(row('fri-am', 'Friday morning', '2026-11-06T09:00', '2026-11-06T12:00'));
  return rows; // (4*510 + 180) / 2550 = 87%
};
const weekDeps = (over = {}) => ({ leave: () => ({ known: true, dates: new Set() }), holidays: () => new Set(), neuroIds: () => new Set(), ...over });

test('3. over 60% → ONE proposal; Protect creates an attendee-free block once; a second press is "already"; Not this week is remembered', async () => {
  db.setState(care.STATE_KEY, '{}');
  seedCalendar(busyWeek());
  const v = care.weekView({ now: NOW, deps: weekDeps() });
  assert.equal(v.ok, true);
  assert.ok(v.load.share > 0.6, String(v.load.share));
  assert.equal(v.offer.kind, 'afternoon');
  assert.equal(v.offer.date, '2026-11-06');
  assert.match(v.offer.say, /Your week is 87% meetings — protect Friday afternoon\?/);
  const made = [];
  const createEvent = async (x) => { made.push(x); return { created: true, event: { id: 'PROT-1' } }; };
  const r = await care.protect({ weekKey: v.week.key, now: NOW, deps: weekDeps({ createEvent }) });
  assert.equal(r.ok, true, r.error);
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].attendees, [], 'nobody is invited');
  assert.equal(made[0].subject, 'Protected — no meetings');
  assert.equal(made[0].start, '2026-11-06T13:30:00');
  const again = await care.protect({ weekKey: v.week.key, now: NOW, deps: weekDeps({ createEvent }) });
  assert.equal(again.already, true);
  assert.equal(made.length, 1, 'one per week');
  assert.equal(care.weekView({ now: NOW, deps: weekDeps() }).offer, null);
  // Not this week.
  db.setState(care.STATE_KEY, '{}');
  assert.equal(care.dismissWeek({ weekKey: v.week.key, now: NOW }).ok, true);
  const after = care.weekView({ now: NOW, deps: weekDeps() });
  assert.equal(after.offer, null);
  assert.match(after.reason, /not this week/);
});

test('4. no offer under the threshold, with a protected block already there, or when leave takes the busy days out', () => {
  db.setState(care.STATE_KEY, '{}');
  seedCalendar([row('one', 'One meeting', '2026-11-04T10:00', '2026-11-04T11:00')]);
  const low = care.weekView({ now: NOW, deps: weekDeps() });
  assert.equal(low.offer, null);
  assert.match(low.reason, /under 60%/);
  seedCalendar([...busyWeek(), row('p', 'Protected — no meetings', '2026-11-06T13:30', '2026-11-06T17:00', { ao: 0, org: 1 })]);
  assert.match(care.weekView({ now: NOW, deps: weekDeps() }).reason, /protected block is already/);
  // The busy days were leave: the remaining day is light.
  seedCalendar(busyWeek());
  const leave = care.weekView({ now: NOW, deps: weekDeps({ leave: () => ({ known: true, dates: new Set(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']) }) }) });
  assert.equal(leave.offer, null, 'leave days are not working time');
  assert.equal(Math.round(leave.load.share * 100), 35);
  // Unreadable leave is SAID.
  const unk = care.weekView({ now: NOW, deps: weekDeps({ leave: () => ({ known: false, reason: 'roster empty', dates: new Set() }) }) });
  assert.match(unk.gaps[0], /leave could not be read/);
});

// ═══ 2. agendas ═════════════════════════════════════════════════════════════

test('5. agenda detection: Teams join blocks (new and old), an empty body and the subject repeated are NO agenda; real words are', () => {
  assert.equal(M.hasAgenda(TEAMS_NEW, { subject: 'Support leadership' }), false, 'new Teams block');
  assert.equal(M.hasAgenda(TEAMS_OLD, { subject: 'Support leadership' }), false, 'old Teams block');
  assert.equal(M.hasAgenda('', {}), false);
  assert.equal(M.hasAgenda('<html><body><p>Hi all</p></body></html>' + TEAMS_NEW, {}), false);
  assert.equal(M.hasAgenda('<p>Support leadership</p>' + TEAMS_NEW, { subject: 'Support leadership' }), false);
  assert.equal(M.hasAgenda('Zoom meeting\nJoin Zoom Meeting\nhttps://zoom.us/j/123\nMeeting ID: 123 456 789\nPasscode: 1', {}), false);
  const withAgenda = TEAMS_NEW.replace('<div><br></div>', '<div>Agenda:</div><ul><li>Q4 roadmap</li><li>Hiring plan</li></ul>');
  assert.equal(M.hasAgenda(withAgenda, { subject: 'Support leadership' }), true);
  assert.equal(M.hasAgenda(`Decide Q4 pricing for MyAudience\n${TEAMS_OLD}`, {}), true);
  // Joining words inside a real sentence are NOT boilerplate.
  assert.equal(M.hasAgenda('Join us to agree the escalation plan', {}), true);
  // A Teams block in another language: no line rule knows its words, the fence does.
  const FR = ['_'.repeat(80), 'Microsoft Teams Besoin d’aide ?', 'Rejoindre la réunion maintenant', 'ID de réunion : 354 671 829',
    'Code secret : gB2Sw9', '_'.repeat(80)].join('\n');
  assert.equal(M.hasAgenda(FR, {}), false, 'a fenced join block is dropped whole');
});

test('6. the drafted agenda: from the write-up when it has open items, else a template whose [gaps] block adding', () => {
  const w = M.agendaDraft({ subject: 'Support leadership', evidence: { previous: { start: '2026-10-30T16:00', notePath: 'Meetings/2026/10/x.md' },
    commitments: [{ text: 'Share the Q4 SLA figures' }], owedFromPrevious: [{ person: 'Chris', text: 'confirm the budget' }] } });
  assert.equal(w.source, 'write-up');
  assert.equal(w.text, 'Agenda\n1. Actions from last time (30/10)\n   • Share the Q4 SLA figures\n2. Still open from others\n   • Chris: confirm the budget\n3. Anything new');
  assert.deepEqual(M.gapsIn(w.text), []);
  const t = M.agendaDraft({ subject: 'X', evidence: { previous: null, commitments: [], owedFromPrevious: [] } });
  assert.equal(t.source, 'template');
  assert.equal(M.gapsIn(t.text).length, 3);
  // A write-up with nothing open is still a template.
  assert.equal(M.agendaDraft({ subject: 'X', evidence: { previous: { start: '2026-10-30T16:00' }, commitments: [], owedFromPrevious: [] } }).source, 'template');
});

test('7. merge: the agenda goes inside <body>, at the top, and the Teams block is kept', () => {
  const out = M.mergeAgendaIntoBody(TEAMS_NEW, 'Agenda\n1. Q4 <roadmap>\n   • detail');
  assert.ok(out.indexOf('Agenda') > out.indexOf('<body>'));
  assert.ok(out.indexOf('Agenda') < out.indexOf('Microsoft Teams'));
  assert.ok(out.includes('Join the meeting now'), 'the join block survives');
  assert.ok(out.includes('Q4 &lt;roadmap&gt;'), 'escaped');
  assert.equal(M.bodyHoldsAgenda(out, 'Agenda\n1. Q4 <roadmap>\n   • detail'), true);
  assert.equal(M.bodyHoldsAgenda(TEAMS_NEW, 'Agenda\n1. Q4'), false);
});

const ATT = ['chris.middleton@nurtur.tech', 'ricky.bostock@nurtur.tech'];
function seedMeeting(id, subject, start, end, html, o = {}) {
  CAL.events.set(id, { id, subject, start, end, attendees: [...ATT].sort(), isCancelled: false, isOrganizer: o.org !== false, organizer: 'nickw@nurtur.tech', html });
}

test('8. agenda pass: only his meetings with others in the next 24h, not stand-ups or 1-2-1s; one proposal per occurrence; a meeting WITH an agenda is left', async () => {
  db.setState(care.STATE_KEY, '{}');
  CAL.events.clear();
  // Monday 2 Nov 10:00 GMT.
  const now = Date.parse('2026-11-02T10:00:00Z');
  seedCalendar([
    row('SL', 'Support leadership', '2026-11-02T16:00', '2026-11-02T17:00', { org: 1 }),
    row('HAS', 'Pricing', '2026-11-02T15:00', '2026-11-02T15:30', { org: 1 }),
    row('SU', 'Team Standup', '2026-11-03T10:00', '2026-11-03T10:25', { org: 1, showAs: 'free' }),
    row('121', '1-2-1 — Nick / Hope', '2026-11-02T14:00', '2026-11-02T14:30', { org: 1 }),
    row('THEIRS', 'Their meeting', '2026-11-02T13:00', '2026-11-02T14:00', { org: 0 }),
    row('SOLO', 'Solo', '2026-11-02T12:00', '2026-11-02T13:00', { org: 1, ao: 0 }),
    row('LATER', 'Too far', '2026-11-04T16:00', '2026-11-04T17:00', { org: 1 }),
  ]);
  seedMeeting('SL', 'Support leadership', '2026-11-02T16:00', '2026-11-02T17:00', TEAMS_NEW);
  seedMeeting('HAS', 'Pricing', '2026-11-02T15:00', '2026-11-02T15:30', `Decide the Q4 pricing for MyAudience${TEAMS_OLD}`);
  const reads = [];
  const deps = {
    readBody: async (id) => { reads.push(id); return calApi.readEventBody(id); },
    gather: () => ({ previous: { start: '2026-10-30T16:00' }, commitments: [{ text: 'Share the Q4 SLA figures' }], owedFromPrevious: [] }),
    datesSeen: () => [],
  };
  const r = await care.agendaPass({ now, deps });
  assert.deepEqual([r.candidates, r.proposed, r.hasAgenda], [2, 1, 1]);
  assert.deepEqual(reads.sort(), ['HAS', 'SL']);
  const offers = care.agendaOffers({ now }).offers;
  assert.equal(offers.length, 1);
  assert.equal(offers[0].eventId, 'SL');
  assert.match(offers[0].text, /Share the Q4 SLA figures/);
  assert.equal(care.agendaOfferFor('SL', '2026-11-02T16:00:00', { now }).key, offers[0].key, 'the prep sheet finds it');
  // A second pass reads nothing again.
  reads.length = 0;
  await care.agendaPass({ now, deps });
  assert.deepEqual(reads, []);
});

const calDeps = { calendar: calApi, calendarEnabled: () => true, recordCalendar: () => {} };
function approve(a, at) {
  const ch = proofs.issue({ actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, now: at });
  assert.equal(ch.ok, true, ch.error);
  return pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, challengeId: ch.challengeId, approvalCode: CODE, now: at, sending: () => true });
}

test('9. Add agenda: [gaps] refused; PREPARES a governed body update; executed, ONLY the body changes, read back with the agenda', async () => {
  const now = Date.parse('2026-11-02T10:00:00Z');
  const key = care.agendaOffers({ now }).offers[0].key;
  const gap = await care.prepareAgenda({ key, text: 'Agenda\n1. [first topic]', now });
  assert.equal(gap.ok, false);
  assert.match(gap.error, /\[first topic\]/);
  const before = { ...CAL.events.get('SL') };
  const r = await care.prepareAgenda({ key, now });
  assert.equal(r.ok, true, r.error);
  const a = r.action;
  assert.equal(a.actionType, 'update_calendar_event_body');
  assert.equal(a.status, 'prepared');
  assert.equal(a.origin, 'meeting-agenda');
  assert.equal(CAL.calls.body, 0, 'nothing changes until it is confirmed');
  assert.equal(approve(a, now + MIN).ok, true);
  const out = await ex.execute(a.actionId, { now: now + 2 * MIN, deps: calDeps });
  assert.equal(out.status, 'verified', JSON.stringify(out));
  const after = CAL.events.get('SL');
  assert.equal(CAL.calls.body, 1);
  assert.equal(CAL.calls.move, 0);
  assert.deepEqual([after.start, after.end, after.subject, after.attendees.join()], [before.start, before.end, before.subject, before.attendees.join()]);
  assert.ok(after.html.includes('Share the Q4 SLA figures'));
  assert.ok(after.html.includes('Join the meeting now'), 'the Teams block is kept');
  assert.equal(care.agendaDone({ key, now }).ok, true);
  assert.equal(care.agendaOffers({ now }).offers.length, 0, 'one per occurrence');
  // The hash binds the body it was added to.
  assert.ok(registry.bindFor('update_calendar_event_body', a.target, a.draft).fromBodyHash);
});

test('9b. Microsoft says yes but the body does not hold the agenda: NOT verified', async () => {
  db.setState(care.STATE_KEY, '{}');
  const now = Date.parse('2026-11-02T10:00:00Z');
  seedMeeting('SL3', 'Budget review', '2026-11-02T16:40', '2026-11-02T17:00', TEAMS_NEW);
  seedCalendar([row('SL3', 'Budget review', '2026-11-02T16:40', '2026-11-02T17:00', { org: 1 })]);
  await care.agendaPass({ now, deps: { readBody: calApi.readEventBody, gather: () => ({ previous: null, commitments: [], owedFromPrevious: [] }), datesSeen: () => [] } });
  const key = care.agendaOffers({ now }).offers.find((o) => o.eventId === 'SL3').key;
  const r = await care.prepareAgenda({ key, text: 'Agenda\n1. Budget lines', now });
  assert.equal(r.ok, true, r.error);
  assert.equal(approve(r.action, now + MIN).ok, true);
  const real = calApi.updateEventBody;
  calApi.updateEventBody = async () => ({ outcome: 'accepted', status: 200 }); // accepted, changed nothing
  try {
    const out = await ex.execute(r.action.actionId, { now: now + 2 * MIN, deps: calDeps });
    assert.notEqual(out.status, 'verified');
    assert.notEqual(pa.get(r.action.actionId).status, 'verified');
  } finally { calApi.updateEventBody = real; }
});

test('10. a body edited after the agenda was prepared is refused — cancelled, nothing written', async () => {
  db.setState(care.STATE_KEY, '{}');
  const now = Date.parse('2026-11-02T10:00:00Z');
  seedMeeting('SL2', 'Ops review', '2026-11-02T16:30', '2026-11-02T17:00', TEAMS_NEW);
  seedCalendar([row('SL2', 'Ops review', '2026-11-02T16:30', '2026-11-02T17:00', { org: 1 })]);
  await care.agendaPass({ now, deps: { readBody: calApi.readEventBody, gather: () => ({ previous: null, commitments: [], owedFromPrevious: [] }), datesSeen: () => [] } });
  const key = care.agendaOffers({ now }).offers.find((o) => o.eventId === 'SL2').key;
  const r = await care.prepareAgenda({ key, text: 'Agenda\n1. Ops numbers', now });
  assert.equal(r.ok, true, r.error);
  CAL.events.get('SL2').html = `Someone wrote a purpose here.${TEAMS_NEW}`;
  assert.equal(approve(r.action, now + MIN).ok, true);
  const calls = CAL.calls.body;
  const out = await ex.execute(r.action.actionId, { now: now + 2 * MIN, deps: calDeps });
  assert.equal(out.code, 'event-body-changed');
  assert.equal(CAL.calls.body, calls, 'nothing written');
  assert.equal(pa.get(r.action.actionId).status, 'cancelled');
});

// ═══ 3. meetings he never attends ═══════════════════════════════════════════

const occ = (n, o = {}) => ({ id: `O${n}`, start: `2026-10-${10 + n}T10:00`, end: `2026-10-${10 + n}T11:00`, responseStatus: o.rs || 'accepted', onLeave: !!o.leave, evidence: null });

test('11. evidence: declined, "I\'m not in it", or written up elsewhere — never a missing write-up alone', () => {
  const declined = new Set([M.occKey('O2', '2026-10-12T10:00')]);
  const skipped = new Set([M.occKey('O3', '2026-10-13T10:00')]);
  assert.equal(M.occurrenceEvidence(occ(1, { rs: 'declined' }), {}).kind, 'declined');
  assert.equal(M.occurrenceEvidence(occ(2), { declined }).kind, 'declined');
  assert.equal(M.occurrenceEvidence(occ(3), { skipped }).kind, 'not-attending');
  assert.equal(M.occurrenceEvidence(occ(4), {}), null, 'no write-up and nothing else: not evidence');
  const other = { id: 'X', subject: 'Escalation call', start: '2026-10-15T10:00', end: '2026-10-15T11:00' };
  assert.equal(M.occurrenceEvidence(occ(5), { others: [other], writeUps: [{ start: '2026-10-15T10:02' }] }), null,
    'a write-up that could belong to either meeting proves nothing');
  const shifted = { ...other, start: '2026-10-15T09:30', end: '2026-10-15T11:00' };
  assert.equal(M.occurrenceEvidence(occ(5), { others: [shifted], writeUps: [{ start: '2026-10-15T09:31' }] }).kind, 'elsewhere');
  assert.equal(M.occurrenceEvidence(occ(5), { others: [shifted], writeUps: [] }), null, 'an overlap alone is not evidence he went to the other one');
});

test('12. verdict: three of three with evidence; one decline is not three; leave days are neutral', () => {
  const ev = (o, e) => ({ ...o, evidence: e ? { kind: e } : null });
  assert.equal(M.seriesVerdict([ev(occ(3), 'declined'), ev(occ(2), 'declined'), ev(occ(1), 'not-attending')]).flagged, true);
  assert.equal(M.seriesVerdict([ev(occ(3), 'declined'), ev(occ(2)), ev(occ(1))]).flagged, false, 'one decline is not three');
  assert.equal(M.seriesVerdict([ev(occ(3), 'declined'), ev(occ(2), 'declined')]).flagged, false, 'two occurrences cannot be three');
  const v = M.seriesVerdict([ev(occ(4), 'declined'), { ...occ(3), onLeave: true }, ev(occ(2), 'declined'), ev(occ(1), 'declined')]);
  assert.equal(v.flagged, true, 'a leave day is skipped, not counted against');
  assert.deepEqual(v.last.map((o) => o.id), ['O4', 'O2', 'O1']);
});

function seedWm(rows) {
  db.run('DELETE FROM wm_meetings');
  for (const r of rows) {
    db.run(`INSERT INTO wm_meetings (meeting_id, provider, provider_event_id, series_id, title, start_local, end_local, is_all_day, status, response_status,
              is_organizer, kind, provenance_kind, observed_at, received_at, evidence_json, updated_at)
            VALUES (?, 'graph', ?, ?, ?, ?, ?, 0, ?, ?, ?, 'meeting', 'observed', 'x', 'x', '{}', 'x')`,
    [`graph:${r.id}`, r.id, r.series || null, r.title, r.start, r.end, r.status || 'scheduled', r.rs || 'accepted', r.org ? 1 : 0]);
  }
}
const seriesDeps = (over = {}) => ({ leave: () => ({ known: true, dates: new Set() }), leaveDeclineDates: () => new Set(), writeUpsOn: () => [], declinedKeys: () => new Set(), skipLog: () => [], ...over });

test('13. series: declined twice + "I\'m not in it" → offered (decline); one decline alone → not; an ended series → not', async () => {
  db.setState(care.STATE_KEY, '{}');
  seedWm([
    { id: 'W1', series: 'MASTER-W', title: 'Weekly vendor sync', start: '2026-10-13T10:00', end: '2026-10-13T11:00', rs: 'declined' },
    { id: 'W2', series: 'MASTER-W', title: 'Weekly vendor sync', start: '2026-10-20T10:00', end: '2026-10-20T11:00', rs: 'declined' },
    { id: 'W3', series: 'MASTER-W', title: 'Weekly vendor sync', start: '2026-10-27T10:00', end: '2026-10-27T11:00', rs: 'accepted' },
    { id: 'W4', series: 'MASTER-W', title: 'Weekly vendor sync', start: '2026-11-03T10:00', end: '2026-11-03T11:00', rs: 'accepted' },
    { id: 'K1', series: 'MASTER-K', title: 'KPI Meet', start: '2026-10-13T09:00', end: '2026-10-13T09:30', rs: 'declined' },
    { id: 'K2', series: 'MASTER-K', title: 'KPI Meet', start: '2026-10-20T09:00', end: '2026-10-20T09:30' },
    { id: 'K3', series: 'MASTER-K', title: 'KPI Meet', start: '2026-10-27T09:00', end: '2026-10-27T09:30' },
    { id: 'K4', series: 'MASTER-K', title: 'KPI Meet', start: '2026-11-03T09:00', end: '2026-11-03T09:30' },
    { id: 'E1', series: 'MASTER-E', title: 'Old series', start: '2026-10-13T12:00', end: '2026-10-13T13:00', rs: 'declined' },
    { id: 'E2', series: 'MASTER-E', title: 'Old series', start: '2026-10-20T12:00', end: '2026-10-20T13:00', rs: 'declined' },
    { id: 'E3', series: 'MASTER-E', title: 'Old series', start: '2026-10-27T12:00', end: '2026-10-27T13:00', rs: 'declined' },
  ]);
  const skipLog = () => [{ eventId: 'W3', start: '2026-10-27T10:00' }];
  const none = care.seriesView({ now: NOW, deps: seriesDeps() });
  assert.deepEqual(none.offers, [], 'without the skip, W has two of three');
  const v = care.seriesView({ now: NOW, deps: seriesDeps({ skipLog }) });
  assert.equal(v.offers.length, 1);
  const o = v.offers[0];
  assert.equal(o.title, 'Weekly vendor sync');
  assert.equal(o.can, 'decline');
  assert.equal(o.seriesId, 'MASTER-W');
  assert.match(o.say, /You’ve missed the last 3 “Weekly vendor sync”\. Leave the series\?/);
  assert.deepEqual(o.last.map((x) => x.evidence.kind), ['not-attending', 'declined', 'declined']);

  // Decline future occurrences — ledgered, read back, once.
  CAL.events.set('MASTER-W', { id: 'MASTER-W', subject: 'Weekly vendor sync', start: '2026-10-06T10:00', end: '2026-10-06T11:00', attendees: ['vendor@x.com'], isOrganizer: false, html: '' });
  const r = await care.declineSeries({ key: o.key, now: NOW, deps: seriesDeps({ skipLog, calendar: calApi }) });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.verified, true);
  assert.equal(CAL.calls.decline, 1);
  const led = db.get("SELECT * FROM external_write_ledger WHERE writer = 'microsoft.calendar.series-decline'");
  assert.equal(led.status, 'confirmed');
  assert.equal(care.seriesView({ now: NOW, deps: seriesDeps({ skipLog }) }).offers.length, 0, 'decided: not offered again');
});

test('14. his own series → a governed cancel of the master (whole series), one press; Keep and Remind me in a month are remembered', async () => {
  db.setState(care.STATE_KEY, '{}');
  seedWm([
    { id: 'N1', series: 'MASTER-N', title: 'Naomi Check In', start: '2026-10-13T10:30', end: '2026-10-13T11:00', rs: 'organizer', org: true },
    { id: 'N2', series: 'MASTER-N', title: 'Naomi Check In', start: '2026-10-20T10:30', end: '2026-10-20T11:00', rs: 'organizer', org: true },
    { id: 'N3', series: 'MASTER-N', title: 'Naomi Check In', start: '2026-10-27T10:30', end: '2026-10-27T11:00', rs: 'organizer', org: true },
    { id: 'N4', series: 'MASTER-N', title: 'Naomi Check In', start: '2026-11-03T10:30', end: '2026-11-03T11:00', rs: 'organizer', org: true },
    { id: 'N5', series: 'MASTER-N', title: 'Naomi Check In', start: '2026-12-15T10:30', end: '2026-12-15T11:00', rs: 'organizer', org: true },
  ]);
  const skipLog = () => [...['N1', 'N2', 'N3'].map((id, i) => ({ eventId: id, start: `2026-10-${13 + 7 * i}T10:30` })), { eventId: 'N4', start: '2026-11-03T10:30' }];
  const o = care.seriesView({ now: NOW, deps: seriesDeps({ skipLog }) }).offers[0];
  assert.equal(o.can, 'cancel');
  assert.match(o.say, /Cancel the series\?/);
  CAL.events.set('MASTER-N', { id: 'MASTER-N', subject: 'Naomi Check In', start: '2026-10-06T10:30', end: '2026-10-06T11:00', attendees: ['naomi@nurtur.tech'], isOrganizer: true, isCancelled: false, html: '' });
  const r = await care.prepareSeriesCancel({ key: o.key, now: NOW, deps: seriesDeps({ skipLog, readEvent: calApi.readEvent }) });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.action.actionType, 'cancel_calendar_event');
  assert.equal(r.action.target.series, true);
  assert.equal(approve(r.action, NOW + MIN).ok, true);
  const out = await ex.execute(r.action.actionId, { now: NOW + 2 * MIN, deps: calDeps });
  assert.equal(out.status, 'verified', JSON.stringify(out));
  assert.equal(CAL.events.get('MASTER-N').isCancelled, true);
  // A non-series cancel of an event that started is still refused (the guard is intact).
  assert.equal(ex.calendarChecks({ action: { draft: { to: [{ email: 'naomi@nurtur.tech' }], subject: 'Naomi Check In' }, target: { eventId: 'MASTER-N', fromStart: '2026-10-06T10:30' } },
    policy: registry.policyFor('cancel_calendar_event'), event: { ok: true, exists: true, event: { ...CAL.events.get('MASTER-N'), isCancelled: false } }, nowLocal: '2026-11-01T17:00' }).code, 'slot-passed');
  // Keep / remind.
  db.setState(care.STATE_KEY, '{}');
  assert.equal(care.seriesAnswer({ key: o.key, answer: 'remind', now: NOW }).ok, true);
  assert.equal(care.seriesView({ now: NOW, deps: seriesDeps({ skipLog }) }).offers.length, 0);
  assert.equal(care.seriesView({ now: NOW + 31 * 86400000, deps: seriesDeps({ skipLog }) }).offers.length, 1, 'back after a month');
  assert.equal(care.seriesAnswer({ key: o.key, answer: 'keep', now: NOW }).ok, true);
  assert.equal(care.seriesView({ now: NOW + 31 * 86400000, deps: seriesDeps({ skipLog }) }).offers.length, 0);
});

test('15. "I\'m not in it" is remembered durably for the series check, and taken back on resume', () => {
  db.setState(finish.SKIP_LOG_KEY, '[]');
  const ev = { id: 'EV-SKIP', subject: 'Vendor sync', start: '2026-11-02T10:00:00', end: '2026-11-02T11:00:00', attendeesOther: true };
  const r = finish.finish(ev, new Date('2026-11-02T09:00:00Z'), { notAttending: true });
  assert.equal(r.ok, true);
  assert.deepEqual(care.readSkipLog().map((x) => [x.eventId, x.start]), [['EV-SKIP', '2026-11-02T10:00']]);
  finish.resume(r.key, new Date('2026-11-02T09:05:00Z'));
  assert.deepEqual(care.readSkipLog(), []);
});

test('16. every POST refuses a machine client', async () => {
  for (const p of ['/week/protect', '/week/dismiss', '/agenda/refresh', '/agenda/add', '/agenda/done', '/agenda/dismiss', '/series/decline', '/series/cancel', '/series/answer']) {
    const r = await post(`/api/calendar-care${p}`, { key: 'x' }, { 'x-test-api-client': '1' });
    assert.equal(r.status, 403, p);
  }
  const am = require('./authority-matrix');
  for (const p of ['/week/protect', '/week/dismiss', '/agenda/refresh', '/agenda/add', '/agenda/done', '/agenda/dismiss', '/series/decline', '/series/cancel', '/series/answer']) {
    const d = am.machineDecision('POST', `/api/calendar-care${p}`);
    assert.equal(d.allow, false, p);
    assert.equal(d.status, 403, p);
  }
  assert.equal(am.resolve('POST', '/api/calendar-care/agenda/add').capability, 'calendar.attendee.agenda');
  assert.equal(am.resolve('POST', '/api/calendar-care/series/decline').capability, 'calendar.series-decline');
});

test('17. the registry: the agenda type is A4, executable, its own send mode, and binds the body hash', () => {
  const p = registry.policyFor('update_calendar_event_body');
  assert.equal(p.authority, 'A4');
  assert.equal(p.sendMode, 'calendar-body');
  assert.equal(p.switchFlag, 'governed_calendar');
  assert.deepEqual(registry.validateRegistry(), []);
  const h = (body) => registry.payloadHash({ actionType: 'update_calendar_event_body', version: 1, commitmentId: 'c', target: { eventId: 'E', fromStart: 'S', fromBodyHash: body }, draft: { to: [{ email: 'a@b.c' }], subject: 's', body: 'x' } });
  assert.notEqual(h('one'), h('two'));
  // A non-series calendar cancel hashes exactly as before (series omitted).
  const base = { actionType: 'cancel_calendar_event', version: 1, commitmentId: 'c', draft: { to: [{ email: 'a@b.c' }], subject: 's', body: '' } };
  assert.equal(registry.payloadHash({ ...base, target: { eventId: 'E' } }), registry.payloadHash({ ...base, target: { eventId: 'E', series: undefined } }));
  assert.notEqual(registry.payloadHash({ ...base, target: { eventId: 'E' } }), registry.payloadHash({ ...base, target: { eventId: 'E', series: true } }));
});
