'use strict';

/**
 * The Teams DM path is an UPGRADE on email, never a precondition for it (Q9).
 * These tests pin the two properties that make that true:
 *
 *  1. every failure comes back as `{ sent: false, reason }` and nothing throws;
 *  2. `getScopedToken` is used, so an unconsented Teams scope can never enter
 *     `GRAPH_SCOPES` and take Calendar/Mail/Tasks down with it.
 *
 * Both were verified live on the Pi on 15 Aug — `ChatMessage.Send` returns
 * AADSTS65001 while `getMailAccessStatus()` stays clean — but the live check is
 * a one-off and this is the thing that catches a regression later.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const MS_PATH = require.resolve('./microsoft');
const TEAMS_PATH = require.resolve('./teams');

/** Load teams.js against a stubbed microsoft.js. */
function loadTeams(microsoftStub, env = {}) {
  const prevEnv = { ...process.env };
  Object.assign(process.env, env);

  delete require.cache[TEAMS_PATH];
  const realMs = require.cache[MS_PATH];
  require.cache[MS_PATH] = { id: MS_PATH, filename: MS_PATH, loaded: true, exports: microsoftStub };

  try {
    return require('./teams');
  } finally {
    if (realMs) require.cache[MS_PATH] = realMs; else delete require.cache[MS_PATH];
    delete require.cache[TEAMS_PATH];
    process.env = prevEnv;
  }
}

// Build 8 (3 Oct 2026): sendDm is DELETED — its only caller, the legacy chase
// sender, was retired in Build 7, and nothing may send as Nick outside the
// governed executor. Pinned as an absence: an export and a source scan, with a
// positive control that the scan reads the real file.
test('Build 8: teams.js has no sender — sendDm is gone and nothing POSTs a chat message', () => {
  const teams = loadTeams({ getScopedToken: async () => ({ token: 'tok' }) });
  assert.equal(teams.sendDm, undefined, 'sendDm must not come back');
  const src = require('fs').readFileSync(path.join(__dirname, 'teams.js'), 'utf8');
  assert.match(src, /async function getSendStatus/, 'positive control: the real file was read');
  assert.doesNotMatch(src, /method:\s*'POST'/, 'teams.js makes no write call at all');
});

test('getSendStatus names what it is waiting on', async () => {
  const waiting = loadTeams({ getScopedToken: async () => ({ token: null, reason: 'consent' }) });
  const s = await waiting.getSendStatus();
  assert.equal(s.available, false);
  assert.equal(s.reason, 'consent');
  assert.match(s.detail, /Admin consent requests/);

  const live = loadTeams({ getScopedToken: async () => ({ token: 'tok' }) });
  assert.equal((await live.getSendStatus()).available, true);
});
