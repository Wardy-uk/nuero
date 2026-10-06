'use strict';

// What is Nick doing? — the cases he named, 2 Oct 2026.
//   "am I watching TV? relaxing? out hiking? sleeping?"
//   "I don't care about work tasks at 4pm on a Saturday"
//   "my laptop itself isn't enough to prove I'm working"

const test = require('node:test');
const assert = require('node:assert/strict');
const life = require('./life-state');

const WORKDAY = { known: true, isWorkingDay: true, reason: null };
const SATURDAY = { known: true, isWorkingDay: false, reason: 'weekend' };
const at = (d, h, m = 0) => new Date(2026, 9, d, h, m); // Oct 2026: 2nd Fri, 3rd Sat

const base = (over = {}) => ({
  workingDay: WORKDAY,
  hours: '08:00-18:00',
  night: '21:00-07:00',
  meeting: { known: true, now: false },
  focusSession: { running: false },
  desk: { known: true, app: null },
  phone: { zone: 'home', ssid: 'WardNet', activity: 'Stationary', audioOutput: 'Built-in Speaker', locality: 'Coalville' },
  room: { known: false },
  tv: { known: true, on: false },
  household: { known: true, othersHome: true, who: ['Helen', 'Isaac'] },
  ...over,
});

test('today: Teams at the office is working, and sure', () => {
  const r = life.infer(base({
    phone: { zone: 'Office', ssid: 'Nurtur-Corp', activity: 'Stationary', audioOutput: 'Bluetooth A2DP', locality: 'Derby' },
    desk: { known: true, app: 'ms-teams', label: 'Teams' },
  }), at(2, 13, 30));
  assert.equal(r.doing, 'working');
  assert.equal(r.confidence, 'sure');
  assert.equal(r.place.kind, 'work');
  assert.equal(r.showWork, true);
});

test('⚠ 4pm on a Saturday at home is not work — and work content is hidden', () => {
  const r = life.infer(base({ workingDay: SATURDAY, room: { known: true, room: 'living-room' } }), at(3, 16));
  assert.equal(r.doing, 'relaxing');
  assert.equal(r.showWork, false);
  assert.match(r.evidence.join(' '), /weekend/);
});

test('⚠ VS Code in the evening is his own project, not work', () => {
  const r = life.infer(base({ desk: { known: true, app: 'Code', label: 'VS Code' } }), at(2, 19, 30));
  assert.equal(r.doing, 'hobby');
  assert.equal(r.showWork, false);
});

test('⚠ a laptop during working hours at home is only a GUESS at work', () => {
  const r = life.infer(base({ desk: { known: true, app: 'Code', label: 'VS Code' } }), at(2, 11));
  assert.equal(r.doing, 'working');
  assert.equal(r.confidence, 'guess');
  assert.match(r.evidence.join(' '), /could be your own project/);
});

test('Outlook in the evening IS work, even out of hours', () => {
  const r = life.infer(base({ desk: { known: true, app: 'olk', label: 'Outlook' } }), at(2, 19));
  assert.equal(r.doing, 'working');
  assert.equal(r.showWork, true);
});

test('a real meeting outranks everything and makes him on duty', () => {
  const r = life.infer(base({ meeting: { known: true, now: true, subject: '1-2-1 Hope' } }), at(2, 18, 10));
  assert.equal(r.doing, 'in-meeting');
  assert.equal(r.company, 'colleagues');
  assert.equal(r.showWork, true);
});

test('TV on with the watch in the living room is watching TV, and sure', () => {
  const r = life.infer(base({ workingDay: SATURDAY, tv: { known: true, on: true }, room: { known: true, room: 'living-room' } }), at(3, 20));
  assert.equal(r.doing, 'watching-tv');
  assert.equal(r.confidence, 'sure');
  assert.equal(r.company, 'family');
});

test('⚠ the plug IS the TV: on, at home, room unknown, is watching TV', () => {
  // Nick, 2 Oct 2026: "if it's on — the TV is on."
  const r = life.infer(base({ workingDay: SATURDAY, tv: { known: true, on: true }, room: { known: false } }), at(3, 20));
  assert.equal(r.doing, 'watching-tv');
  assert.equal(r.confidence, 'likely');
});

test('TV on with nobody in the living room is NOT watching TV', () => {
  const r = life.infer(base({ workingDay: SATURDAY, tv: { known: true, on: true }, room: { known: true, room: 'kitchen' } }), at(3, 20));
  assert.notEqual(r.doing, 'watching-tv');
});

test('walking, away from home and work, is out walking', () => {
  const r = life.infer(base({ workingDay: SATURDAY, phone: { zone: 'not_home', activity: 'Walking', locality: 'Ashby-de-la-Zouch' } }), at(3, 11));
  assert.equal(r.doing, 'walking');
  assert.match(r.evidence.join(' '), /Ashby/);
});

test('walking around the house is not a walk', () => {
  const r = life.infer(base({ workingDay: SATURDAY, phone: { zone: 'home', activity: 'Walking' } }), at(3, 11));
  assert.notEqual(r.doing, 'walking');
});

test('CarPlay is driving', () => {
  const r = life.infer(base({ phone: { zone: 'not_home', activity: 'Automotive', audioOutput: 'CarPlay' } }), at(2, 8, 20));
  assert.equal(r.doing, 'driving');
  assert.equal(r.confidence, 'sure');
});

test('night with the watch in the bedroom is asleep — as a GUESS that asks', () => {
  const r = life.infer(base({ room: { known: true, room: 'bedroom' } }), at(3, 2));
  assert.equal(r.doing, 'sleeping');
  assert.equal(r.band, 'night');
  assert.equal(r.showWork, false);
  assert.equal(r.confidence, 'guess');
  assert.ok(r.ask, 'a guess must ask, never assert asleep');
});

// ⚠ 5 Oct 2026, 21:18: watching the bedroom TV, and SAiM said "asleep".
test('⚠ the bedroom TV on with the watch in the bedroom is watching TV, not asleep', () => {
  const r = life.infer(base({
    room: { known: true, room: 'bedroom' },
    tv: { known: true, on: true, rooms: { 'living-room': false, bedroom: true } },
  }), at(5, 21, 18));
  assert.equal(r.doing, 'watching-tv');
  assert.equal(r.confidence, 'sure');
  assert.equal(r.ask, null);
});

test('a TV on in ANOTHER room is not his evening', () => {
  const r = life.infer(base({
    room: { known: true, room: 'bedroom' },
    tv: { known: true, on: true, rooms: { 'living-room': true, bedroom: false } },
  }), at(5, 21, 18));
  assert.equal(r.doing, 'sleeping');
  assert.equal(r.confidence, 'guess');
});

test('an unread bedroom plug is unknown, never "off" and never "on"', () => {
  assert.equal(life.tvOnIn({ known: true, on: true, rooms: { 'living-room': true } }, 'bedroom'), false);
  assert.equal(life.tvOnIn({ known: false }, 'bedroom'), false);
  // the legacy single-plug shape still means the living room
  assert.equal(life.tvOnIn({ known: true, on: true }, 'living-room'), true);
  assert.equal(life.tvOnIn({ known: true, on: true }, 'bedroom'), false);
});

test('TV entity map parses room=entity pairs', () => {
  assert.deepEqual(life.parseTvEntities('living-room=switch.a, Bedroom=switch.b,junk'), { 'living-room': 'switch.a', bedroom: 'switch.b' });
});

test('⚠ nothing legible is UNKNOWN, said out loud — never a guess at "relaxing"', () => {
  const r = life.infer({ workingDay: WORKDAY, meeting: { known: false } }, at(2, 11));
  assert.equal(r.doing, 'unknown');
  assert.equal(r.label, "Can't tell");
  assert.ok(r.unknowns.includes('phone'));
  // ...and on a working day in hours, unknown keeps today's behaviour: work shows.
  assert.equal(r.showWork, true);
});

test('bands: 08:00-18:00 working, 21:00-07:00 night', () => {
  assert.equal(life.bandFor(at(2, 7, 30)), 'early');
  assert.equal(life.bandFor(at(2, 9)), 'working');
  assert.equal(life.bandFor(at(2, 19)), 'evening');
  assert.equal(life.bandFor(at(2, 22)), 'night');
});

test('a meeting is matched on wall-clock strings and needs other people in it', () => {
  const rows = [
    { subject: 'Focus block', start_time: '2026-10-02T13:00:00', end_time: '2026-10-02T14:00:00', attendees_other: 0 },
    { subject: 'Sync', start_time: '2026-10-02T13:15:00', end_time: '2026-10-02T13:45:00', attendees_other: 1 },
  ];
  assert.equal(life.meetingNow(rows, at(2, 13, 5)).now, false, 'a solo block is not a meeting');
  assert.equal(life.meetingNow(rows, at(2, 13, 20)).subject, 'Sync');
});

// ── Asking when it is a guess (Nick: "something should probably ask me what I'm
//    doing if there's ambiguity") ─────────────────────────────────────────────

test('a guess asks "What are you up to?", with options that fit where he is', () => {
  const r = life.infer(base({ desk: { known: true, app: 'Code', label: 'VS Code' } }), at(2, 11));
  assert.equal(r.confidence, 'guess');
  assert.equal(r.ask.question, 'What are you up to?');
  const opts = r.ask.options.map((o) => o.doing);
  assert.ok(opts.includes('working') && opts.includes('hobby'), 'home options');
  assert.equal(r.ask.options.find((o) => o.doing === 'hobby').label, 'My own project');
});

test('a sure read does not ask', () => {
  const r = life.infer(base({ meeting: { known: true, now: true, subject: 'Sync' } }), at(2, 11));
  assert.equal(r.ask, null);
});

test('"not now" quietens the question', () => {
  const r = life.infer(base({ desk: { known: true, app: 'Code' }, askSnoozed: true }), at(2, 11));
  assert.equal(r.ask, null);
});

test('⚠ his answer beats the inference, and says so', () => {
  const now = at(2, 11);
  const declared = { doing: 'hobby', at: new Date(now.getTime() - 10 * 60000).toISOString(), until: new Date(now.getTime() + 60 * 60000).toISOString(), placeKind: 'home' };
  const r = life.infer(base({ desk: { known: true, app: 'Code' }, declared }), now);
  assert.equal(r.doing, 'hobby');
  assert.equal(r.confidence, 'sure');
  assert.equal(r.showWork, false);
  assert.match(r.evidence[0], /you told me at 10:50/);
  assert.equal(r.ask, null);
});

test('a declaration lapses when its time is up, or when he changes place', () => {
  const now = at(2, 11);
  const expired = { doing: 'relaxing', at: now.toISOString(), until: new Date(now.getTime() - 1).toISOString(), placeKind: 'home' };
  assert.notEqual(life.infer(base({ declared: expired }), now).doing, 'relaxing');
  const saidAtHome = { doing: 'relaxing', at: now.toISOString(), until: new Date(now.getTime() + 3600000).toISOString(), placeKind: 'home' };
  const atWork = base({ declared: saidAtHome, phone: { zone: 'Office', ssid: 'Nurtur-Corp' } });
  assert.notEqual(life.infer(atWork, now).doing, 'relaxing', 'it does not follow him to work');
});

test('an unknown activity cannot be declared', async () => {
  await assert.rejects(() => life.declare('napping'), /unknown activity/);
});

test('⚠ the watch at the WORK desk sensor is work, not a room at home', () => {
  // First live read, 2 Oct 2026: "home, in the office" while he sat in Derby.
  const r = life.infer(base({ room: { known: true, room: 'office' }, desk: { known: true, app: 'ms-teams', label: 'Teams' } }), at(2, 14));
  assert.equal(r.place.kind, 'work');
  assert.equal(r.doing, 'working');
  assert.equal(r.confidence, 'sure');
  assert.equal(r.ask, null);
});
