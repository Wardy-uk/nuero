'use strict';

// Watched tickets (23 Oct 2026). Jira, the model, the push and the clock are
// faked at the deps boundary; the store and the routes are REAL.
// Comment author shapes are copied from live NT tickets: customers are
// accountType 'customer', agents 'atlassian', NOVA/automation 'app'.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watched-')), 'test.db');

const db = require('../db/database');
const wt = require('./watched-tickets');

test.before(async () => { await db.init(); });

const CUSTOMER = { accountType: 'customer', displayName: 'Sam Customer' };
const AGENT = { accountType: 'atlassian', displayName: 'Hope Agent' };
const BOT = { accountType: 'app', displayName: 'NOVA' };
const adf = (t) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });

// Jira comment ids are unique across the whole site, so one counter for every fake ticket.
let nextCommentId = 100;

function world(key) {
  const w = {
    issue: { key, summary: 'Portal down', status: 'In Progress', statusCategory: 'indeterminate', updated: 'u0', url: `https://x/browse/${key}` },
    comments: [],
    pushes: [],
    judged: [],
    modelSays: null,
    now: new Date('2026-10-20T10:00:00Z'),

  };
  w.add = (author, text, jsdPublic = true) => {
    w.comments.push({ id: String(nextCommentId++), author, jsdPublic, body: adf(text), created: w.now.toISOString() });
    w.issue.updated = `u${nextCommentId}`;
  };
  w.deps = {
    configured: () => true,
    states: async (keys) => ({ issues: keys.includes(key) ? [{ ...w.issue }] : [] }),
    comments: async () => ({ comments: [...w.comments].reverse(), complete: true }),
    judge: async (t) => { w.judged.push(t); return w.modelSays; },
    push: async (title, body, data) => { w.pushes.push({ title, body, data }); },
    nextWorkingDay: (d) => { const x = new Date(d); x.setDate(x.getDate() + 1); return x; },
    now: () => w.now,
  };
  return w;
}

const row = (key) => db.get('SELECT * FROM watched_tickets WHERE ticket_key = ?', [key]);

// ── Pure ─────────────────────────────────────────────────────────────────────

test('only a public comment from a customer account counts', () => {
  assert.equal(wt.isCustomerReply({ author: CUSTOMER, jsdPublic: true }), true);
  assert.equal(wt.isCustomerReply({ author: CUSTOMER, jsdPublic: false }), false);
  assert.equal(wt.isCustomerReply({ author: AGENT, jsdPublic: true }), false);
  assert.equal(wt.isCustomerReply({ author: BOT, jsdPublic: true }), false);
});

test('the rule drops a bare thank-you and passes anything with trouble or a question', () => {
  for (const t of ['Thanks!', 'Thank you so much, all sorted now. Kind regards, Sam', 'Cheers, that works', 'Brilliant, many thanks for your help']) {
    assert.equal(wt.judgeByRule(t).verdict, 'thanks', t);
  }
  for (const t of ['Thanks, but it is broken again', 'Thanks - when will this go live?', 'Still not working for me', 'Thanks again, the report is still missing data']) {
    assert.equal(wt.judgeByRule(t).verdict, 'follow-up', t);
  }
  assert.equal(wt.judgeByRule('Thanks. Also could you add Jane Smith to the account as an administrator for the Leeds office please').verdict, 'unsure');
});

test('a comment that is only an attachment (a screenshot) is a follow-up, never a thank-you', () => {
  assert.equal(wt.judgeByRule('').verdict, 'follow-up');
  const imageOnly = { type: 'doc', content: [{ type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x' } }] }] };
  assert.equal(wt.adfText(imageOnly).trim(), '');
  assert.equal(wt.excerptOf(wt.adfText(imageOnly)), '(an attachment, no text)');
});

test('quoted history below "On … wrote:" is not the customer’s words', () => {
  const t = 'Thanks!\n\nOn Mon, 20 Oct 2026, Hope wrote:\n> Is it still broken?';
  assert.equal(wt.judgeByRule(t).verdict, 'thanks');
});

test('the listen ends at the end of the 10th working day', () => {
  const next = (d) => { const x = new Date(d); x.setDate(x.getDate() + 1); return x; };
  const end = wt.listenUntil(new Date(2026, 9, 20, 10), next);
  assert.equal(end.getDate(), 30);
  assert.equal(end.getHours(), 23);
});

// ── Flow ─────────────────────────────────────────────────────────────────────

test('watching takes a baseline: what was already there is never announced', async () => {
  const w = world('NT-1001');
  w.add(CUSTOMER, 'Old complaint from last week');
  const r = await wt.watch('nt-1001', w.deps);
  assert.equal(r.ok, true);
  assert.equal(r.ticket.phase, 'active');
  // Something else changes on the ticket, so the poll really does reread the comments.
  w.issue.updated = 'touched-by-automation';
  await wt.check(w.deps);
  assert.equal(w.pushes.length, 0);
});

test('a baseline Jira could not give at watch time is taken on the first check, never announced', async () => {
  const w = world('NT-1008');
  w.add(CUSTOMER, 'Complaint that predates the watch');
  const real = w.deps.comments;
  w.deps.comments = async () => { throw new Error('Jira request timed out'); };
  await wt.watch('NT-1008', w.deps);
  assert.equal(row('NT-1008').seen_comment_id, null);
  w.deps.comments = real;
  await wt.check(w.deps);
  assert.equal(w.pushes.length, 0);
  assert.ok(row('NT-1008').seen_comment_id > 0);
});

test('a customer reply pushes once; an agent reply and an internal note do not', async () => {
  const w = world('NT-1002');
  await wt.watch('NT-1002', w.deps);
  w.add(AGENT, 'We are looking at it');
  w.add(CUSTOMER, 'It is down again', false); // internal note by a customer account? still not public
  await wt.check(w.deps);
  assert.equal(w.pushes.length, 0);

  w.add(CUSTOMER, 'Any update? The portal is still down.');
  await wt.check(w.deps);
  assert.equal(w.pushes.length, 1);
  assert.match(w.pushes[0].title, /NT-1002: customer replied/);
  assert.equal(w.pushes[0].data.type, 'watched_reply');

  // A second pass over the same comments (Jira bumped `updated` for something else) never re-announces.
  w.issue.updated = 'bumped';
  await wt.check(w.deps);
  assert.equal(w.pushes.length, 1);

  const listed = wt.list().active.find((t) => t.key === 'NT-1002');
  assert.equal(listed.unread, 1);
  wt.markRead('NT-1002');
  assert.equal(wt.list().active.find((t) => t.key === 'NT-1002').unread, 0);
});

test('resolve → listen; a thank-you (even one that reopens it) stays quiet; a follow-up brings it back', async () => {
  const w = world('NT-1003');
  await wt.watch('NT-1003', w.deps);
  w.issue.statusCategory = 'done'; w.issue.status = 'Resolved'; w.issue.updated = 'resolved';
  await wt.check(w.deps);
  assert.equal(row('NT-1003').phase, 'background');
  assert.ok(row('NT-1003').background_until);

  // JSM reopens on the customer's comment, and it is only thanks.
  w.add(CUSTOMER, 'Thank you so much, all sorted now. Kind regards, Sam');
  w.issue.statusCategory = 'indeterminate'; w.issue.status = 'Reopened';
  await wt.check(w.deps);
  assert.equal(w.pushes.length, 0);
  assert.equal(row('NT-1003').phase, 'background');
  assert.equal(db.get(`SELECT verdict FROM watched_ticket_replies WHERE ticket_key = 'NT-1003'`).verdict, 'thanks');

  w.add(CUSTOMER, 'Thanks, but it is broken again this morning');
  await wt.check(w.deps);
  assert.equal(w.pushes.length, 1);
  assert.match(w.pushes[0].title, /came back after it was resolved/);
  assert.equal(row('NT-1003').phase, 'active');
});

test('in the listen, an unclear reply goes to the model; no answer means it is flagged', async () => {
  const w = world('NT-1004');
  w.issue.statusCategory = 'done';
  const r = await wt.watch('NT-1004', w.deps);
  assert.equal(r.ticket.phase, 'background');

  w.modelSays = 'thanks';
  w.add(CUSTOMER, 'Thanks. Jane Smith from the Leeds office passed on her gratitude to the whole team today');
  await wt.check(w.deps);
  assert.equal(w.judged.length, 1);
  assert.equal(w.pushes.length, 0);

  w.modelSays = null;
  w.add(CUSTOMER, 'Could you also add Jane Smith to the account as an administrator for the Leeds office please');
  await wt.check(w.deps);
  assert.equal(w.pushes.length, 1);
  assert.equal(db.get(`SELECT judged_by FROM watched_ticket_replies WHERE ticket_key = 'NT-1004' ORDER BY created DESC, comment_id DESC`).judged_by, 'model-unavailable');
});

test('reopened with no customer comment comes back silently; a quiet listen ends', async () => {
  const w = world('NT-1005');
  w.issue.statusCategory = 'done';
  await wt.watch('NT-1005', w.deps);
  w.issue.statusCategory = 'indeterminate'; w.issue.updated = 'reopened';
  await wt.check(w.deps);
  assert.equal(row('NT-1005').phase, 'active');
  assert.equal(w.pushes.length, 0);

  w.issue.statusCategory = 'done'; w.issue.updated = 'resolved-again';
  await wt.check(w.deps);
  assert.equal(row('NT-1005').phase, 'background');
  w.now = new Date(w.now.getTime() + 15 * 86400000);
  await wt.check(w.deps);
  assert.equal(row('NT-1005').phase, 'ended');
  assert.equal(row('NT-1005').ended_reason, 'quiet-after-resolve');
});

test('a key Jira will not return is named, and the rest are still checked', async () => {
  const w = world('NT-1006');
  await wt.watch('NT-1006', w.deps);
  db.run(`INSERT INTO watched_tickets (ticket_key, phase, watched_at, seen_comment_id) VALUES ('NT-9999', 'active', ?, 0)`, [new Date().toISOString()]);
  w.deps.states = async (keys) => {
    if (keys.includes('NT-9999') && keys.length > 1) throw new Error('Jira API 400: An issue with key NT-9999 does not exist');
    return { issues: keys.includes('NT-1006') ? [{ ...w.issue }] : [] };
  };
  w.add(CUSTOMER, 'Hello? Is anyone looking at this?');
  await wt.check(w.deps);
  assert.ok(row('NT-9999').last_error);
  assert.ok(w.pushes.some((p) => /NT-1006/.test(p.title)));
  db.run(`DELETE FROM watched_tickets WHERE ticket_key = 'NT-9999'`);
});

test('watch refuses junk and a ticket Jira does not have; unwatch keeps history', async () => {
  const w = world('NT-1007');
  assert.equal((await wt.watch('hello', w.deps)).status, 400);
  assert.equal((await wt.watch('NT-424242', w.deps)).status, 404);
  await wt.watch('NT-1007', w.deps);
  assert.equal((await wt.watch('NT-1007', w.deps)).already, true);
  assert.equal(wt.unwatch('NT-1007').ok, true);
  assert.equal(row('NT-1007').ended_reason, 'unwatched');
  assert.equal(wt.unwatch('NT-1007').status, 404);
});

// ── Routes ───────────────────────────────────────────────────────────────────

test('routes answer over real HTTP', async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/escalation', require('../routes/escalation'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/escalation`;
  try {
    const list = await (await fetch(`${base}/watched`)).json();
    assert.ok(Array.isArray(list.active) && Array.isArray(list.listening));
    const bad = await fetch(`${base}/watched`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'nope' }) });
    assert.equal(bad.status, 400);
    const read = await fetch(`${base}/watched/NT-1002/read`, { method: 'POST' });
    assert.equal(read.status, 200);
  } finally {
    server.close();
  }
});

// ── Update commitments ───────────────────────────────────────────────────────

const ME = { accountType: 'atlassian', displayName: 'Nick Ward' };
const NT_35291 = 'Good afternoon, Anthony. What happens next: I will provide you with a further update before 5pm today, regardless of whether the issue has been fully resolved by that point.';

test('the NT-35291 sentence is a commitment for 17:00 that day (BST)', () => {
  const c = wt.detectCommitment(NT_35291, '2026-10-23T13:37:51.097+01:00');
  assert.equal(c.dueAt, '2026-10-23T16:00:00.000Z');
  assert.match(c.phrase, /before 5pm today/);
});

test('what is and is not a commitment', () => {
  const made = '2026-11-02T10:00:00Z'; // GMT
  assert.equal(wt.detectCommitment('I’ll get back to you by 3pm.', made).dueAt, '2026-11-02T15:00:00.000Z');
  assert.equal(wt.detectCommitment("I'll get back to you by 3pm.", made).dueAt, '2026-11-02T15:00:00.000Z');
  assert.equal(wt.detectCommitment('We will update you tomorrow.', made).dueAt, '2026-11-03T17:00:00.000Z');
  assert.equal(wt.detectCommitment('I will update you by end of day.', made).dueAt, '2026-11-02T17:00:00.000Z');
  // "by 9am" written in the afternoon with no day named means the next morning.
  assert.equal(wt.detectCommitment('I will let you know by 9am.', '2026-11-02T16:00:00Z').dueAt, '2026-11-03T09:00:00.000Z');
  for (const t of ['Could you update me by 5pm?', 'We are investigating today.', 'The release is at 5pm today.', 'Thanks for the update, speak tomorrow.']) {
    assert.equal(wt.detectCommitment(t, made), null, t);
  }
});

function w2(key) {
  const w = world(key);
  w.now = new Date('2026-10-23T12:40:00Z'); // 13:40 BST
  return w;
}
const commitment = (key) => db.get('SELECT * FROM watched_ticket_commitments WHERE ticket_key = ? ORDER BY id DESC', [key]);
const tcPushes = (w) => w.pushes.filter((p) => p.data.type === 'ticket_commitment');

test('watching proposes the promise in my latest public reply; confirm, remind, miss, keep', async () => {
  const w = w2('NT-2001');
  w.add(ME, NT_35291);
  const r = await wt.watch('NT-2001', w.deps);
  assert.equal(r.proposed.dueAt, '2026-10-23T16:00:00.000Z');
  let c = commitment('NT-2001');
  assert.equal(c.state, 'proposed');
  assert.equal(wt.nowCards(Date.parse('2026-10-23T15:45:00Z')).filter((x) => x.meta.ticket_key === 'NT-2001').length, 0, 'a proposal is not on Now until confirmed');

  assert.equal(wt.actOnCommitment('NT-2001', c.id, 'confirm', w.now.getTime()).ok, true);
  assert.equal(wt.actOnCommitment('NT-2001', c.id, 'confirm', w.now.getTime()).status, 409);

  // A customer reply does not keep it.
  w.add(CUSTOMER, 'Any news?');
  w.now = new Date('2026-10-23T15:31:00Z'); // 16:31, inside the 30-minute window
  await wt.check(w.deps);
  assert.equal(tcPushes(w).length, 1);
  assert.match(tcPushes(w)[0].title, /update due by 17:00/);
  assert.equal(commitment('NT-2001').state, 'open');
  assert.equal(wt.nowCards(w.now.getTime()).filter((x) => x.meta.ticket_key === 'NT-2001').length, 1);

  await wt.check(w.deps); // no second reminder
  assert.equal(tcPushes(w).length, 1);

  w.now = new Date('2026-10-23T16:05:00Z'); // 17:05, missed
  await wt.check(w.deps);
  assert.equal(w.pushes.filter((p) => p.data.key === `tc:${c.id}:missed`).length, 1);
  assert.equal(wt.nowCards(w.now.getTime()).find((x) => x.meta.ticket_key === 'NT-2001').urgency, 'critical');

  // An internal note from me does not keep it; a public reply does.
  w.add(ME, 'Internal: chased dev', false);
  await wt.check(w.deps);
  assert.equal(commitment('NT-2001').state, 'open');
  w.now = new Date('2026-10-23T16:10:00Z');
  w.add(ME, 'Hi Anthony, quick update: the fix is in testing.');
  await wt.check(w.deps);
  c = db.get('SELECT * FROM watched_ticket_commitments WHERE id = ?', [c.id]);
  assert.equal(c.state, 'kept');
  assert.equal(c.kept_late, 1);
  assert.equal(wt.nowCards(w.now.getTime()).filter((x) => x.meta.ticket_key === 'NT-2001').length, 0);
  assert.equal(tcPushes(w).length, 2, 'nothing more once kept');
});

test('a colleague’s public reply keeps my promised update; an app reply or an internal note does not (NT-35291)', async () => {
  const w = w2('NT-2010');
  await wt.watch('NT-2010', w.deps);
  assert.equal(wt.addCommitment('NT-2010', '17:30', w.now.getTime()).ok, true);
  const id = commitment('NT-2010').id;
  w.now = new Date('2026-10-23T15:50:00Z');
  w.add(BOT, 'Your ticket is now with development.');
  w.add(AGENT, 'Internal: checked the form store', false);
  await wt.check(w.deps);
  assert.equal(commitment('NT-2010').state, 'open');
  w.add(AGENT, 'Hi Anthony, I wanted to update you on the website enquiries. I will update you again by 9am tomorrow.');
  await wt.check(w.deps);
  const c = db.get('SELECT * FROM watched_ticket_commitments WHERE id = ?', [id]);
  assert.equal(c.state, 'kept');
  assert.equal(c.kept_late, 0);
  assert.equal(c.closed_by, 'reply:Hope Agent');
  assert.equal(db.all("SELECT * FROM watched_ticket_commitments WHERE ticket_key = 'NT-2010' AND state = 'proposed'").length, 0,
    'a colleague’s promise is not proposed as mine');
});

test('a new promise in a later reply is proposed, and replaces an unconfirmed one', async () => {
  const w = w2('NT-2002');
  await wt.watch('NT-2002', w.deps);
  w.add(ME, 'I will update you by 3pm today.');
  await wt.check(w.deps);
  const first = commitment('NT-2002');
  assert.equal(first.state, 'proposed');
  w.now = new Date('2026-10-23T13:00:00Z');
  w.add(ME, 'Still investigating. I will update you again by 5pm today.');
  await wt.check(w.deps);
  assert.equal(db.get('SELECT state FROM watched_ticket_commitments WHERE id = ?', [first.id]).state, 'dismissed');
  assert.equal(commitment('NT-2002').due_at, '2026-10-23T16:00:00.000Z');
});

test('confirmed inside the 30-minute window: no "due soon" push, still one if missed', async () => {
  const w = w2('NT-2003');
  await wt.watch('NT-2003', w.deps);
  w.now = new Date('2026-10-23T15:45:00Z'); // 16:45
  assert.equal(wt.addCommitment('NT-2003', '17:00', w.now.getTime()).ok, true);
  await wt.check(w.deps);
  assert.equal(tcPushes(w).length, 0);
  w.now = new Date('2026-10-23T16:01:00Z');
  await wt.check(w.deps);
  assert.equal(tcPushes(w).length, 1);
});

test('adding by hand refuses junk and the past; dismiss, done and unwatch close it', async () => {
  const w = w2('NT-2004');
  await wt.watch('NT-2004', w.deps);
  const now = w.now.getTime();
  assert.equal(wt.addCommitment('NT-2004', '5pm', now).status, 400);
  assert.equal(wt.addCommitment('NT-2004', '2026-02-31T10:00', now).status, 400);
  assert.equal(wt.addCommitment('NT-2004', '09:00', now).status, 400, 'already passed today');
  assert.equal(wt.addCommitment('NT-9998', '17:00', now).status, 404);
  const a = wt.addCommitment('NT-2004', '2026-10-24T10:00', now).commitment;
  assert.equal(a.dueAt, '2026-10-24T09:00:00.000Z');
  assert.equal(wt.actOnCommitment('NT-2004', a.id, 'done', now).commitment.state, 'kept');
  const b = wt.addCommitment('NT-2004', '17:00', now).commitment;
  assert.equal(wt.actOnCommitment('NT-2004', b.id, 'dismiss', now).commitment.state, 'cancelled');
  assert.equal(wt.actOnCommitment('NT-2004', b.id, 'explode', now).status, 400);
  const c = wt.addCommitment('NT-2004', '18:00', now).commitment;
  wt.unwatch('NT-2004');
  assert.equal(db.get('SELECT state FROM watched_ticket_commitments WHERE id = ?', [c.id]).state, 'cancelled');
});

test('commitment routes answer over real HTTP', async () => {
  const w = w2('NT-2005');
  await wt.watch('NT-2005', w.deps);
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/escalation', require('../routes/escalation'));
  const server = app.listen(0);
  const root = `http://127.0.0.1:${server.address().port}/api/escalation/watched`;
  const base = `${root}/NT-2005/commitments`;
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await post(base, { due: 'soon' })).status, 400);
    const ok = await post(base, { due: '2099-01-05T10:00' });
    assert.equal(ok.status, 200);
    const { commitment: c } = await ok.json();
    assert.equal((await post(`${base}/${c.id}/confirm`)).status, 409, 'already open');
    assert.equal((await post(`${base}/${c.id}/done`)).status, 200);
    const listed = await (await fetch(root)).json();
    assert.ok(listed.active.find((t) => t.key === 'NT-2005').commitments.some((x) => x.state === 'kept'));
  } finally {
    server.close();
  }
});

test('a reply only keeps commitments made BEFORE it (one added by hand after the reply stays open)', async () => {
  const w = w2('NT-2006');
  await wt.watch('NT-2006', w.deps);
  w.add(ME, 'Thanks, looking into it now.'); // posted 13:40, poll has not run yet
  w.now = new Date('2026-10-23T12:45:00Z');
  const c = wt.addCommitment('NT-2006', '17:00', w.now.getTime()).commitment;
  await wt.check(w.deps);
  assert.equal(db.get('SELECT state FROM watched_ticket_commitments WHERE id = ?', [c.id]).state, 'open');
});
