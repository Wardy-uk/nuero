'use strict';

/**
 * Repeated source degradation — store and runner (Build 17E–K). The judgement
 * is pure and lives in source-degradation.js; this file reads NEURO's own
 * operational state about SOURCES, records, and stops. It never notifies and
 * never executes anything.
 *
 * Same table and audit trail as source-blind investigations (`investigations`
 * + append-only `investigation_events`), type `repeated_source_degradation`.
 * One investigation per DEGRADATION CLUSTER (dedupe on the cluster's first
 * episode), never per episode. A pass re-gathers only when the cluster grew;
 * the investigation closes when the source has been stable for a week, or at
 * expiry.
 */

const db = require('../db/database');
const sd = require('./source-degradation');
const sbi = require('./source-blind-investigation');
const invs = require('./investigations');
const matrix = require('./authority-matrix');

const TYPE = sd.TYPE;
const DAY_MS = 86400000;
const LOOKBACK_DAYS = 21;          // enough to find a cluster's start and its quiet tail
const CO_OCCUR_MS = 15 * 60 * 1000;

function _iso(ms) { return new Date(ms).toISOString(); }
function _localMinute(ms) { return require('./world-model').localMinute(ms); }

/**
 * When did a NEURO process start? Derived from the durable runtime, which
 * stamps every claimed run with its process's boot id: the earliest run a
 * boot claimed is within minutes of that boot. Replayable from 3 Oct 2026.
 */
function bootTimes(sinceMs, nowMs = Date.now()) {
  const out = [];
  try {
    for (const r of db.all(`SELECT owner, MIN(first_started_at) t FROM runtime_job_runs
                             WHERE owner IS NOT NULL AND first_started_at >= ? GROUP BY owner`, [_iso(sinceMs - DAY_MS)])) {
      const t = Date.parse(r.t);
      if (Number.isFinite(t)) out.push(t);
    }
  } catch { /* no runtime table: no boots known */ }
  out.push(nowMs - Math.round(process.uptime() * 1000));
  return out.sort((a, b) => a - b);
}

/** Every episode for one source since `sinceMs`, annotated. */
function episodesFor(sourceId, { sinceMs, nowMs, boots }) {
  const since = _iso(sinceMs);
  const events = db.all(`SELECT type, occurred_at, payload FROM event_log WHERE subject_id = ? AND occurred_at >= ?
                           AND type IN ('source.sync.failed','source.sync.succeeded') ORDER BY seq`, [sourceId, since])
    .map((e) => { let p = {}; try { p = JSON.parse(e.payload); } catch { p = {}; } return { type: e.type, occurredAt: e.occurred_at, reason: p.reason || null, error: p.error || null }; });
  const findings = db.all(`SELECT condition, basis_at, first_detected_at, resolved_at, resolution FROM source_blind_findings
                            WHERE source_id = ? AND first_detected_at >= ?`, [sourceId, since])
    .map((f) => ({ condition: f.condition, basisAt: f.basis_at, firstDetectedAt: f.first_detected_at, resolvedAt: f.resolved_at, resolution: f.resolution }));
  const eps = [...sd.failureEpisodes(sourceId, events), ...sd.staleEpisodes(sourceId, findings)];
  return sd.annotate(eps, { boots, localMinute: _localMinute, nowMs });
}

function _overlaps(a, b, slack = CO_OCCUR_MS) {
  const as = Date.parse(a.start); const ae = Date.parse(a.end || a.start);
  const bs = Date.parse(b.start); const be = Date.parse(b.end || b.start);
  return as <= be + slack && bs <= ae + slack;
}

/** The default read-only probes. Each reads NEURO's own state about sources. */
function defaultProbes() {
  const native = require('./native-sources');
  return {
    'episode-history': () => ({}),
    'failure-reasons': () => ({}),
    'provider-check': ({ sourceId }) => require('./provider-check').check(sourceId),
    'sync-job': ({ sourceId, cluster }) => {
      const job = sd.SOURCE_JOB[sourceId];
      if (!job) return { job: null, runs: {} };
      const rows = db.all(`SELECT status, skip_reason, error FROM runtime_job_runs WHERE job = ? AND scheduled_for >= ?`, [job, cluster.firstStart]);
      return { job, runs: { total: rows.length, failed: rows.filter((r) => r.status === 'failed').length,
        skipped: rows.filter((r) => r.status === 'skipped' && r.skip_reason !== 'superseded').length,
        timeout: rows.filter((r) => /timeout/i.test(r.error || '')).length } };
    },
    'app-heartbeat': ({ sourceId, cluster }) => {
      const sibs = sbi.appSiblings(sourceId, Object.keys(native.SOURCES)).filter((id) => native.describe(id).lifecycle !== 'retired');
      if (!sibs.length) return { perEpisode: [] };
      const ph = sibs.map(() => '?').join(',');
      const perEpisode = cluster.episodes.map((e) => {
        const n = db.get(`SELECT COUNT(*) n FROM event_log WHERE type = 'source.observation.received' AND subject_id IN (${ph})
                           AND occurred_at > ? AND occurred_at < ?`, [...sibs, e.start, e.end || _iso(Date.now())]).n;
        return { start: e.start, siblingsDelivered: n > 0 };
      });
      return { perEpisode };
    },
    'queue-reports': ({ sourceId, cluster }) => {
      const rows = db.all(`SELECT type FROM event_log WHERE type IN ('native.queue.degraded','native.queue.replayed')
                             AND occurred_at >= ? AND json_extract(payload, '$.sourceId') = ?`, [cluster.firstStart, sourceId]);
      return { degraded: rows.filter((r) => r.type === 'native.queue.degraded').length, replayed: rows.filter((r) => r.type === 'native.queue.replayed').length };
    },
    'co-occurrence': ({ sourceId, cluster, others }) => {
      let shared = 0; const withSources = new Set();
      for (const e of cluster.episodes) {
        const hits = (others || []).filter((o) => o.sourceId !== sourceId && !o.excluded && _overlaps(e, o));
        if (hits.length) { shared += 1; hits.forEach((h) => withSources.add(h.sourceId)); }
      }
      return { sharedEpisodes: shared, withSources: [...withSources] };
    },
    'process-boots': ({ cluster, boots }) => ({ boots: (boots || []).filter((b) => b >= Date.parse(cluster.firstStart)).length }),
    'investigation-history': ({ sourceId }) => {
      const rows = db.all(`SELECT type FROM investigations WHERE subject_ref = ? AND started_at >= ?`, [`source:${sourceId}`, _iso(Date.now() - 30 * DAY_MS)]);
      return { blindness: rows.filter((r) => r.type === invs.TYPE).length, degradation: rows.filter((r) => r.type === TYPE).length };
    },
    'self-heal-history': ({ sourceId }) => {
      const rows = db.all(`SELECT status FROM self_heal_attempts WHERE source_id = ? AND requested_at >= ?`, [sourceId, _iso(Date.now() - 30 * DAY_MS)]);
      return { attempts: rows.length, recovered: rows.filter((r) => r.status === 'recovered').length };
    },
  };
}

function _clusterFacts(cl) {
  return { id: cl.id, counted: cl.counted, inWindow: cl.inWindow, firstStart: cl.firstStart, lastEnd: cl.lastEnd,
    unhealthyMsInWindow: cl.unhealthyMsInWindow, longestMs: Math.max(0, ...cl.episodes.map((e) => e.durationMs || 0)),
    episodes: cl.episodes.map((e) => ({ start: e.start, end: e.end, mode: e.mode, durationMs: e.durationMs, deliveryFailures: e.deliveryFailures, reasons: e.reasons, recovery: e.recovery })),
    excluded: cl.excludedInPeriod };
}

async function _investigate(inv, sourceId, cl, { nowMs, deps, boots, others }) {
  const native = require('./native-sources');
  const d = native.describe(sourceId);
  const at = _iso(nowMs);
  invs._update(inv.id, { state: 'gathering', updated_at: at, trigger_signature: String(cl.counted) });
  invs._event(inv.id, at, 'gathering', inv.state, 'gathering', { signature: String(cl.counted), episodes: cl.counted });
  const planned = sd.plan(sourceId, native.describe);
  const g = await invs.gather(sourceId, planned, { probes: deps.probes, clock: deps.clock, budget: { maxProbes: sd.MAX_PROBES, ...(deps.budget || {}) },
    allowed: sd.PROBES, context: { cluster: cl, boots, others } });
  const evidence = sd.toEvidence(sourceId, cl, g.results);
  invs._event(inv.id, at, 'evidence', 'gathering', 'gathering', { refs: evidence.map((e) => ({ id: e.id, probe: e.probe, status: e.status, signal: e.signal })), calls: g.calls, exhausted: g.exhausted });
  const hypotheses = sd.hypothesise(evidence, { push: !!d.push });
  invs._event(inv.id, at, 'hypothesised', 'gathering', 'hypothesised', { top: hypotheses[0].type, level: hypotheses[0].level });
  let decision = sd.decide({ hypotheses, sourceId, cl });
  if (g.exhausted && decision.decision !== 'PREPARE') decision = { ...decision, stopReason: 'budget-exhausted' };
  const version = (inv.version || 1) + (inv.state === 'detected' ? 0 : 1);
  let prepared = null; let state = decision.state;
  if (decision.fixKind) {
    const p = sbi.prepareFix(decision.fixKind, { matrix, investigationId: inv.id, version });
    // Only manual steps may be prepared by this type — never a retry.
    if (p.ok && p.fix.requiresHuman) { prepared = p.fix; state = p.state; } else { state = 'monitoring'; decision = { ...decision, stopReason: 'authority-exceeded', fixKind: null }; }
  }
  const old = inv.preparedAction;
  const nextFix = prepared || (old && old.status === 'prepared' ? { ...old, status: 'superseded' } : old);
  invs._update(inv.id, {
    state, updated_at: at, evidence_json: JSON.stringify(evidence), hypotheses_json: JSON.stringify(hypotheses),
    confidence: hypotheses[0].confidence, decision: decision.decision, recommended_action: decision.fixKind,
    prepared_action_json: nextFix ? JSON.stringify(nextFix) : null, stop_reason: decision.stopReason,
    budget_json: JSON.stringify({ calls: g.calls, exhausted: g.exhausted, elapsedMs: g.elapsedMs, ...g.limits, cluster: _clusterFacts(cl) }),
    version, ...(['dismissed', 'resolved'].includes(state) ? { completed_at: at } : {}),
  });
  invs._event(inv.id, at, 'decided', 'hypothesised', state, { decision: decision.decision, stopReason: decision.stopReason,
    fix: prepared ? { id: prepared.id, kind: prepared.kind, authority: prepared.authority } : null });
  if (prepared && prepared.requiresHuman) invs._event(inv.id, at, 'approval-handoff', state, state, { fixId: prepared.id, requiresHuman: true });
  return state;
}

function _close(inv, state, stopReason, nowMs, detail) {
  const at = _iso(nowMs);
  const fix = inv.preparedAction;
  const cancelled = fix && fix.status === 'prepared' ? { ...fix, status: 'cancelled' } : fix;
  invs._update(inv.id, { state, stop_reason: stopReason, completed_at: at, updated_at: at, prepared_action_json: cancelled ? JSON.stringify(cancelled) : null });
  if (fix && fix.status === 'prepared') invs._event(inv.id, at, 'fix-cancelled', inv.state, state, { fixId: fix.id });
  invs._event(inv.id, at, state, inv.state, state, { stopReason, ...(detail || {}) });
}

/**
 * One pass. Idempotent: nothing changed → nothing written.
 * @returns {{ sources, started, regathered, resolved, expired, unchanged, triggered:[] }}
 */
async function run({ now = Date.now(), deps = {} } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const native = require('./native-sources');
  const out = { sources: 0, started: 0, regathered: 0, resolved: 0, expired: 0, unchanged: 0, attention: 0, clusters: [] };
  const sinceMs = nowMs - LOOKBACK_DAYS * DAY_MS;
  const boots = deps.boots || bootTimes(sinceMs, nowMs);
  const runDeps = { probes: deps.probes || defaultProbes(), clock: deps.clock || (() => Date.now()), budget: deps.budget || {} };
  // Expected sources only — optional and retired are never investigated.
  const sources = (deps.sources || native.expectedSources()).filter((id) => native.describe(id).lifecycle === 'expected');
  const bySource = new Map(sources.map((id) => [id, (deps.episodes ? deps.episodes(id) : episodesFor(id, { sinceMs, nowMs, boots }))]));
  const allEpisodes = [...bySource.values()].flat();
  const live = new Set();

  for (const sourceId of sources) {
    out.sources += 1;
    const cl = sd.cluster(bySource.get(sourceId), nowMs);
    if (cl.id) out.clusters.push({ sourceId, counted: cl.counted, triggered: cl.triggered, why: cl.why });
    if (!cl.id) continue;
    const key = `${TYPE}:${cl.id}`;
    let inv = invs.byDedupe(key);
    if (!cl.triggered && !inv) continue;
    if (inv && invs.TERMINAL_STATES.includes(inv.state)) { out.unchanged += 1; continue; }
    live.add(key);
    if (inv && cl.stableAgain) { _close(inv, 'resolved', 'stable-again', nowMs, { lastEnd: cl.lastEnd }); out.resolved += 1; continue; }
    if (inv && nowMs >= Date.parse(inv.expiresAt)) { _close(inv, 'inconclusive', 'expired', nowMs); out.expired += 1; continue; }
    if (!inv) {
      const id = `inv_${require('crypto').createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
      const at = _iso(nowMs);
      db.run(`INSERT OR IGNORE INTO investigations (id, type, state, subject_ref, trigger_ref, dedupe_key, started_at, updated_at, expires_at, version)
              VALUES (?, ?, 'detected', ?, ?, ?, ?, ?, ?, 1)`, [id, TYPE, `source:${sourceId}`, cl.id, key, at, at, _iso(nowMs + sd.EXPIRY_MS)]);
      inv = invs.byDedupe(key);
      invs._event(inv.id, at, 'detected', null, 'detected', { cluster: cl.id, episodes: cl.counted, why: cl.why });
      await _investigate(inv, sourceId, cl, { nowMs, deps: runDeps, boots, others: allEpisodes });
      out.started += 1;
    } else if (inv.state === 'gathering' || inv.state === 'detected' || inv.triggerSignature !== String(cl.counted)) {
      await _investigate(inv, sourceId, cl, { nowMs, deps: runDeps, boots, others: allEpisodes });
      out.regathered += 1;
    } else {
      out.unchanged += 1;
    }
    // 17K: ask the EXISTING attention policy, once per version, only when eligible.
    const fresh = invs.get(inv.id);
    const view = sd.attentionView(fresh, cl);
    const asked = invs.events(inv.id).some((e) => e.transition === 'attention' && e.detail && e.detail.version === fresh.version);
    if (view.eligible && !asked) {
      let decision;
      try {
        const { moment } = await (deps.readMoment ? deps.readMoment(nowMs) : require('./ambient-push').readMoment({ now: new Date(nowMs) }));
        const s = summaryFor(fresh);
        const v = require('./ambient-push').worthInterrupting({ kind: 'source-degradation', text: s.pattern, detail: s.recommended, investigationId: inv.id }, moment);
        decision = { push: !!v.push, why: v.why || null, wouldSay: v.push ? v.message : null };
      } catch (e) { decision = { push: false, why: `could not read the moment: ${e.message}` }; }
      invs._event(inv.id, _iso(nowMs), 'attention', fresh.state, fresh.state, { version: fresh.version, ...decision, shadow: true, sent: false });
      out.attention += 1;
    }
  }
  // A cluster that is no longer the current one for its source is over.
  for (const open of invs.list({ open: true, limit: 500 })) {
    if (open.type !== TYPE || live.has(open.dedupeKey)) continue;
    _close(open, 'resolved', 'cluster-ended', nowMs);
    out.resolved += 1;
  }
  return out;
}

function summaryFor(inv) {
  const native = require('./native-sources');
  const sourceId = String(inv.subjectRef || '').replace(/^source:/, '');
  const s = sd.summarise(inv, native.describe(sourceId).label);
  const cl = inv.budget && inv.budget.cluster;
  return { ...s, attention: sd.attentionView(inv, cl) };
}

/** Replay the trigger over history, read-only: which sources WOULD investigate at each threshold. */
function replay({ now = Date.now(), thresholds = [2, 3, 4] } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const native = require('./native-sources');
  const sinceMs = nowMs - LOOKBACK_DAYS * DAY_MS;
  const boots = bootTimes(sinceMs, nowMs);
  const out = { boots: boots.length, sources: [] };
  for (const id of native.expectedSources()) {
    const eps = episodesFor(id, { sinceMs, nowMs, boots });
    const counted = eps.filter((e) => !e.excluded);
    out.sources.push({ sourceId: id, episodes: eps.length, counted: counted.length,
      excluded: eps.filter((e) => e.excluded).reduce((m, e) => { m[e.excluded] = (m[e.excluded] || 0) + 1; return m; }, {}),
      counts: counted.map((e) => ({ start: e.start, mode: e.mode, durationMs: e.durationMs, reasons: e.reasons })),
      wouldTrigger: Object.fromEntries(thresholds.map((n) => [n, sd.cluster(eps, nowMs, { minEpisodes: n }).triggered === true])) });
  }
  return out;
}

module.exports = { TYPE, run, replay, episodesFor, bootTimes, defaultProbes, summaryFor };
