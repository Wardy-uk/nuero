'use strict';

/**
 * A backend route change may not leave the MCP gateway behind.
 *
 * ⚠⚠ WHY THIS LIVES IN backend/. The check already existed — `full-access.test.js`
 * in mcp-server/ asserts the stored inventory matches the live source, with the
 * comment "source changes cannot silently leave MCP behind". It worked. Nobody
 * ran it. The documented deploy sequence is `git pull` → build → `cd backend &&
 * npm test` → restart, and `mcp-server` is not a workspace and has its own
 * runner, so nothing in that path touched it.
 *
 * The result: `/api/health/samples` shipped on 16 Sep 2026 and the gateway did
 * not know the route existed. It was found by being asked a question, not by the
 * guard that was written to find it. A guard outside the path that runs is
 * documentation, and this file is the fix — the same class as a reader with no
 * writer, one layer up: a test with no runner.
 *
 * ── Scope, and what this deliberately does NOT gate ─────────────────────────
 *
 * NEURO's inventory is fully determined by this repository, so it is a HARD
 * GATE here: change a route, refresh the inventory, or the deploy fails.
 *
 * VANTAGE's is not. Its source lives in another repo at a path that may not
 * exist on a given machine and a commit nobody here controls — the Pi has one,
 * this laptop has another. Gating NEURO's deploy on it would fail a deploy for a
 * change this deploy does not ship, and would block every NEURO release until
 * somebody classified another system's routes. So VANTAGE stays gated in
 * mcp-server's own suite, where its surface is owned, and this file asserts only
 * that the gate still EXISTS — deleting it should be loud.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MCP = path.resolve(__dirname, '..', '..', 'mcp-server');
const STORED = path.join(MCP, 'remote', 'api-inventory.json');

// The inspector is ESM and lives in another package; `import()` from CJS is fine
// and resolves its own dependencies from mcp-server/node_modules.
let inspectApi = null;
let loadError = null;
test.before(async () => {
  try {
    ({ inspectApi } = await import(new URL(`file://${path.join(MCP, 'scripts', 'inspect-api.js').replace(/\\/g, '/')}`)));
  } catch (e) {
    loadError = e;
  }
});

// The contract compares the SHAPE, not the line numbers or the prose: moving a
// route down a file is not a gateway change, and failing on it would teach
// people to regenerate without reading.
const contract = ({ line, description, ...op }) => op;

test('the MCP inventory matches the routes this backend actually mounts', () => {
  // ⚠ An unreadable inspector FAILS rather than skipping. "We could not check"
  // is not "it is fine", and a silent skip here reproduces exactly the hole this
  // file exists to close.
  assert.equal(loadError, null,
    `could not load the MCP route inspector — ${loadError && loadError.message}`);
  assert.ok(fs.existsSync(STORED), `no stored inventory at ${STORED}`);

  const stored = JSON.parse(fs.readFileSync(STORED, 'utf8'));
  const live = inspectApi();

  const storedIds = new Set(stored.map(o => o.id));
  const liveIds = new Set(live.map(o => o.id));
  const missing = live.filter(o => !storedIds.has(o.id)).map(o => `${o.method} ${o.route}`);
  const extra = stored.filter(o => !liveIds.has(o.id)).map(o => `${o.method} ${o.route}`);

  // Named, because "deepEqual failed over 518 objects" sends nobody anywhere.
  assert.deepEqual(missing, [],
    `route(s) mounted but NOT in the MCP inventory — run "npm run catalogue:refresh" in mcp-server/: ${missing.join(', ')}`);
  assert.deepEqual(extra, [],
    `inventory advertises route(s) this backend no longer mounts — run "npm run catalogue:refresh" in mcp-server/: ${extra.join(', ')}`);

  // And the full shape, so a changed method, param or body contract is caught
  // too — not just a route appearing or disappearing.
  assert.deepEqual(stored.map(contract), live.map(contract),
    'an inventoried route changed shape — run "npm run catalogue:refresh" in mcp-server/');
});

test('the VANTAGE inventory gate still exists, even though it is not gated here', () => {
  // ⚠ A positive control on somebody else's guard. VANTAGE cannot be checked
  // from this repo's deploy (its source is elsewhere, at an uncontrolled commit),
  // so the one thing this CAN do is make its removal visible.
  const vantageTest = path.join(MCP, 'remote', 'vantage.test.js');
  assert.ok(fs.existsSync(vantageTest), 'the VANTAGE inventory test has gone');
  const src = fs.readFileSync(vantageTest, 'utf8');
  assert.match(src, /vantage-inventory\.json/,
    'the VANTAGE test no longer reads the stored inventory');
  assert.match(src, /inspectVantage/,
    'the VANTAGE test no longer compares against live VANTAGE source');
});

test('the refresh command the failure message names actually exists', () => {
  // A failure that tells you to run something that is not there is worse than
  // one that tells you nothing.
  const pkg = JSON.parse(fs.readFileSync(path.join(MCP, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts && pkg.scripts['catalogue:refresh'],
    'the failure messages above name a script that does not exist');
});
