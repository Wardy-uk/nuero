'use strict';

/**
 * "Deferring should remove something from Now" (Nick, 13 Oct 2026). A capacity
 * card was put off for two hours and stayed on Now, labelled DEFERRED: its item
 * declares `dedupeKey: capacity:start:…`, `attention.itemCard` DROPPED it, the
 * record was filed as `capacity:capacity-start-…`, and the deferred filter looked
 * for the explicit key. Both halves pinned, plus the adoption of records already
 * filed the old way (Nick's live deferral was one).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-defkey-')), 'a.db');

const db = require('../db/database');
const lifecycle = require('./attention-lifecycle');
const attention = require('./attention');

test.before(async () => { await db.init(); });

const NOW = new Date('2026-10-13T09:20:00Z');
const ITEM = {
  type: 'capacity', id: 'capacity-start-345-2026-10-12', dedupeKey: 'capacity:start:345:2026-10-12',
  title: 'NT-24162 is overdue — 4h of work', reason: 'Sized at 4h.', urgency: 'high', tier: 1, score: 80,
};

test('the gate keeps the item’s own key on the card it builds', () => {
  const g = attention.gate({ activity: 'steady', confidence: { level: 'high' } }, [ITEM], NOW);
  assert.ok(g.primary, 'positive control: the capacity card is the primary');
  assert.equal(g.primary.dedupeKey, 'capacity:start:345:2026-10-12');
  assert.equal(lifecycle.dedupeKeyFor(g.primary), lifecycle.dedupeKeyFor(ITEM), 'record and filter agree on ONE key');
});

test('legacyKeyFor names the old key only when it differs', () => {
  assert.equal(lifecycle.legacyKeyFor(ITEM), 'capacity:capacity-start-345-2026-10-12');
  assert.equal(lifecycle.legacyKeyFor({ type: 'todo', title: 'x' }), null);
});

test('a deferral filed under the OLD key is adopted, not reset — and it holds', () => {
  // As it sits on the Pi: opened from a card that had lost its key, then deferred.
  const legacyCard = { ...ITEM, dedupeKey: undefined };
  const row = lifecycle.upsert(legacyCard, { now: NOW });
  assert.equal(row.dedupe_key, 'capacity:capacity-start-345-2026-10-12');
  assert.equal(lifecycle.act(row.id, 'defer', { now: NOW, minutes: 120, reason: 'not-now' }).ok, true);

  // The deferred filter recognises it by either key before any re-key happens.
  const held = lifecycle.deferredKeys(new Date(NOW.getTime() + 60000));
  assert.ok(held.get(lifecycle.dedupeKeyFor(ITEM)) || held.get(lifecycle.legacyKeyFor(ITEM)), 'filtered on the first poll');

  // The next reconcile, now carrying the explicit key, adopts the same record.
  const again = lifecycle.upsert(ITEM, { now: new Date(NOW.getTime() + 120000) });
  assert.equal(again.id, row.id, 'the same record, not a fresh active one');
  assert.equal(again.state, 'deferred', 'the deferral survives');
  assert.equal(db.getOpenAttentionRecord('capacity:start:345:2026-10-12').id, row.id);
});
