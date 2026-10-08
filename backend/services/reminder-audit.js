'use strict';

/**
 * Build 19A — the Apple Reminders list audit, by STABLE ID.
 *
 * "Which lists does NEURO see, what are they for, which does it read, and how
 * much is in each?" — answered from evidence, list by list:
 *
 *   • identity is the list's `calendarIdentifier` (`reminders:id:<id>`). Two
 *     lists may share a name — the live phone has TWO called "Reminders" — so a
 *     name is never an identity and never a classification. A by-name row
 *     from an app build before ids is reported as SUPERSEDED by its id-keyed
 *     twin, not as a third list.
 *   • classification is only what Nick set (source_classifications). Unset is
 *     `unknown`; "Home" does not mean home and "Reminders" does not mean
 *     personal.
 *   • TRACKED says whether its reminders enter the world model: tracked,
 *     ignored, or unknown (not decided, not read). Since Build 20A only Nick's
 *     decision on the list id counts — the built-in-name rule is gone.
 *   • counts come from what the phone actually pushed (open / completed in the
 *     30 days the phone sends), recorded per app at ingest as COUNTS ONLY —
 *     no titles, no notes. Never pushed since this build = `null`, never 0.
 *
 * The shaper is pure; the readers at the bottom are the only DB code.
 */

const lc = (s) => String(s || '').trim().toLowerCase();
const PUSH_KEY = 'reminders_push_by_client';
const STALE_SEEN_DAYS = 14;

/**
 * Per-list counts for ONE push. PURE.
 *   reminders  the phone's payload (each { list, listId, isCompleted, id })
 *   lists      [{ id, title }] the lists the phone could see
 *   isTracked  (listItem) → boolean
 * Returns [{ id, title, open, completed, tracked, projectable }]. `projectable`
 * counts tracked reminders that carried an id (an id-less one is never projected).
 */
function countByList(reminders, lists, isTracked) {
  const byKey = new Map();
  const keyOf = (id, title) => (id ? `id:${id}` : `title:${lc(title)}`);
  for (const l of lists || []) {
    if (!l) continue;
    const k = keyOf(l.id, l.title);
    if (!byKey.has(k)) byKey.set(k, { id: l.id || null, title: l.title || null, open: 0, completed: 0, tracked: !!isTracked(l), projectable: 0 });
  }
  for (const r of reminders || []) {
    if (!r || !r.list) continue;
    const k = keyOf(r.listId ? String(r.listId) : null, String(r.list));
    if (!byKey.has(k)) {
      const l = { id: r.listId ? String(r.listId) : null, title: String(r.list) };
      byKey.set(k, { ...l, open: 0, completed: 0, tracked: !!isTracked(l), projectable: 0 });
    }
    const row = byKey.get(k);
    if (r.isCompleted === true) row.completed += 1; else row.open += 1;
    if (row.tracked && r.id && r.title && String(r.title).trim()) row.projectable += 1;
  }
  return [...byKey.values()];
}

/**
 * Why a list is (not) tracked. PURE. Build 20A: only Nick's explicit decision
 * on the list's STABLE ID counts — `tracked` (read), `ignored` (set not to be
 * read) or `unknown` (not decided, and NOT read). There is no name rule. A
 * by-name row from an old app build cannot be tracked at all.
 */
function trackingFor(classification, { keyedBy = 'id' } = {}) {
  if (keyedBy !== 'id') return { tracked: false, state: 'needs-id', basis: 'no-id', why: 'an older app build sent this list without its id — it cannot be tracked' };
  if (classification && typeof classification.tracked === 'boolean') {
    return classification.tracked
      ? { tracked: true, state: 'tracked', basis: 'set', why: 'you set it as tracked' }
      : { tracked: false, state: 'ignored', basis: 'set', why: 'you set it as ignored' };
  }
  return { tracked: false, state: 'unknown', basis: 'not-set', why: 'not decided — NEURO does not read a list until you say to track it' };
}

/**
 * The audit, one row per list. PURE.
 *   containers      [{ sourceKey, label, containerId, firstSeenAt, lastSeenAt, lastClient }] reminder lists
 *   classifications Map sourceKey → { domains, tracked, setAt }
 *   pushes          { [client]: { at, complete, lists: [{ id, title, open, completed, tracked, projectable }] } }
 *   worldCounts     Map sourceKey → { total, current } (world-model reminders per list)
 *   health          [{ sourceId, state, freshness, lastObservedAt }] for reminders.*
 *   domainLabel     (domain) → label
 */
function auditLists({ containers = [], classifications = new Map(), pushes = {}, worldCounts = new Map(), health = [], domainLabel = (d) => d, now = Date.now() } = {}) {
  const idRows = containers.filter((c) => /^reminders:id:/.test(c.sourceKey));
  const titleRows = containers.filter((c) => /^reminders:title:/.test(c.sourceKey));
  const idNames = new Map();
  for (const c of idRows) idNames.set(lc(c.label), [...(idNames.get(lc(c.label)) || []), c.containerId || c.sourceKey.replace(/^reminders:id:/, '')]);
  // Build 20C: a STABLE ordinal per shared name — first seen first, then id —
  // so "Reminders · List 2" names the same list on every read.
  const ordinal = new Map();
  for (const [, ids] of idNames) {
    if (ids.length < 2) continue;
    const rows = idRows.filter((c) => ids.includes(c.containerId || c.sourceKey.replace(/^reminders:id:/, '')))
      .sort((a, b) => String(a.firstSeenAt || '9999').localeCompare(String(b.firstSeenAt || '9999')) || a.sourceKey.localeCompare(b.sourceKey));
    rows.forEach((c, i) => ordinal.set(c.sourceKey, { index: i + 1, of: rows.length }));
  }

  const pushRows = [];
  for (const [client, p] of Object.entries(pushes || {})) {
    for (const l of (p && p.lists) || []) pushRows.push({ client, at: p.at, complete: !!p.complete, ...l });
  }
  const countsFor = (id, label) => {
    const mine = pushRows.filter((r) => (id ? r.id === id : !r.id && lc(r.title) === lc(label)));
    if (!mine.length) return null;
    const newest = mine.sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    return { open: newest.open, completed30d: newest.completed, measuredAt: newest.at, client: newest.client, readComplete: newest.complete,
      clients: [...new Set(mine.map((r) => r.client))].sort() };
  };

  const shape = (c, { superseded = false } = {}) => {
    const id = c.containerId || (/^reminders:id:/.test(c.sourceKey) ? c.sourceKey.replace(/^reminders:id:/, '') : null);
    const cls = classifications.get(c.sourceKey) || null;
    const domains = cls && Array.isArray(cls.domains) ? cls.domains : [];
    const tracking = trackingFor(cls, { keyedBy: /^reminders:id:/.test(c.sourceKey) ? 'id' : 'title' });
    const twins = (idNames.get(lc(c.label)) || []).filter((x) => x !== id);
    const counts = countsFor(id, c.label);
    // An untracked list's reminders are not read (canonical reads hide them),
    // so "in the world model" is 0 for it whatever the projection still holds.
    const world = tracking.tracked ? (worldCounts.get(c.sourceKey) || { total: 0, current: 0 }) : { total: 0, current: 0 };
    const seenAgeDays = c.lastSeenAt ? Math.floor((now - Date.parse(c.lastSeenAt)) / 86400000) : null;
    const flags = [];
    if (twins.length) flags.push('duplicate-name');
    if (tracking.state === 'unknown') flags.push('tracking-not-decided');
    if (domains.length && !tracking.tracked) flags.push('classified-but-not-tracked');
    if (seenAgeDays !== null && seenAgeDays > STALE_SEEN_DAYS) flags.push('not-seen-recently');
    if (counts === null && !superseded) flags.push('counts-not-measured-yet');
    return {
      listId: id,
      sourceKey: c.sourceKey,
      name: c.label,
      keyedBy: id ? 'id' : 'title',
      superseded,
      sourceApps: counts ? counts.clients : (c.lastClient ? [c.lastClient] : []),
      classification: domains.length
        ? { state: 'classified', domains: domains.map((d) => ({ domain: d, label: domainLabel(d) })), setAt: cls.setAt || null, basis: 'user-set' }
        : { state: 'unknown', domains: [], setAt: null, basis: null },
      tracked: tracking.tracked,
      trackingState: tracking.state,
      trackedBasis: tracking.basis,
      trackedWhy: tracking.why,
      disambiguator: ordinal.has(c.sourceKey) ? `List ${ordinal.get(c.sourceKey).index} of ${ordinal.get(c.sourceKey).of}` : null,
      firstSeenAt: c.firstSeenAt || null,
      lastSeenAt: c.lastSeenAt || null,
      openCount: counts ? counts.open : null,
      completedCount30d: counts ? counts.completed30d : null,
      countsMeasuredAt: counts ? counts.measuredAt : null,
      inWorldModel: { open: world.current, total: world.total },
      duplicateName: twins.length ? { count: twins.length + 1, otherListIds: twins } : null,
      flags,
    };
  };

  const lists = idRows.map((c) => shape(c));
  const legacy = titleRows.map((c) => shape(c, { superseded: idNames.has(lc(c.label)) }));
  const sources = (health || []).map((h) => ({ sourceId: h.sourceId, state: h.state || 'unknown', freshness: h.freshness || 'unknown', lastObservedAt: h.lastObservedAt || null }));
  const summary = {
    lists: lists.length,
    classified: lists.filter((l) => l.classification.state === 'classified').length,
    unknown: lists.filter((l) => l.classification.state === 'unknown').length,
    tracked: lists.filter((l) => l.trackingState === 'tracked').length,
    ignored: lists.filter((l) => l.trackingState === 'ignored').length,
    trackingUndecided: lists.filter((l) => l.trackingState === 'unknown').length,
    duplicateNames: [...new Set(lists.filter((l) => l.duplicateName).map((l) => l.name))],
    open: lists.every((l) => l.openCount === null) ? null : lists.reduce((s, l) => s + (l.openCount || 0), 0),
    completed30d: lists.every((l) => l.completedCount30d === null) ? null : lists.reduce((s, l) => s + (l.completedCount30d || 0), 0),
    inWorldModel: lists.reduce((s, l) => s + l.inWorldModel.open, 0),
    legacyByName: legacy.length,
  };
  return { lists, legacy, sources, summary };
}

// ── store ───────────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }

/** Record one push's per-list counts under its app. Never allowed to fail an ingest. */
function recordPush(client, rows, { complete = false, now = Date.now() } = {}) {
  try {
    const db = _db();
    let all = {};
    try { all = JSON.parse(db.getState(PUSH_KEY) || '{}') || {}; } catch { all = {}; }
    all[client || 'unknown'] = { at: new Date(now).toISOString(), complete: !!complete, lists: rows };
    db.setState(PUSH_KEY, JSON.stringify(all));
    return true;
  } catch (e) {
    console.warn('[ReminderAudit] per-list counts not recorded:', e.message);
    return false;
  }
}

function pushes() {
  try { return JSON.parse(_db().getState(PUSH_KEY) || '{}') || {}; } catch { return {}; }
}

/** The live audit. */
function read({ now = Date.now() } = {}) {
  const db = _db();
  const sc = require('./source-classification');
  const domainsLib = require('../../shared/life-domains.cjs');
  const containers = db.all(`SELECT source_key, label, container_id, first_seen_at, last_seen_at, last_client FROM source_containers
                              WHERE kind = 'reminder-list' ORDER BY label, source_key`).map((r) => ({
    sourceKey: r.source_key, label: r.label, containerId: r.container_id, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, lastClient: r.last_client,
  }));
  let worldCounts = new Map();
  try { worldCounts = sc.entryCounts({ now }); } catch { worldCounts = new Map(); }
  let health = [];
  try {
    health = db.all(`SELECT source_id, state, freshness, last_observed_at FROM source_health WHERE source_id LIKE 'reminders.%' ORDER BY source_id`)
      .map((h) => ({ sourceId: h.source_id, state: h.state, freshness: h.freshness, lastObservedAt: h.last_observed_at }));
  } catch { health = []; }
  const audit = auditLists({
    containers, classifications: sc.classificationMap('reminder-list'), pushes: pushes(), worldCounts, health,
    domainLabel: domainsLib.domainLabel, now,
  });
  return {
    ok: true, asOf: new Date(now).toISOString(), ...audit,
    rule: 'Lists are identified by Apple\'s list id, never by name. What a list is FOR (classification) and whether NEURO READS it (tracking) are two separate choices, both yours; a list is not read until you say to track it.',
  };
}

module.exports = { PUSH_KEY, countByList, trackingFor, auditLists, recordPush, pushes, read };
