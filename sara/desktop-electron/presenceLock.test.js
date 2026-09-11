'use strict';

// The Watch → Windows lock, decided in Electron's main process. See presenceLock.js
// for why it moved here: it had silently stopped on the laptop for over a week.

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./presenceLock');

const T0 = Date.parse('2026-09-11T12:00:00Z');
const reading = (status, at = T0) => ({ status, away: status === 'away', present: status === 'present', updated: new Date(at).toISOString() });

function run(seq, start = P.initialState()) {
  let state = start;
  const actions = [];
  for (const input of seq) {
    const out = P.step(state, input);
    state = out.state;
    actions.push(out.action);
  }
  return { state, actions };
}

const at = (ms, status, idleS = 60, fileAge = 0) => ({ payload: reading(status, T0 + ms - fileAge), now: T0 + ms, idleS });

test('present → away x2 → warn → grace elapses → lock', () => {
  const { actions, state } = run([
    at(0, 'present'),
    at(5000, 'away'),
    at(10000, 'away'),
    at(12000, 'away'),
    at(15000, 'away'),
  ]);
  assert.deepEqual(actions, [null, null, 'warn', null, 'lock']);
  assert.equal(state.lockedBySara, true);
});

test('⚠ never locks before he has been SEEN present — a startup "away" is not evidence', () => {
  const { actions } = run([at(0, 'away'), at(5000, 'away'), at(10000, 'away'), at(20000, 'away')]);
  assert.ok(!actions.includes('lock'));
  assert.ok(!actions.includes('warn'));
});

test('⚠ a STALE file never locks, whatever it last said', () => {
  // The reporter crashed on 4 Sep and its final word stayed on disk.
  const old = P.STALE_MS + 1000;
  const { actions } = run([
    at(0, 'present'),
    at(5000, 'away', 60, old),
    at(10000, 'away', 60, old),
    at(20000, 'away', 60, old),
  ]);
  assert.ok(!actions.includes('lock'));
  assert.deepEqual(P.assessReading(reading('away', T0 - old), T0), { known: false, why: 'stale' });
});

test('⚠ fresh keyboard/mouse input cancels a countdown, even if the Watch reads away', () => {
  const { actions, state } = run([
    at(0, 'present'),
    at(5000, 'away'),
    at(10000, 'away'),          // warn
    at(12000, 'away', 1),       // typing
    at(20000, 'away', 1),
  ]);
  assert.deepEqual(actions, [null, null, 'warn', 'cancel-warn', null]);
  assert.equal(state.lockedBySara, false);
});

test('the Watch returning during the countdown cancels it', () => {
  const { actions } = run([at(0, 'present'), at(5000, 'away'), at(10000, 'away'), at(12000, 'present')]);
  assert.deepEqual(actions, [null, null, 'warn', 'cancel-warn']);
});

test('coming back to a machine SARA locked wakes the display, once, and re-arms', () => {
  const locked = run([at(0, 'present'), at(5000, 'away'), at(10000, 'away'), at(15000, 'away')]);
  assert.equal(locked.state.lockedBySara, true);
  const back = run([at(60000, 'present'), at(65000, 'present')], locked.state);
  assert.deepEqual(back.actions, ['wake', null]);
  const again = run([at(70000, 'away'), at(75000, 'away'), at(80000, 'away')], back.state);
  assert.deepEqual(again.actions, [null, 'warn', 'lock']);
});

test('while SARA holds the lock, more "away" does nothing — one lock, not a loop', () => {
  const locked = run([at(0, 'present'), at(5000, 'away'), at(10000, 'away'), at(15000, 'away')]);
  const more = run([at(20000, 'away'), at(25000, 'away'), at(40000, 'away')], locked.state);
  assert.deepEqual(more.actions, [null, null, null]);
});

test('an unlock by any other means (Hello, PIN) releases SARA\'s claim — no surprise wake', () => {
  const locked = run([at(0, 'present'), at(5000, 'away'), at(10000, 'away'), at(15000, 'away')]);
  const released = P.onOSUnlocked(locked.state);
  const { actions } = run([at(30000, 'present')], released);
  assert.deepEqual(actions, [null]);
});

test('a blind reading mid-countdown abandons the lock rather than finishing it', () => {
  const { actions } = run([at(0, 'present'), at(5000, 'away'), at(10000, 'away'), { payload: null, now: T0 + 16000, idleS: 60 }]);
  assert.deepEqual(actions, [null, null, 'warn', 'cancel-warn']);
});
