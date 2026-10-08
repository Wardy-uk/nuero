'use strict';

/**
 * Build 19E–G / 19P / 19T / 19U — personal obligations, read from what NEURO
 * already holds. NOT a "life task" system: there is no table of personal
 * obligations. An obligation is an OPEN canonical Task or Commitment that
 * qualifies on explicit evidence, judged at read time:
 *
 *   • it carries a NON-WORK domain on an explicit basis — Nick declared it on
 *     the item, classified the list/calendar it came from, or the data is
 *     intrinsically that kind; or it was marked personal (`tasks.domain`); or
 *   • Nick explicitly LINKED it to a personal goal (goal_links) or to a
 *     personal date / calendar entry / person (personal_links, 19T).
 *
 * Never personal because it came from the iPhone, never because of its words,
 * never because a default said so. A `work` default is reported as a default
 * and qualifies nothing either way.
 *
 * Personal ADMIN (19G) is the subset whose explicit domain is admin, finance or
 * transport — MOT, renewals, bills, forms. Only what exists; no integration is
 * invented to fill it.
 *
 * Status (19F) is evidence-based: a due date that is stated or set and is ≤1
 * day away (or ≤14 days past) NEEDS NICK; NEURO's own ten-day placeholder
 * never does; importance — his own or a linked goal's — never creates urgency.
 */

const domainsLib = require('../../shared/life-domains.cjs');

const EXPLICIT_BASES = new Set(['declared', 'classified', 'intrinsic', 'set']);
const ADMIN_DOMAINS = Object.freeze(['admin', 'finance', 'travel']);
const NEEDS_NOW_AHEAD_DAYS = 1;
const NEEDS_NOW_OVERDUE_DAYS = 14;
const SUBJECT_PREFIXES = /^(pd:|meeting:|person:|companion:)/;
const ENTITY_PREFIXES = /^(task:|commitment:)/;

/**
 * Why (if at all) an item is a personal obligation. PURE.
 *   item        a canonical task/commitment shape (canonical-read)
 *   goalLinks   Map entityId → [goal]   explicit links, active goals only
 *   prepLinks   Map entityId → [subjectId]
 */
function personalEvidence(item, { goalLinks = new Map(), prepLinks = new Map() } = {}) {
  const doms = (item.domains && item.domains.domains) || [];
  const explicit = doms.filter((d) => d.domain !== 'work' && EXPLICIT_BASES.has(d.basis));
  const markedPersonal = !!(item.domains && item.domains.sphere === 'personal' && !doms.some((d) => d.domain === 'work' && d.basis !== 'default'));
  const goals = (goalLinks.get(item.id) || []).filter((g) => !(g.domains || []).some((d) => (d.domain || d) === 'work'));
  const subjects = prepLinks.get(item.id) || [];
  const why = [];
  for (const d of explicit) why.push(d.why || `${domainsLib.domainLabel(d.domain)} (${d.basis})`);
  if (markedPersonal && !explicit.length) why.push('marked personal');
  for (const g of goals) why.push(`you linked it to the goal "${g.title}"`);
  for (const s of subjects) why.push(`you linked it as preparation for ${s}`);
  return {
    personal: explicit.length > 0 || markedPersonal || goals.length > 0 || subjects.length > 0,
    domains: explicit.map((d) => ({ domain: d.domain, label: domainsLib.domainLabel(d.domain), basis: d.basis })),
    goals: goals.map((g) => ({ id: g.id, title: g.title })),
    preparesFor: subjects,
    why,
  };
}

/** Is this obligation personal admin? PURE. */
function isAdmin(ev) {
  return (ev.domains || []).some((d) => ADMIN_DOMAINS.includes(d.domain));
}

/**
 * Whether it needs Nick now, and its action state. PURE.
 * `due` is canonical-read's dueContext. A stated or set date ≤1 day away, or
 * up to 14 days past, needs him. A placeholder never does. Importance is NOT
 * an input — that is the point.
 */
function obligationStatus(item) {
  if (item.state === 'unknown') return { actionState: 'unknown', needsNow: false, why: 'the source stopped listing it — not known to be done or open' };
  if (item.state !== 'open' && item.state !== 'in-progress') return { actionState: 'none', needsNow: false, why: `it is ${item.state}` };
  const due = item.due || {};
  if (!due.date) return { actionState: 'preparation_open', needsNow: false, why: 'open, with no date' };
  if (due.kind === 'placeholder') return { actionState: 'preparation_open', needsNow: false, why: 'open; its date is NEURO\'s placeholder, not yours' };
  const firm = due.kind === 'stated' || due.kind === 'set';
  if (firm && due.days !== null && due.days <= NEEDS_NOW_AHEAD_DAYS && due.days >= -NEEDS_NOW_OVERDUE_DAYS) {
    return { actionState: 'needs_you', needsNow: true, why: due.days < 0 ? `still open, ${-due.days} day${due.days === -1 ? '' : 's'} past its date` : due.days === 0 ? 'due today' : 'due tomorrow' };
  }
  return { actionState: 'preparation_open', needsNow: false, why: `open, ${due.label || 'dated'}` };
}

/** Freshness of the evidence behind an item. PURE. `health` Map sourceId → row. */
function evidenceFreshness(item, { health = new Map(), projection = null } = {}) {
  const sys = item.system || (item.kind === 'commitment' ? 'world-model' : null);
  if (sys === 'eventkit-reminders') {
    const rows = [...health.values()].filter((h) => /^reminders\.(?!unknown)/.test(h.sourceId));
    if (!rows.length) return { source: 'Reminders', freshness: 'unknown', lastObservedAt: null, why: 'no Reminders push has been judged yet' };
    const best = rows.sort((a, b) => String(b.lastObservedAt || '').localeCompare(String(a.lastObservedAt || '')))[0];
    return { source: 'Reminders', freshness: rows.some((r) => r.freshness === 'fresh') ? 'fresh' : best.freshness || 'unknown', lastObservedAt: best.lastObservedAt || null, sourceId: best.sourceId };
  }
  if (sys === 'neuro') return { source: 'NEURO', freshness: 'local', lastObservedAt: null, why: 'NEURO holds it itself' };
  if (sys && /^ms-/.test(sys)) return { source: 'Microsoft', freshness: projection && projection.lagging ? 'stale' : 'unknown', lastObservedAt: null };
  return { source: item.sourceLabel || sys || 'world model', freshness: projection && projection.lagging ? 'stale' : 'unknown', lastObservedAt: null };
}

/** One obligation as a surface sees it. PURE. */
function shapeObligation(item, ev, freshness) {
  const st = obligationStatus(item);
  return {
    id: item.id,
    kind: item.kind,
    what: item.description,
    direction: item.direction || null,
    due: item.due && item.due.date ? { date: item.due.date, time: item.due.time || null, kind: item.due.kind, label: item.due.label, days: item.due.days } : null,
    domains: ev.domains,
    admin: isAdmin(ev),
    source: item.sourceLabel || (item.kind === 'commitment' ? 'Commitment' : item.system || null),
    container: item.container || null,
    linkedGoals: ev.goals,
    preparesFor: ev.preparesFor,
    status: item.state,
    actionState: st.actionState,
    needsNow: st.needsNow,
    needsWhy: st.why,
    importance: item.importanceBasis === 'declared' ? item.importance : null,
    evidence: freshness,
    whyPersonal: ev.why,
  };
}

/** Order: needs-you first, then the date, then id. PURE — importance plays no part. */
function rankObligations(list) {
  return [...list].sort((a, b) => (Number(b.needsNow) - Number(a.needsNow))
    || String((a.due && a.due.date) || '9999').localeCompare(String((b.due && b.due.date) || '9999'))
    || String(a.id).localeCompare(String(b.id)));
}

// ── store ───────────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }

function prepLinkMap() {
  const byEntity = new Map();
  const bySubject = new Map();
  try {
    for (const r of _db().all('SELECT subject_id, entity_id, relation, set_at FROM personal_links ORDER BY set_at')) {
      byEntity.set(r.entity_id, [...(byEntity.get(r.entity_id) || []), r.subject_id]);
      bySubject.set(r.subject_id, [...(bySubject.get(r.subject_id) || []), r.entity_id]);
    }
  } catch { /* no table yet: no links */ }
  return { byEntity, bySubject };
}

function goalLinkMap(goals) {
  const out = new Map();
  for (const g of goals || []) {
    if (g.status !== 'active') continue;
    for (const l of g.links || []) out.set(l.entityId, [...(out.get(l.entityId) || []), g]);
  }
  return out;
}

function _health() {
  try {
    return new Map(_db().all("SELECT source_id, state, freshness, last_observed_at FROM source_health WHERE source_id LIKE 'reminders.%'")
      .map((h) => [h.source_id, { sourceId: h.source_id, state: h.state, freshness: h.freshness, lastObservedAt: h.last_observed_at }]));
  } catch { return new Map(); }
}

/**
 * Every open personal obligation (and those whose state is unknown).
 * `adminOnly` narrows to personal admin.
 */
function read({ now = Date.now(), adminOnly = false } = {}) {
  const cr = require('./canonical-read');
  const gaps = [];
  let goals = [];
  try { goals = cr.listGoals({ status: 'active' }); } catch (e) { gaps.push({ input: 'goals', why: e.message }); }
  const goalLinks = goalLinkMap(goals);
  const prep = prepLinkMap();
  const health = _health();
  const items = [];
  let workExcluded = 0;
  let projection = null;
  for (const status of ['open', 'unknown']) {
    try {
      const t = cr.tasks({ status, now });
      projection = projection || t.freshness || null;
      items.push(...t.items);
    } catch (e) { gaps.push({ input: `tasks:${status}`, why: e.message }); }
  }
  try { items.push(...cr.commitments({ status: 'open', now }).items); } catch (e) { gaps.push({ input: 'commitments', why: e.message }); }
  const out = [];
  for (const it of items) {
    const ev = personalEvidence(it, { goalLinks, prepLinks: prep.byEntity });
    if (!ev.personal) { if ((it.domains.domains || []).some((d) => d.domain === 'work') || it.domains.sphere === 'work') workExcluded += 1; continue; }
    const shaped = shapeObligation(it, ev, evidenceFreshness(it, { health, projection }));
    if (adminOnly && !shaped.admin) continue;
    out.push(shaped);
  }
  const ranked = rankObligations(out);
  return {
    ok: true,
    asOf: new Date(now).toISOString(),
    rule: 'Personal = an explicit non-work domain (you declared it, or classified its list or calendar), marked personal, or explicitly linked by you to a personal goal or date. Never because it came from the iPhone.',
    counts: {
      total: ranked.length,
      needsNow: ranked.filter((o) => o.needsNow).length,
      admin: ranked.filter((o) => o.admin).length,
      unknownState: ranked.filter((o) => o.actionState === 'unknown').length,
      undated: ranked.filter((o) => !o.due).length,
      workExcluded,
    },
    items: ranked,
    gaps,
  };
}

/**
 * 19U — what personal-admin data exists at all, per source. Counts and dates
 * only. A source that is not modelled is SAID, never counted as zero.
 */
function adminAudit({ now = Date.now() } = {}) {
  const db = _db();
  const sc = require('./source-classification');
  const isAdminCls = (c) => (c.domains || []).some((d) => ADMIN_DOMAINS.includes(d));
  const lists = sc.listClassifications('reminder-list').filter(isAdminCls);
  const cals = sc.listClassifications('calendar').filter(isAdminCls);
  const obligations = read({ now, adminOnly: true });
  let calEvents = 0;
  try {
    for (const c of cals) {
      const r = db.get("SELECT COUNT(*) n FROM wm_meetings WHERE status = 'scheduled' AND calendar_key = ? AND start_local >= ?", [c.sourceKey, new Date(now).toISOString().slice(0, 10)]);
      calEvents += (r && r.n) || 0;
    }
  } catch { calEvents = null; }
  return {
    ok: true,
    asOf: new Date(now).toISOString(),
    sources: [
      { source: 'Reminders lists classified admin / finance / transport', containers: lists.map((l) => l.label), items: obligations.items.filter((o) => o.source === 'Reminders').length },
      { source: 'NEURO tasks declared admin / finance / transport', items: obligations.items.filter((o) => o.source === 'NEURO').length },
      { source: 'Calendars classified admin / finance / transport', containers: cals.map((c) => c.label), upcomingEvents: calEvents },
      { source: 'Vault notes', items: null, why: 'not modelled — notes are never read as obligations' },
      { source: 'Bills, subscriptions, vehicle records', items: null, why: 'not modelled — no provider is connected, by design' },
    ],
    obligations: obligations.counts,
    dated: obligations.items.filter((o) => o.due).length,
    unknownState: obligations.counts.unknownState,
  };
}

// ── explicit preparation links (19T) and the Activity log (19W) ─────────────

function logEvent(kind, { subjectId = null, actor = 'neuro', detail = {}, dedupeKey, now = Date.now() } = {}) {
  try {
    const r = _db().run('INSERT OR IGNORE INTO personal_ops_events (kind, subject_id, actor, dedupe_key, at, detail_json) VALUES (?, ?, ?, ?, ?, ?)',
      [kind, subjectId, actor, dedupeKey || `${kind}:${subjectId}:${now}`, new Date(now).toISOString(), JSON.stringify(detail)]);
    return !!(r && r.changes);
  } catch (e) {
    console.warn('[PersonalOps] event not recorded:', e.message);
    return false;
  }
}

function validateLink(subjectId, entityId) {
  if (typeof subjectId !== 'string' || !SUBJECT_PREFIXES.test(subjectId) || subjectId.length > 400) return 'subjectId must be a personal date (pd:…), a calendar entry (meeting:…), a person or a companion';
  if (typeof entityId !== 'string' || !ENTITY_PREFIXES.test(entityId) || entityId.length > 300) return 'entityId must be a task (task:…) or commitment (commitment:…)';
  return null;
}

/** Nick links a task as preparation for a personal subject. Explicit only. */
function linkPrep({ subjectId, entityId, label = null } = {}, { now = Date.now() } = {}) {
  const bad = validateLink(subjectId, entityId);
  if (bad) return { ok: false, status: 400, error: bad };
  const r = _db().run('INSERT OR IGNORE INTO personal_links (subject_id, entity_id, relation, set_at) VALUES (?, ?, ?, ?)',
    [subjectId, entityId, 'prepares', new Date(now).toISOString()]);
  if (r && r.changes) logEvent('prep-link-added', { subjectId, actor: 'nick', detail: { entityId, label }, dedupeKey: `prep-link-added:${subjectId}>${entityId}:${now}`, now });
  return { ok: true, already: !(r && r.changes), link: { subjectId, entityId, relation: 'prepares' } };
}

function unlinkPrep({ subjectId, entityId, label = null } = {}, { now = Date.now() } = {}) {
  const bad = validateLink(subjectId, entityId);
  if (bad) return { ok: false, status: 400, error: bad };
  const r = _db().run('DELETE FROM personal_links WHERE subject_id = ? AND entity_id = ?', [subjectId, entityId]);
  if (r && r.changes) logEvent('prep-link-removed', { subjectId, actor: 'nick', detail: { entityId, label }, dedupeKey: `prep-link-removed:${subjectId}>${entityId}:${now}`, now });
  return { ok: true, removed: !!(r && r.changes) };
}

module.exports = {
  EXPLICIT_BASES, ADMIN_DOMAINS, NEEDS_NOW_AHEAD_DAYS, NEEDS_NOW_OVERDUE_DAYS,
  // pure
  personalEvidence, isAdmin, obligationStatus, evidenceFreshness, shapeObligation, rankObligations, validateLink,
  // store
  prepLinkMap, goalLinkMap, read, adminAudit, logEvent, linkPrep, unlinkPrep,
};
