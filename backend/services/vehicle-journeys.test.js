'use strict';

// Car journeys from Life360, approved by Nick (12 Oct 2026). Pure rules over
// synthetic tracks shaped like the measured ones, then the real store, the
// real vehicle read model and the real routes behind real auth + guard.
// HA is a fake fetch; nothing reaches the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-journeys-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'j.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-jour';
process.env.NEURO_API_TOKEN = 'machine-token-jour';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
delete process.env.HA_URL;
process.env.HA_TOKEN = '';
delete process.env.TALLY_API_URL;
fs.mkdirSync(path.join(tmp, 'vault'), { recursive: true });

const db = require('../db/database');
const veh = require('./vehicle');
const J = require('./vehicle-journeys');
const M = require('./journey-model');

const NOW = Date.now();
const DAY = 86400000;
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const localNoon = (daysAgo) => { const d = new Date(NOW - daysAgo * DAY); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime(); };
const endOfLocalDay = J.endOfLocalDay;

// ── synthetic Life360 history ────────────────────────────────────────────────
const KM_LAT = 1 / 111.32;
function row(t, lat, lon, speed, state = 'not_home') {
  const iso = new Date(t).toISOString();
  return { state, last_updated: iso, attributes: { latitude: lat, longitude: lon, gps_accuracy: 10, speed, driving: speed > 0, last_seen: iso } };
}
/** Parked at `from`, drive north at kmh for `minutes` (a fix every 30 s), parked at `to`. */
function drive(startMs, { lat0 = 52.9, lon = -1.4, minutes = 20, kmh = 60, from = 'home', to = 'Office', parkedAfterMin = 10, gapFrom = null, gapMin = 0 } = {}) {
  const rows = [];
  for (let k = 3; k >= 1; k--) rows.push(row(startMs - k * 60000, lat0, lon, 0, from));
  let lat = lat0;
  const steps = minutes * 2;
  for (let i = 1; i <= steps; i++) {
    lat += (kmh / 120) * KM_LAT;
    const t = startMs + i * 30000;
    if (gapFrom != null && i / 2 > gapFrom && i / 2 <= gapFrom + gapMin) continue; // Life360 went quiet
    rows.push(row(t, lat, lon, kmh, 'driving'));
  }
  const endMs = startMs + steps * 30000;
  for (let k = 1; k <= parkedAfterMin; k++) rows.push(row(endMs + k * 60000, lat + (k % 2 ? 0.00003 : -0.00003), lon, 0, to));
  return rows;
}
const fakeFetch = (rows) => async () => ({ ok: true, json: async () => [rows] });

// ═══ PURE ══════════════════════════════════════════════════════════════════════

test('a 20-minute drive at 60 km/h is one journey of ~12.4 mi, home → Office, with the parked jitter not counted', () => {
  const fx = M.fixesFromHistory(drive(localNoon(2)));
  const segs = M.segment(fx, { readEndMs: NOW });
  assert.equal(segs.length, 1);
  const s = segs[0];
  assert.ok(Math.abs(s.measuredMiles - 12.4) <= 0.2, `measured ${s.measuredMiles}`);
  assert.equal(s.start.place, 'home');
  assert.equal(s.end.place, 'Office');
  assert.equal(s.open, false);
  assert.equal(M.rejectReason(s), null);
});

test('Life360 going quiet mid-drive does not split the journey; a seen 10-minute stop does', () => {
  const quiet = M.segment(M.fixesFromHistory(drive(localNoon(2), { minutes: 30, gapFrom: 10, gapMin: 9 })), { readEndMs: NOW });
  assert.equal(quiet.length, 1, 'a data gap with the car far along is a continuation');
  const t2 = localNoon(2) + 60 * 60000;
  const stopped = M.segment(M.fixesFromHistory([...drive(localNoon(2), { to: 'shop' }), ...drive(t2, { lat0: 53.1, from: 'shop' })]), { readEndMs: NOW });
  assert.equal(stopped.length, 2, 'standing still for 10 minutes ends it');
});

test('a walk is too slow and parked jitter is no journey at all', () => {
  const walk = M.segment(M.fixesFromHistory(drive(localNoon(2), { kmh: 5, minutes: 60 }).map((r) => ({ ...r, attributes: { ...r.attributes, speed: 5 } }))), { readEndMs: NOW });
  assert.ok(walk.every((s) => M.rejectReason(s) !== null), 'never offered');
  const parked = [];
  for (let k = 0; k < 60; k++) parked.push(row(localNoon(2) + k * 60000, 52.9 + (k % 2 ? 0.0001 : 0), -1.4, 0, 'home'));
  assert.equal(M.segment(M.fixesFromHistory(parked), { readEndMs: NOW }).length, 0);
});

test('`driving` is Life360’s state, never a place; a still-going drive is open', () => {
  const fx = M.fixesFromHistory([row(1000, 52, -1, 60, 'driving')]);
  assert.equal(fx[0].place, null);
  const rows = drive(NOW - 15 * 60000, { minutes: 14, parkedAfterMin: 0 });
  const segs = M.segment(M.fixesFromHistory(rows), { readEndMs: NOW });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].open, true);
});

test('estimate = reading + APPROVED journeys after it; pending is reported, never added; a journey before the reading never counts', () => {
  const current = { miles: 143673, observedOn: dayKey(localNoon(3)), observedMs: localNoon(3), provenance: { enteredAt: new Date(localNoon(1)).toISOString() } };
  const since = M.readingMoment(current, { endOfLocalDay });
  assert.equal(since, endOfLocalDay(localNoon(3)), 'entered on a later day → end of the reading’s day');
  const js = [
    { status: 'approved', startedAt: since - 3600000, miles: 50 },
    { status: 'approved', startedAt: since + 3600000, miles: 21.3 },
    { status: 'approved', startedAt: since + 7200000, miles: 20.9 },
    { status: 'pending', startedAt: since + 9000000, measuredMiles: 12 },
    { status: 'rejected', startedAt: since + 9500000, miles: null, measuredMiles: 40 },
  ];
  const e = M.estimate(current, js, { endOfLocalDay });
  assert.equal(e.basis, 'journeys');
  assert.equal(e.miles, 143673 + 42);
  assert.equal(e.approvedCount, 2);
  assert.equal(e.pendingMiles, 12);
  assert.equal(M.estimate(current, [], { endOfLocalDay }).basis, 'odometer');
  assert.equal(M.estimate(null, js, { endOfLocalDay }), null);
});

test('a reading entered the same day it is dated starts the clock at the moment it was entered', () => {
  const entered = localNoon(1) + 5 * 3600000;
  const r = { miles: 1, observedOn: dayKey(entered), observedMs: localNoon(1), provenance: { enteredAt: new Date(entered).toISOString() } };
  assert.equal(M.readingMoment(r, { endOfLocalDay }), entered);
});

test('reconcile: approved miles vs what the odometer measured, only for windows after tracking began', () => {
  const a = { miles: 1000, observedOn: dayKey(localNoon(6)), observedMs: localNoon(6), provenance: null };
  const b = { miles: 1100, observedOn: dayKey(localNoon(2)), observedMs: localNoon(2), provenance: null };
  const js = [{ status: 'approved', startedAt: localNoon(4), miles: 60 }, { status: 'pending', startedAt: localNoon(4) + 1, miles: null }];
  const r = M.reconcile([a, b], js, { trackingSince: localNoon(7), endOfLocalDay });
  assert.equal(r.length, 1);
  assert.equal(r[0].coverage, 60);
  assert.equal(r[0].unaccounted, 40);
  assert.equal(M.reconcile([a, b], js, { trackingSince: localNoon(5), endOfLocalDay }).length, 0, 'a window that began before tracking is not judged');
});

// ═══ STORE + ROUTES ═══════════════════════════════════════════════════════════

let server;
let base;
const PIN = { 'X-NEURO-PIN': 'pin-jour', 'Content-Type': 'application/json' };
const MACHINE = { 'X-NEURO-API-TOKEN': 'machine-token-jour', 'Content-Type': 'application/json' };
async function call(method, p, body, headers = PIN) {
  const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const rowCounts = () => db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((t) => `${t.name}:${db.get(`SELECT COUNT(*) AS n FROM "${t.name}"`).n}`).join('|');
const CAPTUR = 'vehicle:captur';

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api', require('./api-auth'));
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/vehicle', require('../routes/vehicle'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(veh.createVehicle({ make: 'Renault', model: 'Captur' }).ok, true);
  assert.equal(veh.addMileage(CAPTUR, { value: 143673, observedOn: dayKey(localNoon(3)) }).ok, true);
});
test.after(() => { server && server.close(); });

let first;
test('sync: tracking starts at the latest reading; a finished drive after it is stored PENDING, a drive before it is not, an open one waits', async () => {
  const before = drive(localNoon(4));                                  // before the reading — not asked about
  const one = drive(localNoon(2));                                     // 12.4 mi
  const two = drive(localNoon(1), { lat0: 53.2, minutes: 30, from: 'Office', to: 'home' }); // ~18.6 mi
  const open = drive(NOW - 15 * 60000, { lat0: 53.5, minutes: 14, parkedAfterMin: 0 });
  process.env.HA_URL = 'http://ha.test'; process.env.HA_TOKEN = 'fake';
  const r = await J.sync({ now: NOW, fetchImpl: fakeFetch([...before, ...one, ...two, ...open]) });
  assert.equal(r.ok, true);
  assert.equal(r.detectedCount, 2);
  assert.equal(r.skipped.open, 1);
  assert.equal(r.skipped.beforeTracking, 1);
  const pend = J.list({ status: 'pending' });
  assert.equal(pend.length, 2);
  assert.ok(pend.every((j) => j.vehicleId === CAPTUR));
  first = pend.find((j) => j.startedAt < localNoon(1));
  // Idempotent: the same history again stores nothing new.
  const again = await J.sync({ now: NOW + 60000, fetchImpl: fakeFetch([...one, ...two]) });
  assert.equal(again.detectedCount, 0);
  assert.equal(J.list({ status: 'all' }).length, 2);
});

test('a drive the read window cut in half is never stored as a new journey (live, 12 Oct 2026)', async () => {
  const whole = drive(localNoon(2) + 3 * 3600000, { lat0: 53.6, minutes: 30 });
  const cut = whole.slice(25); // starts mid-drive: no parked fix before the moving ones
  const segs = M.segment(M.fixesFromHistory(cut), { readEndMs: NOW });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].truncated, true);
  assert.equal(M.segment(M.fixesFromHistory(whole), { readEndMs: NOW })[0].truncated, false, 'positive control');
  const before = J.list({ status: 'all' }).length;
  const r = await J.sync({ now: NOW, fetchImpl: fakeFetch(cut), from: localNoon(2) + 3 * 3600000 });
  assert.equal(r.skipped.truncated, 1);
  assert.equal(r.detectedCount, 0);
  assert.equal(J.list({ status: 'all' }).length, before);
});

test('Home Assistant unreadable is a FAILED pass, never "no journeys"', async () => {
  const r = await J.sync({ now: NOW, fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /500/);
  delete process.env.HA_URL; process.env.HA_TOKEN = '';
  const route = await call('POST', '/api/vehicle/journeys/sync', {});
  assert.equal(route.status, 502, 'HA_URL is unset here — the route must say so, not answer 200');
  assert.equal(route.json.reason, 'not-configured');
  const v = veh.read(CAPTUR);
  assert.equal(v.journeys.lastSync.ok, false);
});

test('pending journeys add nothing; approving one moves the ESTIMATE and writes no odometer reading', async () => {
  let v = veh.read(CAPTUR);
  assert.equal(v.mileage.estimate.basis, 'odometer');
  assert.equal(v.mileage.estimate.pendingCount, 2);
  assert.equal(v.journeys.pending.length, 2);
  const readingsBefore = db.get('SELECT COUNT(*) AS n FROM vehicle_mileage').n;
  const ap = await call('POST', `/api/vehicle/journeys/${encodeURIComponent(first.id)}/approve`, {});
  assert.equal(ap.status, 200);
  assert.equal(ap.json.journey.status, 'approved');
  v = veh.read(CAPTUR);
  assert.equal(v.mileage.estimate.basis, 'journeys');
  assert.equal(v.mileage.estimate.miles, Math.round(143673 + first.measuredMiles));
  assert.equal(v.mileage.current.miles, 143673, 'the odometer fact is unchanged');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM vehicle_mileage').n, readingsBefore, 'no reading was written');
});

test('approve with corrected miles; refuse nonsense; reject needs a reason; reopen undoes', async () => {
  const other = J.list({ status: 'pending' })[0];
  assert.equal((await call('POST', `/api/vehicle/journeys/${encodeURIComponent(other.id)}/approve`, { miles: -3 })).status, 400);
  assert.equal((await call('POST', `/api/vehicle/journeys/${encodeURIComponent(other.id)}/reject`, { reason: 'boring' })).status, 400);
  const ok = await call('POST', `/api/vehicle/journeys/${encodeURIComponent(other.id)}/approve`, { miles: 19.04 });
  assert.equal(ok.json.journey.miles, 19);
  assert.equal(ok.json.journey.edited, true);
  const est = veh.read(CAPTUR).mileage.estimate;
  assert.equal(est.miles, Math.round(143673 + first.measuredMiles + 19));
  const rj = await call('POST', `/api/vehicle/journeys/${encodeURIComponent(other.id)}/reject`, { reason: 'not-the-car' });
  assert.equal(rj.json.journey.status, 'rejected');
  assert.equal(veh.read(CAPTUR).mileage.estimate.approvedCount, 1, 'a rejected journey counts for nothing');
  const ro = await call('POST', `/api/vehicle/journeys/${encodeURIComponent(other.id)}/reopen`, {});
  assert.equal(ro.json.journey.status, 'pending');
  assert.equal((await call('POST', '/api/vehicle/journeys/vj:life360:1/approve', {})).status, 404);
});

test('a machine cannot approve, reject, reopen or sync', async () => {
  const p = J.list({ status: 'pending' })[0];
  for (const [m, url, body] of [
    ['POST', `/api/vehicle/journeys/${encodeURIComponent(p.id)}/approve`, {}],
    ['POST', `/api/vehicle/journeys/${encodeURIComponent(p.id)}/reject`, { reason: 'not-the-car' }],
    ['POST', `/api/vehicle/journeys/${encodeURIComponent(p.id)}/reopen`, {}],
    ['POST', '/api/vehicle/journeys/sync', {}],
  ]) assert.equal((await call(m, url, body, MACHINE)).status, 403, url);
  assert.equal((await call('GET', '/api/vehicle/journeys', null, MACHINE)).status, 200, 'reading is fine');
});

test('a service due by mileage is judged against the estimate and says so; reading the vehicle writes nothing', async () => {
  const add = veh.addObligation(CAPTUR, { type: 'service', dueMileage: 143700 });
  assert.equal(add.ok, true);
  const before = rowCounts();
  const v = veh.read(CAPTUR);
  assert.equal(rowCounts(), before, 'read is read-only');
  const svc = v.obligations.find((o) => o.type === 'service');
  assert.equal(svc.dueBy, 'mileage');
  assert.match(svc.statusWhy, /estimated/);
});

test('render: pending journeys can be approved / rejected on the Transport card, and the estimate says it is one', async () => {
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  const esbuild = require('esbuild');
  const ROOT = path.join(__dirname, '..', '..');
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'frontend', 'src', 'components', 'canonical', 'TransportCard.jsx')],
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
  assert.equal(typeof m.exports.TransportView, 'function', 'positive control: the view is exported');
  const data = await require('./transport').read({ now: NOW, phone: null });
  assert.equal(data.vehicles[0].journeys.pending.length, 1, 'fixture: one waiting, one approved');
  const html = renderToString(React.createElement(m.exports.TransportView, { data })).split('<!-- -->').join('');
  assert.match(html, /Journeys/);
  assert.match(html, /1 to approve/);
  assert.match(html, />Approve</);
  assert.match(html, />Not the car</);
  assert.match(html, />Not a journey</);
  assert.match(html, /≈ [\d,]+ mi now/);
  assert.match(html, /an estimate until the next odometer reading/);
  assert.match(html, /143,673 mi/, 'the odometer reading is still shown as itself');
});

test('evening nudge: silent with nothing waiting, one push when something is, never twice a day', async () => {
  const sent = [];
  const push = async (t, b, d) => sent.push({ t, b, d });
  const pend = J.list({ status: 'pending' });
  assert.ok(pend.length >= 1, 'fixture: something is waiting');
  const a = await J.nudge({ now: NOW, push });
  assert.equal(a.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].d.type, 'journeys');
  assert.match(sent[0].b, /waiting — they don’t count towards the mileage until you approve them/);
  assert.equal((await J.nudge({ now: NOW + 60000, push })).sent, false, 'once a day');
  assert.equal(sent.length, 1);
  for (const j of pend) J.reject(j.id, { reason: 'not-a-journey' });
  const b = await J.nudge({ now: NOW + 2 * DAY, push });
  assert.equal(b.sent, false);
  assert.equal(b.why, 'nothing waiting');
  assert.equal(sent.length, 1);
});

test('a quiet Life360 before the drive still names the start: the nearest zone fix within 300 m, however old (13 Oct 2026)', () => {
  const t0 = localNoon(2);
  // "home" 69 minutes before the first moving fix, ~85 m away — the live shape.
  const rows = [row(t0 - 69 * 60000, 52.7370, -1.3499, 0, 'home')];
  let lat = 52.7377;
  for (let i = 0; i < 40; i++) { rows.push(row(t0 + i * 30000, lat, -1.3491, 60, 'driving')); lat += 0.5 * KM_LAT; }
  for (let k = 1; k <= 8; k++) rows.push(row(t0 + 40 * 30000 + k * 60000, lat, -1.3491, 0, 'Office'));
  const segs = M.segment(M.fixesFromHistory(rows), { readEndMs: NOW });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].start.place, 'home');
  assert.equal(segs[0].end.place, 'Office');
  // Negative: a zone fix 2 km from where the drive began is not where it began.
  const far = [row(t0 - 69 * 60000, 52.7190, -1.3499, 0, 'home'), ...rows.slice(1)];
  assert.equal(M.segment(M.fixesFromHistory(far), { readEndMs: NOW })[0].start.place, null);
});
