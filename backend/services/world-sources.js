'use strict';

/**
 * The world model's PRODUCERS (Build 3C). They publish observations; the
 * `world-model` projector folds them. Nothing here writes a wm_* table.
 *
 *   publishCalendarWindow()  called by calendar-sync (Graph) and apple-ingest
 *                            (the phone) after their cache write commits
 *   publishPeople()          the People notes, on a durable hourly job
 *
 * ⚠ NEVER THROWS. Both calendar paths are ingestion paths whose own behaviour
 * must not change because the world model failed — the same contract as
 * source-health.beginSourceRun.
 *
 * Change, not polling: an unchanged meeting or note re-observed every pass
 * publishes nothing. ⚠ Build 5B: keys name the TRANSITION (change-key.js). The
 * Build 3 keys named the STATE (`<id>:<fingerprint>`), so a meeting moved and
 * moved back folded the move back into its first event and the projection was
 * left showing the slot it had left.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const bus = require('./event-bus');
const wm = require('./world-model');
const ck = require('./change-key');

const CAL_TYPES = ['observation.calendar.event_observed', 'observation.calendar.event_removed'];
const CAL_REMOVED = ['observation.calendar.event_removed'];

function _safe(input, opts) {
  try { return bus.publishEvent(input, opts); } catch (e) {
    console.warn(`[WorldSources] could not publish ${input && input.type}: ${e.message}`);
    return null;
  }
}

const minuteOf = (s) => String(s || '').slice(0, 16);

// ── calendar ────────────────────────────────────────────────────────────────

/**
 * The observation payload for one calendar entry. PURE. Only fields the world
 * model uses; never the body or a join link (links carry tokens).
 */
function calendarPayload(provider, e) {
  const body = {
    provider,
    providerEventId: String(e.id),
    seriesId: e.seriesMasterId || null,
    type: e.type || null,
    title: String(e.subject || '(no subject)').slice(0, 300),
    start: minuteOf(e.start),
    end: minuteOf(e.end || e.start),
    isAllDay: e.isAllDay === true,
    showAs: e.showAs || null,
    isCancelled: e.showAs === 'cancelled' || e.isCancelled === true,
    responseStatus: e.responseStatus || null,
    isOrganizer: typeof e.isOrganizer === 'boolean' ? e.isOrganizer : null,
    organizer: e.organizerEmail || e.organizer ? { name: e.organizer || null, email: e.organizerEmail || null } : null,
    attendees: Array.isArray(e.attendees)
      ? e.attendees.slice(0, 200).map((a) => ({ name: a.name || null, email: a.email || null, status: a.status || null }))
      : null,
    // Three-valued, carried exactly as the source judged it.
    attendeesOther: typeof e.attendeesOther === 'boolean' ? e.attendeesOther : null,
    locationLabel: e.location ? String(e.location).slice(0, 120) : null,
  };
  return { ...body, fingerprint: wm.fingerprintOf(body) };
}

/**
 * Publish what one source's sync window showed, and what it stopped showing.
 *
 *   provider   'graph' | 'apple'
 *   events     the entries as that source delivered them (already filtered)
 *   window     { fromLocal, toLocal } wall-clock minutes the sync covered —
 *              only meetings starting inside it can be judged removed
 *   correlationId  optional — the source run these observations belong to
 *
 * Returns { observed, changed, removed } — or { error } — never throws.
 */
function publishCalendarWindow({ provider, events, window, correlationId = null, now = Date.now() } = {}) {
  try {
    const nowMs = now instanceof Date ? now.getTime() : now;
    const send = (input) => _safe(correlationId ? { ...input, correlationId } : input, { now: nowMs });
    const occurredAt = new Date(nowMs).toISOString();
    let changed = 0;
    const seen = new Set();
    for (const e of Array.isArray(events) ? events : []) {
      if (!e || !e.id || !e.start) continue;
      const payload = calendarPayload(provider, e);
      seen.add(payload.providerEventId);
      const subjectId = `${provider}:${payload.providerEventId}`.slice(0, 256);
      const held = ck.latest('calendar-entry', subjectId, CAL_TYPES, CAL_REMOVED);
      if (ck.isUnchanged(held, payload.fingerprint)) continue;
      const r = send({
        type: 'observation.calendar.event_observed',
        occurredAt,
        source: { system: provider === 'graph' ? 'microsoft-graph' : 'eventkit', recordId: payload.providerEventId },
        subject: { entityType: 'calendar-entry', entityId: subjectId },
        idempotencyKey: ck.observationKey(`cal-event:${provider}`, payload.providerEventId, held, payload.fingerprint),
        payload,
      });
      if (r && !r.duplicate) changed += 1;
    }

    // Removals: what the projection holds from this provider, starting inside
    // the window, that this window no longer showed.
    let removed = 0;
    if (window && window.fromLocal && window.toLocal) {
      const held = db.all(
        `SELECT s.provider_event_id AS id, m.fingerprint AS fp, m.meeting_id AS mid, s.role AS role
           FROM wm_meeting_sources s JOIN wm_meetings m ON m.meeting_id = s.meeting_id
          WHERE s.provider = ? AND m.status IN ('scheduled', 'cancelled')
            AND m.start_local >= ? AND m.start_local <= ?`,
        [provider, window.fromLocal, window.toLocal]
      );
      for (const h of held) {
        if (seen.has(h.id)) continue;
        const subjectId = `${provider}:${h.id}`.slice(0, 256);
        const last = ck.latest('calendar-entry', subjectId, CAL_TYPES, CAL_REMOVED);
        if (last && last.removed) continue; // already said: one removal per presence
        const r = send({
          type: 'observation.calendar.event_removed',
          occurredAt,
          source: { system: provider === 'graph' ? 'microsoft-graph' : 'eventkit', recordId: h.id },
          subject: { entityType: 'calendar-entry', entityId: subjectId },
          // Keyed on the observation that made it present. The fingerprint it
          // carries is what the projector checks, so a removal of a version
          // since replaced still changes nothing.
          idempotencyKey: ck.removalKey(`cal-removed:${provider}`, h.id, last),
          payload: { provider, providerEventId: h.id, lastFingerprint: (last && last.fingerprint) || h.fp || 'none', role: h.role, window },
        });
        if (r && !r.duplicate) removed += 1;
      }
    }
    return { observed: seen.size, changed, removed };
  } catch (e) {
    console.warn(`[WorldSources] calendar window (${provider}) not recorded: ${e.message}`);
    return { error: e.message };
  }
}

// ── people ──────────────────────────────────────────────────────────────────

/**
 * Read a People note's frontmatter. PURE. Scalars as strings, plus the block
 * lists this builder needs (`aliases:`, `emails:`). Deliberately NOT
 * obsidian.parseFrontmatter, which returns "" for a YAML block list — the bug
 * that once made every alias in the vault invisible.
 */
function parseFrontmatter(text) {
  const out = {};
  const norm = String(text || '').split(String.fromCharCode(13)).join('');
  if (!norm.startsWith('---')) return out;
  const end = norm.indexOf('\n---', 3);
  if (end < 0) return out;
  const lines = norm.slice(4, end).split('\n');
  let listKey = null;
  for (const raw of lines) {
    const item = raw.match(/^\s+-\s+(.*)$/);
    if (item && listKey) { out[listKey].push(item[1].trim().replace(/^["']|["']$/g, '')); continue; }
    const kv = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) { listKey = null; continue; }
    const [, key, value] = kv;
    if (value === '') { out[key] = []; listKey = key; continue; }
    listKey = null;
    out[key] = value.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** A wikilink `[[People/Nick Ward|Nick Ward]]` → "Nick Ward". */
function linkText(v) {
  const m = String(v || '').match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
  if (!m) return v ? String(v) : null;
  return (m[2] || m[1].split('/').pop()).trim();
}

/**
 * The declared payload for one People note. PURE. Only what the note states:
 * an unstated relationship stays absent, never guessed.
 */
function personPayload(name, notePath, fm) {
  const emails = [];
  for (const v of [fm.email, ...(Array.isArray(fm.emails) ? fm.emails : [])]) {
    if (typeof v === 'string' && v.includes('@')) emails.push(v.trim().toLowerCase());
  }
  const dr = String(fm['direct-report'] || '').toLowerCase();
  const body = {
    personId: `person:${slug(name)}`,
    displayName: name,
    notePath,
    emails: [...new Set(emails)].sort(),
    aliases: Array.isArray(fm.aliases) ? fm.aliases.filter(Boolean) : [],
    role: typeof fm.role === 'string' && fm.role ? fm.role : null,
    team: typeof fm.team === 'string' && fm.team ? fm.team : null,
    directReport: dr === 'true' ? true : dr === 'false' ? false : null,
    manager: typeof fm.manager === 'string' && fm.manager ? linkText(fm.manager) : null,
    status: typeof fm.status === 'string' && fm.status ? fm.status : null,
  };
  return { ...body, fingerprint: wm.fingerprintOf(body) };
}

/**
 * Publish every People note. Returns { notes, changed } or { error } with the
 * reason — an unreadable vault publishes NOTHING (never a world in which
 * everybody has vanished).
 */
function publishPeople({ vaultRoot = process.env.OBSIDIAN_VAULT_PATH, now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!vaultRoot) return { error: 'OBSIDIAN_VAULT_PATH is not set' };
  const dir = path.join(vaultRoot, 'People');
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_')); } catch (e) {
    return { error: `People folder unreadable: ${e.message}` };
  }
  let changed = 0;
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    const fm = parseFrontmatter(text);
    if (fm.type && fm.type !== 'person') continue;
    const payload = personPayload(f.slice(0, -3), `People/${f}`, fm);
    const held = ck.latest('person', payload.personId, ['observation.person.declared']);
    if (ck.isUnchanged(held, payload.fingerprint)) continue;
    const r = _safe({
      type: 'observation.person.declared',
      occurredAt: new Date(nowMs).toISOString(),
      source: { system: 'vault', recordId: payload.notePath },
      subject: { entityType: 'person', entityId: payload.personId },
      // ⚠ A transition key: an address added and later removed again is two
      // facts, and the second must not fold into the note's first declaration.
      idempotencyKey: ck.observationKey('person-declared', payload.personId, held, payload.fingerprint),
      payload,
    }, { now: nowMs });
    if (r && !r.duplicate) changed += 1;
  }
  return { notes: files.length, changed };
}

module.exports = { calendarPayload, publishCalendarWindow, parseFrontmatter, personPayload, publishPeople, linkText };
