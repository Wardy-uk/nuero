'use strict';

/**
 * What each calendar and reminder list is FOR, as Nick said (Build 11B).
 *
 * ── Calendar source is not domain ──────────────────────────────────────────
 *
 * Build 10 pinned that Outlook does not mean work and EventKit does not mean
 * personal: the transport says nothing about the life. But the CONTAINER can,
 * when Nick says so — "the Open Uni calendar is learning", "Family is family".
 * That is explicit evidence, recorded per container, and it is the only way a
 * calendar or list contributes a domain:
 *
 *   • unclassified → unknown. Never a default, never a guess from the title
 *     ("Family" is not classified family until Nick says it is).
 *   • a classification is basis `classified` (shared/life-domains.cjs): strong
 *     enough to carry a sensitive domain because Nick stated it, weaker than a
 *     declaration about the item itself.
 *   • applied at READ time. Reclassifying a calendar changes every event's
 *     domain on the next read, with no replay and nothing rewritten.
 *
 * ── The key is the provider's identifier; a title is a fallback ────────────
 *
 * Measured on the live phone (3 Oct 2026): 23 calendars, two called "Home" and
 * two called "Work". A title is therefore NOT an identity. iOS builds from
 * Build 11 send each calendar's `calendarIdentifier`; older builds send titles
 * only. A title key is honoured only while exactly ONE visible calendar carries
 * that title — two "Home" calendars make the title key AMBIGUOUS, and an
 * ambiguous classification is refused rather than applied to both.
 *
 * The SHAPERS are pure; the store functions at the bottom are the only DB code.
 */

const domainsLib = require('../../shared/life-domains.cjs');

const KINDS = Object.freeze(['calendar', 'reminder-list']);
const GRAPH_PRIMARY = 'graph-cal:primary';

const lc = (s) => String(s || '').trim().toLowerCase();

/** The stable key for a container. PURE. Identifier first; title only as a fallback. */
function containerKey(kind, { id = null, title = null, provider = 'eventkit' } = {}) {
  if (kind === 'calendar' && provider === 'graph') return GRAPH_PRIMARY;
  const prefix = kind === 'calendar' ? 'eventkit-cal' : 'reminders';
  if (id && String(id).trim()) return `${prefix}:id:${String(id).trim()}`;
  if (title && String(title).trim()) return `${prefix}:title:${lc(title)}`;
  return null;
}

/** Same, but only the title form — used to find a classification made before ids arrived. */
function titleKey(kind, title) {
  return containerKey(kind, { title });
}

/**
 * The domain claims a container contributes. PURE.
 *
 * `classification` is the stored row (or null). `ambiguous` is true when the
 * match was by a title more than one visible container carries — refused.
 * Returns `{ claims, state, why }`:
 *   state  classified | unclassified | ambiguous | not-tracked
 */
function claimsFor(classification, { ambiguous = false, label = null } = {}) {
  if (ambiguous) {
    return { claims: [], state: 'ambiguous', why: `more than one calendar is called "${label || '?'}" — classify it again once the app sends calendar ids` };
  }
  if (!classification) return { claims: [], state: 'unclassified', why: null };
  if (classification.tracked === false) return { claims: [], state: 'not-tracked', why: 'you set this as not tracked' };
  const doms = (classification.domains || []).map(domainsLib.normaliseDomain).filter(Boolean);
  const name = label || classification.label || 'this container';
  return {
    claims: doms.map((d) => ({ domain: d, basis: 'classified', why: `you classified "${name}" as ${domainsLib.domainLabel(d)}` })),
    state: doms.length ? 'classified' : 'unclassified',
    why: null,
  };
}

/**
 * Resolve which classification applies to an item that came through a
 * container. PURE over its inputs.
 *   item       { id, title }  the container as the item names it
 *   byKey      Map source_key → classification row
 *   titleCount Map lower-cased title → how many visible containers carry it
 */
function resolveFor(kind, item, { byKey = new Map(), titleCount = new Map(), provider = 'eventkit' } = {}) {
  if (!item) return { key: null, classification: null, ambiguous: false };
  const idKey = containerKey(kind, { id: item.id, title: null, provider });
  if (idKey && byKey.has(idKey)) return { key: idKey, classification: byKey.get(idKey), ambiguous: false };
  const tKey = item.title ? titleKey(kind, item.title) : null;
  if (provider === 'graph') return { key: GRAPH_PRIMARY, classification: byKey.get(GRAPH_PRIMARY) || null, ambiguous: false };
  if (tKey && byKey.has(tKey)) {
    // A title classification is honoured only while the title is unique.
    const n = titleCount.get(lc(item.title)) || 0;
    if (n > 1) return { key: tKey, classification: null, ambiguous: true };
    return { key: tKey, classification: byKey.get(tKey), ambiguous: false };
  }
  // An item from an old build names only a title. If exactly ONE id-keyed
  // container of this kind carries that name and Nick classified it, that is
  // the same calendar/list — use its classification. Two with the name is
  // ambiguous and takes neither.
  if (!item.id && item.title) {
    const prefix = kind === 'calendar' ? 'eventkit-cal:id:' : 'reminders:id:';
    const same = [...byKey.values()].filter((c) => String(c.sourceKey || '').startsWith(prefix) && lc(c.label) === lc(item.title));
    if (same.length === 1) return { key: same[0].sourceKey, classification: same[0], ambiguous: false };
  }
  return { key: idKey || tKey, classification: null, ambiguous: false };
}

/** Validate a classification request. PURE. Unknown domains REFUSED, never dropped. */
function validate({ kind, sourceKey, domains, tracked }) {
  if (!KINDS.includes(kind)) return { ok: false, error: `kind must be one of ${KINDS.join(', ')}` };
  if (!sourceKey || typeof sourceKey !== 'string' || sourceKey.length > 400) return { ok: false, error: 'sourceKey is required' };
  if (!/^(eventkit-cal|reminders):(id|title):.+|^graph-cal:primary$/.test(sourceKey)) return { ok: false, error: 'sourceKey is not a container key' };
  if (kind === 'calendar' && !/^(eventkit-cal|graph-cal):/.test(sourceKey)) return { ok: false, error: 'a calendar key must be a calendar' };
  if (kind === 'reminder-list' && !/^reminders:/.test(sourceKey)) return { ok: false, error: 'a reminder-list key must be a list' };
  if (domains !== undefined && domains !== null) {
    if (!Array.isArray(domains)) return { ok: false, error: 'domains must be a list' };
    const bad = domains.filter((d) => !domainsLib.normaliseDomain(d));
    if (bad.length) return { ok: false, error: `unknown domain: ${bad.join(', ')}` };
  }
  if (tracked !== undefined && tracked !== null && typeof tracked !== 'boolean') return { ok: false, error: 'tracked must be true or false' };
  // A phone calendar can be IGNORED (5 Oct 2026): untracked, its events stop
  // arriving. The Outlook account cannot — it is the work diary every booking,
  // planner and prep path reads, and ignoring it would blind all of them.
  if (tracked !== undefined && tracked !== null && sourceKey === GRAPH_PRIMARY) return { ok: false, error: 'the Outlook calendar cannot be ignored' };
  // Build 20A: a reminder list is tracked by its STABLE ID only. A by-name key
  // cannot carry a tracking decision — two lists can share the name.
  if (tracked !== undefined && tracked !== null && /^reminders:title:/.test(sourceKey)) {
    return { ok: false, error: 'a reminder list is tracked by its list id — this one has only a name (an older app build)' };
  }
  return { ok: true };
}

// ── store ───────────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

function _shape(r) {
  return {
    kind: r.kind, sourceKey: r.source_key, label: r.label || null,
    domains: parse(r.domains_json) || [], tracked: r.tracked === null || r.tracked === undefined ? null : r.tracked === 1,
    setAt: r.set_at, setVia: r.set_via, provenance: 'user-set',
  };
}

function listClassifications(kind = null) {
  const db = _db();
  const rows = kind ? db.all('SELECT * FROM source_classifications WHERE kind = ?', [kind]) : db.all('SELECT * FROM source_classifications');
  return rows.map(_shape);
}

function classificationMap(kind) {
  return new Map(listClassifications(kind).map((c) => [c.sourceKey, c]));
}

/**
 * Nick classifies a container. OMITTED leaves a field; NULL clears it. A row
 * with nothing left in it is deleted — "no classification" is the absence of
 * a row, never a row of nulls.
 */
function classify({ kind, sourceKey, domains, tracked, label } = {}, { now = Date.now() } = {}) {
  const v = validate({ kind, sourceKey, domains, tracked });
  if (!v.ok) return v;
  const db = _db();
  const held = db.get('SELECT * FROM source_classifications WHERE kind = ? AND source_key = ?', [kind, sourceKey]);
  let nextDomains = held ? held.domains_json : null;
  let nextTracked = held ? held.tracked : null;
  if (domains !== undefined) {
    nextDomains = domains === null || !domains.length ? null : JSON.stringify([...new Set(domains.map(domainsLib.normaliseDomain))]);
  }
  if (tracked !== undefined) nextTracked = tracked === null ? null : tracked ? 1 : 0;
  const container = db.get('SELECT label FROM source_containers WHERE kind = ? AND source_key = ?', [kind, sourceKey]);
  const nextLabel = typeof label === 'string' && label.trim() ? label.trim().slice(0, 200) : (container ? container.label : (held ? held.label : null));
  const iso = new Date(now).toISOString();
  if (!nextDomains && nextTracked === null) {
    db.run('DELETE FROM source_classifications WHERE kind = ? AND source_key = ?', [kind, sourceKey]);
    return { ok: true, classification: null };
  }
  db.run(`INSERT INTO source_classifications (kind, source_key, label, domains_json, tracked, set_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(kind, source_key) DO UPDATE SET label = excluded.label, domains_json = excluded.domains_json,
            tracked = excluded.tracked, set_at = excluded.set_at`,
  [kind, sourceKey, nextLabel, nextDomains, nextTracked, iso]);
  return { ok: true, classification: _shape(db.get('SELECT * FROM source_classifications WHERE kind = ? AND source_key = ?', [kind, sourceKey])) };
}

/**
 * Record the containers a push SHOWED. Never allowed to fail an ingest.
 * `containers` is [{ id?, title }]. Returns the per-title counts of THIS push,
 * which is what makes a duplicated title visible as ambiguous.
 */
function observeContainers(kind, containers, { provider = 'eventkit', client = null, now = Date.now() } = {}) {
  try {
    const db = _db();
    const iso = new Date(now).toISOString();
    for (const c of containers || []) {
      const title = c && (c.title || c.name) ? String(c.title || c.name).slice(0, 200) : null;
      const key = containerKey(kind, { id: c && c.id, title, provider });
      if (!key || !title) continue;
      db.run(`INSERT INTO source_containers (kind, source_key, label, container_id, provider, first_seen_at, last_seen_at, last_client)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(kind, source_key) DO UPDATE SET label = excluded.label, container_id = excluded.container_id,
                last_seen_at = excluded.last_seen_at, last_client = excluded.last_client`,
      [kind, key, title, c.id ? String(c.id) : null, provider, iso, iso, client]);
    }
    return true;
  } catch (e) {
    console.warn(`[SourceClassification] containers not recorded: ${e.message}`);
    return false;
  }
}

/** How many containers SEEN RECENTLY carry each lower-cased title. */
function titleCounts(kind, { withinDays = 14, now = Date.now() } = {}) {
  const out = new Map();
  try {
    const since = new Date(now - withinDays * 86400000).toISOString();
    // A title is ambiguous when two DIFFERENT containers carry it. Id-keyed rows
    // are distinct containers; a title-keyed row is one older-client sighting.
    const rows = _db().all('SELECT source_key, label FROM source_containers WHERE kind = ? AND last_seen_at >= ?', [kind, since]);
    const ids = rows.filter((r) => /:id:/.test(r.source_key));
    const pool = ids.length ? ids : rows;
    for (const r of pool) out.set(lc(r.label), (out.get(lc(r.label)) || 0) + 1);
  } catch { /* empty: nothing is ambiguous we can prove */ }
  return out;
}

/** Record that a title-only push listed a title more than once (older clients). */
function noteDuplicateTitles(kind, titles, { now = Date.now() } = {}) {
  const counts = new Map();
  for (const t of titles || []) counts.set(lc(t), (counts.get(lc(t)) || 0) + 1);
  try {
    const db = _db();
    db.setState(`source_containers_dup:${kind}`, JSON.stringify({ at: new Date(now).toISOString(),
      titles: [...counts.entries()].filter(([, n]) => n > 1).map(([t, n]) => ({ title: t, count: n })) }));
  } catch { /* bookkeeping only */ }
  return counts;
}

function duplicateTitles(kind) {
  try {
    const raw = _db().getState(`source_containers_dup:${kind}`);
    const v = raw ? JSON.parse(raw) : null;
    return new Map(((v && v.titles) || []).map((x) => [x.title, x.count]));
  } catch { return new Map(); }
}

/** Title counts with the older-client duplicate record folded in. */
function effectiveTitleCounts(kind, opts = {}) {
  const a = titleCounts(kind, opts);
  for (const [t, n] of duplicateTitles(kind)) a.set(t, Math.max(a.get(t) || 0, n));
  return a;
}

/** Every container seen, with its classification and ambiguity — the config screen's read. */
function listContainers({ now = Date.now() } = {}) {
  const db = _db();
  const out = [];
  for (const kind of KINDS) {
    const map = classificationMap(kind);
    const counts = effectiveTitleCounts(kind, { now, withinDays: 3650 });
    const rows = db.all('SELECT * FROM source_containers WHERE kind = ? ORDER BY label', [kind]);
    for (const r of rows) {
      const c = map.get(r.source_key) || null;
      const ambiguous = /:title:/.test(r.source_key) && (counts.get(lc(r.label)) || 0) > 1;
      out.push({ kind, sourceKey: r.source_key, label: r.label, containerId: r.container_id, provider: r.provider,
        keyedBy: /:id:/.test(r.source_key) ? 'id' : r.source_key === GRAPH_PRIMARY ? 'account' : 'title',
        ambiguous, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at,
        classification: c, tracking: kind === 'reminder-list' ? trackingState({ id: r.container_id || (/:id:/.test(r.source_key) ? r.source_key.replace(/^reminders:id:/, '') : null) }, { byKey: map }) : null });
    }
    // A classification for a container not seen (yet) still shows — Nick set it.
    for (const c of map.values()) {
      if (!rows.some((r) => r.source_key === c.sourceKey)) {
        out.push({ kind, sourceKey: c.sourceKey, label: c.label || c.sourceKey, containerId: null, provider: c.sourceKey === GRAPH_PRIMARY ? 'graph' : 'eventkit',
          keyedBy: /:id:/.test(c.sourceKey) ? 'id' : c.sourceKey === GRAPH_PRIMARY ? 'account' : 'title', ambiguous: false, firstSeenAt: null, lastSeenAt: null, classification: c,
          tracking: kind === 'reminder-list' ? trackingState({ id: /:id:/.test(c.sourceKey) ? c.sourceKey.replace(/^reminders:id:/, '') : null }, { byKey: map }) : null, notSeen: true });
      }
    }
  }
  if (!out.some((o) => o.sourceKey === GRAPH_PRIMARY)) {
    out.push({ kind: 'calendar', sourceKey: GRAPH_PRIMARY, label: 'Outlook calendar (work account)', containerId: null, provider: 'graph',
      keyedBy: 'account', ambiguous: false, firstSeenAt: null, lastSeenAt: null, classification: null, tracking: null });
  }
  // A by-name container from an app build before ids is SUPERSEDED once the
  // same kind has an id-keyed container with that name: it is the same
  // calendar/list seen the old way. It is not listed, not counted as unknown,
  // and its items take the id-keyed classification (resolveFor) (5 Oct 2026).
  const idLabels = new Set(out.filter((o) => o.keyedBy === 'id').map((o) => `${o.kind}|${lc(o.label)}`));
  for (const o of out) o.superseded = o.keyedBy === 'title' && idLabels.has(`${o.kind}|${lc(o.label)}`);
  // Build 20C: two containers with one name get a STABLE ordinal ("List 1 of
  // 2"), ordered by when NEURO first saw each, then by key — never by sort
  // position on a screen, so a choice on "List 2" cannot drift onto "List 1".
  const byName = new Map();
  for (const o of out) {
    if (o.keyedBy !== 'id' || o.superseded) continue;
    const k = `${o.kind}|${lc(o.label)}`;
    byName.set(k, [...(byName.get(k) || []), o]);
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => String(a.firstSeenAt || '9999').localeCompare(String(b.firstSeenAt || '9999')) || a.sourceKey.localeCompare(b.sourceKey));
    group.forEach((o, i) => { o.twin = { index: i + 1, of: group.length, idTail: String(o.containerId || o.sourceKey).slice(-4) }; });
  }
  // How many entries the world model holds per container (5 Oct 2026). An
  // unreadable count is `null` — "not counted" — never 0, which reads as empty.
  let counts = null;
  try { counts = entryCounts({ now }); } catch (e) { console.warn('[SourceClassification] entry counts unreadable:', e.message); }
  for (const o of out) o.entries = counts ? (counts.get(o.sourceKey) || { total: 0, current: 0 }) : null;
  return out;
}

// ── entries per container ────────────────────────────────────────────────────
//
// Calendars: wm_meetings rows (scheduled only) by their stored calendar_key —
// derived id-first, so a by-name container from an old app build only counts
// what that old build delivered. `current` = from today on.
// Reminder lists: open/completed Apple reminders by their list. `current` = open.
// Both read the world model, so they agree with what Now and Tasks can see.

const todayLocal = (now) => {
  const d = new Date(now instanceof Date ? now.getTime() : now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function _reminderRows() {
  return _db().all(`SELECT record_id, task_id, status, completed_at, payload_json FROM wm_task_sources
                     WHERE system = 'eventkit-reminders' AND removed = 0`).map((r) => {
    let p = {}; try { p = JSON.parse(r.payload_json || '{}'); } catch { p = {}; }
    const l = p.list || {};
    return { key: containerKey('reminder-list', { id: l.id || null, title: l.title || null }), row: r, p };
  });
}

function entryCounts({ now = Date.now() } = {}) {
  const db = _db();
  const today = todayLocal(now);
  const out = new Map();
  for (const r of db.all(`SELECT calendar_key AS k, COUNT(*) AS total, SUM(CASE WHEN start_local >= ? THEN 1 ELSE 0 END) AS cur
                            FROM wm_meetings WHERE status = 'scheduled' AND calendar_key IS NOT NULL GROUP BY calendar_key`, [today])) {
    out.set(r.k, { total: r.total, current: r.cur || 0 });
  }
  // Outlook rows projected before Build 11C carry no calendar_key; every Graph
  // meeting IS the work account, so count by provider instead.
  const g = db.get(`SELECT COUNT(*) AS total, SUM(CASE WHEN start_local >= ? THEN 1 ELSE 0 END) AS cur
                      FROM wm_meetings WHERE status = 'scheduled' AND provider = 'graph'`, [today]);
  out.set(GRAPH_PRIMARY, { total: (g && g.total) || 0, current: (g && g.cur) || 0 });
  for (const { key, row } of _reminderRows()) {
    if (!key) continue;
    const c = out.get(key) || { total: 0, current: 0 };
    c.total += 1; if (row.status === 'open') c.current += 1;
    out.set(key, c);
  }
  return out;
}

/** The entries behind one container, newest-relevant first. Titles and dates only. */
function containerEntries(kind, sourceKey, { limit = 200, now = Date.now() } = {}) {
  if (!KINDS.includes(kind) || typeof sourceKey !== 'string' || !sourceKey) return { ok: false, status: 400, error: 'kind and sourceKey are required' };
  const today = todayLocal(now);
  if (kind === 'calendar') {
    const db = _db();
    const where = sourceKey === GRAPH_PRIMARY ? "provider = 'graph'" : 'calendar_key = ?';
    const args = sourceKey === GRAPH_PRIMARY ? [] : [sourceKey];
    const upcoming = db.all(`SELECT title, start_local, end_local, is_all_day FROM wm_meetings
                              WHERE status = 'scheduled' AND ${where} AND start_local >= ? ORDER BY start_local LIMIT ?`, [...args, today, limit]);
    const past = db.all(`SELECT title, start_local, end_local, is_all_day FROM wm_meetings
                          WHERE status = 'scheduled' AND ${where} AND start_local < ? ORDER BY start_local DESC LIMIT ?`, [...args, today, limit]);
    const shape = (r) => ({ title: r.title, start: r.start_local, end: r.end_local || null, allDay: r.is_all_day === 1 });
    return { ok: true, kind, sourceKey, current: upcoming.map(shape), past: past.map(shape) };
  }
  const rows = _reminderRows().filter((x) => x.key === sourceKey);
  const shape = ({ row, p }) => ({ title: p.title || p.text || '(untitled)', due: p.due || p.dueDate || null, status: row.status, completedAt: row.completed_at || null });
  const open = rows.filter((x) => x.row.status === 'open').map(shape).sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')));
  const done = rows.filter((x) => x.row.status !== 'open').map(shape).sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')));
  return { ok: true, kind, sourceKey, current: open.slice(0, limit), past: done.slice(0, limit) };
}

/**
 * Is a reminder list read into the world model? (Build 20A, 8 Oct 2026.)
 *
 * ONLY when Nick explicitly said "track it" on that list's STABLE ID. There is
 * no default and no name rule any more: the built-in-name fallback ("a list
 * called Reminders is read") is gone, because the live phone has TWO lists
 * called "Reminders" and a name cannot say which one Nick meant. Three states:
 *
 *   tracked   Nick set tracked: true on `reminders:id:<id>`
 *   ignored   Nick set tracked: false
 *   unknown   not decided — NOT read
 *
 * Never inferred from the list's name, the app that sent it, a domain
 * classification, or being Apple's default list. A list with no id (an app
 * build before Build 11) cannot be tracked at all, and a title-keyed row's
 * `tracked` is ignored (validate() refuses to store one).
 */
function trackingState(listItem, { byKey } = {}) {
  const id = listItem && listItem.id ? String(listItem.id).trim() : '';
  if (!id) return 'unknown';
  const map = byKey || classificationMap('reminder-list');
  const c = map.get(containerKey('reminder-list', { id }));
  if (!c || typeof c.tracked !== 'boolean') return 'unknown';
  return c.tracked ? 'tracked' : 'ignored';
}

function isTracked(listItem, { byKey } = {}) {
  return trackingState(listItem, { byKey }) === 'tracked';
}

/**
 * Has Nick ignored this phone calendar? Only an explicit `tracked: false` —
 * unlike a reminder list, a calendar is tracked by default, and an unknown or
 * ambiguous one is never ignored (losing a real event is the expensive error).
 */
function calendarIgnored(item, { byKey, titleCount } = {}) {
  const r = resolveFor('calendar', item, { byKey: byKey || classificationMap('calendar'), titleCount: titleCount || new Map() });
  return !!(r.classification && r.classification.tracked === false && !r.ambiguous);
}

module.exports = {
  KINDS, GRAPH_PRIMARY, calendarIgnored,
  // pure
  containerKey, titleKey, claimsFor, resolveFor, validate, trackingState,
  // store
  listClassifications, classificationMap, classify, observeContainers, titleCounts, effectiveTitleCounts,
  noteDuplicateTitles, listContainers, isTracked, entryCounts, containerEntries,
};
