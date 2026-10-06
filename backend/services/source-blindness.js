'use strict';

/**
 * Source blindness — the first event-subscribing evaluator (Build 2B).
 *
 *   source goes blind → event → this evaluator → an evidence-backed FINDING
 *   → the EXISTING attention policy decides whether it interrupts.
 *
 * ⚠ THIS EVALUATOR NEVER NOTIFIES. It produces findings; ambient-push (the one
 * route to an interruption, with its quiet hours, meeting/focus vetoes,
 * learned muting, dedupe and caps) decides what, if anything, Nick hears.
 * A detector that could push for itself would be a second notification
 * system, which is exactly what the attention engine exists to prevent.
 *
 * ── Shadow mode (the default) ───────────────────────────────────────────────
 *
 *   SOURCE_BLIND_MODE=shadow  findings are created, and ambient-push records
 *                             what the attention policy WOULD do with each —
 *                             but nothing reaches a screen or a phone.
 *   SOURCE_BLIND_MODE=live    findings enter the real policy path.
 *   SOURCE_BLIND_MODE=off     nothing is evaluated for attention.
 *
 * The evaluator itself always runs (it only writes its own tables), so shadow
 * mode produces a full record to judge it by before it is ever trusted.
 *
 * ── Episodes, not ticks ─────────────────────────────────────────────────────
 *
 * A finding is an EPISODE: opened on the transition into blindness, refreshed
 * while it lasts (`repeat`), escalated if its condition changes (`change`),
 * and RESOLVED when the source recovers. stale → stale is never a new finding,
 * so a five-minute staleness check cannot become a five-minute nag.
 *
 * ── Replayable ──────────────────────────────────────────────────────────────
 *
 * A transactional, replayable consumer: its memory (`source_blind_state`) is
 * folded from source.* events alone, never read from another consumer's table
 * mid-replay. Finding ids are deterministic (source + the seq that opened
 * them), so a replay reproduces them and the attention verdicts recorded
 * against them — which are NOT derivable from the log — reattach.
 */

const db = require('../db/database');
const bus = require('./event-bus');
const nativeSources = require('./native-sources');

const CONSUMER = 'source-blindness';
const TYPES = ['source.sync.succeeded', 'source.sync.failed', 'source.sync.stale', 'source.observation.received',
  'source.observation.quiet', 'source.lifecycle.changed'];

// Three failures in a row before a failing source is a finding. One failed
// Graph call or one malformed phone POST is a hiccup; three is a pattern.
const FAIL_THRESHOLD = 3;
const MAX_EVIDENCE = 20;

const CONFIDENCE = {
  stale: 0.9,
  // A phone app going quiet may only mean iOS has not woken it (background
  // refresh was measured once in 21 hours), so the read is genuinely weaker.
  'stale-push': 0.7,
  failing: 0.95,
  // Never heard from at all: could be blind, could be not installed.
  'never-seen': 0.5,
  // Build 3B: a vehicle-scale motion report and no fix after it. Suggestive —
  // the app is alive, so this is a sensor that may have stopped, not a phone
  // that has gone.
  'moving-without-fix': 0.6,
};

// ── Build 13O: shadow → live, behind an explicit threshold ───────────────────
//
// Replayed against all 12 findings on the live Pi (2–6 Oct 2026): every one
// that healed did so by itself within 23.9h (an app iOS had not woken
// overnight), and the two that never healed were pre-identity buckets now
// RETIRED. So "stale" alone is not something to surface. Live surfaces only:
//   • an EXPECTED source (optional/retired never), and
//   • `failing` (FAIL_THRESHOLD consecutive delivery failures — real breakage), or
//   • stale for LIVE_MIN_SILENCE_MS (30h: a full day plus margin over the
//     longest self-healed gap observed).
// never-seen and moving-without-fix stay shadow: both are weaker reads
// (confidence 0.5 / 0.6) and "not installed" is not "broken".
const LIVE_MIN_SILENCE_MS = 30 * 60 * 60 * 1000;
const LIVE_CONDITIONS = Object.freeze(['failing', 'stale']);

/** Pure. Would this shaped finding be surfaced in live mode? */
function liveEligible(f, nowMs) {
  if (!f || f.status !== 'active') return { eligible: false, why: 'not active' };
  const lifecycle = nativeSources.describe(f.source).lifecycle;
  if (lifecycle !== 'expected') return { eligible: false, why: `source is ${lifecycle}` };
  if (!LIVE_CONDITIONS.includes(f.condition)) return { eligible: false, why: `${f.condition} is too weak a read to surface` };
  if (f.condition === 'failing') return { eligible: true, why: 'deliveries keep failing' };
  const basis = f.lastObservedOrSuccessAt ? Date.parse(f.lastObservedOrSuccessAt) : NaN;
  if (!Number.isFinite(basis)) return { eligible: false, why: 'silence cannot be dated' };
  const silence = nowMs - basis;
  return silence >= LIVE_MIN_SILENCE_MS
    ? { eligible: true, why: `silent for ${Math.round(silence / 36e5)}h` }
    : { eligible: false, why: `silent ${Math.round(silence / 36e5)}h, under the 30h live threshold` };
}

function mode() {
  // An explicit environment value wins (shadow | live | off); otherwise the
  // Settings kill switch decides between live and shadow.
  const env = String(process.env.SOURCE_BLIND_MODE || '').trim().toLowerCase();
  if (env) return ['shadow', 'live', 'off'].includes(env) ? env : 'shadow';
  let on = false;
  try { on = require('./feature-flags').isEnabled('source_blind_live'); } catch { on = false; }
  return on ? 'live' : 'shadow';
}

function _later(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a >= b ? a : b;
}

// ── the fold ─────────────────────────────────────────────────────────────────

function _state(sourceId) {
  return db.get('SELECT * FROM source_blind_state WHERE source_id = ?', [sourceId]) || {
    source_id: sourceId, basis_at: null, last_success_at: null, last_outcome_at: null,
    consecutive_failures: 0, last_failure: null, active_finding_id: null, lifecycle: null,
  };
}

function _saveState(s, at) {
  db.run(
    `INSERT INTO source_blind_state (source_id, basis_at, last_success_at, last_outcome_at, consecutive_failures,
       last_failure, active_finding_id, updated_at, lifecycle)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id) DO UPDATE SET basis_at = excluded.basis_at, last_success_at = excluded.last_success_at,
       last_outcome_at = excluded.last_outcome_at, consecutive_failures = excluded.consecutive_failures,
       last_failure = excluded.last_failure, active_finding_id = excluded.active_finding_id,
       updated_at = excluded.updated_at, lifecycle = excluded.lifecycle`,
    [s.source_id, s.basis_at, s.last_success_at, s.last_outcome_at, s.consecutive_failures,
      s.last_failure, s.active_finding_id, at, s.lifecycle || null]
  );
}

function _finding(id) {
  return id ? db.get('SELECT * FROM source_blind_findings WHERE finding_id = ?', [id]) : null;
}

function _open(s, ev, condition, extra = {}) {
  const id = `source-blind:${s.source_id}:${ev.seq}`;
  // A retired source never opens a finding (Build 3B): its silence is the
  // expected state, and its history stays in the log.
  if (s.lifecycle === 'retired') return;
  const confidence = condition === 'stale' && extra.push ? CONFIDENCE['stale-push'] : CONFIDENCE[condition];
  db.run(
    `INSERT INTO source_blind_findings (finding_id, source_id, status, condition, first_detected_at, last_seen_at,
       basis_at, last_success_at, failure_count, stale_after_ms, confidence, change, repeats, evidence_json, updated_at)
     VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, 'new', 0, ?, ?)`,
    [id, s.source_id, condition, ev.occurredAt, ev.occurredAt, s.basis_at, s.last_success_at,
      s.consecutive_failures, extra.staleAfterMs || null, confidence, JSON.stringify([ev.eventId]), ev.receivedAt]
  );
  s.active_finding_id = id;
}

function _touch(f, ev, change, patch = {}) {
  const evidence = JSON.parse(f.evidence_json);
  if (!evidence.includes(ev.eventId)) evidence.push(ev.eventId);
  const fields = {
    last_seen_at: _later(f.last_seen_at, ev.occurredAt),
    change,
    repeats: change === 'repeat' ? f.repeats + 1 : f.repeats,
    evidence_json: JSON.stringify(evidence.slice(-MAX_EVIDENCE)),
    updated_at: ev.receivedAt,
    ...patch,
  };
  const keys = Object.keys(fields);
  db.run(`UPDATE source_blind_findings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE finding_id = ?`,
    [...keys.map((k) => fields[k]), f.finding_id]);
}

function _resolve(s, ev, resolution = 'recovered') {
  const f = _finding(s.active_finding_id);
  if (f && f.status === 'active') {
    _touch(f, ev, 'resolved', { status: 'resolved', resolved_at: ev.occurredAt, resolution });
  }
  s.active_finding_id = null;
}

/** Fold one event. Synchronous: it runs in the offset's transaction. */
function applyEvent(ev) {
  const p = ev.payload;
  const s = _state(p.sourceId);
  const active = _finding(s.active_finding_id);
  const push = !!nativeSources.describe(p.sourceId).push && p.sourceId !== 'microsoft.calendar';

  switch (ev.type) {
    case 'source.sync.succeeded':
    case 'source.observation.received': {
      // Outcome time: a pull run's success time, or a push delivery's ARRIVAL.
      const outcomeAt = ev.type === 'source.observation.received' ? ev.receivedAt : ev.occurredAt;
      const basis = ev.type === 'source.observation.received' ? p.newestObservedAt : ev.occurredAt;
      const newerOutcome = !s.last_outcome_at || outcomeAt >= s.last_outcome_at;
      const newerBasis = !s.basis_at || basis > s.basis_at;
      if (newerOutcome) { s.consecutive_failures = 0; s.last_outcome_at = outcomeAt; }
      s.last_success_at = _later(s.last_success_at, outcomeAt);
      if (newerBasis) s.basis_at = basis;
      // Recovery: fresh data past what the finding was about. An older
      // delivery (a draining queue) does not resolve a staleness finding, and
      // a success resolves a failing one only if it is the newest outcome.
      if (active && active.status === 'active') {
        const cured = active.condition === 'failing' ? newerOutcome : newerBasis;
        if (cured) _resolve(s, ev);
      }
      break;
    }

    case 'source.sync.failed': {
      if (!s.last_outcome_at || ev.occurredAt >= s.last_outcome_at) {
        s.consecutive_failures += 1;
        s.last_outcome_at = ev.occurredAt;
        s.last_failure = String(p.reason || p.error || '').slice(0, 200) || null;
      }
      if (active && active.status === 'active') {
        const escalated = active.condition !== 'failing' && s.consecutive_failures >= FAIL_THRESHOLD;
        _touch(active, ev, escalated ? 'change' : 'repeat', {
          failure_count: s.consecutive_failures,
          ...(escalated ? { condition: 'failing', confidence: CONFIDENCE.failing } : {}),
        });
      } else if (s.consecutive_failures >= FAIL_THRESHOLD) {
        _open(s, ev, 'failing');
      }
      break;
    }

    case 'source.sync.stale': {
      // ⚠ Only about the basis we still hold — a stale verdict on data since
      // superseded is out of date (the projector's own rule, mirrored).
      if (p.neverSeen === true) {
        if (!s.basis_at && !s.last_success_at && !(active && active.status === 'active')) {
          _open(s, ev, 'never-seen', { staleAfterMs: p.staleAfterMs });
        }
        break;
      }
      const verdictBasis = p.basis === 'observation' ? p.lastObservedAt : p.lastSuccessAt;
      if (!verdictBasis || verdictBasis !== s.basis_at) break;
      const condition = p.reason === 'moving-without-fix' ? 'moving-without-fix' : 'stale';
      if (active && active.status === 'active') {
        // The only escalation a stale verdict can make is stale → moving
        // (movement is new evidence). It never rewrites a FAILING finding:
        // failures are the stronger fact, and a stale verdict on the same
        // source must not turn them into something an older delivery can cure.
        const escalate = condition === 'moving-without-fix' && active.condition === 'stale';
        _touch(active, ev, escalate ? 'change' : 'repeat',
          escalate ? { condition, confidence: CONFIDENCE[condition] } : {});
      } else {
        _open(s, ev, condition, { staleAfterMs: p.staleAfterMs, push });
      }
      break;
    }

    case 'source.observation.quiet': {
      // Build 3B: the fix is old but the app is alive on another channel — a
      // phone that has not moved, not a blind sensor. Resolves a staleness
      // finding about THAT fix; never opens one, and never cures a failing
      // source or a moving-without-fix suspicion (movement is the evidence
      // that a fix was owed, and liveness does not answer it).
      if (active && active.status === 'active' && active.condition === 'stale'
          && p.lastObservedAt === s.basis_at) {
        _resolve(s, ev, 'transport-alive');
      }
      break;
    }

    case 'source.lifecycle.changed': {
      s.lifecycle = p.lifecycle;
      if (p.lifecycle === 'retired' && active && active.status === 'active') _resolve(s, ev, 'retired');
      break;
    }

    default:
      return;
  }
  _saveState(s, ev.receivedAt);
}

bus.registerConsumer({
  name: CONSUMER,
  types: TYPES,
  transactional: true,
  replayable: true, // its own two tables; source_blind_attention is deliberately NOT reset
  handle: applyEvent,
  reset: () => {
    db.run('DELETE FROM source_blind_findings');
    db.run('DELETE FROM source_blind_state');
  },
});

// ── never seen ───────────────────────────────────────────────────────────────

const SINCE_KEY = 'source_blind_watch_since';

/**
 * Expected sources NEURO has never heard from. A clock judgement, so — like
 * staleness — it is made once and RECORDED as a `source.sync.stale` event
 * (`neverSeen: true`, one per source, ever), which keeps the evaluator a
 * function of the log.
 *
 * ⚠ The clock starts when NEURO began WATCHING (the first time this ran), not
 * at the dawn of time: a source added to the registry today has not been
 * "missing for months". `since` is persisted so a restart does not reset it.
 */
async function checkExpected({ now = Date.now(), since = null } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  let watchSince = since;
  if (!watchSince) {
    try {
      watchSince = db.getState(SINCE_KEY);
      if (!watchSince) { watchSince = new Date(nowMs).toISOString(); db.setState(SINCE_KEY, watchSince); }
    } catch { return []; }
  }
  const marked = [];
  for (const sourceId of nativeSources.expectedSources()) {
    const d = nativeSources.describe(sourceId);
    const threshold = d.staleAfterMs || 12 * 60 * 60 * 1000;
    if (nowMs - Date.parse(watchSince) <= threshold) continue;
    const row = db.get('SELECT last_success_at, last_observed_at FROM source_health WHERE source_id = ?', [sourceId]);
    if (row && (row.last_success_at || row.last_observed_at)) continue;
    try {
      const r = bus.publishEvent({
        type: 'source.sync.stale',
        occurredAt: new Date(nowMs).toISOString(),
        source: { system: 'neuro', recordId: sourceId },
        subject: { entityType: 'source', entityId: sourceId },
        idempotencyKey: `source-stale:${sourceId}:never`,
        payload: { sourceId, lastSuccessAt: null, staleAfterMs: threshold, neverSeen: true, watchingSince: watchSince },
      }, { now: nowMs });
      if (!r.duplicate) marked.push(sourceId);
    } catch (e) {
      console.warn(`[SourceBlindness] could not record ${sourceId} as never seen: ${e.message}`);
    }
  }
  if (marked.length) await bus.pumpConsumer(CONSUMER, { now: nowMs });
  return marked;
}

// ── reading ──────────────────────────────────────────────────────────────────

/**
 * Severity is the declared importance, dropped one level when a redundant
 * peer is still fresh — health still flows if one of two apps has gone quiet.
 * Computed at READ time from the current peer state, so it stays true as the
 * peers change and nothing has to be re-folded.
 */
function _effective(f, stateById) {
  const d = nativeSources.describe(f.source_id);
  const peers = nativeSources.groupPeers(f.source_id);
  const freshPeers = peers.filter((id) => {
    const ps = stateById.get(id);
    const pf = ps && ps.active_finding_id ? _finding(ps.active_finding_id) : null;
    return ps && (ps.basis_at || ps.last_success_at) && !(pf && pf.status === 'active');
  });
  const severity = freshPeers.length ? nativeSources.lowerImportance(d.importance) : d.importance;
  return { d, severity, coveredBy: freshPeers };
}

function _shape(f, stateById, nowMs, attention) {
  const { d, severity, coveredBy } = _effective(f, stateById);
  const basisMs = f.basis_at ? Date.parse(f.basis_at) : null;
  const why = f.condition === 'moving-without-fix'
    ? `The phone reported travelling and no location fix has arrived since — the location sensor may have stopped (permission, or background location off) even though the app is still talking to NEURO.`
    : f.condition === 'never-seen'
    ? `NEURO has never heard from it since it started watching — it may not be installed, or may never have been granted access. Without it, NEURO is missing ${d.what}.`
    : f.condition === 'failing'
      ? `${f.failure_count} deliveries in a row have failed. Until it recovers, NEURO is missing ${d.what}.`
      : `Nothing new has been observed since ${f.basis_at}. Until it reports, NEURO is missing ${d.what}.`;
  return {
    findingId: f.finding_id,
    source: f.source_id,
    label: d.label,
    status: f.status,
    condition: f.condition,
    change: f.change,
    repeats: f.repeats,
    firstDetectedAt: f.first_detected_at,
    lastSeenAt: f.last_seen_at,
    resolvedAt: f.resolved_at,
    resolution: f.resolution || null,
    lastSuccessAt: f.last_success_at,
    lastObservedOrSuccessAt: f.basis_at,
    failureCount: f.failure_count,
    staleForMs: f.status === 'active' && basisMs ? nowMs - basisMs : null,
    staleAfterMs: f.stale_after_ms,
    confidence: f.confidence,
    importance: d.importance,
    severity,
    coveredBy,
    whyItMatters: why,
    evidence: JSON.parse(f.evidence_json),
    attention: attention || null,
  };
}

function _attentionFor(id) {
  const a = db.get('SELECT * FROM source_blind_attention WHERE finding_id = ?', [id]);
  if (!a) return null;
  return {
    mode: a.mode, firstDecidedAt: a.first_decided_at, lastDecidedAt: a.last_decided_at,
    decisions: a.decisions, wouldPush: a.would_push === 1, pushedAt: a.pushed_at,
    last: JSON.parse(a.last_decision_json),
  };
}

function getFindings({ status = null, now = Date.now(), limit = 50 } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const stateById = new Map(db.all('SELECT * FROM source_blind_state').map((r) => [r.source_id, r]));
  const rows = status
    ? db.all('SELECT * FROM source_blind_findings WHERE status = ? ORDER BY first_detected_at DESC LIMIT ?', [status, limit])
    : db.all('SELECT * FROM source_blind_findings ORDER BY first_detected_at DESC LIMIT ?', [limit]);
  return rows.map((f) => _shape(f, stateById, nowMs, _attentionFor(f.finding_id)));
}

function status() {
  const c = bus.getStatus().consumers.find((x) => x.name === CONSUMER) || null;
  const counts = {};
  for (const r of db.all('SELECT status, COUNT(*) AS n FROM source_blind_findings GROUP BY status')) counts[r.status] = r.n;
  let watchingSince = null;
  try { watchingSince = db.getState(SINCE_KEY) || null; } catch { /* unreadable is not "never" */ }
  return {
    evaluator: CONSUMER,
    mode: mode(),
    lastRunAt: c ? c.lastProcessedAt : null,
    lag: c ? c.lag : null,
    lastError: c ? c.lastError : null,
    lastErrorAt: c ? c.lastErrorAt : null,
    deadLettered: c ? c.deadLettered : 0,
    findings: { active: counts.active || 0, resolved: counts.resolved || 0 },
    watchingSince,
  };
}

// ── the attention boundary ───────────────────────────────────────────────────

/**
 * Active findings as ambient-push OBSERVATIONS — the same currency every other
 * ambient candidate uses, so they pass through the same `worthInterrupting`
 * and the same universal vetoes. Only findings not yet delivered for this
 * episode are offered: once pushed (live) a finding is never pushed again
 * unless its condition CHANGES, which is the "stale → stale is not news" rule
 * at the delivery end.
 */
function observations({ now = Date.now() } = {}) {
  const out = [];
  for (const f of getFindings({ status: 'active', now })) {
    const a = f.attention;
    if (a && a.pushedAt && f.change !== 'change') continue;
    const nowMs = now instanceof Date ? now.getTime() : now;
    const live = liveEligible(f, nowMs);
    out.push({
      kind: 'source-blind',
      findingId: f.findingId,
      liveEligible: live.eligible,
      liveWhy: live.why,
      source: f.source,
      severity: f.severity,
      confidence: f.confidence,
      text: f.condition === 'failing' ? `${f.label} keeps failing.` : f.condition === 'moving-without-fix'
        ? `${f.label} has not sent a fix since you started travelling.` : f.condition === 'never-seen'
        ? `${f.label} has never reported.` : `${f.label} has gone quiet.`,
      detail: f.whyItMatters,
      // Build 14Q: what the bounded investigation found, if one ran — so IF
      // the attention policy decides to say something, it says the useful
      // thing ("open SAiM on the phone"). It changes no decision.
      investigation: _investigationFor(f),
    });
  }
  return out;
}

function _investigationFor(f) {
  try {
    const investigations = require('./investigations');
    const inv = investigations.byDedupe(`${investigations.TYPE}:${f.source}:${f.findingId}`);
    if (!inv) return null;
    const s = investigations.summaryFor(inv);
    return { id: inv.id, state: inv.state, likelyCause: s.likelyCause, confidence: s.confidence, recommended: s.recommended, eligible: s.attention.eligible };
  } catch {
    return null; // a missing table or bad row must never cost the attention pass
  }
}

/**
 * Record what the attention policy said about a finding. Called by
 * ambient-push on its normal pass, in BOTH modes — in shadow it is the only
 * effect. Never throws: a bookkeeping failure must not cost the push pass.
 */
function recordAttention(findingId, decision, { now = Date.now(), pushed = false } = {}) {
  try {
    const iso = new Date(now instanceof Date ? now.getTime() : now).toISOString();
    const json = JSON.stringify(decision);
    db.run(
      `INSERT INTO source_blind_attention (finding_id, mode, first_decided_at, last_decided_at, decisions, would_push, pushed_at, last_decision_json)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(finding_id) DO UPDATE SET mode = excluded.mode, last_decided_at = excluded.last_decided_at,
         decisions = decisions + 1, would_push = MAX(would_push, excluded.would_push),
         pushed_at = COALESCE(pushed_at, excluded.pushed_at), last_decision_json = excluded.last_decision_json`,
      [findingId, mode(), iso, iso, decision && decision.push ? 1 : 0, pushed ? iso : null, json]
    );
  } catch (e) {
    console.warn(`[SourceBlindness] could not record the attention decision for ${findingId}: ${e.message}`);
  }
}

module.exports = {
  CONSUMER, TYPES, FAIL_THRESHOLD, CONFIDENCE, LIVE_MIN_SILENCE_MS,
  mode, liveEligible, applyEvent, checkExpected, getFindings, status, observations, recordAttention,
};
