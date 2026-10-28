'use strict';

// The linked development item "Escalate by email…" asks for (28 Oct 2026).
// Fixture is the live NT-14705 link shape read through NOVA.
const test = require('node:test');
const assert = require('node:assert/strict');
const { devItemsOf } = require('./escalation');

test('linked issues in another project are dev items; the ticket’s own project and duplicates are not', () => {
  const t = {
    key: 'NT-14705',
    issuelinks: [
      { type: { name: 'Problem/Incident' }, inwardIssue: { key: 'TPJ-2504', fields: { status: { name: 'New', statusCategory: { key: 'new' } } } } },
      { type: { name: 'Relates' }, outwardIssue: { key: 'NT-100', fields: { status: { name: 'Open' } } } },
      { type: { name: 'Blocks' }, outwardIssue: { key: 'TPJ-9', fields: { status: { name: 'Done', statusCategory: { key: 'done' } } } } },
      { type: { name: 'Relates' }, inwardIssue: { key: 'TPJ-2504', fields: { status: { name: 'New' } } } },
    ],
  };
  assert.deepEqual(devItemsOf(t), [
    { key: 'TPJ-2504', status: 'New', done: false },
    { key: 'TPJ-9', status: 'Done', done: true },
  ]);
  assert.deepEqual(devItemsOf({ key: 'NT-1' }), []);
});
