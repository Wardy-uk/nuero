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
const VEHICLE_RE = /^vehicle:[a-z0-9][a-z0-9-]{0,39}$/;
const ENTITY_PREFIXES = /^(task:|commitment:)/;
const VEHICLE_ENTITY_PREFIXES = /^(task:|commitment:|meeting:)/;

/**
 * Why (if at all) an item is a personal obligation. PURE.
 *   item        a canonical task/commitment shape (canonical-read)
 *   goalLinks   Map entityId → [goal]   explicit links, active goals only
 *   prepLinks   Map entityId → [subjectId]
 */
function personalEvidence(item, { goalLinks = new Map(), prepLinks = new Map(), careLinks = new Map() } = {}) {
  const doms = (item.domains && item.domains.domains) || [];
  const explicit = doms.filter((d) => d.domain !== 'work' && EXPLICIT_BASES.has(d.basis));
  const markedPersonal = !!(item.domains && item.domains.sphere === 'personal' && !doms.some((d) => d.domain === 'work' && d.basis !== 'default'));
  const goals = (goalLinks.get(item.id) || []).filter((g) => !(g.domains || []).some((d) => (d.domain || d) === 'work'));
  const linked = prepLinks.get(item.id) || [];
  // Build 20N: a vehicle link is CONTEXT (transport), never preparation.
  const vehicles = linked.filter((s) => s.startsWith('vehicle:'));
  const subjects = linked.filter((s) => !s.startsWith('vehicle:'));
  // Build 20G: Nick linked it to a companion's care.
  const care = careLinks.get(item.id) || [];
  const linkedDomains = [];
  for (const c of care) if (!linkedDomains.some((d) => d.domain === 'ember')) linkedDomains.push({ domain: 'ember', label: domainsLib.domainLabel('ember'), basis: 'linked' });
  if (vehicles.length && !explicit.some((d) => d.domain === 'travel')) linkedDomains.push({ domain: 'travel', label: domainsLib.domainLabel('travel'), basis: 'linked' });
  const why = [];
  for (const d of explicit) why.push(d.why || `${domainsLib.domainLabel(d.domain)} (${d.basis})`);
  if (markedPersonal && !explicit.length) why.push('marked personal');
  for (const g of goals) why.push(`you linked it to the goal "${g.title}"`);
  for (const s of subjects) why.push(`you linked it as preparation for ${s}`);
  for (const c of care) why.push(`you linked it to ${c.name}'s care (${c.careKind})`);
  for (const v of vehicles) why.push(`you linked it to the ${vehicleName(v)}`);
  return {
    personal: explicit.length > 0 || markedPersonal || goals.length > 0 || subjects.length > 0 || care.length > 0 || vehicles.length > 0,
    domains: [...explicit.map((d) => ({ domain: d.domain, label: domainsLib.domainLabel(d.domain), basis: d.basis })), ...linkedDomains],
    goals: goals.map((g) => ({ id: g.id, title: g.title })),
    preparesFor: subjects,
    companions: care.map((c) => ({ id: c.companionId, name: c.name, careKind: c.careKind })),
    vehicles: vehicles.map((v) => ({ id: v, name: vehicleName(v) })),
    why,
  };
}

/** "vehicle:car" → "car". PURE. */
function vehicleName(subjectId) {
  return String(subjectId || '').replace(/^vehicle:/, '').replace(/-/g, ' ') || 'vehicle';
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
    companions: ev.companions || [],
    vehicles: ev.vehicles || [],
    status: item.state,
    actionState: st.actionState,
    needsNow: st.needsNow,
    needsWhy: st.why,
    importance: item.importanceBasis === 'declared' ? item.importance : null,
    evidence: freshness,
    whyPersonal: ev.why,
    // Build 25T: a commitment realised by a task names it, so the two collapse
    // on the explicit link and never on similar wording.
    realisedBy: item.kind === 'commitment' ? item.taskId || null : null,
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
  let careLinks = new Map();
  try { careLinks = require('./companion-care').linkMap(); } catch (e) { gaps.push({ input: 'companion-links', why: e.message }); }
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
    const ev = personalEvidence(it, { goalLinks, prepLinks: prep.byEntity, careLinks });
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
  let activation = null;
  try { activation = adminActivation(require('./reminder-audit').read({ now }).lists); } catch (e) { activation = { state: 'unknown', lists: [], steps: [], why: `the list audit could not be read: ${e.message}` }; }
  return {
    ok: true,
    asOf: new Date(now).toISOString(),
    activation,
    sources: [
      { source: 'Reminders lists classified admin / finance / transport', containers: lists.map((l) => l.label), items: obligations.items.filter((o) => o.source === 'Reminders').length },
      { source: 'NEURO tasks declared admin / finance / transport', items: obligations.items.filter((o) => o.source === 'NEURO').length },
      { source: 'Calendars classified admin / finance / transport', containers: cals.map((c) => c.label), upcomingEvents: calEvents },
      { source: 'Vault notes', items: null, why: 'not modelled — notes are never read as obligations' },
      { source: 'Bills and the car', items: null, why: 'shown on the Finance and Vehicle cards — a bill or a car date becomes admin only when you make it a task or link one' },
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

// ── Build 20N: the vehicle a personal-admin item concerns ───────────────────
//
// Just enough transport context to keep "MOT" next to "the car": Nick names
// the vehicle ("car", "van") and links a task or commitment to it. No vehicle
// record, registration, mileage or service history is modelled. The link is
// explicit; "MOT" in a title links nothing.

/** "The Car" → "vehicle:the-car". PURE. null when it cannot be a name. */
function vehicleSubject(name) {
  const s = String(name || '').trim().toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return s && VEHICLE_RE.test(`vehicle:${s}`) ? `vehicle:${s}` : null;
}

/**
 * Build 21D: once a real vehicle is HELD (services/vehicle.js), a link must
 * name it — by id ("vehicle:captur") or its model ("Captur"). "car" no longer
 * mints a generic second vehicle beside the Captur. With none held, the
 * Build 20 free-name behaviour stands.
 */
function _resolveVehicle(vehicle) {
  let held = [];
  try { held = require('./vehicle').listVehicles(); } catch { held = []; }
  if (!held.length) return { subjectId: vehicleSubject(vehicle) };
  const want = String(vehicle || '').trim().toLowerCase();
  const hit = held.find((v) => v.vehicle_id === want || String(v.model).toLowerCase() === want || vehicleSubject(v.model) === vehicleSubject(want));
  if (!hit) return { error: `no such vehicle — NEURO holds ${held.map((v) => `${v.make} ${v.model} (${v.vehicle_id})`).join(', ')}`, status: 404 };
  return { subjectId: hit.vehicle_id, name: `${hit.make} ${hit.model}` };
}

function linkVehicle({ vehicle, entityId, label = null } = {}, { now = Date.now() } = {}) {
  const resolved = _resolveVehicle(vehicle);
  if (resolved.error) return { ok: false, status: resolved.status, error: resolved.error };
  const subjectId = resolved.subjectId;
  if (!subjectId) return { ok: false, status: 400, error: 'vehicle must be a short name, e.g. "car"' };
  if (typeof entityId !== 'string' || !VEHICLE_ENTITY_PREFIXES.test(entityId) || entityId.length > 300) return { ok: false, status: 400, error: 'entityId must be a task (task:…), commitment (commitment:…) or calendar entry (meeting:…)' };
  const db = _db();
  const r = db.run('INSERT OR IGNORE INTO personal_links (subject_id, entity_id, relation, set_at) VALUES (?, ?, ?, ?)',
    [subjectId, entityId, 'concerns', new Date(now).toISOString()]);
  if (r && r.changes) logEvent('vehicle-link-added', { subjectId, actor: 'nick', detail: { entityId, label, vehicle: vehicleName(subjectId) }, dedupeKey: `vehicle-link-added:${subjectId}>${entityId}:${now}`, now });
  return { ok: true, already: !(r && r.changes), link: { subjectId, entityId, relation: 'concerns' } };
}

function unlinkVehicle({ vehicle, entityId, label = null } = {}, { now = Date.now() } = {}) {
  const subjectId = typeof vehicle === 'string' && vehicle.startsWith('vehicle:') ? vehicle : vehicleSubject(vehicle);
  if (!subjectId || typeof entityId !== 'string') return { ok: false, status: 400, error: 'vehicle and entityId are required' };
  const r = _db().run("DELETE FROM personal_links WHERE subject_id = ? AND entity_id = ? AND relation = 'concerns'", [subjectId, entityId]);
  if (r && r.changes) logEvent('vehicle-link-removed', { subjectId, actor: 'nick', detail: { entityId, label, vehicle: vehicleName(subjectId) }, dedupeKey: `vehicle-link-removed:${subjectId}>${entityId}:${now}`, now });
  return { ok: true, removed: !!(r && r.changes) };
}

/**
 * Build 20L — is personal admin ACTIVE? PURE over the list audit and the
 * classified admin lists. NEURO cannot create an Apple Reminders list; this
 * says where activation has got to and the next step, and never guesses that
 * a list is admin from its name.
 *   lists  reminder-audit lists [{ name, sourceKey, trackingState, classification }]
 */
function adminActivation(lists = []) {
  const isAdminList = (l) => (l.classification && l.classification.domains || []).some((d) => ADMIN_DOMAINS.includes(d.domain || d));
  const adminLists = lists.filter(isAdminList);
  const tracked = adminLists.filter((l) => l.trackingState === 'tracked');
  const steps = [
    'On the iPhone, open Reminders and create a list called "Personal Admin" (NEURO cannot create Apple lists).',
    'Open NEURO or SAiM on the phone so it pushes the new list.',
    'Here, in Reminder lists: set that list as Admin and Track it.',
    'Add real items to it with their due dates (MOT, insurance renewal, …). NEURO reads only what is there.',
  ];
  if (tracked.length) return { state: 'active', lists: tracked.map((l) => l.name), steps: [], why: `reading ${tracked.map((l) => `"${l.name}"`).join(', ')}` };
  if (adminLists.length) return { state: 'classified-not-tracked', lists: adminLists.map((l) => l.name), candidates: adminLists.map((l) => ({ name: l.name, sourceKey: l.sourceKey, disambiguator: l.disambiguator || null })), steps: steps.slice(2), why: `${adminLists.map((l) => `"${l.name}"`).join(', ')} is set as admin but not tracked, so NEURO does not read it` };
  // 8 Oct 2026 — the list had ARRIVED from the phone and the card still told
  // Nick to go and create it. A list nobody has decided about yet (not
  // classified, not tracked, not ignored) is offered as a CANDIDATE: every one
  // of them, by id, never picked by its name — Nick presses which is admin.
  const undecided = lists.filter((l) => l.keyedBy === 'id' && l.trackingState === 'unknown'
    && !((l.classification && l.classification.domains) || []).length);
  if (undecided.length) {
    return { state: 'list-waiting', lists: [], candidates: undecided.map((l) => ({ name: l.name, sourceKey: l.sourceKey, disambiguator: l.disambiguator || null })),
      steps: steps.slice(2), why: `${undecided.map((l) => `"${l.name}"`).join(', ')} ${undecided.length === 1 ? 'has' : 'have'} arrived from the phone but nobody has said what ${undecided.length === 1 ? 'it is' : 'they are'} for` };
  }
  return { state: 'not-set-up', lists: [], candidates: [], steps, why: 'no reminder list is set as admin, finance or transport yet' };
}

module.exports = {
  EXPLICIT_BASES, ADMIN_DOMAINS, NEEDS_NOW_AHEAD_DAYS, NEEDS_NOW_OVERDUE_DAYS,
  // pure
  personalEvidence, isAdmin, obligationStatus, evidenceFreshness, shapeObligation, rankObligations, validateLink,
  vehicleName, vehicleSubject, adminActivation,
  // store
  prepLinkMap, goalLinkMap, read, adminAudit, logEvent, linkPrep, unlinkPrep, linkVehicle, unlinkVehicle,
};
