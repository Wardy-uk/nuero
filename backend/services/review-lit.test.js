'use strict';

/**
 * Review, lit — step 5 of the design build order.
 *
 * ⚠⚠ THE INVERSION'S LAST HIDING PLACE. Review rendered the readiness score as a
 * 34pt bare number over the word "ok", and nothing on the card said which way
 * the scale runs. `stress-score` computes `50 - 18z`, so better recovery gives a
 * LOWER number — read as recovery a 62 is a decent day, read correctly it is an
 * elevated-stress one. The same defect was fixed on iOS's Review on 13 Sep when
 * the inversion was found, and this copy was missed.
 *
 * ⚠ AND `status` WAS NEVER THE FIELD FOR THE JOB: it only ever says "ok",
 * "calibrating" or "stale". The brain's `label` IS the reading, and it licenses
 * nothing — which is why the advice ladder was deleted rather than relabelled.
 *
 * Source scans with positive controls.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const VIEWS = path.resolve(__dirname, '..', '..', 'saim', 'app', 'src', 'views');
const jsx = () => fs.readFileSync(path.join(VIEWS, 'Review.jsx'), 'utf8');
const css = () => fs.readFileSync(path.join(VIEWS, 'Review.css'), 'utf8');
// ⚠ A name inside a comment is not a use — sixth time.
const cssCode = () => css().replace(/\/\*[\s\S]*?\*\//g, '');

test('⚠ the body reading says which way it runs', () => {
  const src = jsx();
  assert.match(src, /s\.readiness/, 'could not read Review.jsx');   // positive control

  // The number alone is readable as a good day or a bad one depending on what
  // the reader assumes — and this app assumed wrong for months.
  assert.match(src, /rev__bigunit/, 'the figure carries no unit');
  assert.match(src, /s\.readiness\.label \? `\$\{s\.readiness\.label\} stress`/,
               "the brain's label must name the reading");
  // ⚠ And no advice. The ladder is deleted everywhere, not relabelled.
  for (const banned of ['Enough for a hard one', 'Enough for an easy one', 'Take it gently']) {
    assert.ok(!src.includes(banned), `advice is back: ${banned}`);
  }
});

test('⚠ PENDING is not UNREAD', () => {
  const src = jsx();
  // "3 items still on this device" wore `rev__unread`'s amber, which means
  // "I could not read this". She can see these perfectly well and he can act on
  // them — there is a Send now button in the same box. Amber-means-unread is
  // the one colour whose meaning is fixed across both apps, and spending it on
  // a merely-pending state is how it stops meaning anything.
  assert.match(src, /<Lit className="rev__pending">/);
  const stillUnread = src.match(/rev__unread">\s*\{unsent\}/);
  assert.equal(stillUnread, null, 'pending is wearing the gap colour again');
  assert.match(cssCode(), /\.rev__pending\s*\{/);
});

test('⚠ every gap is a STATEMENT, and so is every empty section', () => {
  const src = jsx();
  // Six "I couldn't read this" branches and five genuinely-empty ones. Facts
  // with no affordance — no glow, nothing that looks pressable — and a gap is
  // never dressed as a fault.
  const unread = src.match(/<Lit[^>]*className="rev__unread"/g) || [];
  const calm = src.match(/<Lit[^>]*className="rev__calm"/g) || [];
  assert.ok(unread.length >= 5, `expected the gap branches, found ${unread.length}`);
  assert.ok(calm.length >= 4, `expected the empty branches, found ${calm.length}`);
  for (const use of [...unread, ...calm]) assert.match(use, /tone="statement"/, use);
});

test('⚠ this screen is scanned, so its rows carry no glow', () => {
  const src = jsx();
  // Same rule as Tasks: a glow per line is haze rather than hierarchy.
  const rows = src.match(/<Lit[^>]*className="rev__row"/g) || [];
  assert.equal(rows.length, 3, `expected three list bodies, found ${rows.length}`);
  for (const r of rows) assert.match(r, /tone="row"/, r);
  // ⚠ And a review of the day has no single answer, so it spends no lead.
  assert.equal((src.match(/tone="lead"/g) || []).length, 0, 'a review spends no lead');
});

test('⚠ no screen-local palette, and ONE red', () => {
  assert.match(css(), /\.rev__h\b/, 'could not read Review.css');   // positive control
  const sheet = cssCode();
  assert.ok(sheet.length < css().length, 'comment stripping removed nothing');

  const accents = sheet.match(/var\(--accent[^)]*\)/g) || [];
  assert.deepEqual(accents, [], `Review.css still picks the system accent: ${accents.join(', ')}`);
  assert.match(sheet, /var\(--saim-rgb/);
  // `rgba(200, 70, 70)` against the primitive's `rgba(224, 84, 58)` is two reds
  // for one meaning — the same thing Capture had on its stuck item.
  assert.ok(!/200,\s*70,\s*70/.test(sheet), 'a second red is back');
});

test('⚠ the section labels are shared, and nothing overrides their colour', () => {
  const src = jsx();
  const sheet = cssCode();
  assert.equal((src.match(/<LitLabel as="h2" className="rev__h">/g) || []).length, 8);
  // ⚠ THE CASCADE TRAP, third screen running: Review.css is imported AFTER
  // Lit.css, so a `color:` left here wins and keeps the labels grey while every
  // other one in the app moves with her. It compiles perfectly either way.
  const rule = sheet.match(/\.rev__h\s*\{([^}]*)\}/s);
  assert.ok(rule, 'the label rule is gone');
  assert.ok(!/(^|;|\s)color:/.test(rule[1]), 'the label overrides the shared colour');
  assert.ok(!/text-transform/.test(rule[1]), 'the label type is local again');
});
