'use strict';

/**
 * Build 29 — Outdoor Life Intelligence (9 Oct 2026).
 *
 * Fixtures are LIVE shapes, copied off the Pi: the repeating all-day "hiking"
 * Saturday (calendar), the 6 Aug 2026 Hiking workout that arrived with no
 * route, the 5 Jun 2026 Walking workout (58 min, 2.2 km), 19 Sep (18,122
 * steps, 8.3 km, 41 background fixes — not a hike), Ember's companion row,
 * and Home Assistant's daily forecast shape ("rainy", 0.04 mm, 15.66 km/h).
 * The hike verdict itself is hiking-loop.js's; these tests pin that Outdoor
 * READS it and never loosens it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b29-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'o.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.HA_TOKEN = '';
process.env.HA_URL = 'http://127.0.0.1:9';

const db = require('../db/database');
const model = require('./outdoor-model');
const outdoor = require('./outdoor');
const loop = require('./hiking-loop');
const radar = require('./future-radar');
const tl = require('./activity-timeline');
const matrix = require('./authority-matrix');

const NOW = Date.parse('2026-10-09T15:00:00Z');   // Friday 16:00 BST
const MONDAY = Date.parse('2026-10-05T08:00:00Z');
const GOAL = 'goal:hike';
const EMBER = 'companion:ember';

function plan(day, cache = false) {
  const table = cache ? 'calendar_cache' : 'calendar_history';
  const extra = cache ? '' : ', first_seen';
  const vals = cache ? '' : ", 'x'";
  db.run(`INSERT OR IGNORE INTO ${table} (event_id, subject, start_time, end_time, is_all_day, source${extra}) VALUES (?, 'hiking', ?, ?, 1, 'apple'${vals})`, [`h-${day}-${cache}`, `${day}T00:00:00`, `${day}T23:59:00`]);
}
function fixes(day, n) {
  const base = Date.parse(`${day}T11:00:00Z`) / 1000;
  for (let i = 0; i < n; i += 1) db.run('INSERT OR IGNORE INTO location_points (device_id, lat, lng, tst, accuracy) VALUES (?, 53, -1.5, ?, 5)', ['ios-1', base + i * 300]);
}
function workout(uuid, type, startedAt, mins, { distanceM = null, route = null, receivedAt = null } = {}) {
  const start = Date.parse(startedAt.replace(' ', 'T') + 'Z');
  const end = new Date(start + mins * 60000).toISOString().replace('T', ' ').slice(0, 19);
  const payload = route == null ? null : JSON.stringify({ route: { pointCount: route,
    firstAt: new Date(start + 60000).toISOString(), lastAt: new Date(start + (mins - 1) * 60000).toISOString(),
    receivedAt: receivedAt || new Date(start + (mins + 30) * 60000).toISOString() } });
  db.run(`INSERT INTO health_workouts (source_uuid, activity_type, started_at, ended_at, duration_seconds, distance_m, payload, created_at, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'apple-health')`, [uuid, type, startedAt, end, mins * 60, distanceM, payload, end]);
  return db.get('SELECT id FROM health_workouts WHERE source_uuid = ?', [uuid]).id;
}
function source(id, state = 'healthy', freshness = 'fresh') {
  db.run(`INSERT OR REPLACE INTO source_health (source_id, state, freshness, last_success_at, updated_at) VALUES (?, ?, ?, '2026-10-09T14:00:00Z', '2026-10-09T14:00:00Z')`, [id, state, freshness]);
}
function forecast(days) {
  db.setState(outdoor.FORECAST_KEY, JSON.stringify({ fetchedAt: new Date(NOW - 3600000).toISOString(), known: true, days }));
}
const RAINY_SAT = { date: '2026-10-10', condition: 'rainy', tempHighC: 13.1, tempLowC: 9, precipitationMm: 0.04, precipitationProbability: null, windKmh: 15.66 };

let WALK_JUN; let HIKE_AUG; let WALK_TODAY;
test.before(async () => {
  await db.init();
  db.run(`INSERT INTO goals (goal_id, title, domains_json, status, importance, created_at, updated_at) VALUES (?, 'Hike weekly', '["health"]', 'active', 'important-to-me', 'x', 'x')`, [GOAL]);
  db.run(`INSERT INTO wm_companions (companion_id, name, species, breed, note_path, household, aliases_json, provenance_kind, observed_at, evidence_json, fingerprint, updated_at)
          VALUES (?, 'Ember', 'Dog', 'Border Collie', 'Companions/Ember.md', 1, '[]', 'fact', 'x', '[]', 'f', 'x')`, [EMBER]);
  for (const d of ['2026-09-19', '2026-09-26', '2026-10-03']) plan(d);
  plan('2026-10-10', true);
  db.run('INSERT OR REPLACE INTO health_daily (day, steps, complete, computed_at) VALUES (?, ?, 1, ?)', ['2026-09-19', 18122, 'x']);
  for (let d = 6; d <= 30; d += 1) fixes(`2026-09-${String(d).padStart(2, '0')}`, d === 19 ? 41 : 3);
  for (let d = 1; d <= 9; d += 1) fixes(`2026-10-0${d}`, 3);
  WALK_JUN = workout('w-jun', 'Walking', '2026-06-05 10:15:06', 58, { distanceM: 2246 });
  HIKE_AUG = workout('w-aug', 'Hiking', '2026-08-06 10:25:18', 292, { distanceM: 17002 });
  WALK_TODAY = workout('w-oct', 'Walking', '2026-10-06 16:00:00', 40, { distanceM: 3100 });
  for (const s of ['healthkit.neuro-ios', 'location.neuro-ios', 'eventkit.neuro-ios']) source(s);
  db.run(`INSERT INTO native_builds (build_key, client, version, build, protocol, capabilities_json, first_seen_at, last_seen_at) VALUES ('neuro-ios|0.1|243', 'neuro-ios', '0.1', '243', 18, '["workout-route-summary"]', 'x', 'x')`);
  for (const [d, m] of [['2026-10-05', 20], ['2026-10-06', 13], ['2026-10-07', 1], ['2026-10-08', 13], ['2026-10-09', 7]]) {
    db.run('INSERT OR REPLACE INTO health_daily (day, daylight_minutes, complete, computed_at) VALUES (?, ?, 1, ?)', [d, m, 'x']);
  }
  forecast([RAINY_SAT]);
});

// Pure helpers in the reader's shape.
function wk(day, type, mins, { route = null } = {}) {
  const startMs = Date.parse(`${day}T09:00:00Z`);
  const endMs = startMs + mins * 60000;
  const track = route == null ? null : { pointCount: route, firstMs: startMs + 60000, lastMs: endMs - 60000, receivedMs: endMs + 3600000 };
  return { day, type, mins, startMs, endMs, endLocal: new Date(endMs + 3600000).toISOString().slice(0, 16), track };
}
const LOC = { '2026-09-19': { working: true } };
const AFTER = '2026-10-07T10:00';
function verdictOf(w, extra = {}) {
  return loop.judgeDay(w.day, { nowLocal: AFTER, workouts: [w], location: LOC, ...extra });
}
function shaped(w, extra = {}, links = []) {
  return model.shapeWorkout({ id: 1, type: w.type, day: w.day, mins: w.mins }, { verdict: verdictOf(w, extra), links, trackValid: loop.trackVerdict(w).valid });
}

// ── HIKE EVIDENCE (1–10) ───────────────────────────────────────────────────

test('1. a Hiking workout WITH its GPS route confirms a hike; without its route it is a recording gap (Build 17 kept)', () => {
  const withRoute = shaped(wk('2026-09-19', 'Hiking', 240, { route: 900 }));
  assert.equal(withRoute.kind, 'hike'); assert.equal(withRoute.state, 'confirmed');
  const noRoute = shaped(wk('2026-09-19', 'Hiking', 240));
  assert.equal(noRoute.kind, 'hike'); assert.equal(noRoute.state, 'recording_gap', 'the brief\'s "Hiking workout confirms" is looser than Build 17; the stricter rule stands');
});

test('2. a Walking workout of 60+ min with >=10 GPS fixes received within 24h confirms a hike', () => {
  const a = shaped(wk('2026-09-19', 'Walking', 75, { route: 40 }));
  assert.equal(a.kind, 'hike'); assert.equal(a.state, 'confirmed');
});

test('3. a walk under 60 minutes is not a hike, whatever its track', () => {
  const a = shaped(wk('2026-09-19', 'Walking', 50, { route: 400 }));
  assert.equal(a.kind, 'walk'); assert.equal(a.hike.state, 'not_hike');
  assert.match(a.hike.why, /under 60 minutes/);
});

test('4. a 60+ min walk without enough GPS fixes is not a hike', () => {
  const a = shaped(wk('2026-09-19', 'Walking', 90, { route: 9 }));
  assert.equal(a.kind, 'walk'); assert.equal(a.hike.state, 'not_hike');
  const none = shaped(wk('2026-09-19', 'Walking', 90));
  assert.equal(none.kind, 'walk');
});

test('5–9. steps, distance, a route plan, the weather and Ember never confirm a hike', () => {
  const day = '2026-09-19';
  const base = { nowLocal: AFTER, location: LOC };
  const v = loop.judgeDay(day, base);
  assert.equal(v.state, 'not_hike', '18,122 steps and 8.3 km did not make 19 Sep a hike');
  // A dated hike route plan is a plan in the loop, never evidence.
  const w = loop.weekState({ start: '2026-09-14', today: '2026-10-07', nowLocal: AFTER, plans: [{ day, source: 'route' }], location: { ...LOC }, steps: { [day]: 18122 } });
  assert.equal(w.confirmed.length, 0);
  // Weather and Ember enter only as context on a shaped activity — neither moves the state.
  const plain = shaped(wk(day, 'Walking', 45));
  const withEmber = shaped(wk(day, 'Walking', 45), {}, [{ relation: 'companion', target: EMBER, label: 'Ember' }]);
  assert.equal(withEmber.hike.state, plain.hike.state);
  assert.equal(withEmber.kind, 'dog_walk'); assert.equal(plain.kind, 'walk');
  const sunny = model.suitability({ daily: { condition: 'sunny', tempHighC: 18, precipitationMm: 0, windKmh: 10 } });
  assert.equal(sunny.state, 'favourable');
  assert.ok(!('hike' in sunny) && !('confirmed' in sunny), 'weather carries no activity field at all');
  assert.ok(model.EVIDENCE.notSufficient.some((x) => /Ember/.test(x)) && model.EVIDENCE.notSufficient.includes('steps'));
});

test('10. Nick\'s explicit confirmation confirms — and a confirmed day survives weaker evidence', () => {
  const r = loop.addEntry('confirm', { day: '2026-09-26', now: NOW });
  assert.equal(r.ok, true);
  const o = outdoor.read({ now: NOW, weeks: 3 });
  const h = o.hikes.find((x) => x.day === '2026-09-26');
  assert.ok(h, 'a confirmed day with no workout is still a confirmed hike');
  assert.equal(h.activityId, 'hike-day:2026-09-26');
  assert.deepEqual(h.evidence, ['you confirmed it']);
  loop.withdraw(r.id, { now: NOW });
});

// ── STATES (11–15) ─────────────────────────────────────────────────────────

test('11. healthy location + no track within 24h → not_hike', () => {
  assert.equal(loop.judgeDay('2026-09-19', { nowLocal: AFTER, location: LOC }).state, 'not_hike');
});

test('12. location unavailable that day → recording_gap, never not_hike', () => {
  const v = loop.judgeDay('2026-09-19', { nowLocal: AFTER, location: { '2026-09-19': { working: false, why: 'the phone sent no location that day' } } });
  assert.equal(v.state, 'recording_gap');
});

test('13. a planned route stays planned until a day is over — never activity', () => {
  const w = loop.weekState({ start: '2026-10-05', today: '2026-10-09', nowLocal: '2026-10-09T16:00', plans: [{ day: '2026-10-10', source: 'route' }], location: {} });
  assert.equal(w.recording, 'planned');
  assert.equal(model.goalState(w).state, 'planned');
});

test('14. inside the 24h window the state is unknown, and the goal is unknown', () => {
  const w = loop.weekState({ start: '2026-10-05', today: '2026-10-09', nowLocal: '2026-10-09T16:00',
    workouts: [wk('2026-10-09', 'Hiking', 120)], location: { '2026-10-09': { working: true } } });
  assert.equal(w.recording, 'unknown');
  assert.equal(model.goalState(w).state, 'unknown');
});

test('15. a confirmed activity is not overwritten by weak evidence (steps, Ember, weather)', () => {
  const v = { day: '2026-09-19', state: 'confirmed', by: 'you', why: 'you confirmed it' };
  const a = model.shapeWorkout({ id: 9, type: 'Walking', day: '2026-09-19', mins: 30 }, { verdict: v, links: [{ relation: 'companion', target: EMBER, label: 'Ember' }] });
  assert.equal(a.kind, 'hike'); assert.equal(a.state, 'confirmed');
  assert.equal(model.goalState({ confirmed: [{ day: '2026-09-19' }], recording: 'not_hike', line: 'x' }).state, 'achieved');
});

// ── WALK / EMBER (16–20) ───────────────────────────────────────────────────

test('16–17. an ordinary walk stays a walk; a long walk does not become a hike', () => {
  const o = outdoor.read({ now: NOW, weeks: 1 });
  const w = o.walks.find((x) => x.activityId === `workout:${WALK_TODAY}`);
  assert.ok(w); assert.equal(w.kind, 'walk'); assert.equal(w.state, 'confirmed');
  assert.notEqual(w.hike.state, 'confirmed');
  const long = shaped(wk('2026-09-19', 'Walking', 200, { route: 3 }));
  assert.equal(long.kind, 'walk', 'three hours without a track is still a walk');
  assert.ok(model.isMeaningfulWalk(long) && !model.isMeaningfulWalk({ kind: 'walk', durationMin: 10, companions: [] }));
});

test('18. an explicit Ember link works, and is audited', () => {
  const r = outdoor.addCompanion(`workout:${WALK_TODAY}`, EMBER, { now: NOW });
  assert.equal(r.ok, true);
  const o = outdoor.read({ now: NOW, weeks: 1 });
  const w = o.walks.find((x) => x.activityId === `workout:${WALK_TODAY}`);
  assert.equal(w.kind, 'dog_walk');
  assert.deepEqual(w.companions.map((c) => c.name), ['Ember']);
  assert.equal(outdoor.addCompanion(`workout:${WALK_TODAY}`, EMBER, { now: NOW }).already, true);
  assert.equal(outdoor.addCompanion(`workout:${WALK_TODAY}`, 'companion:nobody', { now: NOW }).status, 404);
});

test('19. Nick walking never implies Ember', () => {
  const o = outdoor.read({ now: NOW, weeks: 20 });
  const jun = [...o.walks, ...o.hikes].find((x) => x.activityId === `workout:${WALK_JUN}`);
  assert.ok(jun, 'the 5 Jun walk is in the read');
  assert.deepEqual(jun.companions, []);
  assert.equal(jun.kind, 'walk');
  const care = db.get('SELECT COUNT(*) n FROM companion_walk_marks').n;
  assert.equal(care, 0, 'no walk was written to Ember\'s care');
});

test('20. an Ember walk never becomes pet admin', () => {
  assert.equal(db.get('SELECT COUNT(*) n FROM companion_care_items').n, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM companion_links').n, 0);
  const src = fs.readFileSync(path.join(__dirname, 'outdoor.js'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(!/companion_care_items|companion_links|companion_walk_marks/.test(src), 'Outdoor never writes Ember\'s care tables');
  assert.ok(/companion_walk_marks/.test(fs.readFileSync(path.join(__dirname, 'companion-care.js'), 'utf8')), 'positive control');
});

// ── ROUTES (21–25) ─────────────────────────────────────────────────────────

const GPX = `<?xml version="1.0"?><gpx version="1.1" creator="test"><metadata><name>Mam Tor loop</name><link href="https://www.alltrails.com/trail/x"/></metadata>
<trk><name>Mam Tor loop</name><trkseg>
${Array.from({ length: 30 }, (_, i) => `<trkpt lat="${(53.35 + i * 0.001).toFixed(5)}" lon="${(-1.81 + i * 0.001).toFixed(5)}"><ele>${300 + i * 5}</ele></trkpt>`).join('\n')}
</trkseg></trk></gpx>`;

test('21. a GPX file creates a PLAN, not completion — and it plans the week', () => {
  const r = outdoor.createRoute({ gpx: GPX, plannedDate: '2026-10-11' }, { now: NOW });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.route.name, 'Mam Tor loop');
  assert.equal(r.route.source, 'gpx');
  assert.ok(r.route.distanceKm > 3 && r.route.distanceKm < 5, `distance ${r.route.distanceKm}`);
  assert.ok(r.route.elevationGainM >= 140);
  assert.equal(r.route.outcome, null, 'a plan has no outcome until something is linked');
  const o = outdoor.read({ now: NOW, weeks: 1 });
  assert.equal(o.hikes.length, 0, 'no activity appeared');
  assert.ok(o.plans.some((p) => p.day === '2026-10-11' && p.routes.some((x) => x.name === 'Mam Tor loop')));
  assert.ok(!JSON.stringify(o).includes('53.35'), 'plan geometry is never returned');
  assert.equal(model.parseGpx('<html></html>').ok, false);
});

test('22. an exact route reference can link an actual', () => {
  assert.equal(model.matchRoute({ routeRef: 'alltrails:42' }, { routeRef: 'alltrails:42' }).basis, 'route-id');
});

test('23. a strong geometry match may link; a different track does not', () => {
  const line = Array.from({ length: 40 }, (_, i) => [53.35 + i * 0.001, -1.81 + i * 0.001]);
  const same = line.map(([a, b]) => [a + 0.0002, b]);
  assert.equal(model.matchRoute({ geometry: line }, { geometry: same }).basis, 'geometry');
  const half = line.slice(0, 20).map(([a, b]) => [a, b]);
  assert.equal(model.matchRoute({ geometry: line }, { geometry: half }).linked, false, 'half the route is not this route');
});

test('24–25. same area, similar distance or same day alone never link', () => {
  const m = model.matchRoute({ plannedDate: '2026-10-10', distanceKm: 12, region: 'Peak District' }, { day: '2026-10-10', distanceKm: 12.4, region: 'Peak District' });
  assert.equal(m.linked, false);
  assert.match(m.why, /same day, similar distance, same area — not enough/);
});

test('route link: explicit, auditable, and the plan becomes completed only through it', () => {
  const r = outdoor.createRoute({ name: 'Kinder Scout', kind: 'hike', plannedDate: '2026-09-26' }, { now: NOW });
  assert.equal(r.ok, true);
  const conf = loop.addEntry('confirm', { day: '2026-09-26', now: NOW });
  assert.equal(outdoor.linkRoute('hike-day:2026-09-26', r.routeId, { now: NOW }).ok, true);
  let o = outdoor.read({ now: NOW, weeks: 3 });
  assert.equal(o.routes.find((x) => x.routeId === r.routeId).outcome, 'completed');
  assert.equal(outdoor.unlinkRoute('hike-day:2026-09-26', { now: NOW }).ok, true);
  o = outdoor.read({ now: NOW, weeks: 3 });
  assert.equal(o.routes.find((x) => x.routeId === r.routeId).outcome, 'not-linked');
  assert.equal(outdoor.linkRoute('hike-day:2026-09-12', r.routeId, { now: NOW }).status, 404, 'no confirmed day, nothing to link');
  loop.withdraw(conf.id, { now: NOW });
});

// ── GOAL (26–30) ───────────────────────────────────────────────────────────

test('26. a confirmed hike achieves the weekly goal', () => {
  const r = loop.addEntry('confirm', { day: '2026-10-08', now: NOW });
  const o = outdoor.read({ now: NOW, weeks: 1 });
  assert.equal(o.goal.state, 'achieved');
  assert.equal(o.summary.confirmedHikes, 1);
  assert.equal(o.summary.knownDurationMin, null, 'a confirmed day has no duration, so no total is invented');
  loop.withdraw(r.id, { now: NOW });
});

test('27. a planned hike marks the goal planned only', () => {
  const o = outdoor.read({ now: NOW, weeks: 1 });
  assert.equal(o.goal.state, 'planned');
  assert.equal(o.summary.confirmedHikes, 0);
  assert.equal(o.nextPlan.day, '2026-10-10');
});

test('28. no hike, no plan, healthy sources → not_yet', () => {
  const w = loop.weekState({ start: '2026-09-28', today: '2026-10-07', nowLocal: AFTER, plans: [], location: Object.fromEntries(loop.weekDays('2026-09-28').map((d) => [d, { working: true }])) });
  assert.equal(model.goalState(w).state, 'not_yet');
});

test('29. a source gap → recording_gap', () => {
  const w = loop.weekState({ start: '2026-08-03', today: '2026-10-07', nowLocal: AFTER, workouts: [wk('2026-08-06', 'Hiking', 292)], location: {} });
  assert.equal(model.goalState(w).state, 'recording_gap');
});

test('30. no early-week nagging: Monday is never "at risk"; Friday with no plan is', () => {
  const g = { state: 'not_yet' };
  assert.equal(model.goalAtRisk({ goal: g, today: '2026-10-05', weekEnd: '2026-10-11', plans: [], sourcesHealthy: true }).atRisk, false);
  assert.equal(model.goalAtRisk({ goal: g, today: '2026-10-09', weekEnd: '2026-10-11', plans: [], sourcesHealthy: true }).atRisk, true);
  assert.equal(model.goalAtRisk({ goal: g, today: '2026-10-09', weekEnd: '2026-10-11', plans: [{ day: '2026-10-10' }], sourcesHealthy: true }).atRisk, false);
  assert.equal(model.goalAtRisk({ goal: g, today: '2026-10-09', weekEnd: '2026-10-11', plans: [], sourcesHealthy: false }).atRisk, false, 'unhealthy sources never assert risk');
  const mon = outdoor.read({ now: MONDAY, weeks: 1 });
  assert.equal(mon.now.items.some((i) => i.kind === 'goal-at-risk'), false);
});

// ── WEATHER (31–34) ────────────────────────────────────────────────────────

test('31. weather is context on a planned outing (the live Saturday)', () => {
  const o = outdoor.read({ now: NOW, weeks: 1 });
  const sat = o.plans.find((p) => p.day === '2026-10-10');
  assert.equal(sat.weather.state, 'mixed');
  assert.match(sat.weather.line, /rainy/);
  assert.equal(sat.weather.severe, false);
});

test('32. weather never confirms activity', () => {
  forecast([{ ...RAINY_SAT, date: '2026-10-08', condition: 'sunny', precipitationMm: 0 }, RAINY_SAT]);
  const o = outdoor.read({ now: NOW, weeks: 1 });
  assert.ok(!o.hikes.some((h) => h.day === '2026-10-08'));
  forecast([RAINY_SAT]);
});

test('33. no duplicated forecast engine: Outdoor reads stored forecasts, fetches nothing, stores no forecast history', () => {
  const src = fs.readFileSync(path.join(__dirname, 'outdoor.js'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(!/fetch\(|open-meteo\.com|api\.open-meteo/.test(src), 'no forecast fetch of its own');
  assert.ok(!/INSERT INTO weather_/.test(src), 'no forecast rows written');
  assert.equal((src.match(/readDailyForecast/g) || []).length, 1, 'one HA read, in refresh()');
});

test('34. suitability explains its inputs, says what it does not know, and severe is named', () => {
  const s = model.suitability({ daily: { condition: 'rainy', tempHighC: 13, tempLowC: 9, precipitationMm: 12, windKmh: 70 } });
  assert.equal(s.state, 'poor'); assert.equal(s.severe, true);
  assert.deepEqual(s.inputs.map((i) => i.input).sort(), ['condition', 'rain', 'temperature', 'wind']);
  assert.match(s.line, /^Severe — /);
  const partial = model.suitability({ hourly: [{ precipMm: 0, precipProb: 10, tempC: 14 }] });
  assert.deepEqual(partial.missing, ['wind']);
  assert.match(partial.line, /Not known: wind/);
  assert.equal(model.suitability({}).state, 'unknown');
});

test('34b. the live 10 Oct forecast (0.8 mm, wettest hour 72%) is mixed, not favourable', () => {
  const hourly = [{ precipMm: 0.1, precipProb: 40, tempC: 9 }, { precipMm: 0.5, precipProb: 72, tempC: 12 }, { precipMm: 0.2, precipProb: 55, tempC: 11 }];
  const s = model.suitability({ hourly });
  assert.equal(s.state, 'mixed');
  assert.equal(model.suitability({ hourly: [{ precipMm: 0, precipProb: 20, tempC: 14 }] }).state, 'favourable', 'positive control');
});

// ── NOW / RADAR (35–39) ────────────────────────────────────────────────────

const HIKE_EVENT = { meetingId: 'm1', title: 'hiking', day: '2026-10-10', allDay: true, calendarName: 'Home', domains: { domains: [] } };
test('35. a planned hike appears in Radar; a hike route folds into it, a walk route is its own item', () => {
  const r = radar.composeRadar({ today: '2026-10-09', events: [HIKE_EVENT], hikeGoal: { id: GOAL, title: 'Hike weekly' },
    outdoorPlans: [{ routeId: 'route:a', name: 'Mam Tor loop', kind: 'hike', day: '2026-10-10', emberPlanned: true }, { routeId: 'route:b', name: 'Canal', kind: 'walk', day: '2026-10-12' }] });
  const hikes = r.items.filter((i) => i.kind === 'hike');
  assert.equal(hikes.length, 1, 'one plan, not two');
  assert.equal(hikes[0].title, 'Hike planned: Mam Tor loop');
  assert.ok(hikes[0].linkedEntityRefs.includes('companion:ember'));
  assert.ok(r.items.some((i) => i.kind === 'outdoor-plan' && i.title === 'Walk planned: Canal'));
});

test('36. the generic hike goal creates no Radar item on its own', () => {
  const r = radar.composeRadar({ today: '2026-10-09', hikeGoal: { id: GOAL, title: 'Hike weekly' } });
  assert.equal(r.items.length, 0);
});

test('37. Now stays quiet when nothing is relevant (Monday, plan five days away)', () => {
  const n = model.nowRelevance({ today: '2026-10-05', goal: { state: 'planned' }, plans: [{ day: '2026-10-10', label: 'Hike', weather: { state: 'mixed', severe: false, line: 'x' } }], atRisk: { atRisk: false } });
  assert.equal(n.relevant, false);
  assert.equal(n.needsYou.length, 0);
});

test('38. severe weather + an imminent hike → relevant, and a Needs You decision (Now and Radar)', () => {
  forecast([{ ...RAINY_SAT, windKmh: 80, condition: 'lightning-rainy' }]);
  const o = outdoor.read({ now: NOW, weeks: 1 });
  assert.equal(o.now.relevant, true);
  assert.equal(o.now.needsYou[0].kind, 'severe-weather');
  const r = radar.composeRadar({ today: '2026-10-09', events: [HIKE_EVENT], hikeGoal: { id: GOAL, title: 'Hike weekly' },
    outdoorWeather: new Map([['2026-10-10', { state: 'poor', severe: true, line: 'Severe — 80 km/h' }]]) });
  assert.equal(r.items[0].actionState, 'needs_you');
  forecast([RAINY_SAT]);
  const calm = outdoor.read({ now: NOW, weeks: 1 });
  assert.equal(calm.now.needsYou.length, 0, 'mediocre weather is never Needs You');
  assert.equal(calm.now.relevant, true, 'but a hike tomorrow is context on Now');
});

test('39. no new notification policy: Outdoor sends nothing and touches no push path', () => {
  for (const f of ['outdoor.js', 'outdoor-model.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.ok(!/webpush|sendToAll|worthInterrupting|ambient-push|notification-policy/.test(src), f);
  }
  assert.ok(/sendToAll/.test(fs.readFileSync(path.join(__dirname, 'date-nags.js'), 'utf8')), 'positive control');
});

// ── PRIVACY (40–42) ────────────────────────────────────────────────────────

function counts() {
  return Object.fromEntries(db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((t) => [t.name, db.get(`SELECT COUNT(*) n FROM "${t.name}"`).n]));
}

test('40–42. reading Outdoor, Now and the Radar writes nothing — no movement log, no location history', async () => {
  const before = counts();
  const stateBefore = db.all('SELECT key, value FROM agent_state ORDER BY key');
  outdoor.read({ now: NOW, weeks: 8 });
  outdoor.nowBlock({ now: NOW });
  require('./future-radar').read({ now: NOW, horizonDays: 14 });
  assert.deepEqual(counts(), before);
  assert.deepEqual(db.all('SELECT key, value FROM agent_state ORDER BY key'), stateBefore);
  const o = JSON.stringify(outdoor.read({ now: NOW, weeks: 8 }));
  assert.ok(!/"lat"|"lng"|"lon"|"geometry"/.test(o), 'no coordinates in the payload');
  for (const f of ['outdoor.js', 'outdoor-model.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.ok(!/location_points|device_visits|place_region_events|location_visits/.test(src), `${f} never reads or writes location`);
  }
  assert.ok(/location_points/.test(fs.readFileSync(path.join(__dirname, 'hiking-loop.js'), 'utf8')), 'positive control');
});

// ── CORRECTIONS (43–47) ────────────────────────────────────────────────────

let server; let base;
test('43–47. corrections over real HTTP: confirm, not a hike, link/unlink route, Ember on/off — all audited, all machine-refused', async () => {
  const express = require('express');
  const app = express(); app.use(express.json());
  app.use('/api/outdoor', require('../routes/outdoor'));
  app.use('/api/loops', require('../routes/loops'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  const evBefore = db.get('SELECT COUNT(*) n FROM personal_ops_events').n;

  // 43/44: hike confirm and not-a-hike stay on the loop's routes — one place decides a hike.
  assert.equal((await post('/api/loops/hiking/confirm', { day: '2026-10-07' })).status, 200);
  let o = await (await fetch(`${base}/api/outdoor?weeks=1`)).json();
  assert.equal(o.goal.state, 'achieved');
  assert.equal((await post('/api/loops/hiking/deny', { day: '2026-10-07' })).status, 200);
  o = await (await fetch(`${base}/api/outdoor?weeks=1`)).json();
  assert.notEqual(o.goal.state, 'achieved');
  assert.ok(o.refused.some((x) => x.day === '2026-10-07' && x.by === 'you'));

  // 45: link / unlink a route.
  const route = await post('/api/outdoor/routes', { name: 'Edale skyline', kind: 'hike' });
  assert.equal(route.status, 200);
  const act = `workout:${WALK_TODAY}`;
  assert.equal((await post(`/api/outdoor/activities/${encodeURIComponent(act)}/route`, { routeId: route.body.routeId })).status, 200);
  o = await (await fetch(`${base}/api/outdoor?weeks=1`)).json();
  assert.equal([...o.walks, ...o.hikes].find((a) => a.activityId === act).route.name, 'Edale skyline');
  assert.equal((await post(`/api/outdoor/activities/${encodeURIComponent(act)}/route/remove`)).status, 200);
  assert.equal((await post('/api/outdoor/routes', { name: 'x', status: 'cancelled' })).status, 400);
  assert.equal((await post('/api/outdoor/routes', { name: 'x', plannedDate: '2026-02-31' })).status, 400, 'refused, never rolled');
  assert.equal((await post(`/api/outdoor/routes/${encodeURIComponent(route.body.routeId)}`, { status: 'done' })).status, 400, 'completed only via a link');

  // 46: Ember on and off.
  assert.equal((await post(`/api/outdoor/activities/${encodeURIComponent(act)}/companion/remove`, { companionId: EMBER })).status, 200);
  o = await (await fetch(`${base}/api/outdoor?weeks=1`)).json();
  assert.equal([...o.walks, ...o.hikes].find((a) => a.activityId === act).kind, 'walk');
  assert.equal((await post(`/api/outdoor/activities/${encodeURIComponent(act)}/companion`, { companionId: EMBER })).status, 200);

  // 47: auditable — every correction is an append-only line, and Activity names it.
  const rows = db.all('SELECT * FROM personal_ops_events WHERE kind LIKE ? ORDER BY id', ['outdoor-%']);
  assert.ok(db.get('SELECT COUNT(*) n FROM personal_ops_events').n > evBefore);
  assert.deepEqual([...new Set(rows.map((r) => r.kind))].sort(), ['outdoor-companion-added', 'outdoor-companion-removed', 'outdoor-route-linked', 'outdoor-route-planned', 'outdoor-route-unlinked']);
  assert.ok(rows.every((r) => r.actor === 'nick'));
  assert.throws(() => db.run("UPDATE personal_ops_events SET kind = 'x' WHERE id = ?", [rows[0].id]), /append-only/);
  const lines = tl.fromPersonalOps(rows).map((e) => e.headline);
  assert.ok(lines.some((l) => /You marked Ember on/.test(l)) && lines.some((l) => /You linked .* to the route "Edale skyline"/.test(l)));

  // Machine clients may read Outdoor and never write it.
  for (const p of ['/api/outdoor/routes', '/api/outdoor/routes/route:x', '/api/outdoor/activities/workout:1/route', '/api/outdoor/activities/workout:1/route/remove', '/api/outdoor/activities/workout:1/companion', '/api/outdoor/activities/workout:1/companion/remove']) {
    assert.equal(matrix.machineDecision('POST', p).allow, false, p);
  }
  assert.equal(matrix.machineDecision('GET', '/api/outdoor').allow, true);
});

test.after(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

// ── pins added after mutation testing ─────────────────────────────────────

test('a GPS-track confirmation belongs to the workout that carried it — a short walk the same day stays a walk', () => {
  const hike = wk('2026-09-19', 'Hiking', 240, { route: 900 });
  const walk = { ...wk('2026-09-19', 'Walking', 25), startMs: hike.endMs + 3600000 };
  const v = loop.judgeDay('2026-09-19', { nowLocal: AFTER, workouts: [hike, walk], location: LOC });
  assert.equal(v.state, 'confirmed'); assert.equal(v.by, 'gps-track');
  const a = model.shapeWorkout({ id: 2, type: 'Walking', day: '2026-09-19', mins: 25 }, { verdict: v, trackValid: loop.trackVerdict(walk).valid });
  assert.equal(a.kind, 'walk');
  const h = model.shapeWorkout({ id: 1, type: 'Hiking', day: '2026-09-19', mins: 240 }, { verdict: v, trackValid: true });
  assert.equal(h.kind, 'hike'); assert.equal(h.state, 'confirmed');
});

test('Now: a fair-weather plan two days out is not on Now (only today/tomorrow, or severe)', () => {
  const n = model.nowRelevance({ today: '2026-10-08', goal: { state: 'planned' }, plans: [{ day: '2026-10-10', label: 'Hike', weather: { state: 'favourable', severe: false, line: 'fine' } }], atRisk: { atRisk: false } });
  assert.equal(n.relevant, false);
  const severe = model.nowRelevance({ today: '2026-10-08', goal: { state: 'planned' }, plans: [{ day: '2026-10-10', label: 'Hike', weather: { state: 'poor', severe: true, line: 'storm' } }], atRisk: { atRisk: false } });
  assert.equal(severe.relevant, true, 'positive control: severe two days out does show');
});

test('an unreadable GPX file is refused and creates nothing', () => {
  const before = db.get('SELECT COUNT(*) n FROM outdoor_routes').n;
  const r = outdoor.createRoute({ name: 'bad', gpx: '<gpx><trk></trk></gpx>' }, { now: NOW });
  assert.equal(r.ok, false); assert.equal(r.status, 400);
  assert.equal(db.get('SELECT COUNT(*) n FROM outdoor_routes').n, before);
});

test('a dated hike route plan plans the week in the hiking loop itself (one rule for "planned")', () => {
  const r = outdoor.createRoute({ name: 'Stanage Edge', kind: 'hike', plannedDate: '2026-10-11' }, { now: NOW });
  const l = loop.read({ now: NOW, weeks: 1 });
  assert.ok(l.current.planned.some((p) => p.routeId === r.routeId && p.source === 'route'));
  outdoor.updateRoute(r.routeId, { status: 'cancelled' }, { now: NOW });
  assert.ok(!loop.read({ now: NOW, weeks: 1 }).current.planned.some((p) => p.routeId === r.routeId), 'a cancelled plan is not a plan');
});

test('a daily forecast older than 12 hours is not trusted', () => {
  db.setState(outdoor.FORECAST_KEY, JSON.stringify({ fetchedAt: new Date(NOW - 20 * 3600000).toISOString(), known: true, days: [{ ...RAINY_SAT, windKmh: 90, condition: 'exceptional' }] }));
  const o = outdoor.read({ now: NOW, weeks: 1 });
  const sat = o.plans.find((p) => p.day === '2026-10-10');
  assert.equal(sat.weather.severe, false);
  assert.equal(o.now.needsYou.length, 0);
  forecast([RAINY_SAT]);
});

// ── the card, rendered for real, from the REAL read ────────────────────────

test('Life → Outdoor renders the live shape: goal state, the refused Saturday with its steps, route plans, sources — no map, no score', async () => {
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'canonical', 'OutdoorCard.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      b.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiFetch = async () => ({ ok: true, json: async () => ({}) });', loader: 'js' }));
    } }],
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  assert.equal(typeof m.exports.OutdoorView, 'function', 'positive control: the view is exported');
  const data = outdoor.read({ now: NOW, weeks: 4 });
  const html = renderToString(React.createElement(m.exports.OutdoorView, { data, act: () => true }));
  assert.match(html, /data-testid="outdoor-card"/);
  assert.match(html, /This week: <strong>/);
  assert.match(html, /Not counted as a hike/);
  assert.match(html, /2026-10-03/, 'the live not-a-hike Saturday is shown');
  assert.match(html, /Route plans/);
  assert.match(html, /AllTrails/);
  assert.match(html, /not proven yet/, 'the GPS-track channel is drawn as unproven, not working');
  assert.match(html, /(came|wasn’t there)<\/button>/, 'Ember correction control is mounted');
  assert.match(html, /Link<\/button>|Unlink route<\/button>/, 'route link control is mounted');
  // Markup and values, not English words — the How-it-works line SAYS there is no score.
  assert.ok(!/<svg|<canvas|leaflet|kcal|\bscore\s*[:=]?\s*\d|\d+\s*-?day streak/i.test(html), 'no map, chart, calories, streak or score');
  assert.match(html, /Nothing here is a fitness score/, 'positive control: the scan would see the word, and ignores it on purpose');
});

// ── summary, sources, wording ──────────────────────────────────────────────

test('source health keeps the GPS-track channel apart from Apple Health, and AllTrails is named not-connected', () => {
  const s = outdoor.sourceHealth({ nowMs: NOW });
  const by = Object.fromEntries(s.map((x) => [x.id, x]));
  assert.equal(by.workouts.state, 'healthy');
  assert.equal(by['gps-track'].state, 'unproven', 'the build can send routes; none has arrived');
  assert.match(by['gps-track'].line, /only your word can confirm/);
  assert.equal(by.alltrails.state, 'not-connected');
  assert.notEqual(by.weather.state, 'healthy', 'a healthy daily forecast is not activity evidence, and the hourly one is absent here');
});

test('daylight is labelled as Apple\'s estimate, with coverage, and never touches a hike', () => {
  const d = model.daylightWeek([{ day: '2026-10-05', minutes: 20 }, { day: '2026-10-06', minutes: 13 }], { start: '2026-10-05', today: '2026-10-09' });
  assert.equal(d.minutes, 33); assert.equal(d.daysWithReading, 2); assert.equal(d.covered, false);
  assert.match(d.line, /Apple Watch's estimate/);
});

test('no fitness score, streak, calories or guilt in anything Outdoor says', () => {
  const o = outdoor.read({ now: NOW, weeks: 8 });
  const text = JSON.stringify(o);
  assert.ok(!/"score"|streak|calorie|kcal|readiness|leaderboard/i.test(text));
  assert.ok(!/\b(missed|failed|should|behind|lazy|guilt|you need to)\b/i.test([o.goal.line, o.atRisk.why, ...o.now.items.map((i) => i.line), ...o.routes.map((r) => r.outcomeWhy || '')].join(' ')));
});
