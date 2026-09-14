// A corridor card whose TITLE is behind her sentence is not a card.
//
// Photographed on the work Fire, 14 Sep 2026. The centrepiece is opaque and
// correctly in front — near occludes far, which is the corridor's whole
// argument — but two cards had their label and title covered and their subtitle
// showing below her, so the panel carried an orphaned
// "*Resolvable at previous tier · Insufficient information · …*" attached to
// nothing. A card cut at the waist reads as broken rather than as distant.
//
// ⚠ THE TEST THAT MATTERS IS WHICH RECTANGLE IS ASKED ABOUT. Coverage of the
// whole card is the obvious rule and is the wrong one, in a way that is
// invisible until you see it on glass: a card 60% covered from the BOTTOM still
// reads perfectly — its title is showing — while one 60% covered from the TOP is
// exactly the broken case. So the rule asks about the TITLE, and these tests
// pin both directions.
//
// `sara/frontend` has no test runner, so `overlapRatio` is exercised directly
// and the wiring is a source scan with a positive control.
//
//   run: npm test   (from sara/backend)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const srcPath = path.join(__dirname, '..', '..', 'shared-ui', 'Approach.jsx');
const src = fs.readFileSync(srcPath, 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// The pure half, lifted out so it can be run without a DOM or a bundler.
const overlapRatio = (() => {
  const at = src.indexOf('export function overlapRatio');
  assert.ok(at >= 0, 'overlapRatio not found — every assertion below would be vacuous');
  const body = src.slice(at, src.indexOf('\n}', at) + 2).replace('export ', '');
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return overlapRatio;`)();
})();

const rect = (left, top, right, bottom) => ({ left, top, right, bottom });

test('positive control — the scan is reading the real component', () => {
  assert.match(code, /useEclipsed/);
  assert.match(code, /approach__val/);
});

test('a title fully behind her is fully covered', () => {
  assert.equal(overlapRatio(rect(10, 10, 20, 20), rect(0, 0, 100, 100)), 1);
});

test('a title clear of her is not covered at all', () => {
  assert.equal(overlapRatio(rect(200, 200, 300, 300), rect(0, 0, 100, 100)), 0);
  // Touching edges is not overlapping.
  assert.equal(overlapRatio(rect(100, 0, 200, 100), rect(0, 0, 100, 100)), 0);
});

test('half a title behind her is half covered — the threshold is a real edge', () => {
  assert.equal(overlapRatio(rect(0, 0, 100, 100), rect(50, 0, 150, 100)), 0.5);
});

// ⚠ Degenerate input must be 0, never NaN: NaN >= ECLIPSE is false, which would
// hide nothing, but NaN <= anything is also false and the next person to write
// a rule on this would get a silent wrong answer.
test('a zero-sized or missing rect is 0, never NaN', () => {
  assert.equal(overlapRatio(rect(5, 5, 5, 5), rect(0, 0, 100, 100)), 0);
    assert.equal(overlapRatio(null, rect(0, 0, 100, 100)), 0);
  assert.equal(overlapRatio(rect(0, 0, 10, 10), null), 0);
});

test('it judges the TITLE, not the whole card', () => {
  assert.match(code, /querySelector\('\.approach__val'\)/);
  // The bottom-covered case must survive: a card whose subtitle is clipped but
  // whose title is showing is a card.
  const title = rect(0, 0, 100, 20);      // top of the card
  const her = rect(0, 40, 100, 200);      // covering the bottom only
  assert.equal(overlapRatio(title, her), 0);
});

// ⚠ THE CORRECTION THAT CAME OFF THE PANEL. Averaged over a three-line title the
// live offender measured 0.46 and was left alone, so it went on showing two
// lines of a sentence whose beginning was hidden. Asking about the FIRST LINE
// calls the same card at 0.92.
test('the rule asks about the first line, not the whole title', () => {
  assert.match(code, /firstLineOf\(title\)/);
  assert.match(code, /getClientRects\(\)/);

  const her = rect(62, 115, 490, 310);
  // The real card, measured off the 14 Sep photograph: three lines, x 45..265,
  // y 235..385, with only the top line behind her.
  const wholeTitle = rect(45, 235, 265, 385);
  assert.ok(overlapRatio(wholeTitle, her) < 0.5, 'the averaged rule let this through');
  const firstLine = rect(45, 235, 265, 285);
  assert.ok(overlapRatio(firstLine, her) >= 0.5, 'the first-line rule must catch it');
});

test('the threshold is half, and it is named rather than inlined', () => {
  assert.match(code, /const ECLIPSE = 0\.5;/);
  assert.match(code, />= ECLIPSE/);
});

// ⚠ The failure mode of finding the centrepiece by selector is that a rename
// silently stops the fading. That must fail SAFE — nothing faded, i.e. exactly
// the behaviour before this existed — and never hide a card on a guess.
test('no centrepiece, no layout, or no ResizeObserver fades nothing', () => {
  assert.match(code, /if \(rect && rect\.right > rect\.left\)/);
  assert.match(code, /typeof ResizeObserver === 'undefined'/);
  assert.match(code, /const next = new Set\(\);/);
});

// The selector it reaches for has to still be what AttentionSurface renders.
test('AttentionSurface still renders the centrepiece this looks for', () => {
  const surface = fs.readFileSync(
    path.join(__dirname, '..', '..', 'shared-ui', 'AttentionSurface.jsx'), 'utf8');
  assert.match(surface, /surface__say/);
  assert.match(code, /querySelector\('\.surface__say'\)/);
});

// ⚠ An invisible button over the corridor is a trap on a touchscreen.
test('an eclipsed card is untappable and unreachable, not merely transparent', () => {
  assert.match(code, /pointerEvents: dark \? 'none' : undefined/);
  assert.match(code, /tabIndex=\{dark \|\| p\.depth > 0\.8 \? -1 : 0\}/);
  assert.match(code, /aria-hidden=\{dark \|\| undefined\}/);
});

// ⚠ It must not measure on every render: the stage re-renders on pointer move.
test('measurement is keyed on a signature, not run every render', () => {
  assert.match(code, /const sig = placed/);
  assert.match(code, /\[sig, box\.w, box\.h, heroTick/);
  // And the state update must be a no-op when nothing changed, or it re-renders
  // itself for ever.
  assert.match(code, /prev\.size === next\.size/);
});

// The card is hidden, never dropped — this file decides nothing about the feed.
test('nothing is removed from the feed, only darkened', () => {
  assert.doesNotMatch(code, /placed\s*\.filter/);
  assert.match(code, /opacity: dark \? '0'/);
});

// ── A long title buys WIDTH, not HEIGHT ────────────────────────────────────
// Nick, 14 Sep 2026: "the primary card could be made 50% wider when the task is
// big enough, meaning it doesn't have to be so high." Height is the expensive
// dimension on a 600px panel — it is what pushes her into the corridor's band —
// and the space to the right of her above the track is empty.
test('a long title widens the centrepiece and LOWERS its cap', () => {
  const surface = fs.readFileSync(
    path.join(__dirname, '..', '..', 'shared-ui', 'AttentionSurface.jsx'), 'utf8');
  const css = fs.readFileSync(
    path.join(__dirname, '..', '..', 'shared-ui', 'Approach.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  assert.match(surface, /const WIDE_TITLE_CHARS = 60;/);
  // Judged on the TITLE — the line that wraps — never on the whole payload.
  assert.match(surface, /primary && primary\.title[\s\S]{0,80}WIDE_TITLE_CHARS/);
  assert.match(surface, /surface__say--wide/);

  // ⚠ Widening WITHOUT lowering the cap is the worst of both: a very long title
  // would keep its height and spend the width as well.
  const wide = css.slice(css.indexOf('.surface--approach .surface__say--wide {'));
  const body = wide.slice(0, wide.indexOf('}'));
  assert.match(body, /width: min\(63%/);
  assert.match(body, /max-height: 34%/);
});

// ⚠ Scoped to the corridor. The phone reads the same payload in portrait, where
// the box is already 92% wide and this must change nothing.
test('the wide rule never reaches the phone', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', '..', 'shared-ui', 'Approach.css'), 'utf8');
  for (const m of css.matchAll(/^(.*surface__say--wide.*)\{/gm)) {
    assert.match(m[1], /\.surface--approach/, `unscoped rule: ${m[1].trim()}`);
  }
});

// ── The quiet layout is the one that was actually on screen ────────────────
// Measured over DevTools on the Fire, 14 Sep 2026: zero `.approach__card`, one
// `.approach__fact`. The overlap Nick photographed is the FLAT row, not the
// corridor — so the bands, not the cards, are what had to be bounded.
test('the flat row is capped and its titles clamped, so it cannot grow into her', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', '..', 'shared-ui', 'Approach.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const row = css.slice(css.lastIndexOf('.approach--quiet .approach__row {'));
  assert.match(row.slice(0, row.indexOf('}')), /max-height: 24%/);
  // Clamped rather than sliced: overflow alone cuts letters in half.
  assert.match(css, /\.approach__fact \.approach__val \{[^}]*line-clamp: 3/);
});

// ⚠ Decided on the cards it RENDERS, with the SAME parser that places them.
// It read `corridorCards` alone while rendering `[...corridorCards, ...rest]`,
// and re-implemented a narrower time parser than `minutesOf` — so a timed card
// arriving via `rest`, or carrying a bare HH:MM, left the corridor stood down
// with a future hour on the screen.
test('quiet is judged on every card handed to the corridor, via one parser', () => {
  const surface = fs.readFileSync(
    path.join(__dirname, '..', '..', 'shared-ui', 'AttentionSurface.jsx'), 'utf8');
  assert.match(surface, /import Approach, \{ minutesOf \} from '\.\/Approach'/);
  assert.match(surface, /quiet=\{!\[\.\.\.corridorCards, \.\.\.rest\]\.some/);
  assert.match(surface, /const at = minutesOf\(c\.at\)/);
  // The narrower inline copy must be gone, or the two can disagree again.
  assert.doesNotMatch(surface, /c\.at\.match\(\/T\(\d\{2\}\)/);
});

// `minutesOf` is the one parser, and it takes both shapes.
test('minutesOf accepts an ISO stamp and a bare clock time', () => {
  const approach = fs.readFileSync(
    path.join(__dirname, '..', '..', 'shared-ui', 'Approach.jsx'), 'utf8');
  const at = approach.indexOf('export function minutesOf');
  const body = approach.slice(at, approach.indexOf('\n}', at) + 2).replace('export ', '');
  // eslint-disable-next-line no-new-func
  const minutesOf = new Function(`${body}; return minutesOf;`)();
  assert.equal(minutesOf('2026-09-14T15:30:00+01:00'), 15 * 60 + 30);
  assert.equal(minutesOf('15:30'), 15 * 60 + 30);
  assert.equal(minutesOf('not a time'), null);
  assert.equal(minutesOf(null), null);
});
