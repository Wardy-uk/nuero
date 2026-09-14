'use strict';

/**
 * Say it once — the centrepiece and the track must not draw the same thing.
 *
 * ⚠⚠ PHOTOGRAPHED ON THE DESK TABLET, 14 Sep 2026, twice over:
 *
 *   • "Task block: Convert Jira Rejection Reason from free text to select list"
 *     as the CENTREPIECE, with the same words in a corridor card directly
 *     behind it — each half-legible through the other.
 *   • "Nothing in the diary / free until 14:00" in the band top-right AND, word
 *     for word, as the first card on the track.
 *
 * `coveredBy` already existed and already had the right idea. It asked ONE of
 * the three questions: which SECONDARY cards repeat the dashboard. It never
 * asked the reverse — which dashboard ROWS repeat the CENTREPIECE — so a task
 * that was both the primary and a row on the track drew twice. Not an edge
 * case: the primary is very often a thing with an hour, and a thing with an
 * hour is exactly what the corridor carries.
 *
 * The second was a renderer join. `Dashboard` takes `hideRows` in the approach
 * layout because the corridor carries the feed — and `now` sat OUTSIDE the rows
 * block, so it was drawn by the band and by the corridor at once.
 *
 * ⚠ `covered` stays ADVISORY and filters nothing: the pool leaves the composer
 * exactly as it arrived. A renderer that ignores it shows the overlapping
 * screen, never a wrong one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const surface = require('./sara-surface');

const { coveredBy } = surface._internals || surface;

const payload = (over = {}) => ({
  primary: { kind: 'item', id: 'p1', title: 'Task block: Convert Jira Rejection Reason' },
  secondary: [],
  transition: null,
  ...over,
});

const dash = (rows, now = null) => ({ rows, now });

test('⚠ a row that repeats the CENTREPIECE is reported', () => {
  const c = coveredBy(
    payload(),
    dash([
      { what: 'Risk Meeting Prep' },
      { what: 'Task block: Convert Jira Rejection Reason' },
    ])
  );
  assert.deepEqual(c.rowIndexes, [1]);
});

test('⚠ and a transition names its own meeting', () => {
  const c = coveredBy(
    payload({
      primary: null,
      transition: { meta: { subject: 'Team Standup' } },
    }),
    dash([{ what: 'Team Standup' }, { what: 'Nick Catch Up' }])
  );
  assert.deepEqual(c.rowIndexes, [0]);
});

test('⚠ MATCHING IS EXACT, because a false match hides real work', () => {
  // The asymmetry that governs this whole module: a miss shows him something
  // twice, which is the state we were already in; a false match HIDES an item
  // from the list he uses to find what he owes.
  const c = coveredBy(
    payload(),
    dash([{ what: 'Task block: Convert Jira Rejection Reason from free text' }])
  );
  assert.deepEqual(c.rowIndexes, [], 'a near-miss must not be covered');
});

test('⚠ a context primary covers nothing — it is not a thing with a title', () => {
  const c = coveredBy(
    payload({ primary: { kind: 'context', title: 'In a meeting' } }),
    dash([{ what: 'In a meeting' }])
  );
  assert.deepEqual(c.rowIndexes, []);
});

test('⚠ it still answers the question it always answered', () => {
  // The secondary-vs-dashboard direction must not have regressed.
  const c = coveredBy(
    payload({ secondary: [{ kind: 'item', id: 's1', title: 'Risk Meeting Prep' }] }),
    dash([{ what: 'Risk Meeting Prep' }])
  );
  assert.deepEqual(c.cardIds, ['s1']);
});

test('⚠ the corridor honours rowIndexes', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'sara', 'shared-ui', 'AttentionSurface.jsx'), 'utf8');
  assert.match(src, /corridorCards/, 'could not read AttentionSurface.jsx');  // positive control
  assert.match(src, /covered\?\.rowIndexes/, 'the corridor ignores the composer');
  assert.match(src, /if \(coveredRows\.has\(i\)\) return;/);
});

test('⚠ the now band stands down when the corridor is carrying the feed', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'sara', 'shared-ui', 'Dashboard.jsx'), 'utf8');
  assert.match(src, /hideRows/, 'could not read Dashboard.jsx');   // positive control
  assert.match(src, /const showsNow = Boolean\(now\) && !hideRows;/);
  assert.match(src, /\{showsNow && <Now now=\{now\} \/>\}/);
  // ⚠ And `bare` must agree with what is actually drawn, or the approach layout
  // renders a full-chrome panel with nothing in it — which reads as a section
  // that failed to load rather than one deliberately standing down.
  assert.match(src, /const bare = \(hideRows \|\| rows\.length === 0\) && !figure && !showsNow;/);
});
