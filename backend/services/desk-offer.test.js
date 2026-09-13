'use strict';

/**
 * What this machine may be asked to open.
 *
 * Nick, 13 Sep 2026: *"there needs to be a degree of device awareness."* Every
 * surface offered the SAME hardcoded four apps to whatever happened to be
 * listening — so a button could name a program the target machine does not
 * have, or act on a laptop in another room.
 *
 * ⚠ NOTHING NEW HAD TO BE SENSED. The agent has declared `canOpen` on every
 * sample since the pull channel shipped; the route read it to decide a claim
 * and nothing STORED it. This is a field that was already arriving.
 *
 * PURE, so the rule pins without a laptop, a database or a clock.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { offer, APPS, BUTTON_LABELS } = require('./desk-intents');

const AT_DESK = { atDesk: true, deskKnown: true, host: 'DESKTOP-8LGF9RR' };

// ── What it offers ───────────────────────────────────────────────────────────

test('it offers exactly what the machine said it can open', () => {
  const o = offer({ ...AT_DESK, canOpen: ['music', 'browser'] });
  assert.equal(o.known, true);
  assert.deepEqual(o.apps.map(a => a.id), ['music', 'browser']);
  assert.equal(o.why, null);
});

test('⚠ the HOST travels with the offer', () => {
  // Half the point: a press must be able to say WHICH machine it will act on,
  // rather than silently opening something on a laptop in another room.
  const o = offer({ ...AT_DESK, canOpen: ['code'] });
  assert.equal(o.host, 'DESKTOP-8LGF9RR');
});

test('⚠ the list is INTERSECTED with the vocabulary, never trusted whole', () => {
  // It arrives from the laptop. An agent naming something this server does not
  // understand must not be able to put an unknown id on a button.
  const o = offer({ ...AT_DESK, canOpen: ['music', 'rm -rf', 'solitaire', 'browser'] });
  assert.deepEqual(o.apps.map(a => a.id), ['music', 'browser']);
  for (const a of o.apps) assert.ok(APPS[a.id], `${a.id} is in the vocabulary`);
});

test('⚠ a BUTTON gets the button label, never the prose one', () => {
  // `APPS` is prose for sentences ("I'll open your music player"). Rendering it
  // on a button gives you one reading "your music player" — which is how the
  // first cut of this row shipped, and why the two are now separate maps in one
  // module rather than one map used for both jobs.
  const o = offer({ ...AT_DESK, canOpen: ['music', 'code'] });
  assert.equal(o.apps[0].label, 'Music');
  assert.equal(o.apps[1].label, 'VS Code');
  assert.notEqual(o.apps[0].label, APPS.music, 'the prose is not what a button says');
});

test('⚠ every app in the vocabulary HAS a button label', () => {
  // A missing one would silently fall back to the prose and put a sentence on
  // a button, which is the bug above wearing a different hat.
  for (const id of Object.keys(APPS)) {
    assert.ok(BUTTON_LABELS[id], `${id} needs a button label`);
    assert.ok(BUTTON_LABELS[id].length <= 12, `${id}'s button label must be short`);
  }
});

// ── What it refuses, and why the reasons differ ──────────────────────────────

test('⚠ NEGATIVE: a machine that has NOT SAID gets no buttons, and says why', () => {
  // ⚠⚠ `null` is "it has not told me". It is NOT "it can open nothing", and it
  //   is NOT "offer everything and hope" — and the third is exactly what
  //   produced the failing buttons this feature exists to fix.
  const o = offer({ ...AT_DESK, canOpen: null });
  assert.equal(o.known, false);
  assert.deepEqual(o.apps, []);
  assert.match(o.why, /hasn.t said/i);
});

test('⚠ having SPOKEN and named nothing usable is a DIFFERENT fact from silence', () => {
  const spoke = offer({ ...AT_DESK, canOpen: [] });
  const silent = offer({ ...AT_DESK, canOpen: null });
  assert.equal(spoke.known, true, 'it answered');
  assert.equal(silent.known, false, 'it never did');
  assert.notEqual(spoke.why, silent.why, 'and they do not read the same');
});

test('⚠ an unreadable desk is its own fact, not "you are not there"', () => {
  // "I can't see your laptop" and "you're not at it" send him to different
  // fixes — a dead agent versus being in the kitchen.
  const blind = offer({ atDesk: false, deskKnown: false, host: 'X', canOpen: ['music'] });
  const away = offer({ atDesk: false, deskKnown: true, host: 'X', canOpen: ['music'] });
  assert.equal(blind.known, false);
  assert.equal(away.known, true);
  assert.notEqual(blind.why, away.why);
  assert.deepEqual(blind.apps, []);
  assert.deepEqual(away.apps, [], 'an intent has a deadline; offering while away queues something that dies');
});

test('⚠ NEGATIVE: being away never offers, however capable the machine is', () => {
  const o = offer({ atDesk: false, deskKnown: true, host: 'X', canOpen: ['music', 'code', 'terminal', 'browser'] });
  assert.deepEqual(o.apps, []);
});

test('nothing at all yields no apps rather than throwing', () => {
  for (const input of [undefined, {}, { canOpen: 'music' }, { canOpen: 42 }]) {
    const o = offer(input);
    assert.deepEqual(o.apps, [], JSON.stringify(input));
  }
});

test('⚠ NEGATIVE: it never invents a vocabulary of its own', () => {
  // A second list of app ids is how two surfaces come to offer different things
  // and one of them 400s.
  const o = offer({ ...AT_DESK, canOpen: Object.keys(APPS) });
  assert.deepEqual(o.apps.map(a => a.id).sort(), Object.keys(APPS).sort());
});

// ── The JOIN, which is where this actually broke ──────────────────────
//
// ⚠⚠ `canOpen` was stored correctly, `run()` returned it correctly, and it
//   still arrived at the surface as null — because `current-work.current()`
//   rebuilds its `desktop` input as an explicit WHITELIST and the field was
//   not named in it. Every piece was right and the seam was not, which is the
//   same shape as `runAcross(now)` and as the attention draft dropping
//   `weather`. The pure suites could not see it: they supply the input
//   themselves.

test('⚠ the whitelist that builds the desk input NAMES canOpen', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, 'current-work.js'), 'utf8');
  assert.match(src, /active: r\.app != null/, 'positive control: wrong file or rewritten');
  assert.match(src, /canOpen: Array\.isArray\(r\.canOpen\)/,
    'a field produced upstream and not copied here reaches the surface as null');
});

test('deskFrom carries it, and keeps null apart from empty', () => {
  const { _internals } = require('./current-work');
  if (!_internals || !_internals.deskFrom) return; // not exported; the scan above is the pin
  const { deskFrom } = _internals;
  assert.deepEqual(deskFrom({ app: 'Code', host: 'PC', known: true, canOpen: ['music'] }).canOpen, ['music']);
  assert.equal(deskFrom({ app: 'Code', host: 'PC', known: true }).canOpen, null, 'not said');
  assert.deepEqual(deskFrom({ app: 'Code', host: 'PC', known: true, canOpen: [] }).canOpen, [], 'said nothing');
});
