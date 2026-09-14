'use strict';

/**
 * What he can say back, on one line — and the way out on its own.
 *
 * ⚠⚠ FIVE PILLS WILL NOT FIT ONE LINE AT ANY LEGIBLE SIZE. Measured, not
 * eyeballed: the live set ("Coming up" / "Not now — an hour" / "It's too big" /
 * "Seen it" / Show me everything) needs about 668px including gaps, and the
 * centrepiece is `min(42%, 545px)` — about 505px inside its padding. A third
 * short. No font tweak closes that, and widening the box far enough would put
 * her sentence over the corridor.
 *
 * ⚠ THE FIFTH IS NOT THE SAME KIND OF THING, and that is the way out of it.
 * Four are ANSWERS — sentences he says back to her. "Show me everything" is the
 * WAY OUT: `kind: reveal`, always last, never dropped, because the one screen
 * with no menu must always have a way round it. It takes its own line
 * deliberately, so the block reads as her sentence → what you can say → the way
 * out, rather than as a list that ran out of room.
 *
 * Nick, 14 Sep 2026: "the suggestions are wrapping now."
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SHARED = path.resolve(__dirname, '..', '..', 'sara', 'shared-ui');
const read = (f) => fs.readFileSync(path.join(SHARED, f), 'utf8');
const code = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const surface = require('./sara-surface');

test('⚠ the way out takes its own line', () => {
  const css = code(read('Approach.css'));
  assert.match(css, /\.surface--approach \.surface__say/, 'could not read Approach.css'); // positive control

  const quiet = css.match(/\.surface--approach \.surface__say \.surface__say-btn--quiet \{([^}]*)\}/s);
  assert.ok(quiet, 'the hatch no longer gets its own line');
  assert.match(quiet[1], /flex:\s*0 0 100%/);
});

test('⚠ the answers are tightened enough to hold one line', () => {
  const css = code(read('Approach.css'));
  const pill = css.match(/\.surface--approach \.surface__say \.surface__say-btn \{([^}]*)\}/s);
  assert.ok(pill, 'the answer pills took the base size back');
  // Four at the BASE size measure ~507px against ~505 available, which is not a
  // fit — it is a coincidence waiting for a longer phrase.
  assert.match(pill[1], /font-size:\s*clamp\(/);
  assert.match(pill[1], /padding:/);
});

test('⚠ the hatch is still LAST and still never dropped', () => {
  // The rule the layout above depends on: if the composer stopped putting it
  // last, a `flex-basis: 100%` in the middle of the row would break the line in
  // two for no reason — so the two are pinned together.
  const composer = fs.readFileSync(path.resolve(__dirname, 'sara-surface.js'), 'utf8');
  assert.match(composer, /Show me everything/, 'the escape hatch is gone');
  assert.match(composer, /kind: 'reveal'/, 'the hatch lost the intent the CSS keys on');

  // And it really is last in a composed list.
  const built = surface.compose
    ? surface.compose({ primary: { kind: 'item', id: 'x', title: 'A thing', urgency: 'high' },
                        secondary: [], context: { activity: 'steady' }, quiet: false,
                        poolAvailable: true, gaps: [], dropped: [] })
    : null;
  if (built && Array.isArray(built.utterances) && built.utterances.length > 1) {
    const last = built.utterances[built.utterances.length - 1];
    assert.equal(last.intent && last.intent.kind, 'reveal',
                 'the hatch is no longer last — the row would break in the middle');
  }
});

test('⚠ the renderer still emits one list and marks the hatch by INTENT', () => {
  const src = read('AttentionSurface.jsx');
  // ⚠ No wrapper element and no index check: the composer returns ONE list, and
  // which entry is the hatch is the intent it already carries. A renderer that
  // had to know "the last one is special" is a second place that can be wrong
  // about it.
  assert.match(src, /u\.intent && u\.intent\.kind === 'reveal' \? ' surface__say-btn--quiet' : ''/);
});
