'use strict';

// Sentiment escalations (28 Oct 2026): an open ticket NOVA scores Angry is listed
// unseen until Nick opens it, and pushed once when it arrives — never the backlog.
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sent-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.JIRA_BASE_URL = 'https://example.atlassian.net/';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db/database');
const nova = require('./nova-client');
const sent = require('./sentiment-escalations');

let novaList = [];
nova.isConfigured = () => true;
nova.listSentimentEscalations = async () => ({ windowDays: 180, tickets: novaList });

test.before(async () => { await db.init(); });
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

test('first read seeds silently; a later arrival is pushed once', async () => {
  const pushes = [];
  const push = async (title, body, data) => { pushes.push({ title, body, data }); };
  novaList = [{ key: 'NT-1', summary: 'Old anger', score: -0.8 }];
  const first = await sent.sync({ push });
  assert.equal(first.seeded, true);
  assert.equal(pushes.length, 0, 'the backlog did not just arrive');
  assert.equal(sent.getUnseenCount(), 1, 'but it is still unseen');

  novaList = [{ key: 'NT-1', summary: 'Old anger', score: -0.8 }, { key: 'NT-2', summary: 'Forms broken', score: -0.9, why: 'Threatens to cancel', commentId: '77' }];
  await sent.sync({ push });
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].title, /^NT-2: customer is angry/);
  assert.match(pushes[0].body, /Threatens to cancel/);
  assert.equal(pushes[0].data.type, 'sentiment_escalation');
  assert.equal(pushes[0].data.key, 'sentiment:NT-2:77');

  await sent.sync({ push });
  assert.equal(pushes.length, 1, 'still angry is not a new arrival');
});

test('opening marks seen; calming down drops it; angry again is new', async () => {
  const push = async () => {};
  novaList = [{ key: 'NT-1' }, { key: 'NT-2' }];
  await sent.sync({ push });
  assert.deepEqual(sent.markSeen(['NT-1']), ['NT-1']);
  assert.deepEqual(sent.markSeen(['NT-1']), [], 'twice changes nothing');
  assert.deepEqual(sent.decorate([{ key: 'NT-1' }, { key: 'NT-9' }]).map((t) => [t.seen, t.url]),
    [[true, 'https://example.atlassian.net/browse/NT-1'], [false, 'https://example.atlassian.net/browse/NT-9']]);
  novaList = [{ key: 'NT-2' }];
  await sent.sync({ push });
  novaList = [{ key: 'NT-1' }, { key: 'NT-2' }];
  await sent.sync({ push });
  assert.equal(sent.decorate([{ key: 'NT-1' }])[0].seen, false, 'turning angry again is a new escalation');
});

test('NOVA failing leaves the last list alone', async () => {
  const before = db.getState(sent.STORE);
  nova.listSentimentEscalations = async () => { throw new Error('bridge down'); };
  await assert.rejects(sent.sync({ push: async () => {} }), /bridge down/);
  assert.equal(db.getState(sent.STORE), before);
});
