'use strict';

/**
 * Build 6 — the REAL Microsoft mail transport's classification, driven against
 * a fake `fetch`. The executor's own suite uses a fake mailbox, so without this
 * file the one judgement that decides "proven unsent" versus "may have gone" —
 * how an HTTP answer is classified — would have no test at all (a mutation
 * turning every uncertain send into a proven-unsent one survived until this
 * file existed).
 *
 *   run: node --test backend/services/action-mail.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
let token = 'tok';
stub('./microsoft', {
  getAccessToken: async () => token,
  getSignedInAddress: async () => 'nickw@nurtur.tech',
  fetchSentMail: async () => ({ messages: [{ to: ['chris.middleton@nurtur.tech'], cc: [] }], complete: true }),
});
const mail = require('./action-mail');

const realFetch = global.fetch;
let calls = [];
function answer(fn) {
  calls = [];
  global.fetch = async (url, init) => { calls.push({ url, init }); return fn(url, init); };
}
const res = (status, body) => ({ status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
test.after(() => { global.fetch = realFetch; });

test('send: 202 is accepted (transport evidence only)', async () => {
  answer(() => res(202));
  assert.deepEqual(await mail.sendDraft('d1'), { outcome: 'accepted', status: 202 });
  assert.match(calls[0].url, /\/me\/messages\/d1\/send$/);
  assert.equal(calls[0].init.method, 'POST');
});

test('send: a definitive refusal before processing is REJECTED (proven unsent)', async () => {
  for (const status of [400, 401, 403, 404, 409]) {
    answer(() => res(status, { error: { code: 'x' } }));
    assert.equal((await mail.sendDraft('d1')).outcome, 'rejected', `HTTP ${status}`);
  }
  token = null;
  answer(() => { throw new Error('must not be called without a token'); });
  assert.equal((await mail.sendDraft('d1')).outcome, 'rejected', 'no token: nothing was asked, nothing sent');
  token = 'tok';
});

test('send: anything else is UNCERTAIN — 5xx, 429, timeout, network — never "unsent"', async () => {
  for (const status of [500, 502, 503, 504, 429]) {
    answer(() => res(status));
    assert.equal((await mail.sendDraft('d1')).outcome, 'uncertain', `HTTP ${status}`);
  }
  answer(() => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; });
  const t = await mail.sendDraft('d1');
  assert.equal(t.outcome, 'uncertain');
  assert.equal(t.category, 'timeout');
  answer(() => { throw new TypeError('fetch failed'); });
  assert.equal((await mail.sendDraft('d1')).outcome, 'uncertain');
});

test('draft: returns the provider message id; the body goes as Text to exactly the given recipient, no CC', async () => {
  answer(() => res(201, { id: 'AAMk1', internetMessageId: '<a@b>' }));
  const r = await mail.createDraft({ to: [{ email: 'chris.middleton@nurtur.tech', name: 'Chris Middleton' }], subject: 's', body: 'b' });
  assert.deepEqual(r, { ok: true, id: 'AAMk1', internetMessageId: '<a@b>', status: 201 });
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.body.contentType, 'Text');
  assert.deepEqual(sent.toRecipients.map((x) => x.emailAddress.address), ['chris.middleton@nurtur.tech']);
  assert.equal(sent.ccRecipients, undefined);
  assert.match(calls[0].url, /\/me\/messages$/);
  answer(() => res(503));
  assert.equal((await mail.createDraft({ to: [{ email: 'x@y.z' }], subject: 's', body: 'b' })).ok, false);
});

test('findSent: filters Sent Items by internetMessageId; "could not look" is never an empty folder', async () => {
  answer(() => res(200, { value: [{ id: 's1', internetMessageId: '<a@b>', subject: 's', toRecipients: [{ emailAddress: { address: 'Chris.Middleton@nurtur.tech' } }],
    from: { emailAddress: { address: 'nickw@nurtur.tech' } }, sentDateTime: '2026-10-03T09:02:00Z', body: { content: 'b' } }] }));
  const r = await mail.findSent("<a'@b>");
  assert.equal(r.ok, true);
  assert.deepEqual(r.messages[0].to, ['chris.middleton@nurtur.tech']);
  assert.match(decodeURIComponent(calls[0].url), /SentItems\/messages\?\$filter=internetMessageId eq '<a''@b>'/);
  answer(() => res(500));
  assert.equal((await mail.findSent('<a@b>')).ok, false);
  answer(() => { throw new TypeError('fetch failed'); });
  assert.equal((await mail.findSent('<a@b>')).ok, false);
});

test('draftState / deleteDraft: only a draft PROVEN still a draft is deleted', async () => {
  answer(() => res(200, { isDraft: true }));
  assert.equal(await mail.draftState('d'), 'draft');
  answer(() => res(404));
  assert.equal(await mail.draftState('d'), 'gone');
  answer(() => res(200, { isDraft: false }));
  assert.equal(await mail.draftState('d'), 'not-draft');
  answer((url, init) => (init.method === 'DELETE' ? res(204) : res(200, { isDraft: false })));
  assert.equal(await mail.deleteDraft('d'), false);
  assert.ok(!calls.some((c) => c.init.method === 'DELETE'), 'a sent message is never deleted');
});
