'use strict';

/**
 * Build 27 — Transport intelligence, and the end of NEURO's vehicle finance.
 *
 * Real scratch DB, real routes over HTTP behind the real api-auth + authority
 * guard. Tally's `vehicleFinance` section is copied field for field from the
 * live rehearsal (9 Oct 2026, Tally Build 27 on a copy of the real ledger) and
 * stored the way finance.js stores the contract. Anything that could notify is
 * stubbed to THROW. Numbering follows the Build 27 test list in the brief.
 * Build 21's identity / mileage / obligation / official tests live on here; its
 * Tally-reader tests were deleted with the reader.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b27-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'b27.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-2727';
process.env.NEURO_API_TOKEN = 'machine-token-27';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
process.env.HA_TOKEN = '';
delete process.env.DVLA_VES_API_KEY;
delete process.env.TALLY_API_URL;
fs.mkdirSync(path.join(tmp, 'vault'), { recursive: true });

function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
const boom = (what) => async () => { throw new Error(`${what} reached from a Build 27 flow`); };
stub('./webpush', { sendToAll: boom('webpush.sendToAll'), isConfigured: () => true });
stub('./email-sender', { sendMail: boom('email-sender.sendMail'), sendBriefEmail: boom('email-sender.sendBriefEmail'), OWN_ADDRESS: 'nickw@nurtur.tech' });

const db = require('../db/database');
const veh = require('./vehicle');
const transport = require('./transport');
const po = require('./personal-obligations');
const radar = require('./future-radar');
const PA = require('./personal-admin');
const fin = require('./finance');
const store = require('./task-store');
const T = {};

const NOW = Date.now();
const TODAY = veh.localDay(NOW);
const plus = (n) => { const d = new Date(`${TODAY}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const month = (n) => { const d = new Date(`${TODAY.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const end = (m) => { const d = new Date(`${m}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); };
const CAPTUR = 'vehicle:captur';

// ── Tally's vehicleFinance section (shape copied from the live rehearsal) ────
const bucket = (fuel, other = 0) => ({ fuelSpendPence: fuel, insuranceSpendPence: 0, financeRepaymentsPence: 0, maintenanceSpendPence: 0, repairsSpendPence: 0,
  taxSpendPence: 0, breakdownSpendPence: 0, otherMotoringSpendPence: other, totalVehicleSpendPence: fuel + other });
function vehicleFinance({ trend = 'insufficient_data', w3 = true, pending = 0 } = {}) {
  const lc = { month: month(-1), complete: true, ledgerComplete: true, pendingReview: 0, reasons: [], transactions: 6, ...bucket(9798, 350) };
  return {
    meta: { period: `${month(-9)} – ${month(0)}`, source: 'tally', freshness: { state: 'healthy', asOf: `${TODAY}T05:00:00.000Z`, why: 'every bank feed refreshed in the last 2 days' },
      confidence: pending ? 'partial' : 'strong', explanation: ['Vehicle spend is what a person said is the car\'s in Tally (Outlook → Motoring)…'], coverage: '67 car transactions classified' },
    reviewIn: 'Tally → Outlook → Motoring',
    vehicles: [{
      vehicleRef: CAPTUR, confidence: pending ? 'partial' : 'strong', explanation: ['Counted only when a person said a transaction is the car\'s…'],
      classified: { transactions: 67, byDecision: 17, byRule: 50 },
      currentMonth: { month: month(0), complete: false, ledgerComplete: false, pendingReview: 0, reasons: ['Nick data runs only to yesterday'], transactions: 1, ...bucket(130) },
      latestCompleteMonth: lc, months: [lc],
      last3CompleteMonths: w3 ? { months: 3, available: true, why: null, from: `${month(-3)}-01`, to: end(month(-1)), transactions: 24, ...bucket(40837, 1050) }
        : { months: 3, available: false, why: 'needs 3 complete months in a row; 2 available', from: null, to: null },
      last6CompleteMonths: { months: 6, available: false, why: 'needs 6 complete months in a row; 3 available', from: null, to: null },
      rolling12m: { months: 12, available: false, why: 'needs 12 complete months in a row; 3 available', from: null, to: null },
      trend: trend === 'insufficient_data' ? { state: 'insufficient_data', why: 'needs 6 complete months in a row' } : { state: trend, recentPence: 60000, priorPence: 40000, why: null },
    }],
    review: { pending, pendingByMonth: {}, decidedNotVehicle: 4, decidedUnknown: 0, privateAccountsNotOffered: 0, decidedButNotCounted: 0 },
    rules: { active: 8, retired: 0 },
  };
}
const storeContract = (vf) => db.setState(fin.SNAPSHOT_KEY, JSON.stringify({ fetchedAt: new Date(NOW).toISOString(), contract: { contract: 'finance-intelligence-v1', vehicleFinance: vf } }));

let server;
let base;
const PIN = { 'X-NEURO-PIN': 'pin-2727', 'Content-Type': 'application/json' };
const MACHINE = { 'X-NEURO-API-TOKEN': 'machine-token-27', 'Content-Type': 'application/json' };
async function call(method, p, body, headers = PIN) {
  const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const rowCounts = () => db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((t) => `${t.name}:${db.get(`SELECT COUNT(*) AS n FROM "${t.name}"`).n}`).join('|');

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api', require('./api-auth'));
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/vehicle', require('../routes/vehicle'));
  app.use('/api/transport', require('../routes/transport'));
  app.use('/api/canonical', require('../routes/canonical'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server && server.close(); });

// ═══ FINANCE BOUNDARY ═════════════════════════════════════════════════════════

const code = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const TRANSPORT_FILES = ['vehicle.js', 'transport.js', '../routes/vehicle.js', '../routes/transport.js', 'personal-admin.js', 'future-radar.js'];
const DIRECT = /sqlite3|execFile|child_process|\bssh\b|TALLY_SSH_TARGET|TALLY_DB_PATH|tally-vehicle['"`]|readTally|FROM transactions/;

test('1–2. transport code has no SSH Tally reader and no direct Tally database access', () => {
  assert.equal(fs.existsSync(path.join(__dirname, 'tally-vehicle.js')), false, 'the Build 21 reader is deleted');
  for (const f of TRANSPORT_FILES) assert.doesNotMatch(code(f), DIRECT, f);
  // positive control: the scan finds what the deleted reader looked like
  assert.match("execFile('ssh', [c.sshTarget, `sqlite3 -readonly -json ${db}`])", DIRECT);
  assert.match("require('./tally-vehicle')", DIRECT);
  assert.doesNotMatch("{ id: 'tally-vehicle-finance' }", DIRECT, 'a source id that names Tally is not a Tally read');
});

test('3–5, 36. vehicle, fuel and maintenance spend come only from Tally\'s contract, passed through unchanged', () => {
  const vf = vehicleFinance();
  const f = veh.tallyVehicleFinance({ fetchedAt: 'x', contract: { vehicleFinance: vf } }, CAPTUR);
  assert.equal(f.available, true);
  assert.deepEqual(f.latestCompleteMonth, vf.vehicles[0].latestCompleteMonth, 'the month is Tally\'s object, unchanged');
  assert.deepEqual(f.last3CompleteMonths, vf.vehicles[0].last3CompleteMonths);
  assert.equal(f.latestCompleteMonth.fuelSpendPence, 9798);
  assert.equal(f.latestCompleteMonth.maintenanceSpendPence, 0);
  // no Tally section → no figure at all, and it says why
  const none = veh.tallyVehicleFinance({ fetchedAt: 'x', contract: { contract: 'finance-intelligence-v1' } }, CAPTUR);
  assert.equal(none.available, false);
  assert.match(none.why, /no vehicleFinance section/);
  assert.equal(veh.tallyVehicleFinance(null, CAPTUR).state, 'unread');
});

test('7–8. the old vehicle-finance routes are gone: they answer 410 and name Tally; nothing sums spend in NEURO', async () => {
  for (const [m, p] of [['GET', '/api/vehicle/finance/review'], ['GET', '/api/vehicle/finance/rules/preview?matchKind=merchant&merchantKey=SHELL'], ['POST', '/api/vehicle/finance/sync'],
    ['POST', '/api/vehicle/finance/transactions/996/decide'], ['POST', '/api/vehicle/finance/rules/vsr:x/retire']]) {
    const r = await call(m, p, m === 'POST' ? {} : undefined);
    assert.equal(r.status, 410, p);
    assert.match(r.json.error, /Tally/);
  }
  const src = code('vehicle.js');
  for (const fn of ['spendByType', 'ownershipCost', 'fuelCostPerMile', 'costPressure', 'eventCosts', 'monthlySummary', 'financeCoverage']) assert.ok(!src.includes(fn), fn);
  for (const t of ['tally_vehicle_txns', 'vehicle_spend_decisions', 'vehicle_spend_rules', 'vehicle_monthly_summaries']) {
    assert.equal(db.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", [t]).n, 0, `${t} is dropped`);
  }
});

// ═══ VEHICLE IDENTITY ═════════════════════════════════════════════════════════

test('9–10. one Captur — a re-statement folds, "car" is refused, a generic car link is refused', async () => {
  const a = await call('POST', '/api/vehicle', { make: 'Renault', model: 'Captur', plateDescriptor: '65-plate', fuelType: 'diesel' });
  assert.equal(a.status, 200);
  assert.equal(a.json.vehicle.vehicle_id, CAPTUR);
  assert.equal((await call('POST', '/api/vehicle', { make: 'renault', model: 'captur' })).json.already, true);
  assert.equal((await call('POST', '/api/vehicle', { make: 'Generic', model: 'car' })).status, 400);
  assert.equal(veh.listVehicles().length, 1);
  const link = po.linkVehicle({ vehicle: 'car', entityId: 'task:neuro:1' });
  assert.equal(link.ok, false);
});

test('11. explicit links only — a task that says MOT is a suggestion; a linked one is offered as the MOT\'s action, never linked for you', async () => {
  const sugg = veh.linkSuggestions([
    { id: 'task:neuro:2', description: 'Book the MOT for the car', state: 'open' },
    { id: 'task:neuro:4', description: 'Nick Ward to send breakdown of Parsons contacts: consent vs. legitimate interest', state: 'open' },
  ], new Set());
  assert.deepEqual(sugg.map((s) => s.id), ['task:neuro:2']);
  assert.match(sugg[0].why, /a mention, not a link/);
  T.mot = `task:neuro:${store.createTask({ text: 'Book my car in for its MOT tomorrow. Must do tomorrow.', source: 'mcp', domain: 'work' }).id}`; // the live #374 shape
  // the live #383 shape: names MOT, tax AND insurance — data entry, not the booking
  T.basics = `task:neuro:${store.createTask({ text: 'Fill in the Captur basics in NEURO: registration, current mileage, MOT, tax and insurance', source: 'mcp', domain: 'work' }).id}`;
  assert.equal(po.linkVehicle({ vehicle: 'Captur', entityId: T.basics }).ok, true);
  require('./obligation-sources').publishNeuroTasks({ now: NOW });
  await require('./event-bus').pumpConsumer(require('./world-model').CONSUMER, { now: NOW });
  assert.equal(po.linkVehicle({ vehicle: 'Captur', entityId: T.mot, label: 'Book my car in for its MOT' }).ok, true);
  assert.ok(veh.links(CAPTUR).some((l) => l.entityId === T.mot));
});

test('12. unknown fields stay unknown; what Nick states is kept with its provenance', async () => {
  const r0 = veh.read(CAPTUR);
  for (const k of ['registration', 'engine/trim', 'VIN', 'ownership start', 'mileage']) assert.ok(r0.vehicle.unknown.includes(k), k);
  assert.deepEqual(r0.vehicle.registeredWindow, { from: '2015-09', to: '2016-02', basis: 'a 65 plate' });
  assert.equal((await call('POST', '/api/vehicle/captur', { vin: 'NOT-A-VIN' })).status, 400);
  const up = await call('POST', '/api/vehicle/captur', { registration: 'ld65 bhp', variant: 'TDi' });
  assert.equal(up.json.vehicle.registration, 'LD65BHP');
  const r = veh.read(CAPTUR);
  assert.ok(!r.vehicle.unknown.includes('registration'));
  assert.ok(r.vehicle.unknown.includes('VIN'));
  assert.deepEqual(r.vehicle.provenance.updates[0].fields, ['registration', 'variant']);
});

// ═══ OBLIGATIONS ══════════════════════════════════════════════════════════════

test('13–17. MOT, tax, insurance and service are separate typed facts; a booking task never closes the MOT', async () => {
  const add = (body) => call('POST', '/api/vehicle/captur/obligations', body);
  assert.equal((await add({ type: 'mot', dueDate: plus(27), from: 'gov.uk MOT history' })).status, 200);
  assert.equal((await add({ type: 'tax', dueDate: plus(150) })).json.obligation.type, 'tax');
  assert.equal((await add({ type: 'insurance', dueDate: plus(12) })).json.obligation.type, 'insurance');
  assert.equal((await add({ type: 'mot', dueDate: plus(9) })).status, 409, 'one open MOT');
  const r = veh.read(CAPTUR);
  assert.deepEqual(r.obligations.map((o) => o.type).sort(), ['insurance', 'mot', 'tax']);
  // 14: the linked booking task is ticked — the MOT fact stays open
  const st = veh.obligationState({ type: 'mot', status: 'open', due_date: plus(27) }, { today: TODAY, task: { state: 'completed' } });
  assert.notEqual(st.state, 'complete');
  const mot = r.obligations.find((o) => o.type === 'mot');
  const bare = await call('POST', `/api/vehicle/obligations/${encodeURIComponent(mot.id)}/resolve`, { outcome: 'complete' });
  assert.equal(bare.status, 400);
  assert.match(bare.json.error, /a ticked task is not evidence/);
  // 11 (cont.): the task linked to the Captur that names the MOT is OFFERED as its action
  const offer = veh.read(CAPTUR).actionSuggestions.find((s) => s.taskId === T.mot);
  assert.ok(offer && offer.obligationId === mot.id, 'offered');
  assert.match(offer.why, /a suggestion, not a link/);
  assert.ok(!veh.read(CAPTUR).actionSuggestions.some((s) => s.taskId === T.basics), 'a task naming MOT, tax and insurance is not offered as any one of them (live #383)');
  assert.equal(veh.read(CAPTUR).obligations.find((o) => o.type === 'mot').linkedTaskRef, null, 'and not linked for you');
});

test('17. service is due by date or mileage, whichever first, as its own fact', async () => {
  const svc = await call('POST', '/api/vehicle/captur/obligations', { type: 'service', dueDate: plus(300), dueMileage: 63300 });
  assert.equal(svc.status, 200);
  assert.equal(svc.json.obligation.type, 'service');
});

test('18. an explicit obligation enters the Radar; a distant one does not interrupt', () => {
  const items = veh.radarItems(veh.read(CAPTUR), { today: TODAY, last: plus(30) });
  assert.deepEqual(items.map((i) => i.obligationType).sort(), ['insurance', 'mot']);
  const composed = radar.composeRadar({ today: TODAY, horizonDays: 30, vehicles: items });
  const mot = composed.items.find((i) => i.obligationType === 'mot');
  assert.equal(mot.attention.eligible, false, '27 days out is context, not Needs You');
});

// ═══ MILEAGE ══════════════════════════════════════════════════════════════════

test('19–20. a manual odometer reading is accepted; GPS, routes or movement are refused as odometer sources', async () => {
  const a = await call('POST', '/api/vehicle/captur/mileage', { value: 62950, observedOn: `${month(-3)}-01` });
  assert.equal(a.status, 200);
  assert.equal(a.json.reading.state, 'accepted');
  for (const source of ['gps', 'route', 'location', 'movement', 'carplay']) {
    const r = await call('POST', '/api/vehicle/captur/mileage', { value: 63000, observedOn: plus(-1), source });
    assert.equal(r.status, 400, source);
  }
  assert.match((await call('POST', '/api/vehicle/captur/mileage', { value: 63000, observedOn: plus(-1), source: 'gps' })).json.error, /not an odometer reading/);
  assert.ok(!veh.MILEAGE_SOURCES.includes('gps'));
});

test('21. sparse mileage does not invent annual mileage', () => {
  const r = veh.read(CAPTUR);
  const text = JSON.stringify(r);
  assert.ok(!/annual(ised)?Miles|milesPerYear|annualMileage/i.test(text));
  assert.equal(veh.milesBetween(r.mileage.readings.slice().reverse(), plus(-365), TODAY).miles, null, 'one reading measures nothing');
});

test('22. the latest odometer keeps its provenance; latest by date, never the largest', () => {
  const j = veh.judgeMileage([
    { id: 1, value: 60000, unit: 'mi', observedOn: '2026-01-01', source: 'mot' },
    { id: 2, value: 1200, unit: 'mi', observedOn: '2026-03-01', correction: true, source: 'manual' },
  ]);
  const c = veh.currentMileage(j);
  assert.equal(c.miles, 1200);
  assert.equal(c.source, 'manual');
  assert.equal(c.observedOn, '2026-03-01');
  const cur = veh.read(CAPTUR).mileage.current;
  assert.equal(cur.miles, 62950);
  assert.equal(cur.source, 'manual');
});

// ═══ SERVICE ══════════════════════════════════════════════════════════════════

test('23–27. service intervals: explicit date, explicit mileage, whichever first; unknown stays unknown; nothing guessed', () => {
  const ev = [{ event_id: 'vev:1', type: 'scheduled_service', event_date: '2026-02-10', mileage: 38000 }];
  const byDate = veh.effectiveDue({ type: 'service', interval_months: 12, interval_basis: 'service book' }, ev);
  assert.equal(byDate.date, '2027-02-10');
  const byMiles = veh.effectiveDue({ type: 'service', interval_miles: 12000, interval_basis: 'service book' }, ev);
  assert.equal(byMiles.mileage, 50000);
  const first = veh.obligationState({ type: 'service', status: 'open', due_date: plus(200), due_mileage: 40300 }, { today: TODAY, mileage: { miles: 40000 } });
  assert.equal(first.dueBy, 'mileage');
  assert.equal(first.state, 'upcoming');
  const later = veh.obligationState({ type: 'service', status: 'open', due_date: plus(5), due_mileage: 90000 }, { today: TODAY, mileage: { miles: 40000 } });
  assert.equal(later.dueBy, 'date');
  assert.equal(veh.obligationState({ type: 'service', status: 'open' }, { today: TODAY }).state, 'unknown');
  assert.equal(veh.effectiveDue({ type: 'service', interval_months: 12, interval_basis: 'book' }, []).date, null, 'no event to count from');
  const src = fs.readFileSync(path.join(__dirname, 'vehicle.js'), 'utf8');
  assert.ok(!/SERVICE_INTERVAL|DEFAULT_INTERVAL|12000|10000 ?mi/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'no generic schedule in the code');
});

// ═══ TYRES / MAINTENANCE ══════════════════════════════════════════════════════

test('28–29. a tyre replacement is recorded with what was said; tyre age alone creates no due date', async () => {
  const t = await call('POST', '/api/vehicle/captur/events', { type: 'tyres', date: plus(-40), mileage: 62500, description: 'Two front tyres', action: 'replaced', position: 'front', brand: 'Michelin' });
  assert.equal(t.status, 200);
  assert.deepEqual(JSON.parse(t.json.event.detail_json), { action: 'replaced', position: 'front', brand: 'Michelin' });
  assert.equal((await call('POST', '/api/vehicle/captur/events', { type: 'tyres', date: plus(-1), description: 'x', action: 'worn-out' })).status, 400);
  const r = veh.read(CAPTUR);
  assert.equal(r.tyres[0].action, 'replaced');
  assert.ok(!r.obligations.some((o) => /tyre/i.test(o.label)));
  assert.ok(!veh.OBLIGATION_TYPES.includes('tyres'));
  assert.ok(!/TYRE_(LIFE|INTERVAL|MILES|AGE)/.test(fs.readFileSync(path.join(__dirname, 'vehicle.js'), 'utf8')));
});

test('30–31. repair history is preserved with its outcome; a cost stays a Tally reference, never an amount', async () => {
  const rep = await call('POST', '/api/vehicle/captur/events', { type: 'repair', date: plus(-20), description: 'Glow plug replaced', outcome: 'resolved', costRef: 'tally:1029' });
  assert.equal(rep.status, 200);
  assert.equal(rep.json.event.cost_ref, 'tally:1029');
  assert.equal(rep.json.event.cost_pence, null);
  const amt = await call('POST', '/api/vehicle/captur/events', { type: 'repair', date: plus(-2), description: 'Brakes', costPence: 24000 });
  assert.equal(amt.status, 400);
  assert.match(amt.json.error, /Tally/);
  assert.equal((await call('POST', '/api/vehicle/captur/events', { type: 'other', date: plus(-2), description: 'x', costRef: 'tally:abc' })).status, 400);
  assert.equal((await call('POST', '/api/vehicle/captur/events', { type: 'other', date: plus(3), description: 'future' })).status, 400, 'history is what happened');
  assert.equal(veh.read(CAPTUR).history.find((h) => h.type === 'repair').detail.outcome, 'resolved');
  assert.ok(!('costPence' in veh.read(CAPTUR).history[0]));
});

// ═══ MPG / COST PER MILE ══════════════════════════════════════════════════════

test('32. no litres → no MPG; fills without litres or a cost are refused', async () => {
  assert.equal(veh.mpgFromFills([], { today: TODAY }).state, 'insufficient_data');
  assert.equal((await call('POST', '/api/vehicle/captur/fuel', { filledOn: plus(-1), odometer: 63000 })).status, 400);
  assert.equal((await call('POST', '/api/vehicle/captur/fuel', { filledOn: plus(-1), litres: 40, amountPence: 5500 })).status, 400);
  assert.match(veh.read(CAPTUR).fuel.mpg.why, /no fuel fill/);
});

test('27O. MPG is measured only full-to-full; consecutive fills are labelled estimated', () => {
  const measured = veh.mpgFromFills([
    { filledOn: '2026-09-01', litres: 40, odometer: 62000, fullTank: true },
    { filledOn: '2026-09-10', litres: 10, odometer: 62150, fullTank: false },
    { filledOn: '2026-09-20', litres: 30, odometer: 62500, fullTank: true },
  ], { today: '2026-10-01' });
  assert.equal(measured.state, 'measured');
  assert.equal(measured.latest.miles, 500);
  assert.equal(measured.latest.litres, 40, 'every litre after the first brim-full fill');
  assert.equal(measured.latest.mpg, Math.round((500 / (40 / 4.54609)) * 10) / 10);
  const est = veh.mpgFromFills([
    { filledOn: '2026-09-01', litres: 40, odometer: 62000, fullTank: false },
    { filledOn: '2026-09-20', litres: 30, odometer: 62500, fullTank: false },
  ], { today: '2026-10-01' });
  assert.equal(est.state, 'estimated');
  assert.match(est.why, /estimated/);
  assert.equal(veh.mpgFromFills([{ filledOn: '2026-09-01', litres: 40, odometer: null, fullTank: true }], { today: '2026-10-01' }).state, 'insufficient_data');
});

test('33. no mileage → no cost per mile, and it says why', () => {
  storeContract(vehicleFinance());
  const f = veh.tallyVehicleFinance({ fetchedAt: 'x', contract: { vehicleFinance: vehicleFinance() } }, CAPTUR);
  const c = veh.costPerMile(f, veh.judgeMileage([]));
  assert.equal(c.value, null);
  assert.equal(c.state, 'insufficient_data');
  assert.match(c.why, /no two odometer readings/);
});

test('34–36. aligned Tally cost + aligned mileage gives cost per mile, numerator untouched', () => {
  const f = veh.tallyVehicleFinance({ fetchedAt: 'x', contract: { vehicleFinance: vehicleFinance() } }, CAPTUR);
  const w = f.last3CompleteMonths;
  const judged = veh.judgeMileage([{ id: 1, value: 62000, unit: 'mi', observedOn: w.from }, { id: 2, value: 63500, unit: 'mi', observedOn: w.to }]);
  const c = veh.costPerMile(f, judged);
  assert.equal(c.state, 'aligned');
  assert.equal(c.numerator.totalPence, w.totalVehicleSpendPence, 'Tally\'s total, unchanged');
  assert.equal(c.numerator.source, 'Tally');
  assert.equal(c.denominator.miles, 1500);
  assert.equal(c.value, Math.round((w.totalVehicleSpendPence / 1500) * 10) / 10);
});

test('35. misaligned periods are marked partial, or refused when too far out', () => {
  const f = veh.tallyVehicleFinance({ fetchedAt: 'x', contract: { vehicleFinance: vehicleFinance() } }, CAPTUR);
  const w = f.last3CompleteMonths;
  const shift = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const near = veh.costPerMile(f, veh.judgeMileage([{ id: 1, value: 62000, unit: 'mi', observedOn: shift(w.from, 9) }, { id: 2, value: 63500, unit: 'mi', observedOn: w.to }]));
  assert.equal(near.state, 'partial');
  assert.match(near.why, /approximate/);
  const far = veh.costPerMile(f, veh.judgeMileage([{ id: 1, value: 62000, unit: 'mi', observedOn: shift(w.from, 30) }, { id: 2, value: 63500, unit: 'mi', observedOn: w.to }]));
  assert.equal(far.value, null, 'refused');
  // no complete Tally window → refused
  const thin = veh.tallyVehicleFinance({ fetchedAt: 'x', contract: { vehicleFinance: vehicleFinance({ w3: false }) } }, CAPTUR);
  assert.equal(veh.costPerMile(thin, veh.judgeMileage([])).state, 'insufficient_data');
});

// ═══ DRIVING PRIVACY ══════════════════════════════════════════════════════════

test('37. reading the driving state writes nothing — no trip, fix or route is kept', async () => {
  const before = rowCounts();
  for (const phone of [{ activity: 'Automotive', audioOutput: 'CarPlay' }, { activity: 'Still' }, null]) await transport.read({ now: NOW, phone });
  assert.equal(rowCounts(), before);
});

test('38. CarPlay or vehicle motion → driving only while the reading is fresh; "recently" is the phone\'s own last word', () => {
  const at = (min) => new Date(NOW - min * 60000).toISOString();
  assert.equal(transport.drivingState({ activity: 'Automotive', audioOutput: 'CarPlay', activityUpdatedAt: at(2) }, NOW).confidence, 'sure');
  assert.equal(transport.drivingState({ activity: 'Still', audioOutput: 'CarPlay', lastReportAt: at(1) }, NOW).state, 'driving');
  // the live shape, 9 Oct 2026: Automotive at 12:41, last report 12:47, Bluetooth not CarPlay, read at 13:05
  const live = transport.drivingState({ activity: 'Automotive', audioOutput: 'Bluetooth A2DP', activityUpdatedAt: at(24), lastReportAt: at(18) }, NOW);
  assert.equal(live.state, 'recently_drove');
  assert.match(live.why, /18 min ago\); it has not reported since/);
  assert.equal(transport.drivingState({ activity: 'Automotive', activityUpdatedAt: at(300) }, NOW).state, 'unknown', 'a five-hour-old reading says nothing about now');
  assert.equal(transport.drivingState({ activity: 'Still', lastReportAt: at(5) }, NOW).state, 'parked');
  assert.equal(transport.drivingState({ activity: 'Walking', lastReportAt: at(400) }, NOW).state, 'unknown');
  assert.equal(transport.drivingState(null, NOW).state, 'unknown');
  assert.equal(transport.drivingState({}, NOW).state, 'unknown');
  for (const p of [{ activity: 'Walking', lastReportAt: at(5) }, null, {}]) assert.notEqual(transport.drivingState(p, NOW).state, 'recently_drove', 'only a vehicle reading can say "recently"');
  assert.match(transport.drivingState(null).note, /keeps no record of drives/);
});

test('39. no precise route storage: transport code writes nothing and names no coordinate', () => {
  const t = code('transport.js');
  assert.doesNotMatch(t, /INSERT|UPDATE|setState|\.run\(|logEvent/);
  assert.doesNotMatch(t + code('vehicle.js'), /latitude|longitude|\blat\b|\blon\b|coordinates|polyline/i);
  assert.match('INSERT INTO trips', /INSERT|UPDATE|setState|\.run\(|logEvent/, 'positive control');
});

test('40. every drive does not create an Activity entry', async () => {
  const n = () => db.get('SELECT COUNT(*) AS n FROM personal_ops_events').n;
  const before = n();
  for (let i = 0; i < 5; i++) await transport.read({ now: NOW + i * 60000, phone: { activity: 'Automotive', audioOutput: 'CarPlay' } });
  assert.equal(n(), before);
});

// ═══ HEALTH / REPLACEMENT ═════════════════════════════════════════════════════

test('41–42. an overdue MOT or expired insurance makes it attention_needed', () => {
  const h = veh.health({ obligations: [{ type: 'mot', label: 'MOT', recordStatus: 'open', status: 'overdue', statusWhy: '3 days past', dueDate: plus(-3), id: 'a' }], events: [] });
  assert.equal(h.state, 'attention_needed');
  assert.equal(h.attention[0].kind, 'mot-overdue');
  const i = veh.health({ obligations: [{ type: 'insurance', label: 'Insurance', recordStatus: 'open', status: 'overdue', statusWhy: 'x', dueDate: plus(-1), id: 'b' }], events: [] });
  assert.equal(i.attention[0].kind, 'insurance-expired');
  const unresolved = veh.health({ obligations: [], events: [{ event_id: 'e', type: 'brakes', event_date: plus(-3), description: 'grinding', detail_json: '{"outcome":"unresolved"}' }] });
  assert.equal(unresolved.state, 'attention_needed');
});

test('43–44. an old car, high mileage or high cost alone never make it unhealthy', () => {
  const ok = [{ type: 'mot', label: 'MOT', recordStatus: 'open', status: 'later', dueDate: plus(200) }, { type: 'tax', label: 'Vehicle tax', recordStatus: 'open', status: 'later', dueDate: plus(100) }, { type: 'insurance', label: 'Insurance', recordStatus: 'open', status: 'later', dueDate: plus(50) }];
  assert.equal(veh.health({ obligations: ok, events: [] }).state, 'current');
  const resolved = [{ event_id: 'e1', type: 'repair', event_date: plus(-30), description: 'glow plug', detail_json: '{"outcome":"resolved"}' }, { event_id: 'e2', type: 'brakes', event_date: plus(-9), description: 'pads', detail_json: null }];
  assert.equal(veh.health({ obligations: ok, events: resolved }).state, 'current', 'a repair history is not ill health — only an unresolved one is');
  const rep = veh.replacementEvidence({ vehicle: { plate_descriptor: '05-plate' }, current: { miles: 210000, observedOn: TODAY }, events: [],
    fin: veh.tallyVehicleFinance({ fetchedAt: 'x', contract: { vehicleFinance: vehicleFinance({ trend: 'materially_up' }) } }, CAPTUR), today: TODAY });
  assert.equal(veh.health({ obligations: ok, events: [] }).state, 'current', 'age, 210k miles and a rising cost are evidence, not ill health');
  assert.equal(rep.state, 'evidence_available');
  assert.equal(veh.health({ obligations: [], events: [] }).state, 'incomplete_data', 'nothing recorded is not "current"');
});

test('45. no sell, replace or buy recommendation is ever generated', async () => {
  const r = await transport.read({ now: NOW, phone: null });
  const text = JSON.stringify(r);
  assert.doesNotMatch(text, /sell (it|now|the car)|replace (it|now|the car)|you should|time to (sell|replace|upgrade)|\bbuy an?\b|\bEV\b|Enyaq|electric car/i);
  assert.match(r.vehicles[0].replacement.stance, /no keep, sell, replace or buy recommendation/);
  assert.ok(['insufficient_data', 'evidence_available'].includes(r.vehicles[0].replacement.state));
});

// ═══ ADMIN / RADAR / NEEDS YOU ════════════════════════════════════════════════

test('46–47. a vehicle date appears in Personal Admin; mileage, history and fills never do', async () => {
  await call('POST', '/api/vehicle/captur/fuel', { filledOn: plus(-2), litres: 41.2, odometer: 63100, fullTank: true });
  const v = PA.read({ now: NOW });
  const items = v.items;
  const flat = JSON.stringify(v);
  const mot = veh.read(CAPTUR).obligations.find((o) => o.type === 'mot');
  assert.ok(items.some((i) => i.obligationId === mot.id && i.kind === 'vehicle'), 'the MOT is vehicle admin');
  assert.ok(items.some((i) => i.obligationId === T.mot), 'the linked booking task is admin too (Nick linked it to the Captur)');
  const r = veh.read(CAPTUR);
  for (const id of [...r.mileage.readings.map((x) => String(x.id)), ...r.history.map((h) => h.id), ...r.fuel.fills.map((f) => f.id)]) {
    assert.ok(!items.some((i) => i.obligationId === id), `routine fact ${id} is not admin`);
  }
  assert.ok(!/vfill:|vev:/.test(flat));
});

test('48–49. a real deadline can enter the Radar; rising fuel spend alone cannot', () => {
  const near = veh.radarItems(veh.read(CAPTUR), { today: TODAY, last: plus(14) });
  assert.ok(near.some((i) => i.obligationType === 'insurance'), 'insurance 12 days out');
  // a Tally trend of "materially up" and no obligation → nothing for the Radar
  storeContract(vehicleFinance({ trend: 'materially_up' }));
  const bare = { vehicle: { id: CAPTUR, make: 'Renault', model: 'Captur' }, obligations: [], finance: veh.read(CAPTUR).finance };
  assert.equal(bare.finance.trend.state, 'materially_up');
  assert.deepEqual(veh.radarItems(bare, { today: TODAY, last: plus(30) }), []);
  assert.doesNotMatch(code('future-radar.js'), /vehicleFinance|fuelSpend|totalVehicleSpend/);
});

test('50. Needs You is the existing obligation rule only — nothing in transport can push or send', async () => {
  for (const f of TRANSPORT_FILES.slice(0, 4)) assert.doesNotMatch(code(f), /webpush|sendToAll|sendMail|notification-policy|ambient-push|attention-lifecycle/, f);
  const r = await transport.read({ now: NOW, phone: null });
  const ny = r.vehicles[0].needsYou;
  const fromRule = r.vehicles[0].obligations.filter((o) => o.recordStatus === 'open' && (o.status === 'needs_you' || o.status === 'overdue'));
  assert.equal(ny.filter((n) => n.kind === 'obligation').length, fromRule.length);
  storeContract(vehicleFinance({ pending: 12 }));
  const again = await transport.read({ now: NOW, phone: null });
  assert.equal(again.vehicles[0].needsYou.length, ny.length, 'transactions waiting in Tally are not Needs You');
});

// ═══ SOURCES / ACTIVITY / ROUTES / AUTHORITY ══════════════════════════════════

test('27AA. each source is its own line — never one "healthy"', async () => {
  storeContract(vehicleFinance());
  const r = await transport.read({ now: NOW, phone: null });
  const ids = r.vehicles[0].sources.map((s) => s.id);
  assert.deepEqual(ids, ['vehicle-facts', 'official', 'tally-vehicle-finance', 'mileage', 'driving-context', 'tasks', 'history']);
  assert.ok(!r.vehicles[0].sources.some((s) => s.state === 'healthy' && s.id !== 'tally-vehicle-finance'));
  assert.equal(r.vehicles[0].sources.find((s) => s.id === 'driving-context').state, 'unavailable');
  assert.equal(r.vehicles[0].sources.find((s) => s.id === 'official').state, 'unavailable');
});

test('27AB. Activity is semantic: tyres, repairs, a finance source lost and recovered — once each', async () => {
  const kinds = () => db.all('SELECT kind FROM personal_ops_events').map((r) => r.kind);
  assert.ok(kinds().includes('tyre-recorded'));
  assert.ok(kinds().includes('repair-recorded'));
  db.run("DELETE FROM agent_state WHERE key LIKE 'vehicle_finance_state:%'");
  await veh.refresh({ now: NOW });                                          // baseline, silent
  db.setState(fin.SNAPSHOT_KEY, JSON.stringify({ fetchedAt: 'x', contract: { contract: 'finance-intelligence-v1' } }));
  await veh.refresh({ now: NOW + 1000 });
  await veh.refresh({ now: NOW + 2000 });                                   // unchanged → no second line
  storeContract(vehicleFinance());
  await veh.refresh({ now: NOW + 3000 });
  const k = kinds();
  assert.equal(k.filter((x) => x === 'vehicle-finance-source-lost').length, 1);
  assert.equal(k.filter((x) => x === 'vehicle-finance-source-recovered').length, 1);
  const tl = require('./activity-timeline');
  assert.ok(typeof tl === 'object');
});

test('27G. an official reading that matches records "verified" once; a disagreement never overwrites', async () => {
  const mot = veh.read(CAPTUR).obligations.find((o) => o.type === 'mot');
  await call('POST', '/api/vehicle/captur/official-by-hand', { motStatus: 'Valid', motExpiryDate: mot.dueDate });
  await call('POST', '/api/vehicle/captur/official-by-hand', { motStatus: 'Valid', motExpiryDate: mot.dueDate });
  assert.equal(db.all("SELECT * FROM personal_ops_events WHERE kind = 'vehicle-obligation-verified'").length, 1);
  assert.equal(veh.read(CAPTUR).obligations.find((o) => o.type === 'mot').confidence, 'verified');
  await call('POST', '/api/vehicle/captur/official-by-hand', { motStatus: 'Valid', motExpiryDate: plus(60) });
  const after = veh.read(CAPTUR).obligations.find((o) => o.type === 'mot');
  assert.equal(after.dueDate, mot.dueDate);
  assert.equal(after.confidence, 'conflict');
  const none = await veh.runOfficialCheck(CAPTUR, { key: '' });
  assert.equal(none.check.outcome, 'unavailable', 'a missing key is a source limitation, recorded as such');
});

test('routes + authority: /api/transport reads; a machine cannot add a fill, mileage or an obligation', async () => {
  const t = await call('GET', '/api/transport');
  assert.equal(t.status, 200);
  assert.equal(t.json.vehicles[0].vehicle.id, CAPTUR);
  assert.equal((await call('GET', '/api/vehicle/captur')).json.vehicle.model, 'Captur');
  for (const [p, body] of [['/api/vehicle/captur/fuel', { filledOn: plus(-1), litres: 30 }], ['/api/vehicle/captur/mileage', { value: 64000, observedOn: plus(-1) }], ['/api/vehicle/captur/obligations', { type: 'warranty', dueDate: plus(90) }]]) {
    assert.equal((await call('POST', p, body, MACHINE)).status, 403, p);
  }
  assert.equal((await call('GET', '/api/transport', undefined, MACHINE)).status, 200, 'a machine may read');
});

test('render: the Transport card shows Tally\'s figures unchanged, the reason for every gap, and no recommendation', async () => {
  storeContract(vehicleFinance({ pending: 3 }));
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
  const data = await transport.read({ now: NOW, phone: { activity: 'Automotive', audioOutput: 'CarPlay', lastReportAt: new Date(NOW - 60000).toISOString() } });
  const html = renderToString(React.createElement(m.exports.TransportView, { data })).split('<!-- -->').join('');
  assert.match(html, /Renault Captur/);
  assert.match(html, /LD65BHP/);
  assert.match(html, /Driving now/);
  assert.match(html, /£101\.48/, 'Tally\'s latest complete month, as Tally gives it');
  assert.match(html, /3 transactions might be the car’s — review them in/);
  assert.match(html, /Vehicle record differs from official source/);
  assert.match(html, /Replacement evidence/);
  assert.doesNotMatch(html, /The car’s<\/button>|Always<\/button>/, 'no spend classification in NEURO');
  assert.doesNotMatch(html, /sell (it|now)|replace (it|now)|buy an EV/i);
});
