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

test('only TPJ is development: NT-31647’s NTPJ project link is not asked for', () => {
  const st = (name, cat) => ({ fields: { status: { name, statusCategory: { key: cat } } } });
  const t = {
    key: 'NT-31647',
    issuelinks: [
      { inwardIssue: { key: 'NTPJ-10472', ...st('Waiting on Tech', 'indeterminate') } },
      { inwardIssue: { key: 'TPJ-2687', ...st('In Progress', 'indeterminate') } },
      { outwardIssue: { key: 'TPJ-2741', ...st('TO SCOPE / TRIAGE', 'new') } },
    ],
  };
  assert.deepEqual(devItemsOf(t).map((d) => d.key), ['TPJ-2687', 'TPJ-2741']);
  assert.deepEqual(devItemsOf(t, ['NTPJ']).map((d) => d.key), ['NTPJ-10472']);
});

// Escalation emails already sent, by ticket — so a row can say so (28 Oct 2026).
const { emailedFrom } = require('./escalation');

test('only sent (or sending) escalation emails count, grouped by ticket, newest first', () => {
  const row = (ticket, status, at, to) => ({
    status, created_at: at, approved_at: at, executed_at: status === 'verified' ? at : null,
    evidence_json: JSON.stringify(ticket ? { origin: 'composer', ticket } : { origin: 'composer' }),
    draft_json: JSON.stringify({ to }),
  });
  const out = emailedFrom([
    row('NT-31647', 'verified', '2026-10-28T12:41:00Z', [{ name: 'Chris Middleton', email: 'chris@x' }]),
    row('NT-31647', 'verified', '2026-10-29T09:00:00Z', [{ name: null, email: 'liam@x' }]),
    row('NT-1', 'prepared', '2026-10-28T10:00:00Z', [{ email: 'a@x' }]),
    row('NT-2', 'rejected', '2026-10-28T10:00:00Z', [{ email: 'a@x' }]),
    row(null, 'verified', '2026-10-28T10:00:00Z', [{ email: 'a@x' }]),
  ]);
  assert.deepEqual(Object.keys(out), ['NT-31647']);
  assert.deepEqual(out['NT-31647'].map((m) => m.to[0]), ['liam@x', 'Chris Middleton']);
});
