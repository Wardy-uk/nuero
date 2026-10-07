'use strict';

/**
 * "This sense keeps becoming unhealthy and recovering" — the SECOND bounded
 * investigation type (Build 17E–K, 7 Oct 2026). PURE: no DB, no network, no
 * clock. The runner (degradation-investigations.js) reads and records.
 *
 * Source blindness asks "has this sense stopped NOW?" (12h stale, 3 failures,
 * and the live threshold of Build 13). Repeated degradation asks a different
 * question: each wobble is too short to be blindness, but it keeps happening.
 *
 * ── Episodes (17G) ─────────────────────────────────────────────────────────
 * An EPISODE is one unhealthy stretch that RECOVERED:
 *   failing   source.sync.failed run(s) ended by the next source.sync.succeeded
 *             (pull sources) — from the event spine, so short ones count
 *   stale     a stale source-blindness finding resolved by a delivery
 *             (push sources)
 * Each carries source, start, end, duration, failure mode, delivery failures,
 * recovery evidence, failure reasons, the nearest process boot, and why it is
 * EXCLUDED from the count, if it is.
 *
 * ── Exclusions (17F) — not degradation, measured ───────────────────────────
 *   still-unhealthy       no recovery yet: that is blindness, not this
 *   staged-canary         neuro.selftest faults armed by the outage script
 *   neuro-code            NEURO's own bug ("fetchStates is not a function")
 *   deploy-restart        began within 10 min of a NEURO process boot
 *   quiet                 resolved as "transport alive" — the app was reporting
 *   expected-overnight    an iPhone app silent from the evening to the next
 *                         morning (≤20h, recovered before 14:00): measured as
 *                         every iOS stale episode on 3–4 Oct
 *
 * ── Trigger (17F) — chosen by REPLAY of the live spine, 2–7 Oct 2026 ───────
 * MIN_EPISODES (3) counted episodes in a cluster, the latest three inside
 * WINDOW_DAYS (7). Replayed over the spine's whole history (59 NEURO boots,
 * 2–7 Oct): at 2 it raised two investigations that are noise (calendar's two
 * 2-minute empty Graph answers; the NEURO app's Reminders, silent through two
 * days); at 3 it raised none. HA's three failures were one deploy-restart, one
 * NEURO bug and one real 2-minute timeout. A one-off never triggers.
 *
 * ── Conclusions (17I/J) ────────────────────────────────────────────────────
 * HYPOTHESES is closed; confidence is COUNTED (two independent probes agreeing
 * and nothing against = high). DECISIONS are IGNORE | MONITOR | PREPARE, and
 * a prepared fix is a manual step with executes:false — Build 17 adds NO
 * automatic execution for this type (self-heal only reads source_blindness).
 */

const TYPE = 'repeated_source_degradation';
const MIN_EPISODES = 3;
const WINDOW_DAYS = 7;
const CLUSTER_GAP_DAYS = 7;          // an episode more than this after the last starts a new cluster
const CLUSTER_QUIET_DAYS = 7;        // no counted episode for this long → stable again, close
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const OVERNIGHT_MAX_MS = 20 * 60 * 60 * 1000;
const CONSEQUENTIAL_EPISODES = 5;    // 17K: recurrence that is worth Nick's attention
const CONSEQUENTIAL_UNHEALTHY_MS = 6 * 60 * 60 * 1000;
const EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PROBES = 8;
const DAY_MS = 86400000;

const PROBES = Object.freeze(['episode-history', 'failure-reasons', 'provider-check', 'sync-job', 'app-heartbeat',
  'co-occurrence', 'process-boots', 'investigation-history', 'self-heal-history', 'queue-reports']);

const HYPOTHESES = Object.freeze([
  'upstream-intermittent',        // the provider answers with errors now and then
  'app-repeatedly-stopping',      // the app / agent itself keeps stopping
  'sync-job-unstable',            // NEURO's own pull job keeps failing or being skipped
  'connectivity-intermittent',    // several sources wobble at the same moments
  'auth-intermittent',            // the provider refuses the credential now and then
  'deployment-restart-related',   // the wobbles line up with NEURO restarts
  'expected-platform-background', // an iPhone app asleep between openings
  'unknown',
]);

const SOURCE_JOB = Object.freeze({ 'microsoft.calendar': 'calendar-sync', 'neuro.selftest': 'selftest-sync' });
const PROVIDER_CHECKED = Object.freeze(['microsoft.calendar', 'homeassistant.presence', 'neuro.selftest']);

function _ms(iso) { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; }
function _client(sourceId) { const i = String(sourceId).indexOf('.'); return i > 0 ? sourceId.slice(i + 1) : null; }
function isMobileClient(sourceId) { return /-ios$/.test(_client(sourceId) || ''); }

function classifyReason(reason, error) {
  const t = `${reason || ''} ${error || ''}`;
  if (/selftest-fault/.test(t)) return 'staged';
  if (/not a function|TypeError|ReferenceError|SyntaxError/i.test(t)) return 'neuro-code';
  if (/\b(401|403)\b|auth|token|consent|unauthori[sz]ed|AADSTS/i.test(t)) return 'auth';
  if (/timeout|timed out|aborted|ECONN|ENOTFOUND|EAI_AGAIN|network|unreachable|fetch failed/i.test(t)) return 'network';
  if (/\b5\d\d\b|unavailable|no-events|empty/i.test(t)) return 'upstream';
  return 'other';
}

/**
 * Failure episodes from the spine, PURE. `events` ordered by seq:
 * [{ type, occurredAt, reason, error }] for ONE pull source.
 */
function failureEpisodes(sourceId, events) {
  const out = [];
  let cur = null;
  for (const e of events) {
    if (e.type === 'source.sync.failed') {
      if (!cur) cur = { sourceId, mode: 'failing', start: e.occurredAt, end: null, deliveryFailures: 0, reasons: [], recovery: null };
      cur.deliveryFailures += 1;
      cur.reasons.push(classifyReason(e.reason, e.error));
    } else if (e.type === 'source.sync.succeeded' && cur) {
      cur.end = e.occurredAt;
      cur.recovery = 'sync-succeeded';
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Stale episodes from source-blindness findings, PURE. */
function staleEpisodes(sourceId, findings) {
  return findings.filter((f) => f.condition === 'stale' && f.resolution !== 'retired').map((f) => ({
    sourceId, mode: 'stale', start: f.basisAt || f.firstDetectedAt, end: f.resolvedAt || null, deliveryFailures: 0, reasons: [],
    recovery: f.resolvedAt ? (f.resolution === 'transport-alive' ? 'transport-alive' : 'observation-received') : null,
  }));
}

/**
 * Pure. Why an episode does not count, or null. `localMinute(ms)` is injected
 * so the overnight rule is judged on Nick's wall clock.
 */
function exclusionFor(ep, { boots = [], localMinute }) {
  if (!ep.end) return 'still-unhealthy';
  if (ep.reasons.length && ep.reasons.every((r) => r === 'staged')) return 'staged-canary';
  if (ep.reasons.includes('neuro-code')) return 'neuro-code';
  const s = _ms(ep.start); const e = _ms(ep.end);
  if (s != null && boots.some((b) => Math.abs(b - s) <= RESTART_WINDOW_MS)) return 'deploy-restart';
  if (ep.recovery === 'transport-alive') return 'quiet';
  if (ep.mode === 'stale' && isMobileClient(ep.sourceId) && s != null && e != null && localMinute) {
    const ls = localMinute(s); const le = localMinute(e);
    const startHour = +ls.slice(11, 13); const endHour = +le.slice(11, 13);
    const evening = startHour >= 17 || startHour < 6;
    const sameNight = le.slice(0, 10) <= addDay(ls.slice(0, 10)) && (le.slice(0, 10) > ls.slice(0, 10) || startHour < 6);
    if (evening && e - s <= OVERNIGHT_MAX_MS && sameNight && endHour < 14) return 'expected-overnight';
  }
  return null;
}
function addDay(day) { return new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) + DAY_MS).toISOString().slice(0, 10); }

/** Pure. Annotate every episode with its exclusion and duration. */
function annotate(episodes, ctx) {
  return episodes.map((ep) => {
    const s = _ms(ep.start); const e = _ms(ep.end);
    const nearBoot = s != null ? (ctx.boots || []).find((b) => Math.abs(b - s) <= RESTART_WINDOW_MS) : null;
    return { ...ep, durationMs: s != null && e != null ? Math.max(0, e - s) : null,
      nearBootAt: nearBoot ? new Date(nearBoot).toISOString() : null, excluded: exclusionFor(ep, ctx) };
  }).sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

/**
 * Pure. The CURRENT degradation cluster for a source, and whether it triggers.
 * Clusters chain counted episodes no more than CLUSTER_GAP_DAYS apart; the
 * cluster is identified by its first episode, so one cluster = one
 * investigation however many episodes join it later.
 */
function cluster(annotated, nowMs, { minEpisodes = MIN_EPISODES } = {}) {
  const counted = annotated.filter((e) => !e.excluded);
  if (!counted.length) return { triggered: false, counted: 0, why: 'no counted episodes' };
  let start = 0;
  for (let i = 1; i < counted.length; i += 1) {
    if (_ms(counted[i].start) - _ms(counted[i - 1].end || counted[i - 1].start) > CLUSTER_GAP_DAYS * DAY_MS) start = i;
  }
  const eps = counted.slice(start);
  const last = eps[eps.length - 1];
  const quietFor = nowMs - (_ms(last.end) || _ms(last.start));
  const recent = eps.slice(-minEpisodes);
  const span = recent.length ? _ms(recent[recent.length - 1].start) - _ms(recent[0].start) : Infinity;
  const triggered = eps.length >= minEpisodes && span <= WINDOW_DAYS * DAY_MS;
  const inWindow = eps.filter((e) => _ms(e.start) >= nowMs - WINDOW_DAYS * DAY_MS);
  return {
    triggered, id: `${eps[0].sourceId}@${eps[0].start}`, firstStart: eps[0].start, lastEnd: last.end, episodes: eps, counted: eps.length,
    inWindow: inWindow.length, unhealthyMsInWindow: inWindow.reduce((n, e) => n + (e.durationMs || 0), 0),
    stableAgain: quietFor > CLUSTER_QUIET_DAYS * DAY_MS,
    excludedInPeriod: annotated.filter((e) => e.excluded && _ms(e.start) >= _ms(eps[0].start)).map((e) => ({ start: e.start, excluded: e.excluded })),
    why: triggered ? `${eps.length} episodes, the last ${minEpisodes} within ${Math.round(span / 3600000)}h` : `${eps.length} counted episode(s)`,
  };
}

/** The probe plan for one source. Bounded by construction. */
function plan(sourceId, describe) {
  const d = describe(sourceId);
  const out = ['episode-history'];
  if (!d.push) {
    out.push('failure-reasons');
    if (PROVIDER_CHECKED.includes(sourceId)) out.push('provider-check');
    if (SOURCE_JOB[sourceId]) out.push('sync-job');
  } else {
    out.push('app-heartbeat', 'queue-reports');
  }
  out.push('co-occurrence', 'process-boots', 'investigation-history', 'self-heal-history');
  return out.slice(0, MAX_PROBES);
}

/**
 * Probe results → evidence items with ONE signal each. PURE.
 * results: [{ probe, status, data }]
 */
function toEvidence(sourceId, cl, results) {
  const items = [];
  const add = (probe, status, signal, fact) => items.push({ id: `ev:${probe}:${items.length + 1}`, probe, status, signal: signal || null, fact: fact || null });
  const eps = cl.episodes || [];
  for (const r of results) {
    if (r.status !== 'ok') { add(r.probe, r.status, null, null); continue; }
    const d = r.data || {};
    switch (r.probe) {
      case 'episode-history': {
        const longest = Math.max(0, ...eps.map((e) => e.durationMs || 0));
        add(r.probe, 'ok', isMobileClient(sourceId) ? 'client-mobile' : 'client-not-mobile',
          { episodes: eps.length, longestMs: longest, modes: [...new Set(eps.map((e) => e.mode))], excluded: (cl.excludedInPeriod || []).length });
        break;
      }
      case 'failure-reasons': {
        const all = eps.flatMap((e) => e.reasons || []);
        const n = (k) => all.filter((x) => x === k).length;
        const top = ['network', 'upstream', 'auth', 'neuro-code', 'other'].sort((a, b) => n(b) - n(a))[0];
        const signal = !all.length ? null : n(top) / all.length >= 0.6 ? `reasons-${top}` : 'reasons-mixed';
        add(r.probe, 'ok', signal, { counts: { network: n('network'), upstream: n('upstream'), auth: n('auth'), neuroCode: n('neuro-code'), other: n('other') } });
        break;
      }
      case 'provider-check': {
        const signal = d.auth === 'refused' ? 'provider-auth-refused' : d.answering === true ? 'provider-answering' : d.answering === false ? 'provider-down' : null;
        add(r.probe, 'ok', signal, { answering: d.answering === undefined ? null : d.answering, status: d.status || null });
        break;
      }
      case 'sync-job': {
        const runs = d.runs || {};
        const bad = (runs.failed || 0) + (runs.skipped || 0) + (runs.timeout || 0);
        add(r.probe, 'ok', runs.total == null ? 'job-unknown' : bad >= 2 ? 'job-unstable' : 'job-healthy', { job: d.job || null, ...runs });
        break;
      }
      case 'app-heartbeat': {
        // During each episode, did the SAME app's other senses keep delivering?
        const per = d.perEpisode || [];
        const together = per.filter((p) => p.siblingsDelivered === false).length;
        const alive = per.filter((p) => p.siblingsDelivered === true).length;
        add(r.probe, 'ok', !per.length ? null : together >= alive ? 'app-slept-together' : 'app-alive-during', { together, alive });
        break;
      }
      case 'queue-reports': {
        add(r.probe, 'ok', (d.degraded || 0) > 0 ? 'queue-degraded' : 'queue-clean', { degraded: d.degraded || 0, replayed: d.replayed || 0 });
        break;
      }
      case 'co-occurrence': {
        const shared = d.sharedEpisodes || 0;
        add(r.probe, 'ok', shared >= Math.max(2, Math.ceil(eps.length / 2)) ? 'cross-source' : 'isolated', { sharedEpisodes: shared, withSources: d.withSources || [] });
        break;
      }
      case 'process-boots': {
        const near = (cl.excludedInPeriod || []).filter((x) => x.excluded === 'deploy-restart').length;
        add(r.probe, 'ok', near >= Math.max(1, eps.length) ? 'restarts-near' : 'no-restarts-near', { bootsInPeriod: d.boots || 0, episodesAtRestart: near });
        break;
      }
      case 'investigation-history': {
        add(r.probe, 'ok', (d.blindness || 0) > 0 ? 'blindness-before' : 'no-blindness-before', { blindness: d.blindness || 0, degradation: d.degradation || 0 });
        break;
      }
      case 'self-heal-history': {
        add(r.probe, 'ok', (d.attempts || 0) > 0 ? 'self-healed-before' : 'no-self-heal', { attempts: d.attempts || 0, recovered: d.recovered || 0 });
        break;
      }
      default: add(r.probe, 'skipped', null, null);
    }
  }
  return items;
}

// Which signals support / contradict each hypothesis. A probe counts once.
const RULES = Object.freeze({
  'upstream-intermittent': { support: ['reasons-upstream', 'reasons-network', 'provider-answering'], contra: ['reasons-auth', 'cross-source', 'provider-auth-refused'], anchor: ['reasons-upstream', 'reasons-network'], pullOnly: true },
  'auth-intermittent': { support: ['reasons-auth', 'provider-auth-refused'], contra: ['reasons-upstream', 'reasons-network'], anchor: ['reasons-auth'], pullOnly: true },
  'sync-job-unstable': { support: ['job-unstable', 'reasons-neuro-code'], contra: ['job-healthy'], anchor: ['job-unstable'], pullOnly: true },
  'connectivity-intermittent': { support: ['cross-source', 'reasons-network'], contra: ['isolated'], anchor: ['cross-source'] },
  'app-repeatedly-stopping': { support: ['app-slept-together', 'queue-degraded', 'blindness-before'], contra: ['app-alive-during', 'client-mobile'], anchor: ['app-slept-together'], pushOnly: true },
  'expected-platform-background': { support: ['app-slept-together', 'client-mobile'], contra: ['app-alive-during', 'queue-degraded'], anchor: ['client-mobile'], pushOnly: true },
  'deployment-restart-related': { support: ['restarts-near'], contra: ['no-restarts-near'], anchor: ['restarts-near'] },
});

const LEVEL = Object.freeze({ high: 0.85, medium: 0.6, low: 0.3 });

function confidenceFor(supportProbes, contraCount) {
  if (contraCount > 0 || supportProbes === 0) return { level: 'low', value: LEVEL.low };
  if (supportProbes >= 2) return { level: 'high', value: LEVEL.high };
  return { level: 'medium', value: LEVEL.medium };
}

/** Pure. Score the fixed hypothesis set. */
function hypothesise(items, { push = false } = {}) {
  const ok = items.filter((i) => i.status === 'ok' && i.signal);
  const out = [];
  for (const [type, rule] of Object.entries(RULES)) {
    if (rule.pushOnly && !push) continue;
    if (rule.pullOnly && push) continue;
    const sup = ok.filter((i) => rule.support.includes(i.signal));
    const con = ok.filter((i) => rule.contra.includes(i.signal));
    if (!sup.length) continue;
    if (rule.anchor && !sup.some((i) => rule.anchor.includes(i.signal))) continue;
    const independent = new Set(sup.map((i) => i.probe)).size;
    const c = confidenceFor(independent, con.length);
    out.push({ type, confidence: c.value, level: c.level, supportingEvidenceRefs: sup.map((i) => i.id), contradictingEvidenceRefs: con.map((i) => i.id) });
  }
  out.sort((a, b) => b.confidence - a.confidence || a.type.localeCompare(b.type));
  if (!out.length || out[0].level === 'low' || (out[1] && out[1].confidence === out[0].confidence)) {
    out.unshift({ type: 'unknown', confidence: LEVEL.low, level: 'low', supportingEvidenceRefs: [], contradictingEvidenceRefs: [] });
  }
  return out;
}

// The only fixes this type may prepare: manual steps. No retry, no command.
const FIX_FOR = Object.freeze({
  'app-repeatedly-stopping': (sourceId) => (sourceId === 'desktop.agent' ? 'relaunch-agent' : 'open-app'),
  'auth-intermittent': () => 'reconnect-account',
});

/** Pure. IGNORE | MONITOR | PREPARE. */
function decide({ hypotheses, sourceId, cl }) {
  if (!cl.triggered) return { decision: 'IGNORE', state: 'dismissed', stopReason: 'below-threshold', fixKind: null };
  if (cl.stableAgain) return { decision: 'IGNORE', state: 'resolved', stopReason: 'stable-again', fixKind: null };
  const top = hypotheses[0];
  if (top.type === 'expected-platform-background' || top.type === 'deployment-restart-related') {
    return { decision: 'IGNORE', state: 'dismissed', stopReason: 'expected', fixKind: null };
  }
  if (top.type === 'unknown') return { decision: 'MONITOR', state: 'monitoring', stopReason: 'inconclusive', fixKind: null };
  const make = FIX_FOR[top.type];
  const kind = make ? make(sourceId) : null;
  if (!kind) return { decision: 'MONITOR', state: 'monitoring', stopReason: 'cause-identified', fixKind: null };
  return { decision: 'PREPARE', state: 'prepared', stopReason: 'cause-identified', fixKind: kind };
}

/**
 * Pure. May this investigation be OFFERED to Nick (17K)? The attention policy
 * still decides whether it interrupts. Wobbles that recovered are never news
 * on their own: only a manual step, at a consequential recurrence, at medium
 * confidence or better.
 */
function attentionView(inv, cl) {
  const fix = inv && inv.preparedAction;
  const top = inv && (inv.hypotheses || [])[0];
  if (!inv || !['prepared', 'monitoring', 'awaiting_approval'].includes(inv.state)) return { eligible: false, why: 'closed' };
  if (!fix || fix.status !== 'prepared' || !fix.requiresHuman) return { eligible: false, why: 'nothing for Nick to do — NEURO is watching it' };
  if (!top || top.level === 'low') return { eligible: false, why: 'confidence too low to ask' };
  const consequential = cl && ((cl.inWindow || 0) >= CONSEQUENTIAL_EPISODES || (cl.unhealthyMsInWindow || 0) >= CONSEQUENTIAL_UNHEALTHY_MS);
  if (!consequential) return { eligible: false, why: `not consequential yet (${cl ? cl.inWindow : 0} episodes this week)` };
  return { eligible: true, why: 'a recurring problem with a manual step only Nick can take' };
}

const CAUSE_TEXT = Object.freeze({
  'upstream-intermittent': 'the provider answers with errors now and then',
  'app-repeatedly-stopping': 'the app keeps stopping',
  'sync-job-unstable': 'NEURO\'s own sync job keeps failing',
  'connectivity-intermittent': 'several senses drop out at the same moments — connectivity, not this source',
  'auth-intermittent': 'the provider refuses NEURO\'s sign-in now and then',
  'deployment-restart-related': 'the drop-outs line up with NEURO restarting',
  'expected-platform-background': 'the iPhone app sleeps between openings — normal',
  unknown: 'not enough evidence to say',
});
const FIX_TEXT = Object.freeze({
  'open-app': 'Open the app on the phone and check Background App Refresh.',
  'relaunch-agent': 'Review the NEURO desktop agent on the laptop — restart it, and check what stops it.',
  'reconnect-account': 'Reconnect the account in NEURO → Settings.',
});

function _dur(ms) { if (ms == null) return '?'; if (ms < 3600000) return `${Math.max(1, Math.round(ms / 60000))} min`; return `${Math.round(ms / 360000) / 10}h`; }

/** Pure. The concise summary — evidence and conclusion only, from templates. */
function summarise(inv, label) {
  const top = (inv.hypotheses || [])[0] || { type: 'unknown', level: 'low' };
  const cl = (inv.budget && inv.budget.cluster) || {};
  const longest = cl.longestMs;
  return {
    sense: label,
    pattern: cl.counted ? `${label} has dropped out ${cl.counted} times since ${String(cl.firstStart || '').slice(0, 10)}, recovering each time${longest != null ? ` (longest ${_dur(longest)})` : ''}.` : null,
    likelyCause: CAUSE_TEXT[top.type],
    confidence: top.level === 'high' ? 'High' : top.level === 'medium' ? 'Medium' : 'Low',
    decision: inv.decision,
    recommended: inv.preparedAction && inv.preparedAction.status === 'prepared' ? FIX_TEXT[inv.preparedAction.kind] : (inv.state === 'monitoring' ? 'Nothing yet — watching.' : null),
    actionTaken: 'No action taken — NEURO does not fix this kind of problem by itself.',
  };
}

module.exports = {
  TYPE, MIN_EPISODES, WINDOW_DAYS, CLUSTER_GAP_DAYS, CLUSTER_QUIET_DAYS, RESTART_WINDOW_MS, OVERNIGHT_MAX_MS, CONSEQUENTIAL_EPISODES,
  CONSEQUENTIAL_UNHEALTHY_MS, EXPIRY_MS, MAX_PROBES, PROBES, HYPOTHESES, SOURCE_JOB, LEVEL, CAUSE_TEXT, FIX_TEXT,
  classifyReason, failureEpisodes, staleEpisodes, exclusionFor, annotate, cluster, plan, toEvidence, hypothesise, confidenceFor,
  decide, attentionView, summarise, isMobileClient,
};
