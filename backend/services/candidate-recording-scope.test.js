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

test('a DIFFERENT recording raising the same commitment is still offered', () => {
  // The asymmetry that keeps this honest: a later meeting discussing the same
  // thing is real signal, and a decision must not suppress it for ever.
  writeNote(`${DIR}/Later Meeting.md`, OTHER_RECORDING);
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
