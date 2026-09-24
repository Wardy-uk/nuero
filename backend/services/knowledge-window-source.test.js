'use strict';

/**
 * The window control is WIRED, not merely drawn.
 *
 * ⚠ A SCAN RATHER THAN A RENDER, deliberately, and the reason is the component: the
 * panel fetches in `useEffect`, which `renderToString` never runs, so a render test
 * here would assert nothing but the loading state and pass whatever the buttons do.
 * The `people-board-source` / `desktop-attention-source` idiom applies instead — with
 * a positive control, so a broken scan cannot pass by absence.
 *
 * What it pins is the failure this codebase names more than any other, in its UI form:
 * a control that renders, looks live, and changes nothing. Two ways that happens here,
 * both silent and both indistinguishable from a working button:
 *
 *   · the fetch does not carry `daysBack`, so "All time" re-requests 21 days
 *   · `fetchData` does not depend on `windowDays`, so pressing it never refetches at all
 *
 * And one way the screen starts lying: the stat copy used to say "the last 21 days" as
 * a hard-coded literal, so with the window open it would have claimed three weeks over
 * a count of 814.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PANEL = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'InsightsPanel.jsx');
const src = fs.readFileSync(PANEL, 'utf-8');

// Comments explain the rules and must not satisfy them — this file has been bitten
// three separate times by a name matched inside a comment.
const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const code = stripComments(src);

test('positive control — this is the panel, and it still has a promotion queue', () => {
  assert.match(code, /Promotion Queue/, 'wrong file, or the scan is broken');
  assert.match(code, /knowledge-memory\/overview/);
});

test('⚠ the overview fetch carries the window', () => {
  assert.match(
    code,
    /knowledge-memory\/overview\?daysBack=\$\{windowDays\}/,
    'without this "All time" silently re-requests the default 21 days'
  );
});

test('⚠ the fetch re-runs when the window changes', () => {
  // `useCallback(..., [])` is the trap: the button sets state, nothing refetches, and
  // the screen sits on the old list looking perfectly healthy.
  assert.match(code, /\}, \[windowDays\]\);/, 'fetchData must depend on windowDays');
});

test('both windows are offered, and the wide one reaches the back catalogue', () => {
  assert.match(code, /setWindowDays\(21\)/);
  assert.match(code, /setWindowDays\(3650\)/);
  assert.match(code, /Last 21 days/);
  assert.match(code, /All time/);
});

test('the default window is 21 — the daily view must not become an 814-row pile', () => {
  assert.match(code, /useState\(21\)/);
});

test('⚠ the stat copy READS the window instead of restating it', () => {
  assert.match(code, /counts\.promotionWindowDays/, 'the line must come from the payload');
  // The old literal, which would have claimed three weeks over the whole vault.
  assert.doesNotMatch(
    code,
    /Likely signal in the last 21 days/,
    'the window must never be hard-coded in the copy again'
  );
});
