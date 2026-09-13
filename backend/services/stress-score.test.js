'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Scratch DB — set before anything requires the db module, since database.js
// reads NEURO_DB_PATH at load time.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-stress-'));
process.env.NEURO_DB_PATH = path.join(root, 'stress.db');

const db = require('../db/database');
const stress = require('./stress-score');

test.before(async () => { await db.init(); });

function sqlUtc(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function clearSamples() {
  db.getDb().exec('DELETE FROM health_samples');
}

// Seed `days` of HRV/RHR around a baseline, with deterministic spread so the
// robust sigma lands in a realistic range rather than an artificially tight one.
function seedBaseline({ days = 14, hrvMid = 48, rhr = 57 } = {}) {
  const now = Date.now();
  for (let d = days; d >= 1; d--) {
    for (const h of [2, 8, 14, 20]) {
      const t = new Date(now - d * 864e5);
      t.setHours(h, 0, 0, 0);
      const jitter = (((d * 7 + h) % 21) - 10) * 1.2;
      db.insertHealthSample('hrv', hrvMid + jitter, sqlUtc(t.getTime()), 'test');
      db.insertHealthSample('rhr', rhr + (jitter % 3), sqlUtc(t.getTime()), 'test');
    }
  }
}

test('refuses to score until there is enough history for a baseline', () => {
  clearSamples();
  seedBaseline({ days: 3 });
  const r = stress.computeStressScore();
  assert.equal(r.status, 'calibrating');
  assert.equal(r.score, null);
  // An absolute HRV number is meaningless without a personal baseline, so
  // reporting a score here would be worse than reporting nothing.
  assert.ok(r.detail.includes('baseline'));
});

test('a fortnight of history produces a usable baseline', () => {
  clearSamples();
  seedBaseline();
  const b = stress.buildHrvBaseline();
  assert.equal(b.ready, true);
  assert.ok(b.days >= 7);
  assert.ok(Math.abs(b.medianMs - 48) < 4, `baseline ${b.medianMs} should sit near the seeded 48ms`);
});

test('reports stale rather than scoring off an old reading', () => {
  clearSamples();
  seedBaseline();
  const r = stress.computeStressScore();
  // Newest seeded sample is a day old — well outside the 6h "current" window.
  assert.equal(r.status, 'stale');
  assert.equal(r.score, null);
});

test('HRV at baseline scores mid-range', () => {
  clearSamples();
  seedBaseline();
  db.insertHealthSample('hrv', 48, sqlUtc(Date.now() - 20 * 60000), 'test');
  const r = stress.computeStressScore();
  assert.equal(r.status, 'ok');
  assert.ok(r.score > 35 && r.score < 65, `expected mid-range, got ${r.score}`);
});

test('suppressed HRV scores high, elevated HRV scores low', () => {
  clearSamples();
  seedBaseline();
  db.insertHealthSample('hrv', 27, sqlUtc(Date.now() - 20 * 60000), 'test');
  const high = stress.computeStressScore();

  clearSamples();
  seedBaseline();
  db.insertHealthSample('hrv', 80, sqlUtc(Date.now() - 20 * 60000), 'test');
  const low = stress.computeStressScore();

  assert.ok(high.score > 65, `suppressed HRV should read high, got ${high.score}`);
  assert.ok(low.score < 35, `elevated HRV should read low, got ${low.score}`);
  assert.ok(high.score > low.score);
});

// The clamp exists so a freak sensor reading cannot report a bare 0 or 100 —
// those look like certainty the data does not support.
test('never reports absolute certainty, even on absurd readings', () => {
  clearSamples();
  seedBaseline();
  db.insertHealthSample('hrv', 1, sqlUtc(Date.now() - 10 * 60000), 'test');
  const r = stress.computeStressScore();
  assert.ok(r.score <= 98 && r.score >= 2, `got ${r.score}`);
});

test('heart rate well above resting raises the score and flags the exercise caveat', () => {
  clearSamples();
  seedBaseline();
  const recent = sqlUtc(Date.now() - 20 * 60000);
  db.insertHealthSample('hrv', 48, recent, 'test');
  const without = stress.computeStressScore();

  db.insertHealthSample('heartRate', 95, sqlUtc(Date.now() - 2 * 60000), 'test');
  const with_ = stress.computeStressScore();

  assert.ok(with_.score > without.score, 'elevated HR should push the score up');
  // Apple Health cannot distinguish a run from a stressful meeting, so this
  // must be surfaced rather than silently folded into the number.
  assert.ok(with_.caveats.some(c => c.toLowerCase().includes('active')));
});

test('a stale heart rate is ignored rather than treated as current', () => {
  clearSamples();
  seedBaseline();
  db.insertHealthSample('hrv', 48, sqlUtc(Date.now() - 20 * 60000), 'test');
  db.insertHealthSample('heartRate', 150, sqlUtc(Date.now() - 5 * 3600e3), 'test');
  const r = stress.computeStressScore();
  assert.equal(r.currentHr, null, 'a 5h-old heart rate must not drive the score');
});

test('re-posting the same sample folds instead of skewing the baseline', () => {
  clearSamples();
  const at = sqlUtc(Date.now() - 30 * 60000);
  assert.equal(db.insertHealthSample('hrv', 44, at, 'test'), true);
  assert.equal(db.insertHealthSample('hrv', 44, at, 'test'), false);
  const rows = db.getHealthSamples('hrv', sqlUtc(Date.now() - 864e5), 100);
  assert.equal(rows.length, 1);
});

// ─── Is it worth a slot? ─────────────────────────────────────────────────────
//
// ⚠ These pin a DECISION five surfaces gate on, so getting it wrong either
// pads every screen with an ordinary day or hides a genuinely bad one.

test('an ordinary day is NOT notable — "Balanced" is the whole point', () => {
  assert.equal(stress.isNotable({ status: 'ok', score: 52, label: 'Balanced' }), false);
});

test('every band either side of Balanced IS notable', () => {
  for (const [score, label] of [[80, 'High'], [62, 'Elevated'], [30, 'Low'], [10, 'Very low']]) {
    assert.equal(stress.isNotable({ status: 'ok', score, label }), true, label);
  }
});

test('the live 13 Sep reading — 62 Elevated — is notable', () => {
  // The reading that started this: rendered as "62 ready" on two surfaces.
  assert.equal(stress.isNotable({ status: 'ok', score: 62, label: 'Elevated' }), true);
});

test('calibrating and stale are not notable — there is nothing to be off', () => {
  assert.equal(stress.isNotable({ status: 'calibrating', score: null, label: 'Calibrating' }), false);
  assert.equal(stress.isNotable({ status: 'stale', score: null, label: 'No recent reading' }), false);
});

test('a caveat alone does not earn a slot', () => {
  // "Heart rate is well above resting" is a fact about the last ten minutes,
  // not about the day, and it rides WITH a score when one is shown.
  assert.equal(
    stress.isNotable({ status: 'ok', score: 50, label: 'Balanced', caveats: ['Heart rate is well above resting'] }),
    false
  );
});

test('nothing at all is not notable, and does not throw', () => {
  assert.equal(stress.isNotable(null), false);
  assert.equal(stress.isNotable({}), false);
  assert.equal(stress.isNotable({ status: 'ok', score: null, label: 'High' }), false);
});

test('the labels isNotable reads are the ones computeStressScore emits', () => {
  // ⚠ THE JOIN, not the halves. A renamed label would leave `isNotable`
  // matching nothing and quietly make every day notable — this repo has
  // shipped a whole feature reading an identifier nobody emits.
  clearSamples();
  seedBaseline();
  db.insertHealthSample('hrv', 48, sqlUtc(Date.now() - 20 * 60000), 'test');
  const r = stress.computeStressScore();
  assert.equal(r.status, 'ok');
  assert.ok(['High', 'Elevated', 'Balanced', 'Low', 'Very low'].includes(r.label),
            `unexpected label ${r.label}`);
  assert.equal(stress.isNotable(r), r.label !== 'Balanced');
});

test.after(() => {
  try { db.getDb().close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});
