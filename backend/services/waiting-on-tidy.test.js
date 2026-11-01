'use strict';

/**
 * The waiting-on and Spotted tidy (1 Nov 2026).
 *
 * Live that morning: 508 open waiting-on rows, growing, closed only by Nick; and
 * a Spotted queue 14% approved, the rest left to sit. Two passes, both NEURO
 * deciding rather than Nick:
 *
 *   1. waiting-on: an OPEN item over 90 days old that nothing has touched in 90
 *      days goes `lapsed` — not done, not dropped, Reopen-able, one count-only
 *      Activity line. Never done/dropped/snoozed, never an item whose age cannot
 *      be read.
 *   2. "Looks done": Build 5 `likely_fulfilled` is SHOWN on the row with Close /
 *      Not yet. Never applied. Not yet suppresses that evidence for that item;
 *      new evidence asks again.
 *   3. Spotted: a pending capture_todo older than 7 days goes `expired` — never
 *      written as a rejection, never counted as one, and a genuinely new
 *      sighting raises it again.
 *
 * Real scratch DB throughout (waiting-on.test.js / candidate-recording-scope.test.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-wo-tidy-'));
const vault = path.join(root, 'vault');
fs.mkdirSync(path.join(vault, 'Meetings', '2026', '09'), { recursive: true });
process.env.NEURO_DB_PATH = path.join(root, 'tidy.db');
process.env.OBSIDIAN_VAULT_PATH = vault;

const db = require('../db/database');
const waitingOn = require('./waiting-on');
const candidates = require('./action-candidates');

const DAY = 86400000;
const NOW = Date.parse('2026-11-01T03:00:00Z');
const ago = (days) => new Date(NOW - days * DAY).toISOString();

test.before(async () => { await db.init(); });
test.beforeEach(() => {
  db.run('DELETE FROM waiting_on', []);
  db.run("DELETE FROM agent_state WHERE key = 'waiting_on_not_yet'", []);
  try { db.run('DELETE FROM wm_progress_evidence', []); } catch { /* table may be absent */ }
});

/** An open item whose every date is `days` ago — what a 3-month-old, untouched row looks like. */
function seed(text, days, extra = {}) {
  const item = waitingOn.record({ person: 'Naomi', text, sourcePath: `Meetings/2026/09/${text}.md`, sourceDate: null });
  db.run(`UPDATE waiting_on SET first_seen = ?, last_seen = ?, last_mentioned_at = ? WHERE key = ?`,
    [ago(days), ago(days), ago(days), item.key]);
  for (const [col, val] of Object.entries(extra)) db.run(`UPDATE waiting_on SET ${col} = ? WHERE key = ?`, [val, item.key]);
  return item.key;
}
const row = (key) => db.get('SELECT * FROM waiting_on WHERE key = ?', [key]);
const item = (o) => ({ status: 'open', firstSeen: ago(120), lastSeen: ago(120), lastMentionedAt: ago(120), ...o });

// ── 1. lapseVerdict (pure) ──────────────────────────────────────────────────

test('an open item quiet for 91 days lapses; one quiet for 89 stays', () => {
  assert.ok(waitingOn.lapseVerdict(item({ firstSeen: ago(91), lastSeen: ago(91), lastMentionedAt: ago(91) }), NOW));
  assert.equal(waitingOn.lapseVerdict(item({ firstSeen: ago(89), lastSeen: ago(89), lastMentionedAt: ago(89) }), NOW), null,
    'an 89-day item stays open');
});

test('old but recently MENTIONED, CHASED, REOPENED or SNOOZED-TO stays open', () => {
  assert.equal(waitingOn.lapseVerdict(item({ lastMentionedAt: ago(30) }), NOW), null, 'a new-note mention 30 days ago');
  assert.equal(waitingOn.lapseVerdict(item({ askedAt: ago(10) }), NOW), null, 'chased 10 days ago');
  assert.equal(waitingOn.lapseVerdict(item({ reopenedAt: ago(5) }), NOW), null, 'reopened 5 days ago');
  assert.equal(waitingOn.lapseVerdict(item({ snoozedUntil: ago(20) }), NOW), null, 'they said "by" 20 days ago');
});

test('a legacy row (no last_mentioned_at) falls back to last_seen', () => {
  assert.equal(waitingOn.lapseVerdict(item({ lastMentionedAt: null, lastSeen: ago(40) }), NOW), null);
  assert.ok(waitingOn.lapseVerdict(item({ lastMentionedAt: null, lastSeen: ago(100) }), NOW));
});

test('never touches done, dropped, lapsed, snoozed-now, or an unreadable age', () => {
  for (const status of ['done', 'dropped', 'lapsed']) {
    assert.equal(waitingOn.lapseVerdict(item({ status }), NOW), null, `${status} is never lapsed`);
  }
  assert.equal(waitingOn.lapseVerdict(item({ snoozedUntil: new Date(NOW + 5 * DAY).toISOString() }), NOW), null, 'snoozed now');
  assert.equal(waitingOn.lapseVerdict(item({ firstSeen: 'not a date' }), NOW), null, 'unreadable age KEEPS it');
  assert.equal(waitingOn.lapseVerdict(item({ firstSeen: null }), NOW), null, 'missing age KEEPS it');
});

// ── 1b. lapseStale (real DB) ────────────────────────────────────────────────

test('the nightly pass lapses only the quiet ones and writes ONE count-only Activity line', () => {
  db.run("DELETE FROM personal_ops_events WHERE kind = 'waiting-on-lapsed'", []);
  const old1 = seed('send the SLA figures', 120);
  const old2 = seed('share the rota', 100);
  const young = seed('book the training', 89);
  const done = seed('confirm the budget', 200);
  waitingOn.resolve(done, 'done');
  const snoozed = seed('review the pack', 150, { snoozed_until: new Date(NOW + 3 * DAY).toISOString() });

  const r = waitingOn.lapseStale({ now: NOW });
  assert.equal(r.lapsed, 2);
  assert.equal(row(old1).status, 'lapsed');
  assert.equal(row(old2).status, 'lapsed');
  assert.equal(row(young).status, 'open', '89 days stays');
  assert.equal(row(done).status, 'done', 'a done item never lapses');
  assert.equal(row(snoozed).status, 'open', 'a snoozed item is never touched');

  const ev = db.all("SELECT * FROM personal_ops_events WHERE kind = 'waiting-on-lapsed'", []);
  assert.equal(ev.length, 1);
  const detail = JSON.parse(ev[0].detail_json);
  assert.equal(detail.count, 2);
  assert.ok(!/SLA|rota|Naomi/.test(ev[0].detail_json), 'count only: no item text or name in Activity');

  // Rendered as one Activity entry.
  const rendered = require('./activity-timeline').fromPersonalOps(ev);
  assert.match(rendered[0].headline, /2 waiting-on items/);

  // Idempotent: a second pass finds nothing.
  assert.equal(waitingOn.lapseStale({ now: NOW }).lapsed, 0);
});

test('lapsed leaves the open list, is listed under lapsed, and Reopen restarts the clock', () => {
  const k = seed('send the SLA figures', 120);
  waitingOn.lapseStale({ now: NOW });
  assert.equal(waitingOn.byPerson().length, 0, 'not on the open board');
  assert.equal(waitingOn.list({ status: 'lapsed' }).length, 1);

  assert.equal(waitingOn.reopen(k, { now: NOW }).ok, true);
  assert.equal(row(k).status, 'open');
  assert.equal(waitingOn.lapseStale({ now: NOW }).lapsed, 0, 'a reopen is activity — not lapsed again the same night');
  assert.equal(waitingOn.reopen(k).code, 409, 'only a lapsed item can be reopened here');
});

test('a NEW note naming a lapsed item reopens it; a re-read of the SAME note does not count as a mention', () => {
  const k = seed('send the SLA figures', 120);
  const before = row(k).last_mentioned_at;
  waitingOn.record({ person: 'Naomi', text: 'send the SLA figures', sourcePath: 'Meetings/2026/09/send the SLA figures.md' });
  assert.equal(row(k).last_mentioned_at, before, 'same note re-read: last_seen moves, the mention date does not');

  waitingOn.lapseStale({ now: NOW });
  assert.equal(row(k).status, 'lapsed');
  waitingOn.record({ person: 'Naomi', text: 'send the SLA figures', sourcePath: 'Meetings/2026/10/later.md', sourceDate: '2026-10-20' });
  assert.equal(row(k).status, 'open', 'a later meeting raising it again reopens it');
  assert.match(row(k).last_mentioned_at, /^2026-10-20/);
});

// ── 2. Looks done ───────────────────────────────────────────────────────────

function strongDone(commitmentId, evId) {
  db.run(`INSERT OR REPLACE INTO wm_progress_evidence (commitment_id, kind, ref, evidence_event_id, at, polarity, strength,
            provenance_kind, reason, detail_json, received_at)
          VALUES (?, 'later-note', ?, ?, '2026-10-20T12:00:00.000Z', 'done', 'strong', 'observation', 'a later note says done', ?, ?)`,
  [commitmentId, `Meetings/2026/10/x.md#L${evId}`, evId,
    JSON.stringify({ rule: 'later-note@2', notePath: 'Meetings/2026/10/x.md', text: '- SLA figures sent, done' }), new Date(NOW).toISOString()]);
}

/** The real world-model id, the real SQL gate; progressFor stubbed to the Build 5 verdict. */
function deps(state, evidence) {
  return {
    worldObligations: require('./world-obligations'),
    progressEvidence: {
      coverage: () => ({}),
      progressFor: () => ({ state, evidenceIds: evidence.map((e) => e.evidenceId), evidence }),
    },
  };
}
const ev = (id) => ({ evidenceId: id, kind: 'later-note', at: '2026-10-20T12:00:00.000Z', detail: { notePath: 'Meetings/2026/10/x.md', text: '- SLA figures sent, done' } });

test('likely_fulfilled is SHOWN as "Looks done — …" and nothing is closed', () => {
  const k = seed('send the SLA figures', 10);
  const cid = require('./world-obligations').waitingCommitmentId(k);
  strongDone(cid, 'ev-1');
  const [out] = waitingOn.attachLooksDone(waitingOn.list(), { deps: deps('likely_fulfilled', [ev('ev-1')]) });
  assert.ok(out.looksDone, 'shown');
  assert.match(out.looksDone.words, /later meeting note \(2026-10-20\) says “SLA figures sent, done”/);
  assert.deepEqual(out.looksDone.evidenceIds, ['ev-1']);
  assert.equal(row(k).status, 'open', 'never auto-closes');
});

test('anything short of likely_fulfilled shows nothing', () => {
  const k = seed('send the SLA figures', 10);
  strongDone(require('./world-obligations').waitingCommitmentId(k), 'ev-1');
  for (const state of ['contradicted', 'progress_observed', 'no_evidence', 'unknown']) {
    const [out] = waitingOn.attachLooksDone(waitingOn.list(), { deps: deps(state, [ev('ev-1')]) });
    assert.equal(out.looksDone, undefined, state);
  }
});

test('Not yet suppresses THAT evidence for THAT item; new evidence asks again', () => {
  const k = seed('send the SLA figures', 10);
  strongDone(require('./world-obligations').waitingCommitmentId(k), 'ev-1');
  assert.equal(waitingOn.notYet(k, ['ev-1']).ok, true);
  let [out] = waitingOn.attachLooksDone(waitingOn.list(), { deps: deps('likely_fulfilled', [ev('ev-1')]) });
  assert.equal(out.looksDone, undefined, 'answered "Not yet"');
  assert.equal(row(k).status, 'open');

  [out] = waitingOn.attachLooksDone(waitingOn.list(), { deps: deps('likely_fulfilled', [ev('ev-1'), ev('ev-2')]) });
  assert.ok(out.looksDone, 'a new piece of evidence brings it back');
  assert.deepEqual(out.looksDone.evidenceIds, ['ev-2']);

  assert.equal(waitingOn.notYet(k, []).code, 400, 'which evidence is wrong must be said');
});

test('HTTP: reopen and not-yet routes', async () => {
  const k = seed('send the SLA figures', 120);
  waitingOn.lapseStale({ now: NOW });
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/waiting-on', require('../routes/waiting-on'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api/waiting-on`;
  try {
    const lapsed = await (await fetch(`${base}?status=lapsed`)).json();
    assert.equal(lapsed.items.length, 1);
    const r1 = await fetch(`${base}/${encodeURIComponent(k)}/reopen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r1.status, 200);
    const r2 = await fetch(`${base}/${encodeURIComponent(k)}/reopen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r2.status, 409);
    const r3 = await fetch(`${base}/${encodeURIComponent(k)}/not-yet`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ evidenceIds: ['ev-9'] }) });
    assert.equal(r3.status, 200);
    assert.equal(row(k).status, 'open');
  } finally { server.close(); }
});

// ── 3. Spotted expiry ───────────────────────────────────────────────────────

const sqlTs = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const action = (o) => ({ type: 'capture_todo', status: 'pending', created_at: sqlTs(NOW - 8 * DAY), snoozed_until: null, ...o });

test('spottedExpiry: 8 days expires; 6 days, snoozed, undateable, decided or another type do not', () => {
  assert.ok(candidates.spottedExpiry(action(), NOW));
  assert.equal(candidates.spottedExpiry(action({ created_at: sqlTs(NOW - 6 * DAY) }), NOW), null);
  assert.equal(candidates.spottedExpiry(action({ snoozed_until: new Date(NOW + DAY).toISOString() }), NOW), null, 'asleep');
  assert.equal(candidates.spottedExpiry(action({ snoozed_until: new Date(NOW - 2 * DAY).toISOString() }), NOW), null,
    'woke 2 days ago: 7 days from waking');
  assert.equal(candidates.spottedExpiry(action({ created_at: 'nonsense' }), NOW), null);
  assert.equal(candidates.spottedExpiry(action({ status: 'executed' }), NOW), null);
  assert.equal(candidates.spottedExpiry(action({ type: 'draft_reply' }), NOW), null);
});

const DIR = 'Meetings/2026/09';
const COMMITMENT = 'Nick Ward to run a morning catch-up with contacts and update Filippo';
function writeNote(rel, plaudId) {
  fs.writeFileSync(path.join(vault, rel), ['---', 'type: note', `plaud_id: "${plaudId}"`, 'date: 2026-09-17', '---', '',
    '## Next Arrangements', `- ${COMMITMENT}`].join('\n'), 'utf-8');
}
const pending = () => db.getPendingSaimActionsByType('capture_todo', 500);
const reviewKeys = () => db.all(`SELECT key, value FROM agent_state WHERE key LIKE 'note_action_review%' ORDER BY key`, []);

test('expireStaleSpotted: expired, not rejected — no decision memory, no stat, and a new sighting raises it again', () => {
  writeNote(`${DIR}/Weekly A.md`, 'a1b2c3d4e5f60718293a4b5c6d7e8f90');
  assert.equal(candidates.syncNoteActionCandidates(`${DIR}/Weekly A.md`).created, 1);
  const [a] = pending();
  db.run('UPDATE saim_actions SET created_at = ? WHERE id = ?', [sqlTs(Date.now() - 8 * DAY), a.id]);
  const memoryBefore = JSON.stringify(reviewKeys());
  const tallyBefore = db.countSaimActionsSince('2000-01-01');

  const r = candidates.expireStaleSpotted(new Date());
  assert.equal(r.expired, 1);
  assert.equal(db.getSaimAction(a.id).status, 'expired');
  assert.equal(JSON.stringify(reviewKeys()), memoryBefore, 'nothing written to the review / recording / signature memory');
  const tallyAfter = db.countSaimActionsSince('2000-01-01');
  assert.equal(tallyAfter.rejected || 0, tallyBefore.rejected || 0, 'not counted as a rejection');
  assert.equal(tallyAfter.executed || 0, tallyBefore.executed || 0);

  // The same note re-read does not re-raise it (it is decided for that note)…
  assert.equal(candidates.syncNoteActionCandidates(`${DIR}/Weekly A.md`).created || 0, 0);
  // …but a genuinely new sighting — another recording — does.
  writeNote(`${DIR}/Later B.md`, '00112233445566778899aabbccddeeff');
  assert.equal(candidates.syncNoteActionCandidates(`${DIR}/Later B.md`).created, 1, 'an expired commitment may be raised again');
});

test('a 6-day pending suggestion and an executed one are untouched', () => {
  db.run("DELETE FROM saim_actions WHERE type = 'capture_todo'", []);
  writeNote(`${DIR}/Fresh C.md`, 'ffeeddccbbaa99887766554433221100');
  candidates.syncNoteActionCandidates(`${DIR}/Fresh C.md`);
  const [p] = pending();
  db.run('UPDATE saim_actions SET created_at = ? WHERE id = ?', [sqlTs(Date.now() - 6 * DAY), p.id]);
  assert.equal(candidates.expireStaleSpotted(new Date()).expired, 0);
  assert.equal(db.getSaimAction(p.id).status, 'pending');
  db.run('UPDATE saim_actions SET created_at = ?, status = ? WHERE id = ?', [sqlTs(Date.now() - 30 * DAY), 'executed', p.id]);
  assert.equal(candidates.expireStaleSpotted(new Date()).expired, 0);
  assert.equal(db.getSaimAction(p.id).status, 'executed');
});
