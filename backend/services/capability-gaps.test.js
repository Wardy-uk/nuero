'use strict';

/**
 * Capability gaps — the usefulness test, the learning loop, and the routes.
 *
 * The pure half pins the test that makes a suggestion allowed to exist; the
 * real half drives refresh() against a scratch DB with the model stubbed (the
 * model is the one thing a test should not call), then the routes over real
 * HTTP, because a green service suite says nothing about routing.
 *
 *   run: node --test backend/services/capability-gaps.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-capgap-')), 'a.db');
delete process.env.OBSIDIAN_VAULT_PATH;
delete process.env.HA_TOKEN;

const db = require('../db/database');
const cap = require('./capability-gaps');

test.before(async () => { await db.init(); });

const EV = new Map([
  ['goal:1', { kind: 'goal', text: 'Hike weekly (important-to-me)' }],
  ['health:1', { kind: 'health', text: '[act] Blood pressure is averaging 144/86.' }],
  ['sense:1', { kind: 'sense', text: 'Bedroom sensor is stale' }],
  ['setup:1', { kind: 'setup', text: 'Apple push (APNs) key (todo)' }],
]);

const good = (over = {}) => ({
  title: 'Fit a temperature sensor in the bedroom',
  anchors: ['health:1', 'sense:1'],
  unlocks: 'Whether a warmer bedroom costs you sleep.',
  changes: 'You would set the heating schedule overnight on evidence.',
  need: { kind: 'sensor', what: 'A Zigbee temperature sensor fixed in the bedroom', how: 'Pair it in HA', effort: 'small' },
  ...over,
});

// ── the usefulness test ────────────────────────────────────────────────────

test('a suggestion with a personal anchor and all three answers passes', () => {
  const j = cap.judge(good(), EV);
  assert.equal(j.ok, true);
  assert.equal(j.suggestion.need.kind, 'sensor');
  assert.deepEqual(j.suggestion.anchorText.map((a) => a.kind), ['health', 'sense']);
});

test('the CO2 case: anchored only to a sense or set-up item is refused — nothing he cares about', () => {
  const j = cap.judge(good({ anchors: ['sense:1', 'setup:1'] }), EV);
  assert.equal(j.ok, false);
  assert.match(j.why, /nothing you care about/);
});

test('citing evidence that was not in the pack is refused, never trusted', () => {
  const j = cap.judge(good({ anchors: ['goal:1', 'goal:99'] }), EV);
  assert.equal(j.ok, false);
  assert.match(j.why, /does not exist/);
});

test('each of the three answers is required', () => {
  assert.equal(cap.judge(good({ unlocks: '' }), EV).ok, false);
  assert.equal(cap.judge(good({ changes: '  ' }), EV).ok, false);
  assert.equal(cap.judge(good({ need: { kind: 'sensor', what: '' } }), EV).ok, false);
  assert.equal(cap.judge(good({ need: { kind: 'wish', what: 'x' } }), EV).ok, false);
  assert.equal(cap.judge(good({ anchors: [] }), EV).ok, false);
});

test('a truncated model answer is refused whole, never partly kept', () => {
  assert.equal(cap.parseProposals('[{"title":"a"},{"title":"b"').ok, false);
  assert.equal(cap.parseProposals('here you go: []').ok, true);
});

// ── learning: verdicts ───────────────────────────────────────────────────────

function judged(over = {}, ev = EV) {
  const s = cap.judge(good(over), ev).suggestion;
  return { ...s, fingerprint: cap.fingerprint(s), anchorHash: cap.anchorHash(s.anchors, ev) };
}

test('a rejected suggestion does not return while its evidence is unchanged', () => {
  let store = cap.merge({ items: [] }, [judged()], '2026-10-01T08:00:00Z');
  store.items[0].status = 'rejected';
  store.items[0].reason = 'I already know my bedroom is cold';
  const again = cap.merge(store, [judged()], '2026-10-08T08:00:00Z');
  assert.equal(again.items.filter((x) => x.status === 'open').length, 0);
  assert.equal(again.suppressed.length, 1);
});

test('…but returns, saying why, when the evidence it cites has changed', () => {
  let store = cap.merge({ items: [] }, [judged()], '2026-10-01T08:00:00Z');
  store.items[0].status = 'rejected';
  store.items[0].reason = 'not now';
  const ev2 = new Map(EV);
  ev2.set('health:1', { kind: 'health', text: '[act] Blood pressure is averaging 152/94.' });
  const again = cap.merge(store, [judged({}, ev2)], '2026-10-08T08:00:00Z');
  const open = again.items.filter((x) => x.status === 'open');
  assert.equal(open.length, 1);
  assert.match(open[0].reopenedBecause, /evidence/);
  assert.equal(open[0].previousRejection, 'not now');
});

test('an accepted suggestion is never offered again, however the evidence moves', () => {
  let store = cap.merge({ items: [] }, [judged()], '2026-10-01T08:00:00Z');
  store.items[0].status = 'accepted';
  const ev2 = new Map(EV);
  ev2.set('health:1', { kind: 'health', text: 'different' });
  const again = cap.merge(store, [judged({}, ev2)], '2026-10-08T08:00:00Z');
  assert.equal(again.items.filter((x) => x.status === 'open').length, 0);
});

test('rejection reasons are taught back in the prompt', () => {
  const p = cap.buildPrompt({ evidence: [{ id: 'goal:1', kind: 'goal', text: 'Hike weekly' }], decided: [{ status: 'rejected', title: 'CO2 sensor', reason: 'I do not care about air' }], captured: [] });
  assert.match(p, /I do not care about air/);
  assert.match(p, /goal:1 — goal — Hike weekly/);
});

test('an observed miss is recognised; an ordinary answer is not', () => {
  assert.ok(cap.MISS_RE.test("I don't have access to your smart home system"));
  assert.ok(cap.MISS_RE.test('I can’t see your Mac'));
  assert.ok(!cap.MISS_RE.test('Your next meeting is at 14:00.'));
});

// ── real: refresh → store → routes ──────────────────────────────────────────

function seedChat() {
  const d = db.getDb();
  d.prepare("INSERT INTO conversations (conversation_id, role, content, created_at) VALUES ('c1','user','what temperature was the bedroom last night?', datetime('now','-1 day'))").run();
  d.prepare("INSERT INTO conversations (conversation_id, role, content, created_at) VALUES ('c1','assistant','I don''t have access to a bedroom temperature reading.', datetime('now','-1 day'))").run();
}

test('refresh: grounded suggestions are kept, ungrounded ones refused and named', async () => {
  seedChat();
  let seenPrompt = '';
  const r = await cap.refresh({
    ask: async (prompt) => {
      seenPrompt = prompt;
      return JSON.stringify([
        good({ anchors: ['miss:1', 'asked:1'] }),
        { title: 'A CO2 sensor', anchors: ['nonsense:1'], unlocks: 'air', changes: 'open a window', need: { kind: 'sensor', what: 'CO2 sensor' } },
      ]);
    },
  });
  assert.equal(r.ok, true, r.why);
  assert.match(seenPrompt, /miss:1 — miss — .*bedroom/);
  assert.equal(r.kept, 1);
  assert.equal(r.refused.length, 1);
  const l = cap.list();
  assert.equal(l.open.length, 1);
  assert.equal(l.open[0].anchorText[0].kind, 'miss');
});

test('a failed ask is recorded, and the open list is kept', async () => {
  const r = await cap.refresh({ ask: async () => { throw new Error('budget'); } });
  assert.equal(r.ok, false);
  assert.match(r.why, /budget/);
  assert.equal(cap.list().open.length, 1);
  assert.equal(cap.list().lastRun.ok, false);
});

test('routes: list, reject with a reason, undo, refuse junk — over real HTTP', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/setup', require('../routes/setup'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api/setup`;
  try {
    const list = await (await fetch(`${base}/capabilities`)).json();
    assert.equal(list.ok, true);
    const id = list.open[0].id;

    const bad = await fetch(`${base}/capabilities/${id}/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'maybe' }) });
    assert.equal(bad.status, 400);
    const missing = await fetch(`${base}/capabilities/cap:nope/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'reject' }) });
    assert.equal(missing.status, 404);

    const rej = await (await fetch(`${base}/capabilities/${id}/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'reject', reason: 'radiator sensor is enough' }) })).json();
    assert.equal(rej.item.status, 'rejected');
    assert.equal(rej.item.reason, 'radiator sensor is enough');
    assert.equal(cap.list().open.length, 0);

    await fetch(`${base}/capabilities/${id}/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'reopen' }) });
    assert.equal(cap.list().open.length, 1);
  } finally {
    server.close();
  }
});

test('accepting a non-build suggestion makes exactly one task, carrying why', () => {
  const id = cap.list().open[0].id;
  const r = cap.decide(id, { decision: 'accept' });
  assert.equal(r.filed.kind, 'task');
  const again = cap.decide(id, { decision: 'accept' });
  assert.equal(again.already, true);
  const rows = db.getDb().prepare("SELECT text, source FROM tasks WHERE source = 'capability-suggestion'").all();
  assert.equal(rows.length, 1);
  assert.match(rows[0].text, /so NEURO can/);
});

// ── ruled out, already have, and the three places it surfaces ──────────────

test('a ruled-out need is refused by the server, whatever the model says (the first live run named Strava)', () => {
  const j = cap.judge(good({ need: { kind: 'integration', what: 'Export hikes to Strava', how: 'connect it' } }), EV);
  assert.equal(j.ok, false);
  assert.match(j.why, /Strava is ruled out/);
  assert.equal(cap.judge(good({ title: 'Hike sweat correlation' }), EV).ok, false);
});

test('an open card a newer rule rules out is WITHDRAWN with the reason, never deleted', () => {
  const items = [{ id: 'cap:a', status: 'open', title: 'x', need: { what: 'a Strava export' } }, { id: 'cap:b', status: 'open', title: 'y', need: { what: 'a bedroom sensor' } }];
  const out = cap.withdrawRuledOut(items, '2026-10-15T08:00:00Z');
  assert.equal(out[0].status, 'withdrawn');
  assert.match(out[0].reason, /Strava/);
  assert.equal(out[1].status, 'open');
});

test('the prompt says what NEURO already has and what is ruled out', () => {
  const p = cap.buildPrompt({ evidence: [], decided: [], captured: [] });
  assert.match(p, /ALREADY HAS/);
  assert.match(p, /hike GPS tracks/);
  assert.match(p, /Strava is ruled out/);
});

test('the Monday brief offers ONE open suggestion, as personal (never the work email), and only on a Monday', () => {
  const gather = require('./briefing-gather');
  const gaps = [];
  const monday = gather.capabilities(new Date('2026-10-19T08:00:00'), gaps);
  const open = cap.openSummary();
  if (open.length) {
    assert.equal(monday.length, 1);
    assert.equal(monday[0].sphere, 'personal');
    assert.equal(monday[0].kind, 'capability');
  }
  assert.deepEqual(gather.capabilities(new Date('2026-10-20T08:00:00'), gaps), []);
  assert.deepEqual(gaps, []);
});

test('chat carries the open suggestions and is told to offer only those', () => {
  const block = require('./claude')._internals.capabilityBlock();
  if (cap.openSummary().length) {
    assert.match(block, /on file in NEURO Health/);
    assert.match(block, /never suggest a new capability that is not on this list/);
  } else {
    assert.equal(block, '');
  }
});
