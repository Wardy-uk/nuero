'use strict';

/**
 * Build 21P–W — Tally as a finance SOURCE, consumed for the vehicle slice only.
 *
 * Tally (Nick's own finance app, pi-dev) is the source of truth for every
 * transaction. NEURO READS it — `sqlite3 -readonly` over ssh, one fixed query,
 * no write path exists in this module — and keeps only what might be motoring.
 * Household spending is never copied here.
 *
 * What the audit found (8 Oct 2026) and this module is built around:
 *   • transactions.id is Tally's own autoincrement — stable locally, no bank id.
 *   • amount is signed PENCE, negative = spend. No currency column (GBP).
 *   • merchant is NULL on every row; description is raw bank text
 *     ("1717 03JUN26 ZILCH SHELL GB GB"), so merchants are normalised here.
 *   • No vehicle, litres or mileage anywhere — MPG cannot come from Tally.
 *   • Categories are flat and unreliable in both directions ("CRUMBS 2GO" in
 *     Fuel; petrol stations uncategorised or in Groceries), so a category is
 *     EVIDENCE for a suggestion, never a classification on its own.
 *   • A pending and a settled copy of one purchase can both exist
 *     (dedupe hash includes the description) — folded here, both shown.
 *   • Much motoring goes through Zilch (pay-later): the purchase row counts,
 *     the instalments are financing and are never vehicle spend.
 *
 * Classification order (21S): an explicit Tally vehicle category/tag (Tally
 * has none — reported, not invented) → a confirmed reusable rule → Nick's
 * one-off confirmation. A strong merchant/category match is only ever a
 * SUGGESTION. A machine never confirms (authority matrix refuses the routes).
 */

const crypto = require('crypto');

const SPEND_TYPES = Object.freeze(['fuel', 'insurance', 'tax', 'service', 'repair', 'tyres', 'warranty', 'breakdown_cover', 'mot', 'parking', 'other']);
// Rolling ownership cost (21AA) counts these. Parking/tolls only if Nick ever
// chooses; finance/loan payments are not a spend type at all.
const OWNERSHIP_TYPES = Object.freeze(['fuel', 'insurance', 'tax', 'service', 'repair', 'tyres', 'warranty', 'breakdown_cover', 'mot', 'other']);
const EXPECTED_COLUMNS = Object.freeze(['id', 'account_id', 'date', 'amount', 'description', 'category_id', 'is_transfer']);
const MATCH_KINDS = Object.freeze(['merchant', 'category', 'merchant+category']);

// Word-bounded merchant evidence. Each entry: token, proposed type, why.
// Deliberately NOT here: supermarkets (MORRISONS/ASDA/TESCO) on their own —
// a supermarket is groceries until its petrol-station marker says otherwise.
const MERCHANT_HINTS = Object.freeze([
  [/\b(SHELL|ESSO|TEXACO|GULF|JET|BP|MURCO|VALERO)\b/, 'fuel', 'a fuel brand'],
  [/\bPFS\b/, 'fuel', 'a petrol filling station (PFS)'],
  [/\b(PETROL|MOTOR FUEL|FUEL)\b/, 'fuel', 'says petrol/fuel'],
  [/\bS\/?STN\b|\bSERVICE STATION\b/, 'fuel', 'a service station'],
  [/\b(RAC|AA BREAKDOWN|GREEN FLAG)\b/, 'breakdown_cover', 'a breakdown provider'],
  [/\bDVLA\b|\bVEHICLE TAX\b/, 'tax', 'DVLA'],
  [/\bMOT\b/, 'mot', 'says MOT'],
  [/\b(KWIK ?FIT|NATIONAL TYRES|ATS EUROMASTER|BLACK ?CIRCLES|TYRE)/, 'tyres', 'a tyre fitter'],
  [/\b(HALFORDS|AUTOCENTRE|AUTO CENTRE|GARAGE|RENAULT)\b/, 'other', 'a motoring retailer or garage'],
  [/\b(CAR PARK|PARKING|NCP|RINGGO|PAYBYPHONE)\b/, 'parking', 'parking'],
]);
const MOTORING_CATEGORIES = Object.freeze({ fuel: 'fuel', transport: 'other' });
const FINANCING_RE = /\b(INSTALMENT|INSTALLMENT|REPAYMENT)\b/;

// ── pure ─────────────────────────────────────────────────────────────────────

/**
 * Raw bank description → a merchant key and the channel it went through. PURE.
 * "1717 03JUN26 ZILCH SHELL GB GB" → { merchantKey: 'SHELL', channel: 'zilch' }.
 * Only the noise the audit actually saw is stripped: leading card digits, a
 * DDMMMYY date token, a trailing country code, the ZILCH channel prefix.
 */
function normaliseMerchant(description) {
  let s = String(description || '').toUpperCase().replace(/\s+/g, ' ').trim();
  let channel = null;
  s = s.replace(/^\d{4} /, '');
  s = s.replace(/^\d{2}[A-Z]{3}\d{2} /, '');
  if (/^ZILCH /.test(s)) { channel = 'zilch'; s = s.slice(6); }
  s = s.replace(/( GB)+$/, '').trim();
  return { merchantKey: s || null, channel };
}

/**
 * Might this transaction be motoring? PURE. Returns null when nothing points
 * that way. Confidence is never 'high' — that is reserved for what Nick said.
 */
function candidateFor(row) {
  if (!row || row.is_transfer) return null;
  if (!(Number(row.amount) < 0)) return null;                 // spend only; refunds are judged with their purchase
  const { merchantKey, channel } = normaliseMerchant(row.description);
  if (FINANCING_RE.test(merchantKey || '')) return null;      // pay-later instalments are financing
  const reasons = [];
  let type = null;
  for (const [re, t, why] of MERCHANT_HINTS) {
    if (re.test(merchantKey || '')) { reasons.push(`the description names ${why}`); type = type || t; }
  }
  const cat = String(row.category_name || '').trim().toLowerCase();
  const catType = MOTORING_CATEGORIES[cat] || null;
  if (catType) { reasons.push(`Tally files it under "${row.category_name}"`); type = type || catType; }
  if (!reasons.length) return null;
  const both = catType && reasons.length > 1;
  return {
    proposedType: type,
    confidence: both ? 'medium' : 'low',
    reasons,
    note: channel === 'zilch' ? 'paid through Zilch (pay-later) — this row is the purchase; instalments are never counted' : null,
  };
}

/**
 * Pending + settled copies of one purchase. PURE. Same account, date, amount
 * and merchant key = one purchase. Returns Map txnId → representative txnId.
 * The lowest id represents the group, so the answer is stable.
 */
function duplicateMap(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = [r.account_name, r.txn_date, r.amount_pence, r.merchant_key].join('|');
    groups.set(key, [...(groups.get(key) || []), r.source_txn_id]);
  }
  const rep = new Map();
  for (const ids of groups.values()) {
    const lo = Math.min(...ids);
    for (const id of ids) rep.set(id, lo);
  }
  return rep;
}

/** Does a confirmed rule match this read-model row? PURE. Exact keys only. */
function ruleMatches(rule, row) {
  if (!rule || !rule.active) return false;
  const mOk = rule.merchant_key ? row.merchant_key === rule.merchant_key : true;
  const cOk = rule.category_name ? String(row.category_name || '').toLowerCase() === String(rule.category_name).toLowerCase() : true;
  if (rule.match_kind === 'merchant') return !!rule.merchant_key && mOk;
  if (rule.match_kind === 'category') return !!rule.category_name && cOk;
  if (rule.match_kind === 'merchant+category') return !!rule.merchant_key && !!rule.category_name && mOk && cOk;
  return false;
}

function validateRule({ matchKind, merchantKey, categoryName, spendType } = {}) {
  if (!MATCH_KINDS.includes(matchKind)) return `matchKind must be one of ${MATCH_KINDS.join(', ')}`;
  if (!SPEND_TYPES.includes(spendType)) return `spendType must be one of ${SPEND_TYPES.join(', ')}`;
  if (matchKind !== 'category' && !(typeof merchantKey === 'string' && merchantKey.trim().length >= 2)) return 'a merchant rule needs the exact merchant key';
  if (matchKind !== 'merchant' && !(typeof categoryName === 'string' && categoryName.trim())) return 'a category rule needs the Tally category name';
  return null;
}

// ── the Tally reader (read-only, fixed SQL) ──────────────────────────────────

function config() {
  return {
    enabled: String(process.env.TALLY_READ || 'on').toLowerCase() !== 'off',
    sshTarget: process.env.TALLY_SSH_TARGET || 'nickw@100.69.158.50',
    dbPath: process.env.TALLY_DB_PATH || '/home/nickw/tally/tally.db',
  };
}

const READ_SQL = `SELECT t.id AS id, t.date AS date, t.amount AS amount, t.description AS description,
  t.is_transfer AS is_transfer, c.name AS category_name, a.name AS account_name, u.display_name AS account_owner
  FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN accounts a ON a.id = t.account_id
  LEFT JOIN users u ON u.id = a.owner_user_id ORDER BY t.id`;
const SCHEMA_SQL = 'PRAGMA table_info(transactions)';

function _runSql(sql, { execFile = require('child_process').execFile } = {}) {
  const c = config();
  // The SQL is a module constant; nothing from a request reaches this string.
  const remote = `sqlite3 -readonly -json ${JSON.stringify(c.dbPath)} ${JSON.stringify(sql.replace(/\s+/g, ' '))}`;
  return new Promise((resolve, reject) => {
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', c.sshTarget, remote], { timeout: 60000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`Tally could not be read: ${err.message.split('\n')[0]}`));
      const text = String(stdout || '').trim();
      try { resolve(text ? JSON.parse(text) : []); } catch { reject(new Error('Tally answered something that is not JSON')); }
    });
  });
}

/** Read every Tally transaction (in memory only), after checking the schema. */
async function readTally(deps = {}) {
  const cols = await _runSql(SCHEMA_SQL, deps);
  const names = new Set(cols.map((c) => c.name));
  const missing = EXPECTED_COLUMNS.filter((c) => !names.has(c));
  if (missing.length) throw new Error(`Tally's transactions table changed (missing ${missing.join(', ')}) — not read`);
  return _runSql(READ_SQL, deps);
}

// ── store ────────────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }
function _log(kind, detail, { subjectId = 'tally', actor = 'nick', now = Date.now(), dedupeKey } = {}) {
  return require('./personal-obligations').logEvent(kind, { subjectId, actor, detail, dedupeKey: dedupeKey || `${kind}:${subjectId}:${now}`, now });
}
function _state() { try { return JSON.parse(_db().getState('tally_vehicle_sync') || 'null'); } catch { return null; } }
function _setState(s) { _db().setState('tally_vehicle_sync', JSON.stringify(s)); }

function rules({ activeOnly = true } = {}) {
  return _db().all(`SELECT * FROM vehicle_spend_rules ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY confirmed_at`);
}

/**
 * One sync pass. Reads Tally, keeps only candidates and rows a confirmed rule
 * matches, applies rules to rows Nick has not decided, marks rows Tally no
 * longer lists. Never writes to Tally. `reader` is injectable for tests.
 */
async function sync({ now = Date.now(), reader = null, deps = {} } = {}) {
  const c = config();
  const iso = new Date(now).toISOString();
  if (!c.enabled && !reader) return { ok: true, skipped: true, reason: 'TALLY_READ=off' };
  let rows;
  try { rows = await (reader ? reader() : readTally(deps)); } catch (e) {
    const prev = _state() || {};
    _setState({ ...prev, lastAttemptAt: iso, lastOk: false, error: e.message });
    return { ok: false, error: e.message };
  }
  const db = _db();
  const active = rules();
  const seen = new Set();
  let kept = 0;
  let ruled = 0;
  let maxDate = null;
  let minDate = null;
  for (const r of rows) {
    if (!maxDate || r.date > maxDate) maxDate = r.date;
    if (!minDate || r.date < minDate) minDate = r.date;
    const { merchantKey, channel } = normaliseMerchant(r.description);
    const shaped = { ...r, merchant_key: merchantKey };
    const cand = candidateFor(r);
    const ruleHit = !r.is_transfer && Number(r.amount) < 0 && !FINANCING_RE.test(merchantKey || '') ? active.find((x) => ruleMatches(x, shaped)) : null;
    if (!cand && !ruleHit) continue;
    seen.add(r.id);
    kept++;
    db.run(`INSERT INTO tally_vehicle_txns (source_txn_id, txn_date, amount_pence, description, merchant_key, channel, category_name, account_name, account_owner, candidate_json, first_seen_at, last_seen_at, in_source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT(source_txn_id) DO UPDATE SET txn_date = excluded.txn_date, amount_pence = excluded.amount_pence, description = excluded.description,
              merchant_key = excluded.merchant_key, channel = excluded.channel, category_name = excluded.category_name, account_name = excluded.account_name,
              account_owner = excluded.account_owner, candidate_json = excluded.candidate_json, last_seen_at = excluded.last_seen_at, in_source = 1`,
    [r.id, r.date, Number(r.amount), String(r.description || ''), merchantKey, channel, r.category_name || null, r.account_name || null, r.account_owner || null,
      cand ? JSON.stringify(cand) : null, iso, iso]);
    if (ruleHit && !db.get('SELECT 1 FROM vehicle_spend_decisions WHERE source_txn_id = ?', [r.id])) {
      db.run(`INSERT INTO vehicle_spend_decisions (source_txn_id, decision, spend_type, vehicle_id, basis, rule_id, decided_by, decided_at)
              VALUES (?, 'vehicle', ?, ?, 'rule', ?, 'rule', ?)`, [r.id, ruleHit.spend_type, ruleHit.vehicle_id, ruleHit.rule_id, iso]);
      ruled++;
    }
  }
  // Rows Tally stopped listing: kept, marked — never counted as spend again.
  const held = db.all('SELECT source_txn_id FROM tally_vehicle_txns WHERE in_source = 1');
  let gone = 0;
  for (const h of held) if (!seen.has(h.source_txn_id)) { db.run('UPDATE tally_vehicle_txns SET in_source = 0 WHERE source_txn_id = ?', [h.source_txn_id]); gone++; }
  const prev = _state() || {};
  const next = { lastAttemptAt: iso, lastOkAt: iso, lastOk: true, error: null, scanned: rows.length, kept, dataFrom: minDate, dataThrough: maxDate, firstConnectedAt: prev.firstConnectedAt || iso };
  _setState(next);
  if (!prev.firstConnectedAt) _log('tally-connected', { scanned: rows.length, kept, dataThrough: maxDate }, { actor: 'neuro', now, dedupeKey: 'tally-connected' });
  return { ok: true, scanned: rows.length, kept, ruled, gone, dataThrough: maxDate };
}

/** Rows with their decision joined. Internal shape. */
function _rows() {
  return _db().all(`SELECT t.*, d.decision, d.spend_type, d.vehicle_id, d.basis, d.rule_id, d.decided_by, d.decided_at
                    FROM tally_vehicle_txns t LEFT JOIN vehicle_spend_decisions d ON d.source_txn_id = t.source_txn_id
                    ORDER BY t.txn_date DESC, t.source_txn_id DESC`);
}

function _shape(r, dup) {
  const rep = dup.get(r.source_txn_id);
  return {
    sourceTransactionId: r.source_txn_id,
    ref: `tally:${r.source_txn_id}`,
    date: r.txn_date,
    amountPence: r.amount_pence,
    currency: 'GBP',
    description: r.description,
    merchantKey: r.merchant_key,
    channel: r.channel,
    category: r.category_name,
    account: r.account_name,
    payer: r.account_owner || (r.account_name ? `${r.account_name} account` : null),
    inSource: !!r.in_source,
    duplicateOf: rep !== undefined && rep !== r.source_txn_id ? rep : null,
    candidate: r.candidate_json ? JSON.parse(r.candidate_json) : null,
    classification: r.decision ? { decision: r.decision, spendType: r.spend_type, vehicleId: r.vehicle_id, basis: r.basis, ruleId: r.rule_id, decidedBy: r.decided_by, decidedAt: r.decided_at } : null,
  };
}

/** Everything the review screen and the metrics need. */
function read() {
  const rows = _rows();
  const dup = duplicateMap(rows);
  const items = rows.map((r) => _shape(r, dup));
  const pending = items.filter((i) => i.inSource && !i.classification && !i.duplicateOf);
  return {
    state: _state(),
    explicitVehicleCategory: { found: false, why: 'Tally has no vehicle category or tag — only Fuel and Transport, which say "motoring", not "the Captur"' },
    pending,
    decided: items.filter((i) => i.classification),
    rules: rules({ activeOnly: false }).map((r) => ({ ...r, examples: r.examples_json ? JSON.parse(r.examples_json) : [], examples_json: undefined })),
    counts: { held: items.length, pending: pending.length, vehicle: items.filter((i) => i.classification && i.classification.decision === 'vehicle').length, duplicates: items.filter((i) => i.duplicateOf).length },
  };
}

/** Confirmed vehicle spend rows, duplicates folded, gone rows dropped. */
function vehicleSpend({ vehicleId } = {}) {
  const rows = _rows();
  const dup = duplicateMap(rows);
  return rows.map((r) => _shape(r, dup))
    .filter((i) => i.inSource && !i.duplicateOf && i.classification && i.classification.decision === 'vehicle' && (!vehicleId || i.classification.vehicleId === vehicleId));
}

/** Nick decides one transaction. `remember` makes it a reusable rule. */
function decide(txnId, { decision, spendType = null, vehicleId = null, remember = null } = {}, { now = Date.now(), actor = 'nick' } = {}) {
  const id = Number(txnId);
  const db = _db();
  const row = db.get('SELECT * FROM tally_vehicle_txns WHERE source_txn_id = ?', [id]);
  if (!row) return { ok: false, status: 404, error: 'NEURO holds no such Tally transaction' };
  if (!['vehicle', 'not-vehicle', 'unknown'].includes(decision)) return { ok: false, status: 400, error: 'decision must be vehicle, not-vehicle or unknown' };
  if (decision === 'vehicle') {
    if (!SPEND_TYPES.includes(spendType)) return { ok: false, status: 400, error: `spendType must be one of ${SPEND_TYPES.join(', ')}` };
    if (!require('./vehicle').getVehicle(vehicleId)) return { ok: false, status: 404, error: 'no such vehicle' };
  }
  let rule = null;
  if (remember) {
    if (decision !== 'vehicle') return { ok: false, status: 400, error: 'only a vehicle decision can be remembered as a rule' };
    const r = createRule({ matchKind: remember.matchKind, merchantKey: remember.matchKind === 'category' ? null : row.merchant_key,
      categoryName: remember.matchKind === 'merchant' ? null : row.category_name, spendType, vehicleId, scope: remember.scope || null,
      exampleTxnId: id }, { now, actor });
    if (!r.ok) return r;
    rule = r.rule;
  }
  const iso = new Date(now).toISOString();
  db.run(`INSERT INTO vehicle_spend_decisions (source_txn_id, decision, spend_type, vehicle_id, basis, rule_id, decided_by, decided_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_txn_id) DO UPDATE SET decision = excluded.decision, spend_type = excluded.spend_type, vehicle_id = excluded.vehicle_id,
            basis = excluded.basis, rule_id = excluded.rule_id, decided_by = excluded.decided_by, decided_at = excluded.decided_at`,
  [id, decision, decision === 'vehicle' ? spendType : null, decision === 'vehicle' ? vehicleId : null, rule ? 'rule' : 'confirmed-once', rule ? rule.rule_id : null, actor, iso]);
  return { ok: true, decision, rule };
}

/** Preview what a rule would match — the count Nick sees before confirming. */
function previewRule({ matchKind, merchantKey, categoryName } = {}) {
  const rule = { active: 1, match_kind: matchKind, merchant_key: merchantKey || null, category_name: categoryName || null };
  const rows = _rows().filter((r) => r.in_source && ruleMatches(rule, r));
  return { matches: rows.length, examples: rows.slice(0, 5).map((r) => ({ date: r.txn_date, amountPence: r.amount_pence, description: r.description })) };
}

function createRule({ matchKind, merchantKey = null, categoryName = null, spendType, vehicleId, scope = null, exampleTxnId = null } = {}, { now = Date.now(), actor = 'nick' } = {}) {
  const bad = validateRule({ matchKind, merchantKey, categoryName, spendType });
  if (bad) return { ok: false, status: 400, error: bad };
  if (!require('./vehicle').getVehicle(vehicleId)) return { ok: false, status: 404, error: 'no such vehicle' };
  const db = _db();
  const existing = db.all('SELECT * FROM vehicle_spend_rules WHERE active = 1').find((r) => r.match_kind === matchKind && (r.merchant_key || null) === (merchantKey || null) && String(r.category_name || '').toLowerCase() === String(categoryName || '').toLowerCase());
  if (existing) return { ok: true, already: true, rule: existing };
  const preview = previewRule({ matchKind, merchantKey, categoryName });
  const rule = {
    rule_id: `vsr:${crypto.randomUUID()}`, match_kind: matchKind, merchant_key: merchantKey, category_name: categoryName, spend_type: spendType,
    vehicle_id: vehicleId, scope, examples_json: JSON.stringify({ confirmedOn: exampleTxnId, matchedAtConfirmation: preview.matches, examples: preview.examples }),
    confirmed_by: actor, confirmed_at: new Date(now).toISOString(), active: 1,
  };
  db.run(`INSERT INTO vehicle_spend_rules (rule_id, match_kind, merchant_key, category_name, spend_type, vehicle_id, scope, examples_json, confirmed_by, confirmed_at, active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  [rule.rule_id, rule.match_kind, rule.merchant_key, rule.category_name, rule.spend_type, rule.vehicle_id, rule.scope, rule.examples_json, rule.confirmed_by, rule.confirmed_at]);
  // Apply it to rows Nick has not decided. Never overwrites one he has.
  let applied = 0;
  for (const r of _rows()) {
    if (r.decision || !r.in_source || r.amount_pence >= 0 || !ruleMatches(rule, r)) continue;
    db.run(`INSERT INTO vehicle_spend_decisions (source_txn_id, decision, spend_type, vehicle_id, basis, rule_id, decided_by, decided_at)
            VALUES (?, 'vehicle', ?, ?, 'rule', ?, 'rule', ?)`, [r.source_txn_id, spendType, vehicleId, rule.rule_id, rule.confirmed_at]);
    applied++;
  }
  _log('finance-mapping-confirmed', { matchKind, merchantKey, categoryName, spendType, vehicleId, matched: preview.matches, applied }, { subjectId: vehicleId, actor, now, dedupeKey: `finance-mapping-confirmed:${rule.rule_id}` });
  return { ok: true, rule, applied };
}

/** Retire a rule. Decisions it already made stay, attributed to it. */
function retireRule(ruleId, { now = Date.now() } = {}) {
  const r = _db().run('UPDATE vehicle_spend_rules SET active = 0 WHERE rule_id = ? AND active = 1', [ruleId]);
  return r && r.changes ? { ok: true } : { ok: false, status: 404, error: 'no such active rule' };
}

const TABLES = ['tally_vehicle_txns', 'vehicle_spend_decisions', 'vehicle_spend_rules'];

module.exports = {
  SPEND_TYPES, OWNERSHIP_TYPES, EXPECTED_COLUMNS, MATCH_KINDS, READ_SQL, TABLES,
  // pure
  normaliseMerchant, candidateFor, duplicateMap, ruleMatches, validateRule, config,
  // reader
  readTally, _runSql,
  // store
  sync, read, vehicleSpend, decide, previewRule, createRule, retireRule, rules,
};
