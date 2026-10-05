'use strict';
// A break is not something that needs Nick (5 Oct 2026): SAiM led with
// "Needs you — Take a break, in 8 minutes". Free time and solo breaks are out;
// a lunch with someone is still a meeting.
const { test } = require('node:test');
const assert = require('node:assert');
const { isNotForAttention } = require('./decision-engine');

test('free diary time and solo breaks never need Nick', () => {
  assert.equal(isNotForAttention({ subject: 'Take a break', show_as: 'free', attendees_other: 0 }), true);
  assert.equal(isNotForAttention({ subject: 'Lunch', show_as: 'busy', attendees_other: 0 }), true);
  assert.equal(isNotForAttention({ subject: 'Coffee', show_as: 'busy', attendees_other: null }), true);
  assert.equal(isNotForAttention({ subject: 'Anything at all', show_as: 'free', attendees_other: 1 }), true);
});

test('real meetings and work blocks still count', () => {
  assert.equal(isNotForAttention({ subject: 'Lunch with Chris', show_as: 'busy', attendees_other: 1 }), false);
  assert.equal(isNotForAttention({ subject: 'Risk Meeting Prep', show_as: 'busy', attendees_other: 0 }), false);
  assert.equal(isNotForAttention({ subject: 'Breakdown review', show_as: 'busy', attendees_other: 0 }), false, 'whole words only');
});
