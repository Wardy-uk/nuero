'use strict';

/**
 * The todo nudge's "Open" names the task it is about (Nick, 2 Oct 2026) —
 * it opened the whole list, so he had to find the task by hand.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { todoNudgeTarget } = require('./nudges');

const candidate = {
  text: 'SQL pull for Sep 2025',
  task_id: 412, ms_id: null, filePath: null, lineNumber: null,
  message: '"SQL pull for Sep 2025" is still open (7d old). Move it or kill it.',
};

test('a todo nudge carries the handles of the task its message names', () => {
  const t = todoNudgeTarget({ type: 'todo', message: candidate.message }, candidate);
  assert.equal(t.taskId, 412);
  assert.equal(t.taskText, 'SQL pull for Sep 2025');
});

test('a message about a DIFFERENT task gets no target, never the wrong one', () => {
  assert.equal(todoNudgeTarget({ type: 'todo', message: '"Something else" is still open. Move it or kill it.' }, candidate), null);
});

test('non-todo nudges and a missing candidate get nothing', () => {
  assert.equal(todoNudgeTarget({ type: 'standup', message: candidate.message }, candidate), null);
  assert.equal(todoNudgeTarget({ type: 'todo', message: candidate.message }, null), null);
});
