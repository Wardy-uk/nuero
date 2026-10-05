'use strict';
// T-shirt sizes (5 Oct 2026): a size is a band of the estimate, and an XL
// blocks one full day and says so rather than finding no slot.
const { test } = require('node:test');
const assert = require('node:assert');
const { SIZES, sizeOf, minutesFor } = require('../../shared/task-size.cjs');
const { normEstimate } = require('./task-store');
const blocks = require('./task-blocks');

test('bands: XS ≤30, S ≤60, M ≤240, L ≤480, XL above', () => {
  assert.deepEqual([15, 30, 31, 60, 61, 240, 241, 480, 481, 2000].map(sizeOf), ['XS', 'XS', 'S', 'S', 'M', 'M', 'L', 'L', 'XL', 'XL']);
  assert.equal(sizeOf(null), null);
  assert.equal(sizeOf(0), null);
});

test('a size sets an estimate that reads back as the same size, and survives as an exact estimate', () => {
  for (const s of SIZES) {
    const m = normEstimate(minutesFor(s.id), { exact: true });
    assert.equal(m, s.minutes, s.id);
    assert.equal(sizeOf(m), s.id, s.id);
  }
  assert.equal(minutesFor('nope'), null);
});

test('an XL is capped to one working-day window with a note; an L is not', () => {
  const xl = blocks.resolveWindow;
  const w = xl([{ estimate_minutes: 960 }]);
  assert.equal(w.minutes, 480);
  assert.equal(w.capped, true);
  assert.match(w.note, /more than a day/);
  const l = xl([{ estimate_minutes: 480 }]);
  assert.equal(l.minutes, 480);
  assert.equal(l.capped, undefined);
});
