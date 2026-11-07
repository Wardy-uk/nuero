'use strict';

/**
 * Blood pressure against sleep and meeting load (7 Nov 2026).
 * Pinned: a moved meeting counts once at its newest slot; solo, all-day,
 * cancelled and unknown-attendee entries are not meetings; a link is a finding
 * only below the Bonferroni threshold; too few days is "unknown", never a link.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { meetingHoursByDay, bpContext, BP_MIN_DAYS } = require('./performance-insights');

const ev = (id, start, end, extra = {}) => ({ event_id: id, start_time: start, end_time: end, subject: 'Sync', is_all_day: 0, attendees_other: 1, first_seen: '2026-10-01T00:00:00Z', ...extra });

test('a moved meeting counts once, at its newest slot', () => {
  const h = meetingHoursByDay([
    ev('a', '2026-10-06T10:00:00', '2026-10-06T11:00:00', { first_seen: '2026-10-01T00:00:00Z' }),
    ev('a', '2026-10-07T14:00:00', '2026-10-07T15:30:00', { first_seen: '2026-10-05T00:00:00Z' }),
  ]);
  assert.equal(h.get('2026-10-06'), undefined);
  assert.equal(h.get('2026-10-07'), 1.5);
});

test('solo, all-day, cancelled and unknown-attendee entries are not meetings', () => {
  const h = meetingHoursByDay([
    ev('solo', '2026-10-06T09:00:00', '2026-10-06T10:00:00', { attendees_other: 0 }),
    ev('unk', '2026-10-06T10:00:00', '2026-10-06T11:00:00', { attendees_other: null }),
    ev('all', '2026-10-06T00:00:00', '2026-10-07T00:00:00', { is_all_day: 1 }),
    ev('can', '2026-10-06T12:00:00', '2026-10-06T13:00:00', { subject: 'Canceled: Weekly' }),
    ev('real', '2026-10-06T14:00:00', '2026-10-06T14:30:00'),
  ]);
  assert.equal(h.get('2026-10-06'), 0.5);
});

// A deterministic spread with no relationship, and one with a strong one.
function days(n, bpFor) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const sleep = 6 + ((i * 7) % 30) / 10;              // 6.0–8.9h, shuffled order
    out.push({ day: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}-${i}`, asleepHours: sleep, bpSystolic: bpFor(sleep, i), bpDiastolic: 85 + (i % 5) });
  }
  return out;
}

test('too few days is unknown, never a finding', () => {
  const r = bpContext(days(BP_MIN_DAYS - 1, () => 140));
  assert.ok(r.results.every((x) => !x.known));
  assert.equal(r.findings.length, 0);
  assert.match(r.sentence, /Not enough days/);
});

test('a strong relationship is a finding, worded in mmHg with the direction', () => {
  const r = bpContext(days(40, (sleep) => 170 - sleep * 4 + 0.01));
  const f = r.findings.find((x) => x.driver === 'sleep' && x.outcome === 'bpSystolic');
  assert.ok(f, 'sleep → systolic should be significant');
  assert.match(r.sentence, /Systolic ran \d+ mmHg lower after longer nights/);
});

test('no relationship → "no clear link", and significance uses the corrected threshold', () => {
  const r = bpContext(days(40, (sleep, i) => 140 + ((i * 13) % 9)));
  assert.equal(r.findings.filter((x) => x.driver === 'sleep').length, 0);
  assert.match(r.sentence, /No clear link/);
  const tested = r.results.filter((x) => x.known).length;
  assert.equal(r.threshold, Math.round((0.05 / tested) * 10000) / 10000);
});

test('meetings are only tested on the days given (working days with meetings)', () => {
  const d = days(40, () => 140);
  const m = new Map(d.slice(0, 10).map((x) => [x.day, 2]));
  const r = bpContext(d, m);
  const mt = r.results.find((x) => x.driver === 'meetings' && x.outcome === 'bpSystolic');
  assert.equal(mt.known, false);
  assert.equal(mt.days, 10);
});
