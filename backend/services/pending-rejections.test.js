'use strict';

// Pending-rejection seen state (28 Oct 2026): a ticket Tier 2 rejected is unseen
// until Nick opens its row; leaving the status drops it, so a re-rejection is new.
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rej-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db/database');
const jira = require('./jira');

test.before(async () => { await db.init(); });
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

test('new rejections are unseen; opening one marks only that one', () => {
  jira.absorbRejections([{ key: 'NT-1', summary: 'a' }, { key: 'NT-2', summary: 'b' }]);
  assert.equal(jira.getUnseenRejectionCount(), 2);
  assert.deepEqual(jira.markRejectionsSeen(['NT-1']), ['NT-1']);
  assert.deepEqual(jira.markRejectionsSeen(['NT-1']), [], 'twice changes nothing');
  assert.equal(jira.getUnseenRejectionCount(), 1);
  assert.deepEqual(jira.decorateRejections([{ key: 'NT-1' }, { key: 'NT-2' }, { key: 'NT-9' }]).map((r) => r.seen), [true, false, false]);
});

test('seen survives a re-sync; leaving the status and coming back is unseen again', () => {
  jira.absorbRejections([{ key: 'NT-1' }, { key: 'NT-2' }]);
  assert.equal(jira.getUnseenRejectionCount(), 1, 'NT-1 stays seen');
  jira.absorbRejections([{ key: 'NT-2' }]);
  jira.absorbRejections([{ key: 'NT-1' }, { key: 'NT-2' }]);
  assert.equal(jira.getUnseenRejectionCount(), 2, 'NT-1 rejected again is new');
});
