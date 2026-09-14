// The router wedges every ~2-3 weeks and looks perfectly healthy from every
// other screen in the house, because forwarding and DNS are kernel-side and
// keep working while userspace dies. These pin the rules that decide whether
// NEURO can see it coming.
//
// The fixtures are the REAL measurements taken on 14 Sep 2026 — healthy, and
// fully wedged — not invented numbers. The whole finding is what the live box
// actually looked like in each state.
const test = require('node:test');
const assert = require('node:assert');
const { assess, sustainedD, headline, D_SUSTAINED } = require('./router-health');

const NOW = new Date('2026-09-14T20:00:00Z');
const at = (minsAgo) => new Date(NOW.getTime() - minsAgo * 60000).toISOString();

// Measured on the live router immediately after a clean reboot.
const healthy = (over = {}) => ({
  at: at(1), reachable: true, shellOk: true, dstateReadable: true,
  load1: 1.13, load5: 0.90, load15: 0.70, tasks: 140,
  dcount: 0, dprocs: [], memFreeKb: 117616, nvramFree: 6762, ...over,
});

test('a healthy router is ok and raises nothing', () => {
  const a = assess([healthy(), healthy({ at: at(6) })], NOW);
  assert.equal(a.state, 'ok');
  assert.deepEqual(a.issues, []);
});

test('there is no cheerful headline for a healthy router', () => {
  // A surface that always speaks is one nobody reads.
  assert.equal(headline(assess([healthy()], NOW)), null);
});

// ── The inverted alarm ───────────────────────────────────────────────────────
// Everywhere else in NEURO an unreadable source must never read as a fault.
// Here it is THE fault: nothing else makes a shell fail on an idle router.

test('answers ping but cannot run a shell = wedged, not unknown', () => {
  const a = assess([healthy({ shellOk: false, dcount: null, load15: null })], NOW);
  assert.equal(a.state, 'wedged');
  assert.equal(a.issues[0].level, 'critical');
  assert.match(a.issues[0].detail, /fork/i);
});

test('ps failing to fork = wedged', () => {
  const a = assess([healthy({ dstateReadable: false, dcount: null })], NOW);
  assert.equal(a.state, 'wedged');
  assert.match(headline(a), /reboot it/i);
});

test('not answering ping is unreachable, kept distinct from wedged', () => {
  const a = assess([healthy({ reachable: false })], NOW);
  assert.equal(a.state, 'unreachable');
  assert.notEqual(a.state, 'wedged');
});

// ── D state must be SUSTAINED ────────────────────────────────────────────────

test('a single D-state sample is NOT degrading — that is normal disk I/O', () => {
  const a = assess([healthy({ dcount: 6 }), healthy({ at: at(6), dcount: 0 })], NOW);
  assert.equal(a.state, 'ok');
  // It is still worth recording, just not worth alarming about.
  assert.equal(a.issues[0].level, 'info');
});

test('D state sustained across two samples IS degrading', () => {
  const a = assess([
    healthy({ dcount: 8, dprocs: ['asd', 'conn_diag'] }),
    healthy({ at: at(6), dcount: 5 }),
  ], NOW);
  assert.equal(a.state, 'degrading');
  const top = a.issues[0];
  assert.equal(top.level, 'critical');
  assert.match(top.title, /8 processes stuck/);
  // Naming what is stuck is what makes it actionable.
  assert.match(top.detail, /asd/);
});

test('sustainedD returns null on thin history, never false', () => {
  // "I cannot tell yet" and "no" license different words.
  assert.equal(sustainedD([healthy({ dcount: 9 })]), null);
  assert.equal(sustainedD([]), null);
  assert.equal(sustainedD([healthy({ dcount: 9 }), healthy({ dcount: 9 })]), true);
  assert.equal(sustainedD([healthy({ dcount: 9 }), healthy({ dcount: 0 })]), false);
});

test('samples with no dcount do not count towards sustained', () => {
  // A wedged router reports dcount null; that path is `wedged`, and it must not
  // also be quietly satisfying the sustained rule off unreadable samples.
  assert.equal(sustainedD([healthy({ dcount: null }), healthy({ dcount: null })]), null);
});

// ── The real wedged reading ──────────────────────────────────────────────────

test('the load average measured when it actually failed is caught', () => {
  // 250.31 across 1/5/15, with 369 tasks — the real reading on 14 Sep 2026.
  const a = assess([
    healthy({ load1: 250.31, load5: 250.27, load15: 250.24, tasks: 369, dcount: 250 }),
    healthy({ at: at(6), load15: 250.2, tasks: 369, dcount: 249 }),
  ], NOW);
  assert.equal(a.state, 'degrading');
  assert.ok(a.issues.some((i) => /Load average/.test(i.title)));
  assert.ok(a.issues.some((i) => /369 tasks/.test(i.title)));
});

test('a normal busy moment does not trip the load rule', () => {
  // Baseline peaks around 1.5. Crying wolf here costs the real alert.
  assert.equal(assess([healthy({ load15: 2.4 }), healthy({ at: at(6), load15: 3.1 })], NOW).state, 'ok');
});

// ── Unknown is not ok ────────────────────────────────────────────────────────

test('no samples at all is unknown, never ok', () => {
  const a = assess([], NOW);
  assert.equal(a.state, 'unknown');
  assert.match(a.why, /never reported/);
});

test('a stopped watcher is unknown and says it proves nothing about the router', () => {
  const a = assess([healthy({ at: at(45) })], NOW);
  assert.equal(a.state, 'unknown');
  assert.notEqual(a.state, 'ok');
  assert.match(a.issues[0].detail, /says nothing about the router itself/);
});

// ── Slow burn ────────────────────────────────────────────────────────────────

test('nvram running out warns without claiming the box is wedging', () => {
  const a = assess([healthy({ nvramFree: 800 }), healthy({ at: at(6), nvramFree: 800 })], NOW);
  assert.equal(a.state, 'ok');           // a slow burn, not this failure
  assert.match(a.issues[0].title, /nvram/);
  assert.equal(a.issues[0].level, 'warn');
});

test('the nvram level measured on the live box does NOT warn', () => {
  // 6762 bytes free after cleanup, 5342 before. Neither is an alarm; a rule
  // that fires on the normal state of the box is one nobody reads.
  assert.deepEqual(assess([healthy({ nvramFree: 6762 })], NOW).issues, []);
  assert.deepEqual(assess([healthy({ nvramFree: 5342 })], NOW).issues, []);
});

test('MemFree alone never triggers degrading', () => {
  // It moved only 117MB -> 81MB across a TOTAL failure, so it cannot carry an
  // alarm. 81MB must stay silent or the threshold would fire constantly.
  assert.deepEqual(assess([healthy({ memFreeKb: 81120 })], NOW).issues, []);
});

// ── Provenance ───────────────────────────────────────────────────────────────

test('every assessment declares the thresholds are provisional', () => {
  // Two data points is not an onset curve, and no screen may present these as
  // measured until the watcher has captured a real build-up.
  for (const s of [[], [healthy()], [healthy({ shellOk: false })]]) {
    assert.equal(assess(s, NOW).provisional, true);
  }
});

test('D_SUSTAINED sits clear of the measured baseline of zero', () => {
  assert.ok(D_SUSTAINED > 0, 'a bar of 0 would fire on every healthy sample');
});
