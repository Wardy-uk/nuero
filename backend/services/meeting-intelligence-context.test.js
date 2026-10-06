'use strict';

/**
 * Build 14T — meeting-intelligence now carries what the old meeting-prep push
 * carried (a People note's role and the last 1-2-1), as CONTEXT, and the parity
 * classifier can tell "the new side holds it but stays quiet" from "the new
 * side knows nothing". Neither unblocks retirement.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mic-'));
fs.mkdirSync(path.join(vault, 'People'));
process.env.OBSIDIAN_VAULT_PATH = vault;
process.env.NEURO_DB_PATH = path.join(vault, 'x.db');
fs.writeFileSync(path.join(vault, 'People', 'Hope Goodall.md'), '---\r\nrole: Team Lead\r\nteam: 1st Line\r\nlast-1-2-1: 2026-09-30\r\n---\r\nNotes.\r\n');
fs.writeFileSync(path.join(vault, 'People', 'No Front.md'), 'Just text.\n');

const mi = require('./meeting-intelligence');

test('a People note gives role, team and last 1-2-1; unknown stays null; a path in a name is refused', () => {
  const c = mi.readPersonContext('Hope Goodall');
  assert.equal(c.role, 'Team Lead');
  assert.equal(c.team, '1st Line');
  assert.equal(c.last121, '2026-09-30');
  assert.deepEqual(mi.readPersonContext('No Front'), { role: null, team: null, last121: null });
  assert.equal(mi.readPersonContext('Missing Person'), null);
  assert.equal(mi.readPersonContext('../secret'), null);
});

test('attendeeContext lists every named attendee and says which are known', () => {
  const ctx = mi.attendeeContext([{ personId: 'p1', displayName: 'Hope Goodall' }, { personId: 'p2', displayName: 'Missing Person' }, { personId: 'p3' }], mi.readPersonContext);
  assert.equal(ctx.length, 2);
  assert.equal(ctx[0].known, true);
  assert.equal(ctx[0].last121, '2026-09-30');
  assert.equal(ctx[1].known, false);
});

test('parity: old-only with the context held is "covered"; without it is still "old-only"; both still block retirement', () => {
  const old = JSON.stringify({ wouldNotify: true, matchedPeople: ['Hope Goodall'] });
  const covered = { meeting_key: 'a', title: 'Hope 1-2-1', start_local: '2026-10-06T10:00', old_json: old,
    new_json: JSON.stringify({ finding: false, why: 'nothing specific', context: [{ name: 'Hope Goodall', role: 'Team Lead', last121: '2026-09-30' }] }) };
  const bare = { meeting_key: 'b', title: 'Hope 1-2-1', start_local: '2026-10-07T10:00', old_json: old,
    new_json: JSON.stringify({ finding: false, why: 'nothing specific' }) };
  assert.equal(mi.classifyComparison(covered).kind, 'old-only-covered');
  assert.equal(mi.classifyComparison(bare).kind, 'old-only');
  const days = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'].map((d, i) => ({ ...covered, meeting_key: `k${i}`, start_local: `${d}T10:00` }));
  const v = mi.parityVerdict(days);
  assert.equal(v.counts.oldOnlyCovered, 5);
  assert.equal(v.retireSafe, false, 'covered content still needs Nick to decide it does not earn a push');
});
