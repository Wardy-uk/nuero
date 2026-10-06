'use strict';

/**
 * Safe self-healing (Build 15H–N, 6 Oct 2026).
 *
 * A source-blind investigation that has diagnosed its cause with HIGH
 * confidence may run ONE named, typed, low-risk fix by itself, then has to
 * PROVE the source recovered. Everything else stays a recommendation.
 *
 *   investigation (prepared, high confidence)
 *     → eligibility (allowlist + authority matrix + evidence + still failing)
 *     → ledger row written BEFORE the call
 *     → execute the typed op
 *     → wait the op's observation window
 *     → verify from SourceHealth AND the blindness fold: recovered | failed | uncertain
 *
 * ── What may run ────────────────────────────────────────────────────────────
 * `ALLOWLIST` is the whole list of fix KINDS and `OPS` the whole list of
 * per-source operations. An op is a named function with no arguments —
 * there is no command string, no service name and no shell anywhere here.
 * Authority is READ from the matrix (never restated): A1/A2 may run; A3 only
 * if its capability row says `selfHeal: true`; A4 never.
 *
 * ── What "fixed" means ──────────────────────────────────────────────────────
 * Never "the op returned ok". Recovered = SourceHealth recorded a SUCCESS after
 * the attempt started, the source is healthy, AND the blindness finding for
 * the outage has closed — two independent folds of the log agreeing. Command
 * success with no recovery is `failed`; an unreadable verdict past the window
 * is `uncertain`. The words used everywhere are "retried", "recovered after the
 * retry", "could not verify" — never "fixed" without that proof.
 *
 * ── No loops ────────────────────────────────────────────────────────────────
 * One attempt per fix kind per OUTAGE (the finding episode): UNIQUE(outage_key,
 * fix_kind) at the database. A failed attempt hands the investigation back to
 * Nick as a manual step; the attention policy decides whether to say so.
 */

const db = require('../db/database');

const MINUTE = 60 * 1000;
const TYPE = 'source_blindness';
const TERMINAL = ['recovered', 'failed', 'uncertain', 'cancelled'];

const ALLOWLIST = Object.freeze({
  'retry-sync': Object.freeze({
    capability: 'source.retry-sync',
    hypotheses: Object.freeze(['upstream-unavailable', 'sync-job-failed']),
    reversible: true,
    rollback: Object.freeze({
      method: 'nothing to roll back: it re-runs the source\'s own read-only sync once, which changes nothing its next scheduled run would not',
      automatic: false,
      harmfulSideEffect: 'two overlapping syncs (prevented: the runtime in-flight guard) or hammering a provider that is down (bounded: one attempt per outage)',
    }),
  }),
});

// Per-source operations for each allowed kind. Named, typed, no arguments.
const OPS = Object.freeze({
  'retry-sync': Object.freeze({
    'microsoft.calendar': Object.freeze({ name: 'run-calendar-sync', windowMs: 10 * MINUTE, timeoutMs: 5 * MINUTE,
      run: () => require('./runtime-jobs').runNow('calendar-sync') }),
    'homeassistant.presence': Object.freeze({ name: 'run-presence-poll', windowMs: 5 * MINUTE, timeoutMs: 1 * MINUTE,
      run: () => require('./ha-presence').poll().then((r) => ({ ok: !!(r && r.ok), result: r, error: r && r.error })) }),
    'neuro.selftest': Object.freeze({ name: 'run-selftest-sync', windowMs: 5 * MINUTE, timeoutMs: 1 * MINUTE,
      run: () => require('./runtime-jobs').runNow('selftest-sync') }),
  }),
});

function _iso(ms) { return new Date(ms).toISOString(); }
function _ms(iso) { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; }
function _json(s, f) { try { return s ? JSON.parse(s) : f; } catch { return f; } }

function enabled() {
  try { return require('./feature-flags').isEnabled('self_heal'); } catch { return false; }
}

/** Pure. Is this op on the list for this source? */
function opFor(kind, sourceId) {
  const byKind = OPS[kind];
  return byKind && Object.prototype.hasOwnProperty.call(byKind, sourceId) ? byKind[sourceId] : null;
}

/**
 * Pure. May this investigation's prepared fix run by itself, now?
 * Every check is listed, passed or not, so a refusal says which rule held it.
 */
function assess({ isEnabled, inv, sourceId, sourceRow, findingActive, existingAttempt, matrix }) {
  const checks = [];
  const fail = (rule, why) => { checks.push({ rule, ok: false, why }); return { eligible: false, rule, why, checks }; };
  const pass = (rule) => checks.push({ rule, ok: true });

  if (!isEnabled) return fail('switched-on', 'self-healing is switched off (Settings → Switches)');
  pass('switched-on');
  const fix = inv && inv.preparedAction;
  if (!fix || fix.status !== 'prepared') return fail('prepared-fix', 'no prepared fix');
  pass('prepared-fix');
  const rule = ALLOWLIST[fix.kind];
  if (!rule) return fail('allowlist', `${fix.kind} is not on the self-heal allowlist`);
  pass('allowlist');
  const cap = matrix && matrix.CAPABILITIES[rule.capability];
  if (!cap) return fail('authority', `${rule.capability} is not in the authority matrix`);
  if (cap.authority === 'A4') return fail('authority', 'A4 never executes automatically');
  if (cap.authority === 'A3' && cap.selfHeal !== true) return fail('authority', 'A3 needs an explicit self-heal pre-authorisation');
  if (!['A1', 'A2', 'A3'].includes(cap.authority)) return fail('authority', `authority ${cap.authority} cannot self-heal`);
  if (cap.approval !== 'none') return fail('authority', 'the capability requires approval');
  pass('authority');
  const op = opFor(fix.kind, sourceId);
  if (!op) return fail('typed-op', `no ${fix.kind} operation exists for ${sourceId}`);
  pass('typed-op');
  const hyps = inv.hypotheses || [];
  const top = hyps[0];
  if (!top || top.level !== 'high') return fail('confidence', `top hypothesis is ${top ? top.level : 'missing'} confidence — recommend only`);
  if ((top.contradictingEvidenceRefs || []).length) return fail('confidence', 'evidence contradicts the diagnosis');
  if (!rule.hypotheses.includes(top.type)) return fail('confidence', `${fix.kind} does not answer "${top.type}"`);
  if ((inv.evidence || []).some((e) => e.status === 'unavailable' || e.status === 'refused')) return fail('evidence', 'part of the evidence could not be read');
  pass('confidence');
  if (!findingActive) return fail('still-failing', 'the outage has already closed');
  if (!sourceRow) return fail('still-failing', 'source health unreadable — not acting blind');
  if (!(sourceRow.state === 'failing' || sourceRow.freshness === 'stale')) return fail('still-failing', `source is ${sourceRow.state}/${sourceRow.freshness} — it recovered before NEURO acted`);
  pass('still-failing');
  if (existingAttempt) return fail('one-per-outage', `already attempted for this outage (${existingAttempt.status})`);
  pass('one-per-outage');
  return { eligible: true, rule: null, why: null, checks, op, capability: rule.capability, authority: cap.authority };
}

/**
 * Pure. What does the evidence say about an executed attempt?
 * @returns {{ outcome: 'pending'|'recovered'|'failed'|'uncertain', why, basis }}
 */
function judge({ attempt, sourceRow, findingActive, nowMs }) {
  const startMs = _ms(attempt.started_at || attempt.requested_at);
  const deadline = _ms(attempt.verify_by);
  const past = deadline != null && nowMs >= deadline;
  const successAfter = !!(sourceRow && _ms(sourceRow.last_success_at) != null && startMs != null && _ms(sourceRow.last_success_at) > startMs);
  const healthy = !!(sourceRow && sourceRow.state === 'healthy');
  const basis = {
    lastSuccessAt: sourceRow ? sourceRow.last_success_at || null : null,
    sourceState: sourceRow ? sourceRow.state : null,
    freshness: sourceRow ? sourceRow.freshness : null,
    findingActive: findingActive === null ? null : !!findingActive,
    opOutcome: attempt.op_outcome || null,
  };
  if (successAfter && healthy && findingActive === false) {
    return { outcome: 'recovered', why: 'a new successful delivery was recorded after the retry, and the blind finding closed', basis };
  }
  if (!sourceRow || findingActive === null) {
    return past ? { outcome: 'uncertain', why: 'could not read source health or the finding to verify', basis } : { outcome: 'pending', why: 'waiting to read', basis };
  }
  if (!successAfter && attempt.op_outcome === 'error') {
    return { outcome: 'failed', why: 'the retry itself failed and no new delivery followed', basis };
  }
  if (!past) return { outcome: 'pending', why: 'inside the observation window', basis };
  if (successAfter && healthy) return { outcome: 'uncertain', why: 'source health recovered but the blind finding is still open — the two disagree', basis };
  return { outcome: 'failed', why: attempt.op_outcome === 'ok'
    ? 'the retry ran and reported success, but no new delivery was recorded — that is not recovery'
    : 'no new delivery was recorded inside the observation window', basis };
}

// ── store ───────────────────────────────────────────────────────────────────

function _shape(r) {
  if (!r) return null;
  return {
    attemptId: r.attempt_id, outageKey: r.outage_key, fixKind: r.fix_kind, op: r.op, investigationId: r.investigation_id,
    sourceId: r.source_id, authority: r.authority, capability: r.capability, hypothesis: r.hypothesis, confidence: r.confidence,
    status: r.status, requestedAt: r.requested_at, startedAt: r.started_at, executedAt: r.executed_at,
    opOutcome: r.op_outcome, opDetail: r.op_detail, verifyBy: r.verify_by, verifiedAt: r.verified_at,
    verification: _json(r.verification_json, null), reason: r.reason,
  };
}
function get(id) { return _shape(db.get('SELECT * FROM self_heal_attempts WHERE attempt_id = ?', [id])); }
function list({ limit = 100 } = {}) { return db.all('SELECT * FROM self_heal_attempts ORDER BY requested_at DESC LIMIT ?', [limit]).map(_shape); }
function forOutage(outageKey, fixKind) {
  return _shape(db.get('SELECT * FROM self_heal_attempts WHERE outage_key = ? AND fix_kind = ?', [outageKey, fixKind]));
}

function _defaultDeps() {
  return {
    sourceRow: (id) => db.get('SELECT * FROM source_health WHERE source_id = ?', [id]) || null,
    // true / false / null (unreadable)
    findingActive: (findingId) => {
      try {
        const r = db.get('SELECT status FROM source_blind_findings WHERE finding_id = ?', [findingId]);
        return r ? r.status === 'active' : false;
      } catch { return null; }
    },
    ops: null,
    enabled,
    bootId: () => { try { return require('./runtime-jobs')._bootId(); } catch { return 'unknown'; } },
  };
}

function _op(kind, sourceId, deps) {
  if (deps.ops && deps.ops[sourceId]) return { ...opFor(kind, sourceId), run: deps.ops[sourceId] };
  return opFor(kind, sourceId);
}

function _settle(attempt, outcome, why, basis, nowMs, inv, deps) {
  const at = _iso(nowMs);
  db.run(`UPDATE self_heal_attempts SET status = ?, verified_at = ?, verification_json = ?, reason = ? WHERE attempt_id = ? AND status = 'verifying'`,
    [outcome, at, JSON.stringify({ why, basis }), why, attempt.attemptId]);
  const invs = require('./investigations');
  const live = invs.get(attempt.investigationId);
  if (!live) return;
  const fix = live.preparedAction || {};
  if (outcome === 'recovered') {
    invs.applySelfHeal(live.id, {
      fields: { prepared_action_json: JSON.stringify({ ...fix, status: 'verified', executes: true, attemptId: attempt.attemptId }) },
      transition: 'self-heal-recovered', to: live.state, detail: { attemptId: attempt.attemptId, why, basis }, nowMs,
    });
  } else {
    // 15M: a failed or unverifiable attempt stops automatic action and hands
    // the investigation to Nick as a manual step. The attention policy (never
    // this file) decides whether he is told.
    const manual = { ...fix, status: 'prepared', executes: false, requiresHuman: true, autoAttempt: { attemptId: attempt.attemptId, outcome } };
    invs.applySelfHeal(live.id, {
      fields: { state: 'prepared', decision: 'PREPARE', stop_reason: `self-heal-${outcome}`, prepared_action_json: JSON.stringify(manual) },
      transition: `self-heal-${outcome}`, to: 'prepared', detail: { attemptId: attempt.attemptId, why, basis }, nowMs,
    });
  }
}

/** Verify every attempt waiting on evidence. Restart-safe: reads only the ledger. */
function verifyPending({ nowMs, deps }) {
  const out = { recovered: 0, failed: 0, uncertain: 0, pending: 0, recoveredStuck: 0 };
  // A crash between the ledger write and the op's answer leaves requested /
  // executing. The op is a read-only re-run, but it is NOT repeated: its
  // outcome is unknown, so the source is verified instead.
  for (const r of db.all(`SELECT * FROM self_heal_attempts WHERE status IN ('requested','executing')`)) {
    const a = _shape(r);
    const op = opFor(a.fixKind, a.sourceId);
    const stuckAfter = (_ms(a.startedAt || a.requestedAt) || 0) + ((op && op.timeoutMs) || 5 * MINUTE) + MINUTE;
    if (r.boot_id !== deps.bootId() || nowMs > stuckAfter) {
      db.run(`UPDATE self_heal_attempts SET status = 'verifying', op_outcome = 'unknown', op_detail = ?, verify_by = ? WHERE attempt_id = ? AND status IN ('requested','executing')`,
        ['interrupted before the op answered (restart or timeout) — not repeated; verifying instead', _iso(nowMs + ((op && op.windowMs) || 5 * MINUTE)), a.attemptId]);
      out.recoveredStuck += 1;
    }
  }
  for (const r of db.all(`SELECT * FROM self_heal_attempts WHERE status = 'verifying'`)) {
    const a = _shape(r);
    let row = null; let active = null;
    try { row = deps.sourceRow(a.sourceId); } catch { row = null; }
    try { active = deps.findingActive(a.outageKey); } catch { active = null; }
    const j = judge({ attempt: r, sourceRow: row, findingActive: active, nowMs });
    if (j.outcome === 'pending') { out.pending += 1; continue; }
    _settle(a, j.outcome, j.why, j.basis, nowMs, null, deps);
    out[j.outcome] += 1;
  }
  return out;
}

/** Consider every open investigation with a prepared fix; run what is eligible. */
async function considerAll({ nowMs, deps, matrix }) {
  const invs = require('./investigations');
  const out = { executed: 0, cancelled: 0, refused: [] };
  for (const inv of invs.list({ open: true, limit: 200 })) {
    if (inv.type !== TYPE) continue;
    const fix = inv.preparedAction;
    if (!fix || fix.status !== 'prepared' || !ALLOWLIST[fix.kind]) continue;
    const sourceId = String(inv.subjectRef || '').replace(/^source:/, '');
    const outageKey = inv.triggerRef;
    const existing = forOutage(outageKey, fix.kind);
    let row = null; let active = null;
    try { row = deps.sourceRow(sourceId); } catch { row = null; }
    try { active = deps.findingActive(outageKey); } catch { active = null; }
    const a = assess({ isEnabled: deps.enabled(), inv, sourceId, sourceRow: row, findingActive: active === true, existingAttempt: existing, matrix });
    if (!a.eligible) {
      out.refused.push({ investigationId: inv.id, rule: a.rule, why: a.why });
      // 15L: a recovery BEFORE the action cancels it, and that is recorded once.
      if (a.rule === 'still-failing' && !existing && row && active !== null) {
        const id = `heal:${outageKey}:${fix.kind}`;
        const at = _iso(nowMs);
        db.run(`INSERT OR IGNORE INTO self_heal_attempts (attempt_id, outage_key, fix_kind, op, investigation_id, source_id, authority, capability,
                  hypothesis, confidence, status, boot_id, requested_at, reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cancelled', ?, ?, ?)`,
          [id, outageKey, fix.kind, (opFor(fix.kind, sourceId) || {}).name || 'none', inv.id, sourceId,
            (matrix.CAPABILITIES[ALLOWLIST[fix.kind].capability] || {}).authority || 'A1', ALLOWLIST[fix.kind].capability,
            (inv.hypotheses[0] || {}).type || null, (inv.hypotheses[0] || {}).confidence || null, deps.bootId(), at, a.why]);
        out.cancelled += 1;
      }
      continue;
    }
    const op = _op(fix.kind, sourceId, deps);
    const id = `heal:${outageKey}:${fix.kind}`;
    const at = _iso(nowMs);
    // Ledger FIRST. The UNIQUE(outage_key, fix_kind) index is the no-loop guarantee.
    const ins = db.run(`INSERT OR IGNORE INTO self_heal_attempts (attempt_id, outage_key, fix_kind, op, investigation_id, source_id, authority, capability,
              hypothesis, confidence, status, boot_id, requested_at, started_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'executing', ?, ?, ?)`,
      [id, outageKey, fix.kind, op.name, inv.id, sourceId, a.authority, a.capability, inv.hypotheses[0].type, inv.hypotheses[0].confidence, deps.bootId(), at, at]);
    if (!ins || ins.changes === 0) { out.refused.push({ investigationId: inv.id, rule: 'one-per-outage', why: 'claimed by another pass' }); continue; }
    invs.applySelfHeal(inv.id, {
      fields: { state: 'fixing', decision: 'EXECUTE_SAFE_FIX', stop_reason: 'self-heal-executing',
        prepared_action_json: JSON.stringify({ ...fix, status: 'executing', executes: true, attemptId: id }) },
      transition: 'self-heal-executing', to: 'fixing', detail: { attemptId: id, op: op.name, authority: a.authority }, nowMs,
    });
    let opOutcome = 'error'; let detail = null;
    let timer = null;
    try {
      const r = await Promise.race([
        Promise.resolve().then(() => op.run()),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('op timeout')), op.timeoutMs); }),
      ]).finally(() => clearTimeout(timer));
      const inner = r && r.result;
      const ok = !!(r && r.ok) && !(inner && inner.ok === false);
      opOutcome = ok ? 'ok' : 'error';
      detail = ok ? 'the operation reported success' : String((r && (r.error || (inner && inner.error))) || 'the operation reported failure').slice(0, 300);
    } catch (e) {
      opOutcome = 'error'; detail = String(e.message || e).slice(0, 300);
    }
    const done = deps.clock ? deps.clock() : Date.now();
    db.run(`UPDATE self_heal_attempts SET status = 'verifying', executed_at = ?, op_outcome = ?, op_detail = ?, verify_by = ? WHERE attempt_id = ? AND status = 'executing'`,
      [_iso(done), opOutcome, detail, _iso(done + op.windowMs), id]);
    invs.applySelfHeal(inv.id, {
      fields: { prepared_action_json: JSON.stringify({ ...fix, status: 'verifying', executes: true, attemptId: id }) },
      transition: 'self-heal-executed', to: 'fixing', detail: { attemptId: id, opOutcome, windowMs: op.windowMs }, nowMs: done,
    });
    out.executed += 1;
  }
  return out;
}

/** One pass: verify first (a restart resumes here), then consider new fixes. */
async function pass({ now = Date.now(), deps = {}, matrix = require('./authority-matrix') } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const d = { ..._defaultDeps(), ...deps };
  const verified = verifyPending({ nowMs, deps: d });
  const considered = await considerAll({ nowMs, deps: d, matrix });
  return { verified, considered };
}

module.exports = { ALLOWLIST, OPS, TERMINAL, enabled, opFor, assess, judge, pass, verifyPending, get, list, forOutage };
