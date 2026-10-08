'use strict';

/**
 * Build 23 — Finance activation.
 *
 * Real scratch DB, real routes over HTTP behind the real api-auth + authority
 * guard. Tally is read through the REAL reader with only `execFile` (the ssh
 * layer) faked, and every description, amount and shape below is copied from
 * the rows the 8 Oct 2026 measurement found in Tally (pending copies with no
 * balance and no card+date token, the Zilch channel, NatWest's monthly
 * direct debits, the Just Eat refund, Helen's own account). Anything that
 * could notify is stubbed to THROW. Numbering follows the brief's test list.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b23-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'b23.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-2323';
process.env.NEURO_API_TOKEN = 'machine-token-23';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
// Never the real Tally: an unroutable target, and every read goes through the fixture reader.
process.env.TALLY_SSH_TARGET = 'nobody@neuro-test.invalid';
fs.mkdirSync(path.join(tmp, 'vault'), { recursive: true });

function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
const boom = (what) => async () => { throw new Error(`${what} reached from a Build 23 flow`); };
stub('./webpush', { sendToAll: boom('webpush.sendToAll'), isConfigured: () => true });
stub('./email-sender', { sendMail: boom('email-sender.sendMail'), sendBriefEmail: boom('email-sender.sendBriefEmail'), OWN_ADDRESS: 'nickw@nurtur.tech' });

const db = require('../db/database');
const M = require('./finance-model');
const fin = require('./finance');
const fu = require('./build-followups');
const radar = require('./future-radar');

const NOW = Date.now();
const TODAY = new Date(NOW).toISOString().slice(0, 10);
const plus = (n) => M.addDays(TODAY, n);
const isoAgo = (days) => new Date(NOW - days * 86400000).toISOString();

// ── the fixture, from the real read ──────────────────────────────────────────

let nextId = 5000;
function tx(account_id, date, amount, description, o = {}) {
  return { id: o.id || nextId++, account_id, date, amount, description, is_transfer: o.transfer ? 1 : 0, transfer_pair_id: o.pair || null,
    balance_after: o.bal === undefined ? 10000 : o.bal, created_at: o.created || '2026-06-27 06:11:46', category_name: o.cat || null, category_kind: o.kind || (o.cat ? 'expense' : null) };
}
const NICK = 1; const JOINT = 2; const BILLS = 3; const HELEN = 4;
function baseTransactions() {
  nextId = 5000;
  return [
    // first rows per account (data from)
    tx(JOINT, '2026-01-12', -5400, 'TESCO STORES 3381', { cat: 'Groceries' }),
    tx(NICK, '2026-05-15', -1199, '1717 14MAY26 SPOTIFY LONDON GB', { cat: 'Subscriptions' }),
    tx(HELEN, '2026-01-12', -23400, 'MY JUNIPER', {}),
    tx(BILLS, '2026-01-14', -8141, 'SEVERN TRENT WATER', { cat: 'Bills & Utilities' }),
    // Nick's own account: Lendable, monthly (strong)
    ...['2026-01-30', '2026-03-01', '2026-03-31', '2026-05-01', '2026-06-01'].map((d) => tx(NICK, d, -6075, 'LENDABLE', { cat: 'Bills & Utilities' })),
    // Bills: the mortgage, monthly (strong) — a routine Direct Debit
    ...['2026-01-29', '2026-02-27', '2026-03-30', '2026-04-29', '2026-05-29'].map((d) => tx(BILLS, d, -52500, 'MORTGAGE VIA MOBILE - PYMT', { cat: 'Bills & Utilities' })),
    // Bills: Virgin Media, up from £63.05 to £72.15
    ...['2026-02-09', '2026-03-09', '2026-04-09'].map((d) => tx(BILLS, d, -6305, 'VIRGIN MEDIA PYMTS', { cat: 'Bills & Utilities' })),
    ...['2026-05-09', '2026-06-09'].map((d) => tx(BILLS, d, -7215, 'VIRGIN MEDIA PYMTS', { cat: 'Bills & Utilities' })),
    // Bills: Marbles credit card — two payments only (weak), a card repayment
    tx(BILLS, '2026-05-22', -32942, 'MARBLES CREDITCARD', { cat: 'Bills & Utilities' }),
    tx(BILLS, '2026-06-22', -32942, 'MARBLES CREDITCARD', { cat: 'Bills & Utilities' }),
    // Joint: salary in
    ...['2026-02-27', '2026-03-27', '2026-04-29', '2026-05-29'].map((d) => tx(JOINT, d, 321429, 'NURTUR LIMITED', { cat: 'Salary', kind: 'income' })),
    // Joint: an ambiguous merchant — Groceries, nothing, Fuel, nothing
    tx(JOINT, '2026-03-06', -3539, '4297 06MAR26 CD WM MORRISONS STOREDERBY GB', { cat: 'Groceries' }),
    tx(JOINT, '2026-04-06', -2210, '4297 05APR26 CD WM MORRISONS STOREDERBY GB', {}),
    tx(JOINT, '2026-05-06', -4100, '4297 05MAY26 CD WM MORRISONS STOREDERBY GB', { cat: 'Fuel' }),
    tx(JOINT, '2026-06-02', -1890, '4297 01JUN26 CD WM MORRISONS STOREDERBY GB', {}),
    // Bills: an insurer filed under Health — a contradiction
    tx(BILLS, '2026-06-05', -10884, 'NFU MUTUAL INS-BC', { cat: 'Health' }),
    // Joint: a Co-op history, then one far above it
    tx(JOINT, '2026-02-05', -1500, '1717 05FEB26 CD CENTRAL CO-OP RETALE67 5DT GB', {}),
    tx(JOINT, '2026-02-19', -1400, '1717 19FEB26 CD CENTRAL CO-OP RETALE67 5DT GB', {}),
    tx(JOINT, '2026-03-25', -1600, '1717 25MAR26 CD CENTRAL CO-OP RETALE67 5DT GB', {}),
    tx(JOINT, '2026-04-30', -9000, '1717 30APR26 CD CENTRAL CO-OP RETALE67 5DT GB', { id: 4300 }),
    // Joint: the same Greggs, same day, same amount, both settled — possible duplicate
    tx(JOINT, '2026-06-04', -540, '1717 03JUN26 CD GREGGS DERBY GB', { id: 3001 }),
    tx(JOINT, '2026-06-04', -540, '1717 03JUN26 CD GREGGS DERBY GB', { id: 3002 }),
    // Nick: two Shell £1.30 buys on different purchase days — NOT a duplicate
    tx(NICK, '2026-02-18', -130, '4297 17FEB26 CD SHELL TALBOT STREET COALVILLE GB', { cat: 'Fuel' }),
    tx(NICK, '2026-02-19', -130, '4297 18FEB26 CD SHELL TALBOT STREET COALVILLE GB', { cat: 'Fuel' }),
    // Bills: the TV licence, once — large, first time seen
    tx(BILLS, '2026-05-10', -15950, 'TV LICENCE MBP', { id: 4510, cat: 'Bills & Utilities' }),
    // Helen's own account: a regular payment, then one far above it
    ...['2026-02-10', '2026-03-10', '2026-04-10', '2026-05-10'].map((d) => tx(HELEN, d, -4500, 'MATTHEW WARD BANK OF MUM VIA MOBILE - PYMT', {})),
    tx(HELEN, '2026-06-17', -14000, 'MATTHEW WARD BANK OF MUM VIA MOBILE - PYMT', {}),
    // pending + settled copies of one Zilch purchase (strong)
    tx(JOINT, '2026-06-19', -599, 'ZILCH VIXA FROM TH', { id: 1072, bal: null, created: '2026-06-20 00:11:46' }),
    tx(JOINT, '2026-06-19', -599, '1717 18JUN26 ZILCH VIXA FROM THE AA GB GB', { id: 1076, created: '2026-06-20 06:11:46' }),
    // pending + settled that cannot be told apart for sure (unresolved)
    tx(JOINT, '2026-06-22', -999, 'Prime Video add-o', { id: 1092, bal: null }),
    tx(JOINT, '2026-06-22', -999, '5494 21JUN26 PRIME VIDEO*T785X3KW5 LONDON GB', { id: 1124 }),
    // a transfer between household accounts
    tx(JOINT, '2026-06-01', -50000, 'To BILLS', { id: 2001, transfer: true, pair: 2002, cat: 'Transfer', kind: 'transfer' }),
    tx(BILLS, '2026-06-01', 50000, 'From JOINT', { id: 2002, transfer: true, pair: 2001, cat: 'Transfer', kind: 'transfer' }),
    // a credit-card repayment
    tx(JOINT, '2026-06-01', -1109, 'CAPITAL ONE', { cat: 'Bills & Utilities' }),
    // a takeaway, then its refund
    tx(JOINT, '2026-06-19', -1200, '9913 18JUN26 JUST EAT LONDON GB', { id: 687, cat: 'Eating Out' }),
    tx(JOINT, '2026-06-22', 1200, '9913 21JUN26 JUST EAT LONDON GB REFUND', { id: 1140 }),
  ];
}
const ACCOUNTS = [
  { id: NICK, name: 'Nick', type: 'current', active: 1, opening_balance: -200, owner: 'Nick' },
  { id: JOINT, name: 'Joint', type: 'current', active: 1, opening_balance: 74489, owner: null },
  { id: BILLS, name: 'Bills', type: 'current', active: 1, opening_balance: 1042, owner: null },
  { id: HELEN, name: 'Helen', type: 'current', active: 1, opening_balance: 8391, owner: 'Helen' },
];
const DEAD_CONNECTIONS = [
  { id: 1, provider_name: 'NATWEST', expires_at: '2026-06-27T12:21:39.561Z', last_sync_at: '2026-06-27T12:11:47.143Z', active: 1, created_at: '2026-04-12 16:30:25' },
  { id: 2, provider_name: 'NATWEST', expires_at: '2026-06-27T12:21:45.150Z', last_sync_at: '2026-06-27T12:11:49.240Z', active: 1, created_at: '2026-04-12 18:58:32' },
];
const DEAD_TL = [
  { id: 1, connection_id: 1, account_type: 'TRANSACTION', currency: 'GBP', linked_account_id: JOINT, last_sync_at: '2026-06-27T12:11:47.126Z', created_at: '2026-04-12 16:30:25' },
  { id: 2, connection_id: 1, account_type: 'TRANSACTION', currency: 'GBP', linked_account_id: BILLS, last_sync_at: '2026-06-27T12:11:46.387Z', created_at: '2026-04-12 16:30:25' },
  { id: 3, connection_id: 1, account_type: 'TRANSACTION', currency: 'GBP', linked_account_id: NICK, last_sync_at: '2026-06-27T12:11:45.592Z', created_at: '2026-04-12 16:30:25' },
  { id: 4, connection_id: 2, account_type: 'TRANSACTION', currency: 'GBP', linked_account_id: HELEN, last_sync_at: '2026-06-27T12:11:49.230Z', created_at: '2026-04-12 18:58:32' },
];
function staleRead() {
  return { transactions: baseTransactions(), accounts: ACCOUNTS, connections: DEAD_CONNECTIONS, tlAccounts: DEAD_TL,
    tallyRecurring: [{ merchant: 'MORTGAGE VIA MOBILE', typical_amount: -52500, cadence: 'monthly', last_seen: '2026-05-29', next_expected: '2026-06-28', active: 1, ignored: 1 }],
    tallyRules: [{ match_value: '1717 09APR26' }, { match_value: '9913 31MAR26' }, { match_value: 'WORKERS OF' }] };
}
/** Nick reconnects: a new connection feeds Nick, Joint and Bills; Helen's stays dead. */
function reconnectedRead({ helenToo = false } = {}) {
  const r = staleRead();
  const at = isoAgo(1).replace('T', ' ').slice(0, 19);
  r.connections = [...DEAD_CONNECTIONS, { id: 3, provider_name: 'NATWEST', expires_at: new Date(NOW + 3600000).toISOString(), last_sync_at: isoAgo(0.1), active: 1, created_at: at }];
  r.tlAccounts = [...DEAD_TL,
    ...[[5, JOINT], [6, BILLS], [7, NICK]].map(([id, acct]) => ({ id, connection_id: 3, account_type: 'TRANSACTION', currency: 'GBP', linked_account_id: acct, last_sync_at: isoAgo(0.1), created_at: at }))];
  if (helenToo) {
    r.connections.push({ id: 4, provider_name: 'NATWEST', expires_at: new Date(NOW + 3600000).toISOString(), last_sync_at: isoAgo(0.1), active: 1, created_at: at });
    r.tlAccounts.push({ id: 8, connection_id: 4, account_type: 'TRANSACTION', currency: 'GBP', linked_account_id: HELEN, last_sync_at: isoAgo(0.1), created_at: at });
  }
  const created = isoAgo(0.5).replace('T', ' ').slice(0, 19);
  r.transactions.push(
    tx(JOINT, '2026-06-24', -2400, '1717 23JUN26 CD SHELL GB', { id: 9001, created }),
    tx(JOINT, '2026-06-19', -599, '1717 18JUN26 ZILCH VIXA FROM THE AA GB GB', { id: 9002, created }), // double import of 1076
    tx(JOINT, plus(-3), -3100, '1717 01OCT26 CD TESCO-STORES 6573 LEICESTER GB', { id: 9003, created, cat: 'Groceries' }),
  );
  return r;
}
const SCHEMA_ROWS = Object.entries(fin.EXPECTED).flatMap(([t, cols]) => [...cols, 'extra_col'].map((name) => ({ t, name })));
const ORDER = ['schema', 'transactions', 'accounts', 'connections', 'tlAccounts', 'tallyRecurring', 'tallyRules'];
function fakeExec(read, schema = SCHEMA_ROWS) {
  const calls = [];
  const fn = (cmd, args, opts, cb) => {
    calls.push({ cmd, args });
    const data = { schema, ...read };
    cb(null, ORDER.map((k) => `${JSON.stringify(data[k] || [])}\n@@NEURO_FINANCE_SPLIT@@`).join('\n'));
  };
  fn.calls = calls;
  return fn;
}
const reader = (read) => () => fin.readTally({ execFile: fakeExec(read) });

let server;
let base;
const PIN = { 'X-NEURO-PIN': 'pin-2323', 'Content-Type': 'application/json' };
const MACHINE = { 'X-NEURO-API-TOKEN': 'machine-token-23', 'Content-Type': 'application/json' };
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
  app.use('/api/finance', require('../routes/finance'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  fin.useReader(reader(staleRead()));
  const r = await fin.refresh({ now: NOW });
  assert.equal(r.ok, true, r.error);
});
test.after(() => { server && server.close(); });

const snap = () => JSON.parse(db.getState(fin.SNAPSHOT_KEY));
const month = (m) => snap().summaries.find((s) => s.month === m);

// ── source / normalisation ───────────────────────────────────────────────────

test('0. the reader is read-only, names every column, never selects a token or an account number, and refuses a changed schema', async () => {
  for (const [k, sql] of Object.entries(fin.QUERIES)) {
    assert.match(sql, /^SELECT /, k);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|ATTACH)\b/i, k);
    assert.doesNotMatch(sql, /access_token|refresh_token|account_number|sort_code|external_id|\*/, k);
  }
  const ex = fakeExec(staleRead());
  await fin.readTally({ execFile: ex });
  assert.equal(ex.calls[0].cmd, 'ssh');
  assert.match(ex.calls[0].args.at(-1), /sqlite3 -readonly/);
  const broken = SCHEMA_ROWS.filter((r) => !(r.t === 'transactions' && r.name === 'balance_after'));
  await assert.rejects(fin.readTally({ execFile: fakeExec(staleRead(), broken) }), /schema changed .*transactions lost balance_after/);
  const src = fs.readFileSync(path.join(__dirname, 'finance.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"]\.\/(webpush|email-sender|action-mail|action-executor)['"]\)|sendToAll|sendMail/);
});

test('1. a stale bank feed is reported honestly — reconnect required, never healthy', () => {
  const h = snap().health;
  assert.equal(h.household, 'reconnect_required');
  assert.match(h.label, /need reconnecting/);
  for (const a of h.accounts) { assert.equal(a.state, 'reconnect_required'); assert.match(a.why, /2026-06-27/); }
});

test('2. source freshness is separate from stored history', () => {
  // the same history, a live feed: healthy — and the stale read above had the SAME rows
  const live = staleRead();
  live.connections = live.connections.map((c) => ({ ...c, last_sync_at: isoAgo(0.2), expires_at: new Date(NOW + 3600000).toISOString() }));
  live.tlAccounts = live.tlAccounts.map((t) => ({ ...t, last_sync_at: isoAgo(0.2) }));
  const s = fin.compose(live, { now: NOW });
  assert.equal(s.health.household, 'healthy');
  assert.equal(snap().source.transactionsRead, s.source.transactionsRead);
  assert.equal(snap().health.household, 'reconnect_required');
});

test('3. a pending and its settled copy are never counted twice', () => {
  const rows = M.normalise(staleRead());
  const p = rows.find((t) => t.sourceTransactionId === 1072);
  assert.equal(p.status, 'superseded_pending');
  assert.equal(p.pairedWith, 1076);
  assert.equal(rows.find((t) => t.sourceTransactionId === 1092).status, 'unresolved_duplicate');
  const jun = month('2026-06');
  assert.ok(jun.pendingExcluded.count >= 1);
  // the purchase counts once: drop the pending copy and June's spend is unchanged
  const without = staleRead(); without.transactions = without.transactions.filter((t) => t.id !== 1072);
  const s2 = fin.compose(without, { now: NOW }).summaries.find((s) => s.month === '2026-06');
  assert.equal(s2.spendPence, jun.spendPence);
});

test('4. a transfer between household accounts is not spending', () => {
  const rows = M.normalise(staleRead());
  assert.equal(rows.find((t) => t.sourceTransactionId === 2001).transactionType, 'transfer');
  const jun = month('2026-06');
  const noXfer = staleRead(); noXfer.transactions = noXfer.transactions.filter((t) => ![2001, 2002].includes(t.id));
  assert.equal(fin.compose(noXfer, { now: NOW }).summaries.find((s) => s.month === '2026-06').moneyOutPence, jun.moneyOutPence);
  // a credit-card repayment is money out, never a spending category
  assert.equal(rows.find((t) => t.description === 'CAPITAL ONE').transactionType, 'card_repayment');
  assert.ok(jun.cardRepaymentsPence >= 1109);
  assert.match(jun.cardSpendNote, /card's own spending is not in Tally/);
});

test('5. a refund nets against its original spend', () => {
  const rows = M.normalise(staleRead());
  const r = rows.find((t) => t.sourceTransactionId === 1140);
  assert.ok(['refund', 'reversal'].includes(r.transactionType));
  assert.equal(r.refundOf, 687);
  assert.equal(r.domain, 'eating_out');
  assert.equal(month('2026-06').byDomain.eating_out || 0, 0);
  assert.equal(month('2026-06').incomePence, 0, 'a refund is not income');
});

test('6. household ownership is preserved on every row', () => {
  const rows = M.normalise(staleRead());
  assert.equal(rows.find((t) => t.accountId === NICK).owner, 'nick');
  assert.equal(rows.find((t) => t.accountId === JOINT).owner, 'shared');
  assert.equal(rows.find((t) => t.accountId === HELEN).owner, 'helen');
  const may = month('2026-05');
  assert.ok(may.owners.nickPence > 0 && may.owners.sharedPence > 0 && may.owners.helenOwnAccountPence > 0);
  assert.match(may.owners.basis, /Helen's own account as a total only/);
});

test('7. Helen\'s item-level spending is not surfaced — counted, never listed', async () => {
  const stored = db.getState(fin.SNAPSHOT_KEY);
  assert.doesNotMatch(stored, /MATTHEW WARD|JUNIPER/);
  assert.ok(snap().review.hidden.helenUnusual >= 1, 'her unusual payment is counted');
  const g = await call('GET', '/api/finance');
  assert.equal(g.status, 200);
  assert.doesNotMatch(JSON.stringify(g.json), /MATTHEW WARD|JUNIPER/);
  // positive control: the model DID see her row
  assert.ok(M.unusualSpend(M.normalise(staleRead()), {}).some((u) => /MATTHEW WARD/.test(u.txn.merchantKey)));
  // her series shows as a total, her balance not at all
  assert.ok(snap().series.some((s) => s.owner === 'helen' && s.shownAsTotalOnly && /Helen's own account/.test(s.label)));
  assert.equal(snap().balances.find((b) => b.owner === 'helen').balancePence, null);
});

// ── classification ───────────────────────────────────────────────────────────

test('8. a Tally category is evidence, not the truth', async () => {
  const nfu = M.normalise(staleRead()).find((t) => t.merchantKey === 'NFU MUTUAL INS-BC');
  assert.equal(nfu.domain, 'health');
  assert.equal(nfu.domainBasis, 'tally-category');
  assert.ok(nfu.conflict && /an insurer/.test(nfu.conflict.why));
  const id = nfu.sourceTransactionId;
  const r = await call('POST', `/api/finance/transactions/${id}/decide`, { decision: 'confirm', domain: 'insurance' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const after = M.normalise(staleRead(), { decisions: new Map([[id, { decision: 'confirm', domain: 'insurance' }]]) }).find((t) => t.sourceTransactionId === id);
  assert.equal(after.domain, 'insurance');
  assert.equal(month('2026-06').byDomain.insurance, 10884);
});

test('9. an ambiguous merchant stays unresolved — no majority vote', () => {
  const rows = M.normalise(staleRead()).filter((t) => t.merchantKey === 'WM MORRISONS STOREDERBY');
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((t) => t.domain), ['groceries', 'unknown', 'transport', 'unknown']);
  const q = snap().quality;
  assert.ok(q.topAmbiguous.some((a) => a.merchantKey === 'WM MORRISONS STOREDERBY'));
  assert.ok(q.totals.tallyRulesKeyedOnDates === 2);
});

test('10. a confirmed merchant rule is reusable', async () => {
  const unknownOne = snap().review.classification.find((t) => t.merchantKey === 'WM MORRISONS STOREDERBY' && t.domain === 'unknown');
  const r = await call('POST', `/api/finance/transactions/${unknownOne.sourceTransactionId}/decide`, { decision: 'confirm', domain: 'groceries', remember: { matchKind: 'merchant' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.rule.match_kind, 'merchant');
  const rows = M.normalise(staleRead(), { rules: fin.rules() }).filter((t) => t.merchantKey === 'WM MORRISONS STOREDERBY');
  const other = rows.find((t) => t.sourceTransactionId !== unknownOne.sourceTransactionId && t.category == null);
  assert.equal(other.domain, 'groceries');
  assert.equal(other.domainBasis, 'rule');
});

test('11. a machine cannot create a rule or decide anything; broad text rules do not exist', async () => {
  const t = snap().review.classification[0];
  const m = await call('POST', `/api/finance/transactions/${t.sourceTransactionId}/decide`, { decision: 'confirm', domain: 'groceries', remember: { matchKind: 'merchant' } }, MACHINE);
  assert.equal(m.status, 403);
  for (const p of ['/api/finance/sync', '/api/finance/obligations', '/api/finance/rules/x/retire', '/api/finance/recurring/x/decide', '/api/finance/review/x/decide']) {
    assert.equal((await call('POST', p, { decision: 'recurring', kind: 'bill', title: 'x' }, MACHINE)).status, 403, p);
  }
  assert.equal((await call('GET', '/api/finance', null, MACHINE)).status, 200, 'machines may read');
  assert.match(fin.validateRule({ matchKind: 'contains', merchantKey: 'TESCO', domain: 'groceries' }), /matchKind must be/);
  assert.match(fin.validateRule({ matchKind: 'tag', domain: 'groceries' }), /Tally has no tags/);
});

test('12. a conflicting category stays reviewable', () => {
  const s = fin.compose(staleRead(), { now: NOW });
  const nfu = s.review.classification.find((t) => t.merchantKey === 'NFU MUTUAL INS-BC');
  assert.ok(nfu && nfu.conflict, 'in the review list with its contradiction');
  assert.ok(s.quality.totals.contradictory >= 1);
});

// ── recurring ────────────────────────────────────────────────────────────────

const series = (label) => snap().series.find((s) => s.label === label);

test('13. explicit recurring — Nick marks a weak series recurring', async () => {
  const marbles = series('MARBLES CREDITCARD');
  assert.equal(marbles.state, 'weak_pattern');
  const r = await call('POST', `/api/finance/recurring/${marbles.seriesKey}/decide`, { decision: 'recurring' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(series('MARBLES CREDITCARD').state, 'explicit_recurring');
  await call('POST', `/api/finance/recurring/${marbles.seriesKey}/decide`, { decision: 'clear' });
  assert.equal(series('MARBLES CREDITCARD').state, 'weak_pattern');
});

test('14. a strong pattern is detected conservatively', () => {
  const m = series('MORTGAGE VIA MOBILE - PYMT');
  assert.equal(m.state, 'strong_pattern');
  assert.equal(m.cadence, 'monthly');
  assert.equal(m.tally.listed, true);
  assert.equal(m.tally.ignoredInTally, true);
  // the Co-op, irregular, is not recurring
  assert.ok(!snap().series.some((s) => /CO-OP/.test(s.label) && M.OPERATIONAL(s)));
});

test('15. a weak pattern is not promoted to the forward view', () => {
  const up = snap().upcoming.d30.items;
  assert.ok(!up.some((i) => i.label === 'MARBLES CREDITCARD'));
  assert.ok(up.some((i) => i.label === 'MORTGAGE VIA MOBILE - PYMT'), 'a strong one is there');
  assert.ok(snap().upcoming.d30.partial);
  assert.ok(up.every((i) => i.caveat && /bank feed is stale/.test(i.caveat)));
  // the predicate itself — the forward view's next-date rule is a second guard behind it
  assert.equal(M.OPERATIONAL({ state: 'weak_pattern' }), false);
  assert.equal(M.OPERATIONAL({ state: 'unknown' }), false);
  const marbles = series('MARBLES CREDITCARD');
  const inMay = month('2026-05');
  assert.equal(inMay.recurringPence, 52500 + 7215 + 6075, 'May recurring = mortgage + Virgin + Lendable, never the weak Marbles payment');
  assert.ok(marbles && marbles.state === 'weak_pattern');
});

test('16. a recurring payment never creates a task', async () => {
  const before = db.listTaskRows({ status: 'all' }).length;
  await fin.refresh({ now: NOW, reader: reader(staleRead()) });
  assert.equal(db.listTaskRows({ status: 'all' }).length, before);
});

let renewal;
test('17. a renewal obligation links to a task only explicitly', async () => {
  const bad = await call('POST', '/api/finance/obligations', { kind: 'renewal', title: 'Home insurance renewal', dueDate: plus(20), linkedTaskRef: 'not-a-task' });
  assert.equal(bad.status, 400);
  const r = await call('POST', '/api/finance/obligations', { kind: 'renewal', title: 'Home insurance renewal', dueDate: plus(20), expectedAmountPence: 42000, requiresDecision: true, linkedTaskRef: 'task:neuro:777' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  renewal = r.json.obligation;
  assert.equal(renewal.linkedTaskRef, 'task:neuro:777');
  const kinds = db.all("SELECT kind FROM personal_ops_events WHERE subject_id = ?", [renewal.id]).map((e) => e.kind);
  assert.deepEqual(kinds.sort(), ['finance-obligation-added', 'finance-obligation-linked']);
  // a ticked task is not evidence of payment
  const res = await call('POST', `/api/finance/obligations/${renewal.id}/resolve`, { evidence: 'payment-seen' });
  assert.equal(res.status, 409);
  const st = fin.obligationState({ ...renewal, dueDate: plus(20) }, { today: TODAY, task: { status: 'done' }, feedStale: true });
  assert.match(st.payment, /that is the action; the payment itself has not been seen in Tally/);
});

// ── summaries ────────────────────────────────────────────────────────────────

test('18. a partial month is never compared as complete', () => {
  assert.equal(month('2026-01').complete, false);
  assert.equal(month('2026-06').complete, false);
  const mom = snap().monthOnMonth;
  assert.equal(mom.current, '2026-05');
  assert.equal(mom.previous, '2026-04');
  assert.ok(['up', 'down', 'broadly stable'].includes(mom.state));
  assert.equal(M.monthOnMonth([month('2026-06'), month('2026-05')].map((s) => ({ ...s }))).state, 'insufficient data');
});

test('19. category totals explain the total, every month', () => {
  for (const s of snap().summaries) assert.equal(Object.values(s.byDomain).reduce((a, b) => a + b, 0), s.spendPence, s.month);
});

test('20. the rolling view states its exact window', () => {
  const r = snap().rolling;
  assert.equal(r.isTwelveMonths, false);
  assert.equal(r.from, '2026-01-12');
  assert.equal(r.through, '2026-06-26');
  assert.match(r.label, /not 12 months/);
});

test('21. a source gap is visible', () => {
  assert.ok(month('2026-06').coverageReasons.some((x) => /data runs only to 2026-06-26/.test(x)));
  assert.equal(month('2026-06').net.meaningful, false);
  assert.match(snap().cashflow.label, /Not enough current data/);
  assert.equal(snap().pressure.state, 'insufficient data');
});

test('22. the monthly summary is deterministic', () => {
  const a = fin.compose(staleRead(), { now: NOW });
  const b = fin.compose(staleRead(), { now: NOW });
  assert.deepEqual(a.summaries, b.summaries);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM finance_monthly_summaries WHERE complete = 1").n, 4);
  const produced = db.all("SELECT * FROM personal_ops_events WHERE kind = 'finance-summary-produced'");
  assert.equal(produced.length, 4, 'one line per complete month, ever');
});

// ── anomalies ────────────────────────────────────────────────────────────────

test('23. a large expected annual bill is not falsely anomalous', () => {
  const rows = M.normalise(staleRead());
  const plain = M.unusualSpend(rows, { dataFrom: '2026-01-12' }).find((u) => u.txn.sourceTransactionId === 4510);
  assert.equal(plain.kind, 'unusual-merchant');
  assert.equal(plain.explainedBy, null);
  const explained = M.unusualSpend(rows, { dataFrom: '2026-01-12', obligations: [{ title: 'TV licence', dueDate: '2026-05-10', expectedAmountPence: 15950 }] }).find((u) => u.txn.sourceTransactionId === 4510);
  assert.match(explained.explainedBy, /TV licence/);
});

test('24. an unusual-spend candidate is found against merchant history', () => {
  const u = snap().review.unusual.find((x) => x.txn.sourceTransactionId === 4300);
  assert.equal(u.kind, 'above-merchant-history');
  assert.match(u.line, /^Unusual compared with your recorded history: £90.00 against a usual £15.00/);
});

test('25. duplicate-charge candidates are conservative', () => {
  const d = snap().review.duplicates;
  assert.equal(d.length, 1);
  assert.deepEqual(d[0].txns.map((t) => t.sourceTransactionId), [3001, 3002]);
  assert.match(d[0].line, /^Possible duplicate:/);
  // the pending/settled pair and two different-day Shell buys are not duplicates
  assert.ok(!d.some((x) => x.txns.some((t) => [1072, 1076].includes(t.sourceTransactionId))));
});

test('26. no fraud language anywhere', async () => {
  for (const f of ['finance-model.js', 'finance.js', '../routes/finance.js', '../../frontend/src/components/canonical/FinanceCard.jsx']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8').split('\n').filter((l) => !/no fraud|never "fraud"|fraud alert/i.test(l)).join('\n');
    assert.doesNotMatch(src, /\b(fraud|fraudulent|suspicious|scam)\b/i, f);
  }
  assert.doesNotMatch(JSON.stringify((await call('GET', '/api/finance')).json), /fraud|suspicious|scam/i);
});

test('27. a subscription price change is detected', () => {
  const pc = snap().priceChanges.find((p) => p.label === 'VIRGIN MEDIA PYMTS');
  assert.ok(pc);
  assert.equal(pc.fromPence, 6305);
  assert.equal(pc.toPence, 7215);
  assert.match(pc.line, /^Payment increased from £63.05 to £72.15$/);
  assert.equal(series('VIRGIN MEDIA PYMTS').state, 'strong_pattern');
});

// ── Radar / actionability ────────────────────────────────────────────────────

test('28. a routine Direct Debit stays out of the Radar', () => {
  const r = radar.read({ now: NOW, horizonDays: 30 });
  assert.ok(!r.items.some((i) => /MORTGAGE|VIRGIN/.test(i.title)));
  assert.ok(!r.gaps.some((g) => g.input === 'finance'), JSON.stringify(r.gaps));
});

test('29. an actionable renewal enters the Radar (through the real Radar)', () => {
  const r = radar.read({ now: NOW, horizonDays: 30 });
  const it = r.items.find((i) => i.id === renewal.id);
  assert.ok(it, 'the renewal is on the Radar');
  assert.equal(it.kind, 'finance');
  assert.equal(it.actionState, 'preparation_open');
  assert.ok(it.whyVisible.some((w) => /needs a decision/.test(w)));
});

test('30. a passive recurring payment never notifies', async () => {
  // webpush and email are stubbed to throw: a refresh that tried to send would fail
  const r = await fin.refresh({ now: NOW, reader: reader(staleRead()) });
  assert.equal(r.ok, true);
  const src = fs.readFileSync(path.join(__dirname, 'finance.js'), 'utf8');
  assert.doesNotMatch(src, /sendToAll|worthInterrupting|notification-policy/);
});

test('31. a finance prep task can become Needs You', () => {
  const ob = { id: 'fo_x', kind: 'bill', title: 'Car insurance', status: 'open', dueDate: plus(2), requiresDecision: false, linkedTaskRef: 'task:neuro:31' };
  assert.equal(fin.obligationState(ob, { today: TODAY, task: { status: 'open' } }).state, 'needs_you');
  assert.equal(fin.obligationState(ob, { today: TODAY, task: null }).state, 'upcoming', 'without the open task it is only upcoming');
  const idx = new Map([['task:neuro:777', { id: 'task:neuro:777', status: 'open', description: 'Ring the insurer' }]]);
  const items = fin.radar({ today: TODAY, last: plus(30), now: NOW, taskIndex: idx }).items;
  assert.equal(items.find((i) => i.id === renewal.id).actionState, 'preparation_open');
});

test('32. no new finance notification policy was invented', () => {
  const dir = __dirname;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && !x.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(src, /rule: ['"]finance/, f);
  }
  const it = radar.read({ now: NOW, horizonDays: 30 }).items.find((i) => i.id === renewal.id);
  assert.equal(it.attention.eligible, false, 'eligible only through the existing needs-you rule');
});

// ── reconnect ────────────────────────────────────────────────────────────────

test('33/35. a reconnect keeps account identity and the backfill is measured', () => {
  const s = fin.compose(reconnectedRead(), { now: NOW, knownAccounts: ACCOUNTS.map((a) => ({ id: a.id, name: a.name })) });
  const joint = s.reconnect.accounts.find((a) => a.name === 'Joint');
  assert.equal(joint.relinked, true);
  assert.equal(joint.newestBeforeReconnect, '2026-06-22');
  assert.equal(joint.oldestBackfilled, '2026-06-19');
  assert.equal(joint.backfilledRows, 3);
  assert.equal(joint.doubleImported, 1);
  assert.equal(joint.accountRef, 'tally-account:2', 'the same Tally account');
  assert.equal(s.reconnect.identityOk, true);
  assert.equal(s.reconnect.accounts.find((a) => a.owner === 'helen').relinked, false);
});

test('34. an old and a new account are not duplicated', () => {
  const r = reconnectedRead();
  r.accounts = [...ACCOUNTS, { id: 9, name: 'Joint', type: 'current', active: 1, opening_balance: 0, owner: null }];
  const s = fin.compose(r, { now: NOW, knownAccounts: ACCOUNTS.map((a) => ({ id: a.id, name: a.name })) });
  assert.deepEqual(s.reconnect.duplicateAccounts, ['JOINT']);
  assert.deepEqual(s.reconnect.newAccounts, ['Joint']);
  assert.equal(s.reconnect.identityOk, false);
});

test('36/37. stale → partial while Helen is stale → healthy when she reconnects; Activity says so', async () => {
  await fin.refresh({ now: NOW, reader: reader(reconnectedRead()) });
  const h = snap().health;
  assert.equal(h.household, 'partial');
  assert.equal(h.accounts.find((a) => a.name === 'Joint').state, 'healthy');
  assert.ok(h.helen && /Helen's own account is not refreshing/.test(h.helen.why));
  const kinds = db.all("SELECT kind, detail_json FROM personal_ops_events WHERE kind IN ('finance-source-recovered', 'finance-account-relinked')");
  // reconnect required → healthy is a recovery, one line per account; Helen's stays stale
  assert.equal(kinds.filter((k) => k.kind === 'finance-source-recovered').length, 3);
  assert.equal(kinds.filter((k) => k.kind === 'finance-account-relinked').length, 3);
  await fin.refresh({ now: NOW, reader: reader(reconnectedRead({ helenToo: true })) });
  assert.equal(snap().health.household, 'healthy');
  assert.equal(snap().health.helen, null);
  const relinked = db.all("SELECT detail_json FROM personal_ops_events WHERE kind = 'finance-account-relinked'").map((e) => JSON.parse(e.detail_json).account);
  assert.ok(relinked.includes('Helen\'s account'));
  assert.ok(!relinked.includes('Helen'));
});

// ── user-action ledger ───────────────────────────────────────────────────────

const store = require('./task-store');
const LIST = [
  { key: 'reconnect-nick-natwest', build: 'Build 23', title: 'Reconnect my NatWest bank feed in Tally (TrueLayer)', why: 'feed stale' },
  { key: 'captur-registration', build: 'Build 23', title: 'Add the Captur registration in NEURO (Life → Vehicle)' },
  { key: 'build18-native-proof', build: 'Build 23', title: 'Finish the Build 18 native proof on the Mac' },
];

test('42. a follow-up written only in notes fails acceptance', () => {
  const v = fu.verify(LIST);
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing.sort(), LIST.map((f) => f.key).sort());
  assert.match(fu.validate({ key: 'x-y-z', title: 'Something to do' }), /source build/);
});

test('38/39/40/41. build follow-ups become real tasks: existing reused, resolved not recreated, source build recorded', () => {
  // Nick already wrote one in his own words; another he already did
  const own = store.createTask({ text: 'Add the Captur registration to NEURO vehicle', source: 'manual' });
  const done = store.createTask({ text: 'Finish the Build 18 native proof on the Mac', source: 'manual' });
  store.updateTask(done.id, { status: 'done' });
  const dry = fu.reconcile(LIST, { now: NOW });
  assert.equal(dry.applied, false);
  assert.equal(fu.verify(LIST).ok, false, 'a dry run writes nothing');
  const r = fu.reconcile(LIST, { apply: true, now: NOW });
  const by = Object.fromEntries(r.results.map((x) => [x.key, x]));
  assert.equal(by['reconnect-nick-natwest'].outcome, 'created');
  assert.equal(by['captur-registration'].outcome, 'reused');
  assert.equal(by['captur-registration'].taskId, own.id);
  assert.equal(by['build18-native-proof'].outcome, 'resolved');
  assert.equal(by['build18-native-proof'].taskId, done.id);
  const t = db.getTaskRow(by['reconnect-nick-natwest'].taskId);
  assert.equal(t.source, 'build-followup');
  assert.match(t.notes, /From Build 23 \(follow-up: reconnect-nick-natwest\)/);
  assert.equal(fu.verify(LIST).ok, true);
  // a second run creates nothing new
  const before = db.listTaskRows({ status: 'all' }).length;
  const again = fu.reconcile(LIST, { apply: true, now: NOW });
  assert.equal(db.listTaskRows({ status: 'all' }).length, before);
  assert.deepEqual(again.results.map((x) => x.outcome).sort(), ['exists', 'exists', 'resolved']);
  // the real Build 23 list is valid
  for (const f of fu.BUILD_23) assert.equal(fu.validate(f), null, f.key);
});

test('render: the Finance card shows feed state, a complete month, coverage, recurring and review — and Helen only as a total', async () => {
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
  await fin.refresh({ now: NOW, reader: reader(staleRead()) });
  const payload = fin.read({ now: NOW });
  const html = renderToString(React.createElement(m.exports.FinanceView, { data: payload, busy: false, act: async () => {} })).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
  assert.match(html, /Bank feeds: reconnect needed/);
  assert.match(html, /2026-05 \(complete month\)/);
  assert.match(html, /2026-06 is partial/);
  assert.match(html, /not 12 months/);
  assert.match(html, /Recurring payments/);
  assert.match(html, /Possible duplicate/);
  assert.match(html, /Helen’s own account/);
  assert.match(html, /Partial forward view/);
  assert.doesNotMatch(html, /MATTHEW WARD|JUNIPER/);
  assert.doesNotMatch(html, /fraud|suspicious|you spend too much/i);
});

test('Activity: semantic lines only — no per-transaction rows', () => {
  const kinds = db.all("SELECT kind, COUNT(*) AS n FROM personal_ops_events WHERE kind LIKE 'finance-%' GROUP BY kind");
  const map = Object.fromEntries(kinds.map((k) => [k.kind, k.n]));
  assert.equal(map['finance-activated'], 1);
  const total = kinds.reduce((a, k) => a + k.n, 0);
  assert.ok(total < 40, `${total} finance activity lines for ${staleRead().transactions.length} transactions`);
  const tl = require('./activity-timeline');
  assert.ok(typeof tl.read === 'function' || typeof tl.timeline === 'function');
});
