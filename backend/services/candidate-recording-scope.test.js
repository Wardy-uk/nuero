'use strict';

/**
 * A commitment Nick has already answered does not come back through the other
 * summary variant of the same recording.
 *
 * PLAUD emits several summary variants per recording and `imports` routes each one
 * into `Meetings/` as its own note — "<title>.md", "<title> 2.md". They are ONE
 * meeting carrying the same commitments in the same words. Every defence in
 * `action-candidates` was scoped to the note PATH, so the second variant bypassed
 * all of them at once: `alreadyTracked` looked at the wrong note's actions, the
 * review state was empty, and `todoAlreadyExists` compared a path that could not
 * match. The answer Nick had already given was invisible.
 *
 * Measured on the live queue the day this was written: 36 pending, 31 of them
 * word-for-word re-raises (score 1.000) of commitments already decided — 30 already
 * APPROVED INTO TASKS, 21 of those already DONE — and every single one from a
 * different note path than the one he decided on (samePath=0, differentPath=31).
 *
 * The rules pinned here:
 *   - a decision carries to every variant of the SAME recording;
 *   - it does NOT carry to a different recording, because a later meeting raising
 *     the same commitment is a genuine new sighting and must still be offered;
 *   - unknown recording never matches unknown, or every non-PLAUD note would be
 *     "the same recording" as every other.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-rec-scope-'));
const vault = path.join(root, 'vault');
fs.mkdirSync(path.join(vault, 'Meetings', '2026', '09'), { recursive: true });
process.env.NEURO_DB_PATH = path.join(root, 'rec-scope.db');
process.env.OBSIDIAN_VAULT_PATH = vault;

const db = require('../db/database');
const candidates = require('./action-candidates');
const { syncNoteActionCandidates, rememberReviewedAction } = candidates;

const DIR = 'Meetings/2026/09';
const RECORDING = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER_RECORDING = '00112233445566778899aabbccddeeff';

// A real commitment shape off the live vault — ownership stated in the prose, which
// is what extractMeetingActions reads.
const COMMITMENT = 'Nick Ward to run a morning catch-up with contacts and update Filippo';

function writeNote(rel, plaudId, body = COMMITMENT) {
  const lines = ['---', 'type: note'];
  if (plaudId) lines.push(`plaud_id: "${plaudId}"`);
  lines.push('date: 2026-09-17', '---', '', '## Next Arrangements', `- ${body}`);
  fs.writeFileSync(path.join(vault, rel), lines.join('\n'), 'utf-8');
}

function pending() {
  return db.getPendingSaimActionsByType('capture_todo', 500);
}

function decideAll(status) {
  for (const action of pending()) {
    db.updateSaimActionStatus(action.id, status);
    rememberReviewedAction(action, status);
  }
}

test.before(async () => { await db.init(); });

test('the first variant of a recording raises its commitment', () => {
  writeNote(`${DIR}/Weekly Meeting.md`, RECORDING);
  const r = syncNoteActionCandidates(`${DIR}/Weekly Meeting.md`);
  assert.ok(r.created > 0, 'expected the commitment to be raised on first sight');
  assert.equal(pending().length, 1);
});

test('REJECTED: the second summary variant does NOT raise it again', () => {
  decideAll('rejected');
  assert.equal(pending().length, 0, 'guard: the queue should be empty after deciding');

  writeNote(`${DIR}/Weekly Meeting 2.md`, RECORDING);
  const r = syncNoteActionCandidates(`${DIR}/Weekly Meeting 2.md`);

  assert.equal(r.created, 0, 'a rejected commitment must not return via another variant');
  assert.equal(pending().length, 0);
});

test('a DIFFERENT recording REWORDING the commitment is still offered', () => {
  // The asymmetry that keeps this honest: a later meeting genuinely discussing
  // the same ground is real signal, and a decision must not suppress it for
  // ever. Note the wording MUST differ — an identical sentence is the same
  // extraction arriving twice and is suppressed by the exact-match rule below.
  writeNote(`${DIR}/Later Meeting.md`, OTHER_RECORDING,
    'Nick Ward to arrange a follow-up with Filippo about the consent-mapping backlog');
  const r = syncNoteActionCandidates(`${DIR}/Later Meeting.md`);

  assert.equal(r.created, 1, 'a genuinely new sighting must still reach the queue');
  assert.equal(pending().length, 1);
});

test('unknown recording never matches unknown', () => {
  decideAll('rejected');

  // Two notes with NO plaud_id are not "the same recording". Letting null match
  // null would make every daily note and email-sourced candidate share one
  // decision memory and suppress unrelated commitments wholesale.
  writeNote(`${DIR}/No Id A.md`, null, 'Nick to book the Thursday deployment window');
  syncNoteActionCandidates(`${DIR}/No Id A.md`);
  decideAll('rejected');

  writeNote(`${DIR}/No Id B.md`, null, 'Nick to book the Thursday deployment window');
  const r = syncNoteActionCandidates(`${DIR}/No Id B.md`);

  assert.equal(r.created, 1, 'an unknown recording must not inherit another note\'s decision');
});

test('sameRecording requires both sides to be known', () => {
  const { sameRecording } = candidates;
  assert.equal(typeof sameRecording, 'function', 'positive control: the helper must be exported, or this test passes by absence');
  assert.equal(sameRecording(null, null), false);
  assert.equal(sameRecording('abc', null), false);
  assert.equal(sameRecording(null, 'abc'), false);
  assert.equal(sameRecording('abc', 'abc'), true);
});

test('the of_ prefix is canonicalised, so a pre-15-Sep note matches a later one', () => {
  const rec = 'ffeeddccbbaa99887766554433221100';
  writeNote(`${DIR}/Prefixed.md`, rec, 'Nick to renew the Telemetry licence');
  syncNoteActionCandidates(`${DIR}/Prefixed.md`);
  decideAll('rejected');

  // Same recording, id written in the newer `of_` form.
  writeNote(`${DIR}/Prefixed 2.md`, `of_${rec}`, 'Nick to renew the Telemetry licence');
  const r = syncNoteActionCandidates(`${DIR}/Prefixed 2.md`);

  assert.equal(r.created, 0, 'of_<id> and <id> are one recording — see shared/plaud-id.cjs');
});

/**
 * An identical sentence from a DIFFERENT meeting is the same extraction, not a
 * new sighting.
 *
 * The first cut of this fix kept cross-recording re-raises on the grounds that a
 * later meeting revisiting a topic is genuine signal. Live, that left 5 of 6
 * survivors as score-1.000 re-raises of decisions already made — four already
 * rejected once. Nick: "some of the 10 left is the spotted section I've already
 * done." A genuine revisit is worded differently; an identical one is not.
 *
 * Bounded to DECISION_MEMORY_DAYS so this never becomes permanent suppression,
 * which is the thing this file has always refused.
 */
test('an EXACT re-raise from a different recording is not offered again', () => {
  const text = 'Nick Ward to speak offline with Charlie Keough about the cancelled CIA alert';
  writeNote(`${DIR}/Meeting X.md`, 'c0ffee00c0ffee00c0ffee00c0ffee00', text);
  syncNoteActionCandidates(`${DIR}/Meeting X.md`);
  decideAll('rejected');

  writeNote(`${DIR}/Meeting Y.md`, 'beefbeefbeefbeefbeefbeefbeefbeef', text);
  const r = syncNoteActionCandidates(`${DIR}/Meeting Y.md`);

  assert.equal(r.created, 0, 'the same sentence he already rejected must not return');
});

test('a REWORDED commitment from a different recording IS still offered', () => {
  // Not identical, so it could be a real revisit — the asymmetry that keeps this
  // from becoming a blanket "never show me this again".
  writeNote(`${DIR}/Reword A.md`, '1111222233334444555566667777aaaa',
    'Nick to review the escalation policy before the board meeting');
  syncNoteActionCandidates(`${DIR}/Reword A.md`);
  decideAll('rejected');

  writeNote(`${DIR}/Reword B.md`, '9999888877776666555544443333bbbb',
    'Nick to rewrite the escalation policy and circulate it to the leadership team');
  const r = syncNoteActionCandidates(`${DIR}/Reword B.md`);

  assert.equal(r.created, 1, 'different wording may be a genuine new commitment');
});

test('the cross-recording memory EXPIRES, so nothing is suppressed for ever', () => {
  const { recentExactDecision, DECISION_MEMORY_DAYS, buildSemanticSignature } = candidates;
  assert.equal(typeof recentExactDecision, 'function', 'positive control');
  const sig = buildSemanticSignature('Nick to renew the annual insurance policy');
  db.setState(`note_action_review_sig:${sig}`, JSON.stringify({
    status: 'rejected', at: new Date(Date.now() - (DECISION_MEMORY_DAYS + 1) * 86400000).toISOString(),
  }));
  assert.equal(recentExactDecision(sig), null, 'a decision older than the window must not suppress');

  db.setState(`note_action_review_sig:${sig}`, JSON.stringify({
    status: 'rejected', at: new Date().toISOString(),
  }));
  assert.ok(recentExactDecision(sig), 'a recent one must');
});

test('an undateable or unreadable decision suppresses NOTHING', () => {
  const { recentExactDecision, buildSemanticSignature } = candidates;
  const sig = buildSemanticSignature('Nick to book the annual fire drill');
  db.setState(`note_action_review_sig:${sig}`, JSON.stringify({ status: 'rejected' }));
  assert.equal(recentExactDecision(sig), null, 'no timestamp means the window cannot be honoured');
  db.setState(`note_action_review_sig:${sig}`, 'not json');
  assert.equal(recentExactDecision(sig), null, 'an unreadable entry must not hide work');
});
