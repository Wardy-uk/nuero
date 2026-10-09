'use strict';

/**
 * Build 26 — NEURO consumes Tally's finance intelligence; it calculates nothing.
 *
 * Real scratch DB, real routes over HTTP behind the real api-auth + authority
 * guard, the real Radar, the real personal-admin chain, and the REAL tally-api
 * client against a fake at the fetch layer (so the production fetch path runs).
 * The contract is a synthetic finance-intelligence-v1 payload — the repo is
 * public, so no live household value appears here — whose SHAPE was checked
 * against the live contract's key paths on 9 Oct 2026. Anything that could
 * notify is stubbed to THROW. Numbering follows the Build 26 test list.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b26-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'b26.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-2626';
process.env.NEURO_API_TOKEN = 'machine-token-26';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
process.env.TALLY_SSH_TARGET = 'nobody@neuro-test.invalid';
process.env.TALLY_API_URL = 'http://tally.neuro-test.invalid';
process.env.TALLY_API_USERNAME = 'tally-api';
process.env.TALLY_API_PASSWORD = 'test-only';
process.env.HA_TOKEN = '';
fs.mkdirSync(path.join(tmp, 'vault'), { recursive: true });

function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
const boom = (what) => async () => { throw new Error(`${what} reached from a Build 26 flow`); };
stub('./webpush', { sendToAll: boom('webpush.sendToAll'), isConfigured: () => true });
stub('./email-sender', { sendMail: boom('email-sender.sendMail'), sendBriefEmail: boom('email-sender.sendBriefEmail'), OWN_ADDRESS: 'nickw@nurtur.tech' });

const db = require('../db/database');
const fin = require('./finance');
const syn = require('./finance-synthesis');
const fu = require('./build-followups');
const radar = require('./future-radar');

const NOW = Date.now();
const TODAY = require('./world-model').localMinute(NOW).slice(0, 10);
const plus = (n) => { const x = new Date(`${TODAY}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// ── a finance-intelligence-v1 payload (synthetic values, live shape) ──────────

const meta = (o = {}) => ({ period: null, source: 'tally', freshness: { state: 'healthy', asOf: new Date(NOW).toISOString(), why: 'every bank feed refreshed in the last 2 days' }, confidence: 'strong', explanation: ['test'], coverage: 'test', ...o });
function contract({ pressure = 'comfortable', feed = {}, forecast = 'partial', trends = [], cats = null, upcoming = [], established = null, priceChanges = [], unusual = [], catState = 'partial', lowestDate = plus(20) } = {}) {
  const accounts = [
    { accountId: 1, name: 'Nick', owner: 'primary', state: feed[1] || 'healthy', lastRefreshAt: new Date(NOW).toISOString(), ageDays: 0, why: feed[1] ? `feed ${feed[1]}` : 'refreshed today' },
    { accountId: 2, name: 'Joint', owner: 'shared', state: feed[2] || 'healthy', lastRefreshAt: new Date(NOW).toISOString(), ageDays: 0, why: feed[2] ? `feed ${feed[2]}` : 'refreshed today' },
    { accountId: 4, name: 'Helen', owner: 'private', state: feed[4] || 'healthy', lastRefreshAt: new Date(NOW).toISOString(), ageDays: 0, why: feed[4] ? `feed ${feed[4]}` : 'refreshed today' },
  ];
  const states = accounts.map((a) => a.state);
  const household = states.every((s) => s === 'healthy') ? 'healthy' : states.some((s) => s === 'healthy') ? 'partial' : 'stale';
  const horizon = (days, projected) => ({ label: `${days} days`, days, through: plus(days), openingPence: 8000, moneyInPence: 400000, moneyOutPence: 250000, projectedPence: projected, projectedRange: null,
    lowestPoint: { date: lowestDate, pence: -4000 }, dayToDayNotProjectedPence: 240000, items: [], privateAccounts: null });
  return {
    contract: 'finance-intelligence-v1', generatedAt: new Date(NOW).toISOString(), today: TODAY,
    privacy: { privateAccounts: ["Helen's account"], rule: 'test' },
    sourceHealth: { meta: meta({ confidence: 'n/a', explanation: ['Healthy means the bank refreshed in the last 2 days. Stored history is never health.'] }), bankFeed: { household, accounts },
      balances: accounts.map((a) => ({ accountId: a.accountId, name: a.name, owner: a.owner, observedAt: a.lastRefreshAt, observedBasis: 'balance-fetch', ageDays: 0, fresh: true, why: 'bank balance observed today' })),
      transactions: accounts.map((a) => ({ accountId: a.accountId, name: a.name, owner: a.owner, newest: TODAY, ageDays: 0, gaps: [], why: `newest transaction ${TODAY}` })),
      categories: { state: catState, valuePct: 70, countPct: 60, window: 'x', why: `${catState} categories` }, recurrence: { state: 'good', pct: 84, why: '84%' }, forecast: { state: forecast, why: ['test'] } },
    coverage: { meta: meta(), dataFrom: '2026-01-12', dataThrough: TODAY, completeMonths: ['2026-08', '2026-09'], accounts: [] },
    balances: { meta: meta(), household: { usableLiquidPence: 8000, includedAccounts: [1, 2, 4], excluded: [], coverage: 'complete', statement: "Every current account's bank balance is current (3 of 3)." },
      accounts: accounts.map((a) => ({ accountId: a.accountId, name: a.name, owner: a.owner, role: 'current', balancePence: a.owner === 'private' ? null : 4000, inHouseholdTotalOnly: a.owner === 'private', observedAt: a.lastRefreshAt, ageDays: 0, fresh: true, why: 'x' })) },
    cashflow: { meta: meta({ confidence: forecast }), confidence: forecast, confidenceWhy: forecast === 'unavailable' ? ['no recurring payment is established yet'] : ['some bills vary in amount — a range is given'],
      openingPence: forecast === 'unavailable' ? null : 8000, excludedAccounts: [], excludedUnknowns: ['day-to-day spending is not projected'],
      horizons: forecast === 'unavailable' ? [] : [horizon(7, 600), horizon(14, 108000), horizon(30, 247000)], toNextIncome: null,
      nextIncome: forecast === 'unavailable' ? null : { date: plus(9), pence: 195025, label: 'BELRON UK LTD' } },
    monthly: { meta: meta(), months: [{ month: '2026-09', complete: true, coverageReasons: [], spendPence: 412052, incomePence: 506079, moneyInPence: 506079, moneyOutPence: 630624, netMovementPence: -124545,
      recurringOutPence: 382169, discretionaryPence: 50000, discretionaryCoveragePct: 88, refundsPence: 0, transfersExcluded: { count: 2, internalPence: 60000 }, categorisedPct: 88, owners: { primaryPence: 1, sharedPence: 2, othersOwnAccountsPence: 3 } }] },
    trends: { meta: meta(), items: trends },
    categories: { meta: meta({ period: '2026-08 → 2026-09' }), available: !!cats, why: cats ? null : 'only 34% (2026-08) of spending carries a category', latestMonth: null, trends: cats || [] },
    recurring: { meta: meta(), counts: { strong_pattern: 2 }, established: established || [
      { key: 'rs_mortgage', label: 'MORTGAGE', category: null, accountId: 3, accountName: 'Bills', owner: 'shared', direction: 'out', cadence: 'monthly', amountKind: 'fixed', typicalPence: 52500, range: null, occurrences: 9, lastSeen: plus(-8), nextExpected: plus(22), lateDays: null, missed: false, state: 'strong_pattern', why: [] },
      { key: 'rs_belron', label: 'BELRON UK LTD', category: null, accountId: 2, accountName: 'Joint', owner: 'shared', direction: 'in', cadence: 'monthly', amountKind: 'fixed', typicalPence: 195025, range: null, occurrences: 5, lastSeen: plus(-21), nextExpected: plus(9), lateDays: null, missed: false, state: 'strong_pattern', why: [] },
    ], privateAccounts: 0 },
    priceChanges: { meta: meta(), items: priceChanges, privateAccounts: 0 },
    unusual: { meta: meta(), items: unusual, explained: 0, privateAccounts: 0 },
    pressure: { meta: meta(), state: pressure, why: [`Usually the household balance bottoms out around −£371.73 in a month.`, 'That is no lower than usual.'], basis: {} },
    upcoming: { meta: meta(), items: upcoming, privateAccounts: null, planned: [] },
  };
}

let current = contract();
fin.useReader(async () => current);

// The real tally-api client, against a fake at the fetch layer.
const tallyCalls = [];
let tallyPayload = null;
async function fakeTally(url, init = {}) {
  const u = new URL(url);
  tallyCalls.push({ method: init.method || 'GET', path: u.pathname, auth: (init.headers || {}).Authorization || null });
  const reply = (status, json) => ({ ok: status < 400, status, json: async () => json });
  if (u.pathname === '/api/auth/login') return reply(200, { ok: true, data: { token: 'fake-jwt' } });
  if (u.pathname === '/api/intelligence/contract' && (init.method || 'GET') === 'GET') return reply(200, { ok: true, data: tallyPayload });
  return reply(404, { ok: false, error: 'Not found' });
}
require('./tally-api').useFetch(fakeTally);

let server; let base;
const PIN = { 'X-NEURO-PIN': 'pin-2626', 'Content-Type': 'application/json' };
const MACHINE = { 'X-NEURO-API-TOKEN': 'machine-token-26', 'Content-Type': 'application/json' };
async function call(method, p, body, headers = PIN) {
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const VEH = [{ id: 'vehicle:captur', name: 'Renault Captur', obligations: [{ id: 'vob_mot', type: 'mot', label: 'MOT', dueDate: plus(18), recordStatus: 'open' }] }];

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api', require('./api-auth'));
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/finance', require('../routes/finance'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // What Build 23 left behind on the live Pi: NEURO-calculated summaries and a derived snapshot.
  db.run("INSERT INTO finance_monthly_summaries (month, complete, summary_json, computed_at, revisions) VALUES ('2026-05', 1, '{}', '2026-10-08', 0)");
  db.setState('finance_snapshot', '{"summaries":[]}');
  assert.equal(db.all('SELECT * FROM finance_monthly_summaries').length, 1, 'positive control: the legacy row exists');
  const r = await fin.refresh({ now: NOW });
  assert.equal(r.ok, true, r.error);
});
test.after(() => { server && server.close(); });

// ── boundary ───────────────────────────────────────────────────────────────

test('7. NEURO consumes Tally\'s outputs and recalculates none of them', () => {
  assert.equal(fs.existsSync(path.join(__dirname, 'finance-model.js')), false, 'the in-NEURO engine is gone');
  const engine = /\b(spendEffect|moneyOutEffect|monthlySummary|detectRecurring|unusualSpend|duplicateCharges|forwardCashflow|reconcilePending|categoryQuality|monthOnMonth|median)\s*\(/;
  const files = ['finance.js', 'finance-synthesis.js', '../routes/finance.js', '../../frontend/src/components/canonical/FinanceCard.jsx'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.doesNotMatch(src, engine, f);
    assert.doesNotMatch(src, /\.reduce\([^)]*Pence|Pence\s*[+-]\s*\w+\.\w*Pence/, `${f} sums money`);
  }
  // positive control: the scan does find engine code where it exists (Tally's port lives outside this repo,
  // so the control is a string carrying the same shape)
  assert.match('const m = median(xs);', engine);
  // the numbers on the view ARE the contract's
  const r = fin.read({ now: NOW, vehicles: [] });
  const d30 = current.cashflow.horizons.find((h) => h.days === 30);
  assert.equal(r.operational.forecast.d30.projectedPence, d30.projectedPence);
  assert.equal(r.operational.position.usablePence, current.balances.household.usableLiquidPence);
  assert.equal(r.operational.pressure.state, current.pressure.state);
});

// ── NEURO ──────────────────────────────────────────────────────────────────

test('33. a Tally finance fact is ingested and shown with its source', () => {
  const r = fin.read({ now: NOW, vehicles: [] });
  assert.equal(r.source.reads, 'finance-intelligence-v1');
  assert.equal(r.health.household, 'healthy');
  assert.equal(r.health.accounts.find((a) => a.name === 'Helen').owner, 'private');
  assert.ok(r.operational.forecast.nextIncome && r.operational.forecast.nextIncome.label === 'BELRON UK LTD');
});

test('34. cross-domain synthesis needs a second, non-finance fact', () => {
  const tight = contract({ pressure: 'tighter_than_usual' });
  assert.deepEqual(syn.synthesise(tight, { today: TODAY, vehicles: [] }), [], 'finance alone says nothing');
  assert.deepEqual(syn.synthesise(contract({ pressure: 'comfortable', lowestDate: plus(2) }), { today: TODAY, vehicles: VEH }).filter((x) => x.kind === 'pinch-overlaps'), [], 'a car date in a comfortable month is not a pinch');
  const items = syn.synthesise(tight, { today: TODAY, vehicles: VEH });
  const pinch = items.find((x) => x.kind === 'pinch-overlaps');
  assert.ok(pinch);
  assert.equal(pinch.facts.length, 2);
  assert.deepEqual(pinch.facts.map((f) => f.system).sort(), ['neuro', 'tally']);
  assert.equal(pinch.facts.find((f) => f.system === 'neuro').ref, 'vob_mot');
  // the MOT two days from the projected low point
  const near = syn.synthesise(contract({ lowestDate: plus(16) }), { today: TODAY, vehicles: VEH }).find((x) => x.kind === 'near-lowest-point');
  assert.ok(near && near.facts.length === 2);
  assert.equal(syn.synthesise(contract({ lowestDate: plus(5) }), { today: TODAY, vehicles: VEH }).filter((x) => x.kind === 'near-lowest-point').length, 0);
  // car costs: a material motoring category change AND a held vehicle
  const fuel = [{ category: 'Fuel', state: 'materially_up', line: 'Fuel materially up — £120.00 vs £80.00 (+50%)', currentPence: 12000, previousPence: 8000, deltaPence: 4000, deltaPct: 50, contributors: [] }];
  assert.equal(syn.synthesise(contract({ cats: fuel }), { today: TODAY, vehicles: [] }).length, 0);
  assert.equal(syn.synthesise(contract({ cats: fuel }), { today: TODAY, vehicles: VEH }).filter((x) => x.kind === 'car-costs-moving').length, 1);
});

test('35/36. a spending increase and a routine direct debit stay off the Radar', async () => {
  current = contract({
    trends: [{ measure: 'spending', state: 'materially_up', line: '2026-09 spending materially up against 2026-08', timing: null }],
    upcoming: [{ date: plus(3), direction: 'out', pence: 7215, lowPence: 7215, highPence: 7215, label: 'VIRGIN MEDIA PYMTS', kind: 'recurring', variable: false, late: false, cadence: 'monthly', category: null, seriesKey: 'rs_vm', plannedId: null }],
  });
  await fin.refresh({ now: NOW });
  const items = fin.radar({ today: TODAY, last: plus(30), now: NOW, vehicles: [] }).items;
  assert.ok(!items.some((i) => /VIRGIN|spending/i.test(`${i.title} ${i.detail}`)), JSON.stringify(items));
  const r = radar.read({ now: NOW, horizonDays: 30 });
  assert.ok(!r.items.some((i) => /VIRGIN/.test(i.title)));
  assert.ok(!r.gaps.some((g) => g.input === 'finance'), JSON.stringify(r.gaps));
});

let renewal;
test('37. an explicit renewal and a Tally planned or annual payment can reach the Radar', async () => {
  const r = await call('POST', '/api/finance/obligations', { kind: 'renewal', title: 'Home insurance renewal', dueDate: plus(20), expectedAmountPence: 42000, requiresDecision: true, linkedTaskRef: 'task:neuro:777' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  renewal = r.json.obligation;
  current = contract({ upcoming: [
    { date: plus(12), direction: 'out', pence: 48000, lowPence: 48000, highPence: 48000, label: 'Car insurance', kind: 'planned', variable: false, late: false, cadence: null, category: null, seriesKey: null, plannedId: 1 },
    { date: plus(25), direction: 'out', pence: 15900, lowPence: 15900, highPence: 15900, label: 'TV LICENCE', kind: 'annual', variable: false, late: false, cadence: 'yearly', category: null, seriesKey: 'rs_tv', plannedId: null },
  ] });
  await fin.refresh({ now: NOW });
  const items = radar.read({ now: NOW, horizonDays: 30 }).items;
  const ren = items.find((i) => i.id === renewal.id);
  assert.equal(ren.actionState, 'preparation_open');
  const planned = items.find((i) => i.title === 'Car insurance');
  assert.equal(planned.obligationType, 'planned_payment');
  assert.equal(planned.actionState, 'none');
  assert.equal(items.find((i) => i.title === 'TV LICENCE').obligationType, 'annual_payment');
});

test('38. something needing Nick reaches Needs You only through the existing rules', async () => {
  const ob = fin.addObligation({ kind: 'bill', title: 'Car tax', dueDate: plus(1) }, { now: NOW });
  assert.equal(ob.ok, true);
  const it = radar.read({ now: NOW, horizonDays: 30 }).items.find((i) => i.id === ob.obligation.id);
  assert.equal(it.actionState, 'needs_you');
  assert.equal(it.attention.eligible, true, 'the existing needs-you rule, nothing new');
  // a feed that needs re-approving: personal-admin's existing candidate, Nick's own and Helen's told apart
  current = contract({ feed: { 2: 'reconnect_required', 4: 'reconnect_required' } });
  await fin.refresh({ now: NOW });
  const pa = require('./personal-admin');
  const feedJoint = pa.fromFeed ? pa.fromFeed(fin.read({ now: NOW, vehicles: [] }).health.accounts.find((a) => a.name === 'Joint')) : null;
  if (feedJoint) assert.equal(feedJoint.baseState, 'needs_you');
  const op = fin.read({ now: NOW, vehicles: [] }).operational;
  assert.ok(op.needsAction.some((n) => /Reconnect the Joint bank feed in Tally/.test(n.line)));
  assert.ok(op.needsAction.some((n) => /Helen's bank feed needs re-approving at the bank — theirs to do/.test(n.line)));
  current = contract(); await fin.refresh({ now: NOW });
});

test('39. no new notification policy: finance context never interrupts', () => {
  const dir = __dirname;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && !x.endsWith('.test.js'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /rule: ['"]finance/, f);
  }
  const src = fs.readFileSync(path.join(__dirname, 'finance.js'), 'utf8') + fs.readFileSync(path.join(__dirname, 'finance-synthesis.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"]\.\/(webpush|email-sender|action-mail|action-executor|ambient-push)['"]\)|sendToAll|sendMail|worthInterrupting/);
  const items = fin.radar({ today: TODAY, last: plus(30), now: NOW, vehicles: VEH }).items.filter((i) => i.obligationType === 'planned_payment' || i.obligationType === 'annual_payment' || i.obligationType === 'cross_domain');
  for (const i of items) assert.equal(i.actionState, 'none', i.title);
});

// ── contract ───────────────────────────────────────────────────────────────

test('40. the contract is versioned and anything else is refused; the last good read stays', async () => {
  assert.deepEqual(fin.checkContract(contract()), []);
  assert.match(fin.checkContract({ ...contract(), contract: 'finance-intelligence-v2' }).join(), /NEURO reads finance-intelligence-v1/);
  const missing = contract(); delete missing.pressure;
  assert.match(fin.checkContract(missing).join(), /section pressure is missing/);
  const before = fin.read({ now: NOW, vehicles: [] }).source.generatedAt;
  current = { ...contract(), contract: 'finance-intelligence-v2', generatedAt: 'later' };
  const r = await fin.refresh({ now: NOW + 60000 });
  assert.equal(r.ok, false);
  const after = fin.read({ now: NOW + 60000, vehicles: [] });
  assert.equal(after.source.generatedAt, before, 'the last good snapshot stays');
  assert.equal(after.lastRead.ok, false);
  assert.match(after.lastRead.error, /refused/);
  current = contract(); await fin.refresh({ now: NOW });
});

test('41. NEURO depends on the contract, not on Tally\'s database', async () => {
  // Code only: the header comment SAYS ssh is gone, and a comment is not a dependency.
  const src = fs.readFileSync(path.join(__dirname, 'finance.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /sqlite3|execFile|\bssh\b|truelayer_|FROM transactions|pragma_table_info/i);
  // positive control (Build 27 deleted tally-vehicle.js, the last real one): the scan finds the shape a direct Tally read takes
  assert.match("execFile('ssh', [target, 'sqlite3 -readonly -json tally.db'])", /sqlite3|execFile|\bssh\b|truelayer_|FROM transactions|pragma_table_info/i);
  assert.match(src, /'\/intelligence\/contract'/);
  // the real production path: tally-api logs in and GETs the contract (fake only at the fetch layer)
  tallyPayload = contract();
  fin.useReader(null);
  const r = await fin.refresh({ now: NOW });
  fin.useReader(async () => current);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(tallyCalls.map((c) => `${c.method} ${c.path}`).slice(-2), ['POST /api/auth/login', 'GET /api/intelligence/contract']);
  assert.equal(tallyCalls.at(-1).auth, 'Bearer fake-jwt');
});

test('42. stale states stay explicit on NEURO\'s side', async () => {
  current = contract({ feed: { 4: 'stale' } });
  await fin.refresh({ now: NOW });
  const r = fin.read({ now: NOW, vehicles: [] });
  assert.equal(r.health.household, 'partial');
  assert.equal(r.health.accounts.find((a) => a.name === 'Helen').state, 'stale');
  assert.equal(r.health.label, 'Some bank feeds are live');
  current = contract(); await fin.refresh({ now: NOW });
});

test('43. explanation and provenance travel with every section', () => {
  const bad = contract(); delete bad.cashflow.meta;
  assert.match(fin.checkContract(bad).join(), /section cashflow has no meta/);
  const r = fin.read({ now: NOW, vehicles: [] });
  assert.ok(r.source.generatedAt && r.source.fetchedAt && r.source.tallyUrl);
  assert.ok(r.sourceHealth.meta.explanation.length > 0);
});

test('44. source freshness is separate from calculation confidence', async () => {
  current = contract({ forecast: 'unavailable' });
  await fin.refresh({ now: NOW });
  const r = fin.read({ now: NOW, vehicles: [] });
  assert.equal(r.health.household, 'healthy');
  assert.equal(r.operational.forecast.confidence, 'unavailable');
  assert.equal(r.operational.forecast.d30, null);
  current = contract(); await fin.refresh({ now: NOW });
});

// ── routes, privacy, activity, ledger, render ───────────────────────────────

test('the moved decisions answer 410 and name Tally; machines still cannot record obligations', async () => {
  for (const p of ['/api/finance/transactions/12/decide', '/api/finance/rules/fr_1/retire', '/api/finance/recurring/rs_x/decide', '/api/finance/review/ri_x/decide']) {
    const r = await call('POST', p, { decision: 'confirm' });
    assert.equal(r.status, 410, p);
    assert.match(r.json.error, /decided in Tally now/);
  }
  const m = await call('POST', '/api/finance/obligations', { kind: 'bill', title: 'x bill', dueDate: plus(3) }, MACHINE);
  assert.equal(m.status, 403);
  const g = await call('GET', '/api/finance');
  assert.equal(g.status, 200);
  assert.equal(g.json.contract, 'finance-operational-v1');
  const mo = await call('GET', '/api/finance/monthly/2026-09');
  assert.equal(mo.json.summary.source, 'tally');
});

test('32 (NEURO side). Helen appears only as a named feed and inside totals', () => {
  const r = fin.read({ now: NOW, vehicles: VEH });
  const json = JSON.stringify(r);
  assert.ok(!/HELENS|HELEN PRIVATE/.test(json));
  assert.ok(!r.linkable.some((s) => /Helen/i.test(s.label)));
});

test('Activity: a baseline line, then semantic changes only — never per refresh', async () => {
  const count = () => db.all("SELECT kind FROM personal_ops_events WHERE kind LIKE 'finance-%'").length;
  assert.equal(db.all("SELECT * FROM personal_ops_events WHERE kind = 'finance-intelligence-connected'").length, 1);
  const n0 = count();
  await fin.refresh({ now: NOW + 1000 });
  await fin.refresh({ now: NOW + 2000 });
  assert.equal(count(), n0, 'an unchanged contract writes nothing');
  current = contract({ priceChanges: [{ seriesKey: 'rs_vm', label: 'VIRGIN MEDIA PYMTS', cadence: 'monthly', category: null, fromPence: 6305, toPence: 7215, changePence: 910, changePct: 14.4, annualEffectPence: 10920, firstObserved: '2026-05-11', seenTimes: 5, confirmed: true, line: 'Up from £63.05 to £72.15' }] });
  await fin.refresh({ now: NOW + 3000 });
  await fin.refresh({ now: NOW + 4000 });
  assert.equal(db.all("SELECT * FROM personal_ops_events WHERE kind = 'finance-price-changed'").length, 1);
  const n = (k) => db.all('SELECT * FROM personal_ops_events WHERE kind = ?', [k]).length;
  const fa = n('finance-forecast-available');
  current = contract({ forecast: 'unavailable' }); await fin.refresh({ now: NOW + 5000 });
  current = contract(); await fin.refresh({ now: NOW + 6000 });
  await fin.refresh({ now: NOW + 6500 });
  assert.equal(n('finance-forecast-available'), fa + 1, 'one line per transition');
  const cq = n('finance-category-quality-improved');
  current = contract({ catState: 'good' }); await fin.refresh({ now: NOW + 7000 });
  await fin.refresh({ now: NOW + 7500 });
  assert.equal(n('finance-category-quality-improved'), cq + 1);
  const tl = require('./activity-timeline');
  assert.ok(typeof tl.read === 'function' || typeof tl.timeline === 'function');
  current = contract(); await fin.refresh({ now: NOW + 8000 });
});

test('the Build 23 derived store is cleared — NEURO keeps no second ledger', () => {
  assert.equal(db.all('SELECT * FROM finance_monthly_summaries').length, 0);
  assert.equal(db.getState('finance_snapshot'), 'null');
});

const store = require('./task-store');
const LIST = [
  { key: 'reconnect-nick-natwest', build: 'Build 23', title: 'Reconnect my NatWest bank feed in Tally (TrueLayer)', why: 'feed stale' },
  { key: 'captur-registration', build: 'Build 23', title: 'Add the Captur registration in NEURO (Life → Vehicle)' },
  { key: 'build18-native-proof', build: 'Build 23', title: 'Finish the Build 18 native proof on the Mac' },
];

test('ledger: a follow-up written only in notes fails acceptance', () => {
  const v = fu.verify(LIST);
  assert.equal(v.ok, false);
  assert.match(fu.validate({ key: 'x-y-z', title: 'Something to do' }), /source build/);
});

test('ledger: follow-ups become real tasks — reused, resolved, never duplicated; the Build 26 list is valid', () => {
  const own = store.createTask({ text: 'Add the Captur registration to NEURO vehicle', source: 'manual' });
  const done = store.createTask({ text: 'Finish the Build 18 native proof on the Mac', source: 'manual' });
  store.updateTask(done.id, { status: 'done' });
  const r = fu.reconcile(LIST, { apply: true, now: NOW });
  const by = Object.fromEntries(r.results.map((x) => [x.key, x]));
  assert.equal(by['reconnect-nick-natwest'].outcome, 'created');
  assert.equal(by['captur-registration'].taskId, own.id);
  assert.equal(by['build18-native-proof'].outcome, 'resolved');
  const before = db.listTaskRows({ status: 'all' }).length;
  fu.reconcile(LIST, { apply: true, now: NOW });
  assert.equal(db.listTaskRows({ status: 'all' }).length, before);
  for (const f of fu.BUILD_26 || []) assert.equal(fu.validate(f), null, f.key);
  assert.ok(Array.isArray(fu.BUILD_26), 'Build 26 declares its follow-ups');
});

test('render: the Finance card is operational, explains itself, and shows no analytics or editing', async () => {
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  const esbuild = require('esbuild');
  const ROOT = path.join(__dirname, '..', '..');
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'frontend', 'src', 'components', 'canonical', 'FinanceCard.jsx')],
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
  assert.equal(typeof m.exports.FinanceView, 'function', 'positive control: the view is exported');
  current = contract({ pressure: 'tighter_than_usual', feed: { 2: 'reconnect_required' },
    trends: [{ measure: 'spending', state: 'materially_up', line: '2026-09 spending materially up against 2026-08: £4,120.52 vs £3,205.82', timing: { note: '5 monthly payments landed twice in 2026-09' } }],
    unusual: [{ key: 'ri_1', kind: 'above-merchant-history', date: plus(-4), amountPence: 10543, merchantKey: 'TESCO', category: null, line: 'Unusual compared with your recorded history: x', decision: null }] });
  await fin.refresh({ now: NOW });
  const payload = fin.read({ now: NOW, vehicles: VEH });
  const html = renderToString(React.createElement(m.exports.FinanceView, { data: payload, busy: false, act: async () => {} })).replace(/<!-- -->/g, '').replace(/&#x27;/g, "'");
  assert.match(html, /Bank feeds: partly live/);
  assert.match(html, /Tighter than usual/);
  assert.match(html, /Day-to-day spending is not included/);
  assert.match(html, /Needs you/);
  assert.match(html, /Reconnect the Joint bank feed in Tally/);
  assert.match(html, /Where money meets the rest of life/);
  assert.match(html, /MOT/);
  assert.match(html, /landed twice/);
  assert.match(html, /Tally → Outlook/);
  assert.doesNotMatch(html, /Possible duplicate|Confirm and remember|Not recurring|aria-label="Category"|Monthly trend|Category trends<\//, 'no finance editing or analytics in NEURO');
  assert.doesNotMatch(html, /fraud|suspicious|afford/i);
  current = contract(); await fin.refresh({ now: NOW });
});

test('major changes are a selection over Tally\'s figures: material trends, price changes worth £50 a year or more', () => {
  const pc = (label, annual) => ({ seriesKey: `rs_${label}`, label, cadence: 'monthly', category: null, fromPence: 100, toPence: 200, changePence: 100, changePct: 10, annualEffectPence: annual, firstObserved: TODAY, seenTimes: 3, confirmed: true, line: 'x' });
  const c = contract({ priceChanges: [pc('BIG', 33372), pc('SMALL', 1200)], trends: [
    { measure: 'spending', state: 'materially_up', line: 'spending up', timing: null }, { measure: 'money out', state: 'materially_up', line: 'money out up', timing: null }, { measure: 'income', state: 'broadly_stable', line: 'income stable', timing: null }] });
  const op = fin.operational(c, { today: TODAY, obligations: [], vehicles: [] });
  assert.deepEqual(op.changes.map((x) => x.line), ['spending up', 'BIG: x']);
});
