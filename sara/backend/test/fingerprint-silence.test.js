// ⚠ Measured 14 Sep 2026, with Nick at his desk twenty miles from the house: every
// house sensor reported `absent` with no RSSI at all, and the fingerprint answered
// `study / sure`. SARA told him he was in the study all afternoon, and the study
// screen behaved accordingly.
//
// A vector of silence still scores against every profile through the RATE term, so
// one room always wins. An RSSI is the only evidence the watch is within earshot —
// without one there is nothing to identify, and out of the house must read unknown.
//
//   run: npm test   (from sara/backend)

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classify, buildProfile } = require('../src/presence/fingerprint');

// Two rooms taught from plausible readings, so the profiles are real.
function profiles() {
  const samples = (room, near, far) => Array.from({ length: 12 }, (_, i) => ({
    study: { rssi: room === 'study' ? near + (i % 3) : far - (i % 3), rate: room === 'study' ? 2 : 0.4 },
    kitchen: { rssi: room === 'kitchen' ? near + (i % 3) : far - (i % 3), rate: room === 'kitchen' ? 2 : 0.4 },
  }));
  return {
    study: buildProfile('study', samples('study', -45, -80)),
    kitchen: buildProfile('kitchen', samples('kitchen', -45, -80)),
  };
}

test('a real reading still identifies a room', () => {
  const r = classify({ study: { rssi: -46, rate: 2 }, kitchen: { rssi: -79, rate: 0.4 } }, profiles());
  assert.equal(r.room, 'study');
  assert.equal(r.confidence, 'sure');
});

test('silence from every sensor is NOT a room', () => {
  // What the house actually reported with him at work: heard by nobody.
  const r = classify({ study: { rssi: null, rate: 0 }, kitchen: { rssi: null, rate: 0 } }, profiles());
  assert.equal(r.room, null);
  assert.equal(r.confidence, 'none');
  assert.match(r.why, /hear/);
  assert.deepEqual(r.scores, [], 'nothing was scored, so nothing can be least-bad');
});

test('one sensor hearing him is enough to be SCORED', () => {
  // It may still match nothing — a faint reading legitimately does — but the
  // refusal must then be "nothing matches", not "nobody can hear him".
  const r = classify({ study: { rssi: -70, rate: 1 }, kitchen: { rssi: null, rate: 0 } }, profiles());
  assert.ok(r.scores.length > 0, 'a heard reading must reach the scoring');
  assert.doesNotMatch(String(r.why || ''), /hear/);
});

test('an empty reading is still unknown, with its own reason', () => {
  assert.equal(classify({}, profiles()).confidence, 'none');
});
