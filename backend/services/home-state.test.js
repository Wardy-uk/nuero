'use strict';

/**
 * The house, in words a model can answer with.
 *
 * ⚠⚠ WHY THIS EXISTS. The day SARA became the voice agent in the living room,
 * the most obvious thing to say to her was the one thing she could not answer:
 *
 *     "what is the living room temperature"
 *     → "I don't have access to your smart home system or temperature sensors."
 *
 * And it was NOT TRUE — `ha-rooms` had been reading every room for weeks; the
 * chat tools simply did not expose it. A system that denies a capability it has
 * is worse than one that lacks it, because he stops asking.
 *
 * PURE, so all of this pins without Home Assistant, a network or a clock. Most
 * of what follows is a refusal.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describeHouse, describeRoom, countLights, roomSentence,
        looksLikeHouseQuestion, houseBriefing } = require('./home-state');

const HOUSE = {
  known: true,
  rooms: [
    {
      area: 'Living room',
      lights: [{ entity_id: 'light.a', state: 'on' }, { entity_id: 'light.b', state: 'off' }],
      climate: [{ entity_id: 'climate.living_room_rad', state: 'heat', currentC: 20.4, targetC: 19 }],
    },
    { area: 'Kitchen', lights: [{ entity_id: 'light.k', state: 'unavailable' }], climate: [] },
  ],
  presence: { room: 'living-room', subject: 'watch' },
  household: { known: true, othersHome: true, who: ['Helen'] },
  gaps: [],
};

// ── Reading the house ────────────────────────────────────────────────────────

test('it answers the question that started all this', () => {
  const h = describeHouse(HOUSE);
  const lounge = h.rooms.find(r => r.room === 'Living room');
  assert.equal(lounge.temperatureC, 20.4);
  assert.equal(lounge.targetC, 19);
});

test('⚠ NO ENTITY ID REACHES THE ANSWER', () => {
  // `climate.living_room_rad` identifies a radiator to Home Assistant and to
  // nobody else. A model handed one will eventually say it out loud — the
  // `candidate-provenance` rule, where an opaque id rendered as a label made a
  // whole queue unreadable.
  const json = JSON.stringify(describeHouse(HOUSE));
  assert.doesNotMatch(json, /climate\./);
  assert.doesNotMatch(json, /light\./);
  assert.doesNotMatch(json, /entity_id/);
});

test('⚠ THREE LIGHT STATES, never two', () => {
  // A bulb switched off at the WALL reads `unavailable` — 7 of 14 in this house
  // when first probed. `off` means she can help; `unavailable` means she cannot
  // reach it, and folding them together makes "shall I put the lights on?" an
  // offer that fails on acceptance.
  const c = countLights([{ state: 'on' }, { state: 'off' }, { state: 'unavailable' }, { state: 'unknown' }]);
  assert.deepEqual(c, { on: 1, off: 1, unreachable: 2 });
});

test('⚠ an unreachable light is SAID, not hidden', () => {
  const line = roomSentence('Kitchen', null, { on: 0, off: 0, unreachable: 2 });
  assert.match(line, /can’t reach/);
});

// ── What it refuses ──────────────────────────────────────────────────────────

test('⚠⚠ NEGATIVE: an unreadable house is NOT an empty one', () => {
  // "I couldn't read the house" and "everything is off" are opposite facts and
  // only one is an all-clear.
  for (const bad of [null, undefined, {}, { known: false }, { known: true, rooms: null }]) {
    const h = describeHouse(bad);
    assert.equal(h.known, false, JSON.stringify(bad));
    assert.ok(h.gaps.length, 'and it says why');
  }
});

test('⚠ the gaps are NAMED, never counted', () => {
  const h = describeHouse({ known: false, gaps: ['no room-presence sensor in Home Assistant'] });
  assert.match(h.gaps[0], /room-presence sensor/);
});

test('⚠⚠ NEGATIVE: a FAHRENHEIT reading is refused, never answered', () => {
  // Measured on this house, same radiator, same second: the climate attribute
  // said 20.0 and the sensor entity said 68.0. A 68 spoken as "sixty-eight
  // degrees" in a British living room is the failure this guards, and the
  // predicate is BORROWED from `room-offers` so both refuse the same value.
  const r = describeRoom({ area: 'Living room', lights: [], climate: [{ currentC: 68, targetC: 68 }] });
  assert.equal(r.temperatureC, null);
  assert.equal(r.targetC, null);
  assert.equal(r.thermostats, 0, 'and it does not claim a thermostat answered');
});

test('⚠ a room with nothing readable still APPEARS', () => {
  // Dropping it would let "which rooms are cold" answer confidently over a
  // house it only partly read.
  const h = describeHouse({ ...HOUSE, rooms: [{ area: 'Garage', lights: [], climate: [] }] });
  assert.equal(h.rooms.length, 1);
  assert.equal(h.rooms[0].room, 'Garage');
  assert.equal(h.rooms[0].temperatureC, null);
  assert.match(h.rooms[0].summary, /nothing readable/);
});

test('⚠ NEGATIVE: nobody-else-home and could-not-tell are different', () => {
  // `null` must never be spoken as "nobody is home".
  assert.equal(describeHouse({ ...HOUSE, household: { known: true, othersHome: false, who: [] } }).othersHome, false);
  assert.equal(describeHouse({ ...HOUSE, household: { known: false, othersHome: null, who: [] } }).othersHome, null);
});

test('⚠ presence is where the WATCH is, and `unclear` is not a room', () => {
  // Proven by a watch reading "bedroom / sure" for eight minutes while Nick
  // showered — nothing downstream may promote it to "where Nick is".
  assert.equal(describeHouse({ ...HOUSE, presence: { room: 'unclear' } }).whereHeIs, null);
  assert.equal(describeHouse({ ...HOUSE, presence: null }).whereHeIs, null);
  assert.equal(describeHouse(HOUSE).whereHeIs, 'living-room');
});

test('⚠ several radiators give the MEDIAN, and the count is reported', () => {
  // One odd radiator in a room of three must not become the room — and "the
  // house is cold" has to be tellable from "one radiator answered".
  const r = describeRoom({ area: 'Hall', lights: [], climate: [{ currentC: 18 }, { currentC: 20 }, { currentC: 22 }] });
  assert.equal(r.temperatureC, 20);
  assert.equal(r.thermostats, 3);
});

test('it is PURE — the same house twice gives the same answer, and is not mutated', () => {
  const before = JSON.stringify(HOUSE);
  assert.deepEqual(describeHouse(HOUSE), describeHouse(HOUSE));
  assert.equal(JSON.stringify(HOUSE), before);
});

// -- Asking about the house -------------------------------------------------
//
// WARNING-WARNING  THE ROUTER EXISTS BECAUSE THE PROMPT RULE WAS NOT ENOUGH.
//   Asked "is anyone else home", SARA answered "No" with NO TOOL CALL AT ALL,
//   measured against the backend log on 13 Sep 2026, while the household
//   sensor read `on` with Helen and Isaac in it. Every phrasing below that is
//   marked LIVE was actually said to her that day.

test('the phrasings she got WRONG are routed to a read', () => {
  // LIVE: answered "No" with no tool call, twice, while two people were in.
  assert.equal(looksLikeHouseQuestion('is anyone else home'), true);
  assert.equal(looksLikeHouseQuestion('is anyone else home, and are any lights on downstairs'), true);
});

test('the ordinary house phrasings are routed too', () => {
  for (const q of [
    'what is the living room temperature',
    'how warm is the house',
    'is the house cold',
    'are any lights on',
    'is the heating on in the living room',
    'whats the bedroom temperature',
    'is Helen home',
    'is anybody in',
  ]) {
    assert.equal(looksLikeHouseQuestion(q), true, q);
  }
});

test('WARNING NEGATIVE: it does not fire on sentences that merely say home', () => {
  // Injecting a room-by-room reading into these would have SARA answering a
  // question nobody asked.
  for (const q of [
    'I am working from home today',
    'on my way home',
    'what did I finish this week',
    'book me a meeting with Chris',
    'add a todo buy cat food',
    '',
    null,
  ]) {
    assert.equal(looksLikeHouseQuestion(q), false, JSON.stringify(q));
  }
});

// -- What is put in front of the model --------------------------------------

test('the briefing carries the rooms and who is in', () => {
  const text = houseBriefing(describeHouse(HOUSE));
  assert.match(text, /Living room: 20.4/);
  assert.match(text, /Others home: yes \(Helen\)/);
});

test('WARNING-WARNING an UNREADABLE house still produces a block, and forbids inventing', () => {
  // Silence here would leave the model free to do exactly what this exists to
  // stop - the block has to be present AND has to say it could not look.
  const text = houseBriefing(describeHouse(null));
  assert.match(text, /could not be read/);
  assert.match(text, /Do NOT say anything is on, off, warm or cold/);
});

test('WARNING an unreadable HOUSEHOLD is never rendered as nobody home', () => {
  const text = houseBriefing(describeHouse({
    ...HOUSE,
    household: { known: false, othersHome: null, who: [] },
  }));
  assert.match(text, /COULD NOT BE READ/);
  assert.doesNotMatch(text, /Others home: no/);
});

test('WARNING the briefing leaks no entity ids either', () => {
  const text = houseBriefing(describeHouse(HOUSE));
  assert.doesNotMatch(text, /climate\./);
  assert.doesNotMatch(text, /light\./);
});

test('WARNING the house is read BEFORE the model, in claude.js', () => {
  // The router is only useful if something calls it. This is the join, and the
  // join is where this kind of work breaks - `canOpen` was stored, returned
  // and then not copied, hours before this was written.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'claude.js'), 'utf8');
  assert.match(src, /TOOL_PROMPT/, 'positive control: wrong file');
  assert.match(src, /looksLikeHouseQuestion\(userMessage\)/,
    'the prompt builder must route the question');
  assert.match(src, /houseBriefing/, 'and put the reading in front of the model');
});
