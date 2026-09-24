'use strict';

/**
 * What a paid pass would actually read, and the button that says so.
 *
 * ⚠⚠ THE BUG THIS EXISTS FOR: the pass took the newest `limit` summaries and hash-checked
 * each one INSIDE the loop. With the 53 most recent notes already enriched, a limit-25
 * run reported "25 unchanged, 0 enriched" and never reached the 300 older notes that had
 * never been read. It cost nothing, changed nothing, and looked entirely healthy — which
 * from a button is indistinguishable from a button that does not work. Filtering before
 * the slice makes `limit` mean CALLS SPENT, which is what a bounded, paid, human-triggered
 * pass should be bounded by.
 *
 * ⚠ And the panel quotes its cost from the SAME predicate the run uses. Two separately
 * computed numbers would drift, on a control that spends money per note.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const km = require('./knowledge-memory');
const { needsEnrichment } = km;

const crypto = require('crypto');
// Mirrors sourceHashForContent, including the prompt version — deliberately recomputed
// here rather than imported, so a silent change to either side shows up as a failure.
const note = (over = {}) => ({
  path: 'Meetings/2026/09/x.md',
  content: '## Meeting Notes\n- Topic Title: Something\n',
  // Values copied off live notes: all 26 in Meetings/2026/09 carry note_type "summary"
  // AND plaud_summary_type. An invented `meeting-summary` is NOT a summary to
  // isSummaryNote — which this fixture got wrong first time, and the test caught.
  frontmatter: { note_type: '"summary"', plaud_summary_type: '"auto_sum_note"', source: 'PLAUD', ...over }
});

test('a never-enriched summary needs reading', () => {
  assert.equal(needsEnrichment(note()), true);
});

test('a note enriched by a LOCAL model needs reading, whatever its hash says', () => {
  // isCapableJudge's rule: a 1.5b verdict was never counted, so it must never block its
  // own correction. 35 live notes are in exactly this state.
  assert.equal(needsEnrichment(note({
    saim_ai_provider: '"ollama"',
    saim_ai_source_hash: 'whatever',
    saim_ai_enriched_at: '"2026-09-16T10:00:00Z"'
  })), true);
});

test('⚠ a note enriched under an OLDER PROMPT_VERSION needs reading again', () => {
  // The hash covers the prompt, so a stale hash means "we would not get the same
  // answer" — which is the question the skip check actually stands in for.
  assert.equal(needsEnrichment(note({
    saim_ai_provider: '"anthropic"',
    saim_ai_source_hash: '"a-hash-from-the-v1-prompt"',
    saim_ai_enriched_at: '"2026-09-16T10:00:00Z"'
  })), true);
});

test('a transcript is never a target — the summary of it is', () => {
  // Spending a call on 11,000 words of unattributed speech, read through a 3,500-char
  // window, when the write-up is right there.
  //
  // ⚠ THE FIXTURE IS THE LIVE SHAPE, and getting it wrong is how this test first
  // failed: all 352 transcripts in the vault carry note_type "transcript" and ZERO
  // carry plaud_summary_type, so `plaud_summary_type: undefined` here is a fact about
  // the data, not a convenience. (isSummaryNote's second branch would call a note with
  // BOTH a summary; no note is in that state, so the precedence is unexercised and is
  // deliberately not "fixed" on a hypothetical.)
  assert.equal(needsEnrichment(note({
    note_type: '"transcript"', plaud_summary_type: undefined
  })), false);
});

test('⚠ the pass filters BEFORE the slice, so `limit` means calls spent', () => {
  // A source scan, because proving it behaviourally needs a vault of 25+ enriched notes
  // plus a live model. The ORDER is the whole fix, and it is invisible in any output.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, 'knowledge-memory.js'), 'utf-8');
  const body = src.slice(src.indexOf('async function enrichPromotionCandidates'));
  const filterAt = body.indexOf('needsEnrichment(note)');
  const sliceAt = body.indexOf('.slice(0, limit)');
  assert.ok(filterAt > 0, 'positive control: the pass uses the shared predicate');
  assert.ok(sliceAt > 0, 'positive control: the pass is still bounded');
  assert.ok(filterAt < sliceAt, 'the skip check must come BEFORE the bound');
});

test('⚠ the panel quotes its cost from the same predicate, never its own count', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, 'knowledge-memory.js'), 'utf-8');
  assert.match(src, /promotionUnenriched: rankedCandidates\.filter\(needsEnrichment\)/);

  const panel = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'InsightsPanel.jsx'), 'utf-8');
  assert.match(panel, /counts\.promotionUnenriched/, 'the button reads the served count');
  // ⚠ And quotes it against ELIGIBLE notes. Live, the 21-day window holds 63 candidates
  // and 3 summaries; "3 of 63" claims 60 were read when 60 were never readable.
  assert.match(src, /promotionEnrichable: rankedCandidates\.filter\(isSummaryNote\)/);
  assert.match(panel, /promotionEnrichable/, 'the denominator is readable notes');
  assert.ok(
    !/promotionUnenriched\} of \$\{knowledge\.counts\.promotionCandidates/.test(panel),
    'never quoted against the whole candidate list'
  );
  // ⚠ And it sends the window it is SHOWING, or the quoted cost describes another list.
  assert.match(panel, /daysBack: windowDays/, 'the run covers what is on screen');
});

test('⚠ a partial run is reported as partial', () => {
  // "8 read" alone reads as a queue with nothing left to do. The hourly cap makes a
  // long run stopping early the NORMAL case, not an edge one.
  const fs = require('fs');
  const path = require('path');
  const panel = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'InsightsPanel.jsx'), 'utf-8');
  assert.match(panel, /stoppedEarly/, 'the panel renders the partial flag');
  assert.match(panel, /budgetNote/, "and the server's own explanation of why");
  // A refusal keeps its own words rather than becoming a generic failure.
  assert.match(panel, /result\.error/, 'a refusal is shown verbatim');
});
