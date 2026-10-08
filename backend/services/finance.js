'use strict';

/**
 * Build 23 — Finance activation. Tally is the source of truth; NEURO is the
 * operational layer over it.
 *
 * What this module is, and is not:
 *   • It READS Tally (sqlite3 -readonly over ssh, fixed SQL, named columns —
 *     never a token, account number or sort code) and keeps NO copy of the
 *     ledger. Each refresh normalises the read in memory (finance-model.js) and
 *     stores only what NEURO derives: monthly summaries, recurring series,
 *     exception items from household accounts, feed health. Helen's own
 *     account reaches the store only as totals.
 *   • The only finance rows NEURO writes are Nick's own statements: a domain
 *     decision on one transaction, a reusable rule, "this is / is not
 *     recurring", a review answer, a finance obligation and its links.
 *   • No money moves, nothing is paid, cancelled or edited in Tally, nothing is
 *     pushed. A source scan pins that this file imports no sender.
 */

const crypto = require('crypto');
const M = require('./finance-model');

const SNAPSHOT_KEY = 'finance_snapshot';
const STATE_KEY = 'finance_state';
const OBLIGATION_KINDS = Object.freeze(['renewal', 'bill', 'annual_fee', 'subscription_renewal', 'household_charge', 'other']);
const RULE_KINDS = Object.freeze(['merchant', 'merchant+category', 'tag']);
const RESOLVE_EVIDENCE = Object.freeze(['payment-seen', 'renewed', 'cancelled', 'statement']);
const TASK_REF = /^task:[^\s]{3,300}$/;

// ── the Tally reader (read-only, fixed SQL, named columns) ───────────────────

function config() {
  return {
    enabled: String(process.env.TALLY_READ || 'on').toLowerCase() !== 'off',
    sshTarget: process.env.TALLY_SSH_TARGET || 'nickw@100.69.158.50',
    dbPath: process.env.TALLY_DB_PATH || '/home/nickw/tally/tally.db',
  };
}

// Every column is named. truelayer_connections holds bank tokens and
// truelayer_accounts holds account numbers: neither is ever selected.
const QUERIES = Object.freeze({
  schema: "SELECT 'transactions' AS t, name FROM pragma_table_info('transactions') UNION ALL SELECT 'accounts', name FROM pragma_table_info('accounts') UNION ALL SELECT 'truelayer_accounts', name FROM pragma_table_info('truelayer_accounts') UNION ALL SELECT 'truelayer_connections', name FROM pragma_table_info('truelayer_connections') UNION ALL SELECT 'recurring_charges', name FROM pragma_table_info('recurring_charges')",
  transactions: 'SELECT t.id AS id, t.account_id AS account_id, t.date AS date, t.amount AS amount, t.description AS description, t.is_transfer AS is_transfer, t.transfer_pair_id AS transfer_pair_id, t.balance_after AS balance_after, t.created_at AS created_at, c.name AS category_name, c.kind AS category_kind FROM transactions t LEFT JOIN categories c ON c.id = t.category_id ORDER BY t.id',
  accounts: 'SELECT a.id AS id, a.name AS name, a.type AS type, a.active AS active, a.opening_balance AS opening_balance, u.display_name AS owner FROM accounts a LEFT JOIN users u ON u.id = a.owner_user_id ORDER BY a.id',
  connections: 'SELECT id, provider_name, expires_at, last_sync_at, active, created_at FROM truelayer_connections ORDER BY id',
  tlAccounts: 'SELECT id, connection_id, account_type, currency, linked_account_id, last_sync_at, created_at FROM truelayer_accounts ORDER BY id',
  tallyRecurring: 'SELECT merchant, typical_amount, cadence, last_seen, next_expected, active, ignored FROM recurring_charges',
  tallyRules: 'SELECT match_value FROM rules',
});
const EXPECTED = Object.freeze({
  transactions: ['id', 'account_id', 'date', 'amount', 'description', 'category_id', 'is_transfer', 'transfer_pair_id', 'balance_after', 'created_at'],
  accounts: ['id', 'name', 'type', 'owner_user_id', 'opening_balance', 'active'],
  truelayer_accounts: ['id', 'connection_id', 'linked_account_id', 'last_sync_at', 'created_at'],
  truelayer_connections: ['id', 'provider_name', 'expires_at', 'last_sync_at', 'active', 'created_at'],
  recurring_charges: ['merchant', 'typical_amount', 'cadence', 'last_seen', 'next_expected', 'active', 'ignored'],
});
const SPLIT = '@@NEURO_FINANCE_SPLIT@@';

function _remote(order) {
  const c = config();
  // The SQL are module constants; nothing from a request reaches this string.
  return order.map((k) => `sqlite3 -readonly -json ${JSON.stringify(c.dbPath)} ${JSON.stringify(QUERIES[k])}; echo; echo ${SPLIT}`).join('; ');
}

function _ssh(remote, { execFile = require('child_process').execFile } = {}) {
  const c = config();
  return new Promise((resolve, reject) => {
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', c.sshTarget, remote], { timeout: 90000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`Tally could not be read: ${String(err.message).split('\n')[0]}`));
      resolve(String(stdout || ''));
    });
  });
}

/** Check Tally's schema first; a changed table is REFUSED, never half-read. */
function checkSchema(rows) {
  const have = {};
  for (const r of rows) (have[r.t] = have[r.t] || new Set()).add(r.name);
  const problems = [];
  for (const [table, cols] of Object.entries(EXPECTED)) {
    if (!have[table]) { problems.push(`${table} is missing`); continue; }
    const miss = cols.filter((c) => !have[table].has(c));
    if (miss.length) problems.push(`${table} lost ${miss.join(', ')}`);
  }
  return problems;
}

async function readTally(deps = {}) {
  const order = ['schema', 'transactions', 'accounts', 'connections', 'tlAccounts', 'tallyRecurring', 'tallyRules'];
  const text = await _ssh(_remote(order), deps);
  const parts = text.split(SPLIT).map((p) => p.trim());
  const out = {};
  order.forEach((k, i) => {
    const p = parts[i] || '';
    try { out[k] = p ? JSON.parse(p) : []; } catch { throw new Error(`Tally answered something that is not JSON (${k})`); }
  });
  const problems = checkSchema(out.schema);
  if (problems.length) throw new Error(`Tally's schema changed (${problems.join('; ')}) — not read`);
  delete out.schema;
  return out;
}

// ── store helpers ────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }
function _json(key) { try { return JSON.parse(_db().getState(key) || 'null'); } catch { return null; } }
function _setJson(key, v) { _db().setState(key, JSON.stringify(v)); }
function _log(kind, detail, { subjectId = 'finance', actor = 'neuro', now = Date.now(), dedupeKey } = {}) {
  return require('./personal-obligations').logEvent(kind, { subjectId, actor, detail, dedupeKey: dedupeKey || `${kind}:${subjectId}:${now}`, now });
}
function localDay(ms = Date.now()) { return require('./world-model').localMinute(ms).slice(0, 10); }
const _iso = (now) => new Date(now).toISOString();

function rules({ activeOnly = true } = {}) { return _db().all(`SELECT * FROM finance_rules ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY confirmed_at`); }
function _decisions() { return new Map(_db().all('SELECT * FROM finance_txn_decisions').map((d) => [d.source_txn_id, d])); }
function _recurringDecisions() { return new Map(_db().all('SELECT * FROM finance_recurring_decisions').map((d) => [d.series_key, d])); }
function _reviewDecisions() { return new Map(_db().all('SELECT * FROM finance_review_decisions').map((d) => [d.item_key, d])); }

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

// ── compose (pure over a Tally read + Nick's decisions) ──────────────────────

/** Strip a normalised row to what a household-visible surface may show. */
function _item(t) {
  return { ref: t.provenance, sourceTransactionId: t.sourceTransactionId, date: t.date, amountPence: t.amountPence, merchantKey: t.merchantKey,
    category: t.category, account: t.accountName, accountRef: t.accountRef, owner: t.owner, domain: t.domain, domainBasis: t.domainBasis, status: t.status, transactionType: t.transactionType };
}
const VISIBLE = (t) => t.owner !== 'helen';

/**
 * Everything NEURO derives from one Tally read. PURE (given today/now).
 * Item-level lists contain household-visible rows only; Helen's account is
 * counted and totalled, never listed.
 */
function compose(read, { now, rules: rs = [], decisions = new Map(), recurringDecisions = new Map(), reviewDecisions = new Map(), obligations: obs = [], knownAccounts = [] } = {}) {
  const today = new Date(now).toISOString().slice(0, 10);
  const rows = M.normalise(read, { decisions, rules: rs });
  const coverage = M.accountCoverage({ rows, accounts: read.accounts, tlAccounts: read.tlAccounts });
  const dataFrom = coverage.map((c) => c.from).filter(Boolean).sort()[0] || null;
  const dataThrough = coverage.map((c) => c.through).filter(Boolean).sort().slice(-1)[0] || null;
  const series = M.detectRecurring(rows, { coverage, decisions: recurringDecisions, tallyRecurring: read.tallyRecurring || [], today });
  const unusual = M.unusualSpend(rows, { series, obligations: obs, reviewDecisions, dataFrom });
  const duplicates = M.duplicateCharges(rows, { series, reviewDecisions });
  const quality = M.categoryQuality(rows, { tallyRules: read.tallyRules || [], visible: VISIBLE });
  // Every month in the covered window — a covered month with no transactions
  // is a fact (nothing moved), not a missing row.
  const months = [];
  if (dataFrom && dataThrough) {
    let m = dataFrom.slice(0, 7);
    while (m <= dataThrough.slice(0, 7)) { months.push(m); const x = new Date(`${m}-01T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); m = x.toISOString().slice(0, 7); }
  }
  const summaries = months.map((m) => M.monthlySummary(m, rows, { coverage, series, unusual, duplicates, visible: VISIBLE }));
  const health = M.feedHealth({ accounts: read.accounts, tlAccounts: read.tlAccounts, connections: read.connections, coverage, now });
  // While some accounts refresh and others do not (Helen's, until she
  // reconnects), the HOUSEHOLD months stay partial — never relabelled. Beside
  // them, a comparison over the live accounts only, saying which are excluded.
  let comparison = { basis: 'household', excluded: [], summaries: null, monthOnMonth: null };
  const live = health.accounts.filter((a) => a.state === 'healthy').map((a) => Number(a.accountRef.split(':')[1]));
  const stale = health.accounts.filter((a) => a.state !== 'healthy');
  if (live.length && stale.length) {
    const rowsLive = rows.filter((t) => live.includes(t.accountId));
    const covLive = coverage.filter((c) => live.includes(c.accountId));
    const liveSummaries = months.map((m) => M.monthlySummary(m, rowsLive, { coverage: covLive, series, unusual, duplicates, visible: VISIBLE }));
    const excluded = stale.map((a) => (a.owner === 'helen' ? 'Helen\'s own account' : a.name));
    const lastData = stale.map((a) => a.newestTransaction).filter(Boolean).sort().slice(-1)[0] || null;
    comparison = {
      basis: 'live-accounts', excluded, note: `Excluding ${excluded.join(', ')}, which ${excluded.length === 1 ? 'is' : 'are'} not refreshing${lastData ? ` (data ends ${lastData})` : ''}. Household totals stay partial.`,
      summaries: liveSummaries.map((s) => ({ month: s.month, complete: s.complete, coverageReasons: s.coverageReasons, spendPence: s.spendPence, moneyOutPence: s.moneyOutPence, incomePence: s.incomePence, byDomain: s.byDomain, recurringPence: s.recurringPence, biggestMerchants: s.biggestMerchants, cardRepaymentsPence: s.cardRepaymentsPence, financingPence: s.financingPence })),
      monthOnMonth: M.monthOnMonth(liveSummaries),
    };
  }
  const bal = M.balances(read, coverage, { today });
  const staleFeed = health.household !== 'healthy';
  const upcoming = M.upcomingMoneyOut({ series, obligations: obs, today, staleFeed });
  const cashflow = M.forwardCashflow({ balances: bal, series, upcoming });
  const reconnect = M.reconnectReport({ accounts: read.accounts, tlAccounts: read.tlAccounts, connections: read.connections, transactions: read.transactions, knownAccounts, rows });
  // payment evidence for open obligations linked to a series: a payment on or after (due − 7 days)
  const evidence = {};
  for (const o of obs.filter((x) => x.seriesKey)) {
    const s = series.find((x) => x.seriesKey === o.seriesKey);
    if (!s || !o.dueDate) continue;
    const hit = rows.find((t) => s.txnIds.includes(t.sourceTransactionId) && t.date >= M.addDays(o.dueDate, -7) && M.COUNTS(t.status));
    if (hit) evidence[o.id] = { ref: hit.provenance, date: hit.date, amountPence: -hit.amountPence };
  }
  const hiddenHelen = (list, f) => list.filter((x) => !f(x)).length;
  const review = {
    classification: rows.filter((t) => VISIBLE(t) && M.COUNTS(t.status) && (t.transactionType === 'spend' || t.transactionType === 'fee')
      && (t.domain === 'unknown' && !decisions.has(t.sourceTransactionId) || t.conflict))
      .sort((a, b) => b.date.localeCompare(a.date) || b.sourceTransactionId - a.sourceTransactionId).slice(0, 40)
      .map((t) => ({ ..._item(t), hint: t.hint, conflict: t.conflict })),
    unusual: unusual.filter((u) => VISIBLE(u.txn)).map((u) => ({ itemKey: u.itemKey, kind: u.kind, line: u.line, explainedBy: u.explainedBy, decision: u.decision, txn: _item(u.txn) })),
    duplicates: duplicates.filter((d) => d.txns.every(VISIBLE)).map((d) => ({ itemKey: d.itemKey, kind: d.kind, line: d.line, decision: d.decision, txns: d.txns.map(_item) })),
    hidden: { helenUnusual: hiddenHelen(unusual, (u) => VISIBLE(u.txn)), helenDuplicates: hiddenHelen(duplicates, (d) => d.txns.every(VISIBLE)) },
  };
  const shownSeries = series.filter((s) => s.state !== 'unknown').map((s) => (VISIBLE(s) ? s : {
    seriesKey: s.seriesKey, accountRef: s.accountRef, accountName: s.accountName, owner: 'helen', label: 'A payment from Helen\'s own account',
    direction: s.direction, cadence: s.cadence, state: s.state, typicalPence: s.typicalPence, nextExpected: s.nextExpected, active: s.active, shownAsTotalOnly: true,
  })).map((s) => { const { txnIds, amountsPence, ...rest } = s; return { ...rest, txnCount: (txnIds || []).length || undefined }; });
  return {
    asOf: _iso(now), today,
    source: { system: 'tally', mode: 'read-only', transactionsRead: read.transactions.length, accounts: coverage, dataFrom, dataThrough },
    health, reconnect, balances: bal,
    counts: {
      statuses: rows.reduce((o, t) => { o[t.status] = (o[t.status] || 0) + 1; return o; }, {}),
      types: rows.reduce((o, t) => { o[t.transactionType] = (o[t.transactionType] || 0) + 1; return o; }, {}),
      transfersExcluded: rows.filter((t) => t.transactionType === 'transfer').length,
      transfersInferred: (() => { const inf = rows.filter((t) => t.transferInferred && M.COUNTS(t.status)); return { count: inf.length, outPence: inf.filter((t) => t.amountPence < 0).reduce((a, t) => a - t.amountPence, 0), inPence: inf.filter((t) => t.amountPence > 0).reduce((a, t) => a + t.amountPence, 0),
        why: inf.length ? 'Transfers to or from an account Tally used to pair them with (whose feed is not refreshing) — excluded from spending and income.' : null }; })(),
      cardRepayments: rows.filter((t) => t.transactionType === 'card_repayment').length,
      refunds: rows.filter((t) => t.transactionType === 'refund' || t.transactionType === 'reversal').length,
    },
    summaries, monthOnMonth: M.monthOnMonth(summaries), rolling: M.rollingWindow(coverage, { today }), comparison,
    quality, series: shownSeries,
    recurringCounts: series.reduce((o, s) => { o[s.state] = (o[s.state] || 0) + 1; return o; }, {}),
    priceChanges: series.filter((s) => M.OPERATIONAL(s) && s.priceChange && VISIBLE(s)).map((s) => ({ seriesKey: s.seriesKey, label: s.label, account: s.accountName, ...s.priceChange })),
    upcoming, cashflow, pressure: M.pressure(cashflow), review, evidence,
    knownAccounts: read.accounts.map((a) => ({ id: a.id, name: a.name })),
    _series: series.map((s) => ({ seriesKey: s.seriesKey, state: s.state, label: VISIBLE(s) ? s.label : null, owner: s.owner, priceChange: s.priceChange ? { fromPence: s.priceChange.fromPence, toPence: s.priceChange.toPence } : null })),
  };
}

// ── obligation state (read time) ─────────────────────────────────────────────

const NEEDS_YOU_DAYS = 1;          // the existing personal-obligation rule
const PREP_NEEDS_YOU_DAYS = 2;     // the existing Radar prep rule

/**
 * later | upcoming | preparation_open | needs_you | overdue | complete | unknown.
 * A ticked task is the ACTION, not the payment: without transaction evidence
 * the obligation says "action done — payment not seen in Tally".
 */
function obligationState(o, { today, task = null, evidence = null, feedStale = false } = {}) {
  if (o.status !== 'open') return { state: 'complete', why: o.status === 'cancelled' ? 'cancelled' : `resolved (${o.resolvedEvidence})` };
  if (!o.dueDate) return { state: 'unknown', why: 'no date recorded' };
  const days = M.daysBetween(today, o.dueDate);
  const taskOpen = task && !['done', 'complete', 'completed', 'dropped'].includes(String(task.status || task.state || '').toLowerCase());
  const taskDone = task && !taskOpen;
  const payment = evidence ? `payment seen in Tally on ${evidence.date} (${M.pounds(evidence.amountPence)})` : taskDone
    ? `your task is done — that is the action; the payment itself has not been seen in Tally${feedStale ? ' (the bank feed is stale)' : ''}` : null;
  if (days < 0) return { state: evidence ? 'upcoming' : 'overdue', why: evidence ? payment : `was due ${o.dueDate}`, payment };
  if (days <= NEEDS_YOU_DAYS) return { state: 'needs_you', why: days === 0 ? 'due today' : 'due tomorrow', payment };
  if ((taskOpen || (o.requiresDecision && !taskDone)) && days <= PREP_NEEDS_YOU_DAYS) return { state: 'needs_you', why: `due in ${days} days and ${o.requiresDecision ? 'it needs your decision' : 'its task is still open'}`, payment };
  if (taskOpen || o.requiresDecision) return { state: 'preparation_open', why: o.requiresDecision ? 'needs a decision before it is due' : 'its task is open', payment };
  if (days <= 30) return { state: 'upcoming', why: `due in ${days} days`, payment };
  return { state: 'later', why: `due ${o.dueDate}`, payment };
}

function _taskIndex() {
  try { return new Map((require('./canonical-read').tasks({ status: 'all', limit: 2000 }).items || []).map((t) => [t.id, t])); } catch { return new Map(); }
}

// ── read ─────────────────────────────────────────────────────────────────────

function _activation() {
  let lists = [];
  try { lists = require('./reminder-audit').read({}).lists || []; } catch { lists = null; }
  if (!lists) return { state: 'unknown', why: 'the reminder-list audit could not be read' };
  const named = lists.filter((l) => String(l.name || '').trim().toLowerCase() === 'personal admin');
  const act = require('./personal-obligations').adminActivation(lists);
  return { ...act, personalAdminListOnPhone: named.length > 0,
    note: named.length ? null : 'There is no "Personal Admin" list on the phone yet. NEURO cannot create Apple lists and has not made a substitute.' };
}

/** What the Finance view shows. Never reads Tally — it reads the last snapshot. */
function read({ now = Date.now(), taskIndex = null } = {}) {
  const snap = _json(SNAPSHOT_KEY);
  const state = _json(STATE_KEY) || {};
  const today = localDay(now);
  const tasks = taskIndex || _taskIndex();
  const obs = obligations().map((o) => {
    const task = o.linkedTaskRef ? tasks.get(o.linkedTaskRef) || null : (o.linkedReminderRef ? tasks.get(o.linkedReminderRef) || null : null);
    const st = obligationState(o, { today, task, evidence: snap && snap.evidence ? snap.evidence[o.id] || null : null, feedStale: !snap || snap.health.household !== 'healthy' });
    return { ...o, state: st.state, stateWhy: st.why, payment: st.payment || null, task: task ? { id: task.id, title: task.description || task.title, status: task.state || task.status } : null };
  });
  const { _series, ...pub } = snap || {};
  return {
    ok: true, contract: 'finance-v1',
    source: snap ? pub.source : null, lastRead: { at: state.lastOkAt || null, attemptAt: state.lastAttemptAt || null, ok: state.lastOk ?? null, error: state.error || null },
    ...(snap ? pub : { health: { household: 'unknown', label: 'Finance has not been read yet', accounts: [] } }),
    obligations: obs, personalAdmin: _activation(),
    rules: rules({ activeOnly: false }).map((r) => ({ ruleId: r.rule_id, matchKind: r.match_kind, merchantKey: r.merchant_key, categoryName: r.category_name, tag: r.tag, domain: r.domain, active: !!r.active, confirmedAt: r.confirmed_at, matchedAtConfirmation: r.matched_at_confirmation })),
    domains: M.DOMAINS.map((d) => ({ id: d, label: M.DOMAIN_LABEL[d] })),
    rule: 'Read-only. Tally is the source of truth; NEURO never moves money, pays, cancels or edits a transaction. Helen\'s own account appears only as totals.',
  };
}

// ── refresh (the durable job body) ───────────────────────────────────────────

/**
 * Read Tally, compose, store the snapshot, record what CHANGED in Activity.
 * The first run is a baseline: it records one "finance activated" line and
 * nothing per series, so turning this on cannot flood Activity.
 */
// A default reader for tests only: every refresh a decision triggers then reads
// the fixture, never the real Tally over ssh.
let _defaultReader = null;
function useReader(fn) { _defaultReader = typeof fn === "function" ? fn : null; }

async function refresh({ now = Date.now(), reader = null, deps = {} } = {}) {
  reader = reader || _defaultReader;
  const c = config();
  const iso = _iso(now);
  const prevState = _json(STATE_KEY) || {};
  if (!c.enabled && !reader) return { ok: true, skipped: true, reason: 'TALLY_READ=off' };
  let tally;
  try { tally = await (reader ? reader() : readTally(deps)); } catch (e) {
    _setJson(STATE_KEY, { ...prevState, lastAttemptAt: iso, lastOk: false, error: e.message });
    return { ok: false, error: e.message };
  }
  const prevSnap = _json(SNAPSHOT_KEY);
  const snap = compose(tally, { now, rules: rules(), decisions: _decisions(), recurringDecisions: _recurringDecisions(), reviewDecisions: _reviewDecisions(),
    obligations: obligations(), knownAccounts: (prevSnap && prevSnap.knownAccounts) || [] });
  _setJson(SNAPSHOT_KEY, snap);
  _storeSummaries(snap, { now });
  const logged = prevState.baselined ? _logChanges(prevSnap, snap, { now }) : 0;
  if (!prevState.baselined) _log('finance-activated', { transactions: snap.source.transactionsRead, dataFrom: snap.source.dataFrom, dataThrough: snap.source.dataThrough, feed: snap.health.household }, { now, dedupeKey: 'finance-activated' });
  _setJson(STATE_KEY, { lastAttemptAt: iso, lastOkAt: iso, lastOk: true, error: null, baselined: true, firstAt: prevState.firstAt || iso });
  return { ok: true, transactions: snap.source.transactionsRead, feed: snap.health.household, logged };
}

/** One row per month. A month becomes "produced" once, the first time it is complete. */
function _storeSummaries(snap, { now }) {
  const db = _db();
  for (const s of snap.summaries) {
    const held = db.get('SELECT * FROM finance_monthly_summaries WHERE month = ?', [s.month]);
    const json = JSON.stringify(s);
    if (!held) {
      db.run('INSERT INTO finance_monthly_summaries (month, complete, summary_json, computed_at, revisions) VALUES (?, ?, ?, ?, 0)', [s.month, s.complete ? 1 : 0, json, _iso(now)]);
      if (s.complete) _log('finance-summary-produced', { month: s.month, spendPence: s.spendPence }, { subjectId: `finance-month:${s.month}`, now, dedupeKey: `finance-summary-produced:${s.month}` });
    } else if (held.summary_json !== json) {
      db.run('UPDATE finance_monthly_summaries SET complete = ?, summary_json = ?, computed_at = ?, revisions = revisions + 1 WHERE month = ?', [s.complete ? 1 : 0, json, _iso(now), s.month]);
      if (s.complete && !held.complete) _log('finance-summary-produced', { month: s.month, spendPence: s.spendPence }, { subjectId: `finance-month:${s.month}`, now, dedupeKey: `finance-summary-produced:${s.month}` });
    }
  }
}

/** Activity on CHANGE only: feed stale/recovered, relink, new series, new unusual items, price changes. */
function _logChanges(prev, next, { now }) {
  let n = 0;
  const L = (kind, detail, opt) => { if (_log(kind, detail, { now, ...opt })) n++; };
  const prevAcc = new Map(((prev && prev.health && prev.health.accounts) || []).map((a) => [a.accountRef, a.state]));
  for (const a of next.health.accounts) {
    const was = prevAcc.get(a.accountRef);
    if (was && was !== a.state) {
      if (a.state === 'healthy') L('finance-source-recovered', { account: a.owner === 'helen' ? 'Helen\'s account' : a.name, was }, { subjectId: a.accountRef, dedupeKey: `finance-source-recovered:${a.accountRef}:${now}` });
      else if (was === 'healthy') L('finance-source-stale', { account: a.owner === 'helen' ? 'Helen\'s account' : a.name, state: a.state, why: a.why }, { subjectId: a.accountRef, dedupeKey: `finance-source-stale:${a.accountRef}:${now}` });
    }
  }
  const wasRelinked = new Set(((prev && prev.reconnect && prev.reconnect.accounts) || []).filter((a) => a.relinked).map((a) => a.accountRef));
  for (const a of next.reconnect.accounts.filter((x) => x.relinked && !wasRelinked.has(x.accountRef))) {
    L('finance-account-relinked', { account: a.owner === 'helen' ? 'Helen\'s account' : a.name, oldestBackfilled: a.oldestBackfilled, gapDays: a.gapDays, backfilledRows: a.backfilledRows }, { subjectId: a.accountRef, dedupeKey: `finance-account-relinked:${a.accountRef}:${a.relinkedAt}` });
  }
  const prevSeries = new Map(((prev && prev._series) || []).map((s) => [s.seriesKey, s]));
  for (const s of next._series.filter(M.OPERATIONAL)) {
    const p = prevSeries.get(s.seriesKey);
    if (!p || !M.OPERATIONAL(p)) L('finance-recurring-recognised', { label: s.label || 'a payment from Helen\'s own account', state: s.state }, { subjectId: s.seriesKey, dedupeKey: `finance-recurring-recognised:${s.seriesKey}` });
    if (s.priceChange && s.label && !(p && p.priceChange && p.priceChange.toPence === s.priceChange.toPence)) L('finance-price-changed', { label: s.label, ...s.priceChange }, { subjectId: s.seriesKey, dedupeKey: `finance-price-changed:${s.seriesKey}:${s.priceChange.toPence}` });
  }
  const prevUnusual = new Set(((prev && prev.review && prev.review.unusual) || []).map((u) => u.itemKey));
  for (const u of next.review.unusual.filter((x) => !x.explainedBy && !prevUnusual.has(x.itemKey))) {
    L('finance-unusual-found', { line: u.line }, { subjectId: u.itemKey, dedupeKey: `finance-unusual-found:${u.itemKey}` });
  }
  return n;
}

// ── Nick's statements (every route below is machine-refused) ─────────────────

function _snapshotRow(txnId) {
  const snap = _json(SNAPSHOT_KEY);
  if (!snap) return null;
  const all = [...snap.review.classification, ...snap.review.unusual.map((u) => u.txn), ...snap.review.duplicates.flatMap((d) => d.txns)];
  return all.find((t) => t.sourceTransactionId === Number(txnId)) || null;
}

/**
 * Nick decides a domain for ONE transaction in the review queue. `remember`
 * turns it into an exact merchant (or merchant+category) rule. Helen's
 * transactions are never in the queue, so they cannot be decided here.
 */
async function decide(txnId, { decision, domain = null, remember = null } = {}, { now = Date.now(), actor = 'nick', reader = null } = {}) {
  const id = Number(txnId);
  const row = _snapshotRow(id);
  if (!row) return { ok: false, status: 404, error: 'That transaction is not in NEURO\'s review list' };
  if (!['confirm', 'reject', 'unknown'].includes(decision)) return { ok: false, status: 400, error: 'decision must be confirm, reject or unknown' };
  if (decision === 'confirm' && !M.DOMAINS.includes(domain)) return { ok: false, status: 400, error: `domain must be one of ${M.DOMAINS.join(', ')}` };
  if (decision === 'confirm' && ['income', 'transfers'].includes(domain)) return { ok: false, status: 400, error: 'income and transfers are decided by the transaction itself, not by a domain choice' };
  let rule = null;
  if (remember) {
    if (decision !== 'confirm') return { ok: false, status: 400, error: 'only a confirmed domain can be remembered as a rule' };
    const r = createRule({ matchKind: remember.matchKind, merchantKey: row.merchantKey, categoryName: remember.matchKind === 'merchant+category' ? row.category : null, domain, exampleTxnId: id }, { now, actor });
    if (!r.ok) return r;
    rule = r.rule;
  }
  _db().run(`INSERT INTO finance_txn_decisions (source_txn_id, decision, domain, rule_id, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(source_txn_id) DO UPDATE SET decision = excluded.decision, domain = excluded.domain, rule_id = excluded.rule_id, decided_by = excluded.decided_by, decided_at = excluded.decided_at`,
  [id, decision, decision === 'confirm' ? domain : null, rule ? rule.rule_id : null, actor, _iso(now)]);
  const r = await refresh({ now, reader });
  return { ok: true, decision, domain, rule, refreshed: r.ok };
}

function validateRule({ matchKind, merchantKey, categoryName, tag, domain } = {}) {
  if (!RULE_KINDS.includes(matchKind)) return `matchKind must be one of ${RULE_KINDS.join(', ')}`;
  if (!M.DOMAINS.includes(domain) || ['income', 'transfers', 'unknown'].includes(domain)) return 'domain must be a spending domain';
  if (matchKind === 'tag') return tag ? null : 'a tag rule needs the Tally tag (Tally has no tags today)';
  if (!(typeof merchantKey === 'string' && merchantKey.trim().length >= 2)) return 'a merchant rule needs the exact merchant';
  if (matchKind === 'merchant+category' && !(typeof categoryName === 'string' && categoryName.trim())) return 'a merchant+category rule needs the Tally category';
  return null;
}

/** An exact rule Nick confirmed. Broad text rules do not exist. */
function createRule({ matchKind, merchantKey = null, categoryName = null, tag = null, domain, exampleTxnId = null } = {}, { now = Date.now(), actor = 'nick' } = {}) {
  const bad = validateRule({ matchKind, merchantKey, categoryName, tag, domain });
  if (bad) return { ok: false, status: 400, error: bad };
  const db = _db();
  const existing = db.all('SELECT * FROM finance_rules WHERE active = 1').find((r) => r.match_kind === matchKind && (r.merchant_key || null) === (merchantKey || null)
    && String(r.category_name || '').toLowerCase() === String(categoryName || '').toLowerCase() && (r.tag || null) === (tag || null));
  if (existing) return { ok: true, already: true, rule: existing };
  const snap = _json(SNAPSHOT_KEY);
  const matched = snap ? snap.review.classification.filter((t) => M.ruleMatches({ active: 1, match_kind: matchKind, merchant_key: merchantKey, category_name: categoryName, tag }, { ...t, tags: [] })).length : null;
  const rule = { rule_id: `fr_${crypto.randomUUID()}`, match_kind: matchKind, merchant_key: merchantKey, category_name: categoryName, tag, domain,
    example_txn_id: exampleTxnId, matched_at_confirmation: matched, confirmed_by: actor, confirmed_at: _iso(now), active: 1 };
  db.run(`INSERT INTO finance_rules (rule_id, match_kind, merchant_key, category_name, tag, domain, example_txn_id, matched_at_confirmation, confirmed_by, confirmed_at, active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  [rule.rule_id, matchKind, merchantKey, categoryName, tag, domain, exampleTxnId, matched, actor, rule.confirmed_at]);
  _log('finance-rule-confirmed', { matchKind, merchantKey, categoryName, domain, matched }, { subjectId: rule.rule_id, actor, now, dedupeKey: `finance-rule-confirmed:${rule.rule_id}` });
  return { ok: true, rule };
}

async function retireRule(ruleId, { now = Date.now(), reader = null } = {}) {
  const r = _db().run('UPDATE finance_rules SET active = 0 WHERE rule_id = ? AND active = 1', [ruleId]);
  if (!(r && r.changes)) return { ok: false, status: 404, error: 'no such active rule' };
  await refresh({ now, reader });
  return { ok: true };
}

/** "This is recurring" / "this is not recurring" — Nick's own statement about a series. */
async function decideRecurring(seriesKey, { decision } = {}, { now = Date.now(), actor = 'nick', reader = null } = {}) {
  if (!['recurring', 'not-recurring', 'clear'].includes(decision)) return { ok: false, status: 400, error: 'decision must be recurring, not-recurring or clear' };
  const snap = _json(SNAPSHOT_KEY);
  const s = snap && (snap._series || []).find((x) => x.seriesKey === seriesKey);
  if (!s) return { ok: false, status: 404, error: 'NEURO holds no such recurring series' };
  if (s.owner === 'helen') return { ok: false, status: 404, error: 'Helen\'s own payments are not decided here' };
  if (decision === 'clear') _db().run('DELETE FROM finance_recurring_decisions WHERE series_key = ?', [seriesKey]);
  else _db().run(`INSERT INTO finance_recurring_decisions (series_key, decision, decided_by, decided_at) VALUES (?, ?, ?, ?)
                  ON CONFLICT(series_key) DO UPDATE SET decision = excluded.decision, decided_by = excluded.decided_by, decided_at = excluded.decided_at`, [seriesKey, decision, actor, _iso(now)]);
  if (decision === 'recurring') _log('finance-recurring-recognised', { label: s.label, state: 'explicit_recurring', byYou: true }, { subjectId: seriesKey, actor, now, dedupeKey: `finance-recurring-confirmed:${seriesKey}:${now}` });
  await refresh({ now, reader });
  return { ok: true, decision };
}

/** Answer an unusual-spend or duplicate candidate. Nothing is disputed or acted on. */
async function decideReview(itemKey, { decision } = {}, { now = Date.now(), actor = 'nick', reader = null } = {}) {
  if (!['expected', 'not-duplicate', 'leave', 'look-into-it'].includes(decision)) return { ok: false, status: 400, error: 'decision must be expected, not-duplicate, leave or look-into-it' };
  const snap = _json(SNAPSHOT_KEY);
  const item = snap && [...snap.review.unusual, ...snap.review.duplicates].find((x) => x.itemKey === itemKey);
  if (!item) return { ok: false, status: 404, error: 'NEURO holds no such review item' };
  _db().run(`INSERT INTO finance_review_decisions (item_key, decision, decided_by, decided_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(item_key) DO UPDATE SET decision = excluded.decision, decided_by = excluded.decided_by, decided_at = excluded.decided_at`, [itemKey, decision, actor, _iso(now)]);
  if (decision !== 'leave') _log('finance-unusual-resolved', { line: item.line, decision }, { subjectId: itemKey, actor, now, dedupeKey: `finance-unusual-resolved:${itemKey}:${decision}` });
  await refresh({ now, reader });
  return { ok: true, decision };
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
    const s = snap && (snap._series || []).find((x) => x.seriesKey === body.seriesKey);
    if (!s) return { ok: false, status: 404, error: 'no such recurring series' };
    if (s.owner === 'helen') return { ok: false, status: 404, error: 'Helen\'s own payments are not linked here' };
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
 * Resolving needs EVIDENCE. "payment-seen" needs a matching payment in the
 * last Tally read; ticking a task is never evidence that money moved.
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
    const ev = snap && snap.evidence ? snap.evidence[id] : null;
    if (!ev) return { ok: false, status: 409, error: 'No matching payment has been seen in Tally yet. Link a recurring payment, or resolve with renewed, cancelled or statement.' };
    detail = `payment ${ev.ref} on ${ev.date}`;
  } else if (!(typeof note === 'string' && note.trim().length >= 3)) return { ok: false, status: 400, error: 'say what the evidence is (a note of at least 3 characters)' };
  db.run(`UPDATE finance_obligations SET status = ?, resolved_evidence = ?, resolved_note = ?, resolved_at = ?, updated_at = ? WHERE obligation_id = ?`,
    [evidence === 'cancelled' ? 'cancelled' : 'resolved', evidence, detail, _iso(now), _iso(now), id]);
  _log('finance-obligation-resolved', { title: held.title, evidence, detail }, { subjectId: id, actor, now, dedupeKey: `finance-obligation-resolved:${id}` });
  return { ok: true };
}

// ── Future Radar (explicit obligations only — routine payments never) ────────

function radar({ today, last, now = Date.now(), taskIndex = null } = {}) {
  const items = [];
  try {
    const r = read({ now, taskIndex });
    const map = { overdue: 'needs_you', needs_you: 'needs_you', preparation_open: 'preparation_open', upcoming: 'none', later: 'none', unknown: 'unknown' };
    for (const o of r.obligations) {
      if (o.status !== 'open') continue;
      const actionState = map[o.state] || 'unknown';
      const inWindow = o.dueDate && o.dueDate >= today && o.dueDate <= last;
      if (!inWindow && actionState !== 'needs_you') continue;
      items.push({
        id: o.id, title: o.title, detail: o.expectedAmountPence ? `expected ${M.pounds(o.expectedAmountPence)}` : null, date: o.dueDate,
        kind: 'finance', obligationType: o.kind, actionState, needsWhy: o.stateWhy,
        linkedTaskRefs: [o.linkedTaskRef, o.linkedReminderRef].filter(Boolean),
        whyVisible: [`a ${o.kind.replace(/_/g, ' ')} you recorded`, o.stateWhy, o.payment].filter(Boolean),
        confidence: 'high',
      });
    }
  } catch (e) { return { items, error: e.message }; }
  return { items };
}

/** One month's stored summary. */
function monthly(month) {
  const row = _db().get('SELECT * FROM finance_monthly_summaries WHERE month = ?', [month]);
  return row ? { ...JSON.parse(row.summary_json), computedAt: row.computed_at, revisions: row.revisions } : null;
}

const TABLES = ['finance_rules', 'finance_txn_decisions', 'finance_recurring_decisions', 'finance_review_decisions', 'finance_obligations', 'finance_monthly_summaries'];

module.exports = {
  QUERIES, EXPECTED, OBLIGATION_KINDS, RULE_KINDS, RESOLVE_EVIDENCE, TABLES, SNAPSHOT_KEY,
  config, useReader, checkSchema, readTally, _ssh, compose, obligationState, validateRule,
  read, refresh, decide, createRule, retireRule, rules, decideRecurring, decideReview,
  addObligation, updateObligation, resolveObligation, obligations, radar, monthly,
};
