'use strict';

/**
 * Renewals that need a decision (1 Nov 2026).
 *
 * 30 days before something renews, NEURO makes ONE personal task:
 *   "Compare before <X> auto-renews (<date>)", due a week before the renewal.
 *
 * Where renewals come from — each read separately, each failure a NAMED gap:
 *   • vehicle obligations Nick recorded (insurance, tax, MOT) — vehicle.js's table
 *   • Tally's finance-intelligence-v1 contract (the last snapshot finance.js kept):
 *       an established ANNUAL payment is a renewal by Tally's own word; a PLANNED
 *       payment counts only when Tally's own category or label says insurance,
 *       subscription, licence, membership, renewal or warranty. NEURO classifies
 *       nothing about money — it reads the words Tally gave.
 *   • finance obligations Nick recorded in NEURO of kind renewal / subscription
 *     renewal / annual fee
 *   • personal obligations (personal-obligations.read) whose own wording says renew
 *
 * Rules:
 *   • Only renewals 0–30 days away. Due = renewal − 7 days, or today if that has passed.
 *   • ONE task per renewal per year: the ledger (agent_state.renewal_watch_ledger)
 *     keys `<source>:<id>:<year>`. A key in the ledger is never acted on again —
 *     so a task Nick ticked or dropped is never recreated.
 *   • A source that cannot be read creates NOTHING from it and is named in
 *     `gaps` (shown on Personal Admin). Never a guess.
 *   • Activity: one `renewal-task-created` line per task. Nothing is sent.
 */

const LEDGER_KEY = 'renewal_watch_ledger';
const STATUS_KEY = 'renewal_watch_status';
const WINDOW_DAYS = 30;
const LEAD_DAYS = 7;
const TALLY_MAX_AGE_H = 72;
const SOURCE = 'renewal-watch';

// Tally's words that make a PLANNED payment a renewal. Matched on Tally's own
// category and label — never on anything NEURO inferred.
const RENEWAL_WORDS = /\b(insur\w*|subscri\w*|licen[cs]e\w*|membership\w*|renew\w*|warrant\w*|cover)\b/i;
const VEHICLE_TYPES = { insurance: 'insurance', tax: 'tax', mot: 'MOT' };
const FINANCE_KINDS = new Set(['renewal', 'subscription_renewal', 'annual_fee']);

function _db() { return require('../db/database'); }
function _json(key, d) { try { const v = JSON.parse(_db().getState(key) || 'null'); return v == null ? d : v; } catch { return d; } }
function _set(key, v) { _db().setState(key, JSON.stringify(v)); }
function _isDay(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function _utc(d) { return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)); }
function daysBetween(a, b) { return Math.round((_utc(b) - _utc(a)) / 86400000); }
function addDays(d, n) { return new Date(_utc(d) + n * 86400000).toISOString().slice(0, 10); }
function localDay(ms) { return require('./world-model').localMinute(ms).slice(0, 10); }
function _norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// An MOT or road tax is not something to shop around for: it is booked or paid (Nick, 1 Nov 2026).
function taskText(label, date, vtype) {
  if (vtype === 'mot') return `Book ${label} before ${date}`;
  if (vtype === 'tax') return `Renew ${label} before ${date}`;
  return `Compare before ${label} auto-renews (${date})`;
}
function dueFor(date, today) { const d = addDays(date, -LEAD_DAYS); return d < today ? today : d; }

/** PURE. Which Tally upcoming items are renewals — Tally's own kind/category/label only. */
function tallyRenewals(contract) {
  const items = (contract && contract.upcoming && Array.isArray(contract.upcoming.items)) ? contract.upcoming.items : [];
  return items.filter((i) => i && i.direction !== 'in' && _isDay(i.date)
    && (i.kind === 'annual' || (i.kind === 'planned' && (RENEWAL_WORDS.test(String(i.category || '')) || RENEWAL_WORDS.test(String(i.label || ''))))))
    .map((i) => ({
      source: 'tally',
      id: i.plannedId != null ? `planned:${i.plannedId}` : i.seriesKey ? `series:${i.seriesKey}` : `label:${_norm(i.label)}`,
      label: String(i.label || 'a payment').trim(),
      date: i.date,
      why: i.kind === 'annual' ? 'an established annual payment in Tally' : `a planned payment Tally files as ${i.category || 'a renewal by its name'}`,
    }));
}

/** PURE. The candidates that fall in the window and are not yet in the ledger. */
function plan(candidates, { today, ledger = {} }) {
  const out = [];
  for (const c of candidates) {
    if (!_isDay(c.date)) continue;
    const away = daysBetween(today, c.date);
    if (away < 0 || away > WINDOW_DAYS) continue;
    const key = `${c.source}:${c.id}:${c.date.slice(0, 4)}`;
    if (ledger[key]) continue;
    if (out.some((o) => o.key === key)) continue;
    out.push({ ...c, key, text: taskText(c.label, c.date, c.vtype), due: dueFor(c.date, today) });
  }
  return out;
}

// ── readers (each may throw; the caller names the gap) ─────────────────────

function readVehicles() {
  const rows = _db().all(`SELECT o.obligation_id, o.type, o.due_date, v.make, v.model FROM vehicle_obligations o
    JOIN vehicles v ON v.vehicle_id = o.vehicle_id WHERE o.status = 'open' AND o.due_date IS NOT NULL AND v.ownership_state = 'current'`);
  return rows.filter((r) => VEHICLE_TYPES[r.type]).map((r) => ({
    source: 'vehicle', id: r.obligation_id, date: r.due_date, vtype: r.type,
    label: `the ${r.model || r.make || 'car'} ${VEHICLE_TYPES[r.type]}`,
    why: 'a vehicle date you recorded',
  }));
}

function readTally({ nowMs }) {
  const snap = _json('finance_intelligence', null);
  if (!snap || !snap.contract) throw new Error('Tally’s finance contract has never been read');
  const age = (nowMs - Date.parse(snap.fetchedAt)) / 3600000;
  if (!(age >= 0) || age > TALLY_MAX_AGE_H) throw new Error(`Tally’s finance contract was last read ${Number.isFinite(age) ? Math.round(age) : '?'} hours ago`);
  const problems = require('./finance').checkContract(snap.contract);
  if (problems.length) throw new Error(`Tally’s finance contract was refused: ${problems.join('; ')}`);
  return tallyRenewals(snap.contract);
}

function readFinanceObligations() {
  return require('./finance').obligations({ status: 'open' })
    .filter((o) => FINANCE_KINDS.has(o.kind) && _isDay(o.dueDate))
    .map((o) => ({ source: 'finance-obligation', id: o.id, label: o.title, date: o.dueDate, why: 'a renewal you recorded in NEURO' }));
}

function readPersonal({ nowMs, ownTaskIds }) {
  const r = require('./personal-obligations').read({ now: nowMs });
  if (r.gaps && r.gaps.length) throw new Error(`personal obligations partly unreadable (${r.gaps.map((g) => g.input).join(', ')})`);
  return (r.items || []).filter((o) => o.due && _isDay(o.due.date) && /\brenew/i.test(String(o.what || ''))
    && !/^compare before /i.test(String(o.what || ''))
    && !ownTaskIds.has(String(o.id).replace(/^task:neuro:/, '')))
    .map((o) => ({ source: 'personal', id: o.id, label: String(o.what).replace(/\s+/g, ' ').trim(), date: o.due.date, why: 'a personal obligation that says it renews' }));
}

const READERS = [
  { source: 'vehicle', name: 'Vehicle dates', read: () => readVehicles() },
  { source: 'tally', name: 'Tally (annual and planned payments)', read: (ctx) => readTally(ctx) },
  { source: 'finance-obligation', name: 'Renewals recorded in NEURO', read: () => readFinanceObligations() },
  { source: 'personal', name: 'Personal obligations', read: (ctx) => readPersonal(ctx) },
];

/**
 * One pass. `readers` may be replaced in tests. Writes the ledger per task as
 * it goes (a crash cannot create the same task twice).
 */
function run({ now = Date.now(), readers = READERS, createTask = null } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const today = localDay(nowMs);
  const ledger = _json(LEDGER_KEY, {});
  const ownTaskIds = new Set(Object.values(ledger).map((e) => String(e.taskId)));
  const gaps = [];
  const candidates = [];
  const read = [];
  for (const r of readers) {
    try { const got = r.read({ nowMs, today, ownTaskIds }); candidates.push(...got); read.push({ source: r.source, name: r.name, count: got.length }); } catch (e) { gaps.push({ source: r.source, name: r.name, why: e.message }); }
  }
  const make = createTask || ((input) => require('./task-store').createTask(input));
  const created = [];
  for (const p of plan(candidates, { today, ledger })) {
    let res;
    try {
      res = make({ text: p.text, domain: 'personal', source: SOURCE, due_date: p.due, origin_detail: { kind: 'renewal-watch', renewalDate: p.date, from: p.source } });
    } catch (e) { gaps.push({ source: p.source, name: 'task', why: `could not create "${p.text}": ${e.message}` }); continue; }
    ledger[p.key] = { taskId: res.id, created: !!res.created, text: p.text, date: p.date, at: new Date(nowMs).toISOString() };
    _set(LEDGER_KEY, ledger);
    try {
      require('./personal-obligations').logEvent('renewal-task-created', { subjectId: `task:neuro:${res.id}`, detail: { title: p.text, renewalDate: p.date, due: p.due, why: p.why, from: p.source }, dedupeKey: `renewal-task-created:${p.key}`, now: nowMs });
    } catch { /* Activity is a record, never the reason a task is lost */ }
    created.push({ taskId: res.id, text: p.text, due: p.due, renewalDate: p.date, from: p.source });
  }
  const status = { at: new Date(nowMs).toISOString(), today, read, gaps, created: created.length, considered: candidates.length };
  _set(STATUS_KEY, status);
  return { ok: true, ...status, createdTasks: created };
}

/** What Personal Admin shows: the last pass and any source that could not be read. Reads nothing else. */
function status() {
  const s = _json(STATUS_KEY, null);
  if (!s) return { known: false, why: 'the renewal watch has not run yet', gaps: [] };
  return { known: true, at: s.at, gaps: s.gaps || [], read: s.read || [], created: s.created || 0,
    rule: `${WINDOW_DAYS} days before a renewal NEURO adds one personal task to compare, due ${LEAD_DAYS} days before it. A source it cannot read adds nothing.` };
}

module.exports = { run, status, plan, tallyRenewals, taskText, dueFor, READERS, LEDGER_KEY, STATUS_KEY, WINDOW_DAYS, LEAD_DAYS, SOURCE, RENEWAL_WORDS };
