'use strict';
// The off-site backup status, judged without a Pi (watchdog.judgeOffsite is pure).
// Nick disabled the off-site push on 23 Oct 2026: that must read as a decision
// (info), and must never age into "Off-site backup has stopped" (critical).

const test = require('node:test');
const assert = require('node:assert');
const { judgeOffsite } = require('./watchdog');

const NOW = Date.parse('2026-11-30T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

test('disabled is info and says so, however old it is', () => {
  for (const age of [1, 48, 24 * 90]) {
    const out = judgeOffsite({ state: 'disabled', detail: 'Local backups active; off-site Backblaze backup intentionally disabled by Nick on 23 Oct 2026.', finishedAt: hoursAgo(age) }, NOW);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].key, 'offsite:disabled');
    assert.strictEqual(out[0].level, 'info');
    assert.match(out[0].detail, /intentionally disabled by Nick/);
  }
});

test('an ok run that has gone quiet still becomes stale (positive control)', () => {
  const out = judgeOffsite({ state: 'ok', finishedAt: hoursAgo(24 * 10) }, NOW);
  assert.strictEqual(out[0].key, 'offsite:stale');
  assert.strictEqual(out[0].level, 'critical');
});

test('failed is still critical and a fresh ok says nothing', () => {
  assert.strictEqual(judgeOffsite({ state: 'failed', finishedAt: hoursAgo(1) }, NOW)[0].level, 'critical');
  assert.deepStrictEqual(judgeOffsite({ state: 'ok', finishedAt: hoursAgo(1) }, NOW), []);
});

test('unconfigured stays info', () => {
  assert.strictEqual(judgeOffsite({ state: 'unconfigured' }, NOW)[0].level, 'info');
});
