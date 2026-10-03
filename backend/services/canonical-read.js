'use strict';

/**
 * The canonical UI read contract (Build 10A).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Builds 1–5 built a world model; Build 9 found that NO surface on any
 * platform read it. Every screen still joined raw source tables — waiting_on,
 * calendar_cache, agent_state — so the same fact could be "blind" on one
 * screen and "live" on another. This module is the ONE place a surface asks
 * "what does NEURO currently believe?", so NEURO web, the SAiM shells and iOS
 * read the same answer instead of each assembling their own.
 *
 * ── What it is and is not ───────────────────────────────────────────────────
 *  • It READS projections (wm_*, source_health, *_findings, prepared actions)
 *    and composes them. It decides nothing: attention stays the one decision
 *    (embedded verbatim in `now`), evaluators stay the one judge of risk.
 *  • It never exposes storage detail (column names, JSON blobs, event seqs
 *    other than as evidence refs). Every item carries a canonical id, a
 *    freshness, an uncertainty and a provenance kind.
 *  • The SHAPERS below are pure (row in → UI shape out, `today`/`now`
 *    passed). Readers at the bottom are the only DB/network-touching code.
 *
 * Contract version travels on every payload so a client can tell which shape
 * it is reading after an upgrade.
 */

const domainsLib = require('../../shared/life-domains.cjs');

const CONTRACT = 'canonical-v1';
const DAY_MS = 24 * 60 * 60 * 1000;

// "Soon" for a stated deadline. Matches commitment-risk's near window so the
// Commitments screen and the evaluator do not disagree about what is near.
const SOON_DAYS = 3;
// How far back an overdue STATED deadline stays relevant on Now. Older than
// this it is history to clear on the Commitments screen, not a "now" item.
const NOW_OVERDUE_DAYS = 14;

// ── small pure helpers ──────────────────────────────────────────────────────

function parseJson(s, fallback = null) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/** Whole days from `today` to `date` (both YYYY-MM-DD, wall clock). Never parses into a zone. */
function daysBetween(today, date) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(today || '')) || !/^\d{4}-\d{2}-\d{2}/.test(String(date || ''))) return null;
  const a = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10));
  const b = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
  return Math.round((b - a) / DAY_MS);
}

/** Local wall-clock date for a ms instant — local getters, never toISOString (BST). */
function localDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * What a due date MEANS, as well as when it is.
 * `basis` comes from world-obligations.dueBasis: stated (the sentence named
 * it) / set (a date somebody typed — a PLAN, not a promise; Build 4 measured
 * nine of ten "overdue" set dates as a bulk re-set) / default (NEURO's ten-day
 * placeholder) / none.
 */
function dueContext(due, today) {
  if (!due || !due.date) return { date: null, kind: 'none', relative: 'none', days: null, label: 'No date' };
  const kind = due.basis === 'stated' ? 'stated' : due.basis === 'set' ? 'set' : due.basis === 'default' ? 'placeholder' : 'unknown';
  const days = daysBetween(today, due.date);
  const relative = days == null ? 'unknown' : days < 0 ? 'overdue' : days === 0 ? 'today' : days <= SOON_DAYS ? 'soon' : 'later';
  const when = days == null ? due.date
    : days < 0 ? `${-days} day${days === -1 ? '' : 's'} past`
      : days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  const kindWord = kind === 'stated' ? 'stated deadline' : kind === 'set' ? 'planned date' : kind === 'placeholder' ? 'NEURO placeholder' : 'date';
  return { date: due.date.slice(0, 10), kind, relative, days, label: `${when} · ${kindWord}` };
}

// ── domain evidence (pure) ──────────────────────────────────────────────────

const UNKNOWN_TEAMS = new Set(['unknown', '(to confirm)', '']);

/**
 * Is this person, by their own People note, someone Nick knows through work?
 * Evidence: a line manager, a direct-report flag, or a stated team. A note
 * that says "Unknown" proves nothing and yields null.
 */
function personWorkEvidence(person) {
  if (!person) return null;
  const team = String(person.team || '').trim().toLowerCase();
  if (person.directReport === true || person.directReport === 1) {
    return { domain: 'work', basis: 'inference', why: `${person.displayName} reports to Nick` };
  }
  if (person.manager) return { domain: 'work', basis: 'inference', why: `${person.displayName}'s People note names a line manager` };
  if (team && !UNKNOWN_TEAMS.has(team)) return { domain: 'work', basis: 'inference', why: `${person.displayName}'s People note puts them in ${person.team}` };
  return null;
}

/** Claims from an annotation row (declared by Nick). */
function annotationClaims(annotation) {
  if (!annotation || !Array.isArray(annotation.domains)) return [];
  return annotation.domains.map((d) => ({ domain: d, basis: 'declared', why: 'you set this' }));
}

/** Domain evidence for a commitment. `people` is a Map personId → person. */
function commitmentDomains(c, { annotation = null, people = new Map(), task = null } = {}) {
  const claims = [...annotationClaims(annotation)];
  if (c.source && c.source.kind === 'management-log') {
    claims.push({ domain: 'work', basis: 'source-process', why: 'recorded in your management log' });
  }
  const counterpartId = c.direction === 'to-nick' ? c.promisor && c.promisor.personId : c.beneficiary && c.beneficiary.personId;
  const ev = personWorkEvidence(people.get(counterpartId));
  if (ev) claims.push(ev);
  // A meeting write-up is only evidence through the PEOPLE in it — never because
  // it came from a calendar. Resolved participants are checked by the caller.
  if (task && task.household) claims.push({ domain: 'home', basis: 'set', why: 'shared with the household' });
  // The task-domain DEFAULT, reported as a default — the same answer the
  // Tasks screen gives, never promoted to evidence.
  if (task && task.domain === 'work') claims.push({ domain: 'work', basis: 'default', why: 'its task defaults to work until marked personal' });
  let sphere = null;
  if (task && task.domain === 'personal') sphere = 'personal';
  return domainsLib.resolveDomains(claims, { sphere });
}

/**
 * Domain evidence for a NEURO task row (tasks table). `work` here is the
 * task-domain DEFAULT — reported as such, never as a fact about the task.
 */
function taskDomains(task, { annotation = null } = {}) {
  const claims = [...annotationClaims(annotation)];
  if (task && task.household) claims.push({ domain: 'home', basis: 'set', why: 'shared with the household' });
  if (task && task.domain === 'work') claims.push({ domain: 'work', basis: 'default', why: 'tasks default to work until marked personal' });
  return domainsLib.resolveDomains(claims, { sphere: task && task.domain === 'personal' ? 'personal' : null });
}

/** Domain evidence for a meeting: declared, or through resolved colleagues in it. Never the calendar. */
function meetingDomains(meeting, { annotation = null, people = new Map() } = {}) {
  const claims = [...annotationClaims(annotation)];
  const colleague = (meeting.people || []).map((p) => personWorkEvidence(people.get(p.personId))).find(Boolean);
  if (colleague) claims.push({ ...colleague, why: `${colleague.why}, and is in it` });
  return domainsLib.resolveDomains(claims);
}

// ── commitments (pure) ──────────────────────────────────────────────────────

/**
 * One commitment as a surface should see it.
 *
 * Direction is said in Nick's words: `i-owe` / `owed-to-me`. The counterpart
 * is the OTHER party; an unresolved one keeps its raw name and the reason it
 * did not resolve — it is never dropped and never guessed (a first name
 * shared by two colleagues stays unresolved).
 */
function shapeCommitment(c, { today, annotation = null, people = new Map(), task = null, progress = null, meetingTitle = null } = {}) {
  const mine = c.direction === 'by-nick';
  const party = mine ? c.beneficiary : c.promisor;
  // Three states, not two. A name that did not resolve is an IDENTITY gap and
  // is counted as one; "nobody is named" (most of Nick's own promises) is not —
  // folding them together inflated the unresolved count from 50 to 66 on the
  // live store and made it a number nobody could act on.
  const resolved = !!(party && party.personId);
  const named = !!(party && (party.personId || party.raw));
  const counterpart = {
    personId: resolved ? party.personId : null,
    name: party ? party.displayName || party.raw || null : null,
    status: resolved ? 'resolved' : named ? 'unresolved' : 'not-named',
    resolved,
    method: party ? party.method || null : null,
    why: resolved ? null : named
      ? (party.unresolvedWhy || `"${party.raw}" is not a declared person`)
      : 'nobody is named in the source',
  };
  const occurrence = c.meeting && c.meeting.occurrence ? c.meeting.occurrence : null;
  const meeting = c.meetingId || (c.meeting && c.meeting.notePath) ? {
    meetingId: c.meetingId || null,
    title: meetingTitle || (occurrence && occurrence.title) || noteTitle(c.meeting && c.meeting.notePath),
    start: occurrence ? occurrence.start || null : (c.meeting && c.meeting.noteStartLocal) || null,
    notePath: (c.meeting && c.meeting.notePath) || null,
    linked: !!c.meetingId,
    why: c.meetingId ? null : (c.meeting && c.meeting.why) || 'the write-up could not be tied to one calendar occurrence',
  } : null;
  return {
    id: c.commitmentId,
    kind: 'commitment',
    description: c.description,
    direction: mine ? 'i-owe' : 'owed-to-me',
    counterpart,
    state: c.status,
    due: dueContext(c.due, today),
    meeting,
    taskId: c.relatedTaskId || null,
    progress: progress ? { state: progress.state, basis: progress.basis, reasons: progress.reasons || [] } : null,
    domains: commitmentDomains(c, { annotation, people, task }),
    importance: annotation && annotation.importance ? annotation.importance : null,
    provenance: {
      kind: c.provenance ? c.provenance.kind : null,
      confidence: c.provenance ? c.provenance.confidence : null,
      source: c.source ? { kind: c.source.kind, path: c.source.path || null, date: c.source.date || null } : null,
      evidenceCount: c.provenance && Array.isArray(c.provenance.evidence) ? c.provenance.evidence.length : 0,
    },
    since: c.createdAt || null,
    observedAt: c.observedAt || null,
  };
}

function noteTitle(notePath) {
  if (!notePath) return null;
  const base = String(notePath).split('/').pop().replace(/\.md$/i, '');
  return base.replace(/^\d{4}-\d{2}-\d{2}\s*[–-]\s*/, '') || base;
}

/** Group and count without dropping anything. Unresolved stays visible as its own count. */
function summariseCommitments(items) {
  const out = { total: items.length, iOwe: 0, owedToMe: 0, overdue: 0, soon: 0, unresolved: 0, meetingLinked: 0, byDomain: {}, domainUnknown: 0 };
  for (const i of items) {
    if (i.direction === 'i-owe') out.iOwe += 1; else out.owedToMe += 1;
    if (i.due.relative === 'overdue' && i.due.kind === 'stated') out.overdue += 1;
    if ((i.due.relative === 'today' || i.due.relative === 'soon') && (i.due.kind === 'stated' || i.due.kind === 'set')) out.soon += 1;
    if (i.counterpart.status === 'unresolved') out.unresolved += 1;
    if (i.counterpart.status === 'not-named') out.notNamed = (out.notNamed || 0) + 1;
    if (i.meeting && i.meeting.linked) out.meetingLinked += 1;
    if (!i.domains.domains.length) out.domainUnknown += 1;
    for (const d of i.domains.domains) out.byDomain[d.domain] = (out.byDomain[d.domain] || 0) + 1;
  }
  return out;
}

// ── sources (pure) ──────────────────────────────────────────────────────────

/**
 * One verdict from SourceHealth's separate columns — without collapsing them.
 *
 *   retired  history only; never judged, never blind
 *   failing  deliveries/syncs are failing (transport)
 *   stale    nothing new past its own threshold (freshness)
 *   quiet    old observation, but the transport is alive — plausibly current
 *   seeing   healthy and fresh
 *   unknown  NEURO has no evidence either way — never a green light
 *
 * The verdict is a summary for sorting; the `transport` and `freshness`
 * blocks are always shown beside it, so failing-and-stale is visible as both.
 */
function sourceVerdict(row, lifecycle) {
  if (lifecycle === 'retired') return 'retired';
  if (!row || row.known === false) return 'unknown';
  if (row.state === 'failing') return 'failing';
  if (row.freshness === 'stale') return 'stale';
  if (row.freshness === 'quiet') return 'quiet';
  if (row.state === 'healthy' && row.freshness === 'fresh') return 'seeing';
  return 'unknown';
}

const VERDICT_WORDS = Object.freeze({
  seeing: 'Seeing',
  quiet: 'Quiet, still connected',
  stale: 'Stale',
  failing: 'Failing',
  unknown: 'Unknown',
  retired: 'Retired',
});

// Which life domains a source's DATA serves. Intrinsic to what it carries,
// never to its transport: HealthKit carries health readings; EventKit carries
// a diary whose contents could be any domain, so it serves none by itself.
const SOURCE_DOMAINS = Object.freeze({
  'healthkit.neuro-ios': ['health', 'fitness'],
  'healthkit.saim-ios': ['health', 'fitness'],
  'healthkit.freereps-ios': ['health', 'fitness'],
  'location.neuro-ios': ['travel'],
});

// The senses in /api/signals with no spine source. Kept as a literal list so a
// sense that moves onto the spine is a deliberate one-line removal here.
const OFF_SPINE = Object.freeze([
  { id: 'phone', label: 'Phone via Home Assistant', what: 'where you are, and whether the phone is with you' },
  { id: 'watch', label: 'Apple Watch on the wrist', what: 'whether you have been sitting' },
  { id: 'laptop', label: 'Desktop agent', what: 'whether you are working, and what on' },
  { id: 'router', label: 'Home router', what: 'DHCP health' },
  { id: 'rooms', label: 'Room sensors', what: 'which room you are in' },
  { id: 'rescuetime', label: 'RescueTime', what: 'a second opinion on where the day went' },
  { id: 'diet', label: 'Food & water logging', what: 'whether you have eaten and drunk' },
  { id: 'jira', label: 'Jira escalations', what: 'escalations waiting on you' },
  { id: 'vault', label: 'Obsidian vault', what: 'your notes' },
]);

function shapeSource(row, desc, { blind = null } = {}) {
  const lifecycle = (row && row.lifecycle) || desc.lifecycle;
  const verdict = sourceVerdict(row, lifecycle);
  return {
    id: `source:${desc.sourceId}`,
    sourceId: desc.sourceId,
    label: desc.label,
    what: desc.what || null,
    importance: desc.importance,
    lifecycle,
    verdict,
    verdictLabel: VERDICT_WORDS[verdict],
    domains: (SOURCE_DOMAINS[desc.sourceId] || []).map((d) => ({ domain: d, basis: 'intrinsic' })),
    transport: {
      state: row && row.known !== false ? row.state : 'unknown',
      lastAttemptAt: row ? row.lastAttemptAt || null : null,
      lastSuccessAt: row ? row.lastSuccessAt || null : null,
      lastFailureAt: row ? row.lastFailureAt || null : null,
      consecutiveFailures: row ? row.consecutiveFailures || 0 : 0,
      failure: row && row.failure ? (row.failure.reason || row.failure.error || null) : null,
      aliveVia: row ? row.transportSourceId || null : null,
    },
    freshness: {
      state: row && row.known !== false ? row.freshness : 'unknown',
      basis: row ? row.freshnessBasis || null : null,
      lastObservedAt: row ? row.lastObservedAt || null : null,
      staleAfterMs: row && row.staleAfterMs != null ? row.staleAfterMs : desc.staleAfterMs || null,
      staleSince: row ? row.staleSince || null : null,
      quietSince: row ? row.quietSince || null : null,
    },
    blind: blind ? {
      findingId: blind.findingId, condition: blind.condition, severity: blind.severity,
      since: blind.firstDetectedAt, why: blind.whyItMatters, coveredBy: blind.coveredBy || [],
    } : null,
    evidence: { lastEventSeq: row ? row.lastEventSeq || null : null },
  };
}

/** Does a source's state matter to Nick NOW? Expected, not low importance, and failing/stale/blind. Quiet never does. */
function sourceMatters(s) {
  if (s.lifecycle !== 'expected' || s.importance === 'low') return false;
  if (s.blind && s.blind.severity && s.blind.severity !== 'low') return true;
  return s.verdict === 'failing' || s.verdict === 'stale';
}

// ── findings (pure) ─────────────────────────────────────────────────────────

// Evaluator identity and version. ⚠ No finding row stores the version it was
// produced by — these columns were never written — so `version` is the CURRENT
// code's, reported at evaluator level, and each finding says `versionRecorded:
// false` rather than claiming an old row was produced by today's rules.
const EVALUATORS = Object.freeze({
  'source-blindness': { label: 'Source blindness', version: 'build3b', modeEnv: 'SOURCE_BLIND_MODE' },
  'commitment-risk': { label: 'Commitment at risk', version: 'build4', modeEnv: 'COMMITMENT_RISK_MODE' },
  'meeting-intelligence': { label: 'Meeting intelligence', version: 'build5a', modeEnv: 'MEETING_INTELLIGENCE_MODE' },
  'meeting-context': { label: 'Meeting context (replaced)', version: 'build3d', modeEnv: 'MEETING_CONTEXT_MODE' },
});

/**
 * The attention verdict, in audit words. Concise reasons only — the evaluator's
 * own `why`/`summary` strings — never a model's reasoning transcript.
 */
function attentionVerdict(att, mode) {
  if (!att) return { decided: false, wouldInterrupt: null, sent: false, shadow: mode !== 'live', suppressedBecause: null, deferredTo: null };
  const would = att.push === true || att.wouldPush === true || (att.last && att.last.push === true);
  const why = att.why || (att.last && att.last.why) || null;
  return {
    decided: true,
    wouldInterrupt: !!would,
    sent: !!(att.sent || att.pushedAt),
    shadow: att.shadow === true || mode !== 'live',
    suppressedBecause: would ? null : (typeof why === 'string' ? why : null),
    deferredTo: att.deferredTo || null,
    decidedAt: att.decidedAt || att.lastDecidedAt || null,
  };
}

function shapeFinding(evaluator, f, mode) {
  const ev = EVALUATORS[evaluator];
  const base = {
    id: f.findingId,
    evaluator,
    evaluatorLabel: ev.label,
    evaluatorVersion: ev.version,
    versionRecorded: false,
    mode,
    shadow: mode !== 'live',
    status: f.status,
    attention: attentionVerdict(f.attention, mode),
  };
  if (evaluator === 'source-blindness') {
    return { ...base, type: f.condition, title: `${f.label} — ${f.condition}`, summary: f.whyItMatters,
      confidence: f.confidence, severity: f.severity, createdAt: f.firstDetectedAt, resolvedAt: f.resolvedAt,
      lifecycle: f.status === 'active' ? (f.change || 'new') : `resolved${f.resolution ? `: ${f.resolution}` : ''}`,
      evidenceRefs: (f.evidence || []).map(String), subject: `source:${f.source}`,
      domains: (SOURCE_DOMAINS[f.source] || []).map((d) => ({ domain: d, basis: 'intrinsic' })) };
  }
  if (evaluator === 'commitment-risk') {
    return { ...base, type: (f.triggers || []).map((t) => t.kind || t).join(', ') || 'risk', title: f.summary, summary: f.why,
      confidence: f.confidence, severity: f.level, createdAt: f.firstCreatedAt, resolvedAt: f.resolvedAt,
      lifecycle: f.status === 'active' ? (f.novelty || 'new') : `resolved${f.resolution ? `: ${f.resolution}` : ''}`,
      evidenceRefs: evidenceRefs(f.evidence), subject: f.commitmentId, domains: null };
  }
  return { ...base, type: evaluator === 'meeting-intelligence' ? 'meeting-prep' : (f.trigger && f.trigger.kind) || 'meeting',
    title: f.title, summary: f.summary, confidence: f.confidence, severity: null,
    createdAt: f.firstCreatedAt, resolvedAt: f.status === 'active' ? null : f.updatedAt,
    lifecycle: f.status, evidenceRefs: evidenceRefs(f.evidence || (f.linked ? [].concat(f.linked.here || [], f.linked.elsewhere || []) : [])),
    subject: f.meetingId ? `meeting:${f.meetingId}` : null, domains: null };
}

// Keys whose string value is a canonical reference. Anything else in an
// evidence blob (a direction, a state word, a sentence) is not a reference and
// must not be presented as one — the first cut surfaced "by-nick" as evidence.
const REF_KEYS = new Set(['id', 'eventId', 'evidenceId', 'taskId', 'commitmentId', 'meetingId', 'personId', 'findingId', 'sourceId']);

function evidenceRefs(ev) {
  const out = [];
  const seen = new Set();
  const push = (v) => { const s = String(v); if (!seen.has(s)) { seen.add(s); out.push(s); } };
  const walk = (node, key, depth) => {
    if (node == null || depth > 5 || out.length >= 20) return;
    if (Array.isArray(node)) {
      for (const x of node) {
        if ((typeof x === 'string' || typeof x === 'number') && (key === 'evidenceIds' || key === 'evidence' || key === 'eventIds')) push(x);
        else walk(x, key, depth + 1);
      }
      return;
    }
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if ((typeof v === 'string' || typeof v === 'number') && REF_KEYS.has(k) && v !== '') push(v);
      else if (typeof v === 'object') walk(v, k, depth + 1);
    }
  };
  if (Array.isArray(ev) && ev.every((x) => typeof x === 'string' || typeof x === 'number')) ev.forEach(push);
  else walk(ev, null, 0);
  return out.slice(0, 20);
}

// ── Now (pure composition) ──────────────────────────────────────────────────

/**
 * Does a commitment belong on Now? Only a deadline somebody STATED, or a plan
 * due today/tomorrow. A placeholder never; an overdue PLAN never (it is a
 * plan that moved, not a broken promise — Build 4's live measurement).
 */
function commitmentIsNowRelevant(item) {
  if (item.state !== 'open') return false;
  const { kind, relative, days } = item.due;
  if (kind === 'stated') return relative === 'today' || relative === 'soon' || (relative === 'overdue' && days >= -NOW_OVERDUE_DAYS);
  if (kind === 'set') return relative === 'today' || (relative === 'soon' && days <= 1);
  return false;
}

/**
 * Order commitments for Now. Domain-BLIND on purpose: work does not outrank
 * a personal item by being work. Order is when (overdue, today, soon), then
 * whether Nick has said it matters to HIM, then the date.
 */
function rankNowCommitments(items) {
  const when = { overdue: 0, today: 1, soon: 2, later: 3, none: 4, unknown: 5 };
  const importance = { 'personally-important': 0, 'work-critical': 0, restorative: 1, optional: 3 };
  return [...items].sort((a, b) =>
    (when[a.due.relative] - when[b.due.relative])
    || ((importance[a.importance] ?? 2) - (importance[b.importance] ?? 2))
    || String(a.due.date || '').localeCompare(String(b.due.date || ''))
    || String(a.id).localeCompare(String(b.id)));
}

/**
 * "Work is crowding out something personal" — said ONLY on evidence:
 * the working day's real meetings fill at least `fullHours`, AND a commitment
 * whose domains are known to be non-work (declared or set) is due today or
 * tomorrow. Anything less is not evidence and stays silent.
 */
function crowdedOut({ workMeetingMinutes, personalDue }) {
  const FULL = 5 * 60;
  if (!(workMeetingMinutes >= FULL) || !personalDue.length) return null;
  return {
    workMeetingHours: Math.round(workMeetingMinutes / 6) / 10,
    items: personalDue.slice(0, 3).map((i) => ({ id: i.id, description: i.description, due: i.due.label })),
    say: `Meetings fill ${Math.round(workMeetingMinutes / 60)}h of today and ${personalDue.length === 1 ? 'something of yours is' : `${personalDue.length} of your own things are`} due by tomorrow.`,
  };
}

/**
 * Compose Now from the attention DECISION (verbatim) and world-model sections.
 *
 * Every section is optional and appears only with evidence. Dedupe is by
 * canonical id/title against what the decision already shows, so one thing is
 * said once (Build 10 test 11). `calm` is true only when nothing meaningful is
 * present AND nothing that would have been looked at was unreadable — a blind
 * section is never a calm one.
 */
/** Known to be work and nothing else — the only thing off-duty hides. Unknown is never hidden. */
function isKnownWorkOnly(domains) {
  return !!domains && domains.domains.length > 0 && domains.domains.every((d) => d.domain === 'work');
}

function composeNow({ decision = {}, nextEvents = [], nextEvent = null, commitments = [], sources = [], approvals = null, goals = [], crowd = null, gaps = [] }) {
  const shownTitles = new Set();
  const take = (t) => { if (t) shownTitles.add(String(t).trim().toLowerCase()); };
  take(decision.primary && decision.primary.title);
  for (const s of decision.secondary || []) take(s && s.title);
  if (decision.transition && decision.transition.title) take(decision.transition.title);

  // Off duty is life-state's DECISION (decision.life.showWork), honoured here,
  // never re-derived. It holds back only what is KNOWN to be work; an item of
  // unknown domain is shown, because hiding it on a guess hides real things.
  const showWork = !(decision.life && decision.life.showWork === false);
  const held = { work: 0 };
  const candidates = nextEvents.length ? nextEvents : (nextEvent ? [nextEvent] : []);
  const eligible = candidates.filter((e) => showWork || !isKnownWorkOnly(e.domains));
  // One event held, not every work meeting this week: the count says what Now
  // WOULD have led with, not how full the calendar is.
  if (candidates.length && candidates[0] !== eligible[0]) held.work += 1;
  const first = eligible[0] || null;
  const next = first && !shownTitles.has(String(first.title || '').trim().toLowerCase()) ? first : null;
  const due = rankNowCommitments(commitments.filter(commitmentIsNowRelevant))
    .filter((c) => {
      if (!showWork && isKnownWorkOnly(c.domains)) { held.work += 1; return false; }
      return true;
    })
    .filter((c) => !shownTitles.has(String(c.description || '').trim().toLowerCase()))
    .slice(0, 5);
  const blind = sources.filter(sourceMatters).slice(0, 3);
  const needsYou = approvals && approvals.known && (approvals.needsApproval || approvals.needsReview) ? approvals : null;

  const sections = {
    context: decision.context ? { label: decision.context.label, summary: decision.context.summary, quiet: !!decision.quiet, confidence: decision.context.confidence ? decision.context.confidence.level : null } : null,
    nextEvent: next,
    needsYou,
    commitments: due.length ? due : null,
    blindness: blind.length ? blind : null,
    crowdedOut: crowd,
    goals: goals.length ? goals : null,
  };
  const meaningful = !!(decision.primary && decision.primary.kind === 'item') || !!sections.nextEvent || !!needsYou
    || !!sections.commitments || !!sections.blindness || !!crowd;
  const unreadable = (gaps || []).length > 0 || decision.poolAvailable === false;
  return {
    sections,
    calm: !meaningful && !unreadable,
    calmSay: !meaningful
      ? (unreadable ? 'Nothing is asking for you — but some of what NEURO looks at could not be read, so this is not an all-clear.' : 'Nothing needs you right now.')
      : null,
    uncertainty: { unreadable, gaps },
    workHeld: showWork ? null : { count: held.work, say: held.work ? `${held.work} work item${held.work === 1 ? '' : 's'} held back while you're off duty.` : null },
  };
}

// ── readers (DB) ────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }

function getAnnotations(ids = null) {
  const db = _db();
  const rows = ids && ids.length
    ? db.all(`SELECT * FROM life_annotations WHERE entity_id IN (${ids.map(() => '?').join(',')})`, ids)
    : db.all('SELECT * FROM life_annotations');
  const map = new Map();
  for (const r of rows) map.set(r.entity_id, { domains: parseJson(r.domains_json, null), importance: r.importance || null, setAt: r.set_at });
  return map;
}

/**
 * Nick declares a thing's domains and/or personal importance.
 *  • OMITTED leaves a field as it is; explicit NULL clears it ("not said").
 *  • An unrecognised domain or importance is REFUSED, never normalised away.
 */
function setAnnotation(entityId, { domains, importance } = {}, { now = Date.now() } = {}) {
  if (!entityId || typeof entityId !== 'string' || entityId.length > 300) return { ok: false, error: 'entityId is required' };
  const db = _db();
  const held = db.get('SELECT * FROM life_annotations WHERE entity_id = ?', [entityId]);
  let nextDomains = held ? held.domains_json : null;
  let nextImportance = held ? held.importance : null;
  if (domains !== undefined) {
    if (domains === null) nextDomains = null;
    else {
      if (!Array.isArray(domains)) return { ok: false, error: 'domains must be a list' };
      const norm = domains.map(domainsLib.normaliseDomain);
      const bad = domains.filter((d, i) => !norm[i]);
      if (bad.length) return { ok: false, error: `unknown domain: ${bad.join(', ')}` };
      nextDomains = norm.length ? JSON.stringify([...new Set(norm)]) : null;
    }
  }
  if (importance !== undefined) {
    if (importance === null) nextImportance = null;
    else {
      const v = domainsLib.normaliseImportance(importance);
      if (!v) return { ok: false, error: `unknown importance: ${importance}` };
      nextImportance = v;
    }
  }
  const iso = new Date(now).toISOString();
  if (!nextDomains && !nextImportance) {
    db.run('DELETE FROM life_annotations WHERE entity_id = ?', [entityId]);
  } else {
    db.run(`INSERT INTO life_annotations (entity_id, domains_json, importance, set_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(entity_id) DO UPDATE SET domains_json = excluded.domains_json, importance = excluded.importance, set_at = excluded.set_at`,
    [entityId, nextDomains, nextImportance, iso]);
  }
  const a = getAnnotations([entityId]).get(entityId) || null;
  return { ok: true, entityId, annotation: a };
}

function _peopleMap() {
  const wm = require('./world-model');
  const map = new Map();
  try { for (const p of wm.listPeople()) map.set(p.personId, p); } catch { /* empty map: no inference */ }
  return map;
}

function _projection(consumer) {
  try {
    const st = require('./event-bus').getStatus().consumers.find((c) => c.name === consumer);
    return { consumer, current: !!st && st.lag === 0 && st.retrying === 0, lag: st ? st.lag : null, lastProcessedAt: st ? st.lastProcessedAt || null : null };
  } catch { return { consumer, current: null, lag: null, lastProcessedAt: null }; }
}

function _neuroTaskRows(taskIds) {
  const nums = taskIds.map((id) => /^task:neuro:(\d+)$/.exec(id || '')).filter(Boolean).map((m) => Number(m[1]));
  const map = new Map();
  if (!nums.length) return map;
  const db = _db();
  for (const r of db.all(`SELECT id, domain, household FROM tasks WHERE id IN (${nums.map(() => '?').join(',')})`, nums)) {
    map.set(`task:neuro:${r.id}`, { domain: r.domain, household: r.household === 1 });
  }
  return map;
}

function _progressMap() {
  try {
    const sum = require('./progress-evidence').summary();
    return { map: new Map(sum.items.map((i) => [i.commitmentId, i])), coverage: sum.coverage };
  } catch { return { map: new Map(), coverage: null }; }
}

/** GET commitments, canonical. `direction` = i-owe | owed-to-me | null. */
function commitments({ direction = null, status = 'open', now = Date.now(), domain = null } = {}) {
  const wo = require('./world-obligations');
  const dir = direction === 'i-owe' ? 'by-nick' : direction === 'owed-to-me' ? 'to-nick' : null;
  const rows = wo.listCommitments({ status, direction: dir, limit: 2000 });
  const today = localDate(now);
  const people = _peopleMap();
  const ann = getAnnotations();
  const tasks = _neuroTaskRows(rows.map((r) => r.relatedTaskId));
  const prog = _progressMap();
  let items = rows.map((c) => shapeCommitment(c, {
    today, people, annotation: ann.get(c.commitmentId) || null,
    task: tasks.get(c.relatedTaskId) || null, progress: prog.map.get(c.commitmentId) || null,
  }));
  if (domain === 'unknown') items = items.filter((i) => !i.domains.domains.length);
  else if (domain) items = items.filter((i) => i.domains.domains.some((d) => d.domain === domain));
  return {
    contract: CONTRACT,
    asOf: new Date(now).toISOString(),
    freshness: _projection('world-model'),
    progressCoverage: prog.coverage,
    filter: { direction, status, domain },
    counts: summariseCommitments(items),
    items,
  };
}

/** One commitment with its evidence trail (progress, provenance, linked task). */
function commitmentDetail(id, { now = Date.now() } = {}) {
  const wo = require('./world-obligations');
  const c = wo.getCommitment(id);
  if (!c) return null;
  const people = _peopleMap();
  const tasks = _neuroTaskRows([c.relatedTaskId]);
  let progress = null;
  try { progress = require('./progress-evidence').progressFor(id); } catch { progress = null; }
  const item = shapeCommitment(c, { today: localDate(now), people, annotation: getAnnotations([id]).get(id) || null,
    task: tasks.get(c.relatedTaskId) || null, progress });
  const task = c.relatedTaskId ? wo.getTask(c.relatedTaskId) : null;
  return {
    contract: CONTRACT,
    item,
    evidence: {
      provenance: { kind: c.provenance.kind, confidence: c.provenance.confidence, eventIds: c.provenance.evidence },
      source: c.source,
      progress: progress ? { state: progress.state, basis: progress.basis, reasons: progress.reasons, coverage: progress.coverage,
        evidence: (progress.evidence || []).map((e) => ({ kind: e.kind, at: e.at, polarity: e.polarity, strength: e.strength, provenance: e.provenance, reason: e.reason })) } : null,
      task: task ? { id: task.taskId, title: task.title, state: task.status, completionAuthority: task.completionAuthority,
        possibleCompletion: task.possibleCompletion ? { kind: 'inference', note: task.possibleCompletion.note || null } : null } : null,
      promisorResolution: c.promisor,
    },
  };
}

/** Canonical sources: SourceHealth for the spine, declared sources included even if never heard from. */
function sources({ now = Date.now() } = {}) {
  const sh = require('./source-health');
  const ns = require('./native-sources');
  const health = sh.getSourceHealth({ now });
  const rowsById = new Map((health.sources || []).map((r) => [r.sourceId, { ...r, known: true }]));
  let blind = [];
  try { blind = require('./source-blindness').getFindings({ status: 'active', now }); } catch { blind = []; }
  const blindBySource = new Map(blind.map((f) => [f.source, f]));
  const ids = [...new Set([...Object.keys(ns.SOURCES || {}), ...rowsById.keys()])];
  const order = { failing: 0, stale: 1, unknown: 2, quiet: 3, seeing: 4, retired: 5 };
  const spine = ids.map((id) => shapeSource(rowsById.get(id) || null, ns.describe(id), { blind: blindBySource.get(id) || null }))
    .sort((a, b) => order[a.verdict] - order[b.verdict] || a.label.localeCompare(b.label));
  const counts = {};
  for (const s of spine) counts[s.verdict] = (counts[s.verdict] || 0) + 1;
  let runtime = null;
  try {
    const st = require('./runtime-jobs').status({ now });
    runtime = {
      jobs: (st.jobs || st || []).map((j) => ({ name: j.name, lastSuccessAt: j.lastSuccessAt || null, lastFailureAt: j.lastFailureAt || null,
        lastError: j.lastError || null, overdue: j.overdue || 0, failed24h: (j.last24h && j.last24h.failed) || 0 })),
    };
  } catch { runtime = null; }
  return {
    contract: CONTRACT,
    asOf: new Date(now).toISOString(),
    truth: 'source-health',
    projection: health.projection || null,
    counts,
    spine,
    // Senses NEURO uses that are not on the event spine yet. NAMES ONLY — no
    // state — because their checks are the older ones, and putting those
    // verdicts here beside SourceHealth's would be two health truths on one
    // screen. Coverage is said; the judgement stays where it is made.
    offSpine: OFF_SPINE,
    runtime,
  };
}

function _mode(mod) {
  try { return require(`./${mod}`).mode(); } catch { return 'unknown'; }
}

/** Every evaluator's findings in one audit shape. */
function findings({ status = 'active', limit = 100 } = {}) {
  const want = status === 'all' ? null : status;
  const out = [];
  const evaluators = [];
  const add = (name, mod, read, mapStatus) => {
    const mode = _mode(mod);
    let rows = [];
    let error = null;
    try { rows = read(mapStatus(want)); } catch (e) { error = e.message; }
    evaluators.push({ name, label: EVALUATORS[name].label, version: EVALUATORS[name].version, mode, shadow: mode !== 'live', readable: !error, error, count: rows.length });
    for (const f of rows) out.push(shapeFinding(name, f, mode));
  };
  add('source-blindness', 'source-blindness', (s) => require('./source-blindness').getFindings({ status: s, limit }), (s) => (s === 'active' || s === 'resolved' ? s : null));
  add('commitment-risk', 'commitment-risk', (s) => require('./commitment-risk').findings({ status: s, limit }), (s) => (s === 'active' || s === 'resolved' ? s : null));
  add('meeting-intelligence', 'meeting-intelligence', (s) => require('./meeting-intelligence').findings({ status: s, limit }), (s) => (s === 'active' ? 'active' : s === 'resolved' ? 'expired' : null));
  add('meeting-context', 'meeting-context', (s) => require('./meeting-context').findings({ status: s, limit }), (s) => (s === 'active' ? 'active' : s === 'resolved' ? 'expired' : null));
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return { contract: CONTRACT, status, evaluators, findings: out };
}

function listGoals({ status = 'active' } = {}) {
  const db = _db();
  const rows = status === 'all' ? db.all('SELECT * FROM goals ORDER BY created_at') : db.all('SELECT * FROM goals WHERE status = ? ORDER BY created_at', [status]);
  return rows.map((r) => ({ id: r.goal_id, title: r.title, status: r.status, note: r.note || null,
    domains: (parseJson(r.domains_json, []) || []).map((d) => ({ domain: d, basis: 'declared' })), createdAt: r.created_at, updatedAt: r.updated_at }));
}

const GOAL_STATUSES = ['active', 'paused', 'done', 'dropped'];

function saveGoal({ id = null, title, domains, status, note } = {}, { now = Date.now() } = {}) {
  const db = _db();
  const iso = new Date(now).toISOString();
  if (status !== undefined && !GOAL_STATUSES.includes(status)) return { ok: false, error: `status must be one of ${GOAL_STATUSES.join(', ')}` };
  let domainsJson;
  if (domains !== undefined) {
    if (domains !== null && !Array.isArray(domains)) return { ok: false, error: 'domains must be a list' };
    const norm = (domains || []).map(domainsLib.normaliseDomain);
    if (norm.some((d) => !d)) return { ok: false, error: 'unknown domain' };
    domainsJson = norm.length ? JSON.stringify([...new Set(norm)]) : null;
  }
  if (!id) {
    const t = typeof title === 'string' ? title.trim() : '';
    if (!t) return { ok: false, error: 'title is required' };
    const gid = `goal:${require('crypto').randomUUID()}`;
    db.run('INSERT INTO goals (goal_id, title, domains_json, status, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [gid, t.slice(0, 300), domainsJson || null, status || 'active', note ? String(note).slice(0, 2000) : null, iso, iso]);
    return { ok: true, goal: listGoals({ status: 'all' }).find((g) => g.id === gid) };
  }
  const held = db.get('SELECT * FROM goals WHERE goal_id = ?', [id]);
  if (!held) return { ok: false, error: 'no such goal', status: 404 };
  db.run('UPDATE goals SET title = ?, domains_json = ?, status = ?, note = ?, updated_at = ? WHERE goal_id = ?', [
    typeof title === 'string' && title.trim() ? title.trim().slice(0, 300) : held.title,
    domainsJson !== undefined ? domainsJson : held.domains_json,
    status || held.status,
    note !== undefined ? (note ? String(note).slice(0, 2000) : null) : held.note,
    iso, id]);
  return { ok: true, goal: listGoals({ status: 'all' }).find((g) => g.id === id) };
}

/**
 * Per-domain coverage: how much of each part of Nick's life the world model
 * can currently SEE. Counts evidence, never judges the life. A domain with
 * nothing is reported with zeros, not dropped — an empty row is the finding.
 */
function coverageByDomain({ commitmentItems = [], sourceItems = [], goals = [], events = [] }) {
  const rows = Object.fromEntries(domainsLib.DOMAINS.map((d) => [d, { domain: d, label: domainsLib.LABELS[d], commitments: 0, sources: 0, goals: 0, upcoming: 0, declared: 0 }]));
  const bump = (doms, key) => {
    for (const d of (doms && doms.domains) || []) {
      if (!rows[d.domain]) continue;
      rows[d.domain][key] += 1;
      if (d.basis === 'declared') rows[d.domain].declared += 1;
    }
  };
  for (const c of commitmentItems) bump(c.domains, 'commitments');
  for (const s of sourceItems) if (s.lifecycle !== 'retired') bump({ domains: s.domains }, 'sources');
  for (const g of goals) bump({ domains: g.domains }, 'goals');
  for (const e of events) bump(e.domains, 'upcoming');
  return {
    domains: domainsLib.DOMAINS.map((d) => rows[d]),
    unknown: {
      commitments: commitmentItems.filter((c) => !c.domains.domains.length).length,
      upcoming: events.filter((e) => !e.domains.domains.length).length,
    },
  };
}

async function life({ now: nowMs = Date.now() } = {}) {
  const people = _peopleMap();
  const gaps = [];
  const safe = (name, fn, dflt) => { try { return fn(); } catch (e) { gaps.push({ input: name, why: e.message }); return dflt; } };
  const commitmentItems = safe('commitments', () => commitments({ now: nowMs }).items, []);
  const sourceItems = safe('sources', () => sources({ now: nowMs }).spine, []);
  const goals = safe('goals', () => listGoals({ status: 'active' }), []);
  const events = safe('meetings', () => {
    const wm = require('./world-model');
    const up = wm.nextMeetings({ now: nowMs, limit: 60 }).filter((m) => m.kind !== 'block');
    const ann = getAnnotations(up.map((m) => m.meetingId));
    return up.map((m) => ({ id: m.meetingId, domains: meetingDomains(m, { people, annotation: ann.get(m.meetingId) || null }) }));
  }, []);
  return { contract: CONTRACT, asOf: new Date(nowMs).toISOString(), goals, coverage: coverageByDomain({ commitmentItems, sourceItems, goals, events }), gaps };
}

/** Real-meeting minutes in today's working diary (work-domain meetings only). */
function _workMeetingMinutesToday(nowMs, people) {
  const db = _db();
  const today = localDate(nowMs);
  const wm = require('./world-model');
  const rows = db.all(`SELECT * FROM wm_meetings WHERE status = 'scheduled' AND kind = 'meeting' AND substr(start_local,1,10) = ?`, [today]);
  let minutes = 0;
  for (const r of rows) {
    const m = wm.shapeMeeting(r, nowMs);
    if (m.isAllDay) continue;
    const doms = meetingDomains(m, { people });
    if (!doms.domains.some((d) => d.domain === 'work')) continue;
    const s = Date.parse(`${m.start}:00`); const e = Date.parse(`${m.end}:00`);
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) minutes += (e - s) / 60000;
  }
  return minutes;
}

/**
 * The Nick-first Now read model: the attention decision (verbatim, it IS the
 * decision) plus world-model situation sections. One payload, so a renderer
 * cannot show the decision from one moment and the world from another.
 */
async function now({ now: nowMs = Date.now(), decision = null } = {}) {
  const gaps = [];
  let dec = decision;
  if (!dec) {
    try { dec = await require('./attention').build({ now: new Date(nowMs) }); } catch (e) { dec = { poolAvailable: false, gaps: [{ input: 'attention', why: e.message }] }; }
  }
  const people = _peopleMap();
  let nextEvents = [];
  try {
    const wm = require('./world-model');
    const st = wm.meetingState({ now: nowMs });
    // A solo work block is a plan, not an event. `unknown` is KEPT: that is how
    // phone-calendar (personal diary) events arrive, and dropping them would
    // make the next meaningful event structurally a work one.
    const upcoming = wm.nextMeetings({ now: nowMs, limit: 20 }).filter((x) => x.kind !== 'block').slice(0, 10);
    const ann = getAnnotations(upcoming.map((m) => m.meetingId));
    nextEvents = upcoming.map((m) => ({ id: m.meetingId, title: m.title, start: m.start, end: m.end, kind: m.kind,
      withPeople: (m.people || []).map((p) => p.displayName), unresolvedPeople: m.unresolvedParticipants || 0,
      domains: meetingDomains(m, { people, annotation: ann.get(m.meetingId) || null }),
      source: (m.sources || []).map((s) => s.provider), freshness: m.freshness ? m.freshness.freshness : null,
      projectionCurrent: st.projection.current }));
  } catch (e) { gaps.push({ input: 'meetings', why: e.message }); }
  let commitmentItems = [];
  try { commitmentItems = commitments({ now: nowMs }).items; } catch (e) { gaps.push({ input: 'commitments', why: e.message }); }
  let sourceItems = [];
  try { sourceItems = sources({ now: nowMs }).spine; } catch (e) { gaps.push({ input: 'sources', why: e.message }); }
  let goals = [];
  try { goals = listGoals({ status: 'active' }); } catch (e) { gaps.push({ input: 'goals', why: e.message }); }
  let crowd = null;
  try {
    const personalDue = commitmentItems.filter((i) => commitmentIsNowRelevant(i) && i.domains.domains.length
      && i.domains.domains.every((d) => d.domain !== 'work') && i.domains.domains.some((d) => ['declared', 'set', 'intrinsic'].includes(d.basis)));
    crowd = crowdedOut({ workMeetingMinutes: _workMeetingMinutesToday(nowMs, people), personalDue });
  } catch (e) { gaps.push({ input: 'work-balance', why: e.message }); }
  const allGaps = [...(dec.gaps || []), ...gaps];
  const composed = composeNow({ decision: dec, nextEvents, commitments: commitmentItems, sources: sourceItems,
    approvals: dec.approvals || null, goals, crowd, gaps: allGaps });
  return { ...dec, contract: CONTRACT, situation: composed };
}

module.exports = {
  CONTRACT, SOON_DAYS, NOW_OVERDUE_DAYS, EVALUATORS, VERDICT_WORDS, SOURCE_DOMAINS, GOAL_STATUSES, OFF_SPINE,
  // pure
  daysBetween, localDate, dueContext, personWorkEvidence, commitmentDomains, taskDomains, meetingDomains,
  shapeCommitment, summariseCommitments, sourceVerdict, shapeSource, sourceMatters, attentionVerdict, shapeFinding,
  commitmentIsNowRelevant, rankNowCommitments, crowdedOut, composeNow, noteTitle, coverageByDomain, isKnownWorkOnly,
  // readers / writers
  commitments, commitmentDetail, sources, findings, now, life, getAnnotations, setAnnotation, listGoals, saveGoal,
};
