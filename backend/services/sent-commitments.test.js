'use strict';
// What Nick said HE would do, in mail he sent (5 Oct 2026).
const { test } = require('node:test');
const assert = require('node:assert');
const sc = require('./sent-commitments');
const { inferOrigin } = require('../../shared/task-origin.cjs');
const { describeCandidateSource } = require('./candidate-provenance');

const msg = (over = {}) => ({ id: 'AAMk1', subject: 'RE: UAT this week', to: [{ name: 'Dan Short', email: 'dan.short@nurtur.tech' }], cc: [], sentAt: '2026-10-05T13:29:00Z', text: "Thanks Dan, I'll send you the team's availability by Wednesday.", ...over });

test('only his own words are asked about; automated mail in his name and seen mail are skipped', () => {
  const ledger = { seen: { at: new Date().toISOString() } };
  const out = sc.eligible([
    msg(),
    msg({ id: 'seen' }),
    msg({ id: 'acc', subject: 'Accepted: Support leadership' }),
    msg({ id: 'empty', text: 'ok' }),
  ], ledger);
  assert.deepEqual(out.map((m) => m.id), ['AAMk1']);
});

test('the prompt asks for his promises, not his requests of others', () => {
  const p = sc.buildPrompt([msg()]);
  assert.match(p, /NICK HIMSELF said he will do/);
  assert.match(p, /What he asks someone else to do is not his task/);
  assert.match(p, /To: Dan Short/);
});

test('answers parse to at most two usable actions; a truncated answer throws (retried, never "nothing")', () => {
  const m = sc.parseAnswer('[{"index":0,"actions":["Send Dan the team availability for UAT","x","Book the room","Third"]},{"index":1,"actions":null}]', 2);
  assert.deepEqual(m.get(0), ['Send Dan the team availability for UAT', 'Book the room']);
  assert.deepEqual(m.get(1), []);
  assert.throws(() => sc.parseAnswer('[{"index":0,"actions":["Send', 1));
});

test('a candidate is review-only, says who he told, and becomes a commitment when approved', () => {
  const c = sc.buildCandidate(msg(), 'Send Dan the team availability for UAT');
  assert.equal(c.autoPromote, false);
  assert.ok(c.confidence < 0.7);
  assert.match(c.reason, /You said you would — in your email to Dan Short/);
  const prov = describeCandidateSource(c.payload);
  assert.equal(prov.label, 'Email you sent to Dan Short');
  assert.equal(inferOrigin({ source: c.payload.source }).origin, 'commitment');
});
