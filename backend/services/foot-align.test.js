'use strict';

/**
 * A container is not drawn for content it does not have.
 *
 * ⚠⚠ PHOTOGRAPHED 14 Sep 2026: "2 held — blocked on someone, until tomorrow
 * 13:38." sat visibly ABOVE the middle of the shelf cards beside it, despite
 * both bands being bottom-anchored to the same 4%.
 *
 * `surface__footrow` is a flex row with `padding-top: 0.5rem`, and it rendered
 * whether or not the escape hatch inside it was showing — which it usually is
 * not, because the composer already ends the utterance list with "Show me
 * everything" and printing it again would say it twice, a foot apart. So the
 * foot reserved about 22px of NOTHING below its text, and being bottom-anchored
 * that lifted the visible line by the same amount.
 *
 * ⚠ THE SAME SHAPE AS `Dashboard`'s `bare`, fixed earlier the same day: a box
 * with nothing in it is invisible and still takes the room, so every layout
 * measured against it is measured against a lie.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SURFACE = path.resolve(__dirname, '..', '..', 'sara', 'app', 'src', 'views', 'Surface.jsx');
const src = () => fs.readFileSync(SURFACE, 'utf8');

test('⚠ the foot row renders NOTHING when it has nothing', () => {
  const s = src();
  assert.match(s, /surface__footrow/, 'could not read Surface.jsx');   // positive control
  // The whole row is conditional now, not the button inside it.
  assert.match(s, /footExtra=\{[\s\S]{0,900}?!hasRevealUtterance \? \(/);
  assert.match(s, /\) : null\}/);
  // And the button is no longer separately gated — one condition, one place.
  assert.ok(!/\{!hasRevealUtterance && \(\s*<button type="button" className="surface__all"/.test(s),
            'the row is back, with the gate inside it');
});

test('⚠ the escape hatch still appears when the sentence is missing', () => {
  const s = src();
  // The rule this must not break: hidden ONLY where the utterance exists AND
  // this shell can act on one. Either missing and the button comes back —
  // a hatch that vanishes because a composition failed is what strands him.
  assert.match(s, /hasRevealUtterance/);
  assert.match(s, /Show me everything<\/button>/);
  const decl = s.match(/const hasRevealUtterance = ([^;]+);/);
  assert.ok(decl, 'the gate is gone');
  assert.match(decl[1], /reveal/, 'the gate no longer keys on the reveal intent');
});
