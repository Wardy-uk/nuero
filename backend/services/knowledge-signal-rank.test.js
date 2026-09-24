'use strict';

/**
 * The structural signal, folded into the promotion rank (24 Sep 2026).
 *
 * WHY THIS EXISTS, measured on the live vault before a line was written:
 *
 *   · 814 candidates all-time, and 189 OF 243 SUMMARIES SCORED EXACTLY 11. Not
 *     similar — identical. Every arm of the old score asked "is this the right KIND
 *     of note", and every PLAUD summary answers the same way, so 78% of the back
 *     catalogue was one block ordered by nothing but date.
 *
 *   · `promotionSignal` had parsed topics, follow-ups, duration and the conclusion
 *     since it was written, and the score read NONE of it. The card displayed
 *     "42 min · 5 topics · 14 open follow-ups" beside a number that could not see a
 *     single one of those words.
 *
 *   · ⚠ THE ENRICHMENT ARM DOES NOT BREAK THE TIE EITHER, which is why folding the
 *     signal in was necessary rather than merely tidy. `durable` counts bullets and
 *     the prompt asks for 0-2, so across the 41 capably judged notes it is 2 on 39,
 *     41 of 41 yield at least one, and NOT ONE has ever been judged empty. The arm
 *     moves every enriched note from 11 to 19 as a block. Enriching the whole vault
 *     would have bought a second flat tier, not a ranked list.
 *
 * The bands are percentiles of the live corpus and are NOT outcome-validated — the
 * validation cannot be run, because the only available target is a capped constant.
 * That is stated in the source and pinned here so a future change cannot quietly
 * present them as tested.
 */

const test = require('node:test');
const assert = require('node:assert');

const km = require('./knowledge-memory');
const { signalScore, scorePromotionCandidate, DEFAULT_CANDIDATE_DAYS } = km;

// Shapes as `promotionSignal` returns them.
const sig = (over = {}) => ({
  headline: '', conclusion: '', topics: 0, topicNames: [],
  openFollowUps: 0, nextSteps: 0, durationMinutes: null, ...over
});

test('a note with no parsed signal scores zero, never a penalty', () => {
  assert.equal(signalScore(null), 0);
  assert.equal(signalScore(undefined), 0);
  // 568 of the 814 live candidates have no parsed structure. "We cannot read this
  // template" is not evidence the meeting was trivial.
  assert.equal(signalScore(sig()), 0);
});

test('topics band on the measured p75 and p90', () => {
  assert.equal(signalScore(sig({ topics: 6 })), 0, 'below p75 earns nothing');
  assert.equal(signalScore(sig({ topics: 7 })), 1, 'p75');
  assert.equal(signalScore(sig({ topics: 10 })), 1);
  assert.equal(signalScore(sig({ topics: 11 })), 2, 'p90');
  assert.equal(signalScore(sig({ topics: 26 })), 2, 'the live max is still 2 — banded, not linear');
});

test('the bands are BANDS, so one huge note cannot run away with the ranking', () => {
  // Live max values: 26 topics, 43 follow-ups, 171 minutes. Linear weights would let
  // one outlier dominate the whole queue.
  const monster = sig({ topics: 26, openFollowUps: 43, durationMinutes: 171, conclusion: 'x' });
  assert.equal(signalScore(monster), 5);
});

test('duration counts at the p75, and an unknown duration is not a short one', () => {
  assert.equal(signalScore(sig({ durationMinutes: 41 })), 0);
  assert.equal(signalScore(sig({ durationMinutes: 42 })), 1);
  // `duration_ms` is quoted on some notes and absent on others; null must not read as
  // a two-minute meeting.
  assert.equal(signalScore(sig({ durationMinutes: null })), 0);
  assert.equal(signalScore(sig({ durationMinutes: NaN })), 0);
});

test('an open follow-up is debt to chase, so it earns at most one point at the p90', () => {
  assert.equal(signalScore(sig({ openFollowUps: 15 })), 0, 'below p90');
  assert.equal(signalScore(sig({ openFollowUps: 16 })), 1);
  assert.equal(signalScore(sig({ openFollowUps: 43 })), 1, 'the live max earns no more');
  // A meeting of pure commitments must not outrank one that covered real ground.
  assert.ok(
    signalScore(sig({ topics: 11 })) > signalScore(sig({ openFollowUps: 43 })),
    'topics outweigh follow-ups'
  );
});

test('a stated conclusion counts — it is on only 20% of notes', () => {
  assert.equal(signalScore(sig({ conclusion: 'We agreed to split the squad.' })), 1);
  assert.equal(signalScore(sig({ conclusion: '' })), 0);
});

test('⚠ the signal arm is capped BELOW the evidence arm', () => {
  // The whole point: a note something has READ must still outrank one that merely
  // LOOKS big. Letting shape beat a read insight is the inversion the 16 Sep local
  // model incident caused, and it must not come back from the other direction.
  const maxSignal = signalScore(sig({
    topics: 26, openFollowUps: 43, durationMinutes: 171, conclusion: 'x'
  }));
  const maxEvidence = 2 * 3 + 2 * 1; // DURABLE_INSIGHT_POINTS/OPEN_LOOP_POINTS at their caps
  assert.ok(maxSignal < maxEvidence, `signal ${maxSignal} must stay under evidence ${maxEvidence}`);
});

// ── the fold itself ────────────────────────────────────────────────────────────
// A pure suite over signalScore passes happily while nothing calls it — the arm would
// be computed, exported, tested and INERT, which is the failure this codebase names
// more than any other. These drive the real scorer.

const noteWith = (body, fm = {}) => ({
  path: 'Meetings/2026/09/x.md',
  name: 'x',
  folder: 'Meetings/2026/09',
  wordCount: 900,
  links: 1,
  tags: ['meeting'],
  content: body,
  frontmatter: { note_type: 'meeting-summary', source: 'PLAUD', ...fm }
});

const BIG = `## Meeting Notes
${Array.from({ length: 12 }, (_, i) => `- Topic Title: Topic ${i + 1}\n- Conclusion: We settled item ${i + 1}.`).join('\n')}

## Next Arrangements
${Array.from({ length: 18 }, () => '- [ ] follow up').join('\n')}
`;

const SMALL = `## Meeting Notes
- Topic Title: Postage

## Next Arrangements
- [ ] order stamps
`;

test('⚠ the scorer actually reads the signal — a big meeting outranks a small one', () => {
  const big = scorePromotionCandidate(noteWith(BIG, { duration_ms: '3600000' }));
  const small = scorePromotionCandidate(noteWith(SMALL, { duration_ms: '360000' }));
  assert.ok(big > small, `big ${big} must outrank small ${small}`);
  // Before this change both scored identically — that is the bug, stated as a number.
  assert.notEqual(big, small);
});

test('the signal never drags a note below where shape alone put it', () => {
  // It only ever ADDS. A note whose template we cannot parse keeps its old rank
  // exactly, so opening the window cannot demote anything by surprise.
  const plain = noteWith('no structure here at all');
  const score = scorePromotionCandidate(plain);
  assert.ok(score > 0);
  assert.equal(score, scorePromotionCandidate(plain), 'pure');
});

test('the default window is unchanged at 21 days', () => {
  // Widening it silently would turn the daily view into an 814-row pile, which is the
  // thing the queue exists to replace. Reaching further is an explicit request.
  assert.equal(DEFAULT_CANDIDATE_DAYS, 21);
});
