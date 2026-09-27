'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bc = require('./bedroom-climate');
const pi = require('./performance-insights');

test('HA statistics become hours; anything that is not a bedroom is refused', () => {
  const rows = bc.shapeStats([
    { start: 1790521200000, mean: 19.86, min: 19.8, max: 19.9 },   // real row, 27 Sep 2026
    { start: 1790524800000, mean: 67.8, min: 67, max: 68 },        // a Fahrenheit reading
    { start: 1790528400000, mean: null },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hourStart, 1790521200);
});

test('each hourly mean stands mid-hour, and a night of them is a night', () => {
  const t0 = Date.parse('2026-09-20T22:00:00Z') / 1000;   // 23:00 BST
  const hours = Array.from({ length: 8 }, (_, i) => ({ hour_start: t0 + i * 3600, mean: 18 + i * 0.1 }));
  const room = pi.overnightRoom(bc.asReadings(hours));
  assert.deepEqual([...room.keys()], ['2026-09-21']);
  assert.equal(room.get('2026-09-21').readings, 8);
});
