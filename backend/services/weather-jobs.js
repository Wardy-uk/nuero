'use strict';

/**
 * The durable jobs for external weather (services/runtime-jobs.js), registered
 * from scheduler.start(). Separate from registerDurableJobs() on purpose: the
 * runtime tests register that set and tick it, and these jobs reach the
 * internet.
 *
 * Each sync returns {ok:false} as a VALUE when a source fails (its own state
 * already holds the failure and the backoff); the job raises it so the runtime
 * records the run as failed too. A run skipped because the source is backing
 * off, or because a credential is not configured, is NOT a failure.
 */

function _raise(r, what) {
  if (r && r.ok === false && !r.skipped && !r.blocked) throw new Error(`${what}: ${r.error || r.reason || 'failed'}`);
  return r;
}

function register() {
  const runtime = require('./runtime-jobs');

  runtime.defineJob({
    name: 'weather-ea-live',
    cron: '4,19,34,49 * * * *',
    class: 'freshness-sensitive',
    catchUp: 'latest',
    maxLagMs: null,
    maxAttempts: 2,
    backoffMs: [2 * 60 * 1000],
    timeoutMs: 2 * 60 * 1000,
    why: 'The EA Mount St Bernards gauge publishes 15-minute rainfall; each pass re-reads from six hours before the newest held reading, so a missed pass heals itself.',
    run: async () => _raise(await require('./weather-ea').syncLive(), 'EA live'),
  });

  runtime.defineJob({
    name: 'weather-ea-qualified',
    cron: '41 3 * * *',
    class: 'best-effort',
    catchUp: 'latest',
    maxLagMs: null,
    maxAttempts: 2,
    backoffMs: [15 * 60 * 1000],
    timeoutMs: 10 * 60 * 1000,
    why: 'The EA re-issues recent readings once quality-checked (Unchecked → Good). Re-reading the last 120 days daily turns that into recorded revisions.',
    run: async () => _raise(await require('./weather-ea').syncQualifiedRecent(), 'EA qualified'),
  });

  runtime.defineJob({
    name: 'weather-ea-backfill',
    cron: '27 * * * *',
    class: 'expensive',
    catchUp: 'latest',
    maxLagMs: null,
    maxAttempts: 1,
    timeoutMs: 15 * 60 * 1000,
    why: 'Walks the gauge history back (daily to 1985, 15-minute to WEATHER_EA_15MIN_FROM) a few chunks an hour; resumable, and a no-op once complete.',
    run: async () => {
      const r = await require('./weather-ea').backfillStep({ maxChunks: 4 });
      return Object.fromEntries(Object.entries(r).map(([p, s]) => [p, { cursor: s.cursor, rows: s.rows, complete: s.complete }]));
    },
  });

  runtime.defineJob({
    name: 'weather-wu-import',
    // 16 stations, one call each: every 20 min is ~1,150 calls a day, under
    // WU's daily allowance for an owner key with room for ad-hoc imports.
    cron: '2,22,42 * * * *',
    class: 'best-effort',
    catchUp: 'latest',
    maxLagMs: 20 * 60 * 1000,
    maxAttempts: 1,
    timeoutMs: 2 * 60 * 1000,
    why: 'Neighbouring Weather Underground stations. Blocked (recorded as such, not failed) until a key is set.',
    run: async () => require('./weather-wu').syncImport(),
  });

  runtime.defineJob({
    name: 'weather-nowcast',
    cron: '6,26,46 * * * *',
    class: 'best-effort',
    catchUp: 'latest',
    maxLagMs: 20 * 60 * 1000,
    maxAttempts: 1,
    timeoutMs: 60 * 1000,
    why: 'Four minutes after each import: score rain calls whose window has closed, record rain starting at home, and record a new rain call when upwind stations are wet.',
    run: async () => {
      const r = await require('./weather-nowcast').pass();
      return { arrival: r.arrival.state, reporting: r.reporting, resolved: r.resolved, recorded: r.recorded };
    },
  });

  runtime.defineJob({
    name: 'weather-retention',
    cron: '55 3 * * *',
    class: 'best-effort',
    catchUp: 'latest',
    maxLagMs: null,
    maxAttempts: 1,
    timeoutMs: 5 * 60 * 1000,
    why: 'Daily summaries of each WU station (kept for good), then raw WU readings older than 30 days deleted. EA data is never deleted.',
    run: async () => require('./weather-nowcast').retain(),
  });

  runtime.defineJob({
    name: 'weather-wu-publish',
    cron: '*/5 * * * *',
    class: 'best-effort',
    catchUp: 'latest',
    maxLagMs: 5 * 60 * 1000,
    maxAttempts: 1,
    timeoutMs: 60 * 1000,
    why: 'Uploads the home station (ICOALV59) to Weather Underground. A no-op until WU_PUBLISH_ENABLED, WU_STATION_KEY and a live ESP32 reading all exist.',
    run: async () => require('./weather-wu').publishLatest(),
  });
}

module.exports = { register };
