'use strict';

// Draft and post a Jira reply (23 Oct 2026). Jira and the model are faked at
// the deps boundary; the external-write LEDGER, the watched-ticket store and
// the commitment table are REAL.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'treply-')), 'test.db');

const db = require('../db/database');
const tr = require('./ticket-replies');
const wt = require('./watched-tickets');
const ext = require('./external-writes');

test.before(async () => { await db.init(); });

const ME = { accountType: 'atlassian', displayName: 'Nick Ward' };
const CUSTOMER = { accountType: 'customer', displayName: 'Anthony Smith' };
const adf = (t) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
let nextId = 9000;

function jira(key, { landAs } = {}) {
  const j = {
    comments: [{ id: String(nextId++), author: CUSTOMER, jsdPublic: true, body: adf('The forms are still broken, any update?'), created: '2026-10-23T11:00:00.000Z' }],
    posts: [], prompts: [], fail: null, now: Date.parse('2026-10-23T13:00:00Z'),
  };
  j.deps = {
    basics: async (k) => ({ key: k, summary: 'Forms not working', status: 'Work in progress', reporter: 'Anthony Smith', assignee: 'Nick Ward', priority: 'Critical' }),
    comments: async () => ({ comments: [...j.comments].reverse(), complete: true }),
    post: async (k, body, isPublic) => {
      if (j.fail) throw new Error(j.fail);
      j.posts.push({ k, body, isPublic });
      const id = String(nextId++);
      const vis = landAs === undefined ? isPublic : landAs;
      j.comments.push({ id, author: ME, jsdPublic: vis, body: adf(body), created: new Date(j.now).toISOString() });
      return { id, public: vis };
    },
    model: async (prompt) => { j.prompts.push(prompt); return { text: j.draft || 'Hi Anthony,\n\nI own this. The fix is in testing. I will update you by 5pm today.\n\nKind regards,\nNick', model: 'fake' }; },
    watch: (k) => wt.watch(k, {
      configured: () => true,
      states: async () => ({ issues: [{ key: k, summary: 'Forms not working', status: 'Work in progress', statusCategory: 'indeterminate', updated: 'u' }] }),
      comments: async () => ({ comments: [...j.comments].reverse(), complete: true }),
      now: () => new Date(j.now),
    }),
    now: () => j.now,
  };
  return j;
}

test('gaps the draft left must be filled before posting; empty refused', () => {
  assert.match(tr.problemsWith('Hi, I will update you by [time of next update].'), /Fill in \[time of next update\]/);
  assert.match(tr.problemsWith('   '), /empty/);
  assert.equal(tr.problemsWith('Hi Anthony, update by 5pm today. See note [1].'), null, 'a one-character bracket is not a gap');
});

test('the draft prompt carries the golden rules, the thread with who wrote what, and Nick\'s note; it never asks to invent', async () => {
  const j = jira('NT-35291');
  j.comments.push({ id: String(nextId++), author: { accountType: 'atlassian', displayName: 'Hope Agent' }, jsdPublic: false, body: adf('Dev says the cache is stale'), created: '2026-10-23T12:00:00Z' });
  const r = await tr.draft({ key: 'nt-35291', visibility: 'public', guidance: 'fix in testing, next update 5pm' }, j.deps);
  await tr.draft({ key: 'nt-35291', visibility: 'internal' }, j.deps);
  assert.ok(j.prompts[1].includes('INTERNAL NOTE — never repeat to the customer'));
  assert.equal(r.ok, true);
  const p = j.prompts[0];
  for (const s of ['Ownership', "What's happening", 'Timeframes', 'Never invent', 'square brackets', 'fix in testing, next update 5pm', 'CUSTOMER (Anthony Smith)', 'Anthony', 'PLAIN TEXT ONLY', 'never nested', 'INTERNAL NOTES ARE BACKGROUND ONLY']) {
    assert.ok(p.includes(s), `prompt missing: ${s}`);
  }
  assert.equal(r.promise.dueAt, '2026-10-23T16:00:00.000Z', 'the preview shows the promise in the draft');
  assert.equal(r.willWatch, true);
  assert.equal(j.posts.length, 0, 'drafting posts nothing');
});

test('a PUBLIC draft never sees internal notes; an internal-note draft does', async () => {
  const j = jira('NT-35292');
  j.comments.push({ id: String(nextId++), author: { accountType: 'app', displayName: 'Automation for Jira' }, jsdPublic: false, body: adf('Assigned to Luke Scaife, SES config, ETA 5pm'), created: '2026-10-23T12:00:00Z' });
  await tr.draft({ key: 'NT-35292', visibility: 'public' }, j.deps);
  assert.ok(!j.prompts[0].includes('Luke Scaife'), 'internal note leaked into a public draft');
  assert.ok(j.prompts[0].includes('The forms are still broken'), 'the public thread is still there');
  await tr.draft({ key: 'NT-35292', visibility: 'internal' }, j.deps);
  assert.ok(j.prompts[1].includes('Luke Scaife'));
});

test('a public reply posts once, is read back, sets the promise OPEN and starts watching', async () => {
  const j = jira('NT-3001');
  const text = 'Hi Anthony,\n\nI own this. The fix is in testing. I will update you by 5pm today.\n\nKind regards,\nNick';
  const r = await tr.post({ key: 'NT-3001', text, visibility: 'public' }, j.deps);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.outcome, 'confirmed');
  assert.deepEqual(j.posts.map((p) => p.isPublic), [true]);
  assert.equal(r.watchedNow, true);
  assert.equal(r.commitment.state, 'open');
  assert.equal(r.commitment.dueAt, '2026-10-23T16:00:00.000Z');
  const ledger = ext.recent({ writer: 'jira.comment' }).find((e) => e.target === 'NT-3001');
  assert.equal(ledger.status, 'confirmed');
  assert.equal(JSON.stringify(ledger.request).includes('fix is in testing'), false, 'the ledger keeps a hash, not the text');

  // The same text again is not posted twice.
  const again = await tr.post({ key: 'NT-3001', text, visibility: 'public' }, j.deps);
  assert.equal(again.outcome, 'duplicate');
  assert.equal(j.posts.length, 1);
});

test('an internal note posts as internal, sets no commitment and does not start watching', async () => {
  const j = jira('NT-3002');
  const r = await tr.post({ key: 'NT-3002', text: 'Dev owns this; Sam is pulling logs now; I will update the customer by 5pm today.', visibility: 'internal' }, j.deps);
  assert.equal(r.outcome, 'confirmed');
  assert.deepEqual(j.posts.map((p) => p.isPublic), [false]);
  assert.equal(r.commitment, null);
  assert.equal(r.watchedNow, false);
  assert.equal(wt.isWatched('NT-3002'), false);
});

test('a comment that lands with the wrong visibility is reported loudly, never "confirmed"', async () => {
  const j = jira('NT-3003', { landAs: true });
  const r = await tr.post({ key: 'NT-3003', text: 'Internal: chasing dev for an ETA by 3pm.', visibility: 'internal' }, j.deps);
  assert.equal(r.outcome, 'applied-unverified');
  assert.match(r.warning, /PUBLIC — not what you chose/);
});

test('a timeout is an unknown outcome: never re-posted until Nick says what is on the ticket', async () => {
  const j = jira('NT-3004');
  j.fail = 'Jira request timed out';
  const text = 'Hi Anthony, I own this and will update you by 4pm today.';
  const r = await tr.post({ key: 'NT-3004', text, visibility: 'public' }, j.deps);
  assert.equal(r.outcome, 'uncertain');
  assert.ok(r.ledgerKey);
  j.fail = null;
  const again = await tr.post({ key: 'NT-3004', text, visibility: 'public' }, j.deps);
  assert.equal(again.outcome, 'blocked');
  assert.equal(j.posts.length, 0);
  ext.resolveUnknown(r.ledgerKey, { applied: false });
  const third = await tr.post({ key: 'NT-3004', text, visibility: 'public' }, j.deps);
  assert.equal(third.outcome, 'confirmed');
  assert.equal(j.posts.length, 1);
});

test('a 4xx from Jira is a refusal: nothing posted, and trying again is allowed', async () => {
  const j = jira('NT-3005');
  j.fail = 'Jira API 400: comment body invalid';
  const r = await tr.post({ key: 'NT-3005', text: 'Hi, update by 4pm today.', visibility: 'public' }, j.deps);
  assert.equal(r.outcome, 'failed');
  assert.match(r.error, /Nothing was posted/);
});

test('posting refuses junk before anything is ledgered', async () => {
  const j = jira('NT-3006');
  assert.equal((await tr.post({ key: 'nope', text: 'x', visibility: 'public' }, j.deps)).status, 400);
  assert.equal((await tr.post({ key: 'NT-3006', text: 'hello', visibility: 'shout' }, j.deps)).status, 400);
  assert.equal((await tr.post({ key: 'NT-3006', text: 'Update by [time].', visibility: 'public' }, j.deps)).status, 400);
  assert.equal(ext.recent({ writer: 'jira.comment' }).filter((e) => e.target === 'NT-3006').length, 0);
});

test('a public reply on a ticket already watched keeps the earlier promise and sets the new one', async () => {
  const j = jira('NT-3007');
  await j.deps.watch('NT-3007');
  const first = wt.addCommitment('NT-3007', '2026-10-23T15:00', j.now);
  assert.equal(first.ok, true);
  j.now += 60000;
  const r = await tr.post({ key: 'NT-3007', text: 'Hi Anthony, quick update: fix is in testing. I will update you again by 5pm today.', visibility: 'public' }, j.deps);
  assert.equal(r.watchedNow, false);
  assert.equal(db.get('SELECT state FROM watched_ticket_commitments WHERE id = ?', [first.commitment.id]).state, 'kept');
  assert.equal(r.commitment.state, 'open');
});

test('the post route refuses a machine client', async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.apiClient = { name: 'test' }; next(); });
  app.use('/api/escalation', require('../routes/escalation'));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/escalation/reply/post`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'NT-1', text: 'hi', visibility: 'public' }),
    });
    assert.equal(res.status, 403);
  } finally { server.close(); }
});
