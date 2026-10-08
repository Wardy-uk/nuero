'use strict';

/**
 * Build 22 — Household / Home. Fixtures are shaped like the LIVE reads of
 * 8 Oct 2026: the household roster (Nick at work, Helen + Isaac home, Lizzy and
 * Daniel away), HA's two watchdog template sensors, 252 entities with no hazard
 * sensor, and the two reminders that actually reach NEURO (Bathroom's radiator
 * cover classified FAMILY, a test item classified HOME).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const home = require('./home');

// ── fixtures ─────────────────────────────────────────────────────────────────
const SRC_OK = { state: 'healthy', freshness: 'fresh' };
const roster = (states, src = SRC_OK) => ({
  known: true, source: src,
  members: [
    { id: 'nick', name: 'Nick', role: 'self', state: states.nick },
    { id: 'helen', name: 'Helen', role: 'resident', state: states.helen },
    { id: 'isaac', name: 'Isaac', role: 'resident', state: states.isaac },
    { id: 'lizzy', name: 'Lizzy', role: 'visitor', state: states.lizzy || 'away' },
    { id: 'ember', name: 'Ember', role: 'companion', state: 'untracked' },
  ],
});
const watchdog = (offline, batteries, extra = []) => [
  { entity_id: home.WATCHDOG_OFFLINE, state: String(offline.length), attributes: { devices: offline } },
  { entity_id: home.WATCHDOG_BATTERIES, state: String(batteries.length), attributes: { batteries, unreadable: [] } },
  { entity_id: 'sensor.bathroom_rad_battery_level', state: '60', attributes: { device_class: 'battery' } },
  { entity_id: 'binary_sensor.motion_sensor_1', state: 'off', attributes: { device_class: 'motion' } },
  ...extra,
];
const LIVE_OFFLINE = ['no room - bedroom tv', 'no room - extension lead', 'Office - Office plug'];
const obligation = (id, what, domain, extra = {}) => ({
  id, kind: 'task', what, domains: [{ domain, basis: 'classified' }], due: null, source: 'Reminders',
  actionState: 'preparation_open', needsNow: false, needsWhy: 'open, with no date', admin: false, linkedGoals: [], ...extra,
});
const RADIATOR = obligation('task:eventkit-reminders:88aa', 'Radiator cover 74cm wide 79 high 8 deep', 'family');
const TEST_ITEM = obligation('task:eventkit-reminders:3d21', 'Test reminder to trace route', 'home');

// ── 22D occupancy: conservative ─────────────────────────────────────────────
test('occupied when anyone is positively home, named', () => {
  const o = home.occupancyFrom(roster({ nick: 'away', helen: 'home', isaac: 'home' }));
  assert.equal(o.state, 'occupied');
  assert.deepEqual(o.who, ['Helen', 'Isaac']);
});

test('empty ONLY when Nick and every resident are positively away', () => {
  assert.equal(home.occupancyFrom(roster({ nick: 'away', helen: 'away', isaac: 'away' })).state, 'empty');
  // one resident unknown -> can't tell, never empty
  assert.equal(home.occupancyFrom(roster({ nick: 'away', helen: 'away', isaac: 'unknown' })).state, 'unknown');
});

test('a failing or stale presence source is unknown, never empty', () => {
  for (const src of [{ state: 'failing', freshness: 'fresh' }, { state: 'healthy', freshness: 'stale' }]) {
    assert.equal(home.occupancyFrom(roster({ nick: 'away', helen: 'away', isaac: 'away' }, src)).state, 'unknown');
  }
  assert.equal(home.occupancyFrom({ known: false }).state, 'unknown');
  assert.equal(home.occupancyFrom(null).state, 'unknown');
});

test('a visitor home makes it occupied; the companion never counts', () => {
  assert.equal(home.occupancyFrom(roster({ nick: 'away', helen: 'away', isaac: 'away', lizzy: 'home' })).state, 'occupied');
});

// ── devices: HA's watchdog, and "cannot see" ≠ "nothing wrong" ─────────────
test('devices come from the watchdog sensors, claiming no duration', () => {
  const d = home.devicesFrom(watchdog(LIVE_OFFLINE, []));
  assert.equal(d.known, true);
  assert.deepEqual(d.offline, LIVE_OFFLINE);
  assert.deepEqual(d.lowBatteries, []);
  assert.equal(d.claimsDuration, false);
});

test('HA unreadable, or no watchdog sensors, is known:false — never "all fine"', () => {
  assert.equal(home.devicesFrom(null).known, false);
  assert.equal(home.devicesFrom([]).known, false);
  const noWatchdog = home.devicesFrom([{ entity_id: 'sensor.x', state: '1', attributes: {} }]);
  assert.equal(noWatchdog.known, false);
  assert.match(noWatchdog.why, /no device watchdog/);
  const both = [{ entity_id: home.WATCHDOG_OFFLINE, state: 'unavailable', attributes: {} }, { entity_id: home.WATCHDOG_BATTERIES, state: 'unknown', attributes: {} }];
  assert.equal(home.devicesFrom(both).known, false);
});

// ── safety: capability, not reassurance ─────────────────────────────────────
test('no hazard sensor in HA is capability "none", not safe', () => {
  const s = home.safetyFrom(watchdog(LIVE_OFFLINE, []));
  assert.equal(s.capability, 'none');
  assert.match(s.why, /cannot see household hazards/);
  assert.equal(home.safetyFrom(null).capability, 'unknown');
});

test('a door/window sensor is not a hazard; smoke / leak are', () => {
  const door = { entity_id: 'binary_sensor.front_door', state: 'on', attributes: { device_class: 'door' } };
  assert.equal(home.safetyFrom(watchdog([], [], [door])).capability, 'none');
  const smoke = { entity_id: 'binary_sensor.landing_smoke', state: 'on', attributes: { device_class: 'smoke', friendly_name: 'Landing smoke' } };
  const leak = { entity_id: 'binary_sensor.boiler_leak', state: 'unavailable', attributes: { device_class: 'moisture', friendly_name: 'Boiler leak' } };
  const s = home.safetyFrom(watchdog([], [], [smoke, leak]));
  assert.equal(s.capability, 'present');
  assert.deepEqual(s.active, [{ label: 'Landing smoke', hazard: 'smoke' }]);
  assert.deepEqual(s.unavailable, [{ label: 'Boiler leak', hazard: 'water leak' }]);
});

// ── 22C obligations: explicit domain only ───────────────────────────────────
test('household tasks are only those classified HOME — the Bathroom (Family) item is not taken', () => {
  const h = home.homeObligations([RADIATOR, TEST_ITEM]);
  assert.deepEqual(h.map((o) => o.what), ['Test reminder to trace route']);
  // positive control: reclassifying the list to Home is all it takes
  const reclassified = { ...RADIATOR, domains: [{ domain: 'home', basis: 'classified' }] };
  assert.equal(home.homeObligations([reclassified]).length, 1);
});

// ── 22F needs-you: narrow ───────────────────────────────────────────────────
test('needs you: a due household task and a reporting hazard — nothing else', () => {
  const due = { ...TEST_ITEM, due: { date: '2026-10-09', label: 'tomorrow' }, needsNow: true, actionState: 'needs_you', needsWhy: 'due tomorrow' };
  const model = home.compose({
    household: roster({ nick: 'home', helen: 'home', isaac: 'home' }),
    states: watchdog(LIVE_OFFLINE, ['Office - Office TRV (12%)']),
    obligations: [due, RADIATOR],
  });
  assert.deepEqual(model.needsYou.map((n) => n.kind), ['obligation']);
  assert.equal(model.needsYou[0].why, 'due tomorrow');
  // offline devices, a low battery and having no hazard sensors are NOT needs-you
  const quiet = home.compose({ household: roster({ nick: 'away', helen: 'home', isaac: 'home' }), states: watchdog(LIVE_OFFLINE, ['x (5%)']), obligations: [TEST_ITEM] });
  assert.deepEqual(quiet.needsYou, []);
  const smoke = { entity_id: 'binary_sensor.s', state: 'on', attributes: { device_class: 'smoke', friendly_name: 'Hall smoke' } };
  assert.deepEqual(home.compose({ states: watchdog([], [], [smoke]) }).needsYou.map((n) => n.kind), ['hazard']);
});

test('arrivals and departures never produce needs-you or activity', () => {
  const a = home.compose({ household: roster({ nick: 'home', helen: 'home', isaac: 'home' }), states: watchdog([], []) });
  const b = home.compose({ household: roster({ nick: 'away', helen: 'away', isaac: 'home' }), states: watchdog([], []) });
  assert.deepEqual(a.needsYou, []);
  assert.deepEqual(b.needsYou, []);
  assert.deepEqual(home.changesBetween(home.snapshotOf(a), home.snapshotOf(b)), []);
});

// ── 22E Radar: household items feed it through the existing obligation path ──
test('a dated Home obligation reaches the Radar with domain home; HA telemetry never does', () => {
  const fr = require('./future-radar');
  const dated = { ...TEST_ITEM, id: 'task:x', what: 'Plumber booked', due: { date: '2026-10-12', label: 'Sunday', kind: 'set', days: 4 } };
  const r = fr.composeRadar({ today: '2026-10-08', horizonDays: 14, obligations: [dated, RADIATOR] });
  const up = home.upcomingFrom(r.items);
  assert.deepEqual(up.map((u) => u.title), ['Plumber booked']);
  const model = home.compose({ states: watchdog(LIVE_OFFLINE, ['x (5%)']), radarItems: r.items });
  assert.ok(model.upcoming.every((u) => !/plug|battery|tv/i.test(u.title)), 'no device telemetry in upcoming');
});

// ── 22I source health ───────────────────────────────────────────────────────
test('sources keep "no capability" apart from "unavailable" and from "nothing happened"', () => {
  const m = home.compose({ household: roster({ nick: 'away', helen: 'home', isaac: 'home' }), states: watchdog([], []),
    remindersHealth: [{ sourceId: 'reminders.saim-ios', state: 'healthy', freshness: 'fresh' }, { sourceId: 'reminders.neuro-ios', state: 'healthy', freshness: 'stale' }] });
  const v = Object.fromEntries(m.sources.map((s) => [s.id, s.verdict]));
  assert.deepEqual(v, { presence: 'seeing', devices: 'seeing', safety: 'no-capability', reminders: 'seeing' });
  const blind = home.compose({ household: { known: false }, states: null });
  const vb = Object.fromEntries(blind.sources.map((s) => [s.id, s.verdict]));
  assert.deepEqual(vb, { presence: 'unavailable', devices: 'unavailable', safety: 'unavailable', reminders: 'unavailable' });
});

// ── 22J activity: semantic, once per episode ────────────────────────────────
test('activity: first pass is a baseline; a newly low battery is one line; a blind read is not "fixed"', () => {
  const s = (over) => ({ haReadable: true, presence: 'seeing', lowBatteries: [], hazards: [], hazardBlind: [], ...over });
  assert.deepEqual(home.changesBetween(null, s()), []);
  assert.deepEqual(home.changesBetween(s(), s({ lowBatteries: ['Office TRV (12%)'] })), [{ kind: 'home-battery-low', detail: { device: 'Office TRV (12%)' } }]);
  assert.deepEqual(home.changesBetween(s({ lowBatteries: ['Office TRV (12%)'] }), s({ lowBatteries: ['Office TRV (12%)'] })), []);
  // HA goes blind: one "lost" line, and the hazard it held is NOT reported cleared
  const lost = home.changesBetween(s({ hazards: ['Hall smoke'] }), s({ haReadable: false }));
  assert.deepEqual(lost.map((c) => c.kind), ['home-source-lost']);
  assert.deepEqual(home.changesBetween(s({ haReadable: false }), s()).map((c) => c.kind), ['home-source-restored']);
  assert.deepEqual(home.changesBetween(s(), s({ presence: 'failing' })).map((c) => c.detail.source), ['presence']);
});

test('activity normaliser renders household lines in words, with no raw entity ids', () => {
  const tl = require('./activity-timeline');
  const rows = [
    { id: 1, kind: 'obligation-opened', at: '2026-10-08T12:00:00.000Z', subject_id: 'task:x', actor: 'neuro', detail_json: JSON.stringify({ title: 'Plumber booked', home: true }) },
    { id: 2, kind: 'home-battery-low', at: '2026-10-08T12:01:00.000Z', subject_id: 'home:x', actor: 'neuro', detail_json: JSON.stringify({ device: 'Office - Office TRV (12%)' }) },
    { id: 3, kind: 'home-source-lost', at: '2026-10-08T12:02:00.000Z', subject_id: 'home:presence', actor: 'neuro', detail_json: JSON.stringify({ source: 'presence' }) },
    { id: 4, kind: 'obligation-opened', at: '2026-10-08T12:03:00.000Z', subject_id: 'task:y', actor: 'neuro', detail_json: JSON.stringify({ title: 'Anniversary card' }) },
  ];
  const out = tl.fromPersonalOps(rows);
  assert.equal(out[0].headline, 'Household task appeared: "Plumber booked"');
  assert.match(out[1].headline, /needs a battery: Office - Office TRV/);
  assert.equal(out[2].headline, 'NEURO lost sight of who is home');
  assert.match(out[3].headline, /^Personal obligation appeared/, 'positive control: a non-home obligation keeps its wording');
  for (const e of out) assert.doesNotMatch(JSON.stringify(e), /binary_sensor\.|sensor\.watchdog/);
});

// ── the real route over HTTP, against a scratch DB and no Home Assistant ────
test('GET /api/household/home answers home-v1 and says it cannot see, rather than "all clear"', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b22-home-'));
  process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
  const db = require('../db/database');
  await db.init();
  const express = require('express');
  const app = express();
  app.use('/api/household', require('../routes/household'));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/household/home`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.contract, 'home-v1');
    assert.equal(j.occupancy.state, 'unknown');
    assert.equal(j.devices.known, false);
    assert.notEqual(j.safety.capability, 'none', 'an unread HA is not "no hazard sensors"');
    assert.deepEqual(j.needsYou, []);
  } finally { server.close(); }
});

// ── the card, rendered for real ─────────────────────────────────────────────
test('the Home card renders the live shape: occupancy words, no-hazard honesty, offline-but-maybe-deliberate', async () => {
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'canonical', 'HomeCard.jsx')],
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
  assert.equal(typeof m.exports.HomeView, 'function', 'positive control: the view is exported');
  const data = home.compose({ household: roster({ nick: 'away', helen: 'home', isaac: 'home' }), states: watchdog(LIVE_OFFLINE, []), obligations: [RADIATOR, TEST_ITEM] });
  const html = renderToString(React.createElement(m.exports.HomeView, { data }));
  assert.match(html, /Occupied/);
  assert.match(html, /Helen and Isaac are home/);
  assert.match(html, /Test reminder to trace route/);
  assert.doesNotMatch(html, /Radiator cover/, 'a Family-classified reminder is not a household task');
  assert.match(html, /cannot see household hazards/);
  assert.match(html, /unplugged on purpose/);
  const blind = renderToString(React.createElement(m.exports.HomeView, { data: home.compose({ household: { known: false }, states: null }) }));
  assert.match(blind, /Can’t tell/);
  assert.match(blind, /This is not “all fine”/);
});
