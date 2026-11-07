'use strict';

/**
 * What SAiM's Tasks screen offers, and through which routes.
 *
 * ⚠ 7 Nov 2026 — the Build 10H boundary ("SAiM ticks; triage is NEURO's") is
 * LIFTED (audit F16/G): the phone is where tasks get captured, and sending Nick
 * to the desk to set a MoSCoW meant un-triaged tasks ranked wrong until he sat
 * down. SAiM now triages (MoSCoW, priority, estimate) through the SAME routes
 * the desktop uses, sets progress on a Microsoft task, starts a focus session,
 * delegates, and works the Spotted queue through the BOUNDED intake routes.
 *
 * `saim/app/src/views/Tasks.jsx` is mounted by the phone, the laptop and the Pi
 * kiosk, and has no test runner of its own. Every rule here fails silently if it
 * regresses. Source scans, with a positive control.
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

test('positive control: this is the SAiM Tasks view and it still ticks — through the ONE shared helper', () => {
  assert.match(src, /export default function Tasks\(/);
  assert.match(src, /completeTaskOutcome\(item\)/);
  assert.match(src, /\/api\/todos\/focus/);
});

test('a tick reacts to what happened: only a real done strikes through; the rest say so on the row', () => {
  const tasks = componentBody('Tasks');
  assert.match(tasks, /if \(wentDone\(outcome\)\)/, 'repeated / rolled / refused rows are not painted done');
  assert.match(src, /<TickOutcome outcome=\{outcomes\[item\.id\]\}/, 'the outcome is said on the row');
  assert.doesNotMatch(tasks, /setState\(\(s\) => \(\{ \.\.\.s, error: error\.message \}\)\);\s*\} finally \{\s*setBusy/, 'a refused tick is not a page-wide fault');
  assert.match(src, /<JiraHint item=\{item\}/, 'a Jira-linked row says which ticket closes it');
});

test('the routes SAiM calls — and triage uses the desktop\'s writes', () => {
  assert.match(src, /\/api\/tasks\/\$\{item\.task_id\}`/, 'a NEURO task PATCHes the task');
  assert.match(src, /\/api\/todos\/ms\/\$\{encodeURIComponent\(item\.ms_id\)\}\/local/, 'a Microsoft task writes NEURO\'s own annotation');
  assert.match(src, /'\/api\/todos\/wip-ms'/, 'progress on a Microsoft task');
  assert.match(src, /'\/api\/todos\/lane\/defer'/);
  assert.match(src, /'\/api\/todos\/lane\/undefer'/, 'a snooze must have a way back');
  assert.match(src, /'\/api\/capture\/todo'/);
  assert.match(src, /import TaskDue from '\.\.\/\.\.\/\.\.\/shared-ui\/TaskDue\.jsx'/, 'the due date uses the shared control');
  assert.match(componentBody('TaskPanel'), /<TaskDue[\s\S]*readOnly=\{platformNow\(\) === 'kiosk'\}/, 'read-only on the kiosk');
  const panel = componentBody('TaskPanel');
  for (const word of ['MoSCoW', 'Priority', 'Estimate']) assert.match(panel, new RegExp(`tasks__label">${word}<`), `${word} is triaged here`);
  assert.doesNotMatch(panel, /open Tasks in NEURO|changed in NEURO \(Tasks\), not here/, 'no hand-off lines for things SAiM can now do');
});

test('Start, Delegate and Not today come from saim/shared-ui', () => {
  const panel = componentBody('TaskPanel');
  assert.match(panel, /<StartFocus/, 'SAiM Tasks gets Start');
  assert.match(panel, /<DelegateTasks todo=\{item\} call=\{agentCall\}/, 'and Delegate');
  assert.match(panel, /<NotToday[\s\S]*onDefer=\{deferWith\}/, 'the shared "Not today" picker');
  assert.match(panel, /\) : laneRow \? \(/, 'defer controls render only for a lane row');
  assert.match(src, /laneHeld/, 'what is held back is shown');
  assert.doesNotMatch(src, /const NOT_TODAY_REASONS = \[/, 'no local copy of the reasons');
});

test('Spotted suggestions use the BOUNDED intake routes, never /api/actions', () => {
  assert.match(src, /\/api\/todos\/suggestions\/\$\{ids\[i\]\}\/\$\{v\}/);
  assert.match(src, /todos\.value\?\.suggested/);
  assert.doesNotMatch(src, /\/api\/actions/);
});

test('the similar-task warning reads `similar` and never blocks the add', () => {
  const tasks = componentBody('Tasks');
  assert.match(tasks, /res\?\.similar/);
  // 7 Nov 2026: the task IS created, then "Same as #N? Merge / Keep both" is
  // asked in place (SimilarTask) — a press, never an automatic merge.
  assert.match(tasks, /<SimilarTask /, 'asks Merge / Keep both in place');
  assert.doesNotMatch(tasks, /task-dedupe\/merge/, 'no merge call outside the shared prompt');
});
