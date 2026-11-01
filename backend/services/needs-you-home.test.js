'use strict';
// SAiM's home "Needs you" (Nick, 1 Nov 2026): everything to act on right now —
// urgent, or pushed and not yet answered — stays until answered or no longer true.
const { test } = require('node:test');
const assert = require('node:assert');
const { composePresentation, actNow } = require('./presentation-intent');

const card = (o) => ({ kind: 'item', id: o.id, recordId: `r-${o.id}`, title: o.id, type: 'todo', state: 'active', actions: ['acknowledge', 'complete'], ...o });

test('a high card or a pushed card needs him; a quiet unpushed one does not', () => {
  assert.equal(actNow(card({ id: 'a', urgency: 'high' })), true);
  assert.equal(actNow(card({ id: 'b', urgency: 'medium', notifiedAt: '2026-11-01T09:00:00Z' })), true);
  assert.equal(actNow(card({ id: 'c', urgency: 'medium' })), false);
});

test('an answered card leaves Needs you', () => {
  assert.equal(actNow(card({ id: 'a', urgency: 'high', state: 'acknowledged' })), false);
  assert.equal(actNow(card({ id: 'b', urgency: 'high', state: 'deferred' })), false);
});

test('Needs you holds every act-now card, and none is repeated in the tracked list', () => {
  const p = composePresentation({
    primary: card({ id: 'lead', urgency: 'high' }),
    secondary: [
      card({ id: 'x', urgency: 'critical' }),
      card({ id: 'y', urgency: 'high' }),
      card({ id: 'z', urgency: 'medium', notifiedAt: '2026-11-01T09:00:00Z' }),
      card({ id: 'q', urgency: 'low' }),
    ],
    needsYouCap: 3,
  });
  const ids = p.needsYou.map((n) => n.actionRef && n.actionRef.cardId);
  assert.deepEqual(ids, ['x', 'y', 'z']);
  assert.equal(p.needsYou.find((n) => n.actionRef.cardId === 'z').pushed, true);
  const tracked = p.tracked.map((t) => t.actionRef.cardId);
  assert.ok(!tracked.includes('y') && !tracked.includes('z'));
  assert.ok(tracked.includes('q'));
  assert.equal(p.needsYouCap, 3);
});
