'use strict';

// An all-day entry must never switch the corridor on (bedroom screen, 3 Oct
// 2026: at 08:58 a Saturday "hiking" placed at a pretend 09:00 stacked every
// card over her headline, and stood down at 09:00).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ui = path.join(__dirname, '..', '..', 'saim', 'shared-ui');
const approach = fs.readFileSync(path.join(ui, 'Approach.jsx'), 'utf8');
const surface = fs.readFileSync(path.join(ui, 'AttentionSurface.jsx'), 'utf8');

test('positive control: the corridor still decides on a future hour', () => {
  assert.ok(approach.includes('const hasFuture = placed.some('));
});

test('an all-day card carries the flag and is placed without an hour', () => {
  assert.ok(surface.includes('allDay: isAllDay,'), 'the card must say it is all day');
  assert.ok(approach.includes('const at = card.allDay ? null : minutesOf(card.at);'));
});
