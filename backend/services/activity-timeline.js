'use strict';

/**
 * "What has NEURO done?" — one semantic Activity stream (Build 15A–G).
 *
 * NOT a log viewer and NOT a new store. Every entry is NORMALISED, at read
 * time, from a durable record NEURO already keeps for its own reasons:
 *
 *   source_blind_findings   noticed a sense stop / come back
 *   investigation_events    investigated (the conclusion), recommended, gave up
 *   self_heal_attempts      acted (a safe fix) and verified (did it recover?)
 *   prepared_actions        prepared for approval, Nick decided, sent, verified
 *   external_write_ledger   direct external writes and their outcome
 *   activity_log            authority refusals (folded per day), switch flips
 *   event_log               runtime gaps / failures, source lifecycle changes
 *   goal_loop_events        the hiking loop's meaningful transitions
 *
 * ── One lifecycle, not its plumbing (15C) ──────────────────────────────────
 * An investigation's detected / gathering / evidence / hypothesised events are
 * the plumbing of ONE conclusion; only `decided` becomes an entry. A finding's
 * recovery is not repeated when a self-heal attempt already verified it.
 * Refusals are folded to one entry per machine, capability and day.
 *
 * ── Honest verbs (15F) ─────────────────────────────────────────────────────
 * noticed · investigated · recommended · prepared · retried/sent · verified.
 * "Recovered" only where a verification proved it; otherwise "could not
 * verify", "did not recover", "outcome unknown".
 *
 * ── Privacy (15G) ──────────────────────────────────────────────────────────
 * Headlines are templates over KINDS and labels. No email body, no draft, no
 * recipient address, no health value, no request payload ever reaches an
 * entry; `metadata` carries ids and enums only.
 */

const db = require('../db/database');

const CATEGORIES = Object.freeze(['sensed', 'investigated', 'decided', 'prepared', 'acted', 'verified', 'recovered', 'blocked', 'configured']);
const ACTORS = Object.freeze(['neuro', 'nick', 'external-system', 'system-runtime']);
const FILTERS = Object.freeze(['all', 'investigations', 'actions', 'sources', 'decisions', 'problems', 'approvals']);
const FAILED_STATUSES = Object.freeze(['failed', 'uncertain', 'blocked', 'refused', 'inconclusive']);
const MAX_ENTRIES = 500;

function _json(s, f) { try { return s ? JSON.parse(s) : f; } catch { return f; } }

function _label(sourceId) {
  try { return require('./native-sources').describe(sourceId).label; } catch { return sourceId; }
}

function entry(e) {
  return {
    id: e.id,
    occurredAt: e.occurredAt,
    category: e.category,
    type: e.type,
    headline: e.headline,
    summary: e.summary || null,
    actor: e.actor || 'neuro',
    authority: e.authority || null,
    status: e.status || null,
    subjectRefs: e.subjectRefs || [],
    sourceRefs: e.sourceRefs || [],
    evidenceRefs: e.evidenceRefs || [],
    investigationRef: e.investigationRef || null,
    actionRef: e.actionRef || null,
    findingRef: e.findingRef || null,
    verificationRef: e.verificationRef || null,
    severity: e.severity || 'info',
    userVisible: e.userVisible !== false,
    metadata: e.metadata || {},
  };
}

// ── normalisers (PURE over rows) ────────────────────────────────────────────

const CAUSE = {
  'source-offline': 'the sensor stopped while its app is still reporting',
  'agent-not-running': 'the app itself has not run',
  'upstream-unavailable': 'the provider is answering with errors',
  'auth-expired': 'the provider is refusing NEURO\'s sign-in',
  'sync-job-failed': 'NEURO\'s own sync job is failing',
  'consumer-failed': 'NEURO is not processing what arrives',
  'delivery-delayed': 'nothing is arriving from any device',
  'expected-quiet': 'expected quiet, not blindness',
  unknown: 'not enough evidence to say',
};
const LEVEL = { high: 'High', medium: 'Medium', low: 'Low' };
const FIX_WORDS = {
  'open-app': 'open the app on the phone',
  'check-sensor-permission': 'check the app\'s permission for this sense',
  'relaunch-agent': 'start the desktop agent on the laptop',
  'reconnect-account': 'reconnect the account in Settings',
  'retry-sync': 'run the sync again',
  'retry-consumer': 'retry the stuck event consumer',
};

function _local(iso) {
  try { return require('./world-model').localMinute(Date.parse(iso)); } catch { return String(iso).slice(0, 16); }
}

/**
 * "07:00–19:00", or "Mon 19:00–Tue 07:35" when the span crosses midnight. The
 * span runs from when the source was LAST HEARD (`basis_at`) — not when NEURO
 * noticed — to the observation that ended it. PURE.
 */
function _span(fromIso, toIso) {
  const a = _local(fromIso); const b = _local(toIso);
  if (a.slice(0, 10) === b.slice(0, 10)) return `${a.slice(11, 16)}–${b.slice(11, 16)}`;
  const dn = (d) => DAY[new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))).getUTCDay()].slice(0, 3);
  return `${dn(a)} ${a.slice(11, 16)}–${dn(b)} ${b.slice(11, 16)}`;
}

/**
 * Build 16Y: a QUIET episode that came back on its own is ONE line, not two.
 * Measured over Activity's first days: 45% of all entries were "X went quiet" /
 * "X recovered" pairs, 12 of 16 of them the phone asleep overnight, and the two
 * apps on one phone always move in the same minute — one wake, four lines.
 * So a resolved stale/never-seen finding (not FAILING — failures stay loud, and
 * not one a self-heal fixed, whose recovery is its own entry) becomes one
 * `source.quiet-episode` entry at the recovery time, and episodes whose start
 * AND end fall in the same minutes are merged under one headline.
 */
function _foldQuietEpisodes(rows, healedOutages) {
  const groups = new Map();
  const rest = [];
  for (const f of rows) {
    const foldable = f.status === 'resolved' && f.resolved_at && f.resolution !== 'retired'
      && f.condition !== 'failing' && !healedOutages.has(f.finding_id);
    if (!foldable) { rest.push(f); continue; }
    const k = `${String(f.first_detected_at).slice(0, 16)}|${String(f.resolved_at).slice(0, 16)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const folded = [];
  for (const g of groups.values()) {
    const labels = [...new Set(g.map((f) => _label(f.source_id)))];
    const first = g[0];
    const names = labels.length <= 2 ? labels.join(' and ') : `${labels.slice(0, 2).join(', ')} and ${labels.length - 2} more`;
    const one = labels.length === 1;
    folded.push(entry({
      id: `finding:${first.finding_id}:episode`, occurredAt: first.resolved_at, category: 'recovered', type: 'source.quiet-episode',
      headline: `${names} ${one ? 'was' : 'were'} quiet ${_span(first.basis_at || first.first_detected_at, first.resolved_at)} and came back on ${one ? 'its' : 'their'} own`,
      summary: first.resolution === 'transport-alive' ? 'The app was reporting throughout.' : null,
      status: 'recovered', severity: 'info',
      sourceRefs: g.map((f) => `source:${f.source_id}`), findingRef: first.finding_id,
      metadata: { folded: g.length, findingIds: g.map((f) => f.finding_id), condition: first.condition },
    }));
  }
  return { folded, rest };
}

function fromFindings(rows, { healedOutages = new Set() } = {}) {
  const { folded, rest } = _foldQuietEpisodes(rows, healedOutages);
  const out = [...folded];
  for (const f of rest) {
    const label = _label(f.source_id);
    const sev = f.condition === 'failing' ? 'warning' : 'notice';
    out.push(entry({
      id: `finding:${f.finding_id}:opened`, occurredAt: f.first_detected_at, category: 'sensed', type: 'source.stopped',
      headline: f.condition === 'failing' ? `NEURO noticed ${label} was failing` : f.condition === 'never-seen' ? `NEURO noticed it has never heard from ${label}` : `NEURO noticed ${label} had gone quiet`,
      summary: f.condition === 'failing' ? `${f.failure_count} failed deliveries in a row.` : null,
      status: 'noticed', severity: sev, sourceRefs: [`source:${f.source_id}`], findingRef: f.finding_id,
      metadata: { condition: f.condition },
    }));
    if (f.status === 'resolved' && f.resolved_at && f.resolution !== 'retired' && !healedOutages.has(f.finding_id)) {
      out.push(entry({
        id: `finding:${f.finding_id}:resolved`, occurredAt: f.resolved_at, category: 'recovered', type: 'source.recovered',
        headline: `${label} recovered`, summary: f.resolution === 'transport-alive' ? 'The app is reporting again.' : 'It is delivering again.',
        status: 'recovered', sourceRefs: [`source:${f.source_id}`], findingRef: f.finding_id, metadata: { resolution: f.resolution },
      }));
    }
  }
  return out;
}

function fromInvestigations(invs, eventsById, { healedInvestigations = new Set() } = {}) {
  const out = [];
  for (const inv of invs) {
    const sourceId = String(inv.subject_ref || '').replace(/^source:/, '');
    const label = _label(sourceId);
    let lastHyp = null;
    for (const ev of eventsById.get(inv.id) || []) {
      const d = _json(ev.detail_json, {}) || {};
      // The conclusion of THIS pass is the hypothesis recorded just before its
      // decision — never the investigation's current one, which may be newer.
      if (ev.transition === 'hypothesised') { lastHyp = d; continue; }
      // Build 17W: the repeated-degradation type has its own wording — a sense
      // that keeps wobbling, never "stopped". Conclusion and the close only.
      if (inv.type === 'repeated_source_degradation') {
        if (ev.transition === 'decided') {
          const top = (lastHyp && lastHyp.top) || 'unknown';
          const lvl = (lastHyp && lastHyp.level) || 'low';
          const dg = require('./source-degradation');
          out.push(entry({
            id: `inv:${inv.id}:${ev.id}`, occurredAt: ev.at, category: 'investigated', type: 'investigation.degradation',
            headline: `NEURO investigated why ${label} keeps dropping out`,
            summary: `${top === 'unknown' ? 'Not enough evidence to say yet — watching.' : `Likely cause: ${dg.CAUSE_TEXT[top] || top}. Confidence: ${LEVEL[lvl] || lvl}.`}${d.fix && d.fix.kind ? ` Recommended: ${dg.FIX_TEXT[d.fix.kind] || d.fix.kind}` : ''}`,
            status: d.decision ? String(d.decision).toLowerCase() : null, investigationRef: inv.id, findingRef: inv.trigger_ref,
            sourceRefs: [`source:${sourceId}`], metadata: { decision: d.decision || null, stopReason: d.stopReason || null, cause: top, confidence: lvl },
          }));
        } else if (ev.transition === 'resolved' && ['stable-again', 'cluster-ended'].includes(d.stopReason)) {
          out.push(entry({
            id: `inv:${inv.id}:${ev.id}`, occurredAt: ev.at, category: 'recovered', type: 'investigation.degradation-closed',
            headline: `${label} has been steady for a week`, summary: 'NEURO closed its investigation of the drop-outs.',
            status: 'resolved', investigationRef: inv.id, findingRef: inv.trigger_ref, sourceRefs: [`source:${sourceId}`],
          }));
        }
        continue;
      }
      if (ev.transition === 'decided') {
        const top = (lastHyp && lastHyp.top) || 'unknown';
        const lvl = (lastHyp && lastHyp.level) || 'low';
        out.push(entry({
          id: `inv:${inv.id}:${ev.id}`, occurredAt: ev.at, category: 'investigated', type: 'investigation.concluded',
          headline: `NEURO investigated why ${label} stopped`,
          summary: top === 'unknown' ? 'Not enough evidence to say yet — watching.' : `Likely cause: ${CAUSE[top] || top}. Confidence: ${LEVEL[lvl] || lvl}.`,
          status: d.decision ? String(d.decision).toLowerCase() : null, investigationRef: inv.id, findingRef: inv.trigger_ref,
          sourceRefs: [`source:${sourceId}`], metadata: { decision: d.decision || null, stopReason: d.stopReason || null, cause: top, confidence: lvl },
        }));
        // A retry that self-heal then ran is shown as the retry, not as advice.
        if (d.fix && d.fix.kind && !(d.fix.kind === 'retry-sync' && healedInvestigations.has(inv.id))) {
          out.push(entry({
            id: `inv:${inv.id}:${ev.id}:rec`, occurredAt: ev.at, category: 'decided', type: 'investigation.recommended',
            headline: `NEURO recommended: ${FIX_WORDS[d.fix.kind] || d.fix.kind}`,
            summary: d.fix.kind === 'retry-sync' ? 'Not done automatically — the diagnosis was not certain enough to act on.' : 'A manual step — NEURO cannot do this itself.',
            status: 'recommended', authority: d.fix.authority || null, investigationRef: inv.id, findingRef: inv.trigger_ref,
            sourceRefs: [`source:${sourceId}`], metadata: { fixKind: d.fix.kind },
          }));
        }
      } else if (ev.transition === 'self-heal-failed' || ev.transition === 'self-heal-uncertain') {
        out.push(entry({
          id: `inv:${inv.id}:${ev.id}`, occurredAt: ev.at, category: 'decided', type: 'investigation.handed-over',
          headline: `NEURO stopped trying and handed ${label} to you`,
          summary: 'One automatic retry is the limit for an outage. What is left is a manual step.',
          status: 'manual', investigationRef: inv.id, findingRef: inv.trigger_ref, sourceRefs: [`source:${sourceId}`], severity: 'notice',
        }));
      } else if (ev.transition === 'inconclusive') {
        out.push(entry({
          id: `inv:${inv.id}:${ev.id}`, occurredAt: ev.at, category: 'investigated', type: 'investigation.inconclusive',
          headline: `NEURO's investigation of ${label} ended without a cause`, summary: d.stopReason === 'expired' ? 'It ran out of time (7 days).' : null,
          status: 'inconclusive', investigationRef: inv.id, findingRef: inv.trigger_ref, sourceRefs: [`source:${sourceId}`], severity: 'notice',
        }));
      }
    }
  }
  return out;
}

function fromSelfHeal(rows) {
  const out = [];
  for (const a of rows) {
    const label = _label(a.source_id);
    const v = _json(a.verification_json, null);
    if (a.status === 'cancelled') {
      out.push(entry({
        id: `heal:${a.attempt_id}:cancelled`, occurredAt: a.requested_at, category: 'decided', type: 'selfheal.not-needed',
        headline: `NEURO did not need to act — ${label} recovered first`, summary: a.reason || null,
        status: 'cancelled', authority: a.authority, actionRef: a.attempt_id, investigationRef: a.investigation_id, findingRef: a.outage_key,
        sourceRefs: [`source:${a.source_id}`],
      }));
      continue;
    }
    if (a.started_at) {
      out.push(entry({
        id: `heal:${a.attempt_id}:acted`, occurredAt: a.executed_at || a.started_at, category: 'acted', type: 'selfheal.executed',
        headline: `NEURO retried the ${label} sync`,
        summary: a.op_outcome === 'ok' ? 'The retry ran. Checking whether the source really recovered.'
          : a.op_outcome === 'unknown' ? 'The retry was interrupted before it answered — checking the source instead of repeating it.'
            : a.op_outcome === 'error' ? 'The retry itself reported a failure.' : 'Retrying now.',
        status: a.op_outcome === 'error' ? 'attempted' : a.executed_at ? 'executed' : 'executing',
        authority: a.authority, actor: 'neuro', actionRef: a.attempt_id, investigationRef: a.investigation_id, findingRef: a.outage_key,
        sourceRefs: [`source:${a.source_id}`], metadata: { op: a.op, capability: a.capability, opOutcome: a.op_outcome || null },
      }));
    }
    if (['recovered', 'failed', 'uncertain'].includes(a.status)) {
      out.push(entry({
        id: `heal:${a.attempt_id}:verified`, occurredAt: a.verified_at, category: a.status === 'recovered' ? 'recovered' : 'verified', type: `selfheal.${a.status}`,
        headline: a.status === 'recovered' ? `${label} recovered after the retry`
          : a.status === 'failed' ? `The retry did not bring ${label} back` : `NEURO could not verify whether ${label} recovered`,
        summary: a.status === 'recovered' ? 'Verified: a new delivery arrived and source health returned to seeing.' : ((v && v.why) || a.reason || null),
        status: a.status, severity: a.status === 'recovered' ? 'info' : 'warning', authority: a.authority,
        actionRef: a.attempt_id, verificationRef: `${a.attempt_id}#verification`, investigationRef: a.investigation_id, findingRef: a.outage_key,
        sourceRefs: [`source:${a.source_id}`], metadata: { basis: v && v.basis ? { sourceState: v.basis.sourceState, freshness: v.basis.freshness, findingActive: v.basis.findingActive } : null },
      }));
    }
  }
  return out;
}

const TYPE_WORDS = {
  chase_commitment: 'a chase email', reply_email: 'an email reply', chase_agenda: 'an agenda request',
  send_weekly_risk_report: 'the weekly risk report', create_calendar_event: 'a calendar invite',
  reschedule_calendar_event: 'a meeting move', cancel_calendar_event: 'a meeting cancellation',
};
function _typeWords(t) { return TYPE_WORDS[t] || t.replace(/_/g, ' '); }

function fromPreparedActions(rows, verificationsByAction) {
  const out = [];
  for (const a of rows) {
    const what = _typeWords(a.action_type);
    const base = { actionRef: a.action_id, authority: 'A4', metadata: { actionType: a.action_type, version: a.version, origin: a.origin || null } };
    out.push(entry({ ...base, id: `pa:${a.action_id}:prepared`, occurredAt: a.created_at, category: 'prepared', type: 'action.prepared',
      headline: `NEURO prepared ${what} for your approval`, summary: 'Nothing is sent without your approval code.', status: 'prepared' }));
    if (a.approved_at) {
      out.push(entry({ ...base, id: `pa:${a.action_id}:approved`, occurredAt: a.approved_at, category: 'decided', type: 'action.approved',
        actor: 'nick', headline: `You approved ${what}`, status: 'approved' }));
    }
    if (a.status === 'rejected' && a.decided_at) {
      out.push(entry({ ...base, id: `pa:${a.action_id}:rejected`, occurredAt: a.decided_at, category: 'decided', type: 'action.rejected',
        actor: 'nick', headline: `You rejected ${what}`, status: 'rejected' }));
    }
    if (a.executed_at) {
      out.push(entry({ ...base, id: `pa:${a.action_id}:executed`, occurredAt: a.executed_at, category: 'acted', type: 'action.executed',
        headline: `NEURO sent ${what}`, summary: 'Sent. Verification is separate.', status: 'executed' }));
    }
    if (a.status === 'execution_uncertain') {
      out.push(entry({ ...base, id: `pa:${a.action_id}:uncertain`, occurredAt: a.executed_at || a.approved_at || a.created_at, category: 'acted', type: 'action.uncertain',
        headline: `The outcome of ${what} is unknown`, summary: 'NEURO will verify it, never resend it.', status: 'uncertain', severity: 'warning' }));
    }
    if (a.status === 'failed') {
      out.push(entry({ ...base, id: `pa:${a.action_id}:failed`, occurredAt: a.decided_at || a.executed_at || a.created_at, category: 'acted', type: 'action.failed',
        headline: `${what[0].toUpperCase()}${what.slice(1)} failed`, status: 'failed', severity: 'warning' }));
    }
    const v = (verificationsByAction.get(a.action_id) || []).find((x) => x.outcome === 'verified');
    if (v) {
      out.push(entry({ ...base, id: `pa:${a.action_id}:verified`, occurredAt: v.checked_at, category: 'verified', type: 'action.verified',
        headline: `NEURO verified ${what} went out as approved`, status: 'verified', verificationRef: `action_verifications:${v.id}` }));
    }
  }
  return out;
}

const WRITER_WORDS = {
  'nova.escalate': ['escalated a Jira ticket', 'escalate a Jira ticket'],
  'microsoft.task.complete': ['completed a Microsoft task', 'complete a Microsoft task'],
};
function fromExternalWrites(rows) {
  return rows.map((r) => {
    const [did, doIt] = WRITER_WORDS[r.writer] || ['made an external change', 'make an external change'];
    const status = r.status === 'requested' ? 'uncertain' : r.status;
    return entry({
      id: `ext:${r.id}`, occurredAt: r.settled_at || r.requested_at, category: 'acted', type: `external.${r.writer}`,
      actor: String(r.initiated_by || '').startsWith('machine') ? 'external-system' : 'nick',
      headline: status === 'confirmed' ? `NEURO ${did} (read back)` : status === 'applied-unverified' ? `NEURO ${did} — not read back`
        : status === 'failed' ? `NEURO could not ${doIt}` : `NEURO ${did} — outcome unknown`,
      status, authority: r.authority, severity: status === 'confirmed' ? 'info' : 'warning', actionRef: `external_write_ledger:${r.id}`,
      metadata: { writer: r.writer, initiatedBy: r.initiated_by },
    });
  });
}

function fromRefusals(rows) {
  const groups = new Map();
  for (const r of rows) {
    const d = _json(r.event_data, {}) || {};
    const k = `${r.date_key}|${d.machine}|${d.capability || 'unmapped'}`;
    const g = groups.get(k) || { first: r.created_at, last: r.created_at, n: 0, d, day: r.date_key };
    g.n += 1; g.last = r.created_at > g.last ? r.created_at : g.last;
    groups.set(k, g);
  }
  return [...groups.entries()].map(([k, g]) => {
    let effect = g.d.capability || 'an unmapped route';
    try { const c = require('./authority-matrix').CAPABILITIES[g.d.capability]; if (c) effect = c.effect; } catch { /* label only */ }
    return entry({
      id: `refused:${k}`, occurredAt: _sqliteIso(g.last), category: 'blocked', type: 'authority.refused', actor: 'external-system',
      headline: g.d.machine === 'human' ? 'A retired route was called and refused' : `NEURO refused ${g.d.machine}: ${effect}`,
      summary: g.n > 1 ? `${g.n} times that day.` : null, status: 'blocked', severity: 'notice',
      authority: (() => { try { return require('./authority-matrix').CAPABILITIES[g.d.capability].authority; } catch { return null; } })(),
      metadata: { machine: g.d.machine, capability: g.d.capability || null, count: g.n, httpStatus: g.d.status },
    });
  });
}

function fromFlagChanges(rows) {
  return rows.map((r) => {
    const d = _json(r.event_data, {}) || {};
    return entry({
      id: `flag:${r.id}`, occurredAt: _sqliteIso(r.created_at), category: 'configured', type: 'switch.changed', actor: 'nick',
      headline: `You switched "${d.label || d.key}" ${d.to ? 'on' : 'off'}`, status: d.to ? 'on' : 'off', metadata: { key: d.key },
    });
  });
}

function fromEventLog(rows) {
  const out = [];
  for (const r of rows) {
    const p = _json(r.payload, {}) || {};
    if (r.type === 'runtime.job.skipped' && p.reason === 'gap') {
      out.push(entry({ id: `ev:${r.event_id}`, occurredAt: r.occurred_at, category: 'recovered', type: 'runtime.gap', actor: 'system-runtime',
        headline: `NEURO was not running long enough to miss ${p.missedSlots || 'several'} runs of ${p.job}`,
        summary: 'Recorded on restart; the next run went ahead normally.', status: 'recovered', severity: 'notice', metadata: { job: p.job } }));
    } else if (r.type === 'runtime.job.failed') {
      out.push(entry({ id: `ev:${r.event_id}`, occurredAt: r.occurred_at, category: 'sensed', type: 'runtime.failed', actor: 'system-runtime',
        headline: `A scheduled job failed after ${p.attempts} attempt${p.attempts === 1 ? '' : 's'}: ${p.job}`, status: 'failed', severity: 'warning', metadata: { job: p.job } }));
    } else if (r.type === 'native.queue.replayed') {
      // Build 16G: the phone held a backlog while offline and it has landed.
      const age = p.oldestAgeMinutes >= 120 ? `${Math.round(p.oldestAgeMinutes / 60)}h` : `${p.oldestAgeMinutes} min`;
      out.push(entry({ id: `ev:${r.event_id}`, occurredAt: r.occurred_at, category: 'recovered', type: 'native.replayed', actor: 'external-system',
        headline: `${_label(p.sourceId)}: ${p.delivered} queued event${p.delivered === 1 ? '' : 's'} replayed after reconnect (oldest ${age})`,
        status: 'recovered', sourceRefs: [`source:${p.sourceId}`], metadata: { delivered: p.delivered, oldestAgeMinutes: p.oldestAgeMinutes } }));
    } else if (r.type === 'native.queue.degraded') {
      const parts = [];
      if (p.quarantinedAdded) parts.push(`${p.quarantinedAdded} unreadable event${p.quarantinedAdded === 1 ? ' was' : 's were'} quarantined`);
      if (p.evictedAdded) parts.push(`${p.evictedAdded} event${p.evictedAdded === 1 ? ' was' : 's were'} dropped past the retention limit`);
      out.push(entry({ id: `ev:${r.event_id}`, occurredAt: r.occurred_at, category: 'sensed', type: 'native.degraded', actor: 'external-system',
        headline: `${_label(p.sourceId)} queue on the phone: ${parts.join('; ')}`,
        summary: p.quarantinedAdded ? 'Kept aside on the phone, not lost; the good events around it were delivered.' : null,
        status: p.evictedAdded ? 'failed' : 'noticed', severity: 'warning', sourceRefs: [`source:${p.sourceId}`],
        metadata: { quarantinedAdded: p.quarantinedAdded, evictedAdded: p.evictedAdded } }));
    } else if (r.type === 'source.lifecycle.changed') {
      const label = _label(p.sourceId);
      out.push(entry({ id: `ev:${r.event_id}`, occurredAt: r.occurred_at, category: 'configured', type: 'source.lifecycle',
        headline: p.lifecycle === 'retired' ? `NEURO stopped expecting ${label}` : p.lifecycle === 'expected' ? `NEURO now expects to hear from ${label}` : `${label} is now optional`,
        status: p.lifecycle, sourceRefs: [`source:${p.sourceId}`], metadata: { lifecycle: p.lifecycle } }));
    }
  }
  return out;
}

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function _dayName(d) { return d ? DAY[new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))).getUTCDay()] : ''; }

/**
 * Build 17W: personal dates — preparation linked or completed, and a date
 * entering its action window. Never "checked a date"; the attention verdict
 * and lead settings are bookkeeping, not activity.
 */
function fromPersonalDates(rows) {
  return rows.map((r) => {
    const d = _json(r.detail_json, {}) || {};
    const base = { id: `pdate:${r.id}`, occurredAt: r.at, subjectRefs: [`personal-date:${r.date_id}`], metadata: { kind: r.kind, date: d.date || null } };
    switch (r.kind) {
      case 'prep-linked': return entry({ ...base, category: 'sensed', type: 'personal-date.prep',
        headline: `Preparation found for ${d.title}`, summary: `"${d.task}" — linked because it ${d.link}.`, status: 'linked' });
      case 'prep-completed': return entry({ ...base, category: 'verified', type: 'personal-date.prep-done',
        headline: `Preparation done for ${d.title}`, summary: `"${d.task}" is complete.`, status: 'done' });
      case 'action-window': return entry({ ...base, category: 'sensed', type: 'personal-date.action',
        headline: d.line || `${d.title} is close`, summary: 'Shown on Now. Whether it interrupts is the attention policy\'s call.', status: 'action-may-be-needed' });
      // Build 18Q: Nick's explicit edits — the date written into the note.
      case 'declared-set': return entry({ ...base, category: 'configured', type: 'personal-date.declared', actor: 'nick',
        headline: `You ${d.previous ? 'changed' : 'added'} ${d.title}`, summary: `Written to ${d.entity}${d.previous ? ` (was ${d.previous})` : ''}.`, status: 'set' });
      case 'declared-removed': return entry({ ...base, category: 'configured', type: 'personal-date.declared', actor: 'nick',
        headline: `You removed ${d.title}`, summary: `Taken off ${d.entity}. NEURO will not bring it back.`, status: 'removed' });
      default: return null;
    }
  }).filter(Boolean);
}

/** Build 18V: a native build seen for the FIRST time — "it was installed and ran". One line per build, ever. */
function fromNativeBuilds(rows) {
  const apps = { 'neuro-ios': 'NEURO iOS', 'saim-ios': 'SAiM iOS', 'saim-watch': 'SAiM Watch', 'saim-widgets': 'SAiM widgets' };
  return rows.map((r) => {
    const name = apps[r.client] || r.client;
    const lbl = [r.version, r.build ? `(${r.build})` : null].filter(Boolean).join(' ') || 'unversioned';
    return entry({ id: `build:${r.build_key}`, occurredAt: r.first_seen_at, category: 'sensed', type: 'native.build.first-seen',
      headline: `${name} ${lbl} is running`, summary: r.git_commit ? `Commit ${String(r.git_commit).slice(0, 7)} — first heard from now.` : 'First heard from now (no commit stamped in this build).',
      status: 'installed', sourceRefs: [r.client], metadata: { client: r.client, version: r.version, build: r.build, commit: r.git_commit } });
  });
}

function fromGoalLoop(rows) {
  return rows.map((r) => {
    const d = _json(r.detail_json, {}) || {};
    const base = { id: `loop:${r.id}`, occurredAt: r.at, subjectRefs: [`goal:${r.goal_id}`], metadata: { weekStart: r.week_start, kind: r.kind } };
    switch (r.kind) {
      case 'planned': return entry({ ...base, category: r.actor === 'nick' ? 'configured' : 'sensed', type: 'goal.hike.planned', actor: r.actor,
        headline: r.actor === 'nick' ? `You planned a hike for ${_dayName(d.day)}` : `${_dayName(d.day)} hike planned (in your calendar)`, status: 'planned' });
      case 'achieved': return entry({ ...base, category: r.actor === 'nick' ? 'configured' : 'verified', type: 'goal.hike.done', actor: r.actor,
        headline: 'Hike confirmed', summary: d.by === 'you' ? `${_dayName(d.day)} — you confirmed it.` : `${_dayName(d.day)} — recorded as a workout.`, status: 'confirmed' });
      // Build 17A: a day's verdict once its 24h window closed — one line per
      // day and verdict, never per sample.
      case 'resolved': {
        if (d.state === 'confirmed') return entry({ ...base, category: 'verified', type: 'goal.hike.done', actor: r.actor,
          headline: 'Hike confirmed', summary: `${_dayName(d.day)} — a GPS track recorded it.`, status: 'confirmed' });
        if (d.state === 'not_hike') return entry({ ...base, category: r.actor === 'nick' ? 'configured' : 'sensed', type: 'goal.hike.resolved', actor: r.actor,
          headline: r.actor === 'nick' ? `You said ${_dayName(d.day)} was not a hike` : `${_dayName(d.day)}: no hike recorded`,
          summary: r.actor === 'nick' ? null : 'No GPS track within 24 hours, and location recording was working.', status: 'not_hike' });
        return entry({ ...base, category: 'sensed', type: 'goal.hike.uncertain',
          headline: `NEURO can't tell whether ${_dayName(d.day)} was a hike`, summary: d.why ? `${d.why[0].toUpperCase()}${d.why.slice(1)}.` : null, status: 'recording_gap' });
      }
      // Before Build 17 the loop called a big-step day "likely". Kept as the
      // history it is; the day's real verdict follows it as `resolved`.
      case 'likely': return entry({ ...base, category: 'sensed', type: 'goal.hike.asked',
        headline: `NEURO asked whether ${_dayName(d.day)} was a hike`, summary: null, status: 'asked' });
      case 'recording-uncertain': return entry({ ...base, category: 'sensed', type: 'goal.hike.uncertain',
        headline: `NEURO can't tell whether ${_dayName(d.day)}'s hike happened`, summary: 'Nothing recorded it — which is not the same as it not happening.', status: 'uncertain' });
      case 'withdrawn': return entry({ ...base, category: 'configured', type: 'goal.hike.withdrawn', actor: 'nick',
        headline: d.kind === 'plan' ? `You took back the plan for ${_dayName(d.day)}` : d.kind === 'deny' ? `You took back "not a hike" for ${_dayName(d.day)}` : `You took back the hike confirmation for ${_dayName(d.day)}`, status: 'withdrawn' });
      case 'reminder-prepared': return entry({ ...base, category: 'prepared', type: 'goal.hike.reminder',
        headline: 'NEURO prepared a gentle hiking prompt', summary: 'Nothing is planned this week yet. Shown on the hiking loop, not pushed.', status: 'prepared' });
      default: return null;
    }
  }).filter(Boolean);
}

/**
 * Build 19W: personal operations — only transitions, never reads. A list or
 * calendar classified, a goal or preparation link added/removed, a personal
 * obligation opened or completed, a Radar item that started needing Nick.
 */
function fromPersonalOps(rows) {
  const domainsLib = require('../../shared/life-domains.cjs');
  const doms = (ds) => (ds || []).map((d) => domainsLib.domainLabel(d) || d).join(' and ');
  return rows.map((r) => {
    const d = _json(r.detail_json, {}) || {};
    const base = { id: `pops:${r.id}`, occurredAt: r.at, subjectRefs: r.subject_id ? [r.subject_id] : [], actor: r.actor, metadata: { kind: r.kind } };
    switch (r.kind) {
      case 'list-classified':
      case 'calendar-classified': {
        const what = r.kind === 'list-classified' ? 'reminder list' : 'calendar';
        const said = d.cleared ? 'cleared' : [d.domains && d.domains.length ? `as ${doms(d.domains)}` : null, d.tracked === true ? 'tracked' : d.tracked === false ? 'not tracked' : null].filter(Boolean).join(', ');
        return entry({ ...base, category: 'configured', type: `personal.${r.kind}`, headline: `You classified the "${d.label}" ${what}`, summary: said ? `Set ${said}.` : null, status: 'set' });
      }
      case 'goal-link-added': return entry({ ...base, category: 'configured', type: 'goal.link', headline: `You linked ${d.label ? `"${d.label}"` : 'an item'} to "${d.goal}"`, summary: 'Context only — it does not make it more urgent.', status: 'linked' });
      case 'goal-link-removed': return entry({ ...base, category: 'configured', type: 'goal.link', headline: `You unlinked ${d.label ? `"${d.label}"` : 'an item'} from "${d.goal}"`, status: 'unlinked' });
      case 'prep-link-added': return entry({ ...base, category: 'configured', type: 'personal.prep-link', headline: `You marked ${d.label ? `"${d.label}"` : 'a task'} as preparation`, summary: `For ${r.subject_id}.`, status: 'linked' });
      case 'prep-link-removed': return entry({ ...base, category: 'configured', type: 'personal.prep-link', headline: `You removed a preparation link${d.label ? ` ("${d.label}")` : ''}`, status: 'unlinked' });
      case 'obligation-opened': return entry({ ...base, category: 'sensed', type: 'personal.obligation', headline: `Personal ${d.admin ? 'admin' : 'obligation'} appeared: "${d.title}"`, status: 'open' });
      case 'obligation-completed': return entry({ ...base, category: 'verified', type: 'personal.obligation', headline: `Personal obligation done: "${d.title}"`, summary: 'Its source says it is complete.', status: 'done' });
      case 'admin-resolved': return entry({ ...base, category: 'verified', type: 'personal.admin', headline: `Personal admin resolved: "${d.title}"`, summary: 'Its source says it is complete.', status: 'done' });
      // Build 20U — semantic lines only: no walk, sync or Radar refresh is logged.
      case 'list-tracking': return entry({ ...base, category: 'configured', type: 'personal.list-tracking',
        headline: d.tracked === true ? `You set the "${d.label}" reminder list to be tracked` : d.tracked === false ? `You set the "${d.label}" reminder list as ignored` : `You cleared tracking on the "${d.label}" reminder list`,
        summary: d.tracked === true ? 'NEURO now reads its reminders.' : 'NEURO does not read its reminders.', status: 'set' });
      case 'care-item-created': return entry({ ...base, category: 'configured', type: 'companion.care', headline: `You added ${d.companion ? `${d.companion}'s` : 'a'} care item: "${d.title}"`, summary: d.dueDate ? `Due ${d.dueDate}.` : 'No date.', status: 'open' });
      case 'care-item-completed': return entry({ ...base, category: 'verified', type: 'companion.care', headline: `${d.companion ? `${d.companion}: ` : ''}"${d.title}" done`, summary: d.nextDue ? `Next due ${d.nextDue} (the repeat you set).` : 'Done on ' + d.doneOn + '.', status: 'done' });
      case 'care-link-added': return entry({ ...base, category: 'configured', type: 'companion.link', headline: `You linked ${d.label ? `"${d.label}"` : 'an item'} to ${d.companion || 'a companion'}'s care`, summary: `As ${d.careKind}.`, status: 'linked' });
      case 'care-link-removed': return entry({ ...base, category: 'configured', type: 'companion.link', headline: `You unlinked ${d.label ? `"${d.label}"` : 'an item'} from ${d.companion || 'a companion'}'s care`, status: 'unlinked' });
      case 'vehicle-link-added': return entry({ ...base, category: 'configured', type: 'personal.vehicle-link', headline: `You linked ${d.label ? `"${d.label}"` : 'an item'} to the ${d.vehicle}`, status: 'linked' });
      case 'vehicle-link-removed': return entry({ ...base, category: 'configured', type: 'personal.vehicle-link', headline: `You unlinked ${d.label ? `"${d.label}"` : 'an item'} from the ${d.vehicle}`, status: 'unlinked' });
      // Build 21AL — vehicle: semantic lines only; no transaction or sync spam.
      case 'vehicle-created': return entry({ ...base, category: 'configured', type: 'vehicle.entity', headline: `You added the ${d.vehicle} as a vehicle`, summary: d.fields ? `Recorded: ${d.fields.join(', ')}. Anything else stays unknown.` : null, status: 'set' });
      case 'vehicle-configured': return entry({ ...base, category: 'configured', type: 'vehicle.entity', headline: `You updated the ${d.vehicle}`, summary: d.fields ? `Changed: ${d.fields.join(', ')}.` : null, status: 'set' });
      case 'vehicle-obligation-added': return entry({ ...base, category: 'configured', type: 'vehicle.obligation', headline: `You recorded the ${d.label} date`, summary: d.dueDate ? `Due ${d.dueDate}${d.dueMileage ? ` or at ${d.dueMileage} mi` : ''}.` : d.dueMileage ? `Due at ${d.dueMileage} mi.` : 'No date yet.', status: 'open' });
      case 'vehicle-obligation-resolved': return entry({ ...base, category: 'verified', type: 'vehicle.obligation', headline: d.outcome === 'cancelled' ? `${d.label} obligation cancelled` : `${d.label} done`, summary: [d.evidence, d.nextDueDate ? `Next due ${d.nextDueDate}.` : null].filter(Boolean).join(' — ') || null, status: 'done' });
      case 'official-conflict-found': return entry({ ...base, category: 'sensed', type: 'vehicle.official', headline: `Vehicle record differs from official source (${d.field})`, summary: `NEURO has ${d.neuro}; ${d.source} says ${d.official}. Neither was changed.`, status: 'conflict' });
      case 'mileage-added': return entry({ ...base, category: 'configured', type: 'vehicle.mileage', headline: `Odometer reading recorded: ${d.value} ${d.unit}`, summary: d.state === 'needs-review' ? `On ${d.observedOn} — it needs review, so it is not used.` : `On ${d.observedOn}.`, status: d.state === 'needs-review' ? 'needs-review' : 'set' });
      case 'maintenance-recorded': return entry({ ...base, category: 'configured', type: 'vehicle.history', headline: `Vehicle history: ${d.description}`, summary: `${String(d.type).replace(/_/g, ' ')}, ${d.date}.`, status: 'set' });
      case 'tally-connected': return entry({ ...base, category: 'configured', type: 'finance.source', headline: 'Tally connected as a finance source (read-only)', summary: `Read ${d.scanned} transactions; kept ${d.kept} that might be motoring. Data runs to ${d.dataThrough}.`, status: 'connected' });
      case 'finance-mapping-confirmed': return entry({ ...base, category: 'configured', type: 'finance.mapping', headline: `You confirmed a vehicle-spend rule: ${d.matchKind === 'category' ? `category "${d.categoryName}"` : d.matchKind === 'merchant' ? `merchant "${d.merchantKey}"` : `"${d.merchantKey}" in "${d.categoryName}"`} → ${d.spendType}`, summary: `It matched ${d.matched} transaction${d.matched === 1 ? '' : 's'}; applied to ${d.applied} not yet decided.`, status: 'set' });
      case 'vehicle-summary-produced': return entry({ ...base, category: 'sensed', type: 'vehicle.summary', headline: `Monthly vehicle summary for ${d.month}`, summary: d.gaps ? `${d.gaps} evidence gap${d.gaps === 1 ? '' : 's'} noted.` : null, status: 'produced' });
      case 'vehicle-gaps-changed': return entry({ ...base, category: 'sensed', type: 'vehicle.gaps', headline: `What NEURO cannot yet say about the ${d.vehicle} changed`, summary: (d.gaps || []).slice(0, 3).join('; '), status: 'changed' });
      case 'lead-reminders-set': return entry({ ...base, category: 'configured', type: 'personal.lead-reminders',
        headline: d.offsets ? `You set ${d.kind} lead reminders: ${d.offsets.join(', ')} days before` : `You cleared ${d.kind} lead reminders`,
        summary: d.offsets ? 'First step shows on the Radar, the last is the only push — skipped when the prep is done.' : null, status: 'set' });
      case 'radar-needs-you': return entry({ ...base, category: 'sensed', type: 'personal.radar', headline: `Coming up and needs you: ${d.title}`, summary: 'Shown on the Future Radar. It does not interrupt on its own.', status: 'needs-you' });
      default: return null;
    }
  }).filter(Boolean);
}

// ── reading ─────────────────────────────────────────────────────────────────

/** SQLite CURRENT_TIMESTAMP carries no zone; it is UTC. */
function _sqliteIso(s) {
  if (!s) return null;
  const t = String(s);
  return /[zZ]|[+-]\d\d:?\d\d$/.test(t) ? new Date(t).toISOString() : new Date(`${t.replace(' ', 'T')}Z`).toISOString();
}

function _safe(name, fn, gaps) {
  try { return fn(); } catch (e) { gaps.push({ source: name, why: e.message }); return []; }
}

/** All entries in [fromIso, toIso], newest first, stable. Unreadable sources are named gaps. */
function collect({ fromIso, toIso }) {
  const gaps = [];
  const between = (col) => `${col} >= ? AND ${col} <= ?`;
  const w = [fromIso, toIso];
  const heal = _safe('self_heal_attempts', () => db.all(`SELECT * FROM self_heal_attempts WHERE ${between('requested_at')} OR ${between('verified_at')}`, [...w, ...w]), gaps);
  const healed = new Set(heal.filter((a) => a.status === 'recovered').map((a) => a.outage_key));
  const all = [
    ..._safe('source_blind_findings', () => fromFindings(db.all(`SELECT * FROM source_blind_findings WHERE ${between('first_detected_at')} OR ${between('resolved_at')}`, [...w, ...w]), { healedOutages: healed }), gaps),
    ..._safe('investigations', () => {
      const evs = db.all(`SELECT * FROM investigation_events WHERE ${between('at')} AND transition IN ('hypothesised','decided','inconclusive','self-heal-failed','self-heal-uncertain','resolved') ORDER BY id`, w);
      const ids = [...new Set(evs.map((e) => e.investigation_id))];
      if (!ids.length) return [];
      const invs = db.all(`SELECT * FROM investigations WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
      const byId = new Map();
      for (const e of evs) { if (!byId.has(e.investigation_id)) byId.set(e.investigation_id, []); byId.get(e.investigation_id).push(e); }
      return fromInvestigations(invs, byId, { healedInvestigations: new Set(heal.filter((a) => a.status !== 'cancelled').map((a) => a.investigation_id)) });
    }, gaps),
    ..._safe('self_heal_attempts', () => fromSelfHeal(heal), gaps),
    ..._safe('prepared_actions', () => {
      const rows = db.all(`SELECT action_id, action_type, version, origin, status, created_at, approved_at, decided_at, executed_at, verified_at FROM prepared_actions
                            WHERE ${between('created_at')} OR ${between('approved_at')} OR ${between('decided_at')} OR ${between('executed_at')} OR ${between('verified_at')}`, [...w, ...w, ...w, ...w, ...w]);
      const vs = new Map();
      if (rows.length) {
        for (const v of db.all(`SELECT id, action_id, checked_at, outcome FROM action_verifications WHERE action_id IN (${rows.map(() => '?').join(',')})`, rows.map((r) => r.action_id))) {
          if (!vs.has(v.action_id)) vs.set(v.action_id, []);
          vs.get(v.action_id).push(v);
        }
      }
      return fromPreparedActions(rows, vs);
    }, gaps),
    ..._safe('external_write_ledger', () => fromExternalWrites(db.all(`SELECT * FROM external_write_ledger WHERE ${between('requested_at')}`, w)), gaps),
    ..._safe('activity_log', () => {
      const day = (iso) => String(iso).slice(0, 10);
      const rows = db.all(`SELECT id, event_type, event_data, date_key, created_at FROM activity_log WHERE event_type IN ('authority_refused','feature_flag_changed','meeting_prep_mode') AND date_key >= ? AND date_key <= ?`, [day(fromIso), day(toIso)]);
      return [...fromRefusals(rows.filter((r) => r.event_type === 'authority_refused')), ...fromFlagChanges(rows.filter((r) => r.event_type === 'feature_flag_changed')),
        ...rows.filter((r) => r.event_type === 'meeting_prep_mode').map((r) => {
          const d = _json(r.event_data, {}) || {};
          return entry({ id: `prepmode:${r.id}`, occurredAt: _sqliteIso(r.created_at), category: 'configured', type: 'meeting-prep.mode', actor: 'neuro',
            headline: d.mode === 'retired' ? 'The old meeting-prep push is retired' : 'The old meeting-prep push is back on',
            summary: d.mode === 'retired' ? 'Replaced by meeting intelligence (risks) and meeting prep (role, last 1-2-1). Switch: "Legacy meeting-prep pushes".' : `Turned back on (${d.basis || 'switch'}).`,
            status: d.mode, metadata: { mode: d.mode, basis: d.basis || null } });
        })];
    }, gaps),
    ..._safe('event_log', () => fromEventLog(db.all(`SELECT event_id, type, occurred_at, payload FROM event_log WHERE type IN ('runtime.job.skipped','runtime.job.failed','source.lifecycle.changed','native.queue.replayed','native.queue.degraded') AND ${between('occurred_at')}`, w)), gaps),
    ..._safe('goal_loop_events', () => fromGoalLoop(db.all(`SELECT * FROM goal_loop_events WHERE ${between('at')}`, w)), gaps),
    ..._safe('personal_date_events', () => fromPersonalDates(db.all(`SELECT * FROM personal_date_events WHERE ${between('at')}`, w)), gaps),
    ..._safe('native_builds', () => fromNativeBuilds(db.all(`SELECT * FROM native_builds WHERE ${between('first_seen_at')}`, w)), gaps),
    ..._safe('personal_ops_events', () => fromPersonalOps(db.all(`SELECT * FROM personal_ops_events WHERE ${between('at')}`, w)), gaps),
  ].filter((e) => e && e.occurredAt && e.occurredAt >= fromIso && e.occurredAt <= toIso);
  // Stable: newest first, then id — the same rows always come back in the same order.
  all.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : a.id.localeCompare(b.id)));
  return { entries: all, gaps };
}

/** Pure. Which entries does a filter keep? */
function matches(e, filter) {
  switch (filter) {
    case 'investigations': return !!e.investigationRef || e.type.startsWith('investigation.');
    case 'actions': return ['acted', 'prepared'].includes(e.category) || (e.category === 'verified' && !!e.actionRef) || e.type.startsWith('selfheal.');
    case 'sources': return e.sourceRefs.length > 0;
    case 'decisions': return e.category === 'decided';
    case 'problems': return e.category === 'blocked' || FAILED_STATUSES.includes(e.status) || e.severity === 'warning';
    case 'approvals': return e.actor === 'nick' && e.authority === 'A4';
    default: return true;
  }
}

/** Pure. "Today NEURO…" — counts read off the entries, never invented. */
function summarise(entries) {
  const c = {
    // An episode folded into one line is still a thing NEURO noticed (16Y).
    noticed: entries.filter((e) => e.type === 'source.stopped').length
      + entries.filter((e) => e.type === 'source.quiet-episode').reduce((n, e) => n + ((e.metadata && e.metadata.folded) || 1), 0),
    investigated: new Set(entries.filter((e) => e.category === 'investigated').map((e) => e.investigationRef)).size,
    fixed: entries.filter((e) => e.type === 'selfheal.recovered').length,
    fixAttempts: entries.filter((e) => e.type === 'selfheal.executed').length,
    verified: entries.filter((e) => e.category === 'verified' || e.type === 'selfheal.recovered').filter((e) => ['recovered', 'verified', 'confirmed'].includes(e.status)).length,
    recovered: entries.filter((e) => e.category === 'recovered').length,
    prepared: entries.filter((e) => e.category === 'prepared' && e.authority === 'A4').length,
    // An uncertain OUTCOME is about something NEURO did; "can't tell whether a
    // hike happened" is about Nick's week, not an outcome of NEURO's.
    uncertain: entries.filter((e) => e.status === 'uncertain' && !e.type.startsWith('goal.')).length,
    failed: entries.filter((e) => e.status === 'failed').length,
    approvals: entries.filter((e) => e.actor === 'nick' && e.authority === 'A4' && e.category === 'decided').length,
    blocked: entries.filter((e) => e.category === 'blocked').reduce((n, e) => n + ((e.metadata && e.metadata.count) || 1), 0),
  };
  const n = (k, one, many) => `${c[k]} ${c[k] === 1 ? one : many}`;
  const autonomous = c.noticed + c.investigated + c.fixAttempts + c.prepared + c.uncertain + c.failed + c.recovered;
  const lines = autonomous === 0 && !c.approvals && !c.blocked ? ['No autonomous actions today.'] : [
    `investigated ${n('investigated', 'source issue', 'source issues')}`,
    `fixed ${n('fixed', 'low-risk problem', 'low-risk problems')}${c.fixAttempts > c.fixed ? ` (${c.fixAttempts} attempted)` : ''}`,
    `verified ${n('verified', 'recovery or result', 'recoveries or results')}`,
    `prepared ${n('prepared', 'action', 'actions')} for approval`,
    `had ${n('uncertain', 'uncertain outcome', 'uncertain outcomes')}`,
    ...(c.failed ? [`saw ${n('failed', 'failure', 'failures')}`] : []),
    ...(c.approvals ? [`recorded ${n('approvals', 'decision', 'decisions')} of yours`] : []),
    ...(c.blocked ? [`refused ${c.blocked} machine request${c.blocked === 1 ? '' : 's'}`] : []),
  ];
  return { counts: c, lines };
}

/** Declared, not discovered: work deliberately left for later (15Z). */
const PENDING = Object.freeze([
  { id: 'ios-build16', text: 'iOS Build 16 (durable location queue, visits, geofences, SAiM device reports) is committed but not yet built and installed (needs the Mac)' },
  { id: 'ios-device-proof', text: 'Offline / kill / reboot replay has not yet been proven on the real phone' },
]);

/**
 * Build 16Z: "Autonomy today" — read-only, counted off today's entries plus two
 * live reads (what waits for Nick, which switches hold autonomy back). Never
 * throws; an unreadable part is null, never zero.
 */
const AUTONOMY_SWITCHES = Object.freeze(['self_heal', 'source_blind_live', 'governed_execution', 'governed_calendar']);
function autonomy(todayCounts) {
  const out = {
    investigations: todayCounts.investigated,
    automaticFixes: todayCounts.fixAttempts,
    verifiedRecoveries: todayCounts.fixed,
    awaitingNick: null,
    failedOrUncertain: todayCounts.failed + todayCounts.uncertain,
    switchesOff: null,
  };
  try {
    const n = require('./prepared-actions').needsYou();
    out.awaitingNick = n && n.known !== false ? (n.needsApproval || 0) + (n.needsReview || 0) : null;
  } catch { out.awaitingNick = null; }
  try {
    const flags = require('./feature-flags');
    out.switchesOff = AUTONOMY_SWITCHES
      .map((k) => ({ key: k, flag: flags.FLAGS.find((f) => f.key === k) }))
      .filter((x) => x.flag && flags.isEnabled(x.key) === false)
      .map((x) => ({ key: x.key, label: x.flag.label }));
  } catch { out.switchesOff = null; }
  return out;
}

function _localDayStartIso(nowMs) {
  const local = require('./world-model').localMinute(nowMs);
  // Midnight local as an instant: walk back from now by the local clock.
  const mins = +local.slice(11, 13) * 60 + +local.slice(14, 16);
  return new Date(Math.floor(nowMs / 60000) * 60000 - mins * 60000).toISOString();
}

/** The page: entries for a window, the filter, and today's summary. */
function read({ now = Date.now(), from = null, to = null, filter = 'all', limit = 200 } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const toIso = to || new Date(nowMs).toISOString();
  const fromIso = from || new Date(nowMs - 7 * 86400000).toISOString();
  const f = FILTERS.includes(filter) ? filter : 'all';
  const { entries, gaps } = collect({ fromIso, toIso });
  const startToday = _localDayStartIso(nowMs);
  const today = summarise(collect({ fromIso: startToday, toIso: new Date(nowMs).toISOString() }).entries);
  const kept = entries.filter((e) => matches(e, f));
  return {
    contract: 'activity-v1', from: fromIso, to: toIso, filter: f, filters: FILTERS,
    today: { ...today, autonomy: autonomy(today.counts) }, total: kept.length, entries: kept.slice(0, Math.max(1, Math.min(MAX_ENTRIES, limit))), gaps, pending: PENDING,
  };
}

module.exports = {
  CATEGORIES, ACTORS, FILTERS, PENDING, AUTONOMY_SWITCHES, autonomy,
  entry, fromNativeBuilds, fromPersonalDates, fromFindings, fromInvestigations, fromSelfHeal, fromPreparedActions, fromExternalWrites, fromRefusals, fromFlagChanges, fromEventLog, fromGoalLoop, fromPersonalOps,
  collect, matches, summarise, read,
};
