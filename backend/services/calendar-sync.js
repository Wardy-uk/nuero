'use strict';

/**
 * Calendar sync — fill the cache nothing was filling.
 *
 * `db.upsertCalendarEvent` has existed, been exported, and been called by
 * absolutely nothing. `calendar_cache` has therefore always been empty, and
 * every feature reading it has been quietly dark:
 *
 *   - working-memory sets ctx.calendar from the cache, so it was always []
 *   - decision-engine.collectMeetings() never produced an item, so a meeting
 *     has never appeared in Focus
 *   - briefing.checkMeetingAlerts() reads the same context, so the "starting in
 *     10 minutes" push has never fired once
 *   - the chat get_calendar tool and the ADHD dashboard both returned nothing
 *
 * It went unnoticed because the calendar VIEWS call Graph live — the screens
 * looked right while everything that reasons about the calendar was blind.
 *
 * Sync is replace-by-window rather than merge: a meeting that gets cancelled or
 * moved must disappear, and diffing for deletions against Graph is more work
 * than simply rewriting the window.
 */

const crypto = require('crypto');
const db = require('../db/database');

// Source-health identity for this path (Build 1, the nervous system). The
// cadence is the scheduler's every-20-minutes; three missed runs is stale.
const SOURCE_ID = 'microsoft.calendar';
const EXPECTED_INTERVAL_MS = 20 * 60 * 1000;
const STALE_AFTER_MS = 60 * 60 * 1000;

function _beginRun() {
  try {
    return require('./source-health').beginSourceRun(SOURCE_ID, {
      system: 'microsoft-graph', expectedIntervalMs: EXPECTED_INTERVAL_MS, staleAfterMs: STALE_AFTER_MS,
    });
  } catch (e) {
    // The event layer is additive: if it cannot even start, the sync runs as it
    // always did, unobserved.
    console.warn('[CalendarSync] source-health unavailable:', e.message);
    const noop = () => null;
    return { succeed: noop, fail: noop, publish: noop };
  }
}

/**
 * What the window looked like, reduced to a hash. The domain event is keyed on
 * it, so an unchanged diary re-observed every 20 minutes folds into the event
 * already in the log: the log records change, not polling.
 */
function _fingerprint(events) {
  const lines = events
    .filter(e => e && e.id && e.start)
    .map(e => [e.id, e.start, e.end || '', e.subject || '', e.showAs || '', e.isAllDay ? 1 : 0,
      e.attendeesOther === undefined ? '?' : (e.attendeesOther ? 1 : 0)].join('|'))
    .sort();
  return crypto.createHash('sha256').update(lines.join(String.fromCharCode(10))).digest('hex');
}

function _dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Pull the next `days` of calendar into the cache.
 * Returns { synced, from, to } or { synced: 0, reason } when unavailable.
 */
async function sync({ days = 14, checkArrivals = true } = {}) {
  const microsoft = require('./microsoft');

  const now = new Date();
  const from = _dateStr(now);
  const to = _dateStr(new Date(now.getTime() + days * 86400000));
  const run = _beginRun();

  let events;
  try {
    events = await microsoft.fetchCalendarEvents(from, to);
  } catch (e) {
    console.warn('[CalendarSync] Fetch failed:', e.message);
    run.fail(e, { reason: 'fetch-threw' });
    return { synced: 0, reason: e.message };
  }

  if (!Array.isArray(events)) {
    run.fail('no events returned', { reason: 'no-events' });
    return { synced: 0, reason: 'no events returned' };
  }

  // Nothing back from Graph is ambiguous — an empty diary and a broken auth look
  // identical. Leave the existing cache alone rather than wiping a good one on a
  // transient failure; a stale calendar beats an empty one.
  if (events.length === 0) {
    console.log('[CalendarSync] Graph returned no events — leaving the cache as it is');
    // ⚠ Recorded as a FAILURE, flagged ambiguous. The cache was not refreshed,
    // so this run must not renew the source's freshness — and "an empty
    // fortnight" and "broken auth" are indistinguishable from here.
    run.fail('Graph returned no events', { reason: 'empty-response', ambiguous: true });
    return { synced: 0, from, to, reason: 'empty response' };
  }

  // Which ids we already knew about, so the caller can act on just the new
  // ones. Checking every event on every pass would mean a Graph detail fetch
  // per meeting per cycle — the arrival of an invite is the interesting moment,
  // not its continued existence.
  let known = new Set();
  try {
    known = new Set(
      db.getCalendarEvents(from, to).map(e => e.event_id).filter(Boolean)
    );
  } catch {}

  // Does each event have OTHER PEOPLE in it? The cache dropped `attendees` on
  // write, so everything reasoning off it — the ambient SAiM surface most of all
  // — could not tell a 1-2-1 from a solo focus block, and half Nick's diary is
  // solo blocks. Judged here, once, at the only point a live attendee list
  // exists, using plaud-admin-blocks' test rather than a second copy of it.
  //
  // ⚠ Fails CLOSED to UNKNOWN, not to false. With no signed-in address Nick's
  // own entry cannot be told from anyone else's, and the NOVA bridge supplies no
  // attendee list at all — in both cases we do not know, and saying "solo block"
  // would be a confident wrong answer rather than an absent one.
  let me = null;
  try { me = await microsoft.getSignedInAddress(); } catch {}
  const { attendeesOther } = require('./plaud-admin-blocks');
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    event.attendeesOther = (me && Array.isArray(event.attendees))
      ? attendeesOther(event, me).length > 0
      : undefined;
  }
  if (!me) console.warn('[CalendarSync] No signed-in address — attendee judgement left unknown on every event');

  let synced = 0;
  const newEventIds = [];
  try {
    db.batchSaves(() => {
      // ⚠ KEEP WHAT THE CACHE IS ABOUT TO FORGET. This table is a ROLLING
      //   WINDOW, so an event drops out a few weeks after it happens and is
      //   gone — measured 13 Sep 2026: 105 events, 29 Aug to 25 Sep, and nothing
      //   older anywhere. That made every question about the SHAPE of his weeks
      //   unanswerable (when his day really starts, which meetings actually
      //   happen, how often the 10am slips), and NONE of it is recoverable
      //   retrospectively.
      //
      //   Archived BEFORE the clear, because after it the departing rows are
      //   already gone. Append-only and idempotent, so running it on every pass
      //   costs a fold rather than a duplicate.
      //
      // ⚠ Never allowed to fail the sync: keeping history is worth less than
      //   having a current calendar, and this runs every few minutes.
      try {
        const n = db.archiveCalendarEvents(db.getAllCalendarEvents());
        if (n) console.log(`[CalendarSync] archived ${n} new occurrence(s) to history`);
      } catch (e) {
        console.warn('[CalendarSync] could not archive history:', e.message);
      }

      // Graph rows ONLY. This is replace-by-window across the whole table, and
      // scoping it is what stops a Graph sync — which runs every few minutes —
      // from deleting every Apple event a few minutes after the phone pushed it.
      db.clearCalendarCache('graph');
      for (const event of events) {
        if (!event?.id || !event.start) continue;
        db.upsertCalendarEvent(event);
        if (!known.has(event.id)) newEventIds.push(event.id);
        synced++;
      }
    });
  } catch (e) {
    console.error('[CalendarSync] Write failed:', e.message);
    run.fail(e, { reason: 'write-failed' });
    return { synced: 0, reason: e.message };
  }

  try { require('./working-memory').invalidate('calendar synced'); } catch {}

  // The cache write has committed: that is what success means for this source.
  // Recorded here, before the Plaud and triage hooks, because those are other
  // features hanging off a fresh calendar, not part of ingesting it.
  run.publish({
    type: 'observation.calendar.window_synced',
    occurredAt: now.toISOString(),
    subject: { entityType: 'person', entityId: 'nick' },
    idempotencyKey: `graph-calendar-window:${from}:${to}:${_fingerprint(events)}`,
    payload: { window: { from, to }, count: synced, fingerprint: _fingerprint(events) },
  });
  run.succeed({
    synced, from, to,
    // Agrees with what this function RETURNS: a cold start reports no
    // arrivals (below), so its event must not claim any either.
    newCount: known.size === 0 ? 0 : newEventIds.length,
    coldStart: known.size === 0,
  });

  // The 5-minute Plaud write-up block after every meeting Nick created or
  // accepted. Hooked here rather than on its own cron for the same reason the
  // 1-2-1 tracker hangs off syncPeopleNotes: this is the one place a fresh view
  // of the calendar exists, so a block can never be placed around a meeting
  // that has already moved.
  //
  // Deliberately ABOVE the cold-start return and deliberately NOT gated on
  // `newEventIds`. Both would be wrong: accepting an invite that arrived
  // yesterday is the central case and that event is not new, and a cold cache
  // (a restored DB) is not a reason to stop writing up meetings. Repeats are
  // held off by the service's own ledger, not by arrival detection.
  //
  // Gated on PLAUD_ADMIN_BLOCKS_ENABLED and never allowed to fail the sync.
  try {
    await require('./plaud-admin-blocks').syncHook(events);
  } catch (e) {
    console.warn('[CalendarSync] Plaud admin blocks failed:', e.message);
  }


  // First run has no history, so everything looks new. Reporting 50 "new"
  // meetings would queue a chaser for each — treat a cold cache as a baseline.
  const coldStart = known.size === 0;
  if (coldStart && newEventIds.length) {
    console.log(`[CalendarSync] ${synced} event(s) cached (cold start — treated as baseline, no arrivals reported)`);
    return { synced, from, to, newEventIds: [], coldStart: true };
  }

  console.log(`[CalendarSync] ${synced} event(s) cached for ${from} → ${to}${newEventIds.length ? `, ${newEventIds.length} new` : ''}`);

  // A new invite is the moment worth acting on — check it now rather than
  // waiting for the daily sweep, so the ask reaches the organiser while they
  // are still thinking about the meeting they just sent.
  if (newEventIds.length && checkArrivals) {
    try {
      await require('./meeting-triage').checkEvents(newEventIds);
    } catch (e) {
      console.warn('[CalendarSync] Agenda check on arrivals failed:', e.message);
    }
  }

  return { synced, from, to, newEventIds, coldStart: false };
}

module.exports = { sync };
