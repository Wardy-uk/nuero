'use strict';

/**
 * Resolve a NEURO exact-item deep link against the real record (15 Oct 2026).
 * Contract: shared/neuro-links.cjs. Route: GET /api/links/resolve?item=<kind>:<id>.
 *
 * ⚠ EXACT OR EXPLICIT. Each kind looks up ONE record by its own primary key and
 * answers with exactly one status:
 *   open        the record exists and is live — here it is
 *   invalid     the link is malformed (bad kind, bad id)
 *   missing     no such record
 *   stale       the record exists but is no longer live (done, superseded,
 *               dismissed, cleared, ended) — said with why, and the CURRENT
 *               record when NEURO knows it (a superseded action's newer
 *               version, the task a dropped duplicate was merged into)
 *   unreadable  NEURO could not check (store unreadable, no HA reading yet)
 * There is no fallback to a page or a list: a link that cannot show its record
 * says so. READ-ONLY — nothing is written, nothing is marked seen.
 *
 * The record returned is a SUMMARY for showing which record this is; it carries
 * no email body and no draft text.
 */

const LINKS = require('../../shared/neuro-links.cjs');
const db = require('../db/database');

const ms = (x) => { const t = Date.parse(x || ''); return Number.isFinite(t) ? t : null; };
const r = (status, extra = {}) => ({ status, ...extra });

function resolve(item, { now = Date.now() } = {}) {
  const p = LINKS.parseItem(item);
  if (!p.ok) return r('invalid', { kind: p.kind || null, why: p.why });
  const fn = RESOLVERS[p.kind];
  try {
    return { kind: p.kind, id: p.id, ...fn(p.id, now) };
  } catch (e) {
    return { kind: p.kind, id: p.id, ...r('unreadable', { why: `NEURO couldn’t read its ${p.kind} records (${e.message})` }) };
  }
}

const RESOLVERS = {
  task(id) {
    const row = db.getTaskRow(Number(id));
    if (!row) return r('missing', { why: 'NEURO has no task with this id' });
    const record = { taskId: row.id, text: row.text, status: row.status, dueDate: row.due_date || null, moscow: row.moscow || null };
    if (row.status === 'done') return r('stale', { why: 'this task is done', record });
    if (row.status === 'dropped') {
      const merged = mergedInto(row.id);
      return r('stale', { why: merged ? 'this task was merged into another' : 'this task was dropped', record, current: merged ? LINKS.linkFor('task', merged) : null });
    }
    return r('open', { record });
  },

  action(id, now) {
    const row = db.get('SELECT action_id, action_type, status, version, expires_at, created_at FROM prepared_actions WHERE action_id = ?', [id]);
    if (!row) return r('missing', { why: 'NEURO has no prepared action with this id' });
    const record = { actionId: row.action_id, actionType: row.action_type, status: row.status, version: row.version, expiresAt: row.expires_at || null };
    if (row.status === 'superseded') {
      const cur = newestVersion(row.action_id);
      return r('stale', { why: 'this action was replaced by a newer version', record, current: cur ? LINKS.linkFor('action', cur) : null });
    }
    if (['verified', 'failed', 'rejected', 'expired', 'cancelled'].includes(row.status)) return r('stale', { why: `this action is ${row.status}`, record });
    if (row.status === 'prepared' && ms(row.expires_at) != null && ms(row.expires_at) <= now) return r('stale', { why: 'this action has expired', record });
    return r('open', { record });
  },

  email(id) {
    if (/^(pmail|gmail):/.test(id)) {
      const row = db.get('SELECT id, mailbox, subject, from_name, from_email, received, triage_json FROM personal_inbox WHERE id = ?', [id]);
      if (!row) return r('missing', { why: 'this message is not in NEURO’s personal inbox (it may have left the mailbox)' });
      let t = {}; try { t = row.triage_json ? JSON.parse(row.triage_json) : {}; } catch { t = {}; }
      const record = { emailId: row.id, mailbox: row.mailbox, subject: row.subject || null, from: row.from_name || row.from_email || null, receivedAt: row.received || null };
      return t.dismissed ? r('stale', { why: 'this email was dealt with', record }) : r('open', { record });
    }
    const raw = db.getState('email_triage');
    if (raw == null) return r('unreadable', { why: 'the work inbox hasn’t been read yet' });
    const list = JSON.parse(raw);
    const e = Array.isArray(list) ? list.find((x) => x && x.id === id) : null;
    if (!e) return r('missing', { why: 'this email is not in NEURO’s inbox triage' });
    const record = { emailId: e.id, subject: e.subject || null, from: e.from || null, receivedAt: e.received || null, category: e.aiCategory || null };
    if (e.dismissed) return r('stale', { why: e.dismissReason === 'left-inbox' ? 'this email has left the inbox' : 'this email was dealt with', record });
    return r('open', { record });
  },

  hazard(id) {
    const states = require('./ha').cachedStates();
    if (!states) return r('unreadable', { why: 'NEURO has no Home Assistant reading yet' });
    const s = states.find((x) => x && x.entity_id === id);
    if (!s) return r('missing', { why: 'Home Assistant has no sensor with this id' });
    const cls = (s.attributes || {}).device_class;
    if (!require('./home').HAZARD_CLASSES.has(cls)) return r('missing', { why: 'this sensor is not a household hazard sensor' });
    const record = { entityId: s.entity_id, name: (s.attributes || {}).friendly_name || null, deviceClass: cls, state: s.state, since: s.last_changed || null };
    if (s.state === 'off') return r('stale', { why: 'this hazard has cleared', record });
    return r('open', { record }); // 'on' = reporting; 'unavailable' / 'unknown' = the sensor can't be reached — itself the record
  },

  'meeting-prep'(id, now) {
    const row = db.get('SELECT event_id, subject, start_time, end_time, attendees_other FROM calendar_cache WHERE event_id = ?', [id]);
    if (!row) return r('missing', { why: 'this meeting is not in NEURO’s diary' });
    const record = { eventId: row.event_id, subject: row.subject || null, start: row.start_time || null, end: row.end_time || null };
    if (row.attendees_other === 0) return r('missing', { why: 'this diary entry has no other people in it, so it has no meeting prep', record });
    const end = localMs(row.end_time);
    if (end != null && end <= now) return r('stale', { why: 'this meeting has ended', record });
    const start = localMs(row.start_time);
    // Meeting prep is built for the coming week (routes/meeting-prep-view); further out it can't open, so say so.
    if (start != null && start > now + 7 * 86400000) return r('missing', { why: 'NEURO builds meeting prep for the coming week; this meeting is further out', record });
    return r('open', { record });
  },
};

/** calendar_cache times are wall clock in the backend's zone; read them as local. */
function localMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s || ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : null;
}

function mergedInto(taskId) {
  try {
    const raw = db.getState('task_internal_merges');
    const m = raw ? JSON.parse(raw) : {};
    const rec = m && m[String(taskId)];
    return rec && Number.isInteger(rec.keptId) ? rec.keptId : null;
  } catch { return null; }
}

/** Follow parent_action_id forward to the newest version; null if none is recorded. */
function newestVersion(actionId) {
  let cur = actionId;
  for (let i = 0; i < 20; i += 1) {
    const next = db.get('SELECT action_id FROM prepared_actions WHERE parent_action_id = ? ORDER BY version DESC LIMIT 1', [cur]);
    if (!next) break;
    cur = next.action_id;
  }
  return cur === actionId ? null : cur;
}

module.exports = { resolve };
