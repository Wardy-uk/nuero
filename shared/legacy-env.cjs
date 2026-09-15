'use strict';

/**
 * SARA_* → SAiM_* environment shim (SARA → SAiM rename, 15 Sep 2026).
 *
 * ⚠ WHY THIS EXISTS AT ALL: `.env` files are GITIGNORED, so the rename that
 * swept 3,500 references through this repo did not touch a single one of them.
 * The code now reads `SAIM_HA_TOKEN`; the file on the Pi still says
 * `SARA_HA_TOKEN`. Nothing errors — `process.env.SAIM_HA_TOKEN` is simply
 * undefined, so the Home Assistant bridge goes idle, `SAIM_PORT` falls back to
 * its default, and the kiosk reports itself perfectly healthy while being
 * unable to see the house. A deploy where the code and the config disagree in
 * silence is the exact failure this codebase keeps stamping out.
 *
 * So rather than depend on every `.env` on every machine being hand-edited in
 * the same window as a `git pull`, the old names keep working:
 *
 *   - Applied ONCE, at process start, BEFORE anything reads env — so it covers
 *     every read site, including ones written after this.
 *   - COPIES, never moves: `SARA_X` is left in place, so rolling the deploy
 *     back to code that reads the old name still finds it.
 *   - An explicitly set `SAIM_X` ALWAYS WINS. A machine already migrated is
 *     never overridden by a stale line further down its .env.
 *   - It LOGS what it carried over, once, by NAME and never by value — a
 *     compatibility shim working invisibly is one nobody ever removes, and
 *     these names include tokens.
 *
 * Delete this once every `.env` (Pi 5, Pi 4, this laptop) uses SAIM_*.
 */

const PREFIX_OLD = 'SARA_';
const PREFIX_NEW = 'SAIM_';

/**
 * PURE. Given an env-like object, return the keys that should be copied and
 * what they should be copied to. Exported separately so the rule pins without
 * mutating the real process environment.
 */
function planEnvAliases(env) {
  const plan = [];
  for (const key of Object.keys(env || {})) {
    if (!key.startsWith(PREFIX_OLD)) continue;
    const next = PREFIX_NEW + key.slice(PREFIX_OLD.length);
    // An explicitly set new-name variable is the migrated machine's answer and
    // outranks the legacy line, whatever order they appear in the file.
    if (env[next] !== undefined) continue;
    plan.push({ from: key, to: next });
  }
  return plan;
}

let applied = false;

/** Apply the aliases to `process.env`. Idempotent — safe to call more than once. */
function applyLegacyEnv(env = process.env, log = console.warn) {
  if (applied && env === process.env) return [];
  const plan = planEnvAliases(env);
  for (const { from, to } of plan) env[to] = env[from];
  if (env === process.env) applied = true;
  if (plan.length && typeof log === 'function') {
    log(
      `[env] SARA_* is the pre-rename spelling. Carried ${plan.length} variable(s) over to SAIM_*: `
      + plan.map((p) => `${p.from} -> ${p.to}`).join(', ')
      + '. Rename them in the .env on this machine and this line goes away.'
    );
  }
  return plan;
}

module.exports = { planEnvAliases, applyLegacyEnv };
