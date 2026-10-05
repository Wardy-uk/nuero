'use strict';
// Commitments screen actions (5 Oct 2026): done / not owed go to the OWNER of
// the commitment, and "who" must name a real People note.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-cact-')), 'scratch.db');
const db = require('../db/database');
const wo = require('./waiting-on');
const ca = require('./commitment-actions');

test.before(async () => { await db.init(); });

const commit = (id, kind, ref, extra = {}) => db.run(`INSERT INTO wm_commitments (commitment_id, description, direction, status, source_kind, source_ref,
  created_at, updated_at, provenance_kind, confidence, observed_at, received_at, evidence_json, fingerprint, payload_json, waiting_party, related_task_id, beneficiary_kind)
  VALUES (?, 'x', ?, 'open', ?, ?, 't', 't', 'observation', 0.5, 't', 't', '[]', 'f', '{}', 'nick', ?, 'meeting')`,
  [id, extra.direction || 'to-nick', kind, ref, extra.taskId || null]);

test('not owed drops the waiting-on row; it never counts as done', () => {
  const item = wo.record({ person: 'Nathan', text: 'Chase the SLA replies', sourcePath: 'Meetings/a.md', sourceDate: '2026-09-18' });
  commit('c1', 'meeting-waiting-on', `waiting-on:${item.key}`);
  const r = ca.resolve('c1', 'not-owed');
  assert.equal(r.ok, true);
  assert.equal(db.get('SELECT status FROM waiting_on WHERE key = ?', [item.key]).status, 'dropped');
});

test('done on an I-owe commitment closes its NEURO task', () => {
  const t = require('./task-store').createTask({ text: 'Send Chris the risk numbers', source: 'test' });
  commit('c2', 'meeting-task', `neuro-task:${t.id}`, { direction: 'by-nick' });
  assert.equal(ca.resolve('c2', 'done').ok, true);
  assert.equal(db.getTaskRow(t.id).status, 'done');
});

test('refusals: unknown outcome, management log, already closed', () => {
  commit('c3', 'management-log', 'mgmt:1', { direction: 'by-nick' });
  assert.equal(ca.resolve('c3', 'done').status, 409);
  assert.equal(ca.resolve('c3', 'maybe').status, 400);
  db.run("UPDATE wm_commitments SET status = 'completed' WHERE commitment_id = 'c2'");
  assert.equal(ca.resolve('c2', 'done').status, 409);
});

test('who must be a People note, and lands on the row as the full name', () => {
  const item = wo.record({ person: 'Nathan', text: 'Fix the routing', sourcePath: 'Meetings/b.md', sourceDate: '2026-09-18' });
  commit('c4', 'meeting-waiting-on', `waiting-on:${item.key}`);
  db.run(`INSERT INTO wm_people (person_id, display_name, note_path, aliases_json, provenance_kind, confidence, evidence_json, first_observed_at, last_observed_at, updated_at)
          VALUES ('person:nathan-rutland', 'Nathan Rutland', 'People/Nathan Rutland.md', '[]', 'declared', 1, '[]', 't', 't', 't')`);
  assert.equal(ca.setPromisor('c4', 'Nathan Nobody').status, 400);
  const r = ca.setPromisor('c4', 'nathan rutland');
  assert.equal(r.ok, true);
  assert.equal(db.get('SELECT person_full FROM waiting_on WHERE key = ?', [item.key]).person_full, 'Nathan Rutland');
  // A later sighting keeps it.
  wo.record({ person: 'Nathan', text: 'Fix the routing', sourcePath: 'Meetings/b.md', sourceDate: '2026-09-18' });
  assert.equal(db.get('SELECT person_full FROM waiting_on WHERE key = ?', [item.key]).person_full, 'Nathan Rutland');
});
