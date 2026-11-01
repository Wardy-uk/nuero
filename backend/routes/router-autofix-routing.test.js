'use strict';

/**
 * Router auto-restart (1 Nov 2026): restart inside the safe hours, ask outside
 * them, restart on a yes — through the REAL sample route, the REAL ledger and
 * the REAL answer routes over HTTP. The ssh runner is ALWAYS a stub: a test must
 * never restart the real router (pi5 holds its key).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-routerfix-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
process.env.PUSH_QUIET_HOURS = 'off';
process.env.PUSH_HOURLY_CAP = '1000';
process.env.ROUTER_AUTOFIX_NO_SSH = '1';

const db = require('../db/database');
const autofix = require('../services/router-autofix');
const writes = require('../services/external-writes');

let server;
let base;
let calls = 0;
let shellRuns = true;
autofix._setRunnerForTests(async () => {
  calls += 1;
  return shellRuns ? { stdout: `${autofix.MARKER}\n`, stderr: '', code: 255 } : { stdout: '', stderr: 'sh: can\'t fork', code: 1 };
});

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (req.headers['x-test-machine']) req.apiClient = 'n8n'; next(); });
  app.use('/api/router', require('./router'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((r) => server.close(r)));

const reset = () => {
  db.setState('router_health', JSON.stringify({ samples: [], episodeStartedAt: null }));
  db.setState(autofix.STATE_KEY, JSON.stringify({}));
  calls = 0; shellRuns = true;
};
// Safe hours that always / never contain "now", whatever the clock says.
const always = () => autofix.saveSettings({ enabled: true, from: '00:00', to: '23:59' });
const never = () => {
  const m = autofix.londonMinutes(new Date());
  const hh = (x) => `${String(Math.floor(((x + 1440) % 1440) / 60)).padStart(2, '0')}:${String(((x + 1440) % 1440) % 60).padStart(2, '0')}`;
  return autofix.saveSettings({ enabled: true, from: hh(m + 120), to: hh(m + 180) });
};

const sample = (over = {}) => ({
  at: new Date().toISOString(), reachable: true, shellOk: true, dstateReadable: true,
  load15: 0.3, tasks: 140, dcount: 0, dprocs: [], uptimeSec: 400000, ...over,
});
async function post(body) {
  const res = await fetch(`${base}/api/router/sample`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 30));
}
async function answer(body, headers = {}) {
  const res = await fetch(`${base}/api/router/restart/answer`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

test('pure: the window crosses midnight and is London time', () => {
  const at = (iso) => new Date(iso);
  assert.equal(autofix.inWindow(at('2026-11-01T03:00:00Z'), { from: '02:00', to: '08:00' }), true);
  assert.equal(autofix.inWindow(at('2026-11-01T09:00:00Z'), { from: '02:00', to: '08:00' }), false);
  assert.equal(autofix.inWindow(at('2026-11-01T23:30:00Z'), { from: '22:00', to: '06:00' }), true);
  // BST: 01:30 UTC on 1 Jul is 02:30 London.
  assert.equal(autofix.inWindow(at('2026-07-01T01:30:00Z'), { from: '02:00', to: '08:00' }), true);
});

test('settings are refused, never repaired', () => {
  assert.equal(autofix.saveSettings({ from: '25:00' }).ok, false);
  assert.equal(autofix.saveSettings({ enabled: 'yes' }).ok, false);
  assert.equal(autofix.saveSettings({ from: '03:00', to: '03:00' }).ok, false);
  assert.deepEqual(autofix.saveSettings({ from: '02:00', to: '08:00', enabled: true }).settings, { enabled: true, from: '02:00', to: '08:00' });
});

test('inside the safe hours a wedge is restarted once, ledgered, and verified by a reset uptime', async () => {
  reset(); always();
  await post(sample());
  await post(sample({ load15: 40 }));
  assert.equal(calls, 1, 'restarted on the first wedging sample');
  await post(sample({ load15: 41 }));
  assert.equal(calls, 1, 'never twice in one episode');
  const st = autofix.status();
  assert.equal(st.restarts[0].outcome, 'pending');
  const entry = writes.byKey(`router-restart:${st.restarts[0].episode}:1`);
  assert.equal(entry.status, 'applied-unverified');
  // The box comes back: uptime 90 s.
  await post(sample({ uptimeSec: 90 }));
  assert.equal(autofix.status().restarts[0].outcome, 'verified');
  assert.equal(writes.byKey(`router-restart:${st.restarts[0].episode}:1`).status, 'confirmed');
});

test('a shell that never ran is a failed attempt and may retry; a recently booted box is left alone', async () => {
  reset(); always();
  shellRuns = false;
  await post(sample({ load15: 40 }));
  await post(sample({ load15: 40 }));
  assert.equal(calls, 2);
  assert.equal(autofix.status().restarts[0].outcome, 'failed');
  reset(); always();
  await post(sample({ load15: 40, uptimeSec: 600 }));
  assert.equal(calls, 0, 'booted 10 minutes ago — not again');
});

test('outside the safe hours it asks, and restarts only on a yes', async () => {
  reset(); never();
  await post(sample({ load15: 40 }));
  assert.equal(calls, 0, 'never on its own outside the window');
  const ask = autofix.surface().ask;
  assert.ok(ask && /Restart it now/.test(ask.say));
  const machine = await answer({ id: ask.id, decision: 'approve' }, { 'x-test-machine': '1' });
  assert.equal(machine.status, 403, 'a machine cannot approve');
  assert.equal(calls, 0);
  const yes = await answer({ id: ask.id, decision: 'approve' });
  assert.equal(yes.status, 200);
  assert.equal(calls, 1);
  assert.equal(autofix.surface().ask, null, 'the question closes once restarted');
  const again = await answer({ id: ask.id, decision: 'approve' });
  assert.equal(again.status, 409);
  assert.equal(calls, 1);
});

test('"not now" waits; a recovered router is not restarted on a late yes', async () => {
  reset(); never();
  await post(sample({ load15: 40 }));
  const { id } = autofix.surface().ask;
  const no = await answer({ id, decision: 'decline' });
  assert.equal(no.status, 200);
  assert.match(no.json.say, /safe hours/);
  assert.equal(autofix.surface(), null, 'a declined question stops asking');

  reset(); never();
  await post(sample({ load15: 40 }));
  const id2 = autofix.surface().ask.id;
  await post(sample());
  const late = await answer({ id: id2, decision: 'approve' });
  assert.equal(late.status, 409);
  assert.equal(calls, 0);
});

test('switched off does nothing at all', async () => {
  reset();
  autofix.saveSettings({ enabled: false, from: '00:00', to: '23:59' });
  await post(sample({ load15: 40 }));
  assert.equal(calls, 0);
  assert.equal(autofix.surface(), null);
  autofix.saveSettings({ enabled: true, from: '02:00', to: '08:00' });
});

test('the cooldown holds a second wedge within 6 hours', async () => {
  reset(); always();
  await post(sample({ load15: 40 }));
  assert.equal(calls, 1);
  await post(sample());            // recovered: episode ends
  await post(sample({ load15: 40 })); // new episode, same hour
  assert.equal(calls, 1, 'not within the cooldown');
});

test('the real ssh runner refuses inside a test process', async () => {
  autofix._setRunnerForTests(null);
  try {
    reset(); always();
    await post(sample({ load15: 40 }));
    const r = autofix.status().restarts[0];
    assert.equal(r.outcome, 'failed');
    assert.match(r.why, /refused/);
  } finally {
    autofix._setRunnerForTests(async () => { calls += 1; return { stdout: autofix.MARKER, stderr: '', code: 0 }; });
  }
});
