'use strict';

/**
 * Shared source for the Electron test drivers (23 Oct 2026).
 *
 * Every real-browser test writes a small Electron app (`DRIVER`, a String.raw
 * template) and interpolates this text into it. Two things failed ONLY when the
 * whole suite ran in parallel, never alone:
 *
 *   1. `win.loadURL()` rejected with ERR_FAILED (-2) on the first load — a dozen
 *      Electron processes and a dozen local servers starting at once. The page
 *      was never the problem; the load was simply not answered in time.
 *   2. A click ran against an element that had not rendered yet, because the
 *      wait before it gave up silently after 15 s and the click went ahead
 *      anyway ("Script failed to execute").
 *
 * So: a load is retried (fresh load each time, with back-off) on a transport
 * error only — an HTTP error page is an answer and is never retried — and
 * `mustWait` waits longer and THROWS, naming what it was waiting for, instead of
 * returning null for the caller to ignore. A step that genuinely never renders
 * still fails; it fails with its own name.
 */

const LOAD_WITH_RETRY = `
async function loadWithRetry(win, url, attempts = 5) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await win.loadURL(url); } catch (e) {
      last = e;
      const transient = /ERR_(FAILED|ABORTED|CONNECTION_REFUSED|CONNECTION_RESET|EMPTY_RESPONSE|TIMED_OUT)/.test(String(e && (e.code || e.message)));
      if (!transient) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw last;
}
async function mustWait(js, code, label, ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = await js(code); if (v) return v; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('waited ' + ms + 'ms and never saw: ' + label);
}
`;

/**
 * Where the MAIN checkout is, so a worktree's tests can READ its installed
 * node_modules (React for the bundles, Electron) without a node_modules junction.
 * Junctions in worktrees deleted the main checkout three times (19/20/23 Oct 2026);
 * reading by path is the replacement. git's common dir is <main>/.git for the main
 * checkout, a nested .claude/worktrees/* worktree and a sibling worktree alike.
 */
function mainCheckout(root) {
  try {
    const common = require('child_process').execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (common) return require('path').dirname(common);
  } catch { /* not a git checkout: fall back to the sibling layout */ }
  return require('path').join(root, '..', 'nuero');
}

module.exports = { LOAD_WITH_RETRY, mainCheckout };
