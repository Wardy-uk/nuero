'use strict';

/**
 * What SARA's Tasks screen is allowed to offer, and to whom.
 *
 * `sara/app/src/views/Tasks.jsx` is mounted by the phone, the laptop and the Pi
 * kiosk, and has no test runner of its own. Every rule here fails silently if it
 * regresses — a WIP button on a vault line that 400s, a triage editor on a
 * Microsoft row writing to a task that does not exist, a similar-task warning
 * reading a field the route never sends. None of them throws.
 *
 * Source scans, with a positive control, because nothing at runtime can see a
 * control that should not be there.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const VIEW = path.join(__dirname, '..', '..', 'sara', 'app', 'src', 'views', 'Tasks.jsx');
const src = fs.readFileSync(VIEW, 'utf8');

// The body of one named function component, up to the next top-level function.
function componentBody(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} must exist`);
  const next = src.indexOf('\nfunction ', start + 1);
  const nextExport = src.indexOf('\nexport default function ', start + 1);
  const ends = [next, nextExport].filter((i) => i !== -1);
  return src.slice(start, ends.length ? Math.min(...ends) : undefined);
}

test('positive control: this is the SARA Tasks view and it still ticks and dates', () => {
  assert.match(src, /export default function Tasks\(/);
  assert.match(src, /completeTask\(item\)/);
  assert.match(src, /<DueControl /);
  assert.match(src, /\/api\/todos\/focus/);
});

test('the four routes are called', () => {
  assert.match(src, /\/api\/tasks\/\$\{item\.task_id\}`/, 'WIP on a NEURO task PATCHes the task');
  assert.match(src, /'\/api\/todos\/wip-ms'/, 'WIP on a Microsoft row goes to Planner / To Do');
  assert.match(src, /'\/api\/todos\/lane\/defer'/);
  assert.match(src, /'\/api\/todos\/lane\/undefer'/, 'a snooze must have a way back');
  assert.match(src, /\/api\/tasks\/\$\{taskId\}`, \{ method: 'PATCH'/, 'triage fields save in one PATCH');
  assert.match(src, /'\/api\/capture\/todo'/);
});

test('WIP is gated by owner: NEURO status for task_id, Microsoft progress only for an unowned ms row', () => {
  const panel = componentBody('TaskPanel');
  assert.match(panel, /const isNeuro = Boolean\(item\.task_id\)/);
  assert.match(panel, /const isMs = !isNeuro && Boolean\(item\.ms_id\)/, 'a linked NEURO row must not go to wip-ms');
  assert.match(panel, /\{isNeuro && \(/);
  assert.match(panel, /\{isMs && msProgressKnown && \(/);
  // Never lower progress this button did not set.
  assert.match(panel, /pct == null \|\| pct === 0 \|\| pct === 50/);
  assert.match(panel, /your team sees this/, 'a Planner write must say who reads it');
  // A vault line has no status to carry — status: must only be sent from the NEURO path.
  assert.equal((panel.match(/status: starting/g) || []).length, 1);
});

test('the triage editor is NEURO-only, drafted, and names what is unsaved', () => {
  const panel = componentBody('TaskPanel');
  assert.match(panel, /\{isNeuro && \(\s*taskRow\s*\?\s*<TaskFieldEditor/, 'MoSCoW/priority/estimate only on NEURO rows');
  const editor = componentBody('TaskFieldEditor');
  assert.match(editor, /Unsaved:/);
  assert.match(editor, /estimateExact = true/, 'a typed estimate is sent as exact');
  // Nothing in the editor writes on click — only Save does.
  assert.equal((editor.match(/apiFetch\(/g) || []).length, 1, 'one write: the Save PATCH');
});

test('"not today" sends a reason from the server set and is only offered on a lane row', () => {
  for (const key of ['too-big', 'waiting-on-someone', 'no-context', 'not-now']) {
    assert.match(src, new RegExp(`key: '${key}'`), `reason ${key} offered`);
  }
  const panel = componentBody('TaskPanel');
  assert.match(panel, /\) : laneRow \? \(/, 'defer controls render only for a lane row');
  assert.match(src, /laneHeld/, 'what is held back is shown');
});

test('the similar-task warning reads `similar` and never blocks the add', () => {
  const tasks = componentBody('Tasks');
  assert.match(tasks, /res\?\.similar/);
  assert.match(tasks, /both are on the list now/, 'says the task WAS created');
  assert.doesNotMatch(tasks, /task-dedupe\/merge/, 'no auto-merge from the phone');
});
