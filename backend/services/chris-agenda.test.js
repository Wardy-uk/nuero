'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-chris-agenda-')), 'scratch.db');
process.env.NEURO_DB_PATH = DB_PATH;

const db = require('../db/database');
const agenda = require('./chris-agenda');

test.before(async () => { await db.init(); });

test('an item stays open until ticked, and a tick can be undone', () => {
  const { item } = agenda.add('Ask about the TOM timeline');
  assert.equal(agenda.list().open.length, 1);
  agenda.tick(item.id);
  assert.equal(agenda.list().open.length, 0);
  assert.equal(agenda.list({ includeDone: true }).done[0].id, item.id);
  agenda.restore(item.id);
  assert.equal(agenda.list().open.length, 1);
});

test('the same open line twice is one item; empty text is refused', () => {
  const r = agenda.add('ask about the tom timeline');
  assert.equal(r.already, true);
  assert.throws(() => agenda.add('   '), /empty/);
});

test('an unreadable store refuses writes rather than wiping the list', () => {
  const before = db.getState(agenda.KEY);
  db.setState(agenda.KEY, '{not json');
  assert.equal(agenda.list().known, false);
  assert.throws(() => agenda.add('anything'), /could not be read/);
  assert.equal(db.getState(agenda.KEY), '{not json');
  db.setState(agenda.KEY, before);
});

// The report half lives in weekly-risk.test.js, against its full fixture.
