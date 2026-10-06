'use strict';

/**
 * Investigations — store and runner (Build 14G–R). The judgement is pure and
 * lives in source-blind-investigation.js; this file reads, records and stops.
 *
 * ── Trigger (14H) ───────────────────────────────────────────────────────────
 * Only a source-blind finding that the LIVE threshold already admits
 * (`sourceBlindness.liveEligible`: an EXPECTED source, failing, or stale ≥30h)
 * starts one. Normal quiet, optional and retired sources never do. One finding
 * episode → one investigation (dedupe_key UNIQUE); every later pass re-reads it
 * and re-gathers ONLY when the finding's condition changed.
 *
 * ── Stop conditions (14L) ───────────────────────────────────────────────────
 * Gathering stops once per trigger signature: cause identified, evidence
 * unavailable, budget exhausted, or nothing to say (inconclusive). The
 * investigation itself closes on recovery (resolved), on the finding no longer
 * being live (dismissed), or at expiry (inconclusive). No periodic re-runs.
 *
 * ── Attention (14Q) ─────────────────────────────────────────────────────────
 * This file never notifies. `attentionView()` says which investigations are
 * ELIGIBLE for Needs You; the attention policy alone decides what interrupts.
 */

const db = require('../db/database');
const sbi = require('./source-blind-investigation');
const matrix = require('./authority-matrix');

const TYPE = 'source_blindness';
// Build 15: `fixing` = a self-heal attempt is executing or being verified.
const OPEN_STATES = ['detected', 'gathering', 'hypothesised', 'monitoring', 'prepared', 'awaiting_approval', 'fixing'];
const TERMINAL_STATES = ['resolved', 'dismissed', 'inconclusive'];

function _iso(ms) { return new Date(ms).toISOString(); }
function _json(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }

function _event(id, at, transition, from, to, detail) {
  db.run(`INSERT INTO investigation_events (investigation_id, at, transition, from_state, to_state, detail_json) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, at, transition, from || null, to || null, detail ? JSON.stringify(detail) : null]);
}

function _shape(r) {
  if (!r) return null;
  return {
    id: r.id, type: r.type, state: r.state, subjectRef: r.subject_ref, triggerRef: r.trigger_ref,
    triggerSignature: r.trigger_signature, dedupeKey: r.dedupe_key, startedAt: r.started_at, updatedAt: r.updated_at,
    completedAt: r.completed_at, evidence: _json(r.evidence_json, []), hypotheses: _json(r.hypotheses_json, []),
    confidence: r.confidence, decision: r.decision, recommendedAction: r.recommended_action,
    preparedAction: _json(r.prepared_action_json, null), stopReason: r.stop_reason, budget: _json(r.budget_json, null),
    expiresAt: r.expires_at, version: r.version,
  };
}

function get(id) { return _shape(db.get('SELECT * FROM investigations WHERE id = ?', [id])); }
function byDedupe(key) { return _shape(db.get('SELECT * FROM investigations WHERE dedupe_key = ?', [key])); }
function list({ open = null, limit = 50 } = {}) {
  const rows = open === true
    ? db.all(`SELECT * FROM investigations WHERE state IN (${OPEN_STATES.map(() => '?').join(',')}) ORDER BY started_at DESC LIMIT ?`, [...OPEN_STATES, limit])
    : db.all('SELECT * FROM investigations ORDER BY started_at DESC LIMIT ?', [limit]);
  return rows.map(_shape);
}
function events(id) {
  return db.all('SELECT * FROM investigation_events WHERE investigation_id = ? ORDER BY id', [id])
    .map((e) => ({ at: e.at, transition: e.transition, from: e.from_state, to: e.to_state, detail: _json(e.detail_json, null) }));
}

function _update(id, fields) {
  const keys = Object.keys(fields);
  db.run(`UPDATE investigations SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => fields[k]), id]);
}

// ── evidence gathering (14I) ────────────────────────────────────────────────

/** The default, read-only probe implementations. Each reads NEURO's own state about sources. */
function defaultProbes() {
  const native = require('./native-sources');
  const healthRow = (id) => db.get('SELECT * FROM source_health WHERE source_id = ?', [id]) || null;
  return {
    'source-health': ({ sourceId }) => ({ row: healthRow(sourceId) }),
    'blind-state': ({ sourceId }) => ({ state: db.get('SELECT * FROM source_blind_state WHERE source_id = ?', [sourceId]) || null }),
    'app-siblings': ({ sourceId }) => ({ rows: sbi.appSiblings(sourceId, Object.keys(native.SOURCES))
      .filter((id) => native.describe(id).lifecycle !== 'retired').map((id) => ({ sourceId: id, row: healthRow(id) })) }),
    'group-peers': ({ sourceId }) => ({ rows: native.groupPeers(sourceId)
      .filter((id) => native.describe(id).lifecycle !== 'retired').map((id) => ({ sourceId: id, row: healthRow(id) })) }),
    'ingest-alive': () => {
      const pushIds = Object.keys(native.SOURCES).filter((id) => native.describe(id).push);
      const r = db.get(`SELECT MAX(last_success_at) AS t FROM source_health WHERE source_id IN (${pushIds.map(() => '?').join(',')})`, pushIds);
      return { newestPushAt: r ? r.t : null };
    },
    'event-spine': () => ({ consumers: require('./event-bus').getStatus().consumers }),
    'sync-job': ({ sourceId }) => {
      const name = sbi.SOURCE_JOB[sourceId];
      const st = require('./runtime-jobs').status();
      return { job: (st.jobs || []).find((j) => j.name === name) || null };
    },
    'process-uptime': () => ({ uptimeMs: Math.round(process.uptime() * 1000) }),
    // Build 15K: is the provider answering NOW? One bounded read, only for the
    // retryable pull sources (the plan never asks for any other).
    // Lives in provider-check.js: this module imports no network client.
    'provider-check': ({ sourceId }) => require('./provider-check').check(sourceId),
  };
}


function _withTimeout(p, ms) {
  let t;
  return Promise.race([Promise.resolve(p), new Promise((_, rej) => { t = setTimeout(() => rej(new Error('probe timeout')), ms); })])
    .finally(() => clearTimeout(t));
}

/**
 * Run a plan under the budget. Only probes named in sbi.PROBES may run, at most
 * MAX_PROBES, each ≤ PROBE_TIMEOUT_MS, all ≤ TOTAL_TIMEOUT_MS. A probe that
 * throws or times out is `unavailable` — never a guess.
 */
async function gather(sourceId, plannedProbes, { probes = defaultProbes(), clock = Date.now, budget = {} } = {}) {
  const maxProbes = budget.maxProbes || sbi.MAX_PROBES;
  const perProbe = budget.probeTimeoutMs || sbi.PROBE_TIMEOUT_MS;
  const total = budget.totalTimeoutMs || sbi.TOTAL_TIMEOUT_MS;
  const start = clock();
  const results = [];
  let calls = 0;
  let exhausted = false;
  for (const name of plannedProbes) {
    if (!sbi.PROBES.includes(name) || typeof probes[name] !== 'function') { results.push({ probe: name, status: 'refused' }); continue; }
    if (calls >= maxProbes || clock() - start >= total) { exhausted = true; results.push({ probe: name, status: 'skipped' }); continue; }
    calls += 1;
    try {
      const data = await _withTimeout(probes[name]({ sourceId }), Math.min(perProbe, Math.max(1, total - (clock() - start))));
      results.push({ probe: name, status: 'ok', data });
    } catch {
      results.push({ probe: name, status: 'unavailable' });
    }
  }
  return { results, calls, exhausted, elapsedMs: clock() - start, limits: { maxProbes, probeTimeoutMs: perProbe, totalTimeoutMs: total } };
}

// ── the pass ────────────────────────────────────────────────────────────────

function _signature(f) { return `${f.condition}`; }

async function _investigate(inv, finding, { nowMs, deps }) {
  const native = require('./native-sources');
  const d = native.describe(finding.source);
  const at = _iso(nowMs);
  _update(inv.id, { state: 'gathering', updated_at: at, trigger_signature: _signature(finding) });
  _event(inv.id, at, 'gathering', inv.state, 'gathering', { signature: _signature(finding) });

  const planned = sbi.plan(finding.source, native.describe);
  const g = await gather(finding.source, planned, { probes: deps.probes, clock: deps.clock, budget: deps.budget });
  const evidence = sbi.toEvidence(finding.source, finding, g.results, nowMs);
  _event(inv.id, _iso(nowMs), 'evidence', 'gathering', 'gathering', { refs: evidence.map((e) => ({ id: e.id, probe: e.probe, status: e.status, signal: e.signal })), calls: g.calls, exhausted: g.exhausted });

  const hypotheses = sbi.hypothesise(evidence, { push: !!d.push, lifecycle: d.lifecycle, findingActive: true });
  _event(inv.id, _iso(nowMs), 'hypothesised', 'gathering', 'hypothesised', { top: hypotheses[0].type, level: hypotheses[0].level });

  const evidenceAvailable = evidence.some((e) => e.status === 'ok');
  let decision = sbi.decide({ hypotheses, sourceId: finding.source, findingActive: true, evidenceAvailable });
  if (g.exhausted && decision.decision !== 'PREPARE') decision = { ...decision, stopReason: 'budget-exhausted' };

  const version = (inv.version || 1) + (inv.state === 'detected' ? 0 : 1);
  let prepared = null;
  let state = decision.state;
  if (decision.fixKind) {
    const p = sbi.prepareFix(decision.fixKind, { matrix, investigationId: inv.id, version });
    if (p.ok) { prepared = p.fix; state = p.state; } else { state = 'monitoring'; decision = { ...decision, stopReason: 'authority-exceeded' }; }
  }
  // A fix the new evidence replaced is superseded, never left looking current.
  const old = inv.preparedAction;
  let nextFix = old;
  if (prepared) nextFix = prepared;
  else if (old && old.status === 'prepared') nextFix = { ...old, status: 'superseded' };
  if (old && old.status === 'prepared' && (!prepared || old.id !== prepared.id)) {
    _event(inv.id, _iso(nowMs), 'fix-superseded', inv.state, state, { fixId: old.id });
  }
  _update(inv.id, {
    state, updated_at: _iso(nowMs), evidence_json: JSON.stringify(evidence), hypotheses_json: JSON.stringify(hypotheses),
    confidence: hypotheses[0].confidence, decision: decision.decision, recommended_action: decision.fixKind,
    prepared_action_json: nextFix ? JSON.stringify(nextFix) : null,
    stop_reason: decision.stopReason,
    budget_json: JSON.stringify({ calls: g.calls, exhausted: g.exhausted, elapsedMs: g.elapsedMs, ...g.limits }),
    version,
  });
  _event(inv.id, _iso(nowMs), 'decided', 'hypothesised', state, { decision: decision.decision, stopReason: decision.stopReason,
    fix: prepared ? { id: prepared.id, kind: prepared.kind, authority: prepared.authority } : null });
  if (prepared && prepared.requiresHuman) _event(inv.id, _iso(nowMs), 'approval-handoff', state, state, { fixId: prepared.id, requiresHuman: true });
}

function _close(inv, state, stopReason, nowMs, detail) {
  const at = _iso(nowMs);
  const fix = inv.preparedAction;
  const cancelled = fix && fix.status === 'prepared' ? { ...fix, status: 'cancelled' } : fix;
  _update(inv.id, { state, stop_reason: stopReason, completed_at: at, updated_at: at, prepared_action_json: cancelled ? JSON.stringify(cancelled) : null });
  if (fix && fix.status === 'prepared') _event(inv.id, at, 'fix-cancelled', inv.state, state, { fixId: fix.id });
  _event(inv.id, at, state, inv.state, state, { stopReason, ...(detail || {}) });
}

/**
 * One pass. Idempotent: a second pass with nothing changed writes nothing.
 * @returns {{ started, regathered, resolved, dismissed, expired, unchanged }}
 */
async function runSourceBlindInvestigations({ now = Date.now(), deps = {} } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const sb = deps.sourceBlindness || require('./source-blindness');
  const native = require('./native-sources');
  const out = { started: 0, regathered: 0, resolved: 0, dismissed: 0, expired: 0, unchanged: 0 };
  const clock = deps.clock || (() => Date.now());
  const runDeps = { probes: deps.probes || defaultProbes(), clock, budget: deps.budget || {} };

  const active = sb.getFindings({ status: 'active', now: nowMs, limit: 200 });
  const activeById = new Map(active.map((f) => [f.findingId, f]));

  // 1 — close what is over (recovery, no longer live, expiry).
  for (const inv of list({ open: true, limit: 500 })) {
    if (inv.type !== TYPE) continue;
    const f = activeById.get(inv.triggerRef);
    if (!f) {
      const all = sb.getFindings({ now: nowMs, limit: 500 });
      const was = all.find((x) => x.findingId === inv.triggerRef);
      _close(inv, 'resolved', 'recovered', nowMs, { recovery: was ? { resolvedAt: was.resolvedAt, resolution: was.resolution } : { resolution: 'finding-gone' } });
      out.resolved += 1;
      continue;
    }
    if (nowMs >= Date.parse(inv.expiresAt)) { _close(inv, 'inconclusive', 'expired', nowMs); out.expired += 1; continue; }
    if (!sb.liveEligible(f, nowMs).eligible || native.describe(f.source).lifecycle !== 'expected') {
      _close(inv, 'dismissed', 'finding-not-live', nowMs, { why: sb.liveEligible(f, nowMs).why });
      out.dismissed += 1;
    }
  }

  // 2 — start or re-gather for live findings.
  for (const f of active) {
    if (native.describe(f.source).lifecycle !== 'expected') continue;
    if (!sb.liveEligible(f, nowMs).eligible) continue;
    const key = `${TYPE}:${f.source}:${f.findingId}`;
    let inv = byDedupe(key);
    if (inv && TERMINAL_STATES.includes(inv.state)) { out.unchanged += 1; continue; }
    if (!inv) {
      const id = `inv_${require('crypto').createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
      const at = _iso(nowMs);
      db.run(`INSERT OR IGNORE INTO investigations (id, type, state, subject_ref, trigger_ref, dedupe_key, started_at, updated_at, expires_at, version)
              VALUES (?, ?, 'detected', ?, ?, ?, ?, ?, ?, 1)`, [id, TYPE, `source:${f.source}`, f.findingId, key, at, at, _iso(nowMs + sbi.EXPIRY_MS)]);
      inv = byDedupe(key);
      _event(inv.id, at, 'detected', null, 'detected', { findingId: f.findingId, condition: f.condition });
      await _investigate(inv, f, { nowMs, deps: runDeps });
      out.started += 1;
      continue;
    }
    // A self-heal attempt in flight is never re-gathered underneath itself —
    // the attempt's verification decides what happens next (Build 15).
    if (inv.state === 'fixing') { out.unchanged += 1; continue; }
    // A pass interrupted mid-gather resumes; otherwise only a CHANGED finding re-gathers.
    if (inv.state === 'gathering' || inv.state === 'detected' || inv.triggerSignature !== _signature(f)) {
      await _investigate(inv, f, { nowMs, deps: runDeps });
      out.regathered += 1;
    } else {
      out.unchanged += 1;
    }
  }

  // 3 — Build 15: verify self-heal attempts in flight (restart-safe), then let
  // an eligible high-confidence fix run once. Never allowed to fail the pass.
  if (deps.selfHeal !== false) {
    try {
      out.selfHeal = await require('./self-heal').pass({ now: nowMs, deps: deps.selfHealDeps || {} });
    } catch (e) {
      console.warn(`[Investigations] self-heal pass failed: ${e.message}`);
      out.selfHeal = { error: e.message };
    }
  }
  return out;
}

/** Build 15: a self-heal transition — fields + one append-only event. */
function applySelfHeal(id, { fields = {}, transition, to = null, detail = null, nowMs = Date.now() }) {
  const inv = get(id);
  if (!inv) return null;
  _update(id, { ...fields, updated_at: _iso(nowMs) });
  _event(id, _iso(nowMs), transition, inv.state, to || fields.state || inv.state, detail);
  return get(id);
}

/** Which investigations may be offered to Nick — the attention policy still decides. */
function attentionView(inv) {
  if (!inv || !OPEN_STATES.includes(inv.state)) return { eligible: false, why: 'closed' };
  const fix = inv.preparedAction;
  const top = (inv.hypotheses || [])[0];
  if (inv.state === 'fixing') return { eligible: false, why: 'NEURO is trying a safe fix and verifying it' };
  if (!fix || fix.status !== 'prepared') return { eligible: false, why: 'nothing for Nick to do' };
  if (!top || top.level === 'low') return { eligible: false, why: 'confidence too low to ask' };
  if (!fix.requiresHuman) return { eligible: false, why: 'no manual step' };
  return { eligible: true, why: 'a manual step only Nick can take' };
}

function summaryFor(inv) {
  const native = require('./native-sources');
  const label = native.describe(String(inv.subjectRef || '').replace(/^source:/, '')).label;
  return { ...sbi.summarise(inv, label), attention: attentionView(inv) };
}

module.exports = { TYPE, OPEN_STATES, TERMINAL_STATES, runSourceBlindInvestigations, gather, defaultProbes, get, byDedupe, list, events, attentionView, summaryFor, applySelfHeal };
