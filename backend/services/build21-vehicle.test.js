'use strict';

/**
 * Build 21 — Vehicle intelligence + Tally finance ingestion.
 *
 * Real scratch DB, real routes over HTTP behind the real api-auth + authority
 * guard. Tally is read through the REAL reader with only `execFile` (the ssh
 * layer below it) faked, and the transaction fixtures are copied from what the
 * 8 Oct 2026 audit found in Tally (descriptions, pence, categories, accounts).
 * Anything that could notify is stubbed to THROW.
 *
 * Numbering follows the Build 21 test list in the brief.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b21-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'b21.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-2121';
process.env.NEURO_API_TOKEN = 'machine-token-21';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
delete process.env.DVLA_VES_API_KEY;
fs.mkdirSync(path.join(tmp, 'vault'), { recursive: true });

function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
const boom = (what) => async () => { throw new Error(`${what} reached from a Build 21 flow`); };
stub('./webpush', { sendToAll: boom('webpush.sendToAll'), isConfigured: () => true });
stub('./email-sender', { sendMail: boom('email-sender.sendMail'), sendBriefEmail: boom('email-sender.sendBriefEmail'), OWN_ADDRESS: 'nickw@nurtur.tech' });

const db = require('../db/database');
const veh = require('./vehicle');
const tv = require('./tally-vehicle');
const po = require('./personal-obligations');
const radar = require('./future-radar');

const NOW = Date.now();
const TODAY = veh.localDay(NOW);
const plus = (n) => { const d = new Date(`${TODAY}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const CAPTUR = 'vehicle:captur';

// Rows as Tally returns them (READ_SQL's column names), from the audit.
const TALLY_ROWS = [
  { id: 412, date: '2026-03-06', amount: -2000, description: 'WHITTLEWAY S/STN DERBY', is_transfer: 0, category_name: 'Transport', account_name: 'Nick', account_owner: 'Nick' },
  { id: 418, date: '2026-03-09', amount: -400, description: 'HIGHCROSS CAR PARK', is_transfer: 0, category_name: 'Transport', account_name: 'Nick', account_owner: 'Nick' },
  { id: 419, date: '2026-03-09', amount: -790, description: 'SHELL TALBOT ST COALVILLE', is_transfer: 0, category_name: 'Fuel', account_name: 'Nick', account_owner: 'Nick' },
  { id: 655, date: '2026-04-23', amount: -3539, description: 'WM MORRISONS', is_transfer: 0, category_name: 'Fuel', account_name: 'Joint', account_owner: null },
  { id: 812, date: '2026-05-14', amount: -8365, description: 'ZILCH RAC MOTORINGSER', is_transfer: 0, category_name: 'Transport', account_name: 'Joint', account_owner: null },
  { id: 951, date: '2026-05-27', amount: -685, description: 'ZILCH CRUMBS 2GO', is_transfer: 0, category_name: 'Fuel', account_name: 'Joint', account_owner: null },
  { id: 952, date: '2026-05-27', amount: -562, description: 'ZILCH INSTALMENT', is_transfer: 0, category_name: 'Fuel', account_name: 'Joint', account_owner: null },
  { id: 960, date: '2026-05-30', amount: -749, description: 'HALFORDS 0412', is_transfer: 0, category_name: null, account_name: 'Nick', account_owner: 'Nick' },
  { id: 993, date: '2026-06-03', amount: -2226, description: 'ZILCH SHELL', is_transfer: 0, category_name: null, account_name: 'Joint', account_owner: null },
  { id: 996, date: '2026-06-03', amount: -2226, description: '1717 03JUN26 ZILCH SHELL GB GB', is_transfer: 0, category_name: null, account_name: 'Joint', account_owner: null },
  { id: 997, date: '2026-06-04', amount: -5400, description: 'TESCO STORES 3381', is_transfer: 0, category_name: 'Groceries', account_name: 'Joint', account_owner: null },
  { id: 998, date: '2026-06-05', amount: -10000, description: 'TO SAVINGS', is_transfer: 1, category_name: null, account_name: 'Nick', account_owner: 'Nick' },
  { id: 999, date: '2026-01-12', amount: -1500, description: 'NETFLIX.COM', is_transfer: 0, category_name: 'Subscriptions', account_name: 'Joint', account_owner: null },
];
const SCHEMA_ROWS = ['id', 'account_id', 'date', 'amount', 'description', 'merchant', 'category_id', 'notes', 'is_transfer', 'transfer_pair_id', 'import_batch_id', 'dedupe_hash', 'balance_after', 'created_at'].map((name, cid) => ({ cid, name }));

/** A fake `execFile` for the ssh layer: answers PRAGMA and the read query. */
function fakeExec(rows, schema = SCHEMA_ROWS) {
  const calls = [];
  const fn = (cmd, args, opts, cb) => {
    calls.push({ cmd, args });
    const remote = args[args.length - 1];
    if (remote.includes('PRAGMA table_info')) return cb(null, JSON.stringify(schema));
    return cb(null, JSON.stringify(rows));
  };
  fn.calls = calls;
  return fn;
}

let server;
let base;
const PIN = { 'X-NEURO-PIN': 'pin-2121', 'Content-Type': 'application/json' };
const MACHINE = { 'X-NEURO-API-TOKEN': 'machine-token-21', 'Content-Type': 'application/json' };
async function call(method, p, body, headers = PIN) {
  const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api', require('./api-auth'));
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/vehicle', require('../routes/vehicle'));
  app.use('/api/canonical', require('../routes/canonical'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server && server.close(); });

// ── entity ───────────────────────────────────────────────────────────────────

test('1. one Captur entity — a re-statement folds, "car" is refused, and a generic car link is refused', async () => {
  const a = await call('POST', '/api/vehicle', { make: 'Renault', model: 'Captur', plateDescriptor: '65-plate', fuelType: 'diesel', provenanceNote: 'Build 21 brief' });
  assert.equal(a.status, 200);
  assert.equal(a.json.vehicle.vehicle_id, CAPTUR);
  const again = await call('POST', '/api/vehicle', { make: 'renault', model: 'captur' });
  assert.equal(again.json.already, true);
  const car = await call('POST', '/api/vehicle', { make: 'Generic', model: 'car' });
  assert.equal(car.status, 400);
  assert.equal(veh.listVehicles().length, 1);
  const link = po.linkVehicle({ vehicle: 'car', entityId: 'task:neuro:1' });
  assert.equal(link.ok, false);
  assert.equal(link.status, 404);
  assert.match(link.error, /Renault Captur/);
  // positive control: naming the Captur links to the held id
  const ok = po.linkVehicle({ vehicle: 'Captur', entityId: 'task:neuro:1', label: 'Book MOT' });
  assert.equal(ok.ok, true);
  assert.equal(ok.link.subjectId, CAPTUR);
});

test('2. explicit links only — a task that says "MOT" is a suggestion, not a link', () => {
  const sugg = veh.linkSuggestions([
    { id: 'task:neuro:2', description: 'Book the MOT for the car', state: 'open' },
    { id: 'task:neuro:3', description: 'Renew passport', state: 'open' },
    // live wording, 8 Oct 2026 — a "breakdown" that is not a car
    { id: 'task:neuro:4', description: 'Nick Ward to send breakdown of Parsons contacts: consent vs. legitimate interest', state: 'open' },
    { id: 'task:neuro:5', description: 'Book my car in for its MOT tomorrow (8 October 2026)', state: 'open' },
    { id: 'task:neuro:1', description: 'Book MOT', state: 'open' },
  ], new Set(['task:neuro:1']));
  assert.deepEqual(sugg.map((s) => s.id), ['task:neuro:2', 'task:neuro:5']);
  assert.match(sugg[0].why, /a mention, not a link/);
  assert.ok(!veh.links(CAPTUR).some((l) => l.entityId === 'task:neuro:2'));
  assert.ok(veh.links(CAPTUR).some((l) => l.entityId === 'task:neuro:1'));
  // a calendar entry can be linked explicitly (21D)
  assert.equal(po.linkVehicle({ vehicle: CAPTUR, entityId: 'meeting:graph:abc' }).ok, true);
});

test('3. unknown fields remain unknown', () => {
  const r = veh.read(CAPTUR);
  assert.equal(r.vehicle.registration, null);
  assert.equal(r.vehicle.variant, null);
  assert.equal(r.vehicle.currentMileage, null);
  for (const k of ['registration', 'engine/trim', 'VIN', 'purchase date', 'mileage']) assert.ok(r.vehicle.unknown.includes(k), k);
  assert.equal(r.vehicle.plateDescriptor, '65-plate');
  assert.equal(r.vehicle.fuelType, 'diesel');
});

// ── mileage ──────────────────────────────────────────────────────────────────

test('4. current mileage = latest TRUSTWORTHY reading, not the largest', () => {
  // the odometer was replaced: a later, lower reading Nick marks as a correction wins
  const j = veh.judgeMileage([
    { id: 1, value: 60000, unit: 'mi', observedOn: '2026-01-01' },
    { id: 2, value: 1200, unit: 'mi', observedOn: '2026-03-01', correction: true },
  ]);
  assert.equal(veh.currentMileage(j).miles, 1200);
  // an unmarked lower reading is flagged and the earlier one stands
  const k = veh.judgeMileage([
    { id: 1, value: 40000, unit: 'mi', observedOn: '2026-01-01' },
    { id: 2, value: 45000, unit: 'mi', observedOn: '2026-06-01' },
    { id: 3, value: 44000, unit: 'mi', observedOn: '2026-07-01' },
  ]);
  assert.equal(k[2].state, 'needs-review');
  assert.equal(veh.currentMileage(k).miles, 45000);
  // km converts
  assert.equal(veh.currentMileage(veh.judgeMileage([{ id: 1, value: 16093.44, unit: 'km', observedOn: '2026-01-01' }])).miles, 10000);
});

test('5. an impossible jump is flagged "needs review", kept, and not used', async () => {
  const a = await call('POST', `/api/vehicle/captur/mileage`, { value: 40000, observedOn: plus(-30) });
  assert.equal(a.json.reading.state, 'accepted');
  const b = await call('POST', `/api/vehicle/captur/mileage`, { value: 90000, observedOn: plus(-28) });
  assert.equal(b.json.reading.state, 'needs-review');
  assert.match(b.json.reading.review, /not plausible/);
  assert.equal(b.json.current.miles, 40000);
  const fut = await call('POST', `/api/vehicle/captur/mileage`, { value: 41000, observedOn: plus(3) });
  assert.equal(fut.status, 400);
  // withdraw the bad reading so later tests see a clean series
  await call('POST', `/api/vehicle/captur/mileage/${b.json.reading.id}/withdraw`, {});
  assert.equal(veh.read(CAPTUR).mileage.needsReview, 0);
});

// ── obligations ──────────────────────────────────────────────────────────────

test('6–11. obligations are typed: MOT, tax, insurance, service (date + mileage), warranty, breakdown cover', async () => {
  const add = (body) => call('POST', '/api/vehicle/captur/obligations', body);
  const mot = await add({ type: 'mot', dueDate: plus(1), from: 'V5C / last certificate' });
  assert.equal(mot.json.obligation.type, 'mot');
  assert.equal((await add({ type: 'tax', dueDate: plus(10) })).json.obligation.type, 'tax');
  assert.equal((await add({ type: 'insurance', dueDate: plus(12) })).json.obligation.type, 'insurance');
  assert.equal((await add({ type: 'warranty', dueDate: plus(400) })).json.obligation.type, 'warranty');
  assert.equal((await add({ type: 'breakdown_cover', dueDate: plus(200) })).json.obligation.type, 'breakdown_cover');
  const svc = await add({ type: 'service', dueDate: plus(300), dueMileage: 40300 });
  assert.equal(svc.json.obligation.type, 'service');
  assert.equal((await add({ type: 'tyres', dueDate: plus(5) })).status, 400, 'tyres is history, never an obligation');
  assert.equal((await add({ type: 'mot', dueDate: plus(9) })).status, 409, 'one open MOT');
  assert.equal((await add({ type: 'mot', dueMileage: 50000 })).status, 400, 'an MOT is due by date, never by mileage');
  const r = veh.read(CAPTUR);
  const by = Object.fromEntries(r.obligations.map((o) => [o.type, o]));
  assert.equal(by.mot.label, 'MOT');
  assert.equal(by.breakdown_cover.label, 'Breakdown cover');
  // 9: whichever comes first — the date is ~300 days out, the mileage is 300 mi away
  assert.equal(by.service.dueBy, 'mileage');
  assert.equal(by.service.status, 'upcoming');
  assert.match(by.service.statusWhy, /300 mi to go/);
  // and by date when the date is nearer
  const st = veh.obligationState({ type: 'service', status: 'open', due_date: plus(5), due_mileage: 90000 }, { today: TODAY, mileage: { miles: 40000 } });
  assert.equal(st.dueBy, 'date');
  assert.equal(st.state, 'upcoming');
});

test('12. completing the task is not verifying the obligation', async () => {
  const ob = { type: 'mot', status: 'open', due_date: plus(20) };
  const st = veh.obligationState(ob, { today: TODAY, task: { state: 'completed' } });
  assert.notEqual(st.state, 'complete');
  const mot = veh.read(CAPTUR).obligations.find((o) => o.type === 'mot');
  const bare = await call('POST', `/api/vehicle/obligations/${encodeURIComponent(mot.id)}/resolve`, { outcome: 'complete' });
  assert.equal(bare.status, 400);
  assert.match(bare.json.error, /a ticked task is not evidence/);
});

test('13. no invented due date — no date stays unknown; an interval needs its basis and a history event', async () => {
  assert.equal(veh.obligationState({ type: 'insurance', status: 'open' }, { today: TODAY }).state, 'unknown');
  const noBasis = await call('POST', '/api/vehicle/captur/obligations', { type: 'service', intervalMonths: 12 });
  assert.ok(noBasis.status === 400 || noBasis.status === 409);
  const due = veh.effectiveDue({ type: 'service', interval_months: 12, interval_miles: 12000, interval_basis: 'service book' }, []);
  assert.equal(due.date, null);
  assert.equal(due.mileage, null);
  const withEv = veh.effectiveDue({ type: 'service', interval_months: 12, interval_miles: 12000, interval_basis: 'service book' },
    [{ event_id: 'vev:1', type: 'scheduled_service', event_date: '2026-02-10', mileage: 38000 }]);
  assert.equal(withEv.date, '2027-02-10');
  assert.equal(withEv.mileage, 50000);
  assert.equal(withEv.from.basis, 'service book');
  // a repair is not a service to count from
  assert.equal(veh.effectiveDue({ type: 'service', interval_months: 12, interval_basis: 'book' }, [{ event_id: 'vev:2', type: 'repair', event_date: '2026-02-10' }]).date, null);
});

// ── Tally ────────────────────────────────────────────────────────────────────

test('14. Tally is schema-checked before anything is read — through the REAL reader', async () => {
  const bad = fakeExec(TALLY_ROWS, SCHEMA_ROWS.filter((c) => c.name !== 'amount'));
  await assert.rejects(tv.readTally({ execFile: bad }), /changed \(missing amount\)/);
  assert.equal(bad.calls.length, 1, 'the transactions query never ran');
  const good = fakeExec(TALLY_ROWS);
  const rows = await tv.readTally({ execFile: good });
  assert.equal(rows.length, TALLY_ROWS.length);
  const remote = good.calls[1].args[good.calls[1].args.length - 1];
  assert.match(remote, /^sqlite3 -readonly -json /);
  assert.equal(good.calls[1].cmd, 'ssh');
  const res = await tv.sync({ now: NOW, deps: { execFile: good } });
  assert.equal(res.ok, true);
  assert.equal(res.dataThrough, '2026-06-05');
});

test('15. the source transaction id is stable across syncs and decisions survive', async () => {
  const before = db.all('SELECT source_txn_id FROM tally_vehicle_txns ORDER BY source_txn_id').map((r) => r.source_txn_id);
  await tv.sync({ now: NOW + 1000, reader: async () => TALLY_ROWS });
  const after = db.all('SELECT source_txn_id FROM tally_vehicle_txns ORDER BY source_txn_id').map((r) => r.source_txn_id);
  assert.deepEqual(after, before);
  assert.ok(after.includes(419) && after.includes(993) && after.includes(996));
});

test('16. household spending is never copied or shown', async () => {
  const held = db.all('SELECT description FROM tally_vehicle_txns').map((r) => r.description);
  for (const s of ['TESCO STORES 3381', 'NETFLIX.COM', 'TO SAVINGS', 'ZILCH INSTALMENT']) assert.ok(!held.includes(s), s);
  const payload = JSON.stringify((await call('GET', '/api/vehicle/finance/review')).json);
  assert.ok(!payload.includes('TESCO') && !payload.includes('NETFLIX'));
  // positive control: a motoring row IS there
  assert.ok(payload.includes('SHELL TALBOT ST COALVILLE'));
});

test('17. no explicit Tally vehicle category exists — Fuel/Transport are suggestions, never classifications', () => {
  const r = tv.read();
  assert.equal(r.explicitVehicleCategory.found, false);
  const shell = r.pending.find((p) => p.sourceTransactionId === 419);
  assert.equal(shell.classification, null);
  assert.equal(shell.candidate.proposedType, 'fuel');
  assert.equal(shell.candidate.confidence, 'medium');
  assert.equal(r.decided.length, 0);
});

test('18. an ambiguous merchant stays a low-confidence suggestion', () => {
  const r = tv.read();
  const morr = r.pending.find((p) => p.sourceTransactionId === 655);
  assert.equal(morr.candidate.confidence, 'low');
  assert.equal(morr.classification, null);
  const crumbs = r.pending.find((p) => p.sourceTransactionId === 951);
  assert.equal(crumbs.candidate.confidence, 'low', 'filed under Fuel, but nothing about it says fuel');
  // pending + settled copies of one purchase are folded
  const dupe = r.decided.concat(r.pending).find((p) => p.sourceTransactionId === 996);
  assert.equal(dupe, undefined, '996 is the settled copy of 993 — not offered twice');
  assert.equal(tv.normaliseMerchant('1717 03JUN26 ZILCH SHELL GB GB').merchantKey, 'SHELL');
  assert.equal(tv.normaliseMerchant('1717 03JUN26 ZILCH SHELL GB GB').channel, 'zilch');
});

test('19. a confirmed mapping is reusable — the next matching transaction is classified by it', async () => {
  const preview = await call('GET', '/api/vehicle/finance/rules/preview?matchKind=merchant&merchantKey=SHELL');
  assert.equal(preview.json.matches, 2, 'the pending and settled copies');
  const d = await call('POST', '/api/vehicle/finance/transactions/993/decide', { decision: 'vehicle', spendType: 'fuel', vehicleId: 'captur', remember: { matchKind: 'merchant' } });
  assert.equal(d.status, 200);
  assert.equal(d.json.rule.merchant_key, 'SHELL');
  await tv.sync({ now: NOW + 2000, reader: async () => [...TALLY_ROWS, { id: 1100, date: '2026-06-20', amount: -3100, description: 'ZILCH SHELL', is_transfer: 0, category_name: null, account_name: 'Joint', account_owner: null }] });
  const row = tv.read().decided.find((x) => x.sourceTransactionId === 1100);
  assert.equal(row.classification.basis, 'rule');
  assert.equal(row.classification.spendType, 'fuel');
  // a different branch is a different merchant key — exact, not a regex
  assert.equal(tv.read().pending.find((x) => x.sourceTransactionId === 419).classification, null);
  // one-off confirmation, no rule
  const once = await call('POST', '/api/vehicle/finance/transactions/419/decide', { decision: 'vehicle', spendType: 'fuel', vehicleId: CAPTUR });
  assert.equal(once.json.rule, null);
  // "not vehicle" and "leave unknown" both leave the queue — nothing is asked twice
  await call('POST', '/api/vehicle/finance/transactions/951/decide', { decision: 'not-vehicle' });
  await call('POST', '/api/vehicle/finance/transactions/655/decide', { decision: 'unknown' });
  const pend = tv.read().pending.map((p) => p.sourceTransactionId);
  assert.ok(!pend.includes(951) && !pend.includes(655));
  assert.equal(tv.vehicleSpend({ vehicleId: CAPTUR }).some((s) => s.sourceTransactionId === 655), false, 'unknown is never counted');
});

test('20. a machine cannot confirm a mapping, create a rule, alter an obligation, add mileage or read Tally', async () => {
  for (const [p, body] of [
    ['/api/vehicle/finance/transactions/412/decide', { decision: 'vehicle', spendType: 'fuel', vehicleId: CAPTUR, remember: { matchKind: 'category' } }],
    ['/api/vehicle/finance/sync', {}],
    ['/api/vehicle/captur/mileage', { value: 50000, observedOn: TODAY }],
    ['/api/vehicle/captur/obligations', { type: 'tax', dueDate: plus(5) }],
    ['/api/vehicle', { make: 'Ford', model: 'Focus' }],
  ]) {
    const r = await call('POST', p, body, MACHINE);
    assert.equal(r.status, 403, p);
  }
  assert.equal(db.all("SELECT * FROM vehicle_spend_rules WHERE match_kind = 'category'").length, 0);
  // a machine may READ
  assert.equal((await call('GET', '/api/vehicle', null, MACHINE)).status, 200);
});

test('21. Tally stays authoritative — a transaction it stops listing stops counting', async () => {
  assert.ok(tv.vehicleSpend({ vehicleId: CAPTUR }).some((s) => s.sourceTransactionId === 1100));
  await tv.sync({ now: NOW + 3000, reader: async () => TALLY_ROWS });
  assert.equal(db.get('SELECT in_source FROM tally_vehicle_txns WHERE source_txn_id = 1100').in_source, 0);
  assert.ok(!tv.vehicleSpend({ vehicleId: CAPTUR }).some((s) => s.sourceTransactionId === 1100));
});

test('22. NEURO has no path that edits a Tally transaction', () => {
  assert.match(tv.READ_SQL.trim(), /^SELECT /);
  const src = fs.readFileSync(require.resolve('./tally-vehicle'), 'utf8');
  assert.match(src, /sqlite3 -readonly/);
  // every SQL string handed to the remote reader is a module constant
  const calls = src.match(/_runSql\(([^,)]+)/g) || [];
  assert.ok(calls.length >= 2);
  for (const c of calls) assert.match(c, /_runSql\((READ_SQL|SCHEMA_SQL|sql)/);
  assert.ok(!/https?:\/\/[^'"`]*tally/i.test(src), 'no Tally HTTP (write-capable) client');
  // positive control: the guard on the remote command is what this pins
  assert.ok(src.includes("`sqlite3 -readonly -json ${"));
});

// ── fuel / costs ─────────────────────────────────────────────────────────────

test('23. fuel spend with no litres never yields MPG', () => {
  const r = veh.read(CAPTUR);
  assert.equal(r.finance.mpg.value, null);
  assert.match(r.finance.mpg.why, /no fuel quantity/);
});

test('24. MPG needs matching distance AND quantity over the same period', () => {
  const judged = veh.judgeMileage([{ id: 1, value: 40000, unit: 'mi', observedOn: '2026-03-01' }, { id: 2, value: 40500, unit: 'mi', observedOn: '2026-03-31' }]);
  const period = { from: '2026-03-01', to: '2026-03-31' };
  const ok = veh.mpg({ period, judged, fills: [{ date: '2026-03-15', litres: 45.4609 }] });
  assert.equal(ok.value, 50);
  assert.equal(veh.mpg({ period, judged: judged.slice(0, 1), fills: [{ date: '2026-03-15', litres: 40 }] }).value, null);
  assert.equal(veh.mpg({ period, judged, fills: [{ date: '2026-04-15', litres: 40 }] }).value, null, 'litres outside the period do not count');
});

test('25. the weekly MPG refresh is quiet — state only, no Activity line', async () => {
  await veh.refresh({ now: NOW, reader: async () => TALLY_ROWS });
  const st = JSON.parse(db.getState(`vehicle_mpg:${CAPTUR}`));
  assert.equal(st.value, null);
  assert.equal(db.all("SELECT * FROM personal_ops_events WHERE kind LIKE '%mpg%'").length, 0);
});

test('26. the monthly summary is deterministic and stored once', async () => {
  const r = veh.read(CAPTUR);
  const a = veh.monthlySummary(r, '2026-05');
  const b = veh.monthlySummary(veh.read(CAPTUR), '2026-05');
  assert.deepEqual(a, b);
  assert.equal(a.otherVehiclePence, 0, 'RAC is still an undecided suggestion — not counted');
  db.run("UPDATE vehicles SET created_at = '2026-01-01T00:00:00.000Z'");
  await veh.refresh({ now: NOW, reader: async () => TALLY_ROWS });
  await veh.refresh({ now: NOW + 5000, reader: async () => TALLY_ROWS });
  const prev = veh.addMonths(`${TODAY.slice(0, 7)}-01`, -1).slice(0, 7);
  assert.equal(db.all('SELECT * FROM vehicle_monthly_summaries WHERE month = ?', [prev]).length, 1);
  assert.equal(db.all("SELECT * FROM personal_ops_events WHERE kind = 'vehicle-summary-produced'").length, 1);
});

test('27. fuel cost per mile is period-aligned and needs complete finance coverage', () => {
  const judged = veh.judgeMileage([{ id: 1, value: 40000, unit: 'mi', observedOn: '2026-03-01' }, { id: 2, value: 40400, unit: 'mi', observedOn: '2026-03-31' }]);
  const spend = [{ date: '2026-03-10', amountPence: -4000, classification: { spendType: 'fuel' } }, { date: '2026-04-10', amountPence: -9999, classification: { spendType: 'fuel' } }];
  const period = { from: '2026-03-01', to: '2026-03-31' };
  const full = veh.fuelCostPerMile({ period, spend, judged, coverage: { complete: true } });
  assert.equal(full.value, 10);
  assert.equal(full.numeratorPence, 4000, 'April fuel is outside the period');
  const part = veh.fuelCostPerMile({ period, spend, judged, coverage: { complete: false, why: "Tally's data stops 2026-03-20" } });
  assert.equal(part.value, null);
  assert.match(part.why, /stops/);
});

test('28–30. rolling 12-month ownership cost: windowed, parking excluded, categories explain the total', () => {
  const today = '2026-06-30';
  const spend = [
    { date: '2026-05-01', amountPence: -5000, classification: { spendType: 'fuel' } },
    { date: '2026-04-01', amountPence: -40000, classification: { spendType: 'insurance' } },
    { date: '2026-03-01', amountPence: -400, classification: { spendType: 'parking' } },
    { date: '2025-05-01', amountPence: -99999, classification: { spendType: 'repair' } },
  ];
  const events = [{ event_date: '2026-02-01', type: 'repair', cost_pence: 12000, cost_ref: null }, { event_date: '2026-02-02', type: 'tyres', cost_pence: 9000, cost_ref: 'tally:5' }];
  const own = veh.ownershipCost({ today, spend, events, judged: [], coverage: { complete: false, why: "Tally's data starts 2026-01-12" } });
  assert.equal(own.byType.repair, 12000, 'the 2025 repair is outside 12 months');
  assert.equal(own.byType.tyres, undefined, 'a cost already in Tally is not counted twice');
  assert.equal(own.excluded.parking, 400);
  const OWN = tv.OWNERSHIP_TYPES;
  assert.equal(own.totalPence, Object.entries(own.byType).filter(([k]) => OWN.includes(k)).reduce((a, [, v]) => a + v, 0));
  assert.equal(own.totalPence, 5000 + 40000 + 12000);
  assert.equal(own.perMile, null);
  assert.match(own.why, /12 months of finance data/);
});

// ── history ──────────────────────────────────────────────────────────────────

test('31–32. an explicit tyre event is stored with what was said — and no tyre schedule exists', async () => {
  const t = await call('POST', '/api/vehicle/captur/events', { type: 'tyres', date: plus(-40), mileage: 39500, description: 'Two front tyres', axle: 'front', brand: 'Michelin', count: 2 });
  assert.equal(t.status, 200);
  assert.deepEqual(JSON.parse(t.json.event.detail_json), { axle: 'front', brand: 'Michelin', count: '2' });
  assert.ok(!veh.OBLIGATION_TYPES.includes('tyres'));
  assert.ok(!veh.read(CAPTUR).obligations.some((o) => /tyre/i.test(o.label)));
  const src = fs.readFileSync(require.resolve('./vehicle'), 'utf8');
  assert.ok(!/TYRE_(LIFE|INTERVAL|MILES)/.test(src));
});

test('33. a repair is not a service', async () => {
  await call('POST', '/api/vehicle/captur/events', { type: 'repair', date: plus(-20), description: 'Replaced glow plug' });
  await call('POST', '/api/vehicle/captur/events', { type: 'scheduled_service', date: plus(-60), description: 'Annual service' });
  const h = veh.read(CAPTUR).health;
  assert.equal(h.repairs12m.events, 1);
  assert.equal(h.maintenance12m.count, 2, 'service + tyres');
});

test('34. a maintenance cost linked to Tally keeps its provenance and is counted once', async () => {
  const e = await call('POST', '/api/vehicle/captur/events', { type: 'other', date: '2026-05-30', description: 'Wiper blades', costRef: 'tally:960' });
  assert.equal(e.json.event.cost_pence, 749);
  assert.equal(e.json.event.source, 'tally-linked');
  assert.match(e.json.event.provenance_json, /the Tally transaction/);
  assert.equal(veh.eventCosts([e.json.event].map((x) => ({ ...x })), { from: '2026-05-01', to: '2026-05-31' }).other, undefined);
  assert.equal((await call('POST', '/api/vehicle/captur/events', { type: 'other', date: '2026-05-30', description: 'x', costRef: 'tally:4242' })).status, 404);
});

test('35. a garage transaction never creates a repair by itself', async () => {
  const before = db.all('SELECT COUNT(*) AS n FROM vehicle_events')[0].n;
  await tv.sync({ now: NOW + 9000, reader: async () => TALLY_ROWS });
  await veh.refresh({ now: NOW + 9000, reader: async () => TALLY_ROWS });
  assert.equal(db.all('SELECT COUNT(*) AS n FROM vehicle_events')[0].n, before);
  assert.ok(tv.read().pending.some((p) => p.sourceTransactionId === 960 || p.sourceTransactionId === 812));
});

// ── official ─────────────────────────────────────────────────────────────────

const DVLA_BODY = { registrationNumber: 'AB65CDE', taxStatus: 'Taxed', taxDueDate: null, motStatus: 'Valid', motExpiryDate: null, make: 'RENAULT', fuelType: 'DIESEL', yearOfManufacture: 2015 };

test('36–37. an official MOT and tax date verify the obligation', async () => {
  db.run('UPDATE vehicles SET registration = ? WHERE vehicle_id = ?', ['AB65CDE', CAPTUR]);
  const r0 = veh.read(CAPTUR);
  const mot = r0.obligations.find((o) => o.type === 'mot');
  const tax = r0.obligations.find((o) => o.type === 'tax');
  const body = { ...DVLA_BODY, motExpiryDate: mot.dueDate, taxDueDate: tax.dueDate };
  const fetchImpl = async (url, opts) => {
    assert.equal(opts.headers['x-api-key'], 'k-test');
    assert.deepEqual(JSON.parse(opts.body), { registrationNumber: 'AB65CDE' });
    return { ok: true, status: 200, json: async () => body };
  };
  const out = await veh.runOfficialCheck(CAPTUR, { fetchImpl, key: 'k-test' });
  assert.equal(out.check.outcome, 'ok');
  const r = veh.read(CAPTUR);
  assert.equal(r.obligations.find((o) => o.type === 'mot').confidence, 'verified');
  assert.equal(r.obligations.find((o) => o.type === 'mot').verifiedBy, 'dvla-ves');
  assert.equal(r.obligations.find((o) => o.type === 'tax').confidence, 'verified');
  assert.equal(r.obligations.find((o) => o.type === 'insurance').confidence, 'stated', 'DVLA says nothing about insurance');
});

test('38. an unavailable official source stays unavailable — nothing is verified', async () => {
  const out = await veh.runOfficialCheck(CAPTUR, { key: '' });
  assert.equal(out.check.outcome, 'unavailable');
  assert.match(out.check.reason, /DVLA_VES_API_KEY/);
  const row = db.get("SELECT * FROM vehicle_official_checks WHERE outcome = 'unavailable' ORDER BY id DESC LIMIT 1");
  assert.ok(row);
  // the latest OK check is still the one that verified; an unavailable one changes nothing
  assert.equal(veh.read(CAPTUR).obligations.find((o) => o.type === 'mot').confidence, 'verified');
  const noReg = await veh.dvlaCheck({ registration: null }, { key: 'k' });
  assert.equal(noReg.outcome, 'unavailable');
});

test('39–40. a disagreement is kept, shown with provenance, and never overwrites', async () => {
  const mot = veh.read(CAPTUR).obligations.find((o) => o.type === 'mot');
  const r = await call('POST', '/api/vehicle/captur/official-by-hand', { motStatus: 'Valid', motExpiryDate: plus(45) });
  assert.equal(r.status, 200);
  const after = veh.read(CAPTUR).obligations.find((o) => o.type === 'mot');
  assert.equal(after.dueDate, mot.dueDate, 'NEURO\'s date unchanged');
  assert.equal(after.confidence, 'conflict');
  assert.equal(after.conflict.message, 'Vehicle record differs from official source');
  assert.equal(after.conflict.official.value, plus(45));
  assert.equal(after.conflict.official.source, 'gov-uk-by-hand');
  assert.equal(after.conflict.neuro.provenance.from, 'V5C / last certificate');
  assert.equal(db.all("SELECT * FROM personal_ops_events WHERE kind = 'official-conflict-found'").length, 1);
});

// ── Radar ────────────────────────────────────────────────────────────────────

test('41–43. MOT, tax and insurance enter the Radar; a linked task folds into its item', () => {
  const r = veh.read(CAPTUR);
  const items = veh.radarItems(r, { today: TODAY, last: plus(14) });
  const types = items.map((i) => i.obligationType).sort();
  assert.deepEqual(types, ['insurance', 'mot', 'tax']);
  // a task Nick linked as the MOT's action
  const mot = r.obligations.find((o) => o.type === 'mot');
  const v = items.find((i) => i.obligationType === 'mot');
  v.linkedTaskRefs = ['task:neuro:77'];
  const composed = radar.composeRadar({ today: TODAY, horizonDays: 14, vehicles: items,
    obligations: [{ id: 'task:neuro:77', what: 'Book MOT', due: { date: plus(1), label: 'tomorrow', kind: 'set', days: 1 }, domains: [{ domain: 'admin' }], admin: true, kind: 'task', actionState: 'preparation_open', needsWhy: 'open' }] });
  assert.ok(!composed.items.some((i) => i.id === 'task:neuro:77'), 'the task is not listed twice');
  const merged = composed.items.find((i) => i.id === mot.id);
  assert.ok(merged.whyVisible.some((w) => /Book MOT/.test(w)));
  assert.equal(composed.summary.vehicle, 3);
});

test('44. a distant obligation does not interrupt', () => {
  const items = veh.radarItems(veh.read(CAPTUR), { today: TODAY, last: plus(30) });
  assert.ok(!items.some((i) => i.obligationType === 'breakdown_cover'), '200 days out is outside 30');
  const composed = radar.composeRadar({ today: TODAY, horizonDays: 30, vehicles: items });
  const ins = composed.items.find((i) => i.obligationType === 'insurance');
  assert.equal(ins.actionState, 'none');
  assert.equal(ins.attention.eligible, false);
});

test('45. a near, unresolved obligation becomes Needs You under the existing rule', () => {
  const composed = radar.composeRadar({ today: TODAY, horizonDays: 7, vehicles: veh.radarItems(veh.read(CAPTUR), { today: TODAY, last: plus(7) }) });
  const mot = composed.items.find((i) => i.obligationType === 'mot');
  assert.equal(mot.actionState, 'needs_you');
  assert.equal(mot.attention.eligible, true);
  assert.equal(mot.attention.rule, 'open preparation or an own deadline is close');
});

test('46. no new notification policy — nothing in the vehicle code can push or send', () => {
  for (const f of ['./vehicle', './tally-vehicle', '../routes/vehicle']) {
    const src = fs.readFileSync(require.resolve(f), 'utf8');
    assert.ok(!/webpush|sendToAll|sendMail|notification-policy|ambient-push/.test(src), f);
  }
});

// ── the Life card, rendered for real on the real payload ─────────────────────

test('render: the vehicle card shows dates, the conflict, gaps and the review queue — and never a recommendation', async () => {
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  const esbuild = require('esbuild');
  const ROOT = path.join(__dirname, '..', '..');
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'frontend', 'src', 'components', 'canonical', 'VehicleCard.jsx')],
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
  assert.equal(typeof m.exports.OneVehicle, 'function', 'positive control: the view is exported');
  const html = renderToString(React.createElement(m.exports.OneVehicle, { r: veh.read(CAPTUR), review: tv.read(), tasks: [], busy: false, act: () => {} }));
  assert.match(html, /Renault Captur/);
  assert.match(html, /MOT/);
  assert.match(html, /Vehicle record differs from official source/);
  assert.match(html, /Not known: .*VIN/);
  assert.match(html, /no fuel quantity/);
  assert.match(html, /The car’s/);
  assert.match(html, /Evidence only/);
  assert.ok(!/replace (the|your) car|sell it|buy an EV/i.test(html));
});

// ── routing ──────────────────────────────────────────────────────────────────

test('routing: literal /finance and /obligations paths are not swallowed by /:id', async () => {
  const review = await call('GET', '/api/vehicle/finance/review');
  assert.equal(review.status, 200);
  assert.ok(Array.isArray(review.json.pending));
  const list = await call('GET', '/api/vehicle');
  assert.equal(list.json.vehicles[0].vehicle.id, CAPTUR);
  const one = await call('GET', '/api/vehicle/captur');
  assert.equal(one.json.vehicle.model, 'Captur');
  assert.equal((await call('GET', '/api/vehicle/nope')).status, 404);
});
