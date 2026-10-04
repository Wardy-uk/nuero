'use strict';

/**
 * Build 12S — canonical SEMANTIC fixtures for the presentation layer.
 *
 * Each is a `/api/canonical/now`-shaped payload (only the fields the presenter
 * reads) plus the instant it was read at. They exist so one state can be
 * rendered on every surface and compared: same meaning, different composition.
 *
 * Read by: backend/services/presentation-intent.test.js (the composer),
 * backend/services/situation-render.test.js (every profile), and the fixture
 * gallery (saim/shared-ui/presentation/gallery). The iOS tests carry a JSON
 * copy of the composed output for the same reason.
 *
 * ⚠ Times are Europe/London wall clock, as Graph and life-state deliver them.
 *   `at` is a true instant: 2026-10-03 is a Saturday, 2026-10-06 a Tuesday,
 *   both in BST (UTC+1).
 */

const SAT_10 = Date.parse('2026-10-03T09:00:00Z'); // Sat 10:00 BST
const TUE_1030 = Date.parse('2026-10-06T09:30:00Z'); // Tue 10:30 BST
const TUE_1340 = Date.parse('2026-10-06T12:40:00Z'); // Tue 13:40 BST
const TUE_2240 = Date.parse('2026-10-06T21:40:00Z'); // Tue 22:40 BST
const SUN_1020 = Date.parse('2026-10-04T09:21:37Z'); // Sun 10:21 BST (the live read)

const homeLife = (over = {}) => ({
  doing: 'relaxing', label: 'Relaxing', declared: null, ask: null, confidence: 'likely', sure: true,
  place: { kind: 'home', label: 'living-room', basis: 'watch room sensor' },
  household: null, showWork: false, ...over,
});
const workLife = (over = {}) => ({
  doing: 'working', label: 'Working', declared: null, ask: null, confidence: 'likely', sure: true,
  place: { kind: 'home', label: 'study', basis: 'watch room sensor' }, showWork: true, ...over,
});
const offCtx = (over = {}) => ({
  activity: 'off', label: 'Not a working day', summary: "It's the weekend.", quiet: true,
  duty: { onDuty: false, known: true, reason: 'weekend' }, confidence: { level: 'high' }, ...over,
});
const workCtx = (over = {}) => ({
  activity: 'steady', label: 'Working', summary: 'A working day, in hours.', quiet: false,
  duty: { onDuty: true, known: true, reason: 'A working day, in hours.' }, confidence: { level: 'high' }, ...over,
});
const room = (area, c) => ({ known: true, offers: [], considered: [{ area, temperature: { known: true, reading: { currentC: c } } }] });
const weather = { known: true, tempC: 13.6, outlook: ['up to 17° by 14:00'], rain: null };
const sleep = { known: true, asleepHours: 7.6, usualLine: 'usually 8h05 on a Saturday', notable: false };
const noApprovals = { known: true, needsApproval: 0, needsReview: 0, where: 'Actions, in NEURO on the desktop', say: null };
const situation = (sections = {}, over = {}) => ({ sections: { nextEvent: null, commitments: null, tasks: null, laterUnknown: null, blindness: null, ...sections }, workHeld: null, ...over });

const FIXTURES = [
  {
    id: 'calm-saturday',
    name: 'Calm Saturday at home',
    at: SAT_10,
    payload: {
      context: offCtx(), life: homeLife({ doing: 'watching-tv', label: 'Watching TV' }), primary: { kind: 'context', title: 'Not a working day' },
      secondary: [], poolAvailable: true, gaps: [], dropped: [], approvals: noApprovals,
      agenda: { known: true, events: [{ start: '2026-10-09T00:00:00', end: '2026-10-09T23:59:59', subject: "Tracey Allen's birthday", allDay: true, minutesAway: null }] },
      rooms: room('Living Room', 19.2), weather, lastNight: sleep, situation: situation(), quiet: true,
    },
  },
  {
    id: 'approval',
    name: 'One pending approval',
    at: TUE_1030,
    payload: {
      context: workCtx(), life: workLife(), primary: { kind: 'context', title: 'Working' }, secondary: [],
      poolAvailable: true, gaps: [], dropped: [],
      approvals: { known: true, needsApproval: 1, needsReview: 0, where: 'Actions, in NEURO on the desktop', say: 'The weekly report is ready for your approval.' },
      agenda: { known: true, events: [{ start: '2026-10-06T15:00:00', end: '2026-10-06T15:30:00', subject: '1-2-1 Hope', minutesAway: 270, attendeesOther: true }] },
      rooms: room('Study', 20.1), weather, situation: situation(),
      work: { atDesk: true, deskKnown: true, host: 'DESKTOP-8LGF9RR', app: 'Code' },
    },
  },
  {
    id: 'meeting-soon',
    name: 'Meeting in 20 minutes',
    at: TUE_1340,
    payload: {
      context: workCtx(), life: workLife(), primary: { kind: 'context', title: 'Working' }, secondary: [],
      poolAvailable: true, gaps: [], dropped: [], approvals: noApprovals,
      agenda: { known: true, events: [
        { start: '2026-10-06T14:00:00', end: '2026-10-06T15:00:00', subject: 'Tech Leadership', minutesAway: 20, attendeesOther: true },
        { start: '2026-10-06T16:30:00', end: '2026-10-06T17:00:00', subject: 'Weekly risk review', minutesAway: 170, attendeesOther: true },
      ] },
      rooms: room('Study', 20.4), weather, situation: situation(),
    },
  },
  {
    id: 'personal-deadline',
    name: 'Personal deadline tomorrow',
    at: SAT_10,
    payload: {
      context: offCtx(), life: homeLife(), primary: { kind: 'context', title: 'Not a working day' }, secondary: [],
      poolAvailable: true, gaps: [], dropped: [], approvals: noApprovals, agenda: { known: true, events: [] },
      rooms: room('Kitchen', 18.7), weather, lastNight: sleep,
      situation: situation({ commitments: [{ id: 'commitment:car', description: 'Renew the car insurance', direction: 'i-owe', due: { label: 'tomorrow · stated deadline', relative: 'soon', days: 1 }, importance: 'important-to-me' }] }),
    },
  },
  {
    id: 'source-blind',
    name: 'Source blindness',
    at: TUE_1030,
    payload: {
      context: workCtx(), life: workLife(), primary: { kind: 'context', title: 'Working' }, secondary: [],
      poolAvailable: true, gaps: [{ input: 'presence', why: 'Home Assistant phone data is 1 day stale' }], dropped: [], approvals: noApprovals,
      agenda: { known: true, events: [] }, rooms: room('Study', 20.0), weather,
      situation: situation({ blindness: [{ id: 'source:healthkit.neuro-ios', sourceId: 'healthkit.neuro-ios', label: 'Apple Health (NEURO app)', verdictLabel: 'Stale' }] }),
    },
  },
  {
    id: 'working-busy',
    name: 'Working day, several low-priority items',
    at: TUE_1030,
    payload: {
      context: workCtx(), life: workLife(),
      primary: { kind: 'item', id: 'todo:reply-simon', recordId: 'rec-1', title: 'Reply to Simon about renewals', say: 'He asked on Friday.', urgency: 'normal', tab: 'tasks', actions: ['complete', 'defer', 'acknowledge', 'dismiss', 'start'] },
      secondary: [
        { kind: 'item', id: 'todo:a', recordId: 'rec-2', title: 'Check the FOC report', urgency: 'low' },
        { kind: 'item', id: 'todo:b', recordId: 'rec-3', title: 'Book Naomi’s return-to-work', urgency: 'normal' },
        { kind: 'item', id: 'email:c', recordId: 'rec-4', title: '3 emails waiting a reply', urgency: 'low' },
      ],
      poolAvailable: true, gaps: [], dropped: [], approvals: noApprovals,
      agenda: { known: true, events: [
        { start: '2026-10-06T12:00:00', end: '2026-10-06T12:30:00', subject: 'Standup', minutesAway: 90, attendeesOther: true },
        { start: '2026-10-06T15:00:00', end: '2026-10-06T15:30:00', subject: '1-2-1 Zoe', minutesAway: 270, attendeesOther: true },
      ] },
      rooms: room('Study', 20.6), weather, situation: situation(),
      work: { atDesk: true, deskKnown: true, host: 'DESKTOP-8LGF9RR', app: 'Code' },
    },
  },
  {
    id: 'degraded',
    name: 'No readable sources',
    at: TUE_1030,
    payload: {
      context: { activity: 'unknown', label: "Can't tell", summary: null, duty: { onDuty: true, known: false } },
      life: { doing: 'unknown', label: "Can't tell", place: { kind: 'unknown' }, confidence: 'unknown' },
      primary: null, secondary: [], poolAvailable: false,
      gaps: [{ input: 'decision-engine', why: 'database locked' }, { input: 'calendar', why: 'cache unreadable' }, { input: 'presence', why: 'stale' }],
      dropped: [], approvals: { known: false }, agenda: { known: false, events: [] }, situation: situation(),
    },
  },
  {
    id: 'travelling',
    name: 'Leaving / travelling',
    at: SAT_10,
    payload: {
      context: offCtx({ quiet: true }), life: homeLife({ doing: 'driving', label: 'Driving', place: { kind: 'out', label: 'out' } }),
      primary: { kind: 'context', title: 'Not a working day' }, secondary: [], poolAvailable: true, gaps: [], dropped: [], approvals: noApprovals,
      agenda: { known: true, events: [{ start: '2026-10-03T12:30:00', end: '2026-10-03T14:00:00', subject: 'Lunch at Mum’s', minutesAway: 150 }] },
      weather: { ...weather, rain: { starts: '12:00', inMinutes: 120 } }, situation: situation(),
    },
  },
  {
    id: 'bedtime',
    name: 'Bedtime',
    at: TUE_2240,
    payload: {
      context: workCtx({ activity: 'off', duty: { onDuty: false, known: true, reason: 'Outside working hours (evening).' }, quiet: true }),
      life: homeLife({ doing: 'winding-down', label: 'Winding down', place: { kind: 'home', label: 'bedroom' } }),
      primary: { kind: 'context', title: 'Evening' }, secondary: [], poolAvailable: true, gaps: [], dropped: [], approvals: noApprovals,
      agenda: { known: true, events: [{ start: '2026-10-07T09:15:00', end: '2026-10-07T09:30:00', subject: 'Standup', minutesAway: null, attendeesOther: true }] },
      rooms: room('Bedroom', 31.2), situation: situation(),
    },
  },
  {
    id: 'empty',
    name: 'Truly empty / calm',
    at: SAT_10,
    payload: {
      context: offCtx(), life: homeLife({ doing: 'unknown', label: "Can't tell", confidence: 'unknown' }),
      primary: { kind: 'context', title: 'Not a working day' }, secondary: [], poolAvailable: true, gaps: [], dropped: [],
      approvals: noApprovals, agenda: { known: true, events: [] }, situation: situation(),
    },
  },
  {
    id: 'many-next',
    name: 'Working, several things coming, nothing current (Build 12.1)',
    at: TUE_1030,
    payload: {
      context: workCtx(), life: workLife(), primary: { kind: 'context', title: 'Working' }, secondary: [],
      poolAvailable: true, gaps: [], dropped: [], approvals: noApprovals,
      agenda: { known: true, events: [
        { start: '2026-10-06T12:00:00', end: '2026-10-06T12:30:00', subject: 'Standup', minutesAway: 90, attendeesOther: true },
        { start: '2026-10-06T14:00:00', end: '2026-10-06T15:00:00', subject: 'Tech Leadership', minutesAway: 210, attendeesOther: true },
        { start: '2026-10-06T15:30:00', end: '2026-10-06T16:00:00', subject: '1-2-1 Zoe', minutesAway: 300, attendeesOther: true },
      ] },
      rooms: room('Study', 20.6), weather, situation: situation({ commitments: [
        { id: 'commitment:foc', description: 'Send the FOC numbers to Chris', direction: 'i-owe', due: { label: 'Friday', relative: 'later', days: 3 } },
      ] }),
    },
  },
  {
    id: 'live-sunday',
    name: 'Live read, Sun 4 Oct 2026 (duplicate birthday)',
    at: SUN_1020,
    payload: {
      context: offCtx({ confidence: { level: 'moderate' } }),
      life: {
        doing: 'unknown', label: "Can't tell", declared: null, confidence: 'unknown', sure: false,
        ask: { question: 'What are you up to?', options: [
          { doing: 'working', label: 'Working' }, { doing: 'hobby', label: 'My own project' }, { doing: 'relaxing', label: 'Relaxing' },
          { doing: 'watching-tv', label: 'Watching TV' }, { doing: 'winding-down', label: 'Off to bed' }] },
        place: { kind: 'home', label: 'living-room' }, household: { othersHome: true, who: ['Helen', 'Isaac'] },
      },
      primary: { kind: 'context', id: 'context-off', title: 'Not a working day', say: "It's the weekend." },
      secondary: [], poolAvailable: true, approvals: noApprovals, quiet: true,
      gaps: [{ input: 'presence', why: "Home Assistant's phone data is 1 day stale — the Companion app has stopped reporting" }],
      dropped: [{ id: 'x', why: 'not a working day' }, { id: 'y', why: 'not a working day' }],
      agenda: { known: true, scope: 'friday', events: [
        { start: '2026-10-09T00:00:00', end: '2026-10-09T23:59:59', subject: "Tracey Allen's birthday", minutesAway: null, allDay: true, attendeesOther: null },
        { start: '2026-10-09T00:00:00', end: '2026-10-09T23:59:59', subject: 'Tracey Allen’s 16th Birthday', minutesAway: null, allDay: true, attendeesOther: null },
      ] },
      rooms: room('Living Room', 19.2),
      weather: { known: true, condition: 'partlycloudy', tempC: 9.8, outlook: ['up to 18° by 13:00'], rain: null },
      lastNight: { known: true, asleepHours: 10.92, usualLine: 'usually 8h29 on a Sunday', notable: false },
      work: { known: true, atDesk: true, deskKnown: true, host: 'MacBook Air', app: 'Claude' },
      situation: situation({ laterUnknown: { count: 2, say: "2 later events of unknown domain — not leading while you're off duty." } },
        { workHeld: { count: 2, say: "2 work items held back while you're off duty." } }),
    },
  },
];

module.exports = { FIXTURES };
