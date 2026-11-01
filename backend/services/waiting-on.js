'use strict';

/**
 * Waiting on — what other people owe Nick.
 *
 * `standup-accountability` tracks what NICK carries. Nothing tracked the other
 * direction, and it was not for want of data: `action-candidates` already
 * detected "Abdi to send the SLA figures" in a meeting note, matched Abdi
 * against the People index, and then did `if (owner === 'others') continue` —
 * recognised the commitment and discarded it, name and all.
 *
 * With 13 reports, the things you are waiting on are most of what a Head of
 * Support actually has to hold in their head, so this is the gap that most
 * looks like the job.
 *
 * STORAGE: the `waiting_on` table since 15 Aug. It began in the agent_state KV
 * blob only because `schema.sql` was held by a concurrent session; it moved as
 * soon as that freed, because the chasing UI filters, sorts and — the deciding
 * one — SNOOZES, which is a per-item date a single blob had nowhere to put.
 * `migrateFromState()` lifts the KV copy in once and leaves it behind as a
 * rollback path.
 */

const db = require('../db/database');

const STATE_KEY = 'waiting_on_items';

// Matches the standup's rule: three days is when a carry becomes a decision.
const STALE_DAYS = 3;

/**
 * Storage moved from the agent_state KV blob to a real table on 15 Aug. The KV
 * row is deliberately LEFT IN PLACE as a rollback copy — it cost nothing to keep
 * and it holds the 287-item backfill that took a pass over 232 meeting notes.
 *
 * Row shape is snake_case in SQL and camelCase in JS; _fromRow/_toRow are the
 * only places that know, so the rest of the service reads exactly as it did.
 */
function _fromRow(r) {
  if (!r) return null;
  return {
    key: r.key,
    person: r.person,
    personFull: r.person_full,
    text: r.text,
    sourcePath: r.source_path,
    sourceDate: r.source_date,
    status: r.status,
    askedAt: r.asked_at,
    chaseCount: r.chase_count,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    sightings: r.sightings,
    reopenedAt: r.reopened_at,
    resolvedAt: r.resolved_at,
    snoozedUntil: r.snoozed_until,
    lastMentionedAt: r.last_mentioned_at ?? null,
  };
}

function _get(key) {
  return _fromRow(db.get('SELECT * FROM waiting_on WHERE key = ?', [key]));
}

function _all() {
  return db.all('SELECT * FROM waiting_on', []).map(_fromRow);
}

function _upsert(item) {
  db.run(
    `INSERT INTO waiting_on
       (key, person, person_full, text, source_path, source_date, status, asked_at,
        chase_count, first_seen, last_seen, sightings, reopened_at, resolved_at, snoozed_until,
        last_mentioned_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET
       person = excluded.person, person_full = excluded.person_full,
       text = excluded.text, source_path = excluded.source_path,
       source_date = excluded.source_date, status = excluded.status,
       asked_at = excluded.asked_at, chase_count = excluded.chase_count,
       last_seen = excluded.last_seen, sightings = excluded.sightings,
       reopened_at = excluded.reopened_at, resolved_at = excluded.resolved_at,
       snoozed_until = excluded.snoozed_until,
       last_mentioned_at = excluded.last_mentioned_at`,
    [
      item.key, item.person, item.personFull ?? null, item.text,
      item.sourcePath ?? null, item.sourceDate ?? null, item.status ?? 'open',
      item.askedAt ?? null, item.chaseCount ?? 0, item.firstSeen, item.lastSeen,
      item.sightings ?? 1, item.reopenedAt ?? null, item.resolvedAt ?? null,
      item.snoozedUntil ?? null, item.lastMentionedAt ?? null,
    ],
  );
  // Build 4B: the world model reads this table as commitments. Debounced, and
  // never allowed to fail the write (the durable reconcile is the backstop).
  try { require('./obligation-sources').schedulePublish('waiting-on'); } catch { /* reconcile catches it */ }
  return item;
}

/**
 * One-time lift of the KV blob into the table. Idempotent by construction — it
 * only runs when the table is empty — and it never deletes the KV copy, so a
 * bad migration is recoverable by reverting the code alone.
 */
function migrateFromState() {
  const already = db.get('SELECT COUNT(*) AS n FROM waiting_on', []);
  if ((already?.n ?? 0) > 0) return { migrated: 0, reason: 'table already populated' };

  let items = [];
  try {
    const raw = db.getState(STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) items = parsed;
  } catch {
    return { migrated: 0, reason: 'KV blob unreadable' };
  }
  if (!items.length) return { migrated: 0, reason: 'nothing in KV' };

  let migrated = 0;
  for (const i of items) {
    if (!i?.key || !i?.person || !i?.text) continue;   // skip anything malformed
    _upsert({
      ...i,
      firstSeen: i.firstSeen || i.lastSeen || new Date().toISOString(),
      lastSeen: i.lastSeen || i.firstSeen || new Date().toISOString(),
    });
    migrated++;
  }
  console.log(`[waiting-on] migrated ${migrated} items from the KV store into waiting_on`);
  return { migrated, reason: 'ok' };
}

/**
 * Canonical person for grouping. Meeting notes name the same colleague both
 * ways — "Chris to confirm" and "Chris Middleton to confirm" — which produced
 * two separate entries for one person, and so two separate answers to "what am
 * I waiting on from Chris?".
 *
 * First name wins because that is what the People index is keyed on. Two people
 * sharing a first name would merge; with 13 reports that is a trade worth making
 * for a list that is actually readable, and the full name is kept for display.
 */
function _canonicalPerson(person) {
  const raw = String(person || '').trim().replace(/(?:’s|'s)$/, '');
  const first = raw.split(/\s+/)[0] || raw;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function _key(person, text) {
  const norm = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 70);
  return `${String(person || '').toLowerCase()}::${norm}`;
}

/** "2026-06-30" → an ISO timestamp, or null if it is not a usable date. */
function _sourceDateToIso(sourceDate) {
  if (!sourceDate) return null;
  const m = String(sourceDate).match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}T09:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  // A note dated in the future is a typo, not a commitment made tomorrow.
  return d.getTime() > Date.now() ? null : d.toISOString();
}

function _ageDays(iso) {
  if (!iso) return 0;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.floor((Date.now() - then) / 86400000);
}

/**
 * Record a commitment someone else made. Folds on the dedupe key rather than
 * duplicating, so the same action appearing in a follow-up note updates the
 * sighting instead of creating a second row — the same rule the task store uses.
 */
function record({ person, text, sourcePath = null, sourceDate = null }) {
  if (!person || !String(text || '').trim()) return null;

  const canonical = _canonicalPerson(person);
  const key = _key(canonical, text);
  const existing = _get(key);

  if (existing) {
    existing.lastSeen = new Date().toISOString();
    existing.sightings = (existing.sightings || 1) + 1;
    // A DIFFERENT note naming it again is a mention; a re-read of the same note
    // is not (it stamps last_seen, which is why the lapse pass cannot use that).
    // Dated from the note when it has one, and only ever moved forward.
    if (sourcePath && sourcePath !== existing.sourcePath) {
      const at = _sourceDateToIso(sourceDate) || existing.lastSeen;
      if (!existing.lastMentionedAt || Date.parse(at) > Date.parse(existing.lastMentionedAt)) existing.lastMentionedAt = at;
    }
    // Re-opening is deliberate: if it shows up in a NEW meeting note after being
    // marked done, it evidently is not done.
    if (existing.status !== 'open' && sourcePath && sourcePath !== existing.sourcePath) {
      existing.status = 'open';
      existing.reopenedAt = existing.lastSeen;
      existing.resolvedAt = null;
      // A commitment that has resurfaced is not still snoozed.
      existing.snoozedUntil = null;
    }
    _upsert(existing);
    return existing;
  }

  const now = new Date().toISOString();
  const item = {
    key,
    person: canonical,
    // Kept for display where the note was specific.
    personFull: String(person).trim() !== canonical ? String(person).trim() : null,
    text: String(text).trim(),
    sourcePath,
    sourceDate,
    status: 'open',
    askedAt: null,
    // Dated from the MEETING, not from when this row was written. A backfill
    // over four months of notes otherwise stamps everything with today and
    // reports a commitment made in June as nought days old — which breaks the
    // only two things this list is sorted and filtered by.
    firstSeen: _sourceDateToIso(sourceDate) || now,
    lastSeen: now,
    lastMentionedAt: _sourceDateToIso(sourceDate) || now,
    sightings: 1,
    chaseCount: 0,
    snoozedUntil: null,
  };
  _upsert(item);
  return item;
}

/** Open items, oldest first — the ones that have been waiting longest matter most. */
function list({ status = 'open', person = null } = {}) {
  const now = Date.now();
  const items = _all()
    .filter(i => (status === 'all' ? true : i.status === status))
    .filter(i => (person ? i.person.toLowerCase() === person.toLowerCase() : true))
    .map(i => ({
      ...i,
      ageDays: _ageDays(i.firstSeen),
      stale: _ageDays(i.firstSeen) >= STALE_DAYS,
      chased: Boolean(i.askedAt),
      snoozed: Boolean(i.snoozedUntil) && new Date(i.snoozedUntil).getTime() > now,
    }));
  items.sort((a, b) => b.ageDays - a.ageDays);
  return items;
}

/** Grouped by person — how you actually think about it before a 1-2-1. */
function byPerson() {
  const groups = new Map();
  // "Looks done" rides on the open items (Build 5 evidence, shown, never applied).
  for (const item of attachLooksDone(list({ status: 'open' }))) {
    if (!groups.has(item.person)) groups.set(item.person, []);
    groups.get(item.person).push(item);
  }
  return [...groups.entries()]
    .map(([person, items]) => ({
      person,
      count: items.length,
      oldestDays: items[0].ageDays,
      items,
    }))
    .sort((a, b) => b.oldestDays - a.oldestDays);
}

function resolve(key, status = 'done') {
  const item = _get(key);
  if (!item) return null;
  item.status = status === 'dropped' ? 'dropped' : 'done';
  item.resolvedAt = new Date().toISOString();
  _upsert(item);
  return item;
}

/**
 * Nick says who this is with, by full name (from the Commitments screen). The
 * key keeps its first-name form, so later sightings still fold onto this row;
 * record() never overwrites person_full on a re-sighting.
 */
function setPersonFull(key, fullName) {
  const item = _get(key);
  if (!item) return null;
  item.personFull = String(fullName || '').trim() || null;
  _upsert(item);
  return item;
}

/**
 * Hide until a date — "they said next Friday". Distinct from resolving: the
 * commitment is still outstanding and still ages, it just stops being asked
 * about. Clearing is passing no date.
 */
function snooze(key, until = null) {
  const item = _get(key);
  if (!item) return null;
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error('until must be YYYY-MM-DD');
  item.snoozedUntil = until ? new Date(`${until}T09:00:00`).toISOString() : null;
  _upsert(item);
  return item;
}

/** Record that a chase went out, so it is not asked twice in a week. */
function markChased(key, { now = Date.now() } = {}) {
  const item = _get(key);
  if (!item) return null;
  item.askedAt = new Date(now).toISOString();
  item.chaseCount = (item.chaseCount || 0) + 1;
  _upsert(item);
  return item;
}

// ── Lapse: an open commitment nobody has mentioned in 90 days (1 Nov 2026) ──
//
// Live, 1 Nov: 508 open rows, growing, and nothing closed one except Nick.
// `lapsed` is NOT done and NOT dropped — Nick decided nothing, the same reason
// navigation shortcuts go `expired` rather than `rejected`. A lapsed row is not
// counted as kept or as broken, leaves the open list, and has a Reopen. A
// NEW note naming it again reopens it on its own (record()'s rule for any
// non-open row).

const LAPSE_DAYS = 90;
const DAY_MS = 86400000;
const NOT_YET_KEY = 'waiting_on_not_yet';

const _ms = (v) => (v == null || v === '' ? NaN : Date.parse(v));

/**
 * Whether one item lapses now. PURE: the item and the clock, nothing else.
 *
 * null = keep. Lapses only when ALL hold:
 *   - it is OPEN (done / dropped / lapsed are never touched) and not snoozed now;
 *   - its age (first_seen — the MEETING date) is readable and over 90 days —
 *     an unreadable age KEEPS it, because not knowing how old something is is
 *     not evidence that it is old;
 *   - nothing has happened to it in 90 days: no new-note mention
 *     (`last_mentioned_at`, else `last_seen` for rows from before that column —
 *     conservative, since a legacy re-read cannot be told from a mention), no
 *     reopen, no chase, no snooze date it was pointed at.
 */
function lapseVerdict(item, now = Date.now()) {
  if (!item || item.status !== 'open') return null;
  const nowMs = now instanceof Date ? now.getTime() : now;
  const snooze = _ms(item.snoozedUntil);
  if (Number.isFinite(snooze) && snooze > nowMs) return null;
  const born = _ms(item.firstSeen);
  if (!Number.isFinite(born)) return null;
  if (nowMs - born <= LAPSE_DAYS * DAY_MS) return null;
  const mention = item.lastMentionedAt || item.lastSeen;
  const activity = [mention, item.reopenedAt, item.askedAt, item.snoozedUntil, item.firstSeen, _sourceDateToIso(item.sourceDate)]
    .map(_ms).filter(Number.isFinite);
  const latest = Math.max(...activity);
  if (nowMs - latest <= LAPSE_DAYS * DAY_MS) return null;
  return { ageDays: Math.floor((nowMs - born) / DAY_MS), quietDays: Math.floor((nowMs - latest) / DAY_MS),
    lastActivity: new Date(latest).toISOString() };
}

/** Local calendar day — never toISOString(); the Pi may run in UTC. */
function _localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The nightly pass. Marks every open item `lapseVerdict` says lapses, and
 * writes ONE Activity line with the count (never the items — no names in
 * Activity). `apply: false` counts without writing.
 */
function lapseStale({ now = Date.now(), apply = true } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const at = new Date(nowMs).toISOString();
  let lapsed = 0;
  let open = 0;
  for (const item of _all()) {
    if (item.status !== 'open') continue;
    open += 1;
    if (!lapseVerdict(item, nowMs)) continue;
    lapsed += 1;
    if (!apply) continue;
    item.status = 'lapsed';
    item.resolvedAt = at;
    _upsert(item);
  }
  if (apply && lapsed > 0) {
    try {
      require('./personal-obligations').logEvent('waiting-on-lapsed', {
        detail: { count: lapsed, days: LAPSE_DAYS },
        dedupeKey: `waiting-on-lapsed:${_localDay(nowMs)}`,
        now: nowMs,
      });
    } catch { /* Activity is a record, never a reason to fail the pass */ }
    console.log(`[WaitingOn] Lapsed ${lapsed} of ${open} open item(s) — quiet for ${LAPSE_DAYS}+ days`);
  }
  return { lapsed, open, applied: apply };
}

/** Nick puts a lapsed item back. Only from lapsed — done/dropped come back by a new sighting. */
function reopen(key, { now = Date.now() } = {}) {
  const item = _get(key);
  if (!item) return { ok: false, code: 404, error: 'No such item' };
  if (item.status !== 'lapsed') return { ok: false, code: 409, error: `it is ${item.status}, not lapsed` };
  item.status = 'open';
  // A reopen is activity, so the lapse clock restarts from here.
  item.reopenedAt = new Date(now instanceof Date ? now.getTime() : now).toISOString();
  item.resolvedAt = null;
  _upsert(item);
  return { ok: true, item };
}

// ── "Looks done" — Build 5 progress evidence, shown, never applied ──────────

function _notYet() {
  try {
    const v = JSON.parse(db.getState(NOT_YET_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return null; }   // unreadable: suppress nothing, write nothing
}

/** Words for the evidence behind "Looks done". PURE. */
function looksDoneWords(evidence = []) {
  const e = evidence[0];
  if (!e) return 'something NEURO saw says it was done';
  const d = e.detail || {};
  const more = evidence.length > 1 ? ` (+${evidence.length - 1} more)` : '';
  if (e.kind === 'later-note' && d.text) {
    const where = String(d.notePath || '').startsWith('Daily/') ? 'your daily note' : 'a later meeting note';
    const day = String(e.at || '').slice(0, 10);
    const said = String(d.text).replace(/^\s*[-*+]\s*(\[[^\]]\]\s*)?/, '').slice(0, 140);
    return `${where}${day ? ` (${day})` : ''} says “${said}”${more}`;
  }
  return `${e.reason || 'something NEURO saw says it was done'}${more}`;
}

/**
 * Attach `looksDone` to open items whose world-model commitment derives as
 * `likely_fulfilled`. Reads only the commitments that HAVE strong done evidence
 * (one query), so this costs nothing on the other 500. Evidence Nick answered
 * "Not yet" to is not shown again; a NEW piece of evidence is. Never closes.
 */
function attachLooksDone(items, { deps = {} } = {}) {
  let ids;
  try {
    ids = new Set(db.all(`SELECT DISTINCT commitment_id FROM wm_progress_evidence
                          WHERE commitment_id LIKE 'commitment:waiting:%' AND polarity = 'done' AND strength = 'strong'`, [])
      .map((r) => r.commitment_id));
  } catch { return items; }   // no projection: nothing to say, which is not "not done"
  if (!ids.size) return items;
  const wo = deps.worldObligations || require('./world-obligations');
  const pe = deps.progressEvidence || require('./progress-evidence');
  const notYetStore = _notYet() || {};
  let cov;
  try { cov = pe.coverage(); } catch { cov = undefined; }
  return items.map((item) => {
    if (item.status !== 'open') return item;
    const cid = wo.waitingCommitmentId(item.key);
    if (!ids.has(cid)) return item;
    let p = null;
    try { p = pe.progressFor(cid, cov ? { cov } : undefined); } catch { p = null; }
    if (!p || p.state !== 'likely_fulfilled') return item;
    const suppressed = new Set(notYetStore[item.key] || []);
    const fresh = (p.evidenceIds || []).filter((id) => !suppressed.has(id));
    if (!fresh.length) return item;
    const ev = (p.evidence || []).filter((e) => fresh.includes(e.evidenceId));
    return { ...item, looksDone: { words: looksDoneWords(ev), evidenceIds: fresh, commitmentId: cid } };
  });
}

/**
 * "Not yet" — the evidence shown is wrong about this item. Suppresses exactly
 * those evidence ids for this item; the item stays open and a NEW piece of
 * evidence brings the question back.
 */
function notYet(key, evidenceIds = []) {
  const item = _get(key);
  if (!item) return { ok: false, code: 404, error: 'No such item' };
  const ids = (Array.isArray(evidenceIds) ? evidenceIds : []).map(String).filter(Boolean).slice(0, 50);
  if (!ids.length) return { ok: false, code: 400, error: 'evidenceIds is required — which evidence is wrong?' };
  const store = _notYet();
  if (store === null) return { ok: false, code: 503, error: 'the not-yet store could not be read; nothing written' };
  store[key] = [...new Set([...(store[key] || []), ...ids])];
  db.setState(NOT_YET_KEY, JSON.stringify(store));
  return { ok: true, key, suppressed: store[key].length };
}

/*
 * Chasing moved out of this module in Build 7 (3 Oct 2026). The Chase button
 * now PREPARES a governed chase_commitment — services/prepared-actions.js
 * prepareFromWaitingOn — approved with human proof and sent only by
 * services/action-executor.js, which records the chase here via markChased.
 * queueChase / setChaseRecipient / setChaseChannel / buildChaseMessage were the
 * legacy path (a mutable saim_actions payload and a sender with no ledger) and
 * are gone, not disabled: nothing left here can queue or send a chase.
 */

/**
 * Populate from meeting notes already on disk.
 *
 * Needed because the live path only fires for notes that are new or changed:
 * `action-candidates` skips anything whose content hash it has already
 * reviewed, so every historical note is invisible to it. Without this, the
 * feature starts empty and only learns about commitments made from today —
 * which is the least useful day to start.
 *
 * Reads only. `extractMeetingActions` records waiting-on items as a side
 * effect; the task-candidate half is not touched, so this cannot promote
 * anything into the task list or the approval queue.
 */
function backfill({ days = 120, limit = 500 } = {}) {
  const fs = require('fs');
  const path = require('path');

  const vault = process.env.OBSIDIAN_VAULT_PATH;
  if (!vault) return { scanned: 0, reason: 'no vault path' };

  const meetingsDir = path.join(vault, 'Meetings');
  if (!fs.existsSync(meetingsDir)) return { scanned: 0, reason: 'no Meetings directory' };

  const cutoff = Date.now() - days * 86400000;
  const files = [];
  const walk = (dir, depth = 0) => {
    if (depth > 4 || files.length >= limit) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (!entry.name.endsWith('.md')) continue;
      // Transcripts are raw speech — the action extractor is tuned for the
      // structured "## Next Arrangements" blocks in summaries, not for prose.
      if (full.toLowerCase().includes('transcript')) continue;
      try {
        if (fs.statSync(full).mtimeMs < cutoff) continue;
      } catch { continue; }
      files.push(full);
    }
  };
  try { walk(meetingsDir); } catch (e) {
    return { scanned: 0, reason: e.message };
  }

  const before = list({ status: 'all' }).length;
  let scanned = 0;
  const extract = require('./action-candidates').extractMeetingActions;

  for (const full of files) {
    try {
      const text = fs.readFileSync(full, 'utf-8');
      const relativePath = path.relative(vault, full).replace(/\\/g, '/');
      extract(text, relativePath);
      scanned++;
    } catch (e) {
      console.warn('[WaitingOn] Backfill skipped', full, e.message);
    }
  }

  const after = list({ status: 'all' }).length;
  console.log(`[WaitingOn] Backfill: ${scanned} note(s), ${after - before} new item(s)`);
  return { scanned, added: after - before, total: after };
}

module.exports = {
  setPersonFull,
  record, list, byPerson, resolve, snooze, markChased,
  backfill, migrateFromState, STALE_DAYS, _key,
  LAPSE_DAYS, lapseVerdict, lapseStale, reopen,
  looksDoneWords, attachLooksDone, notYet,
};
