'use strict';

/**
 * The `## EOD` section has two generations, and the history view knew one.
 *
 * The old guided flow wrote `**Win:**`, `**Didn't go to plan:**`, `**Feeling:**`.
 * The session renderer that replaced it on 14 Aug 2026 writes `**Done:**` as a
 * bullet list plus `**Mood:**` — and `GET /api/standup/eod-history` was never
 * updated, so it went on matching the old labels and returned
 * `win: null, feeling: null` for every EOD written since.
 *
 * Measured on the live vault: 7 notes in the new shape, 4 in the old. The view
 * was blank for the majority of the entries it exists to show, with no error and
 * no empty list — the wrong-label species this repo has already paid for as
 * `sleep_core_hours`, `meeting_alert` and `summary_type`.
 *
 * (!) The fixtures are REAL sections lifted off the Pi, not invented ones. The
 * whole finding is that plausible-looking output was wrong on Nick's actual
 * data, and invented fixtures would have agreed with the broken parser.
 *
 * PURE, so this pins without a vault.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseEodEntry, parseDailyNote } = require('./standup-accountability');

// Daily/2026-03-24.md, byte for byte, nav footer included.
const LEGACY = `## EOD — 2026-03-24

**Win:** Made some progress on nova data - reckon I can close that off tomorrow

**Didn't go to plan:** The whole day - didn't achieve any of my todos

**Feeling:** Some stress - tough day today

<!-- daily-nav -->
_← [[2026-03-23]] | [[2026-03-25]] →_
`;

// Daily/2026-09-08.md — seven items, which is why `win` must stay null.
const CURRENT = `## EOD

**Done:**
- Ticket type analysis for Mel
- Ticket breakdown for Annabel
- Spec for aged/blocked/cross-team tickets report
- Prep for Risk meeting
- AI messaging workflow proposal scoped
- Focus supports conversation with Naomi
- Cut two tasks down to startable size
**Didn't go to plan:** Catch-up with Chris left him questioning his capability
**Mood:** Rough
`;

// Daily/2026-09-16.md — a single item, so it IS the day's win.
const SINGLE = `## EOD

**Done:**
- Got Sara properly working
**Didn't go to plan:** Nothing — we achieved a lot and ended in a good space
**Tomorrow starts with:** The podcast
**Mood:** Tired but content
`;

// ── 1. Legacy ───────────────────────────────────────────────────────────────

test('legacy Win + Feeling still parse', () => {
  const e = parseEodEntry(LEGACY);
  assert.equal(e.win, 'Made some progress on nova data - reckon I can close that off tomorrow');
  assert.equal(e.feeling, 'Some stress - tough day today');
  assert.match(e.didntGo, /^The whole day/);
  // A named win IS a done item, so the normalised list carries it and no
  // consumer has to know which generation wrote the note.
  assert.deepEqual(e.done, ['Made some progress on nova data - reckon I can close that off tomorrow']);
});

test('the nav footer is not swallowed into a field', () => {
  const e = parseEodEntry(LEGACY);
  for (const v of [e.win, e.feeling, e.didntGo, ...e.done]) {
    assert.doesNotMatch(String(v), /daily-nav|\[\[2026-03-2/);
  }
});

// ── 2. Current ──────────────────────────────────────────────────────────────

test('THE REPORTED BUG: current Done + Mood no longer read as nulls', () => {
  const e = parseEodEntry(CURRENT);
  assert.equal(e.feeling, 'Rough', 'Mood fills the feeling slot');
  assert.equal(e.done.length, 7);
  assert.equal(e.done[0], 'Ticket type analysis for Mel');
  assert.equal(e.done[6], 'Cut two tasks down to startable size');
  assert.match(e.didntGo, /^Catch-up with Chris/);
});

test('⚠ seven done items do NOT become a fabricated "win"', () => {
  // Neither picking the first nor joining them is a win: it is emphasis the note
  // never expressed. `done` carries the day; `win` stays honestly empty.
  const e = parseEodEntry(CURRENT);
  assert.equal(e.win, null);
});

test('a LONE done item is that day\'s win, and fills the slot', () => {
  const e = parseEodEntry(SINGLE);
  assert.equal(e.win, 'Got Sara properly working');
  assert.deepEqual(e.done, ['Got Sara properly working']);
  assert.equal(e.feeling, 'Tired but content');
});

test('didntGo is VERBATIM here, including "Nothing"', () => {
  // ⚠ The divergence from parseDailyNote, which nulls a "Nothing" because for
  // accountability that means nothing went wrong. A history view renders what he
  // wrote. Both are pinned so a future tidy-up cannot quietly merge them.
  assert.match(parseEodEntry(SINGLE).didntGo, /^Nothing/);
  assert.equal(parseDailyNote(SINGLE).didntGo, null);
});

test('a label the history does not model is ignored, not misfiled', () => {
  // SINGLE carries `**Tomorrow starts with:**`; it must not land in any field.
  const e = parseEodEntry(SINGLE);
  for (const v of [e.win, e.feeling, e.didntGo, ...e.done]) {
    assert.doesNotMatch(String(v), /podcast/i);
  }
});

// ── 3. Mixed / partial ──────────────────────────────────────────────────────

test('a mixed note takes the first non-empty feeling and keeps both done sources', () => {
  const mixed = `## EOD

**Win:** Shipped the thing
**Done:**
- Cleared the queue
- Wrote the report
**Feeling:** Steady
**Mood:** Also steady
`;
  const e = parseEodEntry(mixed);
  assert.equal(e.win, 'Shipped the thing');
  assert.equal(e.feeling, 'Steady', 'first non-empty wins; the second does not overwrite it');
  assert.deepEqual(e.done, ['Shipped the thing', 'Cleared the queue', 'Wrote the report']);
});

test('partially populated entries keep what is there and nothing else', () => {
  const onlyMood = parseEodEntry('## EOD\n\n**Mood:** Flat\n');
  assert.deepEqual(onlyMood, { done: [], win: null, didntGo: null, feeling: 'Flat' });

  const onlyDone = parseEodEntry('## EOD\n\n**Done:**\n- One thing\n- Another\n');
  assert.equal(onlyDone.feeling, null);
  assert.equal(onlyDone.didntGo, null);
  assert.equal(onlyDone.win, null);
  assert.equal(onlyDone.done.length, 2);
});

// ── 4. Absence is absence ───────────────────────────────────────────────────

test('⚠ missing fields are genuinely null — nothing is fabricated', () => {
  const bare = parseEodEntry('## EOD\n\n**Done:**\n- Only this\n');
  assert.equal(bare.didntGo, null);
  assert.equal(bare.feeling, null);
  // An EMPTY label is absent, never the empty string: a falsy-but-present value
  // renders as a blank row rather than as no row.
  const blank = parseEodEntry('## EOD\n\n**Win:**\n**Feeling:**\n');
  assert.equal(blank.win, null);
  assert.equal(blank.feeling, null);
  assert.deepEqual(blank.done, []);
});

test('no section, an empty section, and unusable input all return null', () => {
  assert.equal(parseEodEntry('# Day\n\n## Focus Today\n- [ ] a\n'), null);
  assert.equal(parseEodEntry('## EOD\n\n\n'), null);
  for (const bad of [null, undefined, '', 0, {}, []]) {
    assert.equal(parseEodEntry(bad), null, JSON.stringify(bad));
  }
});

test('CRLF notes parse — half the vault is CRLF and \\r is a line terminator', () => {
  const e = parseEodEntry(CURRENT.replace(/\n/g, '\r\n'));
  assert.equal(e.feeling, 'Rough');
  assert.equal(e.done.length, 7);
  for (const v of [e.feeling, e.didntGo, ...e.done]) assert.doesNotMatch(String(v), /\r/);
});

// ── 5. Equivalence where the semantics overlap ──────────────────────────────

test('⚠ both generations produce the SAME shape for the same day', () => {
  // The point of normalising at the parser boundary: a consumer must not be able
  // to tell which generation wrote the note.
  const asLegacy = parseEodEntry(
    "## EOD\n\n**Win:** Closed the Guild backlog\n**Didn't go to plan:** Nothing\n**Feeling:** Good\n");
  const asCurrent = parseEodEntry(
    "## EOD\n\n**Done:**\n- Closed the Guild backlog\n**Didn't go to plan:** Nothing\n**Mood:** Good\n");
  assert.deepEqual(asLegacy, asCurrent);

  // And the keys are identical whichever generation is read, so no consumer has
  // to branch on format.
  assert.deepEqual(Object.keys(parseEodEntry(LEGACY)).sort(),
    Object.keys(parseEodEntry(CURRENT)).sort());
});

// ── The reader ──────────────────────────────────────────────────────────────

test('⚠ `done` has a READER — a payload field nobody renders is the usual bug', () => {
  // The dominant failure mode in this codebase is a value computed for honesty,
  // carried on a payload and read by nothing. `win` stays null on 6 of the 7
  // new-format notes BY DESIGN, so without this row those entries render empty
  // and the fix is invisible on the one screen that shows them.
  const panel = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'InsightsPanel.jsx'), 'utf8');
  assert.match(panel, /entry\.done\?\.length > 1/, 'InsightsPanel must render the done list');
  // Positive control: the field it replaced is still rendered too, or a broken
  // scan would pass by absence.
  assert.match(panel, /entry\.win &&/);
});
