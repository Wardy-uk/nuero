'use strict';

/**
 * A commitment that is ALREADY a task is not offered for approval again.
 *
 * `todoAlreadyExists` was meant to be this guard and both of its arms were dead for
 * the case that mattered:
 *
 *   - `sameSource` compared the candidate's note path against the task's, so a
 *     commitment arriving through PLAUD's SECOND summary variant never matched the
 *     task the first variant had created;
 *   - `task.source?.startsWith('Master')` was written for the `Master Todo.md` list
 *     RETIRED on 16 Aug 2026. The live source values are lowercase
 *     (`master-todo-import`, `meeting-promotion`) and `startsWith` is
 *     case-sensitive, so that arm had matched NOTHING since the day the list went.
 *
 * Measured on the live queue: 26 of 36 pending candidates were already tasks, and
 * 21 of those tasks were already DONE — NEURO asking Nick to approve work he had
 * finished.
 *
 * The asymmetry pinned here: an OPEN task suppresses whatever its origin, because
 * one commitment cannot be actioned twice. A DONE task only suppresses within the
 * same recording, because a commitment can genuinely recur and a later meeting
 * raising it again is real signal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-already-task-'));
const vault = path.join(root, 'vault');
fs.mkdirSync(path.join(vault, 'Meetings', '2026', '09'), { recursive: true });
fs.mkdirSync(path.join(vault, 'Tasks'), { recursive: true });
process.env.NEURO_DB_PATH = path.join(root, 'already-task.db');
process.env.OBSIDIAN_VAULT_PATH = vault;

const db = require('../db/database');
const taskStore = require('./task-store');
const { syncNoteActionCandidates } = require('./action-candidates');

const DIR = 'Meetings/2026/09';
const REC_A = 'aaaa1111bbbb2222cccc3333dddd4444';
const REC_B = 'eeee5555ffff6666aaaa7777bbbb8888';

function writeNote(rel, plaudId, commitment) {
  fs.writeFileSync(path.join(vault, rel), [
    '---', 'type: note', `plaud_id: "${plaudId}"`, 'date: 2026-09-17', '---',
    '', '## Next Arrangements', `- ${commitment}`,
  ].join('\n'), 'utf-8');
}

const pending = () => db.getPendingSaimActionsByType('capture_todo', 500);

test.before(async () => { await db.init(); });

test('an OPEN task suppresses the candidate whatever meeting it came from', () => {
  const text = 'Nick to compile productivity stats comparing June and August';
  // Deliberately a DIFFERENT note path from the candidate's, and a lowercase
  // source — the exact shape both dead arms failed on.
  taskStore.createTask({ text, source: 'meeting-promotion', origin_path: `${DIR}/Somewhere Else.md` });

  writeNote(`${DIR}/Open Case.md`, REC_A, text);
  const r = syncNoteActionCandidates(`${DIR}/Open Case.md`);

  assert.equal(r.created, 0, 'a commitment already on the open task list must not be re-offered');
  assert.equal(pending().length, 0);
});

test('a DONE task from the SAME recording suppresses it', () => {
  const text = 'Nick to draft wording on wellbeing impacts for the SLT proposal';
  const created = taskStore.createTask({
    text, source: 'meeting-promotion', origin_path: `${DIR}/Done Same.md`,
  });
  taskStore.updateTask(created.id, { status: 'done' });

  // The other summary variant of that same recording.
  writeNote(`${DIR}/Done Same 2.md`, REC_A, text);
  fs.writeFileSync(path.join(vault, `${DIR}/Done Same.md`), [
    '---', 'type: note', `plaud_id: "${REC_A}"`, '---', '', '## Next Arrangements', `- ${text}`,
  ].join('\n'), 'utf-8');

  const r = syncNoteActionCandidates(`${DIR}/Done Same 2.md`);
  assert.equal(r.created, 0, 'finished work must not come back through another variant');
});

test('a DONE task does NOT suppress a genuinely new sighting from another recording', () => {
  const text = 'Nick to review the quarterly escalation policy';
  const created = taskStore.createTask({
    text, source: 'meeting-promotion', origin_path: `${DIR}/Old Meeting.md`,
  });
  taskStore.updateTask(created.id, { status: 'done' });
  fs.writeFileSync(path.join(vault, `${DIR}/Old Meeting.md`), [
    '---', 'type: note', `plaud_id: "${REC_A}"`, '---', '', '## Next Arrangements', `- ${text}`,
  ].join('\n'), 'utf-8');

  // A LATER, different meeting raises it again. That is new signal, not a duplicate.
  writeNote(`${DIR}/New Meeting.md`, REC_B, text);
  const r = syncNoteActionCandidates(`${DIR}/New Meeting.md`);

  assert.equal(r.created, 1, 'a recurrence raised by a different meeting must still be offered');
});
