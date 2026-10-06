'use strict';

/**
 * Is a meeting-derived commitment still CURRENT? (Build 15P/Q, 6 Oct 2026)
 *
 * commitment-risk's meeting trigger fires on a commitment taken from the most
 * recent WRITTEN-UP occurrence of a meeting whose next occurrence is near. That
 * rule had no age bound, and Build 14 found the consequence: 22 findings, all
 * from the 21 Sep Team Standup, raised again and again because no later
 * standup had been written up and linked. Measured on the live calendar
 * (6 Oct): the standup was HELD on 10 weekdays between 21 Sep and 5 Oct with no
 * write-up — so "the last one written up" was two weeks and ten meetings old.
 *
 * ── The rule (evidence, not a day count) ───────────────────────────────────
 * The age is measured in OCCURRENCES OF THAT SERIES, read from the calendar,
 * not in days — a daily standup and a fortnightly 1-2-1 age at their own pace,
 * which is what "derive it from the cadence" means. A commitment is current
 * when at most MAX_UNWRITTEN_OCCURRENCES held occurrences sit between its
 * meeting and now (one: a write-up that lands a day late must not break the
 * chain). Beyond that it is risk-producing only on NEWER evidence:
 *
 *   carried-forward    a daily-note standup carried its task since the most
 *                      recent held occurrence, or progress was recorded since
 *   superseded         a newer occurrence restated the same commitment — the
 *                      newer one carries the risk itself
 *   orphaned           a newer occurrence WAS written up, but its write-up did
 *                      not link to the calendar — not raised on the old one
 *   no-newer-evidence  nothing since — history, not tomorrow's agenda
 *   unknown            the calendar could not be read — not raised
 *
 * Nothing here completes, closes or changes a commitment. Unknown stays
 * unknown; a commitment that is not risk-producing is still OPEN.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db/database');

const MAX_UNWRITTEN_OCCURRENCES = 1;
const MAX_CARRY_SCAN_DAYS = 31;

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * PURE. @param {{ sourceStart, held, carried, progressSince, restatedBy, orphanDays, calendarReadable }} i
 *   held           starts of HELD occurrences of the series after the source, before now
 *   carried        YYYY-MM-DD dates a daily note carried the linked task
 *   progressSince  ISO times of recorded progress on the commitment
 *   restatedBy     [{ commitmentId, start }] newer open commitments with the same wording key
 *   orphanDays     YYYY-MM-DD of held occurrences whose write-up exists but did not link
 */
function assess({ sourceStart, held = [], carried = [], progressSince = [], restatedBy = [], orphanDays = [], calendarReadable = true }) {
  const intervening = held.length;
  const newest = held.length ? [...held].sort().pop() : null;
  const base = { intervening, maxUnwritten: MAX_UNWRITTEN_OCCURRENCES, newestHeldOccurrence: newest, sourceStart };
  if (!calendarReadable) return { ...base, state: 'unknown', riskProducing: false, why: 'the calendar history could not be read, so whether newer meetings happened is unknown — not raised' };
  if (restatedBy.length) {
    return { ...base, state: 'superseded', riskProducing: false, restatedBy,
      why: `restated at a newer meeting (${restatedBy[0].start.slice(0, 10)}) — that sighting carries it now` };
  }
  if (intervening <= MAX_UNWRITTEN_OCCURRENCES) return { ...base, state: 'current', riskProducing: true, why: null };
  const since = newest ? newest.slice(0, 10) : sourceStart.slice(0, 10);
  const carriedSince = carried.filter((d) => d >= since).sort();
  if (carriedSince.length) {
    return { ...base, state: 'carried-forward', riskProducing: true, carriedOn: carriedSince,
      why: null, basis: `carried forward in the daily note on ${carriedSince[carriedSince.length - 1]}` };
  }
  const progressed = progressSince.filter((t) => String(t).slice(0, 10) >= since).sort();
  if (progressed.length) {
    return { ...base, state: 'carried-forward', riskProducing: true, progressOn: progressed,
      why: null, basis: `progress recorded on ${progressed[progressed.length - 1].slice(0, 10)}` };
  }
  if (orphanDays.length) {
    return { ...base, state: 'orphaned', riskProducing: false, orphanDays,
      why: `a meeting write-up from ${orphanDays[orphanDays.length - 1]}, when a newer occurrence was held, could not be linked to the calendar — it may be this meeting's, so the older one is not raised` };
  }
  return { ...base, state: 'no-newer-evidence', riskProducing: false,
    why: `${intervening} newer occurrence${intervening === 1 ? '' : 's'} held since it was taken on with no write-up, carry-forward or progress — history, not the next meeting's agenda` };
}

// ── readers (real stores) ───────────────────────────────────────────────────

/** Held occurrences of a series strictly between two local times. Newest slot per occurrence; cancelled never counts. */
function heldBetween(seriesKey, afterLocal, beforeLocal) {
  const key = norm(seriesKey);
  const rows = db.all(`SELECT event_id, start_time, subject, show_as, first_seen FROM calendar_history
                        WHERE attendees_other = 1 AND is_all_day = 0 AND substr(start_time, 1, 16) > ? AND substr(start_time, 1, 16) < ?`,
  [String(afterLocal).slice(0, 16), String(beforeLocal).slice(0, 16)]);
  const newest = new Map();
  for (const o of rows) {
    if (norm(o.subject) !== key) continue;
    const cur = newest.get(o.event_id);
    if (!cur || String(o.first_seen || '') > String(cur.first_seen || '')) newest.set(o.event_id, o);
  }
  return [...newest.values()].filter((o) => o.show_as !== 'cancelled').map((o) => String(o.start_time).slice(0, 16)).sort();
}

function _neuroTaskId(c) {
  if (!c.relatedTaskId) return null;
  try {
    const t = require('./world-obligations').getTask(c.relatedTaskId);
    const s = t && t.sources.find((x) => x.system === 'neuro');
    return s ? Number(s.recordId) : null;
  } catch { return null; }
}

function _addDays(day, n) {
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) + n * 86400000);
  return d.toISOString().slice(0, 10);
}

/** Daily-note dates (since `fromDay`) whose standup lines carry `<!--task:N-->`. Bounded. */
function carriedDays(taskId, fromDay, today, { vaultRoot = process.env.OBSIDIAN_VAULT_PATH } = {}) {
  if (!taskId || !vaultRoot) return [];
  const out = [];
  let day = fromDay;
  for (let i = 0; i < MAX_CARRY_SCAN_DAYS && day <= today; i += 1, day = _addDays(day, 1)) {
    try {
      const text = fs.readFileSync(path.join(vaultRoot, 'Daily', `${day}.md`), 'utf8');
      if (text.includes(`<!--task:${taskId}-->`)) out.push(day);
    } catch { /* no note that day */ }
  }
  return out;
}

function restatedLater(c) {
  const wo = require('./world-obligations');
  const mine = wo.titleKey(c.description);
  const src = c.meeting && c.meeting.occurrence ? c.meeting.occurrence.start : null;
  if (!src) return [];
  return db.all(`SELECT commitment_id, description, meeting_json FROM wm_commitments
                  WHERE meeting_series_key = ? AND status = 'open' AND meeting_id IS NOT NULL AND commitment_id != ?`,
  [c.meetingSeriesKey, c.commitmentId])
    .map((r) => { let m = null; try { m = JSON.parse(r.meeting_json); } catch { m = null; } return { r, start: m && m.occurrence ? m.occurrence.start : null }; })
    .filter((x) => x.start && x.start > src && wo.titleKey(x.r.description) === mine)
    .map((x) => ({ commitmentId: x.r.commitment_id, start: x.start }));
}

function orphanDays(days) {
  if (!days.length) return [];
  const rows = db.all(`SELECT DISTINCT source_date FROM wm_commitments
                        WHERE meeting_id IS NULL AND source_kind LIKE 'meeting%' AND source_date IN (${days.map(() => '?').join(',')})`, days);
  return rows.map((r) => r.source_date).sort();
}

/** The full read for one commitment. Never throws; an unreadable calendar is `unknown`. */
function currencyFor(c, { nowLocal, progressTimes = [] } = {}) {
  const sourceStart = c.meeting && c.meeting.occurrence ? c.meeting.occurrence.start : null;
  if (!sourceStart || !c.meetingSeriesKey) return assess({ sourceStart: sourceStart || nowLocal, calendarReadable: false });
  let held;
  try { held = heldBetween(c.meetingSeriesKey, sourceStart, nowLocal); } catch { return assess({ sourceStart, calendarReadable: false }); }
  if (held.length <= MAX_UNWRITTEN_OCCURRENCES) return assess({ sourceStart, held });
  const newestDay = held[held.length - 1].slice(0, 10);
  let carried = []; let restated = []; let orphans = [];
  try { carried = carriedDays(_neuroTaskId(c), newestDay, nowLocal.slice(0, 10)); } catch { carried = []; }
  try { restated = restatedLater(c); } catch { restated = []; }
  try { orphans = orphanDays([...new Set(held.map((h) => h.slice(0, 10)))]); } catch { orphans = []; }
  let progress = progressTimes;
  if (!progress.length) {
    // Progress or a newer "still outstanding" (current rules only) is evidence
    // it is still live. A `done` row is NOT — that is progress-evidence's call.
    try {
      progress = require('./progress-evidence').evidenceFor(c.commitmentId)
        .filter((e) => e.polarity === 'progress' || e.polarity === 'not-done').map((e) => e.at).filter(Boolean);
    } catch { progress = []; }
  }
  return assess({ sourceStart, held, carried, progressSince: progress, restatedBy: restated, orphanDays: orphans });
}

module.exports = { MAX_UNWRITTEN_OCCURRENCES, assess, heldBetween, carriedDays, restatedLater, currencyFor };
