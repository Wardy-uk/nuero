'use strict';

/**
 * The evening "nothing logged in Foodnoms today" nudge (Nick, 7 Nov 2026:
 * "yes add the evening nudge" — he had stopped logging on 20 Oct and wants a
 * prompt to start again).
 *
 * One push at 20:00 London, only when NOTHING food or drink arrived for today.
 * Switch `food_log_nudge` in Settings (default ON). Once per day, whatever
 * happens — the day's key is stored before the send, so a restart or a second
 * tick cannot send it twice.
 *
 * ⚠ ABSENCE IN NEURO IS NOT PROOF HE DIDN'T LOG. Foodnoms writes to Apple
 * Health and the phone app hands that to NEURO when iOS lets it run — measured
 * as rarely as once in 21 hours in the background. So when the phone has not
 * delivered anything for a while, the push SAYS so, rather than telling him he
 * hasn't logged when he may have.
 *
 * Everything that decides is PURE (decide); run() does the reads and the send.
 */

const TZ = process.env.NEURO_TIMEZONE || 'Europe/London';
const SENT_KEY = 'food_log_nudge_sent';
const STALE_DELIVERY_MS = 2 * 3600000;

function londonDay(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ms));
}
function londonClock(ms) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

/**
 * PURE. Should tonight's nudge go, and with what words?
 *   enabled        — the Settings switch
 *   loggedToday    — true / false / null (null = could not read: say nothing)
 *   lastDeliveryMs — when NEURO last stored anything from the phone's Health sync (null = never)
 *   sentDay        — the London day the nudge last went (or null)
 */
function decide({ enabled = true, loggedToday = null, lastDeliveryMs = null, sentDay = null, nowMs = Date.now() } = {}) {
  const today = londonDay(nowMs);
  if (!enabled) return { send: false, why: 'switched off' };
  if (sentDay === today) return { send: false, why: 'already sent today' };
  if (loggedToday === null) return { send: false, why: 'could not read today’s food log' };
  if (loggedToday) return { send: false, why: 'food logged today' };
  const stale = !Number.isFinite(lastDeliveryMs) || nowMs - lastDeliveryMs > STALE_DELIVERY_MS;
  const body = stale
    ? `Nothing from Foodnoms has reached NEURO today${Number.isFinite(lastDeliveryMs) ? ` — the phone last synced at ${londonClock(lastDeliveryMs)}, so if you’ve logged since, ignore this` : ''}. Otherwise, one entry for tea gets it going again.`
    : 'Nothing logged in Foodnoms today. One entry for tea gets it going again.';
  return { send: true, day: today, title: 'SAiM — Food log', body, stale };
}

/** True/false: did any food or drink entry for today (London) reach NEURO? null if unreadable. */
function loggedToday(nowMs = Date.now()) {
  try {
    const db = require('../db/database');
    const { parseStoredUtc } = require('./stored-time');
    const today = londonDay(nowMs);
    // A day-wide UTC window either side, then judged on the LONDON date.
    const from = new Date(nowMs - 36 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
    const rows = [
      ...db.all('SELECT recorded_at FROM nutrition_entries WHERE recorded_at >= ?', [from]),
      ...db.all("SELECT recorded_at FROM health_samples WHERE metric LIKE 'dietary_%' AND recorded_at >= ?", [from]),
    ];
    return rows.some((r) => {
      const t = parseStoredUtc(r.recorded_at);
      return Number.isFinite(t) && londonDay(t) === today;
    });
  } catch (e) {
    console.warn(`[FoodLogNudge] could not read the food log: ${e.message}`);
    return null;
  }
}

/** When NEURO last stored anything from the phone's Health sync. */
function lastDeliveryMs() {
  try {
    const db = require('../db/database');
    const { parseStoredUtc } = require('./stored-time');
    const r = db.get('SELECT MAX(created_at) AS at FROM health_samples');
    const t = r && r.at ? parseStoredUtc(r.at) : NaN;
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}

async function run({ now = Date.now(), deps = {} } = {}) {
  const db = require('../db/database');
  const flags = require('./feature-flags');
  const d = {
    enabled: () => flags.isEnabled('food_log_nudge'),
    loggedToday: () => loggedToday(now),
    lastDeliveryMs,
    sentDay: () => db.getState(SENT_KEY) || null,
    markSent: (day) => db.setState(SENT_KEY, day),
    push: (t, b, data) => require('./webpush').sendToAll(t, b, data),
    ...deps,
  };
  const v = decide({ enabled: d.enabled(), loggedToday: d.loggedToday(), lastDeliveryMs: d.lastDeliveryMs(), sentDay: d.sentDay(), nowMs: now });
  if (!v.send) return v;
  d.markSent(v.day); // before the send: a second tick or a restart must not repeat it
  await d.push(v.title, v.body, { type: 'food_log', key: `food_log:${v.day}`, url: '/?view=health' });
  console.log(`[FoodLogNudge] sent for ${v.day}${v.stale ? ' (phone sync stale)' : ''}`);
  return v;
}

module.exports = { decide, run, loggedToday, SENT_KEY, STALE_DELIVERY_MS };
