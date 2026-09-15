'use strict';

/**
 * One visit to a room.
 *
 * What is under test is the product: "ask once per visit" is only worth having
 * if a visit survives the presence feed blinking, and only honest if walking
 * out and coming back later counts as a new one. Both directions are cheap to
 * get wrong and expensive to live with — too eager and SAiM re-asks ten times
 * an evening, too sticky and she never asks again after one "no".
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ep = require('./room-episode');
const greeter = require('../../saim/backend/src/greeting/greeter');

const T0 = Date.parse('2026-09-12T18:00:00Z');
const at = ms => new Date(T0 + ms);
const sure = room => ({ room, confidence: 'sure' });
const unclear = { room: null, confidence: 'unclear' };

test('⚠ the wobble guard is the greeter\'s measured number, not a new one', () => {
  // 45s sits between a 16s sensor wobble and a ~56s real walk out and back,
  // both measured on live data on 31 Aug 2026. Two numbers for one physical
  // fact is how two parts of a system disagree about whether he left the room.
  assert.equal(ep.MIN_AWAY_MS, greeter.MIN_AWAY_MS);
});

test('arriving in a room starts a visit', () => {
  const r = ep.advance(null, sure('living-room'), at(0));
  assert.equal(r.room, 'living-room');
  assert.ok(r.episode);
  assert.equal(r.changed, true);
});

test('staying put keeps the same visit', () => {
  const a = ep.advance(null, sure('living-room'), at(0));
  const b = ep.advance(a.state, sure('living-room'), at(60_000));
  const c = ep.advance(b.state, sure('living-room'), at(3_600_000));
  assert.equal(b.episode, a.episode);
  assert.equal(c.episode, a.episode, 'an hour later is still the same visit');
  assert.equal(c.changed, false);
});

test('⚠ a 16-second wobble is NOT a new visit — that is the whole point', () => {
  // The exact failure the greeter measured: unsure for 16s, then back.
  const a = ep.advance(null, sure('living-room'), at(0));
  const b = ep.advance(a.state, unclear, at(5_000));
  const c = ep.advance(b.state, unclear, at(16_000));
  const d = ep.advance(c.state, sure('living-room'), at(21_000));
  assert.equal(d.episode, a.episode, 'same visit, so no second prompt');
  assert.equal(d.changed, false);
});

test('⚠ unreadable presence HOLDS the visit open, it does not end it', () => {
  const a = ep.advance(null, sure('living-room'), at(0));
  const b = ep.advance(a.state, unclear, at(10_000));
  assert.equal(b.episode, a.episode);
  assert.equal(b.room, 'living-room');
  assert.match(b.why, /held open/);
});

test('a real walk out and back is a new visit, and a fair question again', () => {
  // ~56s was his measured walk. Anything past 45s counts.
  const a = ep.advance(null, sure('living-room'), at(0));
  const b = ep.advance(a.state, unclear, at(10_000));
  const c = ep.advance(b.state, sure('living-room'), at(70_000));
  assert.notEqual(c.episode, a.episode);
  assert.equal(c.changed, true);
});

test('moving to another room always ends the visit, however briefly', () => {
  const a = ep.advance(null, sure('living-room'), at(0));
  const b = ep.advance(a.state, sure('kitchen'), at(5_000));
  assert.equal(b.room, 'kitchen');
  assert.notEqual(b.episode, a.episode);
  assert.match(b.why, /moved from living-room/);
});

test('coming back to a room he was just in is still a new visit', () => {
  const a = ep.advance(null, sure('living-room'), at(0));
  const b = ep.advance(a.state, sure('kitchen'), at(10_000));
  const c = ep.advance(b.state, sure('living-room'), at(20_000));
  assert.notEqual(c.episode, a.episode, 'he went somewhere else and returned');
});

test('a long blind spell ends the visit rather than holding it for ever', () => {
  const a = ep.advance(null, sure('living-room'), at(0));
  const b = ep.advance(a.state, unclear, at(10_000));
  const c = ep.advance(b.state, unclear, at(120_000));
  assert.equal(c.episode, null);
  assert.equal(c.room, null);
  assert.match(c.why, /visit ended/);
});

test('⚠ never seen at all is not a visit', () => {
  const r = ep.advance(null, unclear, at(0));
  assert.equal(r.episode, null);
  assert.equal(r.room, null);
});

test('⚠ no readable clock holds state rather than inventing a visit', () => {
  const a = ep.advance(null, sure('living-room'), at(0));
  const r = ep.advance(a.state, sure('living-room'), 'not a date');
  assert.equal(r.episode, a.episode);
  assert.equal(r.changed, false);
  assert.match(r.why, /clock/);
});

test('presence below `sure` never starts a visit', () => {
  for (const p of [{ room: 'living-room', confidence: 'unclear' }, { room: 'living-room', confidence: null }, null]) {
    assert.equal(ep.advance(null, p, at(0)).episode, null);
  }
});

test('the offer key is scoped to the visit, so "no" means "not this time"', () => {
  const a = ep.advance(null, sure('living-room'), at(0));
  const k1 = ep.keyFor('room:living-room:lights-on', a.episode);
  const later = ep.advance(a.state, sure('kitchen'), at(10_000));
  const back = ep.advance(later.state, sure('living-room'), at(20_000));
  const k2 = ep.keyFor('room:living-room:lights-on', back.episode);
  assert.notEqual(k1, k2, 'a new visit mints a new key, so she may ask again');
  assert.ok(k1.startsWith('room:living-room:lights-on#'));
});

test('area slugs are stable across punctuation and case', () => {
  assert.equal(ep.slug("Lizzy's Room"), 'lizzy-s-room');
  assert.equal(ep.slug('Living Room'), 'living-room');
});
