'use strict';

/**
 * Build 15S–X — the "hike weekly" loop.
 *
 * Fixtures are the LIVE shapes measured on 6 Oct 2026: a repeating all-day
 * "hiking" Saturday in the personal calendar (arriving as 23:00 the previous
 * day as well as 00:00), ONE Hiking workout in 90 days (6 Aug), and ordinary
 * step counts on the planned Saturdays.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-hike-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'h.db');
process.env.NEURO_TIMEZONE = 'Europe/London';

const db = require('../db/database');
const loop = require('./hiking-loop');
const tl = require('./activity-timeline');

test.before(async () => { await db.init(); });

const NOW = Date.parse('2026-10-06T09:00:00Z'); // Tuesday
const GOAL = 'goal:hike';
function goal(title = 'Hike weekly', status = 'active') {
  db.run('DELETE FROM goals');
  db.run(`INSERT INTO goals (goal_id, title, domains_json, status, created_at, updated_at) VALUES (?, ?, '["health"]', ?, 'x', 'x')`, [GOAL, title, status]);
}
function plan(day, cache = false) {
  const table = cache ? 'calendar_cache' : 'calendar_history';
  const extra = cache ? '' : ', first_seen';
  const vals = cache ? '' : ", 'x'";
  db.run(`INSERT INTO ${table} (event_id, subject, start_time, end_time, is_all_day, source${extra}) VALUES (?, 'hiking', ?, ?, 1, 'apple'${vals})`, [`h-${day}-${cache}`, `${day}T00:00:00`, `${day}T23:59:00`]);
}
function steps(day, n) { db.run('INSERT OR REPLACE INTO health_daily (day, steps, complete, computed_at) VALUES (?, ?, 1, ?)', [day, n, 'x']); }
function workout(day, type, mins) {
  db.run('INSERT INTO health_workouts (source_uuid, activity_type, started_at, duration_seconds) VALUES (?, ?, ?, ?)', [`w-${day}-${type}`, type, `${day} 10:00:00`, mins * 60]);
}

test.before(() => {
  goal();
  workout('2026-08-06', 'Hiking', 292);
  // The repeating Saturday: history for past days (with the 23:00 duplicate), cache for this week's.
  for (const d of ['2026-09-26', '2026-10-03']) plan(d);
  db.run(`INSERT INTO calendar_history (event_id, subject, start_time, end_time, is_all_day, source, first_seen) VALUES ('h-dup', 'hiking', '2026-10-02T23:00:00', '2026-10-03T23:00:00', 1, 'apple', 'x')`);
  plan('2026-10-10', true);
  for (const [d, n] of [['2026-09-28', 7081], ['2026-09-29', 4723], ['2026-09-30', 10300], ['2026-10-01', 8498], ['2026-10-02', 10084], ['2026-10-03', 4624], ['2026-10-04', 7497], ['2026-10-05', 5342]]) steps(d, n);
});

const FORBIDDEN = /\b(missed|failed|fail|should|behind|streak|lazy|guilt|disappoint|again\?|haven't|didn't hike|you need to)\b/i;

test('30/31. an explicit active weekly hiking goal is required — no goal, no loop', () => {
  assert.equal(loop.findGoal([{ title: 'Hike weekly', status: 'active' }]).title, 'Hike weekly');
  assert.equal(loop.findGoal([{ title: 'Hike more', status: 'active' }]), null, 'no cadence, no weekly loop');
  assert.equal(loop.findGoal([{ title: 'Hike weekly', status: 'paused' }]), null);
  assert.equal(loop.findGoal([{ title: 'Read weekly', status: 'active' }]), null);
  goal('Hike weekly', 'paused');
  assert.equal(loop.read({ now: NOW }).active, false);
  assert.equal(loop.refresh({ now: NOW }).written, 0);
  assert.equal(loop.addEntry('confirm', { day: '2026-10-04', now: NOW }).status, 409);
  goal();
  assert.equal(loop.read({ now: NOW }).active, true, 'positive control');
});

test('35. the planned hike is represented — this Saturday, from the calendar, one plan however it arrived', () => {
  const r = loop.read({ now: NOW });
  assert.equal(r.weekStart, '2026-10-05');
  assert.deepEqual(r.current.planned.map((p) => p.day), ['2026-10-10']);
  assert.equal(r.current.line, 'Saturday hike planned.');
  const last = r.weeks[1];
  assert.deepEqual(last.planned.map((p) => p.day), ['2026-10-03'], 'the 23:00 duplicate folds into Saturday');
});

test('32. a missing workout is NOT a missed hike — with recording unreliable it says it cannot tell', () => {
  const r = loop.read({ now: NOW });
  assert.equal(r.reliability.level, 'unreliable');
  assert.equal(r.reliability.recorded90, 1);
  assert.match(r.reliability.why, /a missing workout says nothing/);
  const last = r.weeks[1];
  assert.equal(last.result, 'cant-tell');
  assert.equal(last.recording, 'no-evidence');
  assert.match(last.line, /I can't tell whether Saturday's hike happened/);
  assert.equal(last.needsNick.kind, 'confirm');
});

test('33. a recorded Hiking workout confirms the week', () => {
  const s = loop.weekState({ start: '2026-09-28', today: '2026-10-06', plans: [{ day: '2026-10-03', source: 'calendar' }],
    workouts: [{ day: '2026-10-03', type: 'Hiking', mins: 240 }], confirms: [], steps: {}, rel: { level: 'unreliable' } });
  assert.equal(s.recording, 'confirmed');
  assert.equal(s.result, 'done');
  assert.equal(s.line, 'Weekly hike done — Saturday.');
});

test('36. a recording gap is reported as one — health data that never arrived', () => {
  const s = loop.weekState({ start: '2026-09-28', today: '2026-10-06', plans: [{ day: '2026-10-03', source: 'calendar' }],
    workouts: [], confirms: [], steps: { '2026-10-03': null }, rel: { level: 'ok' } });
  assert.equal(s.recording, 'recording-gap');
  assert.match(s.line, /didn't arrive for Saturday, so I can't tell/);
  assert.equal(s.result, 'cant-tell');
  // Likely-but-unconfirmed: a big step day is a question, not a fact.
  const l = loop.weekState({ start: '2026-09-28', today: '2026-10-06', plans: [], workouts: [], confirms: [], steps: { '2026-10-04': 21000 }, rel: { level: 'ok' } });
  assert.equal(l.recording, 'likely');
  assert.match(l.line, /was that a hike\?/);
  assert.notEqual(l.result, 'done');
});

test('34. Nick confirming a hike works, and is recorded as HIS statement', () => {
  const r = loop.addEntry('confirm', { day: '2026-10-03', note: 'Kinder Scout', now: NOW });
  assert.equal(r.ok, true);
  assert.equal(loop.addEntry('confirm', { day: '2026-10-03', now: NOW }).already, true, 'confirming twice is one statement');
  assert.equal(loop.addEntry('confirm', { day: '2026-10-09', now: NOW }).status, 400, 'not in the future');
  assert.equal(loop.addEntry('confirm', { day: 'Saturday', now: NOW }).status, 400);
  const last = loop.read({ now: NOW }).weeks[1];
  assert.equal(last.recording, 'confirmed');
  assert.equal(last.confirmed[0].by, 'you');
  assert.equal(last.line, 'Weekly hike done — Saturday (you confirmed it).');
  loop.refresh({ now: NOW });
  const done = loop.events().find((e) => e.kind === 'achieved');
  assert.equal(done.actor, 'nick');
});

test('38/39. one week, one semantic result — a re-run writes nothing; Activity shows transitions, not samples', () => {
  const first = loop.refresh({ now: NOW });
  assert.equal(first.written, 0, 'everything was already recorded by the confirm');
  steps('2026-10-05', 5400); // a new sample arrives
  assert.equal(loop.refresh({ now: NOW + 3600000 }).written, 0, 'a sensor sample is not activity');
  const kinds = loop.events().map((e) => e.kind);
  assert.equal(kinds.filter((k) => k === 'achieved').length, 1);
  assert.ok(kinds.includes('planned'));
  const { entries } = tl.collect({ fromIso: '2026-10-01T00:00:00Z', toIso: '2026-10-08T00:00:00Z' });
  const mine = entries.filter((e) => e.type.startsWith('goal.hike'));
  assert.ok(mine.length >= 2);
  assert.ok(mine.every((e) => ['goal.hike.planned', 'goal.hike.done', 'goal.hike.withdrawn', 'goal.hike.likely', 'goal.hike.uncertain', 'goal.hike.reminder'].includes(e.type)));
  assert.ok(mine.some((e) => e.type === 'goal.hike.done' && e.actor === 'nick'));
});

test('37. no guilt, no nagging — every line the loop can say, across every state', () => {
  const lines = [];
  const rels = [{ level: 'ok' }, { level: 'unreliable' }];
  for (const today of ['2026-10-06', '2026-10-09', '2026-10-11', '2026-10-13']) {
    for (const rel of rels) {
      for (const plans of [[], [{ day: '2026-10-10', source: 'calendar' }], [{ day: '2026-10-07', source: 'manual' }]]) {
        for (const stepsMap of [{}, { '2026-10-07': null }, { '2026-10-07': 20000 }]) {
          lines.push(loop.weekState({ start: '2026-10-05', today, plans, workouts: [], confirms: [], steps: stepsMap, rel }).line);
        }
      }
    }
  }
  lines.push(loop.reliability({ recorded90: 0, plannedPast: ['a', 'b'], recordedOnPlanned: 0 }).why);
  for (const l of lines) assert.ok(!FORBIDDEN.test(l), `guilt/nag wording: "${l}"`);
  // A late-week week with nothing planned PREPARES a prompt (a line on the loop's own screen), it does not push.
  const quietWeek = { '2026-10-05': 5000, '2026-10-06': 6000, '2026-10-07': 7000, '2026-10-08': 6500 };
  const late = loop.weekState({ start: '2026-10-05', today: '2026-10-09', plans: [], workouts: [], confirms: [], steps: quietWeek, rel: { level: 'ok' } });
  assert.equal(late.needsNick.kind, 'plan');
  assert.equal(late.line, 'No hike planned yet this week.');
});
