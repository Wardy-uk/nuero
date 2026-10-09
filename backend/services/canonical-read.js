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

// Build 11E: a relationship a People note STATES. Family relationships give
// the family domain on basis `classified` — Nick said who this person is to
// him. Nothing is inferred from how often they talk, and `friend` names no
// domain (a friend is not a part of life on their own).
const FAMILY_RELATIONSHIPS = new Set(['spouse', 'partner', 'family', 'child', 'parent', 'sibling', 'household']);
function personRelationshipEvidence(person) {
  if (!person || !person.relationship) return null;
  if (FAMILY_RELATIONSHIPS.has(person.relationship)) {
    return { domain: 'family', basis: 'classified', why: `${person.displayName}'s People note says ${person.relationship}` };
  }
  if (person.relationship === 'colleague') return { domain: 'work', basis: 'inference', why: `${person.displayName}'s People note says colleague` };
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

/**
 * Domain evidence for a meeting/event: declared; the CALENDAR it came through,
 * when Nick classified that calendar (Build 11B — the transport still implies
 * nothing); resolved colleagues or family in it.
 *
 * `calendar` is `{ claims, state, why }` from source-classification.claimsFor,
 * resolved by the caller (the read context holds the maps).
 */
function meetingDomains(meeting, { annotation = null, people = new Map(), calendar = null } = {}) {
  const claims = [...annotationClaims(annotation)];
  if (calendar && calendar.claims) claims.push(...calendar.claims);
  const ppl = (meeting.people || []).map((p) => people.get(p.personId)).filter(Boolean);
  const colleague = ppl.map(personWorkEvidence).find(Boolean);
  if (colleague) claims.push({ ...colleague, why: `${colleague.why}, and is in it` });
  const rel = ppl.map(personRelationshipEvidence).find(Boolean);
  if (rel) claims.push({ ...rel, why: `${rel.why}, and is in it` });
  return domainsLib.resolveDomains(claims);
}

/**
 * Domain evidence for a world-model TASK (wm_tasks shape). A NEURO task keeps
 * Build 10's rules (default work is a default); a reminder's domain is its
 * LIST's classification, and nothing else — unclassified is unknown.
 */
function worldTaskDomains(task, { annotation = null, neuroRow = null, list = null } = {}) {
  const claims = [...annotationClaims(annotation)];
  if (list && list.claims) claims.push(...list.claims);
  if (neuroRow && neuroRow.household) claims.push({ domain: 'home', basis: 'set', why: 'shared with the household' });
  if (neuroRow && neuroRow.domain === 'work') claims.push({ domain: 'work', basis: 'default', why: 'tasks default to work until marked personal' });
  return domainsLib.resolveDomains(claims, { sphere: neuroRow && neuroRow.domain === 'personal' ? 'personal' : null });
}

/**
 * PersonalImportance for an item (Build 11G). Explicit only: Nick's own
 * annotation on the item, else the importance of an ACTIVE goal he explicitly
 * linked it to (basis `goal`). Never from a domain, a source or a severity.
 * Returns `{ value, basis, goalId }` or nulls — null is "not said".
 */
function importanceFor(entityId, { annotation = null, goals = [] } = {}) {
  const own = annotation && annotation.importance ? domainsLib.normaliseImportance(annotation.importance) : null;
  if (own) return { value: own, basis: 'declared', goalId: null };
  const linked = (goals || []).filter((g) => g.status === 'active' && g.importance && (g.links || []).some((l) => l.entityId === entityId));
  if (linked.length) {
    const best = linked.sort((a, b) => domainsLib.importanceRank(a.importance) - domainsLib.importanceRank(b.importance))[0];
    return { value: domainsLib.normaliseImportance(best.importance), basis: 'goal', goalId: best.id };
  }
  return { value: null, basis: null, goalId: null };
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
function shapeCommitment(c, { today, annotation = null, people = new Map(), task = null, progress = null, meetingTitle = null, importance = null, goalIds = null } = {}) {
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
    importance: importance ? importance.value : (annotation && annotation.importance ? domainsLib.normaliseImportance(annotation.importance) : null),
    importanceBasis: importance ? importance.basis : (annotation && annotation.importance ? 'declared' : null),
    goalIds: goalIds || [],
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
  // Build 11H: the first non-work evaluator. Its rows DO record the version.
  'personal-deadline': { label: 'Personal deadline', version: 'build11h', modeEnv: 'PERSONAL_DEADLINE_MODE', recordsVersion: true },
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
  if (evaluator === 'personal-deadline') {
    return { ...base, evaluatorVersion: f.evaluatorVersion || ev.version, versionRecorded: !!f.evaluatorVersion,
      type: f.trigger, title: f.summary, summary: f.why, confidence: f.confidence, severity: f.level,
      createdAt: f.firstCreatedAt, resolvedAt: f.resolvedAt,
      lifecycle: f.status === 'active' ? (f.novelty || 'new') : `resolved${f.resolution ? `: ${f.resolution}` : ''}`,
      evidenceRefs: [f.subjectId, ...((f.evidence && f.evidence.goalIds) || [])].filter(Boolean), subject: f.subjectId,
      domains: f.domains || null, deadline: f.deadline || null, importance: f.importance || null };
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
  return [...items].sort((a, b) =>
    (when[a.due.relative] - when[b.due.relative])
    || (domainsLib.importanceRank(a.importance) - domainsLib.importanceRank(b.importance))
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

// Build 11J. Off duty, an event of UNKNOWN domain may lead Now only when it is
// near: today, or within this many minutes. Further out it is de-emphasised —
// listed, never hidden — because "UAT Testing" on Wednesday is not what
// Saturday is about, and hiding it would be a guess that it is work.
const UNKNOWN_NEAR_MINUTES = 12 * 60;
const IMPORTANT_TO_NICK = new Set(['critical-to-me', 'important-to-me']);

/** Wall-clock minutes from a to b (YYYY-MM-DDTHH:MM, one zone). PURE. */
function minutesFrom(a, b) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(a || '')) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(b || ''))) return null;
  const t = (x) => Date.UTC(+x.slice(0, 4), +x.slice(5, 7) - 1, +x.slice(8, 10), +x.slice(11, 13), +x.slice(14, 16));
  return Math.round((t(b) - t(a)) / 60000);
}

/**
 * Off duty, how relevant is an UNKNOWN-domain event? PURE.
 *   'lead'   may be Now's next event: today, within UNKNOWN_NEAR_MINUTES, or
 *            Nick said it matters to him
 *   'later'  shown de-emphasised, never hidden
 * An unreadable time is treated as near — not knowing when is not a reason
 * to push something out of sight.
 */
function unknownEventRelevance(e, nowLocal) {
  if (e && IMPORTANT_TO_NICK.has(e.importance)) return 'lead';
  const mins = minutesFrom(nowLocal, e && e.start);
  if (mins === null) return 'lead';
  if (String(e.start).slice(0, 10) === String(nowLocal).slice(0, 10)) return 'lead';
  return mins <= UNKNOWN_NEAR_MINUTES ? 'lead' : 'later';
}

/** Does a world-model TASK belong on Now? A stated/set date today or tomorrow, or a stated one overdue ≤14d. */
function taskIsNowRelevant(t) {
  if (t.state !== 'open') return false;
  return commitmentIsNowRelevant({ state: 'open', due: t.due });
}

function composeNow({ decision = {}, nextEvents = [], nextEvent = null, commitments = [], tasks = [], sources = [], approvals = null, goals = [], crowd = null, gaps = [], nowLocal = null }) {
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
  const notWork = candidates.filter((e) => showWork || !isKnownWorkOnly(e.domains));
  // One event held, not every work meeting this week: the count says what Now
  // WOULD have led with, not how full the calendar is.
  if (candidates.length && candidates[0] !== notWork[0]) held.work += 1;
  // Build 11J: off duty, an unknown-domain event far ahead does not lead —
  // it is listed below as "later, domain unknown", never hidden.
  const laterUnknown = [];
  const eligible = notWork.filter((e) => {
    if (showWork || (e.domains && e.domains.domains.length) || !nowLocal) return true;
    if (unknownEventRelevance(e, nowLocal) === 'lead') return true;
    laterUnknown.push(e);
    return false;
  });
  const first = eligible[0] || null;
  const next = first && !shownTitles.has(String(first.title || '').trim().toLowerCase()) ? first : null;
  const due = rankNowCommitments(commitments.filter(commitmentIsNowRelevant))
    .filter((c) => {
      if (!showWork && isKnownWorkOnly(c.domains)) { held.work += 1; return false; }
      return true;
    })
    .filter((c) => !shownTitles.has(String(c.description || '').trim().toLowerCase()))
    .slice(0, 5);
  // Build 11D/P: tasks the attention pool cannot see (reminders — NEURO's own
  // tasks are already the decision's), domain-blind, by when then importance.
  const dueTasks = rankNowCommitments(tasks.filter(taskIsNowRelevant))
    .filter((t) => {
      if (!showWork && isKnownWorkOnly(t.domains)) { held.work += 1; return false; }
      return true;
    })
    .filter((t) => !shownTitles.has(String(t.description || '').trim().toLowerCase()))
    .slice(0, 5);
  const blind = sources.filter(sourceMatters).slice(0, 3);
  const needsYou = approvals && approvals.known && (approvals.needsApproval || approvals.needsReview) ? approvals : null;

  const sections = {
    context: decision.context ? { label: decision.context.label, summary: decision.context.summary, quiet: !!decision.quiet, confidence: decision.context.confidence ? decision.context.confidence.level : null } : null,
    nextEvent: next,
    needsYou,
    commitments: due.length ? due : null,
    tasks: dueTasks.length ? dueTasks : null,
    laterUnknown: laterUnknown.length ? {
      count: laterUnknown.length,
      items: laterUnknown.slice(0, 3).map((e) => ({ id: e.id, title: e.title, start: e.start })),
      say: `${laterUnknown.length} later event${laterUnknown.length === 1 ? '' : 's'} of unknown domain — not leading while you're off duty.`,
    } : null,
    blindness: blind.length ? blind : null,
    crowdedOut: crowd,
    goals: goals.length ? goals : null,
  };
  const meaningful = !!(decision.primary && decision.primary.kind === 'item') || !!sections.nextEvent || !!needsYou
    || !!sections.commitments || !!sections.tasks || !!sections.blindness || !!crowd;
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
  // Importance normalised on READ, so a Build 10 'personally-important' row
  // reads as Build 11's 'important-to-me' without a migration.
  for (const r of rows) map.set(r.entity_id, { domains: parseJson(r.domains_json, null), importance: domainsLib.normaliseImportance(r.importance) || null, setAt: r.set_at });
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

/** Active goals with their explicit links, for importance inheritance. Never throws. */
function _activeGoals() {
  try { return listGoals({ status: 'active' }); } catch { return []; }
}

/**
 * The classification maps one read needs, loaded ONCE (Build 11B). Each map is
 * keyed by container key; the title counts say which title keys are ambiguous.
 */
function _classificationCtx() {
  const sc = require('./source-classification');
  try {
    return {
      sc,
      cal: sc.classificationMap('calendar'), calTitles: sc.effectiveTitleCounts('calendar'),
      list: sc.classificationMap('reminder-list'), listTitles: sc.effectiveTitleCounts('reminder-list'),
    };
  } catch { return { sc, cal: new Map(), calTitles: new Map(), list: new Map(), listTitles: new Map() }; }
}

/** The calendar claims for a meeting row/shape. `{ claims, state, why, key, name }`. */
function _calendarFor(m, ctx) {
  if (!m || !ctx) return null;
  const cal = m.calendar || null;
  const provider = m.provider || (String(m.meetingId || '').startsWith('graph:') ? 'graph' : 'apple');
  if (!cal && provider !== 'graph') return { claims: [], state: 'unknown-calendar', why: 'this entry did not say which calendar it is on', key: null, name: null };
  const item = provider === 'graph' ? { id: null, title: 'Outlook' }
    : /:id:/.test(cal.key || '') ? { id: cal.key.replace(/^eventkit-cal:id:/, ''), title: cal.name } : { id: null, title: cal.name };
  const r = ctx.sc.resolveFor('calendar', item, { byKey: ctx.cal, titleCount: ctx.calTitles, provider: provider === 'graph' ? 'graph' : 'eventkit' });
  const c = ctx.sc.claimsFor(r.classification, { ambiguous: r.ambiguous, label: item.title });
  return { ...c, key: r.key, name: provider === 'graph' ? 'Outlook' : item.title };
}

/** The list claims for a reminder task. */
function _listFor(task, ctx) {
  if (!task || !task.container || !ctx) return null;
  const item = { id: task.container.id, title: task.container.title };
  const r = ctx.sc.resolveFor('reminder-list', item, { byKey: ctx.list, titleCount: ctx.listTitles });
  return { ...ctx.sc.claimsFor(r.classification, { ambiguous: r.ambiguous, label: item.title }), key: r.key, name: item.title };
}

/**
 * One world-model task as a surface sees it (Build 11D). Same shape rules as a
 * commitment: canonical id, due KIND, domains with their bases, importance
 * with its basis, provenance.
 */
function shapeWorldTask(t, { today, annotation = null, neuroRow = null, list = null, importance = null, companions = [] } = {}) {
  const lead = (t.sources || []).find((s) => s.role === 'leading') || (t.sources || [])[0] || null;
  const due = dueContext(t.due, today);
  if (t.dueTime && due.date) due.time = t.dueTime;
  return {
    id: t.taskId,
    kind: 'task',
    description: t.title,
    state: t.status === 'completed' ? 'completed' : t.status === 'cancelled' ? 'cancelled' : t.status === 'unknown' ? 'unknown' : 'open',
    system: lead ? lead.system : null,
    sourceLabel: lead && lead.system === 'eventkit-reminders' ? 'Reminders' : lead && lead.system === 'neuro' ? 'NEURO' : lead && /^ms-/.test(lead.system) ? 'Microsoft' : null,
    container: t.container ? { kind: t.container.kind, name: t.container.title, classification: list ? list.state : null } : null,
    due,
    domains: worldTaskDomains(t, { annotation, neuroRow, list }),
    importance: importance ? importance.value : null,
    importanceBasis: importance ? importance.basis : null,
    // "Mentions Ember" — an INFERENCE from an exact name, never a fact about the task.
    mentions: require('./personal-world').mentions(t.title, companions),
    completionAuthority: t.completionAuthority || null,
    provenance: { kind: t.provenance ? t.provenance.kind : null, origin: t.origin ? t.origin.kind : null,
      evidenceCount: t.provenance && Array.isArray(t.provenance.evidence) ? t.provenance.evidence.length : 0 },
    observedAt: t.observedAt || null,
    // Build 25: when its authoritative source said it was completed (null while open).
    completedAt: t.completedAt || null,
  };
}

/**
 * GET tasks, canonical (Build 11D). `system` narrows ('eventkit-reminders'
 * for the personal reminders); `domain` filters like commitments.
 */
function tasks({ status = 'open', system = null, domain = null, now = Date.now(), limit = 500 } = {}) {
  const wo = require('./world-obligations');
  const today = localDate(now);
  const ctx = _classificationCtx();
  const ann = getAnnotations();
  const goals = _activeGoals();
  let companions = [];
  try { companions = require('./personal-world').listCompanions(); } catch { companions = []; }
  let rows = wo.listTasks({ status: status === 'open' ? 'open' : status, limit: 2000 });
  if (system) rows = rows.filter((t) => (t.sources || []).some((s) => s.system === system && s.role === 'leading'));
  // Build 20A: a reminder is read only while its list is TRACKED (Nick's
  // explicit decision on the list id). One held from a list he has not
  // tracked — or has since ignored — leaves every canonical read at once, and
  // comes back the moment he tracks the list again. Applied at read time: no
  // removal is published, so nothing claims the reminder was deleted.
  let hiddenUntracked = 0;
  rows = rows.filter((t) => {
    const lead = (t.sources || []).find((s) => s.role === 'leading') || (t.sources || [])[0];
    if (!lead || lead.system !== 'eventkit-reminders') return true;
    const ok = !!(t.container && ctx.sc.isTracked({ id: t.container.id }, { byKey: ctx.list }));
    if (!ok) hiddenUntracked += 1;
    return ok;
  });
  const neuroRows = _neuroTaskRows(rows.map((t) => t.taskId));
  let items = rows.map((t) => shapeWorldTask(t, {
    today, annotation: ann.get(t.taskId) || null, neuroRow: neuroRows.get(t.taskId) || null,
    list: _listFor(t, ctx), importance: importanceFor(t.taskId, { annotation: ann.get(t.taskId) || null, goals }), companions,
  }));
  if (domain === 'unknown') items = items.filter((i) => !i.domains.domains.length);
  else if (domain) items = items.filter((i) => i.domains.domains.some((d) => d.domain === domain));
  items = items.slice(0, Math.max(1, Math.min(2000, limit)));
  const counts = { total: items.length, bySystem: {}, domainUnknown: 0, byDomain: {}, hiddenUntrackedReminders: hiddenUntracked };
  for (const i of items) {
    counts.bySystem[i.system || 'unknown'] = (counts.bySystem[i.system || 'unknown'] || 0) + 1;
    if (!i.domains.domains.length) counts.domainUnknown += 1;
    for (const d of i.domains.domains) counts.byDomain[d.domain] = (counts.byDomain[d.domain] || 0) + 1;
  }
  return { contract: CONTRACT, asOf: new Date(now).toISOString(), freshness: _projection('world-model'), filter: { status, system, domain }, counts, items };
}

/** GET commitments, canonical. `direction` = i-owe | owed-to-me | null. */
function commitments({ direction = null, status = 'open', now = Date.now(), domain = null } = {}) {
  const wo = require('./world-obligations');
  const dir = direction === 'i-owe' ? 'by-nick' : direction === 'owed-to-me' ? 'to-nick' : null;
  const rows = wo.listCommitments({ status, direction: dir, limit: 2000 });
  const today = localDate(now);
  const people = _peopleMap();
  const ann = getAnnotations();
  const taskRows = _neuroTaskRows(rows.map((r) => r.relatedTaskId));
  const prog = _progressMap();
  const goals = _activeGoals();
  let items = rows.map((c) => shapeCommitment(c, {
    today, people, annotation: ann.get(c.commitmentId) || null,
    task: taskRows.get(c.relatedTaskId) || null, progress: prog.map.get(c.commitmentId) || null,
    importance: importanceFor(c.commitmentId, { annotation: ann.get(c.commitmentId) || null, goals }),
    goalIds: goals.filter((g) => (g.links || []).some((l) => l.entityId === c.commitmentId)).map((g) => g.id),
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
  add('personal-deadline', 'personal-deadline', (s) => require('./personal-deadline').findings({ status: s, limit }), (s) => (s === 'active' || s === 'resolved' ? s : null));
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return { contract: CONTRACT, status, evaluators, findings: out };
}

const GOAL_STATUSES = ['active', 'paused', 'achieved', 'dropped'];
// Build 10's word for achieved, still accepted on input.
const GOAL_STATUS_ALIASES = { done: 'achieved' };
// `pd:` (Build 19P) is one occurrence of a personal date, e.g. this year's anniversary.
const GOAL_LINK_PREFIXES = /^(task|commitment|person|companion|meeting|goal|pd):/;

function _goalLinks(goalId) {
  return _db().all('SELECT entity_id, relation, set_at FROM goal_links WHERE goal_id = ? ORDER BY entity_id', [goalId])
    .map((l) => ({ entityId: l.entity_id, relation: l.relation, setAt: l.set_at }));
}

function _shapeGoalRow(r) {
  return {
    id: r.goal_id, kind: 'goal', title: r.title, status: r.status === 'done' ? 'achieved' : r.status,
    description: r.description || r.note || null, note: r.note || null,
    domains: (parseJson(r.domains_json, []) || []).map((d) => ({ domain: d, basis: 'declared' })),
    importance: r.importance ? domainsLib.normaliseImportance(r.importance) : null,
    startDate: r.start_date || null, reviewDate: r.review_date || null, lastReviewedAt: r.last_reviewed_at || null,
    links: _goalLinks(r.goal_id),
    // A goal is only ever Nick's statement. Nothing in NEURO writes this table
    // except the route he calls (and its tests).
    provenance: { kind: 'fact', declaredBy: 'nick', via: r.provenance || 'neuro' },
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Goals as Nick declared them. `status` = active | paused | achieved | dropped | all. */
function listGoals({ status = 'active' } = {}) {
  const db = _db();
  const want = GOAL_STATUS_ALIASES[status] || status;
  const rows = want === 'all' ? db.all('SELECT * FROM goals ORDER BY created_at')
    : db.all('SELECT * FROM goals WHERE status = ? OR (? = \'achieved\' AND status = \'done\') ORDER BY created_at', [want, want]);
  return rows.map(_shapeGoalRow);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Create or update a goal. Every field is explicit; OMITTED leaves a field,
 * NULL clears it, an unrecognised value is REFUSED (never normalised away).
 * `links`, when given, REPLACES the goal's explicit links. `reviewed: true`
 * stamps lastReviewedAt. Publishes the goal to the event spine afterwards.
 */
function saveGoal({ id = null, title, domains, status, note, description, importance, startDate, reviewDate, links, reviewed } = {}, { now = Date.now() } = {}) {
  const db = _db();
  const iso = new Date(now).toISOString();
  const st = status === undefined ? undefined : (GOAL_STATUS_ALIASES[status] || status);
  if (st !== undefined && !GOAL_STATUSES.includes(st)) return { ok: false, error: `status must be one of ${GOAL_STATUSES.join(', ')}` };
  let domainsJson;
  if (domains !== undefined) {
    if (domains !== null && !Array.isArray(domains)) return { ok: false, error: 'domains must be a list' };
    const norm = (domains || []).map(domainsLib.normaliseDomain);
    if (norm.some((d) => !d)) return { ok: false, error: 'unknown domain' };
    domainsJson = norm.length ? JSON.stringify([...new Set(norm)]) : null;
  }
  let imp;
  if (importance !== undefined) {
    if (importance === null) imp = null;
    else {
      imp = domainsLib.normaliseImportance(importance);
      if (!imp) return { ok: false, error: `unknown importance: ${importance}` };
    }
  }
  for (const [k, v] of [['startDate', startDate], ['reviewDate', reviewDate]]) {
    if (v !== undefined && v !== null && !DATE_ONLY.test(String(v))) return { ok: false, error: `${k} must be YYYY-MM-DD` };
  }
  if (links !== undefined) {
    if (!Array.isArray(links)) return { ok: false, error: 'links must be a list' };
    const bad = links.filter((l) => !(typeof (l && (l.entityId || l)) === 'string' && GOAL_LINK_PREFIXES.test(String(l.entityId || l))));
    if (bad.length) return { ok: false, error: 'a link must name a world-model id (task:…, commitment:…, person:…, companion:…, meeting:…)' };
  }
  const desc = description !== undefined ? description : note;

  let gid = id;
  const write = () => db.batchSaves(() => {
    if (!gid) {
      const t = typeof title === 'string' ? title.trim() : '';
      if (!t) throw Object.assign(new Error('title is required'), { status: 400 });
      gid = `goal:${require('crypto').randomUUID()}`;
      db.run(`INSERT INTO goals (goal_id, title, domains_json, status, note, description, importance, start_date, review_date,
                last_reviewed_at, provenance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'neuro', ?, ?)`,
      [gid, t.slice(0, 300), domainsJson || null, st || 'active', null, desc ? String(desc).slice(0, 2000) : null,
        imp || null, startDate || null, reviewDate || null, reviewed ? iso : null, iso, iso]);
    } else {
      const held = db.get('SELECT * FROM goals WHERE goal_id = ?', [gid]);
      if (!held) throw Object.assign(new Error('no such goal'), { status: 404 });
      db.run(`UPDATE goals SET title = ?, domains_json = ?, status = ?, description = ?, importance = ?, start_date = ?,
                review_date = ?, last_reviewed_at = ?, updated_at = ? WHERE goal_id = ?`, [
        typeof title === 'string' && title.trim() ? title.trim().slice(0, 300) : held.title,
        domainsJson !== undefined ? domainsJson : held.domains_json,
        st || (held.status === 'done' ? 'achieved' : held.status),
        desc !== undefined ? (desc ? String(desc).slice(0, 2000) : null) : (held.description || held.note || null),
        imp !== undefined ? imp : held.importance,
        startDate !== undefined ? startDate : held.start_date,
        reviewDate !== undefined ? reviewDate : held.review_date,
        reviewed ? iso : held.last_reviewed_at,
        iso, gid]);
    }
    if (links !== undefined) {
      db.run('DELETE FROM goal_links WHERE goal_id = ?', [gid]);
      for (const l of links) {
        const entityId = String(l.entityId || l).slice(0, 300);
        db.run('INSERT OR IGNORE INTO goal_links (goal_id, entity_id, relation, set_at) VALUES (?, ?, ?, ?)',
          [gid, entityId, (l && l.relation) || 'serves', iso]);
      }
    }
  });
  try { write(); } catch (e) { return { ok: false, error: e.message, status: e.status || 400 }; }
  // Onto the spine, so the world model (and the personal evaluator) hold it.
  try { require('./personal-world').publishGoals({ now }); } catch { /* the goal is saved; the projection catches up */ }
  return { ok: true, goal: _shapeGoalRow(db.get('SELECT * FROM goals WHERE goal_id = ?', [gid])) };
}

/**
 * Build 19P — Nick links ONE thing to a goal, or takes the link away. Explicit
 * only: nothing calls this on wording ("this looks like hiking" links nothing).
 * A link gives the goal's CONTEXT to the item; it never makes it more urgent.
 */
function addGoalLink(goalId, { entityId, relation = 'serves', label = null } = {}, { now = Date.now() } = {}) {
  const db = _db();
  if (typeof entityId !== 'string' || !GOAL_LINK_PREFIXES.test(entityId) || entityId.length > 300) {
    return { ok: false, status: 400, error: 'entityId must name a world-model id (task:…, commitment:…, meeting:…, pd:…, person:…, companion:…)' };
  }
  const g = db.get('SELECT goal_id, title, status FROM goals WHERE goal_id = ?', [goalId]);
  if (!g) return { ok: false, status: 404, error: 'no such goal' };
  if (g.status !== 'active') return { ok: false, status: 409, error: `the goal is ${g.status}; links are made to an active goal` };
  const rel = typeof relation === 'string' && /^[a-z-]{1,20}$/.test(relation) ? relation : 'serves';
  const r = db.run('INSERT OR IGNORE INTO goal_links (goal_id, entity_id, relation, set_at) VALUES (?, ?, ?, ?)', [goalId, entityId, rel, new Date(now).toISOString()]);
  if (r && r.changes) {
    require('./personal-obligations').logEvent('goal-link-added', { subjectId: goalId, actor: 'nick', detail: { goal: g.title, entityId, label }, dedupeKey: `goal-link-added:${goalId}>${entityId}:${now}`, now });
    try { require('./personal-world').publishGoals({ now }); } catch { /* the link is saved; the projection catches up */ }
  }
  return { ok: true, already: !(r && r.changes), goal: _shapeGoalRow(db.get('SELECT * FROM goals WHERE goal_id = ?', [goalId])) };
}

function removeGoalLink(goalId, { entityId, label = null } = {}, { now = Date.now() } = {}) {
  const db = _db();
  if (typeof entityId !== 'string' || !entityId) return { ok: false, status: 400, error: 'entityId is required' };
  const g = db.get('SELECT goal_id, title FROM goals WHERE goal_id = ?', [goalId]);
  if (!g) return { ok: false, status: 404, error: 'no such goal' };
  const r = db.run('DELETE FROM goal_links WHERE goal_id = ? AND entity_id = ?', [goalId, entityId]);
  if (r && r.changes) {
    require('./personal-obligations').logEvent('goal-link-removed', { subjectId: goalId, actor: 'nick', detail: { goal: g.title, entityId, label }, dedupeKey: `goal-link-removed:${goalId}>${entityId}:${now}`, now });
    try { require('./personal-world').publishGoals({ now }); } catch { /* removed; the projection catches up */ }
  }
  return { ok: true, removed: !!(r && r.changes), goal: _shapeGoalRow(db.get('SELECT * FROM goals WHERE goal_id = ?', [goalId])) };
}

/**
 * Per-domain coverage: how much of each part of Nick's life the world model
 * can currently SEE. Counts evidence, never judges the life. A domain with
 * nothing is reported with zeros, not dropped — an empty row is the finding.
 */
function coverageByDomain({ commitmentItems = [], sourceItems = [], goals = [], events = [], taskItems = [], containers = [] }) {
  const rows = Object.fromEntries(domainsLib.DOMAINS.map((d) => [d, { domain: d, label: domainsLib.LABELS[d], commitments: 0, tasks: 0, sources: 0, containers: 0, goals: 0, upcoming: 0, declared: 0 }]));
  const bump = (doms, key) => {
    for (const d of (doms && doms.domains) || []) {
      if (!rows[d.domain]) continue;
      rows[d.domain][key] += 1;
      if (d.basis === 'declared' || d.basis === 'classified') rows[d.domain].declared += 1;
    }
  };
  for (const c of commitmentItems) bump(c.domains, 'commitments');
  for (const t of taskItems) bump(t.domains, 'tasks');
  for (const s of sourceItems) if (s.lifecycle !== 'retired') bump({ domains: s.domains }, 'sources');
  for (const c of containers) {
    const doms = (c.classification && c.classification.domains) || [];
    for (const d of doms) if (rows[d]) rows[d].containers += 1;
  }
  for (const g of goals) bump({ domains: g.domains }, 'goals');
  for (const e of events) bump(e.domains, 'upcoming');
  return {
    domains: domainsLib.DOMAINS.map((d) => rows[d]),
    unknown: {
      commitments: commitmentItems.filter((c) => !c.domains.domains.length).length,
      tasks: taskItems.filter((t) => !t.domains.domains.length).length,
      upcoming: events.filter((e) => !e.domains.domains.length).length,
      // Superseded name-only twins and anything Nick set as not tracked are
      // not unknowns — there is nothing left for him to say about them.
      containers: containers.filter((c) => !c.superseded && !(c.classification && c.classification.tracked === false)
        && !(c.kind === 'reminder-list' && c.tracking !== 'tracked')
        && !(c.classification && (c.classification.domains || []).length)).length,
    },
  };
}

/** One upcoming diary entry as Now and Life see it, with its calendar's classification applied. */
function _shapeEvent(m, { people, ann, ctx, goals, projectionCurrent = null }) {
  const cal = _calendarFor(m, ctx);
  const annotation = ann.get(m.meetingId) || null;
  const imp = importanceFor(m.meetingId, { annotation, goals });
  return {
    id: m.meetingId, title: m.title, start: m.start, end: m.end, kind: m.kind, entryKind: m.entryKind || null,
    withPeople: (m.people || []).map((p) => p.displayName), unresolvedPeople: m.unresolvedParticipants || 0,
    calendar: cal ? { name: cal.name, classification: cal.state, why: cal.why || null } : null,
    domains: meetingDomains(m, { people, annotation, calendar: cal }),
    importance: imp.value, importanceBasis: imp.basis,
    source: (m.sources || []).map((x) => x.provider), freshness: m.freshness ? m.freshness.freshness : null,
    projectionCurrent,
  };
}

async function life({ now: nowMs = Date.now() } = {}) {
  const people = _peopleMap();
  const gaps = [];
  const safe = (name, fn, dflt) => { try { return fn(); } catch (e) { gaps.push({ input: name, why: e.message }); return dflt; } };
  const pw = require('./personal-world');
  const ctx = _classificationCtx();
  const commitmentItems = safe('commitments', () => commitments({ now: nowMs }).items, []);
  const taskItems = safe('tasks', () => tasks({ now: nowMs }).items, []);
  const sourceItems = safe('sources', () => sources({ now: nowMs }).spine, []);
  const goals = safe('goals', () => listGoals({ status: 'all' }), []);
  const active = goals.filter((g) => g.status === 'active');
  const containers = safe('classifications', () => ctx.sc.listContainers({ now: nowMs }), []);
  const companions = safe('companions', () => pw.listCompanions(), []);
  const events = safe('meetings', () => {
    const wm = require('./world-model');
    const up = wm.nextMeetings({ now: nowMs, limit: 60 }).filter((m) => m.kind !== 'block');
    const ann = getAnnotations(up.map((m) => m.meetingId));
    return up.map((m) => _shapeEvent(m, { people, ann, ctx, goals: active }));
  }, []);
  // What each companion is connected to: explicit goal links (facts), and
  // items that MENTION her by name (an inference, labelled as one).
  const companionsOut = companions.map((c) => ({
    ...c,
    goals: active.filter((g) => g.links.some((l) => l.entityId === c.id)).map((g) => ({ id: g.id, title: g.title })),
    mentionedBy: [...taskItems, ...commitmentItems].filter((i) => pw.mentions(i.description, [c]).length)
      .slice(0, 20).map((i) => ({ id: i.id, kind: i.kind, description: i.description, basis: 'inference' })),
    upcoming: events.filter((e) => pw.mentions(e.title, [c]).length).map((e) => ({ id: e.id, title: e.title, start: e.start, basis: 'inference' })),
  }));
  return {
    contract: CONTRACT, asOf: new Date(nowMs).toISOString(),
    goals, companions: companionsOut, containers,
    coverage: coverageByDomain({ commitmentItems, sourceItems, goals: active, events, taskItems, containers }),
    gaps,
  };
}

/** Real-meeting minutes in today's working diary (work-domain meetings only). */
function _workMeetingMinutesToday(nowMs, people, ctx = null) {
  const db = _db();
  const today = localDate(nowMs);
  const wm = require('./world-model');
  const rows = db.all(`SELECT * FROM wm_meetings WHERE status = 'scheduled' AND kind = 'meeting' AND substr(start_local,1,10) = ?`, [today]);
  let minutes = 0;
  for (const r of rows) {
    const m = wm.shapeMeeting(r, nowMs);
    if (m.isAllDay) continue;
    const doms = meetingDomains(m, { people, calendar: _calendarFor(m, ctx) });
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
let _radarMemo = null;
let _homeMemo = null;
async function now({ now: nowMs = Date.now(), decision = null } = {}) {
  const gaps = [];
  let dec = decision;
  if (!dec) {
    try { dec = await require('./attention').build({ now: new Date(nowMs) }); } catch (e) { dec = { poolAvailable: false, gaps: [{ input: 'attention', why: e.message }] }; }
  }
  const people = _peopleMap();
  const ctx = _classificationCtx();
  let goals = [];
  try { goals = listGoals({ status: 'active' }); } catch (e) { gaps.push({ input: 'goals', why: e.message }); }
  let nextEvents = [];
  try {
    const wm = require('./world-model');
    const st = wm.meetingState({ now: nowMs });
    // A solo work block is a plan, not an event. `unknown` is KEPT: that is how
    // phone-calendar (personal diary) events arrive, and dropping them would
    // make the next meaningful event structurally a work one.
    const upcoming = wm.nextMeetings({ now: nowMs, limit: 20 }).filter((x) => x.kind !== 'block').slice(0, 10);
    const ann = getAnnotations(upcoming.map((m) => m.meetingId));
    nextEvents = upcoming.map((m) => _shapeEvent(m, { people, ann, ctx, goals, projectionCurrent: st.projection.current }));
  } catch (e) { gaps.push({ input: 'meetings', why: e.message }); }
  let commitmentItems = [];
  try { commitmentItems = commitments({ now: nowMs }).items; } catch (e) { gaps.push({ input: 'commitments', why: e.message }); }
  // Build 11D: reminders are tasks the attention pool cannot see.
  let taskItems = [];
  try { taskItems = tasks({ now: nowMs, system: 'eventkit-reminders' }).items; } catch (e) { gaps.push({ input: 'reminders', why: e.message }); }
  let sourceItems = [];
  try { sourceItems = sources({ now: nowMs }).spine; } catch (e) { gaps.push({ input: 'sources', why: e.message }); }
  let crowd = null;
  try {
    const known = (i) => i.domains.domains.length && i.domains.domains.every((d) => d.domain !== 'work')
      && i.domains.domains.some((d) => ['declared', 'classified', 'set', 'intrinsic'].includes(d.basis));
    const personalDue = [...commitmentItems.filter((i) => commitmentIsNowRelevant(i) && known(i)),
      ...taskItems.filter((t) => taskIsNowRelevant(t) && known(t))];
    crowd = crowdedOut({ workMeetingMinutes: _workMeetingMinutesToday(nowMs, people, ctx), personalDue });
  } catch (e) { gaps.push({ input: 'work-balance', why: e.message }); }
  const allGaps = [...(dec.gaps || []), ...gaps];
  const composed = composeNow({ decision: dec, nextEvents, commitments: commitmentItems, tasks: taskItems, sources: sourceItems,
    approvals: dec.approvals || null, goals, crowd, gaps: allGaps, nowLocal: require('./world-model').localMinute(nowMs) });
  const payload = { ...dec, contract: CONTRACT, situation: composed };
  // 5 Oct 2026: the air where Nick is (roaming logger / phone barometer) and
  // what the phone's Music app is playing. Read-only, never allowed to fail Now.
  try { payload.environmentHere = require('./environment').here({ nowSeconds: Math.floor(nowMs / 1000) }); } catch (e) { gaps.push({ input: 'environment-here', why: e.message }); }
  try { payload.nowPlaying = require('./now-playing').current({ now: nowMs }); } catch { payload.nowPlaying = null; }
  // Build 17O: personal dates inside their lead window — context on Now, never
  // a ranked item. `later` dates stay off Now. Never allowed to fail Now.
  try {
    const pd = require('./personal-dates').read({ now: nowMs });
    payload.personalDates = { active: pd.active.map((d) => ({ id: d.id, kind: d.kind, date: d.date, person: d.person, state: d.state, away: d.away, line: d.line, importance: d.importance })), gaps: pd.gaps };
  } catch (e) { payload.personalDates = null; gaps.push({ input: 'personal-dates', why: e.message }); }
  // Build 19O: the next 7 days of the Future Radar as CONTEXT on Now — the
  // summary lines and anything needing Nick. Not a ranked item, never a push.
  try {
    // Now is POLLED by every surface; the Radar costs ~150ms on the Pi, so it is
    // reused for the rest of the minute. The Radar card itself is never cached.
    const minute = Math.floor(nowMs / 60000);
    if (!_radarMemo || _radarMemo.minute !== minute) _radarMemo = { minute, r: require('./future-radar').read({ now: nowMs, horizonDays: 7 }) };
    const r = _radarMemo.r;
    payload.radar = { heading: r.heading, summary: r.summary, complete: r.coverage.complete,
      needsYou: r.items.filter((i) => i.actionState === 'needs_you').slice(0, 3).map((i) => ({ id: i.id, title: i.title, kind: i.kind, when: i.when, why: i.whyVisible })) };
  } catch (e) { payload.radar = null; gaps.push({ input: 'radar', why: e.message }); }
  // Build 22G: household CONTEXT on Now — occupancy, household tasks, device
  // watchdog, hazards. No network (HA states from cache), memoised per minute
  // like the Radar, never a ranked item, never a push. Never fails Now.
  try {
    const minute = Math.floor(nowMs / 60000);
    if (!_homeMemo || _homeMemo.minute !== minute) {
      _homeMemo = { minute, h: require('./home').readCached({ now: nowMs, radarItems: _radarMemo && _radarMemo.r ? _radarMemo.r.items : [] }) };
    }
    const h = _homeMemo.h;
    payload.home = {
      occupancy: { state: h.occupancy.state, why: h.occupancy.why },
      tasks: h.obligations.length, tasksDue: h.obligations.filter((o) => o.needsNow).length,
      upcoming: h.upcoming.slice(0, 3).map((u) => ({ id: u.id, title: u.title, when: u.when })),
      lowBatteries: h.devices.known ? h.devices.lowBatteries : null,
      safety: h.safety.capability, needsYou: h.needsYou, summary: h.summary,
      // Build 28AF: home earns a place on Now only through an exception or
      // something needing Nick — never "occupied, 20 °C" every day.
      exceptions: (h.exceptions || []).slice(0, 3).map((e) => ({ id: e.key, category: e.category, what: e.what, where: e.where, actionState: e.actionState })),
      relevant: h.needsYou.length > 0 || (h.exceptions || []).length > 0,
    };
  } catch (e) { payload.home = null; gaps.push({ input: 'home', why: e.message }); }
  // Build 12A: what this MEANS, ranked, with no layout in it. Composed here and
  // nowhere else, so every surface reading Now renders one presentation. Never
  // allowed to fail the feed: null means "render the way you did before".
  try {
    payload.presentation = require('./presentation-intent').composePresentation(payload, { now: nowMs });
  } catch (e) {
    console.warn('[Canonical] presentation composition failed:', e.message);
    payload.presentation = null;
  }
  return payload;
}

module.exports = {
  CONTRACT, SOON_DAYS, NOW_OVERDUE_DAYS, EVALUATORS, VERDICT_WORDS, SOURCE_DOMAINS, GOAL_STATUSES, OFF_SPINE,
  // pure
  daysBetween, localDate, dueContext, personWorkEvidence, personRelationshipEvidence, commitmentDomains, taskDomains, meetingDomains,
  worldTaskDomains, importanceFor, shapeWorldTask, minutesFrom, unknownEventRelevance, taskIsNowRelevant, UNKNOWN_NEAR_MINUTES,
  shapeCommitment, summariseCommitments, sourceVerdict, shapeSource, sourceMatters, attentionVerdict, shapeFinding,
  commitmentIsNowRelevant, rankNowCommitments, crowdedOut, composeNow, noteTitle, coverageByDomain, isKnownWorkOnly,
  // readers / writers
  commitments, commitmentDetail, tasks, sources, findings, now, life, getAnnotations, setAnnotation, listGoals, saveGoal,
  addGoalLink, removeGoalLink, GOAL_LINK_PREFIXES,
};
