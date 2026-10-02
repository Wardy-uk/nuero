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
// `saim/frontend` has no test runner, so `overlapRatio` is exercised directly
// and the wiring is a source scan with a positive control.
//
//   run: npm test   (from saim/backend)

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
test('long content widens the centrepiece', () => {
  const surface = fs.readFileSync(
    path.join(__dirname, '..', '..', 'shared-ui', 'AttentionSurface.jsx'), 'utf8');
  const css = fs.readFileSync(
    path.join(__dirname, '..', '..', 'shared-ui', 'Approach.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  assert.match(surface, /const WIDE_SAY_CHARS = 55;/);
  // ⚠ Judged on EVERYTHING she says, not the title alone: "In a focus session"
  // is eighteen characters with a hundred-and-fifty-character sub-line, and it
  // hit the cap on content the title knew nothing about.
  assert.match(surface, /sayLength\(primary\) >= WIDE_SAY_CHARS/);
  assert.match(surface, /String\(p\.title \|\| ''\)\.length \+ String\(p\.say \|\| ''\)\.length/);

  const wide = css.slice(css.indexOf('.surface--approach .surface__say--wide {'));
  assert.match(wide.slice(0, wide.indexOf('}')), /width: min\(63%/);
});

// ⚠ THE BUDGET HAS TO ADD UP. Measured on the Fire: a 487px stage, and the
// bands were committing 15 + 40 + 24 + 24 = 103%. Each cap was defensible alone
// and together they guaranteed a collision whenever BOTH the centrepiece and the
// flat row were full — which is why it looked intermittent.
// ⚠ REWRITTEN 2 Oct 2026. These two used to pin a percentage BUDGET — the hero's
// top + cap below the row's bottom + cap — and both halves of that budget were
// later removed on purpose: the row's 23% cap on 14 Sep (it sliced the bottoms
// off the cards on the Fire; the clamps became the only bound), and the hero's
// cap on short landscape screens on 2 Oct (it squeezed the headline below its
// own two-line clamp, cutting it through its letters). Arithmetic over numbers
// the file no longer has is a test that fails for ever and gets ignored. What
// is pinned now is the MECHANISM; the gutter itself was MEASURED on a 1024x600
// render of the live kiosk (18px, 2 Oct 2026), because content height cannot
// be read off CSS.
const approachCss = () => fs.readFileSync(
  path.join(__dirname, '..', '..', 'shared-ui', 'Approach.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

test('on a short landscape screen the headline cannot shrink below its clamp', () => {
  const css = approachCss();
  const at = css.lastIndexOf('@media (max-height: 900px) and (min-aspect-ratio: 1/1)');
  assert.ok(at >= 0, 'the short-landscape block exists');
  const block = css.slice(at);
  assert.match(block, /\.surface__saylead \{[^}]*line-clamp: 2/);
  assert.match(block, /\.surface__saylead \{ flex-shrink: 0; \}/);
  assert.match(block, /\.surface__saysub \{[^}]*flex-shrink: 0;[^}]*line-clamp: 1/);
  // Sized by the clamps, not by a % cap — the stacked state keeps its own cap.
  assert.match(block, /\.surface__say:not\(\.surface__say--stacked\) \{[^}]*max-height: none/);
  // The row drops into the space the one-line shelf frees.
  assert.match(block, /\.approach--quiet \.approach__row \{ bottom: 17%; \}/);
});

test('the flat row is bounded by its clamps, not by a height cap', () => {
  const css = approachCss();
  const row = css.slice(css.lastIndexOf('.approach--quiet .approach__row {'));
  assert.doesNotMatch(row.slice(0, row.indexOf('}')), /max-height/,
    'a cap here slices the bottoms off the cards — the clamps are the bound');
  // Clamped rather than sliced: overflow alone cuts letters in half.
  assert.match(css, /\.approach__fact \.approach__val \{[^}]*line-clamp: 3/);
  assert.match(css, /\.approach__fact \.approach__sub \{[^}]*line-clamp: 2/);
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

// ⚠ THE WAY BACK IS NOT PROTECTED BY A CHARACTER COUNT. Measured on the Fire: a
// centrepiece needing 256px in a 198px box, with the utterance row cut off at
// the bottom — and that row ends in "Show me everything", which MANIFESTATION.md
// calls "always last and never dropped" because it is the only way off a surface
// with no menu. The width proxy missed by three characters; the guarantee has to
// be structural.
test('the utterance row refuses to shrink, and the overflow comes out of the words', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', '..', 'shared-ui', 'Approach.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.surface--approach \.surface__say \.surface__says \{ flex: 0 0 auto; \}/);
  // Her sentence clamps instead — legible as "continues", not sliced.
  assert.match(css, /\.surface--approach \.surface__saylead \{[^}]*line-clamp: 4/);
  assert.match(css, /\.surface--approach \.surface__saysub \{[^}]*line-clamp: 3/);
});

// ⚠ THE ROW IS FOUR FIXED COLUMNS. Nick, 14 Sep 2026: "the secondary row of
// cards are now full width, rather than the 1/4 width we agreed on — allowing 4
// cards." `auto-fit` sizes the track count to the content, so the same band was
// a quarter each with four cards and one full-bleed slab with one — and which
// you got depended on how many things the gate was holding back that minute.
test('the flat row is four fixed columns, so one card is a quarter and not a slab', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', '..', 'shared-ui', 'Approach.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const row = css.slice(css.indexOf('.approach--quiet .approach__row {'));
  const body = row.slice(0, row.indexOf('}'));
  assert.match(body, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(body, /auto-fit/);

  // Portrait still stacks two-up — a quarter of a phone is not a card.
  assert.match(css, /max-aspect-ratio[\s\S]*?grid-template-columns: 1fr 1fr/);
});

// ⚠ Fixed columns are only safe because nothing can render a fifth card onto a
// second row, where the band's ceiling would clip it.
test('the quiet branch renders at most four, so the row can never wrap', () => {
  const approach = fs.readFileSync(
    path.join(__dirname, '..', '..', 'shared-ui', 'Approach.jsx'), 'utf8');
  assert.match(approach, /cards\.slice\(0, 4\)\.map/);
});
