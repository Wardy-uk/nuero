'use strict';

/**
 * The one thing worth saying as he walks in.
 *
 * Nick, 13 Sep 2026: *"take JARVIS as a concept and build it into SARA."* The
 * greeting already had the hard parts - she notices him arrive, owns a
 * cooldown, and NEURO decides the words while SARA only delivers them. What it
 * SAID was a greeting plus the top task: the same sentence whatever was
 * actually happening.
 *
 * PURE, so the ranking pins without a house, a diary or a clock. The ranking IS
 * the product - what earns an interruption at the moment of walking in - so
 * most of what follows is about ORDER and about refusing.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { briefLine, MEETING_SOON_MINUTES } = require('./greeting');

const NOW = new Date('2026-09-15T09:00:00');

const meeting = (over = {}) => ({
  known: true,
  events: [{ subject: 'Catch-up with Chris', minutesAway: 10, attendeesOther: true, ...over }],
});
const coldRoom = { known: true, offers: [{ kind: 'warm-room', currentC: 16.4 }] };
const rain = { known: true, outlook: ['rain from 10:20'] };
const critical = { kind: 'item', title: 'NT-14855 breaching', urgency: 'critical' };

// -- What earns the slot -----------------------------------------------------

test('a meeting about to start is what she says', () => {
  const b = briefLine({ now: NOW, agenda: meeting() });
  assert.equal(b.kind, 'meeting');
  assert.match(b.line, /Catch-up with Chris/);
  assert.match(b.line, /in 10 minutes/);
});

test('a cold room is mentioned when nothing is more pressing', () => {
  const b = briefLine({ now: NOW, rooms: coldRoom });
  assert.equal(b.kind, 'cold');
  assert.match(b.line, /16/);
});

test('rain uses the outlook\'s OWN words', () => {
  // `weather-outlook` already decided what is worth mentioning and phrased it
  // once, so every surface says it the same way.
  const b = briefLine({ now: NOW, weather: rain });
  assert.equal(b.kind, 'weather');
  assert.match(b.line, /rain from 10:20/);
});

test('how he slept, once, on the first greeting of the day', () => {
  const lastNight = { known: true, asleepHours: 9.62, notable: true, usualLine: 'usually 7h52 on a Sunday' };
  const b = briefLine({ now: NOW, firstToday: true, lastNight });
  assert.equal(b.kind, 'sleep');
  assert.match(b.line, /9h37/);
  assert.match(b.line, /usually 7h52 on a Sunday/);
});

// -- The ORDER, which is the product ----------------------------------------

test('WARNING the ranking holds: meeting > breach > cold room > weather > sleep', () => {
  const all = {
    now: NOW,
    firstToday: true,
    agenda: meeting(),
    primary: critical,
    rooms: coldRoom,
    weather: rain,
    lastNight: { known: true, asleepHours: 9.62, notable: true, usualLine: 'usually 7h52 on a Sunday' },
  };
  assert.equal(briefLine(all).kind, 'meeting');
  assert.equal(briefLine({ ...all, agenda: null }).kind, 'critical');
  assert.equal(briefLine({ ...all, agenda: null, primary: null }).kind, 'cold');
  assert.equal(briefLine({ ...all, agenda: null, primary: null, rooms: null }).kind, 'weather');
  assert.equal(briefLine({ ...all, agenda: null, primary: null, rooms: null, weather: null }).kind, 'sleep');
});

test('WARNING ONE LINE, never a list', () => {
  // A briefing at the door is noise. Everything competes for a single slot.
  const b = briefLine({
    now: NOW, firstToday: true, agenda: meeting(), primary: critical, rooms: coldRoom, weather: rain,
  });
  assert.equal(typeof b.line, 'string');
  assert.doesNotMatch(b.line, /breaching/, 'only the winner is said');
  assert.doesNotMatch(b.line, /rain/);
});

// -- What it refuses ---------------------------------------------------------

test('WARNING-WARNING NEGATIVE: a SOLO block is never announced as a meeting', () => {
  // Half his diary is focus blocks. `attendeesOther` is three-valued and only
  // an exact TRUE is a meeting - `isRealMeeting`'s rule, inherited.
  for (const attendeesOther of [false, null, undefined]) {
    const b = briefLine({ now: NOW, agenda: meeting({ attendeesOther }) });
    assert.equal(b, null, String(attendeesOther));
  }
});

test('WARNING a meeting further off than the window is not mentioned at the door', () => {
  const far = meeting({ minutesAway: MEETING_SOON_MINUTES + 1 });
  assert.equal(briefLine({ now: NOW, agenda: far }), null);
});

test('WARNING an UNREADABLE diary says nothing, rather than nothing being on', () => {
  assert.equal(briefLine({ now: NOW, agenda: { known: false } }), null);
});

test('WARNING an unreadable house and an unreadable sky both drop out silently', () => {
  assert.equal(briefLine({ now: NOW, rooms: { known: false }, weather: { known: false } }), null);
});

test('WARNING sleep is NOT mentioned after the first greeting of the day', () => {
  const lastNight = { known: true, asleepHours: 9.62, notable: true, usualLine: 'usually 7h52' };
  assert.equal(briefLine({ now: NOW, firstToday: false, lastNight }), null);
});

test('WARNING an ORDINARY night is not worth saying', () => {
  // Only a night out of the ordinary FOR THAT WEEKDAY earns the slot; otherwise
  // she would report his sleep every single morning.
  const ordinary = { known: true, asleepHours: 7.9, notable: false, usualLine: 'usually 7h52' };
  assert.equal(briefLine({ now: NOW, firstToday: true, lastNight: ordinary }), null);
});

test('WARNING NEGATIVE: she does not say the same KIND twice running', () => {
  // Told about the weather on the way in, she finds something else next time or
  // says nothing - the rule the opener and lead pools already follow.
  assert.equal(briefLine({ now: NOW, weather: rain }).kind, 'weather');
  assert.equal(briefLine({ now: NOW, weather: rain, recentKinds: ['weather'] }), null);
  // …and a different fact is still available.
  const b = briefLine({ now: NOW, weather: rain, rooms: coldRoom, recentKinds: ['weather'] });
  assert.equal(b.kind, 'cold');
});

test('nothing to say is a correct answer, and the commonest one', () => {
  assert.equal(briefLine({ now: NOW }), null);
  assert.equal(briefLine({}), null);
  assert.equal(briefLine(), null);
});

test('WARNING NEGATIVE: it never diagnoses, advises or praises', () => {
  // `health-daily` refuses to diagnose and `initiation-signals` refuses to
  // score; a voice in the room is the last place to start doing either.
  const lines = [
    briefLine({ now: NOW, agenda: meeting() }),
    briefLine({ now: NOW, rooms: coldRoom }),
    briefLine({ now: NOW, weather: rain }),
    briefLine({ now: NOW, firstToday: true, lastNight: { known: true, asleepHours: 5.2, notable: true, usualLine: 'usually 7h52' } }),
    briefLine({ now: NOW, primary: critical }),
  ].filter(Boolean).map(b => b.line).join(' ');
  for (const verdict of [/tired/i, /should/i, /well done/i, /good job/i, /take it easy/i, /you.{0,3}re (not|doing)/i, /try to/i]) {
    assert.doesNotMatch(lines, verdict, String(verdict));
  }
});

test('WARNING-WARNING the cold-room kind matches what room-offers ACTUALLY emits', () => {
  // The first cut guessed `heating` and matched nothing - silently, because a
  // find() returning undefined is indistinguishable from a warm house. This
  // asserts against the PRODUCER rather than against the guess.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'room-offers.js'), 'utf8');
  assert.match(src, /kind: 'warm-room'/, 'positive control: room-offers still emits it');
  const brief = require('fs').readFileSync(require('path').join(__dirname, 'greeting.js'), 'utf8');
  assert.match(brief, /o\.kind === 'warm-room'/, 'and the brief looks for the same string');
});
