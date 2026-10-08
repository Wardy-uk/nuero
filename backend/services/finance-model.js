'use strict';

/**
 * Build 23 — the household finance read model. PURE: no DB, no network, no
 * clock (today/now are passed in). Tally is the source of truth; this turns
 * one read of it into what NEURO can say, and says what it cannot.
 *
 * Measured on Tally's real 1,150 rows (8 Oct 2026) before any rule was set:
 *   • A PENDING copy carries a short description with no card+date token and
 *     no balance_after ("ZILCH VIXA FROM TH"); its SETTLED copy arrives hours
 *     later with the full bank text ("1717 18JUN26 ZILCH VIXA FROM THE AA GB
 *     GB") and a balance. Tally's dedupe hash includes the description, so
 *     both survive. 8 strong pairs.
 *   • All 216 transfers are flagged AND paired by Tally; no unflagged row reads
 *     like one. 39 rows are credit-card repayments (Capital One, Marbles,
 *     Zable) whose card spending is NOT in Tally.
 *   • 421 of 912 spends have no category; 58 of 97 repeated merchants carry
 *     inconsistent ones. Tally's own auto-rules are keyed on card+date tokens
 *     ("1717 09APR26" → Shopping), which explains much of it.
 *   • Refunds: none reliable. Income: salary (Nurtur, Belron) and DWP into Joint.
 *   • Tally keeps no tags, splits, per-person attribution or bank ids.
 *
 * Nothing here decides FOR Nick: a category is evidence, a merchant hint is a
 * suggestion, a recurring pattern is a pattern. Item-level data for Helen's own
 * account never leaves this module except as a total.
 */

const crypto = require('crypto');

const DOMAINS = Object.freeze(['housing', 'groceries', 'transport', 'utilities', 'insurance', 'subscriptions', 'eating_out',
  'leisure', 'household', 'health', 'education', 'personal', 'debt_fees', 'income', 'transfers', 'unknown']);
const DOMAIN_LABEL = Object.freeze({
  housing: 'Housing', groceries: 'Groceries', transport: 'Transport', utilities: 'Bills & utilities', insurance: 'Insurance',
  subscriptions: 'Subscriptions', eating_out: 'Eating out', leisure: 'Leisure', household: 'Household', health: 'Health',
  education: 'Education', personal: 'Personal', debt_fees: 'Fees & charges', income: 'Income', transfers: 'Transfers', unknown: 'Unknown',
});
// Tally category → NEURO domain. `broad` = the category is a mixed bag (Bills &
// Utilities holds insurance, loans and the council), so a more specific hint is
// a SUGGESTION there, not a contradiction.
const CATEGORY_DOMAIN = Object.freeze({
  'groceries': ['groceries', 'direct'], 'eating out': ['eating_out', 'direct'], 'fuel': ['transport', 'direct'],
  'transport': ['transport', 'direct'], 'bills & utilities': ['utilities', 'broad'], 'subscriptions': ['subscriptions', 'direct'],
  'health': ['health', 'direct'], 'rent / mortgage': ['housing', 'direct'], 'entertainment': ['leisure', 'direct'],
  'holidays': ['leisure', 'direct'], 'kids': ['household', 'broad'], 'shopping': ['personal', 'broad'], 'gifts': ['personal', 'direct'],
  'fees & charges': ['debt_fees', 'direct'], 'savings': ['transfers', 'direct'], 'transfer': ['transfers', 'direct'],
  'salary': ['income', 'direct'], 'other income': ['income', 'direct'],
});
const UNUSABLE_CATEGORIES = new Set(['uncategorised', 'cash']);

// Word-bounded description hints → a SUGGESTED domain. Only what the audit saw.
const HINTS = Object.freeze([
  [/\b(INSURANCE|INSSRV|NFU MUTUAL|PET ?PLAN|D&G|DOMESTIC & GENERAL|AVIVA|ADMIRAL|DIRECT LINE|HASTINGS|CHURCHILL)\b/, 'insurance', 'an insurer'],
  [/\bMORTGAGE\b/, 'housing', 'a mortgage'],
  [/\b(EON|E ON|EDF|OCTOPUS|BRITISH GAS|SEVERN TRENT|SKY MOBILE|SKY TV|VIRGIN MEDIA|TV LICENCE|NWLDC|COUNCIL TAX|O2)\b/, 'utilities', 'a utility or household bill'],
  [/\b(TESCO|SAINSBURY|SAINSBURYS|ASDA|ALDI|LIDL|MORRISONS|MORR|CO-OP|COOP|WAITROSE|ICELAND)\b/, 'groceries', 'a supermarket'],
  [/\b(MCDONALDS|GREGGS|KFC|BURGER KING|SUBWAY|COSTA|STARBUCKS|CRUMBS 2GO|SLIM CHICKENS|NANDOS|JUST EAT|DELIVEROO|DOMINOS|UBER ?\* ?EATS)\b/, 'eating_out', 'a takeaway or café'],
  [/\b(NETFLIX|DISNEY PLUS|SPOTIFY|AUDIBLE|AMAZON PRIME|PRIME VIDEO|ITVX|NOW TV|YOUTUBE)\b/, 'subscriptions', 'a streaming or subscription service'],
  [/\b(SHELL|ESSO|TEXACO|GULF|BP|MURCO|PFS|S\/?STN|CAR PARK|PARKING|RINGGO|PAYBYPHONE|RAC|DVLA)\b/, 'transport', 'fuel, parking or motoring'],
  [/\b(SPECSAVERS|BOOTS|PHARMACY|DENTAL|DENTIST)\b/, 'health', 'a health retailer'],
]);
const CARD_REPAYMENT_RE = /\b(CAPITAL ONE|MARBLES|ZABLE|BARCLAYCARD|AMERICAN EXPRESS|AMEX|CREDIT ?CARD)\b/;
const FINANCING_RE = /\b(INSTALMENT|INSTALLMENT|REPAYMENT|LENDABLE|MONEYBARN|TANDEM HL|KLARNA)\b/;
const FEE_RE = /\b(SNOOZE FEE|UNPAID TRANSAC|OVERDRAFT|ARRANGED OD|INTEREST CHARGE|LATE FEE)\b/;
const CARD_DATE_TOKEN = /^\d{4} \d{2}[A-Z]{3}\d{2} /;
const TALLY_DATE_RULE = /^\d{4} \d{2}[A-Z]{3}\d{2}$|^\d{2}[A-Z]{3}$/;

// Thresholds, stated once. Each says what it is for.
const T = Object.freeze({
  PENDING_WINDOW_DAYS: 4,          // a settled copy arrives within days of its pending one
  FEED_FRESH_DAYS: 2,              // a bank feed that refreshed in 2 days is live
  RECONNECT_AFTER_DAYS: 3,         // no refresh for 3 days with an expired token = the link needs re-approval
  REFUND_LOOKBACK_DAYS: 90,
  DUPLICATE_WINDOW_DAYS: 2,
  RECUR_AMOUNT_TOLERANCE: 0.10,    // occurrences of one series within 10% of each other
  RECUR_STRONG_MIN: 3,
  RECUR_PRICE_STEP: 0.5,           // a later cluster up to 50% away continues the series as a price change
  PRICE_CHANGE_MIN_PENCE: 100,
  PRICE_CHANGE_MIN_RATIO: 0.05,
  UNUSUAL_MERCHANT_MULT: 3,
  UNUSUAL_MIN_PENCE: 4000,
  UNUSUAL_NEW_MIN_PENCE: 15000,
  UNUSUAL_HISTORY_MIN: 3,
  NEW_MERCHANT_WARMUP_DAYS: 30,    // in the first month of data every merchant is "new"
  MOM_STABLE_RATIO: 0.10,
  MOM_STABLE_PENCE: 10000,
});

// ── small helpers ────────────────────────────────────────────────────────────

const up = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
const alnum = (s) => up(s).replace(/[^A-Z0-9]/g, '');
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
function daysBetween(a, b) { return Math.round((dayMs(b) - dayMs(a)) / 86400000); }
function addDays(d, n) { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function monthEnd(m) { const x = new Date(`${m}-01T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); x.setUTCDate(0); return x.toISOString().slice(0, 10); }
function prevMonth(m) { const x = new Date(`${m}-01T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() - 1); return x.toISOString().slice(0, 7); }
function median(nums) { const s = [...nums].sort((a, b) => a - b); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); }
function shortHash(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12); }
const pounds = (p) => `£${(Math.abs(p) / 100).toFixed(2)}`;

/**
 * Raw bank text → the merchant key. Strips only the noise the audit saw: the
 * leading card digits, the DDMMMYY date token, a "CD "/"D " card-debit marker,
 * a trailing country code. Keeps a "ZILCH " channel prefix — it is a different
 * way of paying and belongs in the key.
 */
function merchantKey(description) {
  let s = up(description);
  s = s.replace(/^\d{4} /, '').replace(/^\d{2}[A-Z]{3}\d{2} /, '').replace(/^C?D /, '');
  s = s.replace(/( GB| IE)+$/, '').trim();
  // Bank text carries account and reference numbers ("25MAR A/C 26620871");
  // a long digit run identifies nothing useful and is not shown.
  s = s.replace(/\d{6,}/g, '#');
  return s || null;
}
/** The purchase date inside a card line ("1717 03JUN26 …" → "03JUN26"), or null. */
function purchaseToken(description) {
  const m = up(description).match(/^\d{4} (\d{2}[A-Z]{3}\d{2}) /);
  return m ? m[1] : null;
}
/** A coarser key for recurrence: the first two words, punctuation and ids gone. */
function recurKey(key) {
  const words = up(key).replace(/^ZILCH /, '').replace(/\.COM\b/g, '').replace(/[*/].*$/, '').replace(/[^A-Z& ]/g, ' ')
    .split(' ').filter((w) => w.length > 1 && !['LTD', 'LIMITED', 'PLC', 'UK', 'THE'].includes(w));
  return words.slice(0, 2).join(' ') || null;
}
function hintFor(key) {
  for (const [re, domain, why] of HINTS) if (re.test(key || '')) return { domain, why };
  return null;
}

// ── ownership ────────────────────────────────────────────────────────────────

/** Tally account → owner. Tally's only ownership fact is accounts.owner_user_id. */
function ownerOf(account) {
  const o = String(account && account.owner || '').trim().toLowerCase();
  if (o === 'nick') return { owner: 'nick', basis: 'Tally owner' };
  if (o === 'helen') return { owner: 'helen', basis: 'Tally owner' };
  if (!o) return { owner: 'shared', basis: 'no single owner recorded in Tally — treated as shared' };
  return { owner: 'other', basis: `owned by ${account.owner} in Tally` };
}

// ── transaction type (structural, before any domain) ─────────────────────────

/**
 * spend | fee | financing | card_repayment | transfer | income | refund | other_credit.
 * `refundFor` is decided later, against the merchant history.
 */
function transactionType(row, key) {
  const amt = Number(row.amount);
  if (row.is_transfer) return 'transfer';
  if (amt < 0) {
    if (CARD_REPAYMENT_RE.test(key || '')) return 'card_repayment';
    if (FINANCING_RE.test(key || '')) return 'financing';
    if (FEE_RE.test(key || '')) return 'fee';
    return 'spend';
  }
  if (amt > 0) return String(row.category_kind || '') === 'income' ? 'income' : 'other_credit';
  return 'other_credit';
}

// ── pending / settled ────────────────────────────────────────────────────────

/** A pending copy looks like this: no balance, no card+date token in the text. */
function looksPending(row) { return row.balance_after == null && !CARD_DATE_TOKEN.test(up(row.description)); }

/**
 * Reconcile pending and settled copies. Deterministic: pending rows in id
 * order, each matched at most once to the lowest-id settled row that fits.
 *   strong   same account, same amount, within the window, and one merchant
 *            text is a prefix of the other → pending is `superseded_pending`
 *   weak     same account/amount/window, first word agrees → `unresolved_duplicate`
 *   none     the pending row stands as `pending` (still real money)
 * Returns Map id → { status, pairedWith, basis }.
 */
function reconcilePending(rows) {
  const out = new Map();
  for (const r of rows) out.set(r.id, { status: 'settled', pairedWith: null, basis: null });
  const settled = rows.filter((r) => !looksPending(r));
  const used = new Set();
  const lastDate = new Map();
  for (const r of rows) if (!lastDate.has(r.account_id) || r.date > lastDate.get(r.account_id)) lastDate.set(r.account_id, r.date);
  const pend = rows.filter(looksPending).sort((a, b) => a.id - b.id);
  for (const p of pend) {
    const pk = alnum(merchantKey(p.description));
    const fits = settled.filter((s) => !used.has(s.id) && s.account_id === p.account_id && Number(s.amount) === Number(p.amount)
      && s.id !== p.id && Math.abs(daysBetween(p.date, s.date)) <= T.PENDING_WINDOW_DAYS && !s.is_transfer)
      .sort((a, b) => a.id - b.id);
    const strong = fits.find((s) => { const sk = alnum(merchantKey(s.description)); return pk.length >= 4 && (sk.startsWith(pk) || pk.startsWith(sk)); });
    if (strong) {
      used.add(strong.id);
      out.set(p.id, { status: 'superseded_pending', pairedWith: strong.id, basis: 'same account, amount and days apart; the pending text is the start of the settled one' });
      out.set(strong.id, { status: 'settled', pairedWith: p.id, basis: 'settled copy of a pending transaction' });
      continue;
    }
    const firstWord = (s) => up(merchantKey(s)).split(' ')[0];
    const weak = fits.find((s) => firstWord(s.description) && firstWord(s.description) === firstWord(p.description));
    if (weak) {
      out.set(p.id, { status: 'unresolved_duplicate', pairedWith: weak.id, basis: 'looks like the pending copy of another row, but the merchant text does not match closely enough to be sure' });
      continue;
    }
    // A pending copy settles within days. A balance-less row well before the end
    // of its account's data never had one to wait for (bank charges look like
    // this) — it stands as settled.
    const nearEnd = daysBetween(p.date, lastDate.get(p.account_id)) <= T.PENDING_WINDOW_DAYS;
    out.set(p.id, nearEnd
      ? { status: 'pending', pairedWith: null, basis: 'pending when Tally last synced; no settled copy seen' }
      : { status: 'settled', pairedWith: null, basis: 'no balance recorded by the bank, but too old to still be pending' });
  }
  return out;
}

/** Does a status count in totals? Pending + settled must never both count. */
const COUNTS = (status) => status === 'settled' || status === 'pending';

// ── domain resolution ────────────────────────────────────────────────────────

/** Does a rule Nick confirmed match? Exact keys only. PURE. */
function ruleMatches(rule, t) {
  if (!rule || !rule.active) return false;
  if (rule.match_kind === 'merchant') return !!rule.merchant_key && t.merchantKey === rule.merchant_key;
  if (rule.match_kind === 'merchant+category') return !!rule.merchant_key && !!rule.category_name
    && t.merchantKey === rule.merchant_key && String(t.category || '').toLowerCase() === String(rule.category_name).toLowerCase();
  if (rule.match_kind === 'tag') return !!rule.tag && (t.tags || []).includes(rule.tag);
  return false;
}

/**
 * Which domain, and why. Order: Nick's own decision on this transaction → the
 * structure of the transaction (transfer, income, card repayment…) → a rule Nick
 * confirmed → Tally's category (EVIDENCE) → unknown. A merchant hint never
 * decides; it only suggests or flags a contradiction for review.
 */
function resolveDomain(t, { decisions = new Map(), rules = [] } = {}) {
  const d = decisions.get(t.sourceTransactionId);
  const hint = hintFor(t.merchantKey);
  const catKey = String(t.category || '').trim().toLowerCase();
  const cat = CATEGORY_DOMAIN[catKey] || null;
  if (d && d.decision === 'confirm' && DOMAINS.includes(d.domain)) return { domain: d.domain, basis: 'confirmed-once', confidence: 'high', ruleId: null, hint, conflict: null };
  if (d && (d.decision === 'reject' || d.decision === 'unknown')) return { domain: 'unknown', basis: d.decision === 'reject' ? 'rejected-by-you' : 'left-unknown', confidence: 'high', ruleId: null, hint, conflict: null };
  const structural = { transfer: 'transfers', income: 'income', card_repayment: 'debt_fees', financing: 'debt_fees', fee: 'debt_fees' }[t.transactionType];
  if (structural) return { domain: structural, basis: 'structure', confidence: 'high', ruleId: null, hint: null, conflict: null };
  const rule = rules.find((r) => ruleMatches(r, t));
  if (rule) return { domain: rule.domain, basis: 'rule', confidence: 'high', ruleId: rule.rule_id, hint, conflict: null };
  if (cat && !UNUSABLE_CATEGORIES.has(catKey)) {
    const [domain, kind] = cat;
    const conflict = hint && hint.domain !== domain && kind === 'direct'
      ? { tallySays: t.category, descriptionSuggests: hint.domain, why: `Tally files it under "${t.category}", but the description names ${hint.why}` } : null;
    return { domain, basis: 'tally-category', confidence: kind === 'direct' ? 'medium' : 'low', ruleId: null, hint: hint && hint.domain !== domain ? hint : null, conflict };
  }
  return { domain: 'unknown', basis: 'unknown', confidence: 'none', ruleId: null, hint, conflict: null };
}

// ── normalisation ────────────────────────────────────────────────────────────

/**
 * One Tally read → the normalised rows (in memory only). Refunds and reversals
 * are matched against their original spend where the merchant agrees.
 */
function normalise({ transactions = [], accounts = [] } = {}, { decisions = new Map(), rules = [] } = {}) {
  const acc = new Map(accounts.map((a) => [a.id, a]));
  const pend = reconcilePending(transactions);
  const rows = transactions.map((r) => {
    const a = acc.get(r.account_id) || null;
    const key = merchantKey(r.description);
    const own = ownerOf(a);
    const p = pend.get(r.id);
    return {
      sourceTransactionId: r.id, date: r.date, amountPence: Number(r.amount), currency: 'GBP',
      merchantKey: key, recurKey: recurKey(key), description: r.description, category: r.category_name || null, tags: [],
      accountRef: `tally-account:${r.account_id}`, accountId: r.account_id, accountName: a ? a.name : null,
      owner: own.owner, ownerBasis: own.basis, status: p.status, pairedWith: p.pairedWith, statusBasis: p.basis,
      transactionType: transactionType(r, key), source: 'tally', provenance: `tally:${r.id}`, createdAt: r.created_at || null,
      balanceAfterPence: r.balance_after == null ? null : Number(r.balance_after), transferPair: r.transfer_pair_id || null,
    };
  });
  // refunds/reversals: a credit whose merchant matches an earlier spend on a household account
  const spends = rows.filter((t) => t.transactionType === 'spend' && COUNTS(t.status));
  for (const t of rows) {
    if (t.transactionType !== 'other_credit' || !COUNTS(t.status)) continue;
    const k = alnum(t.merchantKey);
    if (k.length < 4) continue;
    const orig = spends.filter((s) => s.date <= t.date && daysBetween(s.date, t.date) <= T.REFUND_LOOKBACK_DAYS
      && (alnum(s.merchantKey).startsWith(k) || k.startsWith(alnum(s.merchantKey))) && alnum(s.merchantKey).length >= 4)
      .sort((a, b) => (Math.abs(a.amountPence + t.amountPence) - Math.abs(b.amountPence + t.amountPence)) || (b.date.localeCompare(a.date)));
    if (!orig.length) continue;
    const o = orig[0];
    t.transactionType = (o.amountPence + t.amountPence === 0 && daysBetween(o.date, t.date) <= 7) ? 'reversal' : 'refund';
    t.refundOf = o.sourceTransactionId;
  }
  for (const t of rows) {
    if (t.transactionType === 'refund' || t.transactionType === 'reversal') {
      const o = rows.find((x) => x.sourceTransactionId === t.refundOf);
      const od = resolveDomain(o, { decisions, rules });
      t.domain = od.domain; t.domainBasis = `refund of tally:${t.refundOf}`; t.domainConfidence = od.confidence; t.hint = null; t.conflict = null;
      continue;
    }
    const d = resolveDomain(t, { decisions, rules });
    t.domain = d.domain; t.domainBasis = d.basis; t.domainConfidence = d.confidence; t.ruleId = d.ruleId; t.hint = d.hint; t.conflict = d.conflict;
  }
  return rows;
}

/** Net spend effect of a row: spend/fee negative pence → positive spend; refunds subtract. */
function spendEffect(t) {
  if (!COUNTS(t.status)) return 0;
  if (t.transactionType === 'spend' || t.transactionType === 'fee') return -t.amountPence;
  if (t.transactionType === 'refund' || t.transactionType === 'reversal') return -t.amountPence; // credit: reduces spend
  return 0;
}
function moneyOutEffect(t) {
  if (!COUNTS(t.status)) return 0;
  if (['spend', 'fee', 'financing', 'card_repayment'].includes(t.transactionType)) return -t.amountPence;
  if (t.transactionType === 'refund' || t.transactionType === 'reversal') return -t.amountPence;
  return 0;
}

// ── coverage ─────────────────────────────────────────────────────────────────

/**
 * How far each account's data can be trusted. `from` is its first transaction;
 * `through` is the day before its last bank refresh (Tally syncs a day's
 * transactions when the bank releases them), else its newest transaction.
 */
function accountCoverage({ rows = [], accounts = [], tlAccounts = [] } = {}) {
  return accounts.filter((a) => a.active !== 0).map((a) => {
    const mine = rows.filter((t) => t.accountId === a.id).map((t) => t.date).sort();
    const tl = tlAccounts.filter((x) => x.linked_account_id === a.id && x.last_sync_at).map((x) => x.last_sync_at).sort();
    const lastSync = tl.length ? tl[tl.length - 1] : null;
    const through = lastSync ? addDays(lastSync.slice(0, 10), -1) : (mine.length ? mine[mine.length - 1] : null);
    return { accountRef: `tally-account:${a.id}`, accountId: a.id, name: a.name, owner: ownerOf(a).owner, from: mine[0] || null, through, newest: mine[mine.length - 1] || null, rows: mine.length, lastSyncAt: lastSync };
  });
}
function monthCoverage(month, cov) {
  const start = `${month}-01`; const end = monthEnd(month);
  const withData = cov.filter((c) => c.rows > 0);
  const reasons = [];
  for (const c of withData) {
    if (!c.from || c.from > addDays(start, 6)) reasons.push(`${c.name} data starts ${c.from}`);
    else if (!c.through || c.through < end) reasons.push(`${c.name} data runs only to ${c.through}`);
  }
  if (!withData.length) reasons.push('no account has data');
  return { month, complete: reasons.length === 0, reasons };
}

// ── recurring ────────────────────────────────────────────────────────────────

function cadenceOf(gap) {
  if (gap >= 6 && gap <= 8) return { cadence: 'weekly', days: 7, tol: 1 };
  if (gap >= 13 && gap <= 15) return { cadence: 'fortnightly', days: 14, tol: 2 };
  if (gap >= 26 && gap <= 34) return { cadence: 'monthly', days: 30, tol: 5 };
  if (gap >= 85 && gap <= 95) return { cadence: 'quarterly', days: 91, tol: 7 };
  if (gap >= 355 && gap <= 375) return { cadence: 'yearly', days: 365, tol: 10 };
  return null;
}
function seriesKeyFor(accountId, rk, cluster) { return `rs_${shortHash(`${accountId}|${rk}|${cluster}`)}`; }

/**
 * Recurring payments, conservatively. Occurrences are grouped by account and
 * coarse merchant, split into amount clusters, and a later cluster continues an
 * earlier one as a PRICE CHANGE when it picks up where that one stopped.
 *   explicit_recurring  Nick said so
 *   strong_pattern      ≥3 occurrences, regular cadence, steady amount, still active
 *   weak_pattern        repeats, but fails one of those
 *   not_recurring       Nick said not
 *   unknown             too little data to judge (e.g. yearly in a 6-month window)
 * Only explicit and strong feed operational views.
 */
function detectRecurring(rows, { coverage = [], decisions = new Map(), tallyRecurring = [], today } = {}) {
  const pool = rows.filter((t) => COUNTS(t.status) && ['spend', 'fee', 'financing', 'card_repayment', 'income'].includes(t.transactionType) && t.recurKey);
  const groups = new Map();
  for (const t of pool) { const k = `${t.accountId}|${t.recurKey}`; groups.set(k, [...(groups.get(k) || []), t]); }
  const cov = new Map(coverage.map((c) => [c.accountId, c]));
  const out = [];
  for (const [gk, list] of groups) {
    if (list.length < 2) continue;
    const [accountId] = gk.split('|');
    // amount clusters (greedy, by amount)
    const byAmt = [...list].sort((a, b) => a.amountPence - b.amountPence);
    const clusters = [];
    for (const t of byAmt) {
      const c = clusters.find((x) => Math.abs(t.amountPence - x.median) <= Math.abs(x.median) * T.RECUR_AMOUNT_TOLERANCE);
      if (c) { c.items.push(t); c.median = median(c.items.map((i) => i.amountPence)); } else clusters.push({ items: [t], median: t.amountPence });
    }
    for (const c of clusters) c.items.sort((a, b) => a.date.localeCompare(b.date));
    clusters.sort((a, b) => a.items[0].date.localeCompare(b.items[0].date));
    // chain price changes: cluster B continues A when it starts after A ends, within the step
    const chains = [];
    for (const c of clusters) {
      const prev = chains.find((ch) => { const last = ch[ch.length - 1]; const lastDate = last.items[last.items.length - 1].date;
        return c.items[0].date > lastDate && Math.abs(c.median - last.median) <= Math.abs(last.median) * T.RECUR_PRICE_STEP && last.items.length >= 2; });
      if (prev) prev.push(c); else chains.push([c]);
    }
    for (const chain of chains) {
      const items = chain.flatMap((c) => c.items).sort((a, b) => a.date.localeCompare(b.date));
      if (items.length < 2) continue;
      const gaps = items.slice(1).map((t, i) => daysBetween(items[i].date, t.date));
      const medGap = median(gaps);
      const cad = cadenceOf(medGap);
      const first = items[0];
      const rk = first.recurKey;
      const key = seriesKeyFor(accountId, rk, chain[0].median);
      const c = cov.get(Number(accountId));
      const through = c ? c.through : items[items.length - 1].date;
      const last = items[items.length - 1];
      const regular = !!cad && gaps.every((g) => Math.abs(g - cad.days) <= cad.tol || (cad.cadence === 'monthly' && g >= 26 && g <= 34));
      const steady = chain.length === 1 || chain.slice(1).every((cl) => cl.items.length >= 1);
      const active = !!cad && daysBetween(last.date, through) <= Math.round(cad.days * 1.5);
      const lastAmt = chain[chain.length - 1].median;
      const amounts = items.map((t) => -t.amountPence);
      const d = decisions.get(key);
      let state;
      if (d && d.decision === 'not-recurring') state = 'not_recurring';
      else if (d && d.decision === 'recurring') state = 'explicit_recurring';
      else if (cad && regular && items.length >= T.RECUR_STRONG_MIN && active && steady) state = 'strong_pattern';
      else if (cad) state = 'weak_pattern';
      else state = 'unknown';
      // price change: the latest cluster against the one before it
      let priceChange = null;
      if (chain.length >= 2 && chain[0].median < 0) {
        const before = chain[chain.length - 2]; const now = chain[chain.length - 1];
        const from = -before.median; const to = -now.median;
        if (Math.abs(to - from) >= T.PRICE_CHANGE_MIN_PENCE && Math.abs(to - from) / from >= T.PRICE_CHANGE_MIN_RATIO) {
          priceChange = { fromPence: from, toPence: to, firstAt: now.items[0].date, seenTimes: now.items.length,
            line: `Payment ${to > from ? 'increased' : 'decreased'} from ${pounds(from)} to ${pounds(to)}${now.items.length === 1 ? ' (seen once so far)' : ''}` };
        }
      }
      // next expected: step the cadence on from the last occurrence; say if that crosses a gap in the data
      let nextExpected = null; let projectedThroughGap = false;
      if (cad && (state === 'strong_pattern' || state === 'explicit_recurring')) {
        nextExpected = addDays(last.date, cad.days);
        while (today && nextExpected < today) { nextExpected = addDays(nextExpected, cad.days); projectedThroughGap = true; }
        if (through && through < addDays(last.date, cad.days)) projectedThroughGap = projectedThroughGap || (today && through < today);
      }
      const tallyMatch = tallyRecurring.find((r) => { const tk = alnum(r.merchant); const ok = alnum(first.merchantKey); return tk.length >= 4 && (ok.startsWith(tk) || tk.startsWith(alnum(rk))); });
      out.push({
        seriesKey: key, accountId: Number(accountId), accountRef: first.accountRef, accountName: first.accountName, owner: first.owner,
        label: last.merchantKey || rk, merchantKey: last.merchantKey, transactionType: last.transactionType, domain: last.domain,
        direction: lastAmt > 0 ? 'in' : 'out',
        cadence: cad ? cad.cadence : null, occurrences: items.length, firstSeen: first.date, lastSeen: last.date, active,
        typicalPence: Math.abs(lastAmt), amountsPence: amounts.map(Math.abs), state, priceChange, nextExpected, projectedThroughGap,
        txnIds: items.map((t) => t.sourceTransactionId),
        tally: tallyMatch ? { listed: true, ignoredInTally: !!tallyMatch.ignored, cadence: tallyMatch.cadence } : { listed: false },
        why: [
          `${items.length} payment${items.length === 1 ? '' : 's'} to ${rk} from ${first.accountName}`,
          cad ? `about every ${cad.days} days (${cad.cadence})` : `irregular gaps (median ${medGap} days)`,
          regular ? 'gaps are regular' : 'gaps vary',
          active ? 'still being paid at the end of the data' : `last paid ${last.date}, before the data ends (${through})`,
          tallyMatch ? `Tally also lists it${tallyMatch.ignored ? ' (you hid it in Tally)' : ''}` : null,
          d ? `you marked it ${d.decision === 'recurring' ? 'recurring' : 'not recurring'}` : null,
        ].filter(Boolean),
      });
    }
  }
  return out.sort((a, b) => b.typicalPence - a.typicalPence || a.seriesKey.localeCompare(b.seriesKey));
}
const OPERATIONAL = (s) => s.state === 'explicit_recurring' || s.state === 'strong_pattern';

// ── anomalies and duplicates ─────────────────────────────────────────────────

/**
 * Unusual compared with recorded history. Conservative; never "fraud".
 *   above-merchant-history  ≥3 earlier payments to the same merchant, this one
 *                           ≥3× their median and ≥£40
 *   unusual-merchant        first time seen, ≥£150, after the first month of data
 * Explained (and so not listed): part of an operational recurring series,
 * housing, a finance obligation of that size near that date, or Nick said expected.
 */
function unusualSpend(rows, { series = [], obligations = [], reviewDecisions = new Map(), dataFrom = null } = {}) {
  const inSeries = new Set(series.filter(OPERATIONAL).flatMap((s) => s.txnIds));
  const spends = rows.filter((t) => COUNTS(t.status) && t.transactionType === 'spend').sort((a, b) => a.date.localeCompare(b.date) || a.sourceTransactionId - b.sourceTransactionId);
  const out = [];
  for (const t of spends) {
    const amt = -t.amountPence;
    const prior = spends.filter((s) => s.merchantKey === t.merchantKey && (s.date < t.date || (s.date === t.date && s.sourceTransactionId < t.sourceTransactionId)));
    const sameCoarse = spends.filter((s) => s.recurKey && s.recurKey === t.recurKey && s.date < t.date);
    let kind = null; let why = null;
    if (prior.length >= T.UNUSUAL_HISTORY_MIN) {
      const m = median(prior.map((s) => -s.amountPence));
      if (amt >= T.UNUSUAL_MIN_PENCE && amt >= m * T.UNUSUAL_MERCHANT_MULT) { kind = 'above-merchant-history'; why = `${pounds(amt)} against a usual ${pounds(m)} across ${prior.length} earlier payments to ${t.merchantKey}`; }
    } else if (!prior.length && !sameCoarse.length && amt >= T.UNUSUAL_NEW_MIN_PENCE && dataFrom && daysBetween(dataFrom, t.date) >= T.NEW_MERCHANT_WARMUP_DAYS) {
      kind = 'unusual-merchant'; why = `${pounds(amt)} to ${t.merchantKey}, a merchant not seen before in the recorded history`;
    }
    if (!kind) continue;
    const itemKey = `ri_${shortHash(`unusual|${t.sourceTransactionId}`)}`;
    let explainedBy = null;
    if (inSeries.has(t.sourceTransactionId)) explainedBy = 'part of a recurring payment';
    else if (t.domain === 'housing') explainedBy = 'housing';
    else {
      const ob = obligations.find((o) => o.expectedAmountPence && o.dueDate && Math.abs(o.expectedAmountPence - amt) <= o.expectedAmountPence * 0.1 && Math.abs(daysBetween(o.dueDate, t.date)) <= 7);
      if (ob) explainedBy = `the "${ob.title}" you recorded`;
    }
    const rd = reviewDecisions.get(itemKey);
    if (rd && rd.decision === 'expected') explainedBy = 'you said it was expected';
    out.push({ itemKey, kind, txn: t, why, explainedBy, decision: rd ? rd.decision : null,
      line: `Unusual compared with your recorded history: ${why}` });
  }
  return out;
}

/**
 * Possible duplicate charges: same account, same merchant, same amount, within
 * two days, both counted (a pending/settled pair is NOT a duplicate). Output
 * only ever says "possible duplicate"; nothing is disputed or acted on.
 */
function duplicateCharges(rows, { series = [], reviewDecisions = new Map() } = {}) {
  const weekly = new Set(series.filter((s) => OPERATIONAL(s) && s.cadence === 'weekly').flatMap((s) => s.txnIds));
  const pool = rows.filter((t) => COUNTS(t.status) && (t.transactionType === 'spend' || t.transactionType === 'fee') && t.merchantKey).sort((a, b) => a.sourceTransactionId - b.sourceTransactionId);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i]; const b = pool[j];
      if (seen.has(b.sourceTransactionId)) continue;
      if (a.accountId !== b.accountId || a.merchantKey !== b.merchantKey || a.amountPence !== b.amountPence) continue;
      if (Math.abs(daysBetween(a.date, b.date)) > T.DUPLICATE_WINDOW_DAYS) continue;
      if (weekly.has(a.sourceTransactionId) && weekly.has(b.sourceTransactionId)) continue;
      if (a.pairedWith === b.sourceTransactionId || b.pairedWith === a.sourceTransactionId) continue;
      // Both card lines carry the date of purchase: different dates are two purchases.
      const pa = purchaseToken(a.description); const pb = purchaseToken(b.description);
      if (pa && pb && pa !== pb) continue;
      seen.add(b.sourceTransactionId);
      const itemKey = `ri_${shortHash(`dup|${a.sourceTransactionId}|${b.sourceTransactionId}`)}`;
      const rd = reviewDecisions.get(itemKey);
      out.push({ itemKey, kind: 'possible-duplicate', txns: [a, b], decision: rd ? rd.decision : null,
        line: `Possible duplicate: two ${pounds(-a.amountPence)} payments to ${a.merchantKey} on ${a.date}${a.date === b.date ? '' : ` and ${b.date}`} from ${a.accountName}` });
    }
  }
  return out;
}

// ── category quality ─────────────────────────────────────────────────────────

/**
 * How good is Tally's classification? Counts over ALL accounts (aggregate);
 * named merchants and rule opportunities over household-visible accounts only.
 */
function categoryQuality(rows, { tallyRules = [], visible = (t) => t.owner !== 'helen' } = {}) {
  const spends = rows.filter((t) => COUNTS(t.status) && (t.transactionType === 'spend' || t.transactionType === 'fee'));
  const classified = spends.filter((t) => t.domain !== 'unknown');
  const byTally = spends.filter((t) => t.category && !UNUSABLE_CATEGORIES.has(String(t.category).toLowerCase()));
  const conflicts = spends.filter((t) => t.conflict);
  const motoring = spends.filter((t) => {
    const cat = String(t.category || '').toLowerCase();
    const h = (hintFor(t.merchantKey) || {}).domain || null;
    return (cat === 'fuel' && h !== 'transport') || (h === 'transport' && cat !== 'fuel' && cat !== 'transport');
  });
  const byMerchant = new Map();
  for (const t of spends) { const k = t.merchantKey; if (!k) continue; byMerchant.set(k, [...(byMerchant.get(k) || []), t]); }
  const repeated = [...byMerchant.values()].filter((l) => l.length >= 2);
  const inconsistent = repeated.filter((l) => new Set(l.map((t) => t.category || '(none)')).size > 1);
  const visibleList = (ls) => ls.filter((l) => l.every(visible));
  const topAmbiguous = visibleList(inconsistent).sort((a, b) => b.length - a.length).slice(0, 8).map((l) => ({
    merchantKey: l[0].merchantKey, transactions: l.length, categories: Object.entries(l.reduce((o, t) => { const c = t.category || '(none)'; o[c] = (o[c] || 0) + 1; return o; }, {})).map(([c, n]) => ({ category: c, n })),
  }));
  const opportunities = visibleList([...byMerchant.values()].filter((l) => l.length >= 3 && l.some((t) => t.domain === 'unknown' || t.conflict) && l.every((t) => !t.ruleId)))
    .sort((a, b) => b.length - a.length).slice(0, 8).map((l) => ({
      merchantKey: l[0].merchantKey, transactions: l.length, unknown: l.filter((t) => t.domain === 'unknown').length,
      suggestion: (hintFor(l[0].merchantKey) || {}).domain || null,
      line: `"Confirm and remember" on ${l[0].merchantKey} would settle ${l.length} transactions`,
    }));
  const dateRules = tallyRules.filter((r) => TALLY_DATE_RULE.test(String(r.match_value || '').trim().toUpperCase())).length;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
  return {
    totals: { spendTransactions: spends.length, classified: classified.length, unknown: spends.length - classified.length,
      withUsableTallyCategory: byTally.length, contradictory: conflicts.length, motoringMiscategorised: motoring.length,
      repeatedMerchants: repeated.length, inconsistentMerchants: inconsistent.length, tallyRules: tallyRules.length, tallyRulesKeyedOnDates: dateRules },
    score: { classifiedPct: pct(classified.length, spends.length), consistentMerchantPct: pct(repeated.length - inconsistent.length, repeated.length) },
    readout: [
      `${pct(classified.length, spends.length)}% of spending has a usable domain (${spends.length - classified.length} of ${spends.length} are unknown).`,
      `${pct(repeated.length - inconsistent.length, repeated.length)}% of repeated merchants are categorised consistently in Tally (${inconsistent.length} of ${repeated.length} are not).`,
      conflicts.length ? `${conflicts.length} transaction${conflicts.length === 1 ? ' has a Tally category' : 's have Tally categories'} that the description contradicts.` : null,
      dateRules ? `${dateRules} of Tally's ${tallyRules.length} auto-rules match a card number and a date, so they categorise everything bought with that card on that day the same way.` : null,
      motoring.length ? `${motoring.length} motoring transactions are in the wrong Tally category (fuel in Groceries or none, food in Fuel) — the Build 21 finding.` : null,
    ].filter(Boolean),
    topAmbiguous, opportunities,
    conflicts: conflicts.filter(visible).slice(0, 20).map((t) => ({ txn: t, ...t.conflict })),
  };
}

// ── summaries ────────────────────────────────────────────────────────────────

function emptyByDomain() { return Object.fromEntries(DOMAINS.filter((d) => !['income', 'transfers'].includes(d)).map((d) => [d, 0])); }

/**
 * One month, deterministic. Spending = spend + fees net of refunds; money out
 * adds finance and card repayments; transfers never count. Category totals add
 * up to the spending total (pinned). Item-level lines exclude Helen's account.
 */
function monthlySummary(month, rows, { coverage = [], series = [], unusual = [], duplicates = [], visible = (t) => t.owner !== 'helen' } = {}) {
  const inM = rows.filter((t) => t.date.slice(0, 7) === month);
  const counted = inM.filter((t) => COUNTS(t.status));
  const byDomain = emptyByDomain();
  let spend = 0; let moneyOut = 0; let income = 0; let otherCredits = 0; let financing = 0; let cardRepayments = 0;
  const owners = { nick: 0, shared: 0, helen: 0, other: 0 };
  for (const t of counted) {
    const s = spendEffect(t);
    if (s) { byDomain[t.domain in byDomain ? t.domain : 'unknown'] += s; spend += s; owners[t.owner] = (owners[t.owner] || 0) + s; }
    moneyOut += moneyOutEffect(t);
    if (t.transactionType === 'income') income += t.amountPence;
    if (t.transactionType === 'other_credit') otherCredits += t.amountPence;
    if (t.transactionType === 'financing') financing += -t.amountPence;
    if (t.transactionType === 'card_repayment') cardRepayments += -t.amountPence;
  }
  const mc = monthCoverage(month, coverage);
  const operational = new Set(series.filter(OPERATIONAL).flatMap((s) => s.txnIds));
  const recurring = counted.filter((t) => operational.has(t.sourceTransactionId)).reduce((a, t) => a + moneyOutEffect(t), 0);
  const merch = new Map();
  for (const t of counted.filter(visible)) { const s = spendEffect(t); if (s > 0 && t.merchantKey) merch.set(t.merchantKey, (merch.get(t.merchantKey) || 0) + s); }
  const biggest = [...merch].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([merchantKey, pence]) => ({ merchantKey, pence }));
  const sup = inM.filter((t) => t.status === 'superseded_pending');
  const unres = inM.filter((t) => t.status === 'unresolved_duplicate');
  const incomeSeen = income > 0;
  return {
    month, complete: mc.complete, coverageReasons: mc.reasons,
    spendPence: spend, byDomain: Object.fromEntries(Object.entries(byDomain).filter(([, v]) => v !== 0)),
    moneyOutPence: moneyOut, financingPence: financing, cardRepaymentsPence: cardRepayments,
    incomePence: income, otherCreditsPence: otherCredits,
    net: mc.complete && incomeSeen ? { pence: income + otherCredits - moneyOut, meaningful: true } : { pence: null, meaningful: false, why: !mc.complete ? 'the month is not fully covered' : 'no income recorded this month' },
    owners: { nickPence: owners.nick, sharedPence: owners.shared, helenOwnAccountPence: owners.helen, basis: 'by account owner in Tally: Nick\'s account, the Joint and Bills accounts (no single owner), and Helen\'s own account as a total only' },
    recurringPence: recurring, biggestMerchants: biggest,
    unusual: unusual.filter((u) => u.txn.date.slice(0, 7) === month && !u.explainedBy).length,
    possibleDuplicates: duplicates.filter((d) => d.txns[0].date.slice(0, 7) === month && d.decision !== 'not-duplicate').length,
    pendingExcluded: { count: sup.length, pence: sup.reduce((a, t) => a - t.amountPence, 0) },
    unresolvedDuplicates: { count: unres.length, pence: unres.reduce((a, t) => a - t.amountPence, 0), note: unres.length ? 'excluded from totals until it can be told apart from its settled copy' : null },
    cardSpendNote: cardRepayments ? 'Credit-card repayments are money out, but the card\'s own spending is not in Tally, so it is not in the categories.' : null,
  };
}

/** Month-on-month: latest two COMPLETE months only. A partial month is never compared. */
function monthOnMonth(summaries) {
  const complete = summaries.filter((s) => s.complete).sort((a, b) => a.month.localeCompare(b.month));
  if (complete.length < 2) return { state: 'insufficient data', why: `${complete.length} complete month${complete.length === 1 ? '' : 's'} of data` };
  const cur = complete[complete.length - 1]; const prev = complete[complete.length - 2];
  if (prev.month !== prevMonth(cur.month)) return { state: 'insufficient data', why: `the latest complete months (${prev.month}, ${cur.month}) are not consecutive` };
  const delta = cur.spendPence - prev.spendPence;
  const ratio = prev.spendPence ? delta / prev.spendPence : null;
  const stable = Math.abs(delta) < T.MOM_STABLE_PENCE || (ratio != null && Math.abs(ratio) < T.MOM_STABLE_RATIO);
  const doms = new Set([...Object.keys(cur.byDomain), ...Object.keys(prev.byDomain)]);
  const drivers = [...doms].map((d) => ({ domain: d, label: DOMAIN_LABEL[d], deltaPence: (cur.byDomain[d] || 0) - (prev.byDomain[d] || 0) }))
    .filter((x) => x.deltaPence !== 0).sort((a, b) => Math.abs(b.deltaPence) - Math.abs(a.deltaPence)).slice(0, 3);
  return {
    state: stable ? 'broadly stable' : delta > 0 ? 'up' : 'down', current: cur.month, previous: prev.month,
    currentPence: cur.spendPence, previousPence: prev.spendPence, deltaPence: delta,
    drivers, line: `${cur.month} spending ${stable ? 'was broadly stable against' : delta > 0 ? `was up ${pounds(delta)} on` : `was down ${pounds(delta)} on`} ${prev.month}`
      + (drivers.length && !stable ? ` — mostly ${drivers.slice(0, 2).map((d) => `${d.label.toLowerCase()} (${d.deltaPence > 0 ? '+' : '−'}${pounds(d.deltaPence)})`).join(' and ')}` : ''),
  };
}

/** The rolling view, with its EXACT window. Never called 12 months unless it is. */
function rollingWindow(coverage, { today }) {
  const from = coverage.map((c) => c.from).filter(Boolean).sort()[0] || null;
  const through = coverage.map((c) => c.through).filter(Boolean).sort().slice(-1)[0] || null;
  if (!from || !through) return { state: 'no data', label: 'No finance data yet' };
  const start = from < addDays(today, -365) ? addDays(today, -365) : from;
  const days = daysBetween(start, through) + 1;
  const full = days >= 365;
  const months = Math.floor(days / 30.44);
  return { from: start, through, days, isTwelveMonths: full, label: full ? `Last 12 months (${start} – ${through})` : `${start} – ${through} (${months} month${months === 1 ? '' : 's'} of data — not 12 months)` };
}

// ── balances, cashflow, pressure ─────────────────────────────────────────────

/** Tally's own current balance: opening_balance + sum of its rows, as of its last refresh. */
function balances({ transactions = [], accounts = [] } = {}, coverage = [], { today }) {
  const cov = new Map(coverage.map((c) => [c.accountId, c]));
  return accounts.filter((a) => a.active !== 0).map((a) => {
    const sum = transactions.filter((t) => t.account_id === a.id).reduce((s, t) => s + Number(t.amount), 0);
    const c = cov.get(a.id) || {};
    const asOf = c.lastSyncAt ? c.lastSyncAt.slice(0, 10) : c.newest || null;
    const ageDays = asOf ? daysBetween(asOf, today) : null;
    const own = ownerOf(a).owner;
    return { accountRef: `tally-account:${a.id}`, name: a.name, owner: own, balancePence: own === 'helen' ? null : Number(a.opening_balance || 0) + sum,
      shownAsTotalOnly: own === 'helen', asOf, ageDays, fresh: ageDays != null && ageDays <= T.FEED_FRESH_DAYS };
  });
}

/**
 * Forward cashflow, only when the inputs are genuinely there: every balance
 * fresh, and operational recurring payments known. Otherwise it says why not.
 * Never "you will have £X left" from partial inputs.
 */
function forwardCashflow({ balances: bal = [], series = [], upcoming = null, horizonDays = 30 } = {}) {
  const reasons = [];
  if (!bal.length) reasons.push('no account balances');
  const stale = bal.filter((b) => !b.fresh);
  if (stale.length) reasons.push(`${stale.length} of ${bal.length} account balance${bal.length === 1 ? ' is' : 's are'} not current (${stale.map((b) => `${b.name} as of ${b.asOf || 'unknown'}`).join(', ')})`);
  if (!series.some(OPERATIONAL)) reasons.push('no recurring payment is established');
  const incomeKnown = series.some((s) => OPERATIONAL(s) && s.transactionType === 'income');
  if (!incomeKnown) reasons.push('income dates are not established as a recurring pattern');
  if (reasons.length) return { state: 'insufficient data', label: 'Not enough current data for a forward view', reasons };
  const start = bal.reduce((a, b) => a + (b.balancePence || 0), 0);
  const out = upcoming && upcoming[`d${horizonDays}`] ? upcoming[`d${horizonDays}`].knownPence : 0;
  return { state: 'partial', label: 'Partial forward view', startPence: start, knownOutPence: out, reasons: ['only payments NEURO can see are included'] };
}
function pressure(cashflow) {
  if (!cashflow || cashflow.state === 'insufficient data') return { state: 'insufficient data', why: cashflow ? cashflow.reasons[0] : 'no forward view' };
  return { state: cashflow.startPence - cashflow.knownOutPence >= 0 ? 'comfortable' : 'tighter than usual', basis: 'known balance minus known payments; read-only, never pushed' };
}

// ── upcoming money out ───────────────────────────────────────────────────────

/** Known outgoing money in 7/14/30 days, from operational series and obligations. */
function upcomingMoneyOut({ series = [], obligations = [], today, staleFeed = false } = {}) {
  const out = {};
  for (const h of [7, 14, 30]) {
    const last = addDays(today, h);
    const items = [];
    for (const s of series.filter((x) => OPERATIONAL(x) && x.nextExpected && x.transactionType !== 'income')) {
      let d = s.nextExpected;
      const step = { weekly: 7, fortnightly: 14, monthly: 30, quarterly: 91, yearly: 365 }[s.cadence] || 30;
      while (d <= last) {
        if (d >= today) items.push({ kind: 'recurring', seriesKey: s.seriesKey, label: s.owner === 'helen' ? 'A payment from Helen\'s own account' : s.label, date: d, amountPence: s.typicalPence, owner: s.owner,
          confidence: s.state === 'explicit_recurring' ? 'high' : 'medium', basis: s.state === 'explicit_recurring' ? 'you marked it recurring' : `recurring ${s.cadence}`,
          caveat: s.projectedThroughGap || staleFeed ? 'projected from earlier payments — not seen recently because the bank feed is stale' : null });
        d = addDays(d, step);
      }
    }
    for (const o of obligations.filter((x) => x.status === 'open' && x.dueDate && x.dueDate >= today && x.dueDate <= last)) {
      if (o.seriesKey && items.some((i) => i.seriesKey === o.seriesKey && Math.abs(daysBetween(i.date, o.dueDate)) <= 7)) continue;
      items.push({ kind: 'obligation', obligationId: o.id, label: o.title, date: o.dueDate, amountPence: o.expectedAmountPence || null, confidence: 'high', basis: 'a date you recorded', caveat: o.expectedAmountPence ? null : 'no amount recorded' });
    }
    items.sort((a, b) => a.date.localeCompare(b.date) || String(a.label).localeCompare(String(b.label)));
    const known = items.reduce((a, i) => a + (i.amountPence || 0), 0);
    const reasons = [];
    if (staleFeed) reasons.push('the bank feed is stale, so recent changes to these payments are not visible');
    if (items.some((i) => i.amountPence == null)) reasons.push('some recorded dates have no amount');
    reasons.push('only established recurring payments and dates you recorded are included');
    out[`d${h}`] = { days: h, items, knownPence: known, partial: true, label: 'Partial forward view', reasons };
  }
  return out;
}

// ── feed health and reconnect ────────────────────────────────────────────────

/**
 * Bank-feed health per Tally account and for the household. Old rows existing
 * is NOT health: only a recent bank refresh is.
 *   healthy | stale | reconnect_required | unknown   per account
 *   healthy | partial | stale | reconnect_required | unknown   household
 */
function feedHealth({ accounts = [], tlAccounts = [], connections = [], coverage = [], now }) {
  const today = new Date(now).toISOString().slice(0, 10);
  const conn = new Map(connections.map((c) => [c.id, c]));
  const per = accounts.filter((a) => a.active !== 0).map((a) => {
    const links = tlAccounts.filter((t) => t.linked_account_id === a.id).map((t) => ({ ...t, connection: conn.get(t.connection_id) || null }));
    const activeLinks = links.filter((l) => l.connection && l.connection.active);
    const best = [...activeLinks].sort((x, y) => String(y.last_sync_at || '').localeCompare(String(x.last_sync_at || '')))[0] || null;
    const c = coverage.find((x) => x.accountId === a.id) || {};
    const own = ownerOf(a).owner;
    const base = { accountRef: `tally-account:${a.id}`, name: a.name, owner: own, newestTransaction: c.newest || null, lastRefreshAt: best ? best.last_sync_at : null, connections: activeLinks.length };
    if (!links.length) return { ...base, state: 'unknown', why: 'no bank link in Tally — imported by hand, if at all' };
    if (!best || !best.last_sync_at) return { ...base, state: 'unknown', why: 'linked to the bank but never refreshed' };
    const age = daysBetween(best.last_sync_at.slice(0, 10), today);
    if (age <= T.FEED_FRESH_DAYS) return { ...base, state: 'healthy', ageDays: age, why: `refreshed ${age === 0 ? 'today' : `${age} day${age === 1 ? '' : 's'} ago`}` };
    const exp = best.connection && best.connection.expires_at ? Date.parse(best.connection.expires_at) : NaN;
    const expiredDays = Number.isFinite(exp) ? Math.floor((now - exp) / 86400000) : null;
    if (age >= T.RECONNECT_AFTER_DAYS && expiredDays != null && expiredDays >= T.RECONNECT_AFTER_DAYS) {
      return { ...base, state: 'reconnect_required', ageDays: age, why: `no bank refresh since ${best.last_sync_at.slice(0, 10)} and the bank link stopped renewing — it needs re-approving at ${best.connection.provider_name || 'the bank'}` };
    }
    return { ...base, state: 'stale', ageDays: age, why: `last bank refresh ${best.last_sync_at.slice(0, 10)} (${age} days ago)` };
  });
  const states = per.map((p) => p.state);
  let household;
  if (!per.length) household = 'unknown';
  else if (states.every((s) => s === 'healthy')) household = 'healthy';
  else if (states.some((s) => s === 'healthy')) household = 'partial';
  else if (states.every((s) => s === 'reconnect_required')) household = 'reconnect_required';
  else if (states.every((s) => s === 'unknown')) household = 'unknown';
  else household = states.includes('reconnect_required') ? 'reconnect_required' : 'stale';
  const helenStale = per.filter((p) => p.owner === 'helen' && p.state !== 'healthy');
  const label = { healthy: 'Bank feeds live', partial: 'Some bank feeds are live', stale: 'Bank feeds are stale', reconnect_required: 'Bank feeds need reconnecting', unknown: 'Bank feed state unknown' }[household];
  return { household, label, accounts: per,
    helen: helenStale.length ? { state: helenStale[0].state, why: 'Helen\'s own account is not refreshing; household totals are partial until she reconnects it' } : null,
    rule: 'Healthy means the bank refreshed in the last 2 days. Stored history on its own is never health.' };
}

/**
 * Post-reconnect validation, measured from Tally after Nick (or Helen)
 * re-approves. Account identity is Tally's account id; a reconnect must feed
 * the SAME accounts (Tally relinks by account number and sort code).
 */
function reconnectReport({ accounts = [], tlAccounts = [], connections = [], transactions = [], knownAccounts = [], rows = [] } = {}) {
  const conns = [...connections].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const latestConnAt = conns.length ? conns[conns.length - 1].created_at : null;
  const per = accounts.filter((a) => a.active !== 0).map((a) => {
    const links = tlAccounts.filter((t) => t.linked_account_id === a.id).sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)));
    const newest = links[links.length - 1] || null;
    const mine = transactions.filter((t) => t.account_id === a.id);
    // A link is a RE-link when the account already held transactions before the
    // link existed. Measured on the real reconnect (8 Oct 2026): Tally DELETED the
    // dead connection's rows, leaving one new link per account — so "two links"
    // is not the evidence; "data older than the link" is.
    const firstCreated = mine.map((t) => String(t.created_at || '')).filter(Boolean).sort()[0] || null;
    const relinked = !!newest && !!firstCreated && String(newest.created_at) > firstCreated;
    const relinkAt = relinked ? newest.created_at : null;
    const before = relinkAt ? mine.filter((t) => String(t.created_at) < String(relinkAt)) : mine;
    const after = relinkAt ? mine.filter((t) => String(t.created_at) >= String(relinkAt)) : [];
    const newestBefore = before.map((t) => t.date).sort().slice(-1)[0] || null;
    const oldestBackfilled = after.map((t) => t.date).sort()[0] || null;
    const newestTxn = mine.map((t) => t.date).sort().slice(-1)[0] || null;
    const keyOf = (t) => `${t.date}|${t.amount}|${alnum(merchantKey(t.description))}`;
    const beforeKeys = new Set(before.map(keyOf));
    const doubleImported = after.filter((t) => beforeKeys.has(keyOf(t))).length;
    const unresolved = rows.filter((r) => r.accountId === a.id && r.status === 'unresolved_duplicate').length;
    return { accountRef: `tally-account:${a.id}`, name: a.name, owner: ownerOf(a).owner, relinked, relinkedAt: relinkAt,
      newestTransaction: newestTxn, newestBeforeReconnect: newestBefore, oldestBackfilled,
      gapDays: newestBefore && oldestBackfilled ? Math.max(0, daysBetween(newestBefore, oldestBackfilled) - 1) : null,
      backfilledRows: after.length, doubleImported, duplicateRate: after.length ? Math.round((doubleImported / after.length) * 1000) / 10 : null, unresolvedPending: unresolved };
  });
  const names = accounts.filter((a) => a.active !== 0).map((a) => up(a.name));
  const duplicateAccounts = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  const known = new Set(knownAccounts.map((k) => k.id));
  const newAccounts = known.size ? accounts.filter((a) => !known.has(a.id)).map((a) => a.name) : [];
  const lost = knownAccounts.filter((k) => !accounts.some((a) => a.id === k.id)).map((k) => k.name);
  return { latestConnectionAt: latestConnAt, accounts: per, duplicateAccounts, newAccounts, lostAccounts: lost,
    identityOk: !duplicateAccounts.length && !lost.length && !newAccounts.length,
    anyRelinked: per.some((p) => p.relinked) };
}

module.exports = {
  DOMAINS, DOMAIN_LABEL, CATEGORY_DOMAIN, T, COUNTS, OPERATIONAL,
  merchantKey, purchaseToken, recurKey, hintFor, ownerOf, transactionType, looksPending, reconcilePending, ruleMatches, resolveDomain,
  normalise, spendEffect, moneyOutEffect, accountCoverage, monthCoverage, detectRecurring, unusualSpend, duplicateCharges,
  categoryQuality, monthlySummary, monthOnMonth, rollingWindow, balances, forwardCashflow, pressure, upcomingMoneyOut,
  feedHealth, reconnectReport, daysBetween, addDays, monthEnd, prevMonth, pounds, shortHash,
};
