'use strict';

/**
 * Replies to an escalation EMAIL (6 Nov 2026): a signal on the ticket, never a
 * second inbox. The pure fold decides what counts as a reply and when it is
 * seen; sync is driven against a fake DB/KV and a fake mailbox.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./escalation-replies');

const SENT = '2026-11-06T09:34:00Z';
const thread = { ticket: 'TS-7880', actionId: 'pa_1', conversationId: 'CONV', sentAt: SENT };
const entry = (over) => ({ id: 'm1', conversationId: 'CONV', from: 'Chris Middleton', fromEmail: 'Chris.Middleton@nurtur.tech', received: '2026-11-06T10:42:00Z', dismissed: false, ...over });

test('a reply on the thread, after the send, from someone else, is recorded unseen', () => {
  const r = R.fold({ threads: [thread], entries: [entry()], self: ['nickw@nurtur.tech'] });
  assert.equal(r.added, 1);
  const rep = r.replies.m1;
  assert.equal(rep.ticket, 'TS-7880');
  assert.equal(rep.from, 'Chris Middleton');
  assert.equal(rep.seenAt, null);
  assert.ok(!('body' in rep) && !('preview' in rep) && !('subject' in rep), 'who and when only — never the mail');
});

test('not a reply: other thread, before the send, from Nick himself', () => {
  const r = R.fold({ threads: [thread], self: ['nickw@nurtur.tech'], entries: [
    entry({ id: 'a', conversationId: 'OTHER' }),
    entry({ id: 'b', received: '2026-11-06T09:00:00Z' }),
    entry({ id: 'c', fromEmail: 'NickW@nurtur.tech' }),
  ] });
  assert.equal(r.added, 0);
});

test('seen when the inbox card is dealt with, or pruned from the store', () => {
  const stored = R.fold({ threads: [thread], entries: [entry(), entry({ id: 'm2', received: '2026-11-06T11:00:00Z' })] }).replies;
  const r = R.fold({ threads: [thread], stored, entries: [entry({ dismissed: true, dismissedAt: '2026-11-06T12:00:00Z' })] });
  assert.equal(r.replies.m1.seenBy, 'inbox');
  assert.equal(r.replies.m2.seenBy, 'inbox', 'gone from the store = pruned = it was dismissed');
  assert.equal(r.seen, 2);
});

test('seen when Nick sends on the thread after the reply (answered from Outlook); not before', () => {
  const stored = R.fold({ threads: [thread], entries: [entry()] }).replies;
  const before = R.fold({ threads: [thread], stored, entries: [entry()], sent: [{ conversationId: 'CONV', sentAt: '2026-11-06T10:00:00Z' }] });
  assert.equal(before.replies.m1.seenAt, null, 'his own escalation email is not an answer to the reply');
  const after = R.fold({ threads: [thread], stored, entries: [entry()], sent: [{ conversationId: 'CONV', sentAt: '2026-11-06T11:15:00Z' }] });
  assert.equal(after.replies.m1.seenBy, 'you-replied');
});

test('an unread Sent Items (null) marks nothing seen', () => {
  const stored = R.fold({ threads: [thread], entries: [entry()] }).replies;
  assert.equal(R.fold({ threads: [thread], stored, entries: [entry()], sent: null }).replies.m1.seenAt, null);
});

test('summarise: count, unseen and the newest reply per ticket', () => {
  const s = R.summarise({
    a: { emailId: 'a', ticket: 'TS-7880', from: 'Chris', at: '2026-11-06T10:00:00Z', seenAt: 'x' },
    b: { emailId: 'b', ticket: 'TS-7880', from: 'Alex', at: '2026-11-06T14:05:00Z', seenAt: null },
  });
  assert.equal(s['TS-7880'].count, 2);
  assert.equal(s['TS-7880'].unseen, 1);
  assert.equal(s['TS-7880'].latest.from, 'Alex');
});

test('sync: resolves the thread from Sent Items once, records, persists', async () => {
  const kv = {};
  const db = { getState: (k) => kv[k] || null, setState: (k, v) => { kv[k] = v; } };
  const dbh = { prepare: () => ({ all: () => [{ action_id: 'pa_1', status: 'verified', executed_at: SENT, evidence_json: '{"ticket":"TS-7880"}', imid: '<x@y>' }] }) };
  let lookups = 0;
  const mail = { findSent: async () => { lookups++; return { ok: true, messages: [{ conversationId: 'CONV', sentAt: SENT }] }; } };
  const deps = { db, dbh, mail, self: ['nickw@nurtur.tech'] };
  const r1 = await R.sync({ entries: [entry()], deps });
  assert.equal(r1.added, 1);
  const r2 = await R.sync({ entries: [entry()], deps });
  assert.equal(r2.added, 0, 'recorded once');
  assert.equal(lookups, 1, 'the thread is looked up once, then remembered');
  assert.equal(R.byTicket({ db })['TS-7880'].unseen, 1);
  assert.deepEqual(R.ticketByEmail({ db }), { m1: 'TS-7880' });
});

test('an unreadable reply store is not overwritten and reads as null', async () => {
  const kv = { [R.STORE_KEY]: '{not json' };
  const db = { getState: (k) => kv[k] || null, setState: (k, v) => { kv[k] = v; } };
  assert.equal(R.byTicket({ db }), null);
});
