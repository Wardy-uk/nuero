'use strict';

/**
 * The "hike weekly" loop — Build 15S–X, with the confirmation rule REPLACED in
 * Build 17A (7 Oct 2026): a hike is confirmed by a GPS track received within
 * 24h, or by Nick. Steps, distance and duration never confirm.
 *
 * Fixtures are LIVE shapes: a repeating all-day "hiking" Saturday (arriving as
 * 23:00 the previous day as well as 00:00), the 6 Aug Hiking workout with no
 * route, location fixes from 6 Sep, and 19 Sep — 18,122 steps, 8.3 km, 41
 * background location fixes, no GPS track, not a hike.
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

const NOW = Date.parse('2026-10-07T09:00:00Z'); // Wednesday 10:00 BST
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
function fixes(day, n) { // background location fixes, noon onwards (UTC)
  const base = Date.parse(`${day}T11:00:00Z`) / 1000;
  for (let i = 0; i < n; i += 1) db.run('INSERT OR IGNORE INTO location_points (device_id, lat, lng, tst, accuracy) VALUES (?, 53, -1.5, ?, 5)', ['ios-1', base + i * 300]);
}

// Pure-week helpers — a workout with or without a route, as the reader shapes it.
function wk(day, type, mins, { route = null, startUtc = '10:00', receivedHoursAfterEnd = 1 } = {}) {
  const startMs = Date.parse(`${day}T${startUtc}:00Z`);
  const endMs = startMs + mins * 60000;
  const track = route == null ? null : { pointCount: route, firstMs: startMs + 60000, lastMs: endMs - 60000, receivedMs: endMs + receivedHoursAfterEnd * 3600000 };
  return { day, type, mins, startMs, endMs, endLocal: new Date(endMs + 3600000).toISOString().slice(0, 16), track };
}
const OK = { working: true };
const allWorking = (days) => Object.fromEntries(days.map((d) => [d, OK]));
const SEP = loop.weekDays('2026-09-14');            // 19 Sep is the Saturday
const AFTER = '2026-10-07T10:00';                    // long after 19 Sep

test.before(() => {
  goal();
  db.run(`INSERT INTO health_workouts (source_uuid, activity_type, started_at, ended_at, duration_seconds, created_at) VALUES ('w-aug', 'Hiking', '2026-08-06 10:25:18', '2026-08-06 15:17:01', 17502, '2026-08-06 16:00:00')`);
  for (const d of ['2026-09-19', '2026-09-26', '2026-10-03']) plan(d);
  db.run(`INSERT INTO calendar_history (event_id, subject, start_time, end_time, is_all_day, source, first_seen) VALUES ('h-dup', 'hiking', '2026-10-02T23:00:00', '2026-10-03T23:00:00', 1, 'apple', 'x')`);
  plan('2026-10-10', true);
  steps('2026-09-19', 18122);
  db.run(`INSERT INTO health_samples (metric, value, recorded_at) VALUES ('walking_running_distance', 8.3, '2026-09-19 12:00:00')`);
  for (let d = 6; d <= 30; d += 1) fixes(`2026-09-${String(d).padStart(2, '0')}`, d === 19 ? 41 : 3);
  for (let d = 1; d <= 7; d += 1) fixes(`2026-10-0${d}`, 3);
});

const FORBIDDEN = /\b(missed|failed|fail|should|behind|streak|lazy|guilt|disappoint|again\?|haven't|didn't hike|you need to|likely|probably)\b/i;

test('the loop needs an explicit active weekly hiking goal — no goal, no loop', () => {
  assert.equal(loop.findGoal([{ title: 'Hike weekly', status: 'active' }]).title, 'Hike weekly');
  assert.equal(loop.findGoal([{ title: 'Hike more', status: 'active' }]), null);
  goal('Hike weekly', 'paused');
  assert.equal(loop.read({ now: NOW }).active, false);
  assert.equal(loop.addEntry('confirm', { day: '2026-10-04', now: NOW }).status, 409);
  goal();
  assert.equal(loop.read({ now: NOW }).active, true, 'positive control');
});

test('1. a GPS track received within 24h confirms the hike', () => {
  const s = loop.weekState({ start: SEP[0], today: '2026-10-07', nowLocal: AFTER, workouts: [wk('2026-09-19', 'Hiking', 240, { route: 900 })], location: allWorking(SEP) });
  assert.equal(s.recording, 'confirmed');
  assert.equal(s.confirmed[0].by, 'gps-track');
  assert.equal(s.line, 'Hike confirmed — Saturday (GPS track).');
});

test('17B. what is NOT a track: too few fixes, a late arrival, a short walk, a run, no route at all', () => {
  const base = { type: 'Hiking', mins: 200 };
  assert.equal(loop.trackVerdict(wk('2026-09-19', 'Hiking', 200, { route: 1 })).valid, false, 'one fix');
  assert.equal(loop.trackVerdict(wk('2026-09-19', 'Hiking', 200, { route: 9 })).valid, false, 'below the floor');
  assert.equal(loop.trackVerdict(wk('2026-09-19', 'Hiking', 200, { route: 10 })).valid, true, 'positive control at the floor');
  const late = loop.trackVerdict(wk('2026-09-19', 'Hiking', 200, { route: 500, receivedHoursAfterEnd: 25 }));
  assert.equal(late.valid, false); assert.equal(late.late, true);
  assert.equal(loop.trackVerdict(wk('2026-09-19', 'Hiking', 200, { route: 500, receivedHoursAfterEnd: 23 })).valid, true);
  assert.equal(loop.trackVerdict(wk('2026-09-19', 'Walking', 40, { route: 500 })).valid, false, 'a 40-minute walk is not a hike');
  assert.equal(loop.trackVerdict(wk('2026-09-19', 'Walking', 90, { route: 500 })).valid, true);
  assert.equal(loop.trackVerdict(wk('2026-09-19', 'Running', 90, { route: 500 })).valid, false);
  assert.equal(loop.trackVerdict({ ...base }).valid, false, 'no route recorded');
  const outside = wk('2026-09-19', 'Hiking', 200, { route: 500 });
  outside.track.lastMs = outside.endMs + 3 * 3600000;
  assert.equal(loop.trackVerdict(outside).valid, false, 'timestamped outside the workout');
});

test('2. Nick confirming a hike confirms it — and is recorded as HIS statement', () => {
  const r = loop.addEntry('confirm', { day: '2026-10-03', note: 'Kinder Scout', now: NOW });
  assert.equal(r.ok, true);
  assert.equal(loop.addEntry('confirm', { day: '2026-10-03', now: NOW }).already, true);
  assert.equal(loop.addEntry('confirm', { day: '2026-10-09', now: NOW }).status, 400, 'not in the future');
  const wk3 = loop.read({ now: NOW }).weeks.find((w) => w.start === '2026-09-28');
  assert.equal(wk3.recording, 'confirmed');
  assert.equal(wk3.confirmed[0].by, 'you');
  assert.equal(wk3.line, 'Hike confirmed — Saturday (you confirmed it).');
  assert.ok(loop.events().some((e) => e.kind === 'achieved' && e.actor === 'nick'));
});

test('3/4/5. steps alone, distance alone and a long walk alone never confirm', () => {
  const big = loop.weekState({ start: SEP[0], today: '2026-10-07', nowLocal: AFTER, steps: { '2026-09-19': 30000 }, distance: { '2026-09-19': 25 }, location: allWorking(SEP) });
  assert.notEqual(big.recording, 'confirmed');
  assert.equal(big.recording, 'not_hike');
  const walk = loop.weekState({ start: SEP[0], today: '2026-10-07', nowLocal: AFTER, workouts: [wk('2026-09-19', 'Walking', 300)], location: allWorking(SEP) });
  assert.equal(walk.recording, 'not_hike', 'a five-hour walk with no track is not a hike');
  const hikeNoRoute = loop.weekState({ start: SEP[0], today: '2026-10-07', nowLocal: AFTER, workouts: [wk('2026-09-19', 'Hiking', 300)], location: allWorking(SEP) });
  assert.notEqual(hikeNoRoute.recording, 'confirmed', 'a Hiking workout without its route confirms nothing either');
});

test('6. no GPS track after 24h + location working ⇒ not_hike', () => {
  const v = loop.judgeDay('2026-09-19', { nowLocal: AFTER, location: { '2026-09-19': OK } });
  assert.equal(v.state, 'not_hike');
});

test('7. no GPS track after 24h + location NOT working ⇒ recording_gap', () => {
  const v = loop.judgeDay('2026-09-19', { nowLocal: AFTER, location: { '2026-09-19': { working: false, why: 'the phone had stopped sending location' } } });
  assert.equal(v.state, 'recording_gap');
  assert.equal(loop.judgeDay('2026-09-19', { nowLocal: AFTER, location: {} }).state, 'recording_gap', 'unknown location is not "working"');
  // A Hiking workout whose route never came is a recording gap — the GPS half failed.
  assert.equal(loop.judgeDay('2026-09-19', { nowLocal: AFTER, workouts: [wk('2026-09-19', 'Hiking', 200)], location: { '2026-09-19': OK } }).state, 'recording_gap');
  const s = loop.weekState({ start: SEP[0], today: '2026-10-07', nowLocal: AFTER, plans: [{ day: '2026-09-19', source: 'calendar' }], location: {} });
  assert.equal(s.recording, 'recording_gap');
  assert.equal(s.line, "I can't tell — location recording was unavailable.");
});

test('8. inside the 24h window the answer is unknown — and only then', () => {
  const sat = '2026-10-03';
  const during = loop.judgeDay(sat, { nowLocal: '2026-10-04T18:00', location: { [sat]: OK } });
  assert.equal(during.state, 'unknown');
  assert.equal(during.closesAt, '2026-10-05T00:00');
  assert.equal(loop.judgeDay(sat, { nowLocal: '2026-10-05T00:01', location: { [sat]: OK } }).state, 'not_hike', 'closed one minute later');
  // A workout ending late extends the window from ITS end.
  const late = wk(sat, 'Walking', 300, { startUtc: '19:00' });
  assert.ok(loop.windowClosesAt(sat, [late]) > '2026-10-05T00:00');
  const s = loop.weekState({ start: '2026-09-28', today: '2026-10-04', nowLocal: '2026-10-04T18:00', steps: { [sat]: 20000 }, location: { [sat]: OK } });
  assert.equal(s.recording, 'unknown');
  assert.match(s.line, /^Was Saturday a hike\? A GPS track or your word settles it by Monday 00:00\.$/);
  assert.equal(s.needsNick.kind, 'confirm');
});

test('9. Nick can reverse it both ways — "not a hike" beats a track; taking it back restores the track', () => {
  const now = Date.parse('2026-10-07T09:00:00Z');
  const d = loop.addEntry('deny', { day: '2026-10-03', now });
  assert.equal(d.ok, true, JSON.stringify(d));
  const after = loop.read({ now }).weeks.find((w) => w.start === '2026-09-28');
  assert.equal(after.recording, 'not_hike', 'the denial withdrew his earlier confirmation and rules it out');
  assert.equal(loop.entries(GOAL).filter((e) => e.kind === 'confirm' && e.day === '2026-10-03').length, 0);
  const pure = loop.weekState({ start: SEP[0], today: '2026-10-07', nowLocal: AFTER, workouts: [wk('2026-09-19', 'Hiking', 240, { route: 900 })], denials: [{ day: '2026-09-19', id: 1 }], location: allWorking(SEP) });
  assert.equal(pure.recording, 'not_hike', 'his word beats a GPS track');
  assert.equal(loop.withdrawDenial(d.id, { now }).ok, true);
  const restored = loop.read({ now }).weeks.find((w) => w.start === '2026-09-28');
  assert.notEqual(restored.recording, 'confirmed', 'his confirmation stays taken back');
  assert.equal(loop.addEntry('confirm', { day: '2026-10-03', now }).ok, true);
  assert.equal(loop.read({ now }).weeks.find((w) => w.start === '2026-09-28').recording, 'confirmed', 'and confirming again works');
});

test('10. 19 Sep — 18,122 steps, 8.3 km, 41 background fixes, no track — is NOT a hike, and is no longer "likely"', () => {
  const w = loop.read({ now: NOW, weeks: 4 }).weeks.find((x) => x.start === '2026-09-14');
  const sat = w.days.find((v) => v.day === '2026-09-19');
  assert.equal(sat.state, 'not_hike');
  assert.equal(w.recording, 'not_hike');
  assert.equal(w.line, 'No hike recorded this week.');
  const ev = w.evidence.find((e) => e.day === '2026-09-19');
  assert.equal(ev.steps, 18122, 'the evidence is still shown — it just confirms nothing');
  assert.equal(ev.location, true);
  // 6 Aug: a Hiking workout before location recording existed, with no route.
  const aug = loop.read({ now: NOW, weeks: 10 }).weeks.find((x) => x.start === '2026-08-03');
  assert.equal(aug.recording, 'recording_gap');
  assert.match(aug.line, /came without its GPS route/);
});

test('11. no guilt, no "likely" after the window — every line the loop can say', () => {
  const lines = [];
  const loc = allWorking(loop.weekDays('2026-10-05'));
  for (const [today, nowLocal] of [['2026-10-06', '2026-10-06T09:00'], ['2026-10-09', '2026-10-09T20:00'], ['2026-10-11', '2026-10-11T12:00'], ['2026-10-13', '2026-10-13T09:00']]) {
    for (const plans of [[], [{ day: '2026-10-10', source: 'calendar' }], [{ day: '2026-10-07', source: 'manual' }]]) {
      for (const st of [{}, { '2026-10-07': 20000 }]) {
        for (const location of [loc, {}]) {
          for (const workouts of [[], [wk('2026-10-07', 'Hiking', 200)], [wk('2026-10-07', 'Hiking', 200, { route: 300 })]]) {
            lines.push(loop.weekState({ start: '2026-10-05', today, nowLocal, plans, steps: st, location, workouts }).line);
          }
        }
      }
    }
  }
  lines.push(loop.reliability({ recorded90: 0, plannedPast: ['a', 'b'], recordedOnPlanned: 0 }).why);
  for (const l of lines) assert.ok(!FORBIDDEN.test(l), `forbidden wording: "${l}"`);
  for (const l of lines) assert.ok(!/likely|probably/i.test(l), l);
  const late = loop.weekState({ start: '2026-10-05', today: '2026-10-09', nowLocal: '2026-10-09T12:00', location: loc });
  assert.equal(late.needsNick.kind, 'plan');
  assert.equal(late.line, 'No hike planned yet this week.');
  assert.equal(loop.weekState({ start: '2026-10-05', today: '2026-10-07', nowLocal: '2026-10-07T10:00', plans: [{ day: '2026-10-10', source: 'calendar' }], location: loc }).line, 'Saturday hike planned.');
  // The plan for TODAY is still a plan, not a question.
  assert.equal(loop.weekState({ start: '2026-10-05', today: '2026-10-10', nowLocal: '2026-10-10T08:00', plans: [{ day: '2026-10-10', source: 'calendar' }], location: loc }).recording, 'planned');
});

test('12. Activity records ONE semantic resolution per day — a re-run and new samples write nothing', () => {
  const at = NOW + 3600000;
  loop.refresh({ now: at, weeks: 10 });
  assert.equal(loop.refresh({ now: at, weeks: 10 }).written, 0, 'a rerun writes nothing');
  steps('2026-10-05', 5400);
  fixes('2026-10-05', 2);
  assert.equal(loop.refresh({ now: at + 3600000, weeks: 10 }).written, 0, 'a sensor sample is not activity');
  const resolved = loop.events().filter((e) => e.kind === 'resolved' && e.detail.day === '2026-09-19');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].detail.state, 'not_hike');
  const { entries } = tl.collect({ fromIso: '2026-10-07T00:00:00Z', toIso: '2026-10-08T00:00:00Z' });
  const mine = entries.filter((e) => e.type.startsWith('goal.hike'));
  assert.ok(mine.some((e) => e.type === 'goal.hike.resolved' && /Saturday: no hike recorded/.test(e.headline)));
  assert.ok(mine.some((e) => e.type === 'goal.hike.uncertain' && /can't tell/.test(e.headline)), 'the 6 Aug gap is one line');
  assert.ok(!mine.some((e) => /likely|might have been/i.test(`${e.headline} ${e.summary || ''}`)));
});

test('location recording is judged per day — before the first fix it did not exist; a blindness episode suspends it', () => {
  const days = ['2026-09-04', '2026-09-06', '2026-09-07', '2026-09-08'];
  const r = loop.locationByDay(days, { pointDays: new Set(['2026-09-06', '2026-09-08']), firstDay: '2026-09-06', episodes: [{ fromDay: '2026-09-08', toDay: '2026-09-08' }] });
  assert.equal(r['2026-09-04'].working, false);
  assert.equal(r['2026-09-06'].working, true);
  assert.equal(r['2026-09-07'].working, false, 'no fix that day');
  assert.equal(r['2026-09-08'].working, false, 'inside a blindness episode');
});

test('a route arriving with a workout is stamped on arrival; one re-sent later is stamped LATE and never confirms', () => {
  const parsed = { sourceUuid: 'w-route', activityType: 'Hiking', startedAt: '2026-10-04 09:00:00', endedAt: '2026-10-04 13:00:00', durationSeconds: 14400,
    payload: { route: { pointCount: 800, firstAt: '2026-10-04 10:01:00 +0100', lastAt: '2026-10-04 13:59:00 +0100' } } };
  db.insertWorkouts([parsed]);
  const row = db.get(`SELECT payload, created_at FROM health_workouts WHERE source_uuid = 'w-route'`);
  const t = loop.routeFromPayload(row.payload, row.created_at);
  assert.equal(t.pointCount, 800);
  assert.equal(t.firstMs, Date.parse('2026-10-04T09:01:00Z'), 'the HAE offset is honoured');
  assert.ok(Number.isFinite(t.receivedMs));
  // An old workout gaining its route later keeps its own row and gets the route's arrival time.
  db.insertWorkouts([{ sourceUuid: 'w-aug', activityType: 'Hiking', startedAt: '2026-08-06 10:25:18', payload: { route: { pointCount: 900, firstAt: '2026-08-06 10:30:00', lastAt: '2026-08-06 15:10:00' } } }]);
  const aug = db.get(`SELECT payload, created_at FROM health_workouts WHERE source_uuid = 'w-aug'`);
  const at = loop.routeFromPayload(aug.payload, aug.created_at);
  assert.equal(at.pointCount, 900);
  const v = loop.trackVerdict({ type: 'Hiking', mins: 292, startMs: Date.parse('2026-08-06T10:25:18Z'), endMs: Date.parse('2026-08-06T15:17:01Z'), track: at });
  assert.equal(v.valid, false);
  assert.equal(v.late, true, 'a back-filled route is late, not a confirmation');
  assert.equal(db.all(`SELECT COUNT(*) n FROM health_workouts WHERE source_uuid = 'w-aug'`)[0].n, 1, 'no duplicate workout');
});

test('NeuroKit sends a route SUMMARY — never coordinates (cross-repo guard)', () => {
  const p = path.join(__dirname, '..', '..', '..', 'nuero-ios', 'NeuroKit', 'Sources', 'NeuroKit', 'HealthSync.swift');
  if (!fs.existsSync(p)) return; // the iOS repo is a sibling checkout; absent on the Pi
  const src = fs.readFileSync(p, 'utf8');
  const fn = src.slice(src.indexOf('private func routeSummary'));
  assert.match(src, /HKSeriesType\.workoutRoute\(\)/, 'positive control: the route is read');
  const end = fn.search(/\r?\n {4}\}\r?\n/); // the function's own closing brace (CRLF-safe)
  const body = fn.slice(0, end);
  assert.ok(end > 200, 'the function body was found');
  assert.match(body, /"pointCount"/);
  assert.doesNotMatch(body, /latitude|longitude|coordinate/, 'no coordinates leave the phone');
  assert.doesNotMatch(src, /\/usr\/bin\/bash/);
});
