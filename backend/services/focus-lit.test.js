'use strict';

/**
 * Focus, lit — step 6 of the design build order.
 *
 * ⚠ THE FINDING HERE IS A RAMP WITH ONE RUNG THAT MOVED. `focus__u--critical`
 * and `--high` are fixed red and amber; `--medium` was `var(--accent)`, the
 * system blue. Now that `--sara-rgb` drives the app, the bottom of a SEVERITY
 * ramp would have moved with her state — so on a day she has gone red, every
 * `medium` row would carry a red edge and read as critical. A ramp has to be
 * self-consistent or it stops being a ramp.
 *
 * That is the same call made for MoSCoW on Tasks and the Personal badge beside
 * it: what an ITEM means keeps its own colours, and only HER state moves with
 * her. The difference here is that the two claims were mixed inside one ramp.
 *
 * Source scans with positive controls.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const VIEWS = path.resolve(__dirname, '..', '..', 'sara', 'app', 'src', 'views');
const jsx = () => fs.readFileSync(path.join(VIEWS, 'Focus.jsx'), 'utf8');
const css = () => fs.readFileSync(path.join(VIEWS, 'Focus.css'), 'utf8');
// ⚠ A name inside a comment is not a use — seventh time.
const cssCode = () => css().replace(/\/\*[\s\S]*?\*\//g, '');

test('⚠ the severity ramp is self-consistent — no rung moves with her', () => {
  const sheet = cssCode();
  assert.match(sheet, /\.focus__u--critical/, 'could not read Focus.css');   // positive control

  const ramp = ['critical', 'high', 'medium'].map((u) => {
    const m = sheet.match(new RegExp(`\\.focus__u--${u}\\s*\\{([^}]*)\\}`, 's'));
    assert.ok(m, `the ${u} rung is gone`);
    return m[1];
  });
  for (const rung of ramp) {
    assert.ok(!/--sara-rgb/.test(rung), 'a severity rung moves with her state');
    assert.ok(!/var\(--accent/.test(rung), 'a severity rung uses the system accent');
  }
});

test('⚠ but the LEAD does move with her', () => {
  const sheet = cssCode();
  // The one card that is the ANSWER rather than a candidate is hers, like the
  // rest of the app. The distinction is the whole point: severity describes the
  // item, her colour describes the day.
  const next = sheet.match(/\.focus__next\s*\{([^}]*)\}/s);
  assert.ok(next, 'the lead edge is gone');
  assert.match(next[1], /--sara-rgb/);
});

test('⚠ exactly ONE lead, and it is the next action', () => {
  const src = jsx();
  assert.match(src, /nextAction/, 'could not read Focus.jsx');   // positive control
  // MANIFESTATION.md's named exception: a screen that genuinely has one answer.
  // "Next action" is that answer by definition. The ranked list below it is not.
  const leads = src.match(/tone="lead"/g) || [];
  assert.equal(leads.length, 1, `expected one lead, found ${leads.length}`);
  assert.match(src, /tone="lead"[\s\S]{0,200}focus__next/);
  // And the candidates are `row` — a glow per line is haze, not hierarchy.
  assert.match(src, /tone="row"[\s\S]{0,120}focus__item/);
});

test('⚠ her briefing is a STATEMENT, and so is an empty list', () => {
  const src = jsx();
  // The briefing is composed server-side and rendered verbatim — the one thing
  // on this screen she actually said. Not a control.
  assert.match(src, /<Lit tone="statement" className="focus__briefing">/);
  assert.match(src, /<Lit tone="statement" className="focus__clear">/);
  assert.match(src, /<Lit tone="statement">Asking the brain/);
});

test('⚠ only a dead backend gets the alarm', () => {
  const src = jsx();
  const sheet = cssCode();
  assert.match(src, /className="focus__fault err"/);
  assert.match(sheet, /\.focus__fault\s*\{[^}]*224, 84, 58/s, 'the one red must be the primitive\'s');
  // No second red anywhere.
  assert.ok(!/200,\s*70,\s*70/.test(sheet));
});

test('⚠ no screen-local palette left, hover included', () => {
  assert.match(css(), /\.focus__tap\b/, 'could not read Focus.css');   // positive control
  const sheet = cssCode();
  assert.ok(sheet.length < css().length, 'comment stripping removed nothing');

  const accents = sheet.match(/var\(--accent[^)]*\)/g) || [];
  assert.deepEqual(accents, [], `Focus.css still picks the system accent: ${accents.join(', ')}`);
  // ⚠ `rgba(76, 154, 255)` is the system accent under another name, and it was
  // on the HOVER state — a card lighting up in a colour she is not in, at the
  // moment he reaches for it.
  assert.ok(!/76,\s*154,\s*255/.test(sheet), 'the hardcoded hover blue is back');
});
