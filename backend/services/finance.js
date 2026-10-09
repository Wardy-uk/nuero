'use strict';

/**
 * Build 26 — NEURO's finance domain: a CONSUMER of Tally's finance intelligence.
 *
 * The boundary (Nick, 9 Oct 2026): Tally understands the money; NEURO
 * understands why the money matters.
 *   • Tally owns every finance calculation — balances, cashflow, recurrence,
 *     monthly and category totals and trends, price changes, unusual spend,
 *     pressure, source health. NEURO reads them as ONE versioned contract,
 *     `finance-intelligence-v1` (GET /api/intelligence/contract, through
 *     tally-api.js's login), and never recomputes a figure. If a result can be
 *     calculated from financial data alone, it belongs in Tally.
 *   • NEURO adds what needs the wider world: cross-domain synthesis
 *     (finance-synthesis.js), the Future Radar, Needs You through the existing
 *     rules, and Nick's own operational finance obligations (a renewal that needs
 *     a decision, linked to a task) — the one finance store NEURO keeps.
 *   • NEURO does not depend on Tally's tables: no ssh, no SQL, no schema check.
 *     A contract that is not v1, or is missing a section, is REFUSED and the last
 *     good snapshot stays, its age shown.
 *   • Nothing here moves, pays, cancels or categorises anything, and nothing
 *     pushes. Finance decisions (recurring, unusual, planned payments,
 *     categories) are made in Tally by a person.
 *
 * Replaced Build 23's in-NEURO engine (finance-model.js, deleted): it had been
 * a second finance engine reading Tally's database over ssh.
 */

const crypto = require('crypto');
const { synthesise } = require('./finance-synthesis');

const CONTRACT = 'finance-intelligence-v1';
const SNAPSHOT_KEY = 'finance_intelligence';
const STATE_KEY = 'finance_intel_state';
const LEGACY_KEYS = ['finance_snapshot', 'finance_state'];
const SECTIONS = Object.freeze(['sourceHealth', 'coverage', 'balances', 'cashflow', 'monthly', 'trends', 'categories', 'recurring', 'priceChanges', 'unusual', 'pressure', 'upcoming']);
const OBLIGATION_KINDS = Object.freeze(['renewal', 'bill', 'annual_fee', 'subscription_renewal', 'household_charge', 'other']);
const RESOLVE_EVIDENCE = Object.freeze(['payment-seen', 'renewed', 'cancelled', 'statement']);
const TASK_REF = /^task:[^\s]{3,300}$/;
const TALLY_URL = () => String(process.env.TALLY_PUBLIC_URL || 'https://tally.nickward.co.uk').replace(/\/+$/, '');

// Dates and display only — never arithmetic over money.
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
const daysBetween = (a, b) => Math.round((dayMs(b) - dayMs(a)) / 86400000);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const pounds = (p) => `£${(Math.abs(p) / 100).toFixed(2)}`;

// ── the contract ─────────────────────────────────────────────────────────────

/** What is wrong with a payload, as NEURO depends on it. Empty = usable. PURE. */
function checkContract(c) {
  if (!c || typeof c !== 'object') return ['not an object'];
  const problems = [];
  if (c.contract !== CONTRACT) problems.push(`contract is "${c.contract}", NEURO reads ${CONTRACT}`);
  for (const s of SECTIONS) {
    if (!c[s] || typeof c[s] !== 'object') { problems.push(`section ${s} is missing`); continue; }
    const m = c[s].meta;
    if (!m || !('freshness' in m) || !('confidence' in m) || !Array.isArray(m.explanation)) problems.push(`section ${s} has no meta (freshness, confidence, explanation)`);
  }
  return problems;
}

// Tests inject a reader (a function returning the contract); production asks Tally.
let _defaultReader = null;
function useReader(fn) { _defaultReader = typeof fn === 'function' ? fn : null; }
async function fetchContract() { return require('./tally-api').call('GET', '/intelligence/contract'); }

// ── store helpers ────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }
function _json(key) { try { return JSON.parse(_db().getState(key) || 'null'); } catch { return null; } }
function _setJson(key, v) { _db().setState(key, JSON.stringify(v)); }
function _log(kind, detail, { subjectId = 'finance', actor = 'neuro', now = Date.now(), dedupeKey } = {}) {
  return require('./personal-obligations').logEvent(kind, { subjectId, actor, detail, dedupeKey: dedupeKey || `${kind}:${subjectId}:${now}`, now });
}
function localDay(ms = Date.now()) { return require('./world-model').localMinute(ms).slice(0, 10); }
const _iso = (now) => new Date(now).toISOString();

function _shapeObligation(o) {
  return {
    id: o.obligation_id, kind: o.kind, title: o.title, dueDate: o.due_date, expectedAmountPence: o.expected_amount_pence,
    seriesKey: o.series_key, requiresDecision: !!o.requires_decision, scope: o.scope, linkedTaskRef: o.linked_task_ref,
    linkedReminderRef: o.linked_reminder_ref, status: o.status, resolvedEvidence: o.resolved_evidence, resolvedNote: o.resolved_note,
    resolvedAt: o.resolved_at, provenance: o.provenance, createdAt: o.created_at, updatedAt: o.updated_at,
  };
}
function obligations({ status = null } = {}) {
  return _db().all(`SELECT * FROM finance_obligations ${status ? 'WHERE status = ?' : ''} ORDER BY COALESCE(due_date, '9999') , created_at`, status ? [status] : []).map(_shapeObligation);
}

/**
 * Payment evidence for an obligation linked to one of Tally's recurring series:
 * Tally says the series was last paid on or after (due − 7 days). A date
 * comparison over Tally's own fact — NEURO matches no transactions.
 */
function evidenceFor(o, contract) {
  if (!o.seriesKey || !o.dueDate || !contract) return null;
  const s = ((contract.recurring && contract.recurring.established) || []).find((x) => x.key === o.seriesKey);
  if (!s || !s.lastSeen || s.lastSeen < addDays(o.dueDate, -7)) return null;
  return { ref: `tally-series:${s.key}`, date: s.lastSeen, amountPence: s.typicalPence, basis: 'Tally: the linked recurring payment was last seen on this date' };
}

/** Tally's owner vocabulary → the one personal-admin and the Radar read. */
const OWNER = { primary: 'nick', shared: 'shared', private: 'private' };

/** Feed health in the shape NEURO's other surfaces read (personal-admin). Tally's words, verbatim. */
function healthFrom(contract) {
  if (!contract) return { household: 'unknown', label: 'Finance has not been read from Tally yet', accounts: [] };
  const f = contract.sourceHealth.bankFeed;
  const label = { healthy: 'Bank feeds live', partial: 'Some bank feeds are live', stale: 'Bank feeds are stale', reconnect_required: 'Bank feeds need reconnecting', unknown: 'Bank feed state unknown' }[f.household] || f.household;
  return { household: f.household, label, rule: contract.sourceHealth.meta.explanation[0],
    accounts: f.accounts.map((a) => ({ accountRef: `tally-account:${a.accountId}`, name: a.name, owner: OWNER[a.owner] || a.owner, state: a.state, why: a.why, lastRefreshAt: a.lastRefreshAt })) };
}

// ── obligation state (read time) ─────────────────────────────────────────────

const NEEDS_YOU_DAYS = 1;          // the existing personal-obligation rule
const PREP_NEEDS_YOU_DAYS = 2;     // the existing Radar prep rule

/**
 * later | upcoming | preparation_open | needs_you | overdue | complete | unknown.
 * A ticked task is the ACTION, not the payment: without Tally's evidence the
 * obligation says "action done — payment not seen in Tally".
 */
function obligationState(o, { today, task = null, evidence = null, feedStale = false } = {}) {
  if (o.status !== 'open') return { state: 'complete', why: o.status === 'cancelled' ? 'cancelled' : `resolved (${o.resolvedEvidence})` };
  if (!o.dueDate) return { state: 'unknown', why: 'no date recorded' };
  const days = daysBetween(today, o.dueDate);
  const taskOpen = task && !['done', 'complete', 'completed', 'dropped'].includes(String(task.status || task.state || '').toLowerCase());
  const taskDone = task && !taskOpen;
  const payment = evidence ? `payment seen in Tally on ${evidence.date} (${pounds(evidence.amountPence)})` : taskDone
    ? `your task is done — that is the action; the payment itself has not been seen in Tally${feedStale ? ' (the bank feed is stale)' : ''}` : null;
  if (days < 0) return { state: evidence ? 'upcoming' : 'overdue', why: evidence ? payment : `was due ${o.dueDate}`, payment };
  if (days <= NEEDS_YOU_DAYS) return { state: 'needs_you', why: days === 0 ? 'due today' : 'due tomorrow', payment };
  if ((taskOpen || (o.requiresDecision && !taskDone)) && days <= PREP_NEEDS_YOU_DAYS) return { state: 'needs_you', why: `due in ${days} days and ${o.requiresDecision ? 'it needs your decision' : 'its task is still open'}`, payment };
  if (taskOpen || o.requiresDecision) return { state: 'preparation_open', why: o.requiresDecision ? 'needs a decision before it is due' : 'its task is open', payment };
  if (days <= 30) return { state: 'upcoming', why: `due in ${days} days`, payment };
  return { state: 'later', why: `due ${o.dueDate}`, payment };
}

// ── the operational view (PURE over the contract + NEURO's own facts) ───────────

const MATERIAL = /^materially_/;

/**
 * What matters to Nick operationally, from Tally's facts. Selection and wording
 * only — every number shown is Tally's. `needsAction` is what asks something of
 * Nick through EXISTING rules (an obligation's own state, a bank feed that needs
 * re-approving); a trend, an anomaly or a price change on its own never does.
 */
function operational(contract, { today, obligations: obs = [], vehicles = [] } = {}) {
  if (!contract) return null;
  const c = contract;
  const d30 = (c.cashflow.horizons || []).find((h) => h.days === 30) || null;
  const position = { usablePence: c.balances.household.usableLiquidPence, coverage: c.balances.household.coverage, statement: c.balances.household.statement };
  const forecast = {
    confidence: c.cashflow.confidence, why: c.cashflow.confidenceWhy,
    d30: d30 ? { through: d30.through, projectedPence: d30.projectedPence, projectedRange: d30.projectedRange, lowestPoint: d30.lowestPoint, dayToDayNotProjectedPence: d30.dayToDayNotProjectedPence } : null,
    nextIncome: c.cashflow.nextIncome,
    untilNextIncome: c.cashflow.toNextIncome ? { through: c.cashflow.toNextIncome.through, projectedPence: c.cashflow.toNextIncome.projectedPence, lowestPoint: c.cashflow.toNextIncome.lowestPoint } : null,
    excludedUnknowns: c.cashflow.excludedUnknowns,
  };
  const changes = [
    ...c.trends.items.filter((t) => MATERIAL.test(t.state) && ['spending', 'money out', 'income'].includes(t.measure)).map((t) => ({ kind: 'trend', state: t.state, line: t.line, timing: t.timing ? t.timing.note : null })),
    ...c.priceChanges.items.filter((p) => p.confirmed && p.annualEffectPence != null).map((p) => ({ kind: 'price-change', line: `${p.label}: ${p.line}`, since: p.firstObserved })),
  ];
  // Upcoming: what Tally knows that is explicit and dated (planned payments, annual payments) — never every
  // direct debit — beside the obligations Nick recorded in NEURO.
  const upcoming = [
    ...c.upcoming.items.filter((i) => i.kind === 'planned' || i.kind === 'annual').map((i) => ({ source: 'tally', kind: i.kind, date: i.date, label: i.label, direction: i.direction, pence: i.pence })),
    ...obs.filter((o) => o.status === 'open').map((o) => ({ source: 'neuro', kind: 'obligation', id: o.id, date: o.dueDate, label: o.title, pence: o.expectedAmountPence, state: o.state, stateWhy: o.stateWhy })),
  ].sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')));
  const needsAction = [];
  for (const o of obs.filter((x) => x.status === 'open' && ['needs_you', 'overdue'].includes(x.state))) needsAction.push({ kind: 'obligation', id: o.id, line: `${o.title} — ${o.stateWhy}` });
  for (const a of c.sourceHealth.bankFeed.accounts.filter((x) => x.state === 'reconnect_required')) {
    needsAction.push({ kind: 'feed', ref: `tally-account:${a.accountId}`, line: a.owner === 'private' ? `${a.name}'s bank feed needs re-approving at the bank — theirs to do; your part is asking` : `Reconnect the ${a.name} bank feed in Tally — ${a.why}` });
  }
  const toLook = { unusual: c.unusual.items.length, priceChanges: c.priceChanges.items.length, where: `${TALLY_URL()} → Outlook` };
  return {
    contract: c.contract, generatedAt: c.generatedAt, position, forecast, pressure: { state: c.pressure.state, why: c.pressure.why },
    changes, upcoming, needsAction, toLook, synthesis: synthesise(c, { today, vehicles }),
    categories: { available: c.categories.available, why: c.categories.why, period: c.categories.meta.period },
  };
}

function _vehicles() {
  try {
    const v = require('./vehicle');
    return v.listVehicles().map((row) => { const r = v.read(row.vehicle_id); return r ? { id: row.vehicle_id, name: `${r.vehicle.make} ${r.vehicle.model}`.trim(), obligations: r.obligations } : null; }).filter(Boolean);
  } catch { return []; }
}

function _taskIndex() {
  try { return new Map((require('./canonical-read').tasks({ status: 'all', limit: 2000 }).items || []).map((t) => [t.id, t])); } catch { return new Map(); }
}

function _activation() {
  let lists = [];
  try { lists = require('./reminder-audit').read({}).lists || []; } catch { lists = null; }
  if (!lists) return { state: 'unknown', why: 'the reminder-list audit could not be read' };
  const named = lists.filter((l) => String(l.name || '').trim().toLowerCase() === 'personal admin');
  const act = require('./personal-obligations').adminActivation(lists);
  return { ...act, personalAdminListOnPhone: named.length > 0,
    note: named.length ? null : 'There is no "Personal Admin" list on the phone yet. NEURO cannot create Apple lists and has not made a substitute.' };
}

/** What the Finance view shows. Never reads Tally — it reads the last contract snapshot. */
function read({ now = Date.now(), taskIndex = null, vehicles = null } = {}) {
  const snap = _json(SNAPSHOT_KEY);
  const state = _json(STATE_KEY) || {};
  const today = localDay(now);
  const contract = snap ? snap.contract : null;
  const tasks = taskIndex || _taskIndex();
  const health = healthFrom(contract);
  const obs = obligations().map((o) => {
    const task = o.linkedTaskRef ? tasks.get(o.linkedTaskRef) || null : (o.linkedReminderRef ? tasks.get(o.linkedReminderRef) || null : null);
    const st = obligationState(o, { today, task, evidence: evidenceFor(o, contract), feedStale: health.household !== 'healthy' });
    return { ...o, state: st.state, stateWhy: st.why, payment: st.payment || null, task: task ? { id: task.id, title: task.description || task.title, status: task.state || task.status } : null };
  });
  const ageMinutes = snap ? Math.round((now - Date.parse(snap.fetchedAt)) / 60000) : null;
  return {
    ok: true, contract: 'finance-operational-v1',
    source: { system: 'tally', reads: CONTRACT, generatedAt: contract ? contract.generatedAt : null, fetchedAt: snap ? snap.fetchedAt : null, ageMinutes, tallyUrl: TALLY_URL() },
    lastRead: { at: state.lastOkAt || null, attemptAt: state.lastAttemptAt || null, ok: state.lastOk ?? null, error: state.error || null },
    health, sourceHealth: contract ? contract.sourceHealth : null,
    operational: operational(contract, { today, obligations: obs, vehicles: vehicles || _vehicles() }),
    obligations: obs, personalAdmin: _activation(),
    // Outgoing recurring payments an obligation may be linked to (Tally's list, household-visible only).
    linkable: contract ? contract.recurring.established.filter((s) => s.direction === 'out').map((s) => ({ key: s.key, label: s.label, typicalPence: s.typicalPence })) : [],
    rule: 'Tally understands the money; NEURO understands why it matters. Every finance figure here is Tally\'s, read from its finance-intelligence-v1 contract — NEURO calculates none of them. Finance decisions (recurring, unusual, planned payments, categories) are made in Tally. NEURO never moves money, pays, cancels or categorises.',
  };
}

// ── refresh (the durable job body) ───────────────────────────────────────────

/**
 * Read Tally's contract, keep it, record what CHANGED in Activity. A refused or
 * failed read keeps the last good snapshot (its age is shown) and stores
 * nothing new. The first good read is a baseline: one line, nothing per item.
 */
async function refresh({ now = Date.now(), reader = null } = {}) {
  reader = reader || _defaultReader;
  const iso = _iso(now);
  const prevState = _json(STATE_KEY) || {};
  if (String(process.env.TALLY_READ || 'on').toLowerCase() === 'off' && !reader) return { ok: true, skipped: true, reason: 'TALLY_READ=off' };
  let contract;
  try { contract = await (reader ? reader() : fetchContract()); } catch (e) {
    _setJson(STATE_KEY, { ...prevState, lastAttemptAt: iso, lastOk: false, error: e.message });
    return { ok: false, error: e.message };
  }
  const problems = checkContract(contract);
  if (problems.length) {
    const error = `Tally's finance contract was refused: ${problems.join('; ')}`;
    _setJson(STATE_KEY, { ...prevState, lastAttemptAt: iso, lastOk: false, error });
    return { ok: false, error };
  }
  const prev = _json(SNAPSHOT_KEY);
  _setJson(SNAPSHOT_KEY, { fetchedAt: iso, contract });
  // Build 23 kept NEURO-calculated summaries; under the Build 26 boundary they are a second ledger. Gone.
  if (!prevState.legacyCleared) {
    for (const k of LEGACY_KEYS) _db().setState(k, 'null');
    try { _db().run('DELETE FROM finance_monthly_summaries'); } catch { /* table absent */ }
  }
  const logged = prevState.baselined && prev ? _logChanges(prev.contract, contract, { now }) : 0;
  if (!prevState.baselined) _log('finance-intelligence-connected', { contract: CONTRACT, feed: contract.sourceHealth.bankFeed.household, forecast: contract.cashflow.confidence }, { now, dedupeKey: 'finance-intelligence-connected' });
  _setJson(STATE_KEY, { lastAttemptAt: iso, lastOkAt: iso, lastOk: true, error: null, baselined: true, legacyCleared: true, firstAt: prevState.firstAt || iso });
  return { ok: true, contract: CONTRACT, feed: contract.sourceHealth.bankFeed.household, forecast: contract.cashflow.confidence, logged };
}

const CAT_RANK = { unknown: 0, poor: 1, partial: 2, good: 3 };

/** Activity on CHANGE only — never per transaction, per refresh or per render. Compares Tally's states. */
function _logChanges(prev, next, { now }) {
  let n = 0;
  const L = (kind, detail, opt) => { if (_log(kind, detail, { now, ...opt })) n++; };
  const acct = (a) => (a.owner === 'private' ? `${a.name}'s account` : a.name);
  const was = new Map(((prev && prev.sourceHealth && prev.sourceHealth.bankFeed.accounts) || []).map((a) => [a.accountId, a.state]));
  for (const a of next.sourceHealth.bankFeed.accounts) {
    const w = was.get(a.accountId);
    if (!w || w === a.state) continue;
    if (a.state === 'healthy') L('finance-source-recovered', { account: acct(a), was: w }, { subjectId: `tally-account:${a.accountId}`, dedupeKey: `finance-source-recovered:${a.accountId}:${now}` });
    else if (w === 'healthy') L('finance-source-stale', { account: acct(a), state: a.state, why: a.why }, { subjectId: `tally-account:${a.accountId}`, dedupeKey: `finance-source-stale:${a.accountId}:${now}` });
  }
  const pc = prev && prev.cashflow ? prev.cashflow.confidence : 'unavailable';
  const nc = next.cashflow.confidence;
  if (pc === 'unavailable' && nc !== 'unavailable') L('finance-forecast-available', { confidence: nc }, { dedupeKey: `finance-forecast-available:${now}` });
  if (pc !== 'unavailable' && nc === 'unavailable') L('finance-forecast-unavailable', { why: next.cashflow.confidenceWhy[0] || null }, { dedupeKey: `finance-forecast-unavailable:${now}` });
  const held = new Set(((prev && prev.recurring && prev.recurring.established) || []).map((s) => s.key));
  for (const s of next.recurring.established.filter((x) => !held.has(x.key))) {
    L('finance-recurring-recognised', { label: s.label, state: s.state, byYou: s.state === 'explicit_recurring' }, { subjectId: s.key, dedupeKey: `finance-recurring-recognised:${s.key}` });
  }
  const pcs = new Set(((prev && prev.priceChanges && prev.priceChanges.items) || []).map((p) => `${p.seriesKey}:${p.toPence}`));
  for (const p of next.priceChanges.items.filter((x) => !pcs.has(`${x.seriesKey}:${x.toPence}`))) {
    L('finance-price-changed', { label: p.label, fromPence: p.fromPence, toPence: p.toPence, annualEffectPence: p.annualEffectPence }, { subjectId: p.seriesKey, dedupeKey: `finance-price-changed:${p.seriesKey}:${p.toPence}` });
  }
  const pq = prev && prev.sourceHealth ? prev.sourceHealth.categories.state : 'unknown';
  const nq = next.sourceHealth.categories.state;
  if (pq !== 'unknown' && (CAT_RANK[nq] || 0) > (CAT_RANK[pq] || 0)) L('finance-category-quality-improved', { from: pq, to: nq, why: next.sourceHealth.categories.why }, { dedupeKey: `finance-category-quality:${nq}:${now}` });
  const pu = new Set(((prev && prev.unusual && prev.unusual.items) || []).map((u) => u.key));
  for (const u of next.unusual.items.filter((x) => !pu.has(x.key))) L('finance-unusual-found', { line: u.line }, { subjectId: u.key, dedupeKey: `finance-unusual-found:${u.key}` });
  return n;
}

// ── statements that moved to Tally (Build 26) ────────────────────────────────

/** Recurring, unusual and category decisions are Tally's now — made there, by a person. */
function movedToTally(what) {
  return { ok: false, status: 410, error: `${what} is decided in Tally now (${TALLY_URL()} → Outlook). NEURO reads the result; it no longer holds finance decisions.`, movedTo: TALLY_URL() };
}

// ── finance obligations (typed facts; the action stays a task) ───────────────

function _validObligation(body, { partial = false } = {}) {
  if (!partial || body.kind !== undefined) if (!OBLIGATION_KINDS.includes(body.kind)) return `kind must be one of ${OBLIGATION_KINDS.join(', ')}`;
  if (!partial || body.title !== undefined) if (!(typeof body.title === 'string' && body.title.trim().length >= 2)) return 'a title is needed';
  if (body.dueDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.dueDate))) return 'dueDate must be YYYY-MM-DD';
  if (body.expectedAmountPence != null && !(Number.isInteger(body.expectedAmountPence) && body.expectedAmountPence > 0)) return 'expectedAmountPence must be a positive whole number of pence';
  for (const k of ['linkedTaskRef', 'linkedReminderRef']) if (body[k] != null && !TASK_REF.test(String(body[k]))) return `${k} must be a task id (task:…)`;
  if (body.scope != null && !['household', 'nick'].includes(body.scope)) return 'scope must be household or nick';
  return null;
}

function addObligation(body = {}, { now = Date.now(), actor = 'nick' } = {}) {
  const bad = _validObligation(body);
  if (bad) return { ok: false, status: 400, error: bad };
  if (body.seriesKey) {
    const snap = _json(SNAPSHOT_KEY);
    // The contract lists only household-visible series: another person's own payments are never linkable.
    const s = snap && snap.contract && snap.contract.recurring.established.find((x) => x.key === body.seriesKey);
    if (!s) return { ok: false, status: 404, error: 'no such recurring payment in Tally' };
  }
  const id = `fo_${crypto.randomUUID()}`;
  const iso = _iso(now);
  _db().run(`INSERT INTO finance_obligations (obligation_id, kind, title, due_date, expected_amount_pence, series_key, requires_decision, scope, linked_task_ref, linked_reminder_ref, status, provenance, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
  [id, body.kind, body.title.trim(), body.dueDate || null, body.expectedAmountPence || null, body.seriesKey || null, body.requiresDecision ? 1 : 0, body.scope || 'household',
    body.linkedTaskRef || null, body.linkedReminderRef || null, body.provenance || 'stated by Nick', actor, iso, iso]);
  _log('finance-obligation-added', { title: body.title.trim(), kind: body.kind, dueDate: body.dueDate || null }, { subjectId: id, actor, now, dedupeKey: `finance-obligation-added:${id}` });
  if (body.linkedTaskRef || body.linkedReminderRef) _log('finance-obligation-linked', { title: body.title.trim(), ref: body.linkedTaskRef || body.linkedReminderRef }, { subjectId: id, actor, now, dedupeKey: `finance-obligation-linked:${id}:${now}` });
  return { ok: true, obligation: obligations().find((o) => o.id === id) };
}

function updateObligation(id, body = {}, { now = Date.now(), actor = 'nick' } = {}) {
  const db = _db();
  const held = db.get('SELECT * FROM finance_obligations WHERE obligation_id = ?', [id]);
  if (!held) return { ok: false, status: 404, error: 'no such finance obligation' };
  if (held.status !== 'open') return { ok: false, status: 409, error: 'that obligation is already resolved' };
  const bad = _validObligation(body, { partial: true });
  if (bad) return { ok: false, status: 400, error: bad };
  const map = { title: 'title', dueDate: 'due_date', expectedAmountPence: 'expected_amount_pence', requiresDecision: 'requires_decision', linkedTaskRef: 'linked_task_ref', linkedReminderRef: 'linked_reminder_ref', kind: 'kind' };
  const sets = []; const vals = [];
  for (const [k, col] of Object.entries(map)) if (body[k] !== undefined) { sets.push(`${col} = ?`); vals.push(k === 'requiresDecision' ? (body[k] ? 1 : 0) : body[k]); }
  if (!sets.length) return { ok: false, status: 400, error: 'nothing to change' };
  db.run(`UPDATE finance_obligations SET ${sets.join(', ')}, updated_at = ? WHERE obligation_id = ?`, [...vals, _iso(now), id]);
  const linked = (body.linkedTaskRef && body.linkedTaskRef !== held.linked_task_ref) || (body.linkedReminderRef && body.linkedReminderRef !== held.linked_reminder_ref);
  if (linked) _log('finance-obligation-linked', { title: held.title, ref: body.linkedTaskRef || body.linkedReminderRef }, { subjectId: id, actor, now, dedupeKey: `finance-obligation-linked:${id}:${now}` });
  return { ok: true, obligation: obligations().find((o) => o.id === id) };
}

/**
 * Resolving needs EVIDENCE. "payment-seen" needs Tally to have seen the linked
 * recurring payment; ticking a task is never evidence that money moved.
 */
function resolveObligation(id, { evidence, note = null } = {}, { now = Date.now(), actor = 'nick' } = {}) {
  const db = _db();
  const held = db.get('SELECT * FROM finance_obligations WHERE obligation_id = ?', [id]);
  if (!held) return { ok: false, status: 404, error: 'no such finance obligation' };
  if (held.status !== 'open') return { ok: false, status: 409, error: 'that obligation is already resolved' };
  if (!RESOLVE_EVIDENCE.includes(evidence)) return { ok: false, status: 400, error: `evidence must be one of ${RESOLVE_EVIDENCE.join(', ')} — a ticked task is not evidence of payment` };
  let detail = note;
  if (evidence === 'payment-seen') {
    const snap = _json(SNAPSHOT_KEY);
    const ev = evidenceFor(_shapeObligation(held), snap && snap.contract);
    if (!ev) return { ok: false, status: 409, error: 'No matching payment has been seen in Tally yet. Link a recurring payment, or resolve with renewed, cancelled or statement.' };
    detail = `payment ${ev.ref} on ${ev.date}`;
  } else if (!(typeof note === 'string' && note.trim().length >= 3)) return { ok: false, status: 400, error: 'say what the evidence is (a note of at least 3 characters)' };
  db.run(`UPDATE finance_obligations SET status = ?, resolved_evidence = ?, resolved_note = ?, resolved_at = ?, updated_at = ? WHERE obligation_id = ?`,
    [evidence === 'cancelled' ? 'cancelled' : 'resolved', evidence, detail, _iso(now), _iso(now), id]);
  _log('finance-obligation-resolved', { title: held.title, evidence, detail }, { subjectId: id, actor, now, dedupeKey: `finance-obligation-resolved:${id}` });
  return { ok: true };
}

// ── Future Radar (explicit, dated, operationally meaningful — never routine) ──

/**
 * Finance on the Radar:
 *   • obligations Nick recorded (their own action state),
 *   • Tally's PLANNED payments and established ANNUAL payments inside the window
 *     (context: a dated, explicit fact Tally holds),
 *   • a cross-domain pinch: Tally reads the month as tight AND a real non-finance
 *     obligation falls in it (context beside that obligation).
 * Never: a direct debit, a monthly trend, "spending is up", an anomaly.
 */
function radar({ today, last, now = Date.now(), taskIndex = null, vehicles = null } = {}) {
  const items = [];
  try {
    const r = read({ now, taskIndex, vehicles });
    const map = { overdue: 'needs_you', needs_you: 'needs_you', preparation_open: 'preparation_open', upcoming: 'none', later: 'none', unknown: 'unknown' };
    for (const o of r.obligations) {
      if (o.status !== 'open') continue;
      const actionState = map[o.state] || 'unknown';
      const inWindow = o.dueDate && o.dueDate >= today && o.dueDate <= last;
      if (!inWindow && actionState !== 'needs_you') continue;
      items.push({
        id: o.id, title: o.title, detail: o.expectedAmountPence ? `expected ${pounds(o.expectedAmountPence)}` : null, date: o.dueDate,
        kind: 'finance', obligationType: o.kind, actionState, needsWhy: o.stateWhy,
        linkedTaskRefs: [o.linkedTaskRef, o.linkedReminderRef].filter(Boolean),
        whyVisible: [`a ${o.kind.replace(/_/g, ' ')} you recorded`, o.stateWhy, o.payment].filter(Boolean),
        confidence: 'high',
      });
    }
    const op = r.operational;
    if (op) {
      for (const u of op.upcoming.filter((x) => x.source === 'tally' && x.date && x.date >= today && x.date <= last)) {
        items.push({
          id: `tally-${u.kind}:${u.date}:${u.label}`, title: u.label, detail: `${u.direction === 'in' ? 'in' : 'out'} ${pounds(u.pence)} (Tally)`, date: u.date,
          kind: 'finance', obligationType: u.kind === 'annual' ? 'annual_payment' : 'planned_payment', actionState: 'none', needsWhy: null, linkedTaskRefs: [],
          whyVisible: [u.kind === 'annual' ? 'an established annual payment in Tally' : 'a planned payment recorded in Tally'], confidence: 'high',
        });
      }
      for (const s of op.synthesis.filter((x) => x.kind === 'pinch-overlaps' && x.date && x.date >= today && x.date <= last)) {
        items.push({
          id: s.id, title: 'A tighter month around a car date', detail: s.line, date: s.date, kind: 'finance', obligationType: 'cross_domain',
          actionState: 'none', needsWhy: null, linkedTaskRefs: [], whyVisible: s.facts.map((f) => `${f.system === 'tally' ? 'Tally' : 'NEURO'}: ${f.statement}`), confidence: 'medium',
        });
      }
    }
  } catch (e) { return { items, error: e.message }; }
  return { items };
}

/** One month's summary — Tally's, from the contract. */
function monthly(month) {
  const snap = _json(SNAPSHOT_KEY);
  const m = snap && snap.contract ? snap.contract.monthly.months.find((x) => x.month === month) : null;
  return m ? { ...m, source: 'tally', generatedAt: snap.contract.generatedAt } : null;
}

const TABLES = ['finance_obligations'];

module.exports = {
  CONTRACT, SECTIONS, SNAPSHOT_KEY, OBLIGATION_KINDS, RESOLVE_EVIDENCE, TABLES,
  checkContract, useReader, fetchContract, healthFrom, evidenceFor, operational, obligationState,
  read, refresh, movedToTally, addObligation, updateObligation, resolveObligation, obligations, radar, monthly,
};
