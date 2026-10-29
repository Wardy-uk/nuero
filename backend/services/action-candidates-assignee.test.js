'use strict';
// A checkbox assigned to someone else (👤 [[People/X]]) is not Nick's task.
// Fixtures are the real lines NOVA wrote into People/Heidi Power.md (28 Oct 2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const ac = require('./action-candidates');

const HEIDI = [
  '## 1-2-1 Actions',
  '',
  "- [ ] Use the 'Golden rules' skill in Claude to check updates for clarity, tone, and accuracy before posting to tickets 👤 [[People/Heidi Power|Heidi Power]] <!-- nova:144 -->",
  '- [ ] Ask Claude to help optimize workflow by describing current process and asking for improvement suggestions 👤 [[People/Heidi Power|Heidi Power]] <!-- nova:145 -->',
  '- [ ] Speak to power users like Abdi, Charlie Cure, and Nick Mack about AI workflow optimization 👤 [[People/Heidi Power|Heidi Power]] <!-- nova:146 -->',
].join('\n');

test('actions assigned to a colleague raise no candidate', () => {
  assert.deepEqual(ac.extractActionCandidates(HEIDI, 'People/Heidi Power.md'), []);
});

test('an action assigned to Nick still raises one (positive control)', () => {
  const text = '## Actions\n\n- [ ] Book Heidi\'s Claude training 👤 [[People/Nick Ward|Nick Ward]] <!-- nova:147 -->';
  const out = ac.extractActionCandidates(text, 'People/Heidi Power.md');
  assert.equal(out.length, 1);
});

test('an unassigned checkbox is unaffected', () => {
  const out = ac.extractActionCandidates('- [ ] Chase the renewal quote', 'Areas/Admin.md');
  assert.equal(out.length, 1);
});

test('assignedToSomeoneElse', () => {
  assert.equal(ac.assignedToSomeoneElse('- [ ] x 👤 [[People/Heidi Power|Heidi Power]]'), true);
  assert.equal(ac.assignedToSomeoneElse('- [ ] x 👤 [[People/Nick Ward]]'), false);
  assert.equal(ac.assignedToSomeoneElse('- [ ] x'), false);
});
