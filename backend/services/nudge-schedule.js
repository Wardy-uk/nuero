'use strict';

/**
 * WHEN the rituals fire, as data a client can act on.
 *
 * ⚠ WHY THIS EXISTS. A phone on a personal team cannot receive APNs, so the
 * native app has no push at all — it polled `/api/nudges` when it happened to
 * be awake and posted what it found. `BGAppRefreshTask` ran ONCE in two days
 * against 51 requests, measured off the device, so in practice a closed app
 * nudged Nick approximately never. For an ADHD tool that is not a missing
 * nicety; the prompt arriving at the right time IS the product.
 *
 * A LOCAL notification scheduled in advance does not need the app to be awake,
 * does not need the network, and does not need the Pi to be up. It is the only
 * mechanism on iOS that survives all three, and it is free.
 *
 * ⚠ THE TIMES ARE DECLARED HERE, NOT COPIED INTO THE PHONE. `standup_nudge_hour`
 * is adjustable at runtime — `activity.js` moves it when Nick's actual start
 * time drifts — so a second copy of "9am" compiled into an app would silently
 * disagree with the server the first time it moved. The client asks; the server
 * answers.
 *
 * ⚠ AND WHAT IT SENDS IS A DOORBELL, NOT A CLAIM. A notification scheduled at
 * 08:00 for 20:00 can only say what was true at 08:00 — so the wording it
 * carries must be about the RITUAL ("End of day"), never about the state
 * ("3 things need you"). Tapping it opens SARA, which then reads the composed
 * line for real. Anything else is a confident sentence about a world that moved
 * on, which is the failure this codebase refuses everywhere else.
 */

const db = require('../db/database');

/** Mon–Fri, in the ISO sense the clients use (1 = Monday). */
const WEEKDAYS = [1, 2, 3, 4, 5];

function journalTime() {
  // ⚠ CONFIGURABLE, like the standup hour — `journal_nudge_time` is an
  // "HH:MM" state and defaults to 21:00. A time compiled into the app would
  // disagree the first time he moved it.
  const raw = db.getState('journal_nudge_time') || '21:00';
  const [h, m] = String(raw).split(':').map(n => parseInt(n, 10));
  const hour = Number.isInteger(h) && h >= 0 && h <= 23 ? h : 21;
  const minute = Number.isInteger(m) && m >= 0 && m <= 59 ? m : 0;
  return { hour, minute };
}

function standupHour() {
  // ⚠ Falls back to 9 rather than throwing: an unset state is the default
  // start, not a broken schedule.
  const raw = db.getState('standup_nudge_hour');
  const hour = parseInt(raw || '9', 10);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 9;
}

/**
 * The rituals a client should ring itself, with the times the server uses.
 *
 * ⚠ ONLY THE FIXED-TIME ONES. A nudge that fires BECAUSE something became
 * urgent cannot be pre-scheduled — nobody knows when it will be true — and
 * pretending otherwise would put a prompt on his phone for a thing that is not
 * happening. Those still need a live surface, which is what the PWA's web push
 * is for.
 */
function ritualSchedule() {
  const hour = standupHour();
  const journal = journalTime();
  return [
    {
      key: 'standup',
      // His words for it, not the slug.
      title: 'Standup',
      // ⚠ NO STATE IN THE BODY. See the header.
      body: 'SARA is ready when you are.',
      hour,
      minute: 0,
      weekdays: WEEKDAYS,
      tab: 'surface',
    },
    {
      key: 'eod',
      title: 'End of day',
      body: 'Time to close the day off.',
      hour: 20,
      minute: 0,
      weekdays: null, // every day
      tab: 'surface',
    },
    {
      key: 'todo',
      title: 'Today',
      body: 'Your list is ready.',
      hour,
      minute: 0,
      weekdays: WEEKDAYS,
      tab: 'surface',
    },
    {
      key: 'plan-milestone',
      title: 'The plan',
      body: 'A milestone wants a look.',
      hour: 9,
      minute: 5,
      weekdays: WEEKDAYS,
      tab: 'surface',
    },
    {
      key: '121',
      title: 'One to ones',
      body: 'Worth a check before the day fills.',
      hour: 9,
      minute: 10,
      weekdays: WEEKDAYS,
      tab: 'surface',
    },
    {
      key: 'journal',
      title: 'Journal',
      body: 'A few lines, if you have them.',
      hour: journal.hour,
      minute: journal.minute,
      weekdays: null,
      tab: 'surface',
    },
    {
      key: 'eod-retry',
      title: 'End of day',
      // ⚠ Named as the second ask, because an identical repeat an hour later
      // reads as a bug rather than as a nudge.
      body: 'Still open, if you want it.',
      hour: 21,
      minute: 0,
      weekdays: null,
      tab: 'surface',
    },
  ];
}

module.exports = { ritualSchedule, standupHour, WEEKDAYS };
