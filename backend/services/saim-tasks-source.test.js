'use strict';

/**
 * What SAiM's Tasks screen is allowed to offer, and to whom.
 *
 * ⚠ Build 10H: SAiM is NOT the place for task administration. It ticks, marks a
 * NEURO task "working on it", puts things off ("not today") and adds; triage
 * fields, due dates and any write to Planner / To Do are NEURO's, handed off
 * by name. These tests pin that boundary as well as what remains.
 *
 * `saim/app/src/views/Tasks.jsx` is mounted by the phone, the laptop and the Pi
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

const VIEW = path.join(__dirname, '..', '..', 'saim', 'app', 'src', 'views', 'Tasks.jsx');
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

test('positive control: this is the SAiM Tasks view and it still ticks', () => {
  assert.match(src, /export default function Tasks\(/);
  assert.match(src, /completeTask\(item\)/);
  assert.match(src, /\/api\/todos\/focus/);
});

test('the routes SAiM keeps are called — and the editing routes are gone', () => {
  assert.match(src, /\/api\/tasks\/\$\{item\.task_id\}`/, 'WIP on a NEURO task PATCHes the task');
  assert.match(src, /'\/api\/todos\/lane\/defer'/);
  assert.match(src, /'\/api\/todos\/lane\/undefer'/, 'a snooze must have a way back');
  assert.match(src, /'\/api\/capture\/todo'/);
  // Build 10H: no Planner/To Do write, no due-date control, no triage editor.
  assert.doesNotMatch(src, /wip-ms/, 'SAiM must not write progress to Planner / To Do');
  assert.doesNotMatch(src, /DueControl|due_date/, 'due dates are edited in NEURO');
  assert.doesNotMatch(src, /TaskFieldEditor|estimateExact|moscow:\s*draft/, 'triage fields are edited in NEURO');
  assert.equal(fs.existsSync(path.join(__dirname, '..', '..', 'saim', 'app', 'src', 'components', 'DueControl.jsx')), false,
    'DueControl should be deleted, not left unreachable');
});

test('WIP is NEURO-only, and a Microsoft row is handed off to NEURO by name', () => {
  const panel = componentBody('TaskPanel');
  assert.match(panel, /const isNeuro = Boolean\(item\.task_id\)/);
  assert.match(panel, /const isMs = !isNeuro && Boolean\(item\.ms_id\)/);
  assert.match(panel, /\{isNeuro && \(/);
  assert.match(panel, /changed in NEURO \(Tasks\), not here/, 'a Microsoft row must say where its progress is changed');
  assert.equal((panel.match(/status: starting/g) || []).length, 1, 'status is only sent on the NEURO path');
});

test('triage fields hand off to NEURO rather than being edited here', () => {
  const panel = componentBody('TaskPanel');
  assert.match(panel, /open Tasks in NEURO/, 'the hand-off must name where to go');
  assert.doesNotMatch(panel, /method: 'PATCH',\s*body: JSON\.stringify\(body\)/, 'no triage PATCH from SAiM');
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
