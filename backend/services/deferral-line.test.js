'use strict';

/**
 * "You put this off" — in words, once, in the right zone.
 *
 * ⚠⚠ THE SURFACE WAS PRINTING A MACHINE STRING AT HIM. Photographed on the desk
 * tablet, 14 Sep 2026:
 *
 *     1 held — you put this off (waiting-on-someone) until 2026-09-15T12:38:41.575Z.
 *
 * Three things wrong, and the third is the one that showed on screen:
 *
 *   • an identifier is never a label — this repo's own rule, learned when 150
 *     characters of base64 appeared under the words "waiting on you";
 *   • it is UTC, beside a screen of Europe/London times, so an hour out through
 *     the whole of BST;
 *   • at SEVENTY-SEVEN characters it wrapped, and the wrap pushed the foot up
 *     into the flat row. That is the "overlap" six commits of band-height
 *     rebalancing had been chasing: the bands were being budgeted to fit a
 *     string that should never have been that long.
 *
 * ⚠ AND TASKS ALREADY SAID IT PROPERLY, and had since the defer feature
 * shipped. One fact, two vocabularies, and the ambient surface had the worse
 * one — the drift `say` / `speech` / `silence` are composed server-side to stop.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { describeDeferral, describeUntil, REASON_LABELS } = require('../../shared/deferral-line.cjs');

// A Monday afternoon, London time (13:00 UTC = 14:00 BST).
const NOW = new Date('2026-09-14T13:00:00Z');
const opts = { now: NOW, timeZone: 'Europe/London' };

test('⚠ the live line, as photographed', () => {
  assert.equal(
    describeDeferral('waiting-on-someone', '2026-09-15T12:38:41.575Z', opts),
    'blocked on someone, until tomorrow 13:38'
  );
});

test('⚠ it is the SCREEN\'s zone, not UTC', () => {
  // 12:38Z in September is 13:38 in London. Printing the Z string put the held
  // line an hour behind every other time on the same screen.
  const line = describeDeferral('too-big', '2026-09-14T15:00:00.000Z', opts);
  assert.match(line, /until 16:00$/, line);
  // And the DAY comparison is made on the same zone's calendar, or "tomorrow
  // 00:30" comes to mean tonight.
  assert.equal(describeUntil('2026-09-14T23:30:00.000Z', opts), 'until tomorrow 00:30');
});

test('⚠ no slug reaches the screen', () => {
  // `waiting-on-someone` is a key in a map. Printing it hands the reader the
  // thing the code uses to look something up.
  for (const slug of Object.keys(REASON_LABELS)) {
    const line = describeDeferral(slug, null, opts);
    assert.ok(!line.includes('-') || slug === 'unspecified', `slug leaked: ${line}`);
  }
});

test('⚠ an unrecognised reason falls through to ITSELF, not to "none"', () => {
  // A reason NEURO recorded and this map has not learned is still information.
  // Replacing it with "no reason given" would be inventing an absence.
  assert.match(describeDeferral('brand-new-reason', null, opts), /^brand-new-reason/);
});

test('⚠ nothing is invented when there is no time to state', () => {
  assert.equal(describeDeferral('not-now', null, opts), 'not today');
  assert.equal(describeDeferral('not-now', 'not-a-date', opts), 'not today');
  assert.equal(describeUntil(null, opts), '');
  // An unreadable `now` cannot place a date, so it says nothing rather than
  // guessing which side of today it falls.
  assert.equal(describeUntil('2026-09-15T09:00:00Z', { now: 'rubbish' }), '');
});

test('⚠ a time already gone says so, rather than reading as the future', () => {
  // Narrow window — a spent deferral is released on the next pass — but a
  // confident wrong tense is worse than an honest vague one.
  assert.equal(describeUntil('2026-09-13T09:00:00Z', opts), 'and that has passed');
});

test('⚠ the line is short enough not to wrap the foot', () => {
  // The length IS the bug. Every shape it can take, against the string it
  // replaced (77 characters with the prefix the composer added).
  const cases = [
    ['waiting-on-someone', '2026-09-15T12:38:41.575Z'],
    ['no-context', '2026-09-18T08:30:00.000Z'],
    ['too-big', '2026-10-30T08:30:00.000Z'],
    ['unspecified', null],
  ];
  for (const [r, u] of cases) {
    const full = `1 held — ${describeDeferral(r, u, opts)}.`;
    assert.ok(full.length <= 56, `${full.length} chars: ${full}`);
  }
});

test('⚠ the composer uses it, and no longer interpolates the instant', () => {
  const src = fs.readFileSync(path.resolve(__dirname, 'attention.js'), 'utf8');
  assert.match(src, /deferredKeys/, 'could not read attention.js');   // positive control
  assert.match(src, /describeDeferral\(entry\.reason, entry\.until/);
  assert.ok(!/until \$\{entry\.until\}/.test(src), 'the raw instant is back');
  // ⚠ And the zone is the screen's, read from config — never the host's, which
  // on the Pi is UTC.
  assert.match(src, /process\.env\.NEURO_TIMEZONE \|\| 'Europe\/London'/);
});
