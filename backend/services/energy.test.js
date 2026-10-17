'use strict';

// Home energy (Bright / Glowmarkt). A fake Glowmarkt answers through
// `fetchImpl`; storage is a real scratch SQLite. No network.

const path = require('path');
const os = require('os');
const fs = require('fs');
process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-energy-')), 'a.db');
delete process.env.BRIGHT_USERNAME;
delete process.env.BRIGHT_PASSWORD;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db/database');
const glow = require('./energy-glowmarkt');
const model = require('./energy-model');
const energy = require('./energy');

const PASSWORD = 'correct-horse-battery-staple-7731';
const RES = {
  ve: 've-1',
  elec: 'r-elec', elecCost: 'r-elec-cost', gas: 'r-gas', gasCost: 'r-gas-cost',
};

/** A fake Glowmarkt. `value(resourceId, ts)` → number|null; `first` epoch s. */
function fakeBright(opts = {}) {
  const calls = { auth: 0, readings: 0, catchup: 0, log: [] };
  const state = {
    password: opts.password || PASSWORD,
    first: opts.first || null,
    value: opts.value || ((id, ts) => (id.endsWith('-cost') ? 5 : 0.25)),
    expired: new Set(),
    tariffs: opts.tariffs || [],
    tokenN: 0,
    lastTs: opts.lastTs || null,
  };
  const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const p = u.pathname.replace('/api/v0-1', '');
    calls.log.push(`${init.method || 'GET'} ${p}`);
    if (p === '/auth') {
      calls.auth += 1;
      const b = JSON.parse(init.body);
      if (b.password !== state.password) return reply(401, { valid: false });
      state.tokenN += 1;
      return reply(200, { valid: true, token: `tok-${state.tokenN}`, exp: Math.floor(Date.now() / 1000) + 7 * 86400 });
    }
    const tok = init.headers && init.headers.token;
    if (!tok || state.expired.has(tok)) return reply(401, { error: 'unauthorised' });
    if (p === '/virtualentity') return reply(200, [{ veId: RES.ve, resources: [] }]);
    if (p === `/virtualentity/${RES.ve}/resources`) {
      return reply(200, { resources: [
        { resourceId: RES.elec, classifier: 'electricity.consumption', baseUnit: 'kWh', name: 'electricity' },
        { resourceId: RES.elecCost, classifier: 'electricity.consumption.cost', baseUnit: 'pence' },
        { resourceId: RES.gas, classifier: 'gas.consumption', baseUnit: 'kWh' },
        { resourceId: RES.gasCost, classifier: 'gas.consumption.cost', baseUnit: 'pence' },
        { resourceId: 'r-exp', classifier: 'electricity.export', baseUnit: 'kWh' },
      ] });
    }
    const m = /^\/resource\/([^/]+)\/(readings|first-time|last-time|catchup|tariff-list)$/.exec(p);
    if (m) {
      const [, id, what] = m;
      if (what === 'catchup') { calls.catchup += 1; return reply(200, { data: { valid: true } }); }
      if (what === 'first-time') return state.first ? reply(200, { data: { firstTs: state.first } }) : reply(404, 'not found');
      if (what === 'last-time') return reply(200, { data: { lastTs: state.lastTs } });
      if (what === 'tariff-list') return reply(200, { data: state.tariffs });
      calls.readings += 1;
      assert.equal(u.searchParams.get('nulls'), '1', 'readings must be asked with nulls=1');
      assert.equal(u.searchParams.get('offset'), '0', 'readings must be asked in UTC');
      const from = Date.parse(`${u.searchParams.get('from')}Z`) / 1000;
      const to = Date.parse(`${u.searchParams.get('to')}Z`) / 1000;
      const data = [];
      for (let t = Math.ceil(from / 1800) * 1800; t <= to; t += 1800) {
        if (state.first && t < state.first) continue;
        if (t * 1000 > Date.now()) continue;
        data.push([t, state.value(id, t)]);
      }
      return reply(200, { status: 'OK', units: id.endsWith('-cost') ? 'pence' : 'kWh', data });
    }
    return reply(404, 'nope');
  }
  return { fetchImpl, calls, state };
}

const noSleep = async () => {};

function resetEnergy() {
  for (const t of ['energy_readings', 'energy_resources', 'energy_sync', 'energy_tariffs']) db.run(`DELETE FROM ${t}`);
  for (const k of ['bright_credentials', 'bright_token', 'bright_auth_state', 'energy_settings', 'energy_alerts_sent']) db.setState(k, '');
}

test.before(async () => { await db.init(); });

// ── Pure model ───────────────────────────────────────────────────────────────

test('London days: 46 / 50 / 48 half-hours across the clock changes', () => {
  assert.equal(model.slotsOfDay('2026-03-29').length, 46);
  assert.equal(model.slotsOfDay('2026-10-25').length, 50);
  assert.equal(model.slotsOfDay('2026-07-14').length, 48);
  // BST midnight is 23:00 UTC the day before.
  assert.equal(new Date(model.slotsOfDay('2026-07-14')[0] * 1000).toISOString(), '2026-07-13T23:00:00.000Z');
});

test('rollup: a 50-slot autumn day is complete only with all 50, and a NULL slot is missing, not zero', () => {
  const slots = new Map(model.slotsOfDay('2026-10-25').map((t) => [t, 0.5]));
  let [d] = model.rollupDays(slots, '2026-10-25', '2026-10-25');
  assert.equal(d.complete, true);
  assert.equal(d.expected, 50);
  assert.equal(d.kwh, 25);
  slots.set(model.slotsOfDay('2026-10-25')[10], null);
  [d] = model.rollupDays(slots, '2026-10-25', '2026-10-25');
  assert.equal(d.complete, false);
  assert.equal(d.present, 49);
  assert.equal(d.kwh, 24.5);
  [d] = model.rollupDays(new Map(), '2026-10-26', '2026-10-26');
  assert.equal(d.kwh, null, 'no readings is null, never 0');
});

test('units: kWh and Wh normalise; cubic metres need a calorific value and are never guessed', () => {
  assert.equal(model.toKwh(1.5, 'kWh').kwh, 1.5);
  assert.equal(model.toKwh(1500, 'Wh').kwh, 1.5);
  assert.equal(model.toKwh(2, 'm3').kwh, null);
  assert.match(model.toKwh(2, 'm³').basis, /calorific/);
  assert.equal(model.round(model.toKwh(2, 'm3', { gasCalorificValue: 39.5 }).kwh, 3), 22.441);
  assert.equal(model.toKwh(1, 'furlongs').kwh, null);
});

test('tariffs: flat parses; time-of-use and dynamic are kept but not flat; manual beats meter on the same date', () => {
  const flat = model.parseBrightTariff({ id: 'a', plan: [{ planDetail: [{ rate: 24.5 }, { standing: '53.35' }] }], effectiveDate: '2026-09-01 00:00:00' });
  assert.deepEqual([flat.unitRateP, flat.standingPDay, flat.flat, flat.effectiveFrom], [24.5, 53.35, true, '2026-09-01']);
  const tou = model.parseBrightTariff({ id: 'b', plan: [{ planDetail: [{ standing: 25 }, { tier: 1, rate: '16.26' }, { tier: 2, tourate: '5', time: '20:30-00:00' }] }], from: '2026-10-01 00:00:00' });
  assert.equal(tou.flat, false);
  const dyn = model.parseBrightTariff({ id: 'c', plan: [{ planDetail: [{ standing: 25 }, { dynamic: 'X' }] }], from: '2026-10-05' });
  assert.equal(dyn.flat, false);
  const list = [
    { fuel: 'gas', source: 'meter', effectiveFrom: '2026-09-01', unitRateP: 6, standingPDay: 30, flat: true },
    { fuel: 'gas', source: 'manual', effectiveFrom: '2026-09-01', unitRateP: 7, standingPDay: 31, flat: true },
    { fuel: 'gas', source: 'meter', effectiveFrom: '2026-10-01', unitRateP: 8, standingPDay: 32, flat: true },
  ];
  assert.equal(model.tariffOn(list, 'gas', '2026-09-15').unitRateP, 7, 'manual wins a tie');
  assert.equal(model.tariffOn(list, 'gas', '2026-10-01').unitRateP, 8, 'tariff change takes effect on its date');
  assert.equal(model.tariffOn(list, 'gas', '2026-08-31'), null, 'before any tariff there is none — never a guess');
  assert.equal(model.tariffOn(list, 'electricity', '2026-10-01'), null);
});

test('cost: units × rate + standing; no tariff or a non-flat one is null WITH a reason', () => {
  const c = model.costOfDay(10, { flat: true, unitRateP: 24.5, standingPDay: 53.35, source: 'meter', effectiveFrom: '2026-09-01' });
  assert.equal(model.round(c.pence, 2), 298.35);
  assert.equal(model.costOfDay(10, null).pence, null);
  assert.match(model.costOfDay(10, null).why, /no tariff/);
  assert.equal(model.costOfDay(10, { flat: false, unitRateP: 1, standingPDay: 1 }).pence, null);
  assert.equal(model.validateManualTariff({ fuel: 'gas', effectiveFrom: '2026-01-01', unitRateP: 900, standingPDay: 30 }).ok, false, 'refused, not clamped');
});

test('weather fit and the gas judge: refuses without history or a real relationship; flags a clear excess', () => {
  const days = [];
  for (let i = 0; i < 60; i++) {
    const hdd = (i % 12);
    days.push({ day: model.addDays('2026-01-01', i), complete: true, hdd, kwh: 10 + 4 * hdd + ((i % 3) - 1) });
  }
  const fit = model.fitGasWeather(days);
  assert.ok(fit.r2 > 0.9);
  assert.ok(Math.abs(fit.kwhPerDegreeDay - 4) < 0.2);
  assert.equal(model.judgeGasDay({ day: 'x', complete: true, hdd: 10, kwh: 52 }, fit).unusual, false);
  const hot = model.judgeGasDay({ day: 'x', complete: true, hdd: 10, kwh: 80 }, fit);
  assert.equal(hot.unusual, true);
  assert.ok(hot.pctAbove > 50);
  assert.equal(model.judgeGasDay({ day: 'x', complete: false, hdd: 10, kwh: 999 }, fit).unusual, false, 'a partial day is never judged');
  assert.equal(model.fitGasWeather(days.slice(0, 10)), null, 'under 28 days: no baseline');
  const noise = days.map((d, i) => ({ ...d, kwh: 30 + ((i * 37) % 23) }));
  assert.match(model.judgeGasDay({ day: 'x', complete: true, hdd: 5, kwh: 90 }, model.fitGasWeather(noise)).why, /does not follow the weather/);
});

test('electricity judge: against its own last 28 complete days', () => {
  const hist = Array.from({ length: 30 }, (_, i) => ({ day: model.addDays('2026-08-01', i), complete: true, kwh: 9 + (i % 3) }));
  assert.equal(model.judgeElectricityDay({ day: '2026-09-01', complete: true, kwh: 11 }, hist).unusual, false);
  assert.equal(model.judgeElectricityDay({ day: '2026-09-01', complete: true, kwh: 25 }, hist).unusual, true);
  assert.match(model.judgeElectricityDay({ day: '2026-09-01', complete: true, kwh: 25 }, hist.slice(0, 5)).why, /not enough history/);
});

// ── Auth and credentials ─────────────────────────────────────────────────────

test('connect: a wrong password stores NOTHING; a right one stores it, discovers four resources, ignores export', async () => {
  resetEnergy();
  const fake = fakeBright();
  const bad = await glow.connect('nick@example.com', 'wrong', { fetchImpl: fake.fetchImpl });
  assert.equal(bad.ok, false);
  assert.equal(glow.credentials(), null);
  assert.equal(glow.authState().configured, false);
  const ok = await glow.connect('nick@example.com', PASSWORD, { fetchImpl: fake.fetchImpl, sleep: noSleep });
  assert.equal(ok.ok, true);
  assert.equal(ok.resources.length, 4);
  assert.deepEqual(ok.ignored, ['electricity.export']);
  assert.equal(glow.credentialSource(), 'stored');
  const shown = JSON.stringify(glow.authState());
  assert.ok(!shown.includes(PASSWORD) && !shown.includes('tok-'), 'auth state never carries a secret');
});

test('token: reused while valid, renewed a day before expiry, one re-login on a mid-session 401', async () => {
  resetEnergy();
  const fake = fakeBright();
  await glow.connect('nick@example.com', PASSWORD, { fetchImpl: fake.fetchImpl, sleep: noSleep });
  const before = fake.calls.auth;
  await glow.get('/virtualentity', { fetchImpl: fake.fetchImpl, sleep: noSleep });
  await glow.get('/virtualentity', { fetchImpl: fake.fetchImpl, sleep: noSleep });
  assert.equal(fake.calls.auth, before, 'a valid token is reused');
  // 6.5 days later: inside the one-day renewal margin.
  await glow.get('/virtualentity', { fetchImpl: fake.fetchImpl, sleep: noSleep, nowMs: Date.now() + 6.5 * 86400 * 1000 });
  assert.equal(fake.calls.auth, before + 1, 'renewed a day before expiry');
  // Bright revokes the token early → exactly one re-login, then success.
  fake.state.expired.add(`tok-${fake.state.tokenN}`);
  const r = await glow.get('/virtualentity', { fetchImpl: fake.fetchImpl, sleep: noSleep });
  assert.ok(Array.isArray(r));
  assert.equal(fake.calls.auth, before + 2);
});

test('a rejected login is recorded and NOTHING retries it until the credentials change', async () => {
  resetEnergy();
  const fake = fakeBright();
  await glow.connect('nick@example.com', PASSWORD, { fetchImpl: fake.fetchImpl, sleep: noSleep });
  fake.state.password = 'changed-on-bright';
  db.setState('bright_token', '');
  await assert.rejects(glow.get('/virtualentity', { fetchImpl: fake.fetchImpl, sleep: noSleep }), (e) => e.code === 'auth');
  assert.equal(glow.blockedReason(), 'login-rejected');
  const n = fake.calls.auth;
  const r = await energy.syncRecent({ fetchImpl: fake.fetchImpl, sleep: noSleep });
  assert.equal(r.blocked, true);
  assert.equal(fake.calls.auth, n, 'blocked: no further login attempt');
  // New credentials lift it.
  fake.state.password = 'new-password-1';
  assert.equal((await glow.connect('nick@example.com', 'new-password-1', { fetchImpl: fake.fetchImpl, sleep: noSleep })).ok, true);
  assert.equal(glow.blockedReason(), null);
});

// ── Storage, sync, backfill ──────────────────────────────────────────────────

test('store outcomes: stored / missing / filled / revised / kept / duplicate', () => {
  resetEnergy();
  energy.saveResources([{ resourceId: 'x', fuel: 'electricity', kind: 'consumption', classifier: 'electricity.consumption', baseUnit: 'kWh' }]);
  const res = energy.resources({ fuel: 'electricity' })[0];
  const t = 1790000000 - (1790000000 % 1800);
  let s = energy.storeReadings(res, [{ startTs: t, value: 0.3 }, { startTs: t + 1800, value: null }]);
  assert.deepEqual([s.stored, s.missing], [1, 1]);
  s = energy.storeReadings(res, [{ startTs: t, value: 0.3 }, { startTs: t + 1800, value: 0.2 }]);
  assert.deepEqual([s.duplicate, s.filled], [1, 1]);
  s = energy.storeReadings(res, [{ startTs: t, value: 0.35 }, { startTs: t + 1800, value: null }]);
  assert.deepEqual([s.revised, s.kept], [1, 1]);
  const row = db.get('SELECT value, previous_value, revision FROM energy_readings WHERE resource_id = ? AND start_ts = ?', ['x', t]);
  assert.deepEqual([row.value, row.previous_value, row.revision], [0.35, 0.3, 1]);
  assert.equal(db.get('SELECT value FROM energy_readings WHERE start_ts = ?', [t + 1800]).value, 0.2, 'Bright going quiet does not erase a held reading');
});

test('sync: repeat ingestion stores nothing twice; gas and electricity are separate health runs', async () => {
  resetEnergy();
  const fake = fakeBright({ value: (id, ts) => (id === RES.gas && ts > Date.now() / 1000 - 3600 * 30 ? null : (id.endsWith('-cost') ? 4 : 0.5)) });
  await glow.connect('nick@example.com', PASSWORD, { fetchImpl: fake.fetchImpl, sleep: noSleep });
  const a = await energy.syncRecent({ fetchImpl: fake.fetchImpl, sleep: noSleep });
  assert.equal(a.ok, true);
  assert.ok(a.electricity.stored > 0);
  assert.ok(a.gas.missing > 0, 'recent gas slots Bright has not got are stored as missing');
  const count = db.get('SELECT COUNT(*) AS n FROM energy_readings').n;
  const b = await energy.syncRecent({ fetchImpl: fake.fetchImpl, sleep: noSleep, force: true });
  assert.equal(b.electricity.stored, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM energy_readings').n, count, 'no duplicates');
  assert.ok(fake.calls.catchup >= 2, 'asks Bright to catch up from the DCC');
  const health = require('./source-health');
  await require('./event-bus').pumpConsumer(health.CONSUMER);
  assert.equal(health.getSource('energy.bright-electricity').state, 'healthy');
  assert.equal(health.getSource('energy.bright-gas').state, 'healthy', 'delayed data is not a failing source');
});

test('backfill: walks back to first-time in checkpointed chunks, resumes, and reopens if Bright finds older history', async () => {
  resetEnergy();
  const nowS = Math.floor(Date.now() / 1000);
  const first = Math.floor((nowS - 25 * 86400) / 1800) * 1800;
  const fake = fakeBright({ first });
  await glow.connect('nick@example.com', PASSWORD, { fetchImpl: fake.fetchImpl, sleep: noSleep });
  const r1 = await energy.backfillStep({ fetchImpl: fake.fetchImpl, sleep: noSleep, maxChunks: 1 });
  assert.equal(r1['electricity-consumption'].complete, false);
  const cursor1 = energy.syncState(RES.elec).backfill.cursor;
  // "restart": a fresh step continues from the persisted cursor.
  await energy.backfillStep({ fetchImpl: fake.fetchImpl, sleep: noSleep, maxChunks: 10 });
  const bf = energy.syncState(RES.elec).backfill;
  assert.ok(bf.cursor < cursor1);
  assert.equal(bf.complete, true);
  assert.equal(bf.cursor, first);
  // Bright populates more history; the daily first-time re-check reopens it.
  fake.state.first = first - 5 * 86400;
  await energy.backfillStep({ fetchImpl: fake.fetchImpl, sleep: noSleep, maxChunks: 10, nowMs: Date.now() + 25 * 3600 * 1000 });
  const bf2 = energy.syncState(RES.elec).backfill;
  assert.equal(bf2.complete, true);
  assert.equal(bf2.cursor, first - 5 * 86400);
  const oldest = db.get('SELECT MIN(start_ts) AS a FROM energy_readings WHERE resource_id = ?', [RES.elec]).a;
  assert.equal(oldest, first - 5 * 86400);
});

test('read model: costs need a tariff; Bright\'s own cost is kept beside NEURO\'s, never mixed in', async () => {
  resetEnergy();
  const fake = fakeBright({ tariffs: [{ id: 't1', plan: [{ planDetail: [{ rate: 20 }, { standing: 50 }] }], effectiveDate: '2020-01-01 00:00:00' }] });
  await glow.connect('nick@example.com', PASSWORD, { fetchImpl: fake.fetchImpl, sleep: noSleep });
  await energy.syncRecent({ fetchImpl: fake.fetchImpl, sleep: noSleep });
  let r = energy.read();
  const y = r.fuels.electricity.yesterday;
  assert.equal(y.complete, true);
  assert.equal(y.kwh, y.expected * 0.25);
  assert.equal(y.costP, null);
  assert.match(y.costWhy, /no tariff/);
  await energy.syncTariffs({ fetchImpl: fake.fetchImpl, sleep: noSleep });
  r = energy.read();
  const y2 = r.fuels.electricity.yesterday;
  assert.equal(y2.costP, model.round(y2.kwh * 20 + 50, 1));
  assert.equal(y2.brightP, y2.expected * 5, 'Bright\'s figure carried separately');
  assert.match(r.labels.cost, /not a bill/i);
  assert.ok(!JSON.stringify(r).includes(PASSWORD));
});

test('alerts: a clearly unusual complete day pushes once, never twice', async () => {
  resetEnergy();
  const today = model.londonDay(Date.now());
  const spike = model.addDays(today, -1);
  energy.saveResources([{ resourceId: 'e', fuel: 'electricity', kind: 'consumption', classifier: 'electricity.consumption', baseUnit: 'kWh' }]);
  const res = energy.resources()[0];
  const rows = [];
  for (const d of model.dayRange(model.addDays(today, -40), spike)) {
    for (const t of model.slotsOfDay(d)) rows.push({ startTs: t, value: d === spike ? 1.2 : 0.2 + ((t / 1800) % 3) * 0.01 });
  }
  energy.storeReadings(res, rows);
  const pushes = [];
  const push = async (title, body, data) => { pushes.push({ title, body, data }); };
  const a = await energy.alertPass({ push });
  assert.equal(a.sent.length, 1);
  assert.equal(pushes[0].data.type, 'energy_unusual');
  assert.match(pushes[0].body, /Electricity on .*kWh — about \d+% above your usual day/);
  await energy.alertPass({ push });
  assert.equal(pushes.length, 1, 'once per fuel per day');
});
