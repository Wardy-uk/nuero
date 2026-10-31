'use strict';

/**
 * Executing a confirmed, STORED prepared move. Real intent grants, real
 * external-write ledger, real prepared_moves store, real scratch database.
 * Targets are the sandbox, or the LIVE adapters driven against fakes only: a
 * fake Graph at the fetch layer (with a stubbed token) and a temp folder as
 * OBSIDIAN_VAULT_PATH, so routes/vault.js's real path guard is what runs.
 * Fixtures are dated off the wall clock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-exec-'));
const VAULT = path.join(tmp, 'vault'); // a disposable stand-in for the vault
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_TIMEZONE = 'Europe/London';
for (const k of ['HA_TOKEN', 'HA_URL', 'SAIM_PREPARED_MOVE_EXECUTION']) delete process.env[k];
fs.mkdirSync(path.join(VAULT, 'Projects', 'Support Improvement Plan'), { recursive: true });

const db = require('../db/database');
const exec = require('./prepared-move-exec');
const store = require('./prepared-move-store');
const ig = require('./intent-grants');
const { createSandbox } = require('./prepared-move-sandbox');

const DAY = 86400000;
const NOW = Date.now();
const ymd = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
const SLOT_DAY = ymd(NOW + 2 * DAY);
const FORUM_DAY = ymd(NOW + 3 * DAY);
const NOTE = 'Projects/Support Improvement Plan/SIP - T1 Acceptance Criteria (draft).md';
const DRAFT = '# T1 — Triage and escalation acceptance criteria (DRAFT prepared by SAiM)\n\n## Every escalation must carry\n- Current customer ask\n\n## What each team accepts\n| Team | Accepts when | Rejects with |\n|---|---|---|\n| Team Alpha | _to agree_ | _to agree_ |\n';
const MOVE = `saim-move:planner:PLANNER-ID-1@${FORUM_DAY}`;
const SESSION = 'session_test_0001';

function packet(edit = () => {}) {
  const p = {
    contract: 'prepared-move-v1',
    decision: { decidedAt: new Date(NOW - 10 * 60000).toISOString() },
    selected: {
      title: 'Written criteria for what each team accepts',
      record: { system: 'planner', msId: 'PLANNER-ID-1', plan: 'Support Improvement Plan' },
      screens: { employment: { sensitive: false, categories: [] }, freshnessOk: true, recordUnique: true },
      preparation: [{ did: 'drafted', sideEffect: 'none', draft: DRAFT }],
      decision: {
        slots: [{ id: 'approve', date: SLOT_DAY, start: '10:25', end: '10:55' }, { id: 'slot-1', date: SLOT_DAY, start: '15:30', end: '16:00' }],
        proposedWrites: [
          { kind: 'calendar.solo', title: 'Triage and escalation criteria draft', slot: 'chosen', attendees: [], body: 'Prepared by SAiM' },
          { kind: 'vault.note', path: NOTE },
        ],
        forum: { title: 'Support Improvement Plan', start: `${FORUM_DAY}T16:00` },
      },
      verification: { checks: [{ what: 'The block exists', how: 'read back' }, { what: 'The draft grew', how: 'own text' }] },
    },
  };
  edit(p);
  return p;
}

// Every fresh check passing; a test overrides one at a time.
const okChecks = (over = {}) => ({
  diary: async () => ({ known: true, clashes: [] }),
  availability: async () => ({ known: true, off: false, working: true }),
  candidate: async () => ({ ok: true }),
  noteState: async () => ({ known: true, exists: false }),
  ...over,
});
// The sandbox's own note state, so retries and idempotency see the real file.
const sandboxChecks = (sb, over = {}) => okChecks({ noteState: exec.defaultChecks({ adapters: sb }).noteState, ...over });

let n = 0;
const sandbox = () => createSandbox(path.join(tmp, `sandbox-${++n}`), { realVault: VAULT });
const ledger = () => db.all(`SELECT idempotency_key k, status, attempts FROM external_write_ledger WHERE idempotency_key LIKE ? ORDER BY id`, [`${MOVE}%`]);
let counter = 0;
// Every execution test runs with BOTH gates open: the device lock (env) and an
// allowance for today. authority-budget.test.js closes each one in turn.
const budget = require('./authority-budget');
const reset = () => {
  db.run(`DELETE FROM external_write_ledger WHERE idempotency_key LIKE 'saim-move:%'`);
  process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
  budget._test.reset(); budget._test.grantToday({ now: NOW });
};
/** A fresh stored record for this test (a unique draft line makes it a new version). */
function stored(edit = () => {}) {
  const p = packet((x) => { x.selected.preparation[0].draft = `${DRAFT}\n<!-- v${++counter} -->\n`; edit(x); });
  const r = store.store(p, { now: NOW });
  assert.equal(r.ok, true, r.why);
  return r.record;
}
async function confirmAndRun({ record, adapters, checks, option = 'approve' }) {
  const c = exec.requestConfirmation({ recordId: record.id, option, sessionId: SESSION });
  assert.equal(c.ok, true, JSON.stringify(c));
  return exec.execute({ recordId: record.id, option, grantId: c.grantId, adapters, checks: checks || sandboxChecks(adapters) });
}

test.before(async () => { await db.init(); exec._setDeps({ readDuty: async () => ({ onDuty: true }) }); });
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

// ── The record ───────────────────────────────────────────────────────────────

test('record: stored, versioned, immutable — identical packet is not a new version; a changed one is', () => {
  const p = packet();
  const a = store.store(p, { now: NOW });
  const again = store.store(p, { now: NOW });
  assert.equal(again.created, false); assert.equal(again.record.id, a.record.id);
  const b = store.store(packet((x) => { x.selected.preparation[0].draft += '\nchanged'; }), { now: NOW });
  assert.equal(b.record.version, a.record.version + 1);
  assert.equal(store.isLatest(a.record), false); assert.equal(store.isLatest(b.record), true);
  assert.deepEqual(Object.keys(b.record.options), ['approve', 'slot-1']);
  assert.ok(b.record.options.approve.writeHash.length === 64);
  assert.equal(b.record.evidenceExpiresAt, new Date(Date.parse(p.decision.decidedAt) + 2 * 3600000).toISOString());
  assert.ok(b.record.packet.selected.verification && b.record.packet.selected.decision.proposedWrites, 'evidence, writes and verification plan are kept');
  assert.throws(() => db.run(`UPDATE prepared_moves SET packet_json = '{}' WHERE id = ?`, [b.record.id]), /immutable/);
  assert.throws(() => db.run(`DELETE FROM prepared_moves WHERE id = ?`, [b.record.id]), /never deleted/);
});

test('record: a packet with no move, or an out-of-scope move, is never stored', () => {
  assert.equal(store.store({ contract: 'prepared-move-v1', decision: { decidedAt: new Date(NOW).toISOString() }, selected: null }).ok, false);
  assert.equal(store.store(packet((x) => { x.selected.decision.proposedWrites[0].attendees = ['mel@example.test']; })).ok, false);
});

// ── mintForPreparedMove: not a generic door ──────────────────────────────────

test('mint: only for a stored, latest record, an offered option and its exact stored write hash', () => {
  const rec = stored();
  const good = rec.options.approve.writeHash;
  const base = { recordId: rec.id, version: rec.version, option: 'approve', writeHash: good, surface: 'neuro-web', sessionId: SESSION };
  assert.equal(ig.mintForPreparedMove(base).ok, true);
  assert.equal(ig.mintForPreparedMove({ ...base, caller: { machine: 'mcp-local' } }).reason, 'machine');
  assert.equal(ig.mintForPreparedMove({ ...base, recordId: 'pa_0123456789abcdef' }).reason, 'missing', 'an A4 action id mints nothing');
  assert.equal(ig.mintForPreparedMove({ ...base, recordId: 'anything-at-all' }).reason, 'missing');
  assert.equal(ig.mintForPreparedMove({ ...base, option: 'not-this-week' }).reason, 'option');
  assert.equal(ig.mintForPreparedMove({ ...base, writeHash: 'f'.repeat(64) }).reason, 'scope', 'a hash for some other set of writes is refused');
  assert.equal(ig.mintForPreparedMove({ ...base, writeHash: rec.options['slot-1'].writeHash }).reason, 'scope', 'another option\'s writes are not this option\'s');
  assert.equal(ig.mintForPreparedMove({ ...base, sessionId: 'x' }).reason, 'session');
  const newer = stored();
  void newer;
  assert.equal(ig.mintForPreparedMove(base).reason, 'changed', 'an older version cannot be confirmed');
  assert.equal(ig.mintDirect, undefined, 'the generic minting door is gone');
  const row = db.get(`SELECT action_capability FROM human_action_intents ORDER BY created_at DESC LIMIT 1`);
  assert.equal(row.action_capability, 'saim.prepared-move');
});

test('a grant for anything else is refused unspent; a prepared-move grant spends once', async () => {
  reset(); const rec = stored(); const sb = sandbox();
  // An A4-style grant row naming this record id cannot run it — and is not burned.
  db.run(`INSERT INTO human_action_intents (id, user_id, action_capability, action_id, action_version, payload_hash, session_id, surface, initiated_by, created_at, expires_at)
          VALUES ('ig_other', 'nick', 'chase_commitment', ?, ?, ?, ?, 'neuro-web', 'human_direct', ?, ?)`,
  [rec.id, rec.version, rec.options.approve.writeHash, SESSION, new Date(NOW).toISOString(), new Date(NOW + 60000).toISOString()]);
  const r = await exec.execute({ recordId: rec.id, grantId: 'ig_other', adapters: sb, checks: sandboxChecks(sb) });
  assert.equal(r.ok, false); assert.match(r.reasons[0], /not for a prepared move/);
  assert.equal(ig.get('ig_other').consumed_at, null, 'someone else\'s grant is left unspent');
  const c = exec.requestConfirmation({ recordId: rec.id, sessionId: SESSION });
  assert.equal((await exec.execute({ recordId: rec.id, grantId: c.grantId, adapters: sb, checks: sandboxChecks(sb) })).ok, true);
  const replay = await exec.execute({ recordId: rec.id, grantId: c.grantId, adapters: sb, checks: sandboxChecks(sb) });
  assert.equal(replay.ok, false); assert.match(replay.reasons[0], /already been used/);
});

// ── The switch ───────────────────────────────────────────────────────────────

test('default off: execution is refused inside the executor and no adapter is touched', async () => {
  reset(); delete process.env.SAIM_PREPARED_MOVE_EXECUTION;
  const rec = stored();
  const c = exec.requestConfirmation({ recordId: rec.id, sessionId: SESSION });
  let touched = 0;
  const trap = new Proxy({}, { get: () => { touched += 1; throw new Error('adapter touched'); } });
  const r = await exec.execute({ recordId: rec.id, grantId: c.grantId, adapters: { kind: 'live', calendar: trap, vault: trap }, checks: okChecks() });
  assert.equal(r.ok, false); assert.match(r.reasons[0], /^Carrying out moves is switched off on NEURO’s server — nothing was written and your confirmation was not used\.$/);
  assert.equal(touched, 0);
  assert.equal(ig.get(c.grantId).consumed_at, null, 'refused before the confirmation was even spent');
  assert.equal(require('./feature-flags').isEnabled('saim_prepared_move_execution'), false);
  const unknown = await exec.execute({ recordId: rec.id, grantId: c.grantId, adapters: { kind: 'graph', calendar: trap, vault: trap } });
  assert.match(unknown.reasons[0], /unknown execution target/);
});

test('nothing executes without an explicit confirmation', async () => {
  reset(); const rec = stored(); const sb = sandbox();
  const r1 = await exec.execute({ recordId: rec.id, adapters: sb, checks: sandboxChecks(sb) });
  assert.match(r1.reasons[0], /confirmation/);
  const r2 = await exec.execute({ recordId: rec.id, grantId: 'ig_made_up', adapters: sb, checks: sandboxChecks(sb) });
  assert.equal(r2.ok, false);
  assert.deepEqual(await sb.calendar._all(), []); assert.equal(await sb.vault.exists(NOTE), false); assert.deepEqual(ledger(), []);
});

// ── Changed packet, scope ────────────────────────────────────────────────────

test('a changed packet invalidates the confirmation for the old version', async () => {
  reset(); const v1 = stored(); const sb = sandbox();
  const c = exec.requestConfirmation({ recordId: v1.id, sessionId: SESSION });
  stored(); // the move is prepared again with different content
  const r = await exec.execute({ recordId: v1.id, grantId: c.grantId, adapters: sb, checks: sandboxChecks(sb) });
  assert.equal(r.ok, false); assert.equal(r.rePrepare, true); assert.match(r.reasons[0], /changed since you confirmed/);
  assert.deepEqual(await sb.calendar._all(), []);
});

test('a confirmation for one time cannot run another', async () => {
  reset(); const rec = stored(); const sb = sandbox();
  const c = exec.requestConfirmation({ recordId: rec.id, option: 'approve', sessionId: SESSION });
  const r = await exec.execute({ recordId: rec.id, option: 'slot-1', grantId: c.grantId, adapters: sb, checks: sandboxChecks(sb) });
  assert.equal(r.ok, false);
  assert.deepEqual(await sb.calendar._all(), []);
});

test('scope: only one solo block and one note in an existing project folder', () => {
  const cases = [
    [(x) => { x.selected.decision.proposedWrites[0].attendees = ['mel@example.test']; }, /attendees/],
    [(x) => { x.selected.decision.proposedWrites.push({ kind: 'email.send' }); }, /exactly one solo block and one note/],
    [(x) => { x.selected.decision.proposedWrites[1].path = 'Projects/Support Improvement Plan/../../People/Mel.md'; }, /note path/],
    [(x) => { x.selected.decision.proposedWrites[1].path = 'People/Melanie Ellis.md'; }, /note path/],
    [(x) => { x.selected.screens.recordUnique = false; }, /exactly one record/],
  ];
  for (const [edit, re] of cases) {
    const w = exec.writesFor(packet(edit), 'approve');
    assert.equal(w.ok, false); assert.match(w.reasons.join(' '), re);
  }
  assert.match(exec.writesFor(packet(), 'not-this-week').reasons[0], /not one of the times/);
});

// ── Fresh checks ─────────────────────────────────────────────────────────────

test('fresh checks: each failing condition refuses and hands the packet back', async () => {
  const cases = [
    ['stale', (x) => { x.decision.decidedAt = new Date(NOW - 3 * 3600000).toISOString(); }, {}, /evidence behind this move expired/],
    ['slot collision', () => {}, { diary: async () => ({ known: true, clashes: ['1-2-1 — Nick / Abdi'] }) }, /no longer free/],
    ['diary unknown', () => {}, { diary: async () => ({ known: false, why: 'the calendar has not synced in the last 15 minutes' }) }, /couldn’t confirm .* still free \(the calendar has not synced/],
    ['leave change', () => {}, { availability: async () => ({ known: true, off: true, working: true }) }, /now booked off/],
    ['leave unknown', () => {}, { availability: async () => ({ known: false, why: 'roster empty' }) }, /couldn’t check your leave/],
    ['bank holiday', () => {}, { availability: async () => ({ known: true, off: false, working: false }) }, /not a working day/],
    ['candidate ambiguous', () => {}, { candidate: async () => ({ ok: false, why: 'the commitment is now ambiguous — more than one record carries its words' }) }, /now ambiguous/],
    ['candidate sensitive', () => {}, { candidate: async () => ({ ok: false, why: 'it now reads as an employment matter' }) }, /employment matter/],
    ['existing note', () => {}, { noteState: async () => ({ known: true, exists: true, ours: false }) }, /already exists at that path/],
  ];
  for (const [name, edit, over, re] of cases) {
    reset();
    const rec = stored(edit); const sb = sandbox();
    // Confirm while still valid, then let the condition change before running.
    let grantId;
    if (name === 'stale') {
      grantId = ig.mintForPreparedMove({ recordId: rec.id, version: rec.version, option: 'approve', writeHash: rec.options.approve.writeHash, surface: 'neuro-web', sessionId: SESSION }).grantId;
    } else grantId = exec.requestConfirmation({ recordId: rec.id, sessionId: SESSION }).grantId;
    const r = await exec.execute({ recordId: rec.id, grantId, adapters: sb, checks: okChecks(over) });
    assert.equal(r.ok, false, name); assert.equal(r.rePrepare, true, name); assert.match(r.reasons[0], re, name);
    assert.ok(r.packet && r.packet.selected, `${name}: the packet comes back`);
    assert.deepEqual(await sb.calendar._all(), [], `${name}: nothing written`);
    assert.equal(await sb.vault.exists(NOTE), false, name);
  }
});

test('a sandbox run with no fresh checks supplied refuses rather than writing blind', async () => {
  reset(); const rec = stored(); const sb = sandbox();
  const c = exec.requestConfirmation({ recordId: rec.id, sessionId: SESSION });
  const r = await exec.execute({ recordId: rec.id, grantId: c.grantId, adapters: sb });
  assert.match(r.reasons[0], /no fresh checks/);
});

// ── Execution semantics (sandbox) ────────────────────────────────────────────

test('confirmed: both created, read back, receipted against the stored version', async () => {
  reset(); const rec = stored(); const sb = sandbox();
  const before = fs.readdirSync(path.join(VAULT, 'Projects', 'Support Improvement Plan'));
  const { receipt } = await confirmAndRun({ record: rec, adapters: sb });
  assert.equal(receipt.complete, true);
  assert.equal(receipt.recordId, rec.id); assert.equal(receipt.version, rec.version);
  assert.deepEqual(receipt.steps.map((s) => s.status), ['done', 'done']);
  assert.deepEqual(receipt.contacted, []);
  assert.equal((await sb.calendar._all()).length, 1);
  assert.deepEqual(fs.readdirSync(path.join(VAULT, 'Projects', 'Support Improvement Plan')), before, 'the stand-in vault was not written by a sandbox run');
  // Receipt truth: a practice run is labelled, never verified, and claims no vault location.
  assert.equal(receipt.practice, true);
  assert.equal(receipt.verified, false);
  assert.equal(receipt.notePath, null);
  assert.equal(receipt.steps[1].path, null, 'a sandbox note is not in the vault');
  assert.match(receipt.plain, /^Practice run — nothing real was changed\./);
  assert.doesNotMatch(receipt.plain, /in your calendar|in your notes/i);
  assert.match(receipt.steps[0].when.say, /^\w+day \d+ \w+, \d\d:\d\d–\d\d:\d\d$/, 'even a practice block states its exact time');
  const row = require('./prepared-move-history').today().items.find((i) => i.moveKey === MOVE);
  assert.equal(row.stage, 'practice');
  assert.equal(row.note, null);
  assert.equal(row.when.practice, true);
});

test('idempotent across confirmations', async () => {
  reset(); const rec = stored(); const sb = sandbox();
  await confirmAndRun({ record: rec, adapters: sb });
  const again = await confirmAndRun({ record: rec, adapters: sb });
  assert.deepEqual(again.receipt.steps.map((s) => s.status), ['already-done', 'already-done']);
  assert.equal((await sb.calendar._all()).length, 1);
});

test('partial: block lands, note fails — the block stays; a retry does only the note', async () => {
  reset(); const rec = stored(); const sb = sandbox();
  sb.faults.vault = 'fail-next';
  const first = await confirmAndRun({ record: rec, adapters: sb });
  assert.deepEqual(first.receipt.steps.map((s) => s.status), ['done', 'failed']);
  assert.match(first.receipt.plain, /^Practice run — nothing real was changed\. The note was not saved: .* The sandbox block that worked stays in the sandbox\./);
  const retry = await confirmAndRun({ record: rec, adapters: sb });
  assert.deepEqual(retry.receipt.steps.map((s) => s.status), ['already-done', 'done']);
  assert.equal((await sb.calendar._all()).length, 1);
  assert.deepEqual(ledger().map((r) => [r.status, r.attempts]), [['confirmed', 1], ['confirmed', 2]]);
});

test('a timeout after the block landed is found on retry, not repeated', async () => {
  reset(); const rec = stored(); const sb = sandbox();
  sb.faults.calendar = 'apply-then-throw';
  const first = await confirmAndRun({ record: rec, adapters: sb });
  assert.equal(first.receipt.steps[0].status, 'failed'); assert.equal(first.receipt.steps[0].provablyNotApplied, false);
  const retry = await confirmAndRun({ record: rec, adapters: sb });
  assert.equal(retry.receipt.steps[0].status, 'already-done');
  assert.equal((await sb.calendar._all()).length, 1);
});

test('an unverified block is re-checked on retry — never created twice — while the note is done once', async () => {
  reset(); const rec = stored(); const sb = sandbox();
  sb.faults.calendar = 'mangle-next';
  const first = await confirmAndRun({ record: rec, adapters: sb });
  assert.deepEqual(first.receipt.steps.map((s) => s.status), ['unverified', 'done']);
  assert.equal(first.receipt.complete, false);
  const retry = await confirmAndRun({ record: rec, adapters: sb });
  assert.deepEqual(retry.receipt.steps.map((s) => s.status), ['unverified', 'already-done'], 'still does not match — it is reported again, not papered over');
  assert.equal((await sb.calendar._all()).length, 1, 'no second block');
});

test('an unverified note is never overwritten: the retry refuses before writing and hands the packet back', async () => {
  reset(); const rec = stored(); const sb = sandbox();
  sb.faults.vault = 'mangle-next';
  const first = await confirmAndRun({ record: rec, adapters: sb });
  assert.deepEqual(first.receipt.steps.map((s) => s.status), ['done', 'unverified']);
  const onDisk = await sb.vault.read(NOTE);
  const c = exec.requestConfirmation({ recordId: rec.id, sessionId: SESSION });
  const retry = await exec.execute({ recordId: rec.id, grantId: c.grantId, adapters: sb, checks: sandboxChecks(sb) });
  assert.equal(retry.ok, false); assert.equal(retry.rePrepare, true); assert.match(retry.reasons[0], /won’t overwrite/);
  assert.equal(await sb.vault.read(NOTE), onDisk);
  assert.equal((await sb.calendar._all()).length, 1);
});

// ── Live adapters, against fakes only ────────────────────────────────────────

function fakeGraph() {
  const events = new Map(); const calls = [];
  const MARKER = require('./calendar-read').MARKER_PROP;
  const shape = (e) => ({ ...e, singleValueExtendedProperties: e.singleValueExtendedProperties });
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url); const method = opts.method || 'GET';
    calls.push(`${method} ${u.pathname}`);
    const json = (status, body) => ({ status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
    if (u.hostname !== 'graph.microsoft.com') throw new Error('unexpected host');
    if (method === 'POST' && u.pathname === '/v1.0/me/events') {
      const b = JSON.parse(opts.body);
      if (fakeGraph.next === 'timeout-after') { fakeGraph.next = null; const id = `evt${events.size + 1}`; events.set(id, { id, ...b }); const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; }
      const id = `evt${events.size + 1}`; events.set(id, { id, ...b });
      return json(201, shape(events.get(id)));
    }
    if (method === 'GET' && u.pathname === '/v1.0/me/events') {
      const want = /ep\/value eq '([^']+)'/.exec(decodeURIComponent(u.search))[1];
      return json(200, { value: [...events.values()].filter((e) => (e.singleValueExtendedProperties || []).some((p) => p.id === MARKER && p.value === want)) });
    }
    const one = /^\/v1\.0\/me\/events\/([^/]+)$/.exec(u.pathname);
    if (method === 'GET' && one) return events.has(decodeURIComponent(one[1])) ? json(200, shape(events.get(decodeURIComponent(one[1])))) : json(404, {});
    return json(500, {});
  };
  return { events, calls };
}

test('live adapters (fake Graph + temp vault): solo event with marker, read back by id; the note never overwrites and says sync is unchecked', async () => {
  reset();
  const ms = require('./microsoft'); const realToken = ms.getAccessToken; ms.getAccessToken = async () => 'fake-token';
  const g = fakeGraph();
  process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
  try {
    const rec = stored(); const live = exec.liveAdapters();
    const { receipt } = await confirmAndRun({ record: rec, adapters: live, checks: okChecks({ noteState: exec.defaultChecks({ adapters: live }).noteState }) });
    assert.equal(receipt.complete, true, JSON.stringify(receipt.steps));
    const [ev] = g.events.values();
    assert.deepEqual(ev.attendees, [], 'no attendees in the Graph body');
    assert.equal(ev.singleValueExtendedProperties[0].value, MOVE, 'NEURO marker on the event');
    assert.ok(ev.transactionId, 'Graph transactionId set');
    assert.equal(receipt.steps[0].id, 'evt1');
    assert.match(receipt.steps[1].unconfirmed, /Obsidian Sync, which I haven’t checked/);
    assert.ok(fs.existsSync(path.join(VAULT, NOTE)));
    // Receipt truth (22 Oct 2026): stamped by the executor from the live run itself.
    assert.equal(receipt.practice, false);
    assert.equal(receipt.verified, true, 'live, complete, every read-back held');
    assert.match(receipt.steps[0].when.say, /^\w+day \d+ \w+, \d\d:\d\d–\d\d:\d\d$/, 'the exact date and time of the block');
    assert.deepEqual(receipt.when, receipt.steps[0].when);
    assert.equal(receipt.notePath, NOTE, 'the vault location, because the note is live and read back');
    assert.equal(receipt.steps[1].findIt, 'Projects → Support Improvement Plan → SIP - T1 Acceptance Criteria (draft)');
    const hist = require('./prepared-move-history').today();
    const row = hist.items.find((i) => i.moveKey === MOVE);
    assert.equal(row.stage, 'verified');
    assert.equal(row.note.path, NOTE);
    assert.equal(row.when.say, receipt.when.say);
    assert.equal(row.when.practice, false);
    // Confirm again: found by marker, nothing posted twice; the note is ours and untouched.
    const posts = () => g.calls.filter((c) => c.startsWith('POST')).length;
    const again = await confirmAndRun({ record: rec, adapters: live, checks: okChecks({ noteState: exec.defaultChecks({ adapters: live }).noteState }) });
    assert.deepEqual(again.receipt.steps.map((s) => s.status), ['already-done', 'already-done']);
    assert.equal(posts(), 1);
  } finally { delete process.env.SAIM_PREPARED_MOVE_EXECUTION; ms.getAccessToken = realToken; fs.rmSync(path.join(VAULT, NOTE), { force: true }); }
});

test('live calendar: a timeout after Graph created the event is found by marker on retry', async () => {
  reset();
  const ms = require('./microsoft'); const realToken = ms.getAccessToken; ms.getAccessToken = async () => 'fake-token';
  const g = fakeGraph(); fakeGraph.next = 'timeout-after';
  process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
  try {
    const rec = stored(); const live = exec.liveAdapters();
    const checks = okChecks({ noteState: exec.defaultChecks({ adapters: live }).noteState });
    const first = await confirmAndRun({ record: rec, adapters: live, checks });
    assert.equal(first.receipt.steps[0].status, 'failed'); assert.equal(first.receipt.steps[0].provablyNotApplied, false);
    const retry = await confirmAndRun({ record: rec, adapters: live, checks });
    assert.equal(retry.receipt.steps[0].status, 'already-done');
    assert.equal(g.events.size, 1, 'one event, however many attempts');
  } finally { delete process.env.SAIM_PREPARED_MOVE_EXECUTION; ms.getAccessToken = realToken; fs.rmSync(path.join(VAULT, NOTE), { force: true }); }
});

test('live calendar: if NEURO cannot look for an existing block, it does not create one', async () => {
  const ms = require('./microsoft'); const realToken = ms.getAccessToken; ms.getAccessToken = async () => null; // no token
  let posted = 0; global.fetch = async () => { posted += 1; throw new Error('should not be called'); };
  try {
    const live = exec.liveAdapters();
    await assert.rejects(live.calendar.findByMarker('m'), /could not check the calendar/);
    assert.equal(posted, 0);
  } finally { ms.getAccessToken = realToken; }
});

test('live vault: the real path guard refuses an escape; no overwrite; no new folders', async () => {
  const live = exec.liveAdapters();
  await assert.rejects(live.vault.exists('../outside.md'), /outside the vault/);
  fs.writeFileSync(path.join(VAULT, 'Projects', 'Support Improvement Plan', 'mine.md'), 'Nick wrote this');
  await assert.rejects(live.vault.writeNew('Projects/Support Improvement Plan/mine.md', 'x'), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(VAULT, 'Projects', 'Support Improvement Plan', 'mine.md'), 'utf8'), 'Nick wrote this');
  await assert.rejects(live.vault.writeNew('Projects/New Folder/x.md', 'x'), /project folder does not exist/);
  assert.equal(fs.existsSync(path.join(VAULT, 'Projects', 'New Folder')), false);
});

test('live diary check: a clash, a held free meeting, and a stale calendar', async () => {
  const fresh = new Date(NOW - 5 * 60000).toISOString().replace('T', ' ').slice(0, 19);
  db.run(`DELETE FROM calendar_cache`);
  const add = (subject, s, e, showAs, others, organiser, fetched = fresh) => db.run(`INSERT INTO calendar_cache (event_id, subject, start_time, end_time, is_all_day, show_as, fetched_at, attendees_other, source, is_organizer) VALUES (?,?,?,?,0,?,?,?, 'graph', ?)`, [subject, subject, `${SLOT_DAY}T${s}:00`, `${SLOT_DAY}T${e}:00`, showAs, fetched, others, organiser]);
  const diary = exec.defaultChecks({ adapters: null, now: NOW }).diary;
  const slot = { date: SLOT_DAY, start: '10:25', end: '10:55' };
  add('Take a break', '10:30', '10:35', 'free', 0, 1);
  assert.deepEqual((await diary(slot, { title: 'T' })).clashes, [], 'a solo free block is not a wall');
  add('Team Standup', '10:00', '10:30', 'free', 1, 1);
  assert.deepEqual((await diary(slot, { title: 'T' })).clashes, ['Team Standup'], 'his own free-marked standup is');
  add('T', '10:25', '10:55', 'busy', 0, 1);
  assert.ok(!(await diary(slot, { title: 'T' })).clashes.includes('T'), 'our own block on a retry is not a clash');
  db.run(`UPDATE calendar_cache SET fetched_at = ?`, [new Date(NOW - 40 * 60000).toISOString().replace('T', ' ').slice(0, 19)]);
  assert.equal((await diary(slot, { title: 'T' })).known, false, 'a stale calendar cannot vouch for a free slot');
});

// ── Scope pins added with the routes (19 Oct 2026) ───────────────────────────

test('scope: the note must be in the ONE pinned project folder, and the title one plain line', () => {
  assert.deepEqual(exec.PROJECT_FOLDERS, ['Projects/Support Improvement Plan']);
  const cases = [
    [(x) => { x.selected.decision.proposedWrites[1].path = 'Projects/Widget Plan/WP - T1 Acceptance Criteria (draft).md'; }, /not in a project folder a prepared move may save into/],
    [(x) => { x.selected.decision.proposedWrites[1].path = 'Projects/Support Improvement Plan/Sub/x.md'; }, /note path/],
    [(x) => { x.selected.decision.proposedWrites[0].title = 'Triage draft\nDESCRIPTION: anything'; }, /single plain line/],
    [(x) => { x.selected.decision.proposedWrites[0].title = '<b>Triage</b> draft'; }, /single plain line/],
  ];
  for (const [edit, re] of cases) {
    const w = exec.writesFor(packet(edit), 'approve');
    assert.equal(w.ok, false); assert.match(w.reasons.join(' '), re);
    assert.equal(store.store(packet(edit), { now: NOW }).ok, false, 'never stored, so no confirmation can be minted for it');
  }
});

test('a step already done is only read back: a block Nick deleted is not recreated by confirming again', async () => {
  reset(); const rec = stored(); const sb = sandbox();
  const first = await confirmAndRun({ record: rec, adapters: sb });
  assert.equal(first.receipt.complete, true);
  sb.calendar._save([]); // Nick deletes the block in Outlook
  const again = await confirmAndRun({ record: rec, adapters: sb });
  assert.deepEqual(again.receipt.steps.map((s) => s.status), ['removed-since', 'already-done']);
  assert.match(again.receipt.plain, /has since been removed — I haven’t recreated it/);
  assert.equal(again.receipt.next, 'Nothing else will be done.');
  assert.deepEqual(sb.calendar._all(), [], 'not recreated');
});

test('the receipt claims no tracking and contacts nobody', async () => {
  reset(); const rec = stored(); const sb = sandbox();
  const { receipt } = await confirmAndRun({ record: rec, adapters: sb });
  assert.equal(receipt.tracking, undefined);
  assert.deepEqual(receipt.contacted, []);
  assert.equal(exec.track, undefined, 'no tracking job exists');
});
