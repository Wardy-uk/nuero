'use strict';

/**
 * The automatic scan's cap (24 Oct 2026; replaces the 23 Oct global
 * one-active rule). Real scratch DB, real store, real planner, real scan,
 * real authority budget and grants — and, for "booked", a REAL confirm through
 * prepared-move-exec's live adapters against a fake Graph and a temp vault, so
 * a block counts as scheduled only because it was written and read back.
 *
 *   - an automatic review (a draft that proposes a private block) that is not
 *     booked blocks the next REVIEW item, never a reply;
 *   - a manual press always prepares, without touching the automatic one, and
 *     a repeated press returns the existing proposal;
 *   - a proposed slot stays blocking; a sandbox run or a failed calendar step
 *     does not unblock; a live, read-back block does;
 *   - the daily allowance and the per-move confirmation still hold.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-scan-cap-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_TIMEZONE = 'Europe/London';
for (const k of ['HA_TOKEN', 'HA_URL', 'SAIM_PREPARED_MOVE_EXECUTION', 'SAIM_PREPARED_MOVE_SCAN']) delete process.env[k];
fs.mkdirSync(path.join(VAULT, 'Projects', 'Support Hub'), { recursive: true });

const db = require('../db/database');
const planner = require('./prepared-move-planner');
const store = require('./prepared-move-store');
const exec = require('./prepared-move-exec');
const scan = require('./prepared-move-scan');
const budget = require('./authority-budget');
const ig = require('./intent-grants');
const { createSandbox } = require('./prepared-move-sandbox');

const NOW = Date.now();
const SESSION = 'session_cap_00001';
let tick = 0;
const uniq = () => `${NOW}-${++tick}`;
const BODY = 'Hi Nick, could you confirm whether the renewal for Acme can go ahead this month? We need your answer.';
const emailCand = (id) => ({ ref: `held:email-${id}`, role: 'held', title: 'Renewal question', item: { type: 'email', id: 'email-urgent', title: 'Renewal question', meta: { emailId: id } } });
const emailIds = new Set();
const triage = (id) => (emailIds.has(id) ? { id, subject: 'Renewal question', from: 'Sam Jones', fromEmail: 'sam@acme.test', triagedAt: new Date(NOW - 3600000).toISOString() } : null);
function todo(label) {
  const text = `Write the Support Hub ${label} notes ${uniq()}`;
  require('./task-store').createTask({ text, source: 'manual', origin_path: 'Projects/Support Hub/Support Hub.md' });
  const row = db.get('SELECT id, text FROM tasks WHERE text = ?', [text]);
  return { id: row.id, cand: { ref: `held:todo-${row.id}`, role: 'held', title: text, item: { type: 'todo', id: `todo-${row.id}`, title: text, meta: {} } } };
}
let drafts = 0;
function deps(cands, over = {}) {
  return {
    prepareV1: async () => ({ contract: 'prepared-move-v1', decision: { decidedAt: new Date(NOW - 60000).toISOString() }, duty: { onDuty: true, why: 'working' }, selected: null, withheld: [], candidates: cands }),
    roster: () => ({ full: [] }),
    triageEntry: triage,
    emailBody: async () => BODY,
    liveReply: () => null,
    evidenceLines: (t) => [{ text: `${t} need a single owner each week`, cite: 'Projects/Support Hub/Support Hub.md:2' }],
    draft: async (kind) => { drafts += 1; return kind === 'email-reply' ? { ok: true, text: 'Hi Sam,\n\nThanks — I will confirm the renewal this month.\n\nNick', gaps: [] } : { ok: true, text: '## Notes\n- one owner each week', gaps: ['who owns it'] }; },
    diary: () => ({ known: true, events: [], fetchedAt: new Date(NOW - 60000).toISOString() }),
    holidays: () => new Set(),
    leaveState: () => 'working',
    ...over,
  };
}
const sc = (cands, over = {}) => scan.scanOnce({ now: NOW, deps: { flagOn: true, workingDay: true, duty: { onDuty: true }, inMeeting: false, planner: deps(cands), ...over } });
const keyOfTodo = (t) => planner.moveKeyFor('project-note', `task:${t.id}`);
const keyOfEmail = (id) => planner.moveKeyFor('email-reply', `email:${id}`);
const rowsOf = (k) => db.all('SELECT id, version FROM prepared_moves WHERE move_key = ? ORDER BY version', [k]);
const responsesOf = (id) => { try { return db.all('SELECT * FROM prepared_move_responses WHERE record_id = ?', [id]); } catch { return []; } };

// ── A fake Graph for the live calendar adapter ───────────────────────────────
function fakeGraph({ failCreate = false } = {}) {
  const events = new Map();
  const MARKER = require('./calendar-read').MARKER_PROP;
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url); const method = opts.method || 'GET';
    const json = (status, body) => ({ status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
    if (u.hostname !== 'graph.microsoft.com') throw new Error('unexpected host');
    if (method === 'POST' && u.pathname === '/v1.0/me/events') {
      if (failCreate) return json(400, { error: { message: 'refused' } });
      const id = `evt${events.size + 1}`; events.set(id, { id, ...JSON.parse(opts.body) }); return json(201, events.get(id));
    }
    if (method === 'GET' && u.pathname === '/v1.0/me/events') {
      const want = /ep\/value eq '([^']+)'/.exec(decodeURIComponent(u.search))[1];
      return json(200, { value: [...events.values()].filter((e) => (e.singleValueExtendedProperties || []).some((p) => p.id === MARKER && p.value === want)) });
    }
    const one = /^\/v1\.0\/me\/events\/([^/]+)$/.exec(u.pathname);
    if (method === 'GET' && one) return events.has(decodeURIComponent(one[1])) ? json(200, events.get(decodeURIComponent(one[1]))) : json(404, {});
    return json(500, {});
  };
  return events;
}
const okChecks = (ad) => ({
  diary: async () => ({ known: true, clashes: [] }),
  availability: async () => ({ known: true, off: false, working: true }),
  candidate: async () => ({ ok: true }),
  noteState: exec.defaultChecks({ adapters: ad }).noteState,
});
async function confirmLive(rec, { failCreate = false } = {}) {
  const ms = require('./microsoft'); const realToken = ms.getAccessToken; ms.getAccessToken = async () => 'fake-token';
  const realFetch = global.fetch;
  const events = fakeGraph({ failCreate });
  process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
  try {
    const c = exec.requestConfirmation({ recordId: rec.id, option: 'approve', sessionId: SESSION });
    assert.equal(c.ok, true, JSON.stringify(c));
    const live = exec.liveAdapters();
    const r = await exec.execute({ recordId: rec.id, option: 'approve', grantId: c.grantId, adapters: live, checks: okChecks(live) });
    return { r, events };
  } finally { delete process.env.SAIM_PREPARED_MOVE_EXECUTION; ms.getAccessToken = realToken; global.fetch = realFetch; }
}

test.before(async () => {
  await db.init();
  exec._setDeps({ readDuty: async () => ({ onDuty: true, why: 'working' }) });
  require('./prepared-move').readDuty = async () => ({ onDuty: true, why: 'working' });
});
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

const A = todo('rota'); const B = todo('escalation'); const C = todo('handover');
const E1 = `cap-e1-${uniq()}`; const E2 = `cap-e2-${uniq()}`;
emailIds.add(E1); emailIds.add(E2);

test('an unbooked automatic review blocks the next REVIEW item — but a reply still gets prepared', async () => {
  budget._test.reset(); budget._test.grantToday({ now: NOW });
  const r1 = await sc([A.cand, B.cand]);
  assert.equal(r1.outcome, 'stored'); assert.equal(r1.moveKey, keyOfTodo(A));
  const recA = store.latest(keyOfTodo(A));
  assert.equal(store.needsBlock(recA), true, 'A proposes a private block');
  assert.equal(scan.isAutomatic(recA), true);
  // B is another review: held while A's block is unbooked.
  const r2 = await sc([A.cand, B.cand]);
  assert.notEqual(r2.moveKey, keyOfTodo(B));
  assert.equal(r2.reviewWaiting, keyOfTodo(A));
  assert.equal(store.latest(keyOfTodo(B)), null, 'B was not prepared');
  // A reply does not consume the review cap.
  const r3 = await sc([A.cand, B.cand, emailCand(E1)]);
  assert.equal(r3.outcome, 'stored'); assert.equal(r3.moveKey, keyOfEmail(E1));
  assert.equal(r3.reviewWaiting, keyOfTodo(A));
  // A proposed slot stays blocking on every rescan: still nothing for B.
  const r4 = await sc([A.cand, B.cand]);
  assert.notEqual(r4.moveKey, keyOfTodo(B));
  assert.equal(store.scheduledFor(keyOfTodo(A)), null, 'a suggested slot is not scheduled');
  assert.deepEqual(rowsOf(keyOfTodo(A)).map((x) => x.version), [1], 'A was re-checked, never re-planned');
});

test('a manual press on B prepares it while automatic A is still unbooked — and neither is overwritten', async () => {
  const recA = store.latest(keyOfTodo(A));
  const r = await planner.planAndStore({ now: NOW, ref: B.cand.ref, origin: 'manual', deps: deps([A.cand, B.cand]) });
  assert.equal(r.outcome, 'stored', JSON.stringify(r));
  const recB = store.latest(keyOfTodo(B));
  assert.equal(scan.isAutomatic(recB), false, 'B is Nick’s, not the scan’s');
  // A untouched.
  assert.equal(store.latest(keyOfTodo(A)).id, recA.id);
  assert.deepEqual(rowsOf(keyOfTodo(A)).map((x) => x.version), [1]);
  assert.deepEqual(responsesOf(recA.id), [], 'not declined, deferred or touched');
  // A repeated manual press on B returns the existing proposal: no duplicate, no new draft.
  const d0 = drafts;
  const again = await planner.planAndStore({ now: NOW, ref: B.cand.ref, origin: 'manual', deps: deps([A.cand, B.cand]) });
  assert.equal(again.outcome, 'existing');
  assert.equal(again.record.id, recB.id);
  assert.deepEqual(rowsOf(keyOfTodo(B)).map((x) => x.version), [1]);
  assert.equal(drafts, d0);
  // Nick's own B does not count against the AUTOMATIC cap either way, and the scan does not re-prepare it.
  const s = await sc([A.cand, B.cand, C.cand]);
  assert.notEqual(s.moveKey, keyOfTodo(C), 'C still waits on A’s booking');
  assert.deepEqual(rowsOf(keyOfTodo(B)).map((x) => x.version), [1]);
});

test('the per-move confirmation and the daily allowance still hold — preparing spent nothing and confirms nothing', async () => {
  const recA = store.latest(keyOfTodo(A));
  // No grant was minted by preparing.
  assert.equal(db.get('SELECT COUNT(*) n FROM human_action_intents').n, 0);
  // Nothing runs without a confirmation.
  process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
  try {
    const sb = createSandbox(path.join(tmp, 'sb-0'), { realVault: VAULT });
    const none = await exec.execute({ recordId: recA.id, option: 'approve', grantId: null, adapters: sb, checks: okChecks(sb) });
    assert.equal(none.ok, false); assert.match(none.reasons.join(' '), /confirmation/);
  } finally { delete process.env.SAIM_PREPARED_MOVE_EXECUTION; }
  // No allowance today → cannot even be asked to confirm, and the scan prepares nothing.
  budget._test.reset();
  const ask = await exec.requestForMove({ recordId: recA.id, sessionId: SESSION, now: NOW });
  assert.equal(ask.ok, false);
  const used = await sc([A.cand, C.cand], { authority: () => ({ grant: { day: 'x' }, allowance: { moves: { left: 0 } } }) });
  assert.equal(used.ran, false); assert.match(used.why, /used up/);
  budget._test.grantToday({ now: NOW });
});

test('a SANDBOX run does not unblock; a live run whose calendar step FAILED does not unblock', async () => {
  const recA = store.latest(keyOfTodo(A));
  process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
  try {
    const sb = createSandbox(path.join(tmp, 'sb-1'), { realVault: VAULT });
    const c = exec.requestConfirmation({ recordId: recA.id, option: 'approve', sessionId: SESSION });
    assert.equal(c.ok, true, JSON.stringify(c));
    const r = await exec.execute({ recordId: recA.id, option: 'approve', grantId: c.grantId, adapters: sb, checks: okChecks(sb) });
    assert.equal(r.receipt.target, 'sandbox');
  } finally { delete process.env.SAIM_PREPARED_MOVE_EXECUTION; }
  assert.equal(store.scheduledFor(keyOfTodo(A)), null, 'a practice run books nothing');
  // The sandbox is test-only (unreachable from HTTP) and shares the live step
  // keys; clear its ledger rows as prepared-move-exec.test.js's reset() does.
  db.run(`DELETE FROM external_write_ledger WHERE idempotency_key LIKE ?`, [`${keyOfTodo(A)}%`]);
  const s1 = await sc([A.cand, C.cand]);
  assert.notEqual(s1.moveKey, keyOfTodo(C));
  // A live confirm where Graph refused the block.
  const { r } = await confirmLive(store.latest(keyOfTodo(A)), { failCreate: true });
  const cal = r.receipt.steps.find((x) => x.step === 'calendar');
  assert.notEqual(cal.status, 'done');
  assert.equal(store.scheduledFor(keyOfTodo(A)), null, 'a failed calendar step is not a booking');
  const s2 = await sc([A.cand, C.cand]);
  assert.notEqual(s2.moveKey, keyOfTodo(C));
});

test('once the block is genuinely WRITTEN and read back, A stops counting and the scan prepares the next review item', async () => {
  // A fresh move for A (the failed attempt above spent its version's confirmation).
  const recA = store.latest(keyOfTodo(A));
  const { r, events } = await confirmLive(recA);
  const cal = r.receipt.steps.find((x) => x.step === 'calendar');
  assert.ok(['done', 'already-done'].includes(cal.status), JSON.stringify(r.receipt.steps));
  assert.equal(events.size, 1, 'one block in the (fake) calendar');
  const [ev] = events.values();
  assert.deepEqual(ev.attendees, [], 'just Nick');
  const booked = store.scheduledFor(keyOfTodo(A));
  assert.ok(booked && booked.date && booked.start && booked.end, JSON.stringify(booked));
  // The external-write ledger records the same step.
  assert.ok(db.get(`SELECT COUNT(*) n FROM external_write_ledger WHERE idempotency_key LIKE ? AND status = 'confirmed'`, [`${keyOfTodo(A)}%`]).n >= 1);
  const s = await sc([A.cand, C.cand]);
  assert.equal(s.outcome, 'stored', JSON.stringify(s));
  assert.equal(s.moveKey, keyOfTodo(C));
  assert.equal(s.reviewWaiting, null);
});

test('the view says which is which: "Needs your decision before I can schedule it" vs "Scheduled for …; I can now make the next item ready"', () => {
  const view = require('./prepared-move-view');
  const rows = view.outstandingFrom(store.activeV2({ now: NOW, limit: 50 }), NOW);
  const byTitle = (t) => rows.find((r) => r.title === t);
  const c = byTitle(C.cand.title);
  assert.ok(c, JSON.stringify(rows));
  assert.equal(c.state, 'needs-decision'); assert.equal(c.say, 'Needs your decision before I can schedule it.');
  const a = byTitle(A.cand.title);
  assert.equal(a.state, 'scheduled', 'the booked one is listed as scheduled');
  assert.match(a.say, /^Scheduled for \w+ \d+ \w+ \d{2}:\d{2}–\d{2}:\d{2}; I can now make the next item ready\.$/);
  const e = byTitle('Renewal question');
  assert.equal(e.state, 'ready'); assert.equal(e.say, 'Ready for you to confirm — nothing needs booking.');
});

test('PURE: what counts against the review cap', () => {
  const draft = (writes, origin = 'scan') => ({ packet: { origin, selected: { plan: 'draft', kind: 'project-note', decision: { proposedWrites: writes } } } });
  assert.equal(scan.reviewPending(draft([{ kind: 'vault.note' }, { kind: 'calendar.solo' }])), true);
  assert.equal(scan.reviewPending(draft([{ kind: 'vault.note' }])), false, 'a note with no block needed');
  assert.equal(scan.reviewPending({ packet: { selected: { plan: 'draft', kind: 'email-reply', decision: { proposedWrites: [{ kind: 'governed.reply' }] } } } }), false, 'a reply never');
  assert.equal(scan.reviewPending({ packet: { selected: { plan: 'ask', kind: 'project-note' } } }), true, 'a review item still asking Nick');
  assert.equal(scan.reviewPending({ packet: { selected: { plan: 'ask', kind: 'email-reply' } } }), false);
  assert.equal(scan.isAutomatic({ packet: { origin: 'answer', firstOrigin: 'scan' } }), true, 'answering a scan proposal keeps it automatic');
  assert.equal(scan.isAutomatic({ packet: { origin: 'manual' } }), false);
});
