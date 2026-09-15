'use strict';

/**
 * She knows what day it is.
 *
 * ⚠⚠ MEASURED, 13 Sep 2026. Asked "what have I got done today", SAiM answered
 * *"…but it's Saturday, so that's fine"* — on a SUNDAY. Nothing anywhere in the
 * chat prompt carried the date, the day or the time, so the single fact that
 * every answer about "today", "this week", "tomorrow" or the diary rests on was
 * being guessed. A wrong day makes a correct answer wrong.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _internals } = require('./claude');
const { rightNowBlock } = _internals;

test('it names the day, the date and the time', () => {
  const block = rightNowBlock(new Date('2026-09-13T12:26:00Z'));
  assert.match(block, /Sunday/);
  assert.match(block, /13 September 2026/);
  assert.match(block, /RIGHT NOW/);
});

test('⚠ it tells her NOT to guess', () => {
  assert.match(rightNowBlock(new Date()), /Never guess the day/);
});

test('⚠ LOCAL time, never UTC getters', () => {
  // The Pi may run UTC. Building a date string out of UTC getters is how every
  // BST event read an hour early, in three separate places in this repo.
  // 23:30 UTC on the 13th is 00:30 on the 14th in London.
  const block = rightNowBlock(new Date('2026-06-13T23:30:00Z'));
  assert.match(block, /14 June 2026/, 'the London date, not the UTC one');
  assert.match(block, /Sunday/);
});

test('⚠ a working day is working-days\' call, including bank holidays', () => {
  // Not Monday-to-Friday. A second opinion here is how one part of the system
  // comes to disagree with the thing that books meetings.
  const weekend = rightNowBlock(new Date('2026-09-13T12:00:00Z'));
  assert.match(weekend, /NOT a working day/);
  const tuesday = rightNowBlock(new Date('2026-09-15T12:00:00Z'));
  assert.match(tuesday, /It is a working day/);
});

test('⚠ it never throws, whatever the clock or the zone', () => {
  const before = process.env.NEURO_TIMEZONE;
  try {
    process.env.NEURO_TIMEZONE = 'Not/AZone';
    assert.match(rightNowBlock(new Date()), /RIGHT NOW/, 'a bad zone must not cost the prompt');
  } finally {
    if (before === undefined) delete process.env.NEURO_TIMEZONE;
    else process.env.NEURO_TIMEZONE = before;
  }
});
