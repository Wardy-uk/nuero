'use strict';

/**
 * The reflection reaches the desktop — end to end, through a real DB.
 *
 * ⚠ WHY THIS IS A SEPARATE FILE FROM THE PURE `assess()` TESTS. Those pin the
 * JUDGEMENT and hand it a `knowledge` block they built themselves, so they pass
 * perfectly with `generateReflection` never writing the stamp, with
 * `getLastTabOpenAt` querying the wrong JSON key, and with `snapshot()` not
 * calling either. That is this morning's `readVantage` lesson, one service
 * along: A STUB CANNOT TEST THE THING IT REPLACES. Three separate pieces have
 * to agree here — a writer in knowledge-memory, a query in database.js and a
 * reader in state-of-play — and only a real round trip sees them agree.
 *
 * The failure being defended against is not hypothetical. Before 21 Sep 2026 a
 * knowledge reflection's ENTIRE reach was one web push, so on a morning when
 * both registered push endpoints turned out to be the iPhone, it was written,
 * announced to a device Nick was not holding, and invisible on the machine he
 * was sitting at.
 *
 * ⚠ NEVER point this at the live agent.db or the live vault.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-kreflect-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
process.env.OBSIDIAN_VAULT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-kvault-'));

const db = require('../db/database');
const activity = require('./activity');
const sop = require('./state-of-play');

test.before(async () => { await db.init(); });

/** What `generateReflection` stores, without paying for a whole vault scan. */
function stamp(at, name = '2026-09-21 - Knowledge Reflection') {
  db.setState('knowledge_reflection_last', JSON.stringify({
    at, path: 'Knowledge/Reflections/x.md', name,
  }));
}

test('generateReflection stamps the write, so the desktop does not depend on push', () => {
  // ⚠ THE REAL WRITER, not a hand-built stamp. The stamp deliberately goes with
  // the vault write rather than beside `sendToAll`: the whole point is that the
  // card survives push being unsubscribed, broken or suppressed, which is the
  // case that prompted it. A stamp written next to the push would go missing in
  // exactly the situation it exists to cover.
  db.setState('knowledge_reflection_last', '');
  const km = require('./knowledge-memory');
  const result = km.generateReflection({ write: true });
  assert.equal(result.status, 'ok');
  assert.ok(result.path, 'it must have written a note');

  const raw = db.getState('knowledge_reflection_last');
  assert.ok(raw, 'generateReflection must record the write — without this the panel never fires');
  const parsed = JSON.parse(raw);
  assert.ok(Number.isFinite(Date.parse(parsed.at)), `the stamp must carry a real timestamp, got ${parsed.at}`);
  assert.ok(parsed.name && /Knowledge Reflection/.test(parsed.name), `and a readable name, got ${parsed.name}`);
});

test('snapshot carries the knowledge block, and assess turns it into a card', () => {
  // The join: writer -> KV -> snapshot -> assess -> an issue with a `view`.
  db.setState('knowledge_reflection_last', '');
  stamp(new Date(Date.now() - 2 * 3600 * 1000).toISOString());

  const snap = sop.snapshot();
  assert.ok(snap.knowledge, 'snapshot() must carry the knowledge block');
  assert.ok(snap.knowledge.announcedAt, 'and it must have read the stamp');

  const issue = sop.assess(snap).find(i => /knowledge reflection/i.test(i.title));
  assert.ok(issue, 'a reflection written two hours ago must reach the panel');
  assert.equal(issue.view, 'insights', 'and it must be actionable — the card opens Insights');
});

// ⚠ ORDER MATTERS AND IS DELIBERATE: this logs an Insights open, which
// correctly CLEARS the card, so it has to come after the test that proves
// the card appears. Caught by the suite rather than by reading — which is
// also a live demonstration that the clearing path works.
test('getLastTabOpenAt finds a real logged open', () => {
  // ⚠ The query reads `json_extract(event_data, '$.tab')`, and `trackTabOpen` is
  // what decides that key's name. A test that writes the row by hand would pass
  // over a mismatch between them — which is silent, because a wrong key returns
  // no rows rather than an error, and no rows reads as "never opened".
  activity.trackTabOpen('insights');
  const at = db.getLastTabOpenAt('insights', '2000-01-01');
  assert.ok(at, 'an open logged through the real writer must be findable');

  assert.equal(
    db.getLastTabOpenAt('a-tab-nobody-has-opened', '2000-01-01'), null,
    'and a tab never opened is null, not a stray row'
  );
});

test('an open logged after the reflection clears the card, through the real query', () => {
  // ⚠ Clock-derived, never a fixed date. A fixture dated in the past would age
  // out of REFLECTION_FRESH_DAYS the moment real time moved past it, and this
  // file would start passing for the wrong reason — the date bomb that has bitten
  // this repo twice.
  db.setState('knowledge_reflection_last', '');
  stamp(new Date(Date.now() - 2 * 3600 * 1000).toISOString());
  activity.trackTabOpen('insights'); // now, i.e. after it was written

  const issue = sop.assess(sop.snapshot()).find(i => /knowledge reflection/i.test(i.title));
  assert.equal(issue, undefined, 'he has been to Insights since — there is nothing to say');
});

test('an unreadable stamp is silence, never a card and never a crash', () => {
  // The panel must not invent an alarm OR an all-clear out of a bad KV value.
  db.setState('knowledge_reflection_last', '{not json');
  let snap;
  assert.doesNotThrow(() => { snap = sop.snapshot(); });
  assert.equal(snap.knowledge.announcedAt, null);
  assert.equal(sop.assess(snap).find(i => /knowledge reflection/i.test(i.title)), undefined);
});
