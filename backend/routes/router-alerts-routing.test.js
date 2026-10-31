'use strict';

/**
 * Router alerts reach the phone once per wedge, over real HTTP, through the
 * REAL webpush gates and attention lifecycle.
 *
 * Why this exists (15 Oct 2026): the router wedged 12-14 Oct and NEURO tried to
 * alert ~60 times. Every attempt was "already notified, nothing changed",
 * because every router push ever sent shared ONE attention record, opened on
 * 21 Sep and never closed. The route, the router-health suite and the webpush
 * suite were all green, because each was right on its own. Only the JOIN fails,
 * so the test is the join: route -> episode -> sendToAll -> lifecycle -> push_log.
 *
 * VAPID is configured and there are no subscriptions, so a push that passes
 * every gate is logged `undeliverable / no subscriptions`. That outcome is
 * the proof it was let through. `suppressed` is the proof it was held.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-routeralerts-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
process.env.PUSH_QUIET_HOURS = 'off';
process.env.PUSH_HOURLY_CAP = '1000';
const keys = require('web-push').generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = keys.publicKey;
process.env.VAPID_PRIVATE_KEY = keys.privateKey;

const db = require('../db/database');
const webpush = require('../services/webpush');
const lifecycle = require('../services/attention-lifecycle');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/router', require('./router'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((r) => server.close(r)));

const resetGovernor = () => db.setState('push_governor', JSON.stringify({ sent: [], recent: {} }));

const sample = (over = {}) => ({
  at: new Date().toISOString(),
  reachable: true, shellOk: true, dstateReadable: true,
  load15: 0.3, tasks: 140, dcount: 0, dprocs: [], memFreeKb: 117000, nvramFree: 5500, ...over,
});

async function post(body) {
  const res = await fetch(`${base}/api/router/sample`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  await new Promise((r) => setImmediate(r));
  return json;
}

/** The newest push_log row of a type, or null. */
function lastPush(type) {
  return db.getPushLog(200).find((r) => r.type === type) || null;
}

const PASSED = 'undeliverable';
const openRouterRecords = () => db.getOpenAttentionRecords().filter((r) => r.type === 'router_health');

test('every wedge gets its own alert, and recovery closes it', async () => {
  resetGovernor();

  // A record left over from before the fix: the shared one that silenced 12-14 Oct.
  await webpush.sendToAll('SAiM — Router', 'old shared alert', { type: 'router_health' });
  assert.equal(openRouterRecords().length, 1);

  // Healthy: nothing sent, and the legacy record is closed.
  const before = db.getPushLog(200).length;
  await post(sample());
  assert.equal(db.getPushLog(200).length, before, 'a healthy sample must not push');
  assert.equal(openRouterRecords().length, 0, 'recovery closes the legacy shared record');

  // Episode 1 starts building: the first sample gets through.
  let r = await post(sample({ load15: 30 }));
  assert.equal(r.announced, true);
  assert.equal(lastPush('router_health').outcome, PASSED);

  // Still building: held as already notified.
  await post(sample({ load15: 31 }));
  assert.equal(lastPush('router_health').reason, 'already notified, nothing changed');

  // Escalates to down: a second alert, once.
  await post(sample({ shellOk: false }));
  assert.equal(lastPush('router_health').outcome, PASSED, 'escalating to down must alert');
  await post(sample({ shellOk: false }));
  assert.equal(lastPush('router_health').reason, 'already notified, nothing changed');

  // Recovers: both records closed.
  await post(sample());
  assert.equal(openRouterRecords().length, 0);

  // ⚠ THE BUG: episode 2 must alert again.
  await post(sample({ load15: 44 }));
  assert.equal(lastPush('router_health').outcome, PASSED,
    'a new wedge after recovery must reach the phone');
});

test('a stopped watcher does not end the episode', async () => {
  resetGovernor();
  await post(sample());
  await post(sample({ load15: 55 }));
  assert.equal(lastPush('router_health').outcome, PASSED);
  // A stale sample (watcher stopped) reads as unknown.
  await post(sample({ at: new Date(Date.now() - 60 * 60000).toISOString(), load15: 0.2 }));
  // Back, still building: same episode, so no second alert.
  await post(sample({ load15: 56 }));
  assert.equal(lastPush('router_health').reason, 'already notified, nothing changed');
  await post(sample());
});

test('an alert held by the governor is retried, not lost', async () => {
  // Hourly cap already reached: the attention gate passes it, the governor holds it.
  db.setState('push_governor', JSON.stringify({ sent: Array(1000).fill(Date.now()), recent: {} }));
  await post(sample());
  await post(sample({ load15: 66 }));
  assert.match(lastPush('router_health').reason, /hourly cap/);

  // Cap clears; the next sample must get through rather than read "already notified".
  resetGovernor();
  await post(sample({ load15: 67 }));
  assert.equal(lastPush('router_health').outcome, PASSED,
    'a push the governor held must not be stamped as notified');
  await post(sample());
});

test('a watchdog recovery closes the alert it recovers from', async () => {
  resetGovernor();
  const alert = () => webpush.sendToAll('⚠ Home router has stopped working', 'stuck', { type: 'sense_alert', key: 'sense:router' });
  await alert();
  assert.equal(lastPush('sense_alert').outcome, PASSED);
  await alert();
  assert.equal(lastPush('sense_alert').reason, 'already notified, nothing changed');

  await webpush.sendToAll('✅ Back: Home router', 'Reporting again.', { type: 'sense_alert', key: 'sense:router:resolved' });
  const key = lifecycle.dedupeKeyForPush('sense_alert', 'sense:router');
  assert.equal(db.getOpenAttentionRecord(key), null, 'the original alert is closed');

  resetGovernor();
  await alert();
  assert.equal(lastPush('sense_alert').outcome, PASSED, 'the next occurrence alerts again');

  // ...and its recovery is announced again too.
  resetGovernor();
  await webpush.sendToAll('✅ Back: Home router', 'Reporting again.', { type: 'sense_alert', key: 'sense:router:resolved' });
  assert.equal(lastPush('sense_alert').outcome, PASSED, 'the second recovery is announced');
});

// 31 Oct 2026: the 30 Oct wedge pushed at 13:30 and then said nothing for 29
// hours. A router that stays DOWN is re-announced every 4 hours — once per
// round, one open record at a time, and never once Nick has acknowledged it.
test('a router still down is re-announced every 4 hours, until Nick answers', async () => {
  resetGovernor();
  await post(sample());
  await post(sample({ shellOk: false }));
  assert.equal(lastPush('router_health').outcome, PASSED);

  const backdate = (hours) => {
    const s = JSON.parse(db.getState('router_health'));
    s.episodeStartedAt = new Date(Date.now() - hours * 3600000).toISOString();
    db.setState('router_health', JSON.stringify(s));
  };
  const pushes = () => db.getPushLog(500).filter((r) => r.type === 'router_health' && r.outcome === PASSED).length;

  backdate(5);
  let n = pushes();
  const r = await post(sample({ shellOk: false }));
  assert.equal(r.announced, true);
  assert.equal(pushes(), n + 1, 'four hours on, still down: a reminder');
  assert.equal(openRouterRecords().length, 1, 'the reminder supersedes the first record');

  await post(sample({ shellOk: false }));
  assert.equal(lastPush('router_health').reason, 'already notified, nothing changed', 'once per round');

  // Nick acknowledges it: the next round stays quiet.
  lifecycle.act(openRouterRecords()[0].id, 'acknowledge');
  backdate(9);
  n = pushes();
  await post(sample({ shellOk: false }));
  assert.equal(pushes(), n, 'acknowledged: no further reminders this episode');

  await post(sample());
  assert.equal(openRouterRecords().length, 0, 'recovery closes every round');
});
