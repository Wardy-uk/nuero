'use strict';

/**
 * "A sense went blind" — the first bounded autonomous investigation (Build 14).
 * PURE: no DB, no network, no clock. The store and runner (investigations.js)
 * gather evidence through the probes named here and hand it back.
 *
 *   live source-blind finding → gather bounded evidence → hypothesise from a
 *   FIXED set → confidence from counted evidence → IGNORE | MONITOR | PREPARE
 *
 * ── What it may look at ─────────────────────────────────────────────────────
 * `PROBES` is the whole list, and every probe is a read of NEURO's own
 * operational state about SOURCES — health rows, the blindness fold, sibling
 * sources from the same app, the event spine, the sync job, process uptime.
 * Nothing here can name a mailbox, a vault note, a person, a health metric or
 * the internet: an investigation about a sensor has no reason to.
 *
 * ── What it may conclude ────────────────────────────────────────────────────
 * `HYPOTHESES` is a closed set. Each carries the evidence ids that support and
 * contradict it — never prose reasoning. Confidence is COUNTED: high needs two
 * independent probes agreeing and nothing against; one probe is medium; any
 * contradiction is low. "unknown" is a real answer and the default.
 *
 * ── What it may prepare ─────────────────────────────────────────────────────
 * `FIXES` is a closed allowlist of enum kinds, each classified through the
 * authority matrix. A fix is a recommendation with `executes: false`. Build 15:
 * ONE kind (`retry-sync`) may be run by self-heal.js — only for a source with a
 * named op, only at high confidence, once per outage, and only counted as
 * working when the source is SEEN to recover. There is still no command string
 * anywhere to run.
 */

const MAX_PROBES = 8;
const PROBE_TIMEOUT_MS = 2000;
const TOTAL_TIMEOUT_MS = 8000;
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const SIBLING_WINDOW_MS = 2 * 60 * 60 * 1000;
const INGEST_ALIVE_MS = 60 * 60 * 1000;
const RESTART_WINDOW_MS = 30 * 60 * 1000;

const PROBES = Object.freeze(['source-health', 'blind-state', 'app-siblings', 'group-peers', 'ingest-alive', 'event-spine', 'sync-job', 'process-uptime']);

const HYPOTHESES = Object.freeze([
  'source-offline',      // the sensor stopped while its app is alive (permission, background off)
  'agent-not-running',   // the app / agent itself has not run
  'upstream-unavailable',// the provider answers with errors
  'auth-expired',        // the provider refuses the credential
  'sync-job-failed',     // NEURO's own pull job is failing or not running
  'consumer-failed',     // NEURO's event spine is not folding what arrives
  'delivery-delayed',    // nothing is arriving from ANY device — transport, not the source
  'expected-quiet',      // not blindness at all
  'unknown',
]);

// Which pull job feeds which source (only pull sources have one).
const SOURCE_JOB = Object.freeze({ 'microsoft.calendar': 'calendar-sync', 'neuro.selftest': 'selftest-sync' });

// Build 15: pull sources whose own sync NEURO can re-run (self-heal.OPS keys —
// a test pins the two lists equal). Only these get a retry for a transient
// upstream failure; for anything else that cause is watched, not acted on.
const RETRYABLE_SOURCES = Object.freeze(['microsoft.calendar', 'homeassistant.presence', 'neuro.selftest']);

/** The probe plan for one source. Bounded by construction. */
function plan(sourceId, describe) {
  const d = describe(sourceId);
  const out = ['source-health', 'blind-state'];
  if (d.push) out.push('app-siblings', 'ingest-alive');
  if (d.group) out.push('group-peers');
  if (!d.push && SOURCE_JOB[sourceId]) out.push('sync-job');
  out.push('event-spine', 'process-uptime');
  return out.slice(0, MAX_PROBES);
}

function _client(sourceId) {
  const i = String(sourceId).indexOf('.');
  return i > 0 ? sourceId.slice(i + 1) : null;
}

/** Siblings: other sources delivered by the SAME app (e.g. *.saim-ios). */
function appSiblings(sourceId, allSourceIds) {
  const c = _client(sourceId);
  if (!c || c === 'unknown' || c === 'agent') return [];
  return allSourceIds.filter((id) => id !== sourceId && _client(id) === c);
}

function _ms(iso) { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; }
function _basis(row) {
  if (!row) return null;
  const o = _ms(row.last_observed_at); const s = _ms(row.last_success_at);
  return o != null && s != null ? Math.max(o, s) : (o ?? s);
}

function classifyFailure(detail) {
  const t = String(detail || '');
  if (!t) return null;
  if (/\b(401|403)\b|auth|token|consent|unauthori[sz]ed|AADSTS/i.test(t)) return 'auth';
  if (/\b5\d\d\b|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|network|unavailable|fetch failed/i.test(t)) return 'upstream';
  if (/not a function|TypeError|ReferenceError|SyntaxError/i.test(t)) return 'neuro-code';
  return 'other';
}

/**
 * Turn raw probe results into evidence items + signals. Pure.
 * @param results  [{ probe, status: 'ok'|'unavailable'|'skipped', data }]
 * @returns { items: [{id, probe, status, signal, fact}], signals: Set }
 */
function toEvidence(sourceId, finding, results, nowMs) {
  const items = [];
  const add = (probe, status, signal, fact) => items.push({ id: `ev:${probe}:${items.length + 1}`, probe, status, signal: signal || null, fact: fact || null });
  const silenceStart = _ms(finding && finding.lastObservedOrSuccessAt);
  for (const r of results) {
    if (r.status !== 'ok') { add(r.probe, r.status, null, null); continue; }
    const d = r.data || {};
    switch (r.probe) {
      case 'source-health': {
        const row = d.row;
        if (!row) { add(r.probe, 'ok', 'never-healthy', { state: null }); break; }
        const fc = classifyFailure(row.failure_detail);
        add(r.probe, 'ok', row.consecutive_failures >= 3 ? `failing-${fc || 'other'}` : (row.freshness === 'stale' ? 'stale' : `state-${row.state}`),
          { state: row.state, freshness: row.freshness, consecutiveFailures: row.consecutive_failures || 0, failureClass: fc,
            lastSuccessAt: row.last_success_at || null, lastObservedAt: row.last_observed_at || null });
        break;
      }
      case 'blind-state': {
        const s = d.state;
        add(r.probe, 'ok', s && s.consecutive_failures >= 3 ? `failing-${classifyFailure(s.last_failure) || 'other'}` : 'not-failing',
          { consecutiveFailures: s ? s.consecutive_failures : 0, failureClass: s ? classifyFailure(s.last_failure) : null });
        break;
      }
      case 'app-siblings': {
        const sibs = d.rows || [];
        if (!sibs.length) { add(r.probe, 'ok', 'no-siblings', { count: 0 }); break; }
        const fresh = sibs.filter((x) => x.row && x.row.freshness === 'fresh');
        const stoppedTogether = sibs.filter((x) => {
          const b = _basis(x.row);
          return x.row && x.row.freshness !== 'fresh' && b != null && silenceStart != null && Math.abs(b - silenceStart) <= SIBLING_WINDOW_MS;
        });
        const signal = fresh.length ? 'siblings-fresh' : stoppedTogether.length ? 'siblings-stopped-together' : 'siblings-silent';
        add(r.probe, 'ok', signal, { count: sibs.length, fresh: fresh.map((x) => x.sourceId), stoppedTogether: stoppedTogether.map((x) => x.sourceId) });
        break;
      }
      case 'group-peers': {
        const peers = d.rows || [];
        const fresh = peers.filter((x) => x.row && x.row.freshness === 'fresh').map((x) => x.sourceId);
        add(r.probe, 'ok', fresh.length ? 'peer-covering' : (peers.length ? 'peers-blind' : 'no-peers'), { fresh });
        break;
      }
      case 'ingest-alive': {
        const newest = _ms(d.newestPushAt);
        const alive = newest != null && nowMs - newest <= INGEST_ALIVE_MS;
        add(r.probe, 'ok', alive ? 'ingest-alive' : 'ingest-silent', { newestPushAt: d.newestPushAt || null });
        break;
      }
      case 'event-spine': {
        const bad = (d.consumers || []).filter((c) => c.deadLettered > 0 || (c.lastError && c.lag > 0)).map((c) => c.name);
        const relevant = bad.filter((n) => ['source-health', 'source-blindness'].includes(n));
        add(r.probe, 'ok', relevant.length ? 'consumer-unhealthy' : 'consumer-healthy', { unhealthy: bad });
        break;
      }
      case 'sync-job': {
        const j = d.job;
        if (!j) { add(r.probe, 'ok', 'job-unknown', null); break; }
        const failing = j.last24h && j.last24h.failed > 0 && (!j.lastSuccessAt || (j.lastFailureAt && j.lastFailureAt > j.lastSuccessAt));
        const stalled = !j.lastSuccessAt || (nowMs - _ms(j.lastSuccessAt) > 6 * 60 * 60 * 1000);
        add(r.probe, 'ok', failing ? 'job-failing' : stalled ? 'job-stalled' : 'job-healthy',
          { job: j.name, lastSuccessAt: j.lastSuccessAt || null, lastFailureAt: j.lastFailureAt || null, failed24h: j.last24h ? j.last24h.failed : null });
        break;
      }
      case 'process-uptime': {
        const startedAt = nowMs - (d.uptimeMs || 0);
        const near = silenceStart != null && Math.abs(startedAt - silenceStart) <= RESTART_WINDOW_MS;
        add(r.probe, 'ok', near ? 'restart-near-silence' : 'no-restart-near-silence', { startedAt: new Date(startedAt).toISOString() });
        break;
      }
      default:
        add(r.probe, 'skipped', null, null);
    }
  }
  return items;
}

// Which signals support / contradict each hypothesis. A probe counts once.
const RULES = Object.freeze({
  'agent-not-running': { support: ['stale', 'siblings-stopped-together', 'ingest-alive'], contra: ['siblings-fresh', 'ingest-silent'], pushOnly: true },
  'source-offline': { support: ['stale', 'siblings-fresh', 'ingest-alive'], contra: ['siblings-stopped-together', 'ingest-silent'], pushOnly: true },
  'upstream-unavailable': { support: ['failing-upstream'], contra: ['failing-auth'] },
  'auth-expired': { support: ['failing-auth'], contra: ['failing-upstream'] },
  'sync-job-failed': { support: ['job-failing', 'job-stalled', 'failing-neuro-code'], contra: ['job-healthy'] },
  'consumer-failed': { support: ['consumer-unhealthy'], contra: ['consumer-healthy'] },
  'delivery-delayed': { support: ['ingest-silent', 'restart-near-silence'], contra: ['ingest-alive'], pushOnly: true },
});

const LEVEL = Object.freeze({ high: 0.85, medium: 0.6, low: 0.3 });

/** Bounded, counted confidence. Never 1. */
function confidenceFor(supportProbes, contraCount) {
  if (contraCount > 0 || supportProbes === 0) return { level: 'low', value: LEVEL.low };
  if (supportProbes >= 2) return { level: 'high', value: LEVEL.high };
  return { level: 'medium', value: LEVEL.medium };
}

/** Pure. Score the fixed hypothesis set against the evidence. */
function hypothesise(items, { push = false, lifecycle = 'expected', findingActive = true } = {}) {
  const ok = items.filter((i) => i.status === 'ok' && i.signal);
  if (lifecycle !== 'expected' || !findingActive) {
    return [{ type: 'expected-quiet', confidence: LEVEL.medium, level: 'medium', supportingEvidenceRefs: [], contradictingEvidenceRefs: [] }];
  }
  const out = [];
  for (const [type, rule] of Object.entries(RULES)) {
    if (rule.pushOnly && !push) continue;
    const sup = ok.filter((i) => rule.support.includes(i.signal));
    const con = ok.filter((i) => rule.contra.includes(i.signal));
    if (!sup.length) continue;
    // "stale" alone says only that the source is silent — it is the PREMISE
    // of every push hypothesis, so it cannot be one of the two agreeing probes.
    const independent = new Set(sup.filter((i) => i.signal !== 'stale').map((i) => i.probe)).size;
    if (!independent) continue;
    const c = confidenceFor(independent, con.length);
    out.push({ type, confidence: c.value, level: c.level, supportingEvidenceRefs: sup.map((i) => i.id), contradictingEvidenceRefs: con.map((i) => i.id) });
  }
  out.sort((a, b) => b.confidence - a.confidence || a.type.localeCompare(b.type));
  // A tie at the top is not an answer.
  if (!out.length || out[0].level === 'low' || (out[1] && out[1].confidence === out[0].confidence)) {
    out.unshift({ type: 'unknown', confidence: LEVEL.low, level: 'low', supportingEvidenceRefs: [], contradictingEvidenceRefs: [] });
  }
  return out;
}

// The fix allowlist. `capability` is the authority-matrix row the fix would
// exercise; its authority is READ from the matrix, never restated here.
const FIXES = Object.freeze({
  'open-app': { capability: 'push.self', requiresHuman: true, kind: 'manual-device-action' },
  'check-sensor-permission': { capability: 'push.self', requiresHuman: true, kind: 'manual-device-action' },
  'relaunch-agent': { capability: 'push.self', requiresHuman: true, kind: 'manual-device-action' },
  'reconnect-account': { capability: 'config.security', requiresHuman: true, kind: 'reauth-request' },
  'retry-sync': { capability: 'source.retry-sync', requiresHuman: false, kind: 'retry' },
  'retry-consumer': { capability: 'internal.state', requiresHuman: false, kind: 'retry' },
});

const FIX_FOR = Object.freeze({
  'agent-not-running': (sourceId) => (sourceId === 'desktop.agent' ? 'relaunch-agent' : 'open-app'),
  'source-offline': () => 'check-sensor-permission',
  'auth-expired': () => 'reconnect-account',
  // Build 15: a provider answering with errors is usually transient; for a
  // source NEURO pulls itself, one retry is the proportionate response.
  'upstream-unavailable': (sourceId) => (RETRYABLE_SOURCES.includes(sourceId) ? 'retry-sync' : null),
  'sync-job-failed': () => 'retry-sync',
  'consumer-failed': () => 'retry-consumer',
});

/** Pure. Build a prepared fix through the allowlist + matrix, or refuse. */
function prepareFix(kind, { matrix, investigationId, version }) {
  const f = FIXES[kind];
  if (!f) return { ok: false, why: `${kind} is not an allowed fix` };
  const cap = matrix.CAPABILITIES[f.capability];
  if (!cap) return { ok: false, why: `${kind} maps to no authority-matrix capability` };
  // Anything that would need approval stays a recommendation; nothing executes.
  const state = cap.authority === 'A3' || cap.authority === 'A4' || f.kind === 'retry' ? 'awaiting_approval' : 'prepared';
  return {
    ok: true,
    fix: { id: `fix:${investigationId}:v${version}`, kind, capability: f.capability, authority: cap.authority, fixKind: f.kind,
      requiresHuman: f.requiresHuman, executes: false, status: 'prepared' },
    state,
  };
}

/** Pure. IGNORE | MONITOR | PREPARE, with the state and stop reason it implies. */
function decide({ hypotheses, sourceId, findingActive, evidenceAvailable }) {
  if (!findingActive) return { decision: 'IGNORE', state: 'resolved', stopReason: 'recovered', fixKind: null };
  const top = hypotheses[0];
  if (top.type === 'expected-quiet') return { decision: 'IGNORE', state: 'dismissed', stopReason: 'finding-not-live', fixKind: null };
  if (top.type === 'unknown') {
    return { decision: 'MONITOR', state: 'monitoring', stopReason: evidenceAvailable ? 'inconclusive' : 'evidence-unavailable', fixKind: null };
  }
  const make = FIX_FOR[top.type];
  const kind = make ? make(sourceId) : null;
  if (!kind) return { decision: 'MONITOR', state: 'monitoring', stopReason: 'cause-identified', fixKind: null };
  return { decision: 'PREPARE', state: 'prepared', stopReason: 'cause-identified', fixKind: kind };
}

// Human-facing words, from templates only — no generated prose is stored.
const CAUSE_TEXT = Object.freeze({
  'source-offline': 'the sensor has stopped while its app is still reporting (permission or background access)',
  'agent-not-running': 'the app has not run — its other senses stopped at the same time',
  'upstream-unavailable': 'the provider is answering with errors',
  'auth-expired': 'the provider is refusing NEURO\'s sign-in',
  'sync-job-failed': 'NEURO\'s own sync job is failing',
  'consumer-failed': 'NEURO is not processing what arrives',
  'delivery-delayed': 'nothing is arriving from any device — the route in, not this source',
  'expected-quiet': 'this is expected quiet, not blindness',
  unknown: 'not enough evidence to say',
});
const FIX_TEXT = Object.freeze({
  'open-app': 'Open the app on the phone.',
  'check-sensor-permission': 'Check the app\'s permission for this sense in Settings.',
  'relaunch-agent': 'Start the NEURO desktop agent on the laptop.',
  'reconnect-account': 'Reconnect the account in NEURO → Settings.',
  'retry-sync': 'Run the sync again (NEURO → Sources).',
  'retry-consumer': 'Retry the stuck event consumer (NEURO → NEURO Health).',
});

function _facts(items) {
  const lines = [];
  for (const i of items) {
    if (i.status === 'unavailable') { lines.push(`${i.probe}: could not be read`); continue; }
    if (!i.signal) continue;
    const f = i.fact || {};
    switch (i.signal) {
      case 'stale': lines.push(`last delivery ${f.lastObservedAt || f.lastSuccessAt || 'unknown'}`); break;
      case 'siblings-stopped-together': lines.push(`stopped at the same time: ${f.stoppedTogether.join(', ')}`); break;
      case 'siblings-fresh': lines.push(`still reporting from the same app: ${f.fresh.join(', ')}`); break;
      case 'ingest-alive': lines.push('server ingestion is healthy'); break;
      case 'ingest-silent': lines.push('no device has delivered anything in the last hour'); break;
      case 'peer-covering': lines.push(`covered meanwhile by: ${f.fresh.join(', ')}`); break;
      case 'consumer-unhealthy': lines.push(`event consumer unhealthy: ${f.unhealthy.join(', ')}`); break;
      case 'job-failing': lines.push(`sync job ${f.job} failing (last success ${f.lastSuccessAt || 'never'})`); break;
      case 'job-stalled': lines.push(`sync job ${f.job} has not succeeded recently`); break;
      case 'restart-near-silence': lines.push(`NEURO restarted near when it went quiet (${f.startedAt})`); break;
      default:
        if (i.signal.startsWith('failing-')) lines.push(`${f.consecutiveFailures} failures in a row (${f.failureClass || 'unclassified'})`);
    }
  }
  return [...new Set(lines)];
}

/** Pure. What NEURO did about it — never "fixed" without a verified recovery. */
function actionTakenText(fix) {
  if (!fix) return 'No action taken.';
  const attempt = fix.autoAttempt;
  if (fix.status === 'executing') return 'NEURO is retrying it now.';
  if (fix.status === 'verifying') return 'NEURO retried it and is checking whether it recovered.';
  if (fix.status === 'verified') return 'NEURO retried it, and it recovered after the retry.';
  if (attempt && attempt.outcome === 'failed') return 'NEURO retried it once; it did not recover. Over to you.';
  if (attempt && attempt.outcome === 'uncertain') return 'NEURO retried it once and could not verify the result.';
  return 'No action taken.';
}

/** Pure. The concise summary the spec asks for — evidence and conclusion only. */
function summarise(inv, label) {
  const top = (inv.hypotheses || [])[0] || { type: 'unknown', level: 'low' };
  return {
    senseLost: label,
    found: _facts(inv.evidence || []),
    likelyCause: CAUSE_TEXT[top.type],
    confidence: top.level === 'high' ? 'High' : top.level === 'medium' ? 'Medium' : 'Low',
    recommended: inv.preparedAction && inv.preparedAction.status === 'prepared' ? FIX_TEXT[inv.preparedAction.kind] : (inv.state === 'monitoring' ? 'Nothing yet — watching.' : null),
    actionTaken: actionTakenText(inv.preparedAction),
  };
}

module.exports = {
  MAX_PROBES, PROBE_TIMEOUT_MS, TOTAL_TIMEOUT_MS, EXPIRY_MS, PROBES, HYPOTHESES, FIXES, LEVEL, SOURCE_JOB, RETRYABLE_SOURCES,
  plan, appSiblings, classifyFailure, toEvidence, hypothesise, confidenceFor, prepareFix, decide, summarise, actionTakenText,
};
