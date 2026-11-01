'use strict';

// Renewals to compare (1 Nov 2026). Real DB, real task store, real vehicle and
// finance-obligation tables; Tally is a contract fixture stored where finance.js
// keeps its snapshot. Dates derive from the clock.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'renew-')), 'test.db');

const db = require('../db/database');
const rw = require('./renewal-watch');
const taskStore = require('./task-store');
const finance = require('./finance');

test.before(async () => { await db.init(); });

const NOW = Date.now();
const today = require('./world-model').localMinute(NOW).slice(0, 10);
const plus = (n) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const meta = () => ({ freshness: 'fresh', confidence: 'good', explanation: [] });
function contract(upcoming) {
  const c = { contract: 'finance-intelligence-v1', generatedAt: new Date(NOW).toISOString() };
  for (const s of finance.SECTIONS) c[s] = { meta: meta() };
  c.upcoming.items = upcoming;
  return c;
}
function storeTally(items, { ageHours = 1 } = {}) {
  db.setState('finance_intelligence', JSON.stringify({ fetchedAt: new Date(NOW - ageHours * 3600000).toISOString(), contract: contract(items) }));
}
function reset() {
  db.setState(rw.LEDGER_KEY, 'null');
  db.setState(rw.STATUS_KEY, 'null');
  db.run('DELETE FROM vehicle_obligations'); db.run('DELETE FROM vehicles');
  db.run("DELETE FROM tasks WHERE source = 'renewal-watch'");
  try { db.run('DELETE FROM finance_obligations'); } catch { /* table absent */ }
}
function addVehicle(type, due) {
  const at = new Date(NOW).toISOString();
  db.run("INSERT OR IGNORE INTO vehicles (vehicle_id, make, model, ownership_state, source, created_at, updated_at) VALUES ('vehicle:captur','Renault','Captur','current','nick',?,?)", [at, at]);
  db.run(`INSERT INTO vehicle_obligations (obligation_id, vehicle_id, type, due_date, status, source, created_at, updated_at) VALUES (?, 'vehicle:captur', ?, ?, 'open', 'nick', ?, ?)`, [`vo_${type}`, type, due, at, at]);
}
// Only the sources under test, so the personal-obligations read is not asked.
const ONLY = (names) => rw.READERS.filter((r) => names.includes(r.source));

test('tally: an annual payment and a planned insurance renew; a planned plain bill and money in do not', () => {
  const r = rw.tallyRenewals(contract([
    { kind: 'annual', label: 'TV LICENCE', date: plus(20), direction: 'out', seriesKey: 'rs_tv', category: null },
    { kind: 'planned', label: 'Car insurance', date: plus(12), direction: 'out', plannedId: 1, category: null },
    { kind: 'planned', label: 'Builder', date: plus(12), direction: 'out', plannedId: 2, category: 'Home' },
    { kind: 'planned', label: 'Gym', date: plus(12), direction: 'out', plannedId: 3, category: 'Subscriptions' },
    { kind: 'recurring', label: 'Netflix', date: plus(5), direction: 'out', seriesKey: 'rs_nf', category: 'Subscriptions' },
    { kind: 'annual', label: 'Refund', date: plus(5), direction: 'in', seriesKey: 'rs_r', category: null },
  ]));
  assert.deepStrictEqual(r.map((x) => x.label).sort(), ['Car insurance', 'Gym', 'TV LICENCE']);
});

test('one personal task per renewal, due a week before, and it is never recreated once done', () => {
  reset();
  addVehicle('insurance', plus(25));
  addVehicle('mot', plus(45)); // outside the 30-day window
  storeTally([{ kind: 'annual', label: 'TV LICENCE', date: plus(20), direction: 'out', seriesKey: 'rs_tv', category: null }]);
  const r1 = rw.run({ now: NOW, readers: ONLY(['vehicle', 'tally']) });
  assert.strictEqual(r1.created, 2, JSON.stringify(r1));
  const ins = r1.createdTasks.find((t) => t.from === 'vehicle');
  assert.strictEqual(ins.text, `Compare before the Captur insurance auto-renews (${plus(25)})`);
  assert.strictEqual(ins.due, plus(18));
  const row = taskStore.getTask(ins.taskId);
  assert.strictEqual(row.domain, 'personal');
  assert.strictEqual(row.source, 'renewal-watch');
  // Activity line recorded.
  assert.ok(db.get("SELECT 1 FROM personal_ops_events WHERE kind = 'renewal-task-created'"));

  // Again: nothing new.
  assert.strictEqual(rw.run({ now: NOW, readers: ONLY(['vehicle', 'tally']) }).created, 0);
  // Done, then dropped: still nothing.
  taskStore.updateTask(ins.taskId, { status: 'done' });
  assert.strictEqual(rw.run({ now: NOW, readers: ONLY(['vehicle', 'tally']) }).created, 0);
  db.run('DELETE FROM tasks WHERE id = ?', [ins.taskId]);
  assert.strictEqual(rw.run({ now: NOW, readers: ONLY(['vehicle', 'tally']) }).created, 0, 'the ledger, not the task row, remembers');
});

test('due date never lands in the past', () => {
  reset();
  addVehicle('tax', plus(3));
  const r = rw.run({ now: NOW, readers: ONLY(['vehicle']) });
  assert.strictEqual(r.createdTasks[0].due, today);
});

test('an unreadable source creates nothing from it and is named as a gap', () => {
  reset();
  addVehicle('insurance', plus(10));
  storeTally([{ kind: 'annual', label: 'TV LICENCE', date: plus(20), direction: 'out', seriesKey: 'rs_tv' }], { ageHours: 200 });
  const r = rw.run({ now: NOW, readers: ONLY(['vehicle', 'tally']) });
  assert.strictEqual(r.created, 1);
  assert.strictEqual(r.createdTasks[0].from, 'vehicle');
  assert.strictEqual(r.gaps.length, 1);
  assert.strictEqual(r.gaps[0].source, 'tally');
  assert.match(r.gaps[0].why, /hours ago/);
  const st = rw.status();
  assert.strictEqual(st.gaps[0].source, 'tally');
  // And Personal Admin carries it.
  const pa = require('./personal-admin').read({ now: NOW });
  assert.strictEqual(pa.renewalWatch.gaps[0].source, 'tally');
});

test('a Tally contract that fails its own check is a gap, not an empty list', () => {
  reset();
  db.setState('finance_intelligence', JSON.stringify({ fetchedAt: new Date(NOW).toISOString(), contract: { contract: 'finance-intelligence-v0' } }));
  const r = rw.run({ now: NOW, readers: ONLY(['tally']) });
  assert.strictEqual(r.created, 0);
  assert.match(r.gaps[0].why, /refused/);
});

test('renewals recorded in NEURO count, other finance obligations do not', () => {
  reset();
  finance.addObligation({ kind: 'renewal', title: 'Home insurance', dueDate: plus(14) });
  finance.addObligation({ kind: 'bill', title: 'Window cleaner', dueDate: plus(14) });
  const r = rw.run({ now: NOW, readers: ONLY(['finance-obligation']) });
  assert.deepStrictEqual(r.createdTasks.map((t) => t.text), [`Compare before Home insurance auto-renews (${plus(14)})`]);
});
