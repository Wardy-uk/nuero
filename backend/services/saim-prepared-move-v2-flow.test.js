'use strict';

/**
 * The client flow for a v2 proposal (saim/app/src/preparedMove.mjs), driven
 * with fake API answers: a stored proposal is confirmed by ITS record id (never
 * re-prepared), "Make this ready" calls /prepare with the Now item's ref only,
 * defer/decline/answer send exactly the store's fields, and a reply step's
 * receipt line says it was NOT sent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const MOD = pathToFileURL(path.resolve(__dirname, '..', '..', 'saim', 'app', 'src', 'preparedMove.mjs')).href;
const MOVE = { version: 2, recordId: 'pm_0123456789abcdef0123', recordVersion: 3, kind: 'email-reply', plan: 'draft', options: [{ id: 'approve' }], prepared: { headline: 'I drafted the reply to Sam.' } };
const VIEW = { contract: 'prepared-move-view-v1', move: MOVE, authority: { boundary: null } };

function fakeCall(answers) {
  const calls = [];
  const fn = async (p, opts = {}) => { calls.push({ p, ...opts }); const a = answers[`${opts.method || 'GET'} ${p}`]; return typeof a === 'function' ? a(opts) : a; };
  fn.calls = calls;
  return fn;
}

test('load: nothing prepared but a Now item SAiM could take forward → an offer', async () => {
  const m = await import(MOD);
  const call = fakeCall({ 'GET /api/prepared-moves/current': { status: 200, body: { contract: 'prepared-move-view-v1', move: null, makeReady: { ref: 'held:email-urgent', title: 'Renewal', label: 'Draft the reply' } } } });
  const s = await m.load(call);
  assert.equal(s.kind, 'offer'); assert.equal(s.offer.ref, 'held:email-urgent');
});

test('askToConfirm: a stored v2 proposal is requested by its recordId', async () => {
  const m = await import(MOD);
  const call = fakeCall({ 'POST /api/prepared-moves/request': { status: 200, body: { ok: true, grantId: 'ig_x' } } });
  await m.askToConfirm(call, { view: VIEW, option: 'approve', sessionId: 'saim_abcdefgh' });
  assert.deepEqual(call.calls[0].body, { option: 'approve', sessionId: 'saim_abcdefgh', recordId: MOVE.recordId });
});

test('makeReady sends the ref and nothing else; respond and answer send the store’s fields', async () => {
  const m = await import(MOD);
  const call = fakeCall({
    'POST /api/prepared-moves/prepare': { status: 409, body: { ok: false, error: 'It reads as an employment matter.' } },
    'POST /api/prepared-moves/respond': { status: 200, body: { ok: true, until: '2026-10-24T09:00:00Z' } },
    'POST /api/prepared-moves/answer': { status: 409, body: { ok: false, error: 'not a question this move asked' } },
  });
  const r = await m.makeReady(call, { offer: { ref: 'held:x' } });
  assert.deepEqual(call.calls[0].body, { ref: 'held:x' });
  assert.equal(r.kind, 'note'); assert.match(r.message, /employment/);
  const d = await m.respond(call, { view: VIEW, response: 'defer', days: 3, reason: 'not-now' });
  assert.deepEqual(call.calls[1].body, { recordId: MOVE.recordId, version: 3, response: 'defer', reason: 'not-now', days: 3 });
  assert.match(d.message, /2026-10-24/);
  const a = await m.answer(call, { view: VIEW, questionId: 'purpose', text: 'cover the rota' });
  assert.equal(a.keep, true, 'a refused answer stays in the box'); assert.match(a.message, /still in the box/);
});

test('receipt lines: a reply step says it is in Actions and NOT sent', async () => {
  const m = await import(MOD);
  const lines = m.receiptLines({ steps: [{ step: 'reply', status: 'done' }, { step: 'note', status: 'failed', provablyNotApplied: true }] });
  assert.equal(lines[0].step, 'Reply draft'); assert.match(lines[0].status, /not sent/);
  assert.equal(lines[1].status, 'not saved');
});
