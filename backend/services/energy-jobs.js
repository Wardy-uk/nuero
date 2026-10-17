'use strict';

/**
 * Durable jobs for home energy (services/runtime-jobs.js), registered from
 * scheduler.start() beside weather-jobs — NOT inside registerDurableJobs(),
 * whose set the runtime tests tick, because these reach the internet.
 *
 * A run with no Bright credentials (or a rejected login) is `blocked`, never a
 * failure: not having connected is a decision, a broken connection is a fault.
 */

function _raise(r, what) {
  if (r && r.ok === false && !r.skipped && !r.blocked) throw new Error(`${what}: ${r.error || r.reason || 'failed'}`);
  return r;
}

function register() {
  const runtime = require('./runtime-jobs');

  runtime.defineJob({
    name: 'energy-sync',
    // Just after each half hour (with Bright's own catch-up request inside):
    // DCC half-hours become available on the half hour, late and in batches.
    cron: '4,34 * * * *',
    class: 'freshness-sensitive',
    catchUp: 'latest',
    maxLagMs: null,
    maxAttempts: 2,
    backoffMs: [3 * 60 * 1000],
    timeoutMs: 5 * 60 * 1000,
    why: 'Re-reads the last three days of electricity and gas half-hours from Bright (late and revised DCC data), and asks Bright to catch up from the DCC. Restart-safe: a missed pass re-reads from the newest held reading.',
    run: async () => _raise(await require('./energy').syncRecent(), 'energy sync'),
  });

  runtime.defineJob({
    name: 'energy-backfill',
    cron: '13,43 * * * *',
    class: 'expensive',
    catchUp: 'latest',
    maxLagMs: null,
    maxAttempts: 1,
    timeoutMs: 10 * 60 * 1000,
    why: 'Walks each meter\'s history back to Bright\'s first available reading, nine days a call, checkpointed after every call; re-checks the first reading daily because Bright is still populating from the DCC.',
    run: async () => require('./energy').backfillStep({ maxChunks: 8 }),
  });

  runtime.defineJob({
    name: 'energy-daily',
    cron: '21 5 * * *',
    class: 'best-effort',
    catchUp: 'latest',
    maxLagMs: null,
    maxAttempts: 2,
    backoffMs: [30 * 60 * 1000],
    timeoutMs: 15 * 60 * 1000,
    why: 'Refreshes the meter tariff history, revisits half-hours Bright had no data for, and fills the outdoor temperature archive the gas weather baseline needs.',
    run: async () => {
      const energy = require('./energy');
      const out = {};
      out.tariffs = await energy.syncTariffs().catch((e) => ({ ok: false, error: e.message }));
      out.gaps = await energy.revisitGaps().catch((e) => ({ ok: false, error: e.message }));
      try {
        const oldest = require('../db/database').get('SELECT MIN(start_ts) AS a FROM energy_readings WHERE value IS NOT NULL');
        const fromDay = oldest && oldest.a ? require('./energy-model').londonDay(oldest.a * 1000) : null;
        out.weather = await require('./energy-weather').syncArchive({ fromDay });
      } catch (e) { out.weather = { ok: false, error: e.message }; }
      return out;
    },
  });

  runtime.defineJob({
    name: 'energy-alerts',
    // Three times a day: gas often completes a day or two late, and only a
    // COMPLETE day is ever judged.
    cron: '27 8,13,19 * * *',
    class: 'best-effort',
    catchUp: 'latest',
    maxLagMs: 3 * 3600 * 1000,
    maxAttempts: 1,
    timeoutMs: 2 * 60 * 1000,
    why: 'Pushes once per fuel per day when a complete day was clearly unusual (gas against its weather baseline, electricity against its own month). Silent until a month of history exists.',
    run: async () => require('./energy').alertPass(),
  });
}

module.exports = { register };
