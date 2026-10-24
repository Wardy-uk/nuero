'use strict';

/**
 * Brief 004 (D-007) — NEURO can SEE whether the Watch lock is actually running.
 *
 * The agent reports `watchLock` on every activity sample. This pins:
 *   - the stored shape is CLOSED (no RSSI, no Watch identity, junk refused);
 *   - a sample that omits it never wipes a known report;
 *   - Set up's `windows.watch-lock` is `done` ONLY when the agent is locking,
 *     reporting recently and can read the Watch — and names why otherwise;
 *   - end to end over real HTTP: a sample posted to /api/desktop/activity
 *     reaches the Set up item.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b004-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const db = require('../db/database');
const DA = require('./desktop-activity');
const SC = require('./setup-check');

const NOW = Date.parse('2026-10-24T09:00:00Z');
const on = { mode: 'on', presence: 'present', why: null, presenceAgeS: 2, armed: true, lockedByUs: false, locks: 3, wouldLock: 0, wakes: 2, failures: 0, lastAction: 'wake', lastActionAt: '2026-10-24T08:50:00Z', since: '2026-10-24T07:00:00Z' };
const host = (wl, at = '2026-10-24T08:58:00Z') => ({ host: 'DESKTOP-TEST', lastAt: at, watchLock: wl, watchLockAt: wl ? at : null });

test.before(async () => { await db.init(); });

test('sanitiseWatchLock keeps a closed shape and drops everything else', () => {
  const s = DA.sanitiseWatchLock({ ...on, rssi: -61, irk: 'secret', lastAction: 'format c:', presence: 'nearby' });
  assert.equal(s.mode, 'on'); assert.equal(s.presence, 'blind', 'unknown presence is blind, never present');
  assert.equal(s.lastAction, null);
  assert.ok(!JSON.stringify(s).match(/rssi|irk|secret|-61|format/));
  assert.equal(DA.sanitiseWatchLock({ mode: 'turbo' }), null);
  assert.equal(DA.sanitiseWatchLock(null), null);
  assert.deepEqual(DA.sanitiseWatchLock({ mode: 'off', locks: 9 }), { mode: 'off' });
});

test('record stores watchLock per host; a sample that omits it never wipes it', () => {
  DA.record({ host: 'DESKTOP-TEST', app: 'Code', idleSeconds: 3, at: '2026-10-24T08:00:00Z', watchLock: on });
  DA.record({ host: 'DESKTOP-TEST', app: 'Code', idleSeconds: 3, at: '2026-10-24T08:02:00Z' });
  DA.record({ host: 'DESKTOP-TEST', app: 'Code', idleSeconds: 3, at: '2026-10-24T08:04:00Z', watchLock: { mode: 'bogus' } });
  const h = DA.hosts().find((x) => x.host === 'DESKTOP-TEST');
  assert.equal(h.watchLock.mode, 'on');
  assert.equal(h.watchLock.locks, 3);
  assert.equal(h.watchLockAt, '2026-10-24T08:00:00.000Z', 'only a usable report moves the stamp');
});

test('windows.watch-lock: done only when locking, recent and reading the Watch; every other case says why', () => {
  const cases = [
    [null, 'todo', /No Windows machine/],
    [host(null), 'todo', /has not reported a Watch lock/],
    [host(on, '2026-10-24T08:30:00Z'), 'attention', /may have stopped/],
    [host({ mode: 'off' }), 'attention', /Switched off/],
    [host({ ...on, presence: 'blind', why: 'stale', presenceAgeS: 120 }), 'attention', /Can’t read the Watch \(stale, 120s old\)/],
    [host({ ...on, failures: 1 }), 'attention', /failed/],
    [host({ ...on, mode: 'shadow', wouldLock: 4 }), 'attention', /Shadow \(soak\).*NOT locking — 4 lock/],
    [host(on), 'done', /Locking on DESKTOP-TEST: Watch present, 3 lock\(s\) and 2 wake/],
  ];
  for (const [h, status, re] of cases) {
    const r = SC.watchLockItem(h, NOW);
    assert.equal(r.status, status, JSON.stringify(h));
    assert.match(r.evidence, re);
  }
});

test('assess: the item is present, and SAiM’s window no longer claims the Watch lock', () => {
  const snap = {
    microsoft: { configured: true, authenticated: true }, vault: true, ai: true, vapid: true, apns: true,
    approvalCode: true, sendingEnabled: false, sources: [], desktopHosts: [host(on)], apnsApps: [],
    containers: 0, unclassified: 0, goals: 0, companions: 0, reports: [], clients: {},
  };
  const list = SC.assess(snap, { now: NOW }).items;
  const wl = list.find((i) => i && i.id === 'windows.watch-lock');
  assert.ok(wl, 'windows.watch-lock listed');
  assert.equal(wl.status, 'done');
  const saim = list.find((i) => i && i.id === 'windows.saim');
  assert.doesNotMatch(saim.why, /and the Watch lock\.$/);
});

test('end to end: a sample POSTed to /api/desktop/activity reaches the Set up item', async () => {
  const app = express(); app.use(express.json());
  app.use('/api/desktop', require('../routes/desktop'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const at = new Date().toISOString();
    const res = await fetch(`${base}/api/desktop/activity`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'DESKTOP-E2E', app: 'Code', idleSeconds: 1, at, locked: false, watchLock: { ...on, mode: 'shadow', wouldLock: 1, rssi: -50 } }) });
    assert.equal(res.status, 200);
    const h = DA.hosts().find((x) => x.host === 'DESKTOP-E2E');
    assert.equal(h.watchLock.mode, 'shadow');
    assert.ok(!('rssi' in h.watchLock));
    const r = SC.watchLockItem(h, Date.now());
    assert.equal(r.status, 'attention'); assert.match(r.evidence, /Shadow \(soak\)/);
  } finally { server.close(); }
});
