'use strict';

/**
 * SAiM's authority budget — the hard operating boundary. Real scratch database,
 * real intent grants, real external-write ledger, real executor, disposable
 * sandbox adapters. Nothing reaches Microsoft, the Pi or the real vault.
 *
 * What is pinned: zero defaults; every budget dimension; both gates (device
 * lock AND allowance) required and neither creating the other; concurrent
 * confirms never exceeding a limit; a retry never spending twice; a partial
 * action keeping its truthful state; the emergency stop before, during and
 * after an action; off-duty and stale-evidence refusals leaving nothing spent;
 * the grant itself being a one-use, exact, ceiling-bound human act.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-budget-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_TIMEZONE = 'Europe/London';
for (const k of ['HA_TOKEN', 'HA_URL', 'SAIM_PREPARED_MOVE_EXECUTION']) delete process.env[k];
fs.mkdirSync(path.join(VAULT, 'Projects', 'Support Improvement Plan'), { recursive: true });

const db = require('../db/database');
const budget = require('./authority-budget');
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
const DRAFT = '# T1 — Triage and escalation acceptance criteria (DRAFT prepared by SAiM)\n\n## Every escalation must carry\n- Current customer ask\n';
const SESSION = 'session_budget_0001';

let counter = 0;
function stored({ msId = 'PLANNER-ID-1', minutes = 30, decidedAgoMin = 10 } = {}) {
  const end = `10:${String(25 + minutes).padStart(2, '0')}`;
  const p = {
    contract: 'prepared-move-v1',
    decision: { decidedAt: new Date(NOW - decidedAgoMin * 60000).toISOString() },
    selected: {
      title: 'Written criteria for what each team accepts',
      record: { system: 'planner', msId, plan: 'Support Improvement Plan' },
      screens: { employment: { sensitive: false, categories: [] }, freshnessOk: true, recordUnique: true },
      preparation: [{ did: 'drafted', sideEffect: 'none', draft: `${DRAFT}\n<!-- v${++counter} -->\n` }],
      decision: {
        slots: [{ id: 'approve', date: SLOT_DAY, start: '10:25', end }],
        proposedWrites: [
          { kind: 'calendar.solo', title: 'Triage and escalation criteria draft', slot: 'chosen', attendees: [], body: 'Prepared by SAiM' },
          // One note path per move, so several moves in a day never collide on a file.
          { kind: 'vault.note', path: msId === 'PLANNER-ID-1' ? NOTE : `Projects/Support Improvement Plan/SIP - ${msId} (draft).md` },
        ],
        forum: { title: 'Support Improvement Plan', start: `${FORUM_DAY}T16:00` },
      },
      verification: { checks: [] },
    },
  };
  const r = store.store(p, { now: NOW });
  assert.equal(r.ok, true, r.why);
  return r.record;
}
const okChecks = (sb) => ({
  diary: async () => ({ known: true, clashes: [] }),
  availability: async () => ({ known: true, off: false, working: true }),
  candidate: async () => ({ ok: true }),
  noteState: exec.defaultChecks({ adapters: sb }).noteState,
});
let n = 0;
const sandbox = () => createSandbox(path.join(tmp, `sb-${++n}`), { realVault: VAULT });
const confirmation = (rec) => { const c = exec.requestConfirmation({ recordId: rec.id, option: 'approve', sessionId: SESSION }); assert.equal(c.ok, true, JSON.stringify(c)); return c.grantId; };
const run = (rec, sb, grantId = confirmation(rec)) => exec.execute({ recordId: rec.id, option: 'approve', grantId, adapters: sb, checks: okChecks(sb) });
const today = () => budget.londonDay(Date.now());

let duty = { onDuty: true };
function fresh({ lock = true, grant = true, blockMinutes } = {}) {
  db.run(`DELETE FROM external_write_ledger WHERE idempotency_key LIKE 'saim-move:%'`);
  budget._test.reset();
  duty = { onDuty: true };
  if (lock) process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true'; else delete process.env.SAIM_PREPARED_MOVE_EXECUTION;
  if (grant) budget._test.grantToday({ blockMinutes });
}

test.before(async () => { await db.init(); exec._setDeps({ readDuty: async () => duty }); });
test.after(() => { delete process.env.SAIM_PREPARED_MOVE_EXECUTION; try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

// ── Zero by default ──────────────────────────────────────────────────────────

test('zero by default: no allowance, nothing can act, and the executor refuses before spending or building', async () => {
  fresh({ lock: true, grant: false });
  const s = budget.status();
  assert.equal(s.grant, null);
  for (const k of ['blocks', 'minutes', 'notes', 'moves']) assert.equal(s.allowance[k].granted, 0, k);
  assert.equal(s.allowance.spendPence, 0); assert.equal(s.allowance.contacts, 0);
  assert.equal(s.canAct, false);
  assert.equal(s.gates.allowance.say, 'You haven’t allowed SAiM to carry out any prepared moves today.');
  assert.equal(budget.reserve({ moveKey: 'm', steps: [{ key: 'm:calendar', kind: 'calendar.solo', minutes: 10 }] }).limit, 'no-allowance');

  const rec = stored(); const grantId = confirmation(rec);
  let built = 0;
  const r = await exec.execute({ recordId: rec.id, grantId, adapters: () => { built += 1; return sandbox(); }, target: 'sandbox', checks: () => okChecks(null) });
  assert.equal(r.ok, false); assert.equal(r.budget, 'no-allowance');
  assert.match(r.reasons[0], /^SAiM has no allowance to act today\. Nothing was written and your confirmation was not used\.$/);
  assert.equal(built, 0, 'no adapter constructed');
  assert.equal(ig.get(grantId).consumed_at, null, 'the confirmation was not spent');
  assert.equal(db.get(`SELECT COUNT(*) n FROM saim_authority_reservations`).n, 0);
});

test('a fresh install: viewing the allowance inside a read-only pass creates no tables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-budget-ro-'));
  const script = `
    process.env.NEURO_DB_PATH = ${JSON.stringify(path.join(dir, 'agent.db'))};
    (async () => {
      const db = require(${JSON.stringify(path.join(__dirname, '..', 'db', 'database'))});
      await db.init();
      const scope = require(${JSON.stringify(path.join(__dirname, 'read-only-scope'))});
      const budget = require(${JSON.stringify(path.join(__dirname, 'authority-budget'))});
      const out = await scope.run(async () => ({ brief: budget.brief(), stop: budget.stopState() }));
      const tables = db.all("SELECT name FROM sqlite_master WHERE name LIKE 'saim_authority%'").length;
      console.log(JSON.stringify({ out, tables }));
    })().catch((e) => { console.log(JSON.stringify({ error: e.message })); });`;
  const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  const line = res.stdout.trim().split('\n').pop();
  const parsed = JSON.parse(line);
  assert.equal(parsed.error, undefined, parsed.error);
  assert.equal(parsed.tables, 0, 'no budget tables created by a read');
  assert.equal(parsed.out.writesRefused, 0, 'it did not even try to write');
  const { brief } = parsed.out.result;
  assert.equal(brief.canAct, false); assert.equal(brief.granted, false);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
});

// ── The grant: a human act, exact and bounded ────────────────────────────────

test('grant: only the day and block length may be chosen; ceilings refused, never clamped', () => {
  fresh({ grant: false });
  for (const body of [{ spendPence: 100 }, { contacts: 1 }, { blocks: 4 }, { notes: 4 }, { moves: 4 }, { action: 'email.send' }, { attendees: ['x'] }]) {
    const p = budget.previewGrant(body);
    assert.equal(p.ok, false, JSON.stringify(body)); assert.equal(p.code, 400); assert.match(p.why, /not something SAiM can be allowed/);
  }
  assert.match(budget.previewGrant({ blockMinutes: 31 }).why, /at most 30 minutes/);
  assert.match(budget.previewGrant({ blockMinutes: 0 }).why, /at most 30 minutes/);
  assert.match(budget.previewGrant({ day: ymd(NOW - DAY) }).why, /passed/);
  assert.match(budget.previewGrant({ day: ymd(NOW + 9 * DAY) }).why, /at most 7 days ahead/);
  const p = budget.previewGrant({ blockMinutes: 30 });
  assert.equal(p.ok, true);
  assert.equal(p.terms.spendPence, 0); assert.equal(p.terms.contacts, 0); assert.equal(p.terms.blocks, 3); assert.equal(p.terms.notes, 3); assert.equal(p.terms.moves, 3);
  assert.match(p.statement[0], /^Allow SAiM to carry out up to three prepared moves on /);
  assert.match(p.statement.join(' '), /waits for you to confirm it before it writes anything/);
  assert.match(p.statement.join(' '), /No sending, no contacting anyone, no meeting invitations, no tasks, no shared-board changes, and no changes to what SAiM may do/);
  assert.doesNotMatch(p.statement.join(' '), /\bPi\b|\benv\b|SAIM_|\block\b/i, 'no implementation words');
});

test('grant: the confirmation is one-use, expires, and grants exactly what was shown', () => {
  fresh({ grant: false });
  const p = budget.previewGrant({ blockMinutes: 20 });
  assert.equal(budget.grant({ confirmToken: 'ac_made_up' }).ok, false);
  const late = budget.grant({ confirmToken: p.confirmToken, now: Date.now() + budget.CONFIRM_TTL_MS + 1000 });
  assert.match(late.why, /expired/);
  const p2 = budget.previewGrant({ blockMinutes: 20 });
  assert.equal(budget.grant({ confirmToken: p2.confirmToken }).ok, true);
  assert.match(budget.grant({ confirmToken: p2.confirmToken }).why, /already been used/);
  assert.equal(budget.status().grant.blockMinutes, 20);
  assert.match(budget.previewGrant({}).why, /already has an allowance/);
});

test('the database itself refuses anything past the ceiling, and a grant is never edited or deleted', () => {
  fresh();
  const ins = (cols) => db.run(`INSERT INTO saim_authority_grants (id, day, action, blocks, block_minutes, notes, moves, spend_pence, contacts, statement, granted_at, granted_by)
    VALUES (?, ?, 'prepared-move.block-and-note', ?, ?, ?, ?, ?, ?, '[]', 'x', 'test')`, cols);
  assert.throws(() => ins(['g1', '2099-01-01', 4, 30, 3, 3, 0, 0]), /CHECK/);
  assert.throws(() => ins(['g2', '2099-01-01', 3, 31, 3, 3, 0, 0]), /CHECK/);
  assert.throws(() => ins(['g3', '2099-01-01', 3, 30, 4, 3, 0, 0]), /CHECK/);
  assert.throws(() => ins(['g4', '2099-01-01', 3, 30, 3, 4, 0, 0]), /CHECK/);
  assert.throws(() => ins(['g5', '2099-01-01', 3, 30, 3, 3, 1, 0]), /CHECK/);
  assert.throws(() => ins(['g6', '2099-01-01', 3, 30, 3, 3, 0, 1]), /CHECK/);
  const g = db.get(`SELECT id FROM saim_authority_grants WHERE day = ?`, [today()]);
  assert.throws(() => db.run(`UPDATE saim_authority_grants SET blocks = 1, block_minutes = 25 WHERE id = ?`, [g.id]), /immutable/);
  assert.throws(() => db.run(`DELETE FROM saim_authority_grants WHERE id = ?`, [g.id]), /never deleted/);
  assert.throws(() => db.run(`DELETE FROM saim_authority_events`), /append-only/);
  assert.equal(budget.revoke().revoked, true);
  assert.throws(() => db.run(`UPDATE saim_authority_grants SET revoked_at = NULL WHERE id = ?`, [g.id]), /immutable/, 'a revocation cannot be undone by editing');
});

// ── Both gates ───────────────────────────────────────────────────────────────

test('both gates are required, and neither creates the other', async () => {
  // Allowance, but the device is locked.
  fresh({ lock: false, grant: true });
  let rec = stored(); let sb = sandbox(); let grantId = confirmation(rec);
  let r = await run(rec, sb, grantId);
  assert.equal(r.ok, false); assert.equal(r.gate, 'device'); assert.match(r.reasons[0], /switched off on NEURO’s server/);
  assert.equal(ig.get(grantId).consumed_at, null);
  assert.equal(budget.status().allowance.blocks.used, 0, 'locked: nothing reserved');
  assert.equal(require('./feature-flags').isEnabled('saim_prepared_move_execution'), false, 'granting did not open the lock');
  assert.equal(budget.status().gates.device.say, 'Carrying out moves is switched off on NEURO’s server.');
  assert.match(budget.status().grant.statement.join(' '), /switched off on NEURO’s server right now, so until that is switched on SAiM can prepare moves but not do them/);

  // Device open, but no allowance.
  fresh({ lock: true, grant: false });
  assert.equal(budget.status().grant, null, 'opening the lock created no allowance');
  rec = stored(); sb = sandbox(); grantId = confirmation(rec);
  r = await run(rec, sb, grantId);
  assert.equal(r.ok, false); assert.equal(r.budget, 'no-allowance');
  assert.deepEqual(await sb.calendar._all(), []);

  // Both: it runs.
  fresh({ lock: true, grant: true });
  rec = stored(); sb = sandbox();
  r = await run(rec, sb);
  assert.equal(r.ok, true); assert.equal(r.receipt.complete, true);
  const s = budget.status();
  assert.equal(s.gates.device.say, 'SAiM is ready.');
  assert.equal(s.allowance.blocks.left, 2); assert.equal(s.allowance.notes.left, 2); assert.equal(s.allowance.moves.left, 2);
  assert.equal(s.canAct, true, 'two of three moves left');
  assert.equal(s.leftToday, 'two of three prepared moves left today · 2 calendar blocks · 2 notes or reply drafts');
});

// ── Every dimension ──────────────────────────────────────────────────────────

test('dimensions: spend, contacts and unknown actions are refused at £0 / 0 / allow-list', () => {
  fresh();
  const step = (over) => [{ key: 'k:calendar', kind: 'calendar.solo', minutes: 10, contacts: 0, spendPence: 0, ...over }];
  assert.equal(budget.reserve({ moveKey: 'k', steps: step({ spendPence: 1 }) }).limit, 'spend');
  assert.match(budget.reserve({ moveKey: 'k', steps: step({ spendPence: 1 }) }).say, /£0/);
  assert.equal(budget.reserve({ moveKey: 'k', steps: step({ contacts: 1 }) }).limit, 'contacts');
  assert.equal(budget.reserve({ moveKey: 'k', steps: step({ kind: 'email.send' }) }).limit, 'action');
  assert.equal(budget.reserve({ action: 'calendar.cancel', moveKey: 'k', steps: step() }).limit, 'action');
  assert.equal(db.get(`SELECT COUNT(*) n FROM saim_authority_reservations`).n, 0, 'a refusal reserves nothing');
});

test('dimensions: block minutes — a 30-minute move against a 20-minute allowance is refused, unspent', async () => {
  fresh({ blockMinutes: 20 });
  const rec = stored({ minutes: 30 }); const sb = sandbox(); const grantId = confirmation(rec);
  const r = await run(rec, sb, grantId);
  assert.equal(r.ok, false); assert.equal(r.budget, 'minutes');
  assert.match(r.reasons[0], /This block is 30 minutes; a block may be at most 20\./);
  assert.equal(ig.get(grantId).consumed_at, null);
  assert.equal(budget.status().allowance.minutes.used, 0);
  const smaller = stored({ minutes: 20, msId: 'PLANNER-ID-1' });
  assert.equal((await run(smaller, sandbox())).ok, true, 'a 20-minute version fits');
});

test('dimensions: three moves a day — each confirmed on its own; a fourth is refused, unspent', async () => {
  fresh();
  for (const id of ['A', 'B', 'C']) {
    // Every move needs ITS OWN confirmation: one grant never covers another.
    const rec = stored({ msId: id });
    const other = stored({ msId: `${id}-other` });
    const g = confirmation(rec);
    const wrong = await exec.execute({ recordId: other.id, option: 'approve', grantId: g, adapters: sandbox(), checks: okChecks(null) });
    assert.equal(wrong.ok, false, `${id}: a confirmation for one move cannot run another`);
    assert.equal((await run(rec, sandbox(), confirmation(rec))).ok, true, id);
  }
  const fourth = stored({ msId: 'D' }); const grantId = confirmation(fourth); const sb = sandbox();
  const r = await run(fourth, sb, grantId);
  assert.equal(r.ok, false); assert.equal(r.budget, 'moves');
  assert.match(r.reasons[0], /covers 3 prepared moves, and it has been used/);
  assert.equal(ig.get(grantId).consumed_at, null);
  assert.deepEqual(await sb.calendar._all(), []);
  assert.equal(budget.status().canAct, false, 'used up');
  assert.equal(budget.status().summary, 'Today’s prepared moves are used up. It starts again tomorrow.');
  // The block and note limits are each enforced on their own too.
  const u = budget.usage(today());
  assert.deepEqual([u.blocks, u.notes, u.moves], [3, 3, 3]);
  const g9 = (over) => ({ action: budget.ACTION, blocks: 3, block_minutes: 30, notes: 3, moves: 9, spend_pence: 0, contacts: 0, ...over });
  assert.equal(budget.judge({ stopped: false, g: g9({ notes: 9 }), action: budget.ACTION, steps: [{ kind: 'calendar.solo', minutes: 5 }], fresh: [{ kind: 'calendar.solo', minutes: 5 }], u, isNewMove: true }).limit, 'blocks');
  assert.equal(budget.judge({ stopped: false, g: g9({ blocks: 9 }), action: budget.ACTION, steps: [{ kind: 'vault.note' }], fresh: [{ kind: 'vault.note' }], u, isNewMove: true }).limit, 'notes');
  assert.equal(budget.judge({ stopped: false, g: g9({ blocks: 9 }), action: budget.ACTION, steps: [{ kind: 'reply.draft' }], fresh: [{ kind: 'reply.draft' }], u, isNewMove: true }).limit, 'notes', 'a reply draft counts as a written output');
  assert.equal(budget.judge({ stopped: false, g: g9({ blocks: 9, notes: 9 }), action: budget.ACTION, steps: [{ kind: 'calendar.solo', minutes: 31 }], fresh: [{ kind: 'calendar.solo', minutes: 31 }], u, isNewMove: true }).limit, 'minutes', 'no single block past 30 minutes');
});

test('off duty and stale evidence: refused before anything is reserved or spent', async () => {
  fresh();
  duty = { onDuty: false, why: 'leave' };
  let rec = stored(); let grantId = confirmation(rec);
  let r = await run(rec, sandbox(), grantId);
  assert.equal(r.ok, false); assert.equal(r.held, true); assert.equal(r.reasons[0], 'I’ve prepared this for your next working morning.');
  assert.equal(ig.get(grantId).consumed_at, null);
  assert.equal(db.get(`SELECT COUNT(*) n FROM saim_authority_reservations`).n, 0);

  duty = { onDuty: true };
  rec = stored({ decidedAgoMin: 3 * 60 }); // evidence older than two hours
  grantId = ig.mintForPreparedMove({ recordId: rec.id, version: rec.version, option: 'approve', writeHash: rec.options.approve.writeHash, surface: 'neuro-web', sessionId: SESSION }).grantId;
  const sb = sandbox();
  r = await run(rec, sb, grantId);
  assert.equal(r.ok, false); assert.match(r.reasons[0], /expired/);
  assert.equal(budget.status().allowance.blocks.left, 3, 'a fresh-check refusal hands the allowance back');
  assert.equal(db.get(`SELECT state FROM saim_authority_reservations LIMIT 1`).state, 'released');
  assert.deepEqual(await sb.calendar._all(), []);
});

// ── Concurrency, retries and partial actions ─────────────────────────────────

test('concurrent confirms for four different moves: exactly three run, the fourth is refused at the limit', async () => {
  fresh();
  const recs = ['RACE-A', 'RACE-B', 'RACE-C', 'RACE-D'].map((msId) => stored({ msId }));
  const sbs = recs.map(() => sandbox());
  const rs = await Promise.all(recs.map((r, i) => run(r, sbs[i])));
  assert.equal(rs.filter((r) => r.ok).length, 3, JSON.stringify(rs.map((r) => r.reasons)));
  assert.equal(rs.find((r) => !r.ok).budget, 'moves');
  let events = 0; for (const sb of sbs) events += (await sb.calendar._all()).length;
  assert.equal(events, 3, 'three calendar blocks in total');
  const u = budget.usage(today());
  assert.deepEqual([u.blocks, u.notes, u.moves], [3, 3, 3]);
});

test('concurrent confirms of the SAME move: one runs, the other is turned away unspent; one block, budget spent once', async () => {
  fresh();
  const rec = stored(); const sb = sandbox();
  const g1 = confirmation(rec); const g2 = confirmation(rec);
  const rs = await Promise.all([run(rec, sb, g1), run(rec, sb, g2)]);
  assert.equal(rs.filter((r) => r.ok).length, 1, JSON.stringify(rs.map((r) => r.reasons)));
  const other = rs.find((r) => !r.ok);
  assert.match(other.reasons[0], /already being carried out/);
  assert.equal(ig.get([g1, g2][rs.indexOf(other)]).consumed_at, null, 'the turned-away confirmation was not spent');
  assert.equal((await sb.calendar._all()).length, 1);
  const u = budget.usage(today());
  assert.deepEqual([u.blocks, u.minutes, u.notes, u.moves], [1, 30, 1, 1]);
});

test('an idempotent repeat spends nothing more', async () => {
  fresh();
  const rec = stored(); const sb = sandbox();
  await run(rec, sb);
  const again = await run(rec, sb);
  assert.equal(again.ok, true);
  assert.deepEqual(again.receipt.steps.map((s) => s.status), ['already-done', 'already-done']);
  assert.deepEqual([budget.usage(today()).blocks, budget.usage(today()).notes], [1, 1]);
  assert.equal(db.get(`SELECT COUNT(*) n FROM saim_authority_reservations`).n, 2);
});

test('partial: the note provably failed — its allowance comes back, the block stays spent; the retry uses it once', async () => {
  fresh();
  const rec = stored(); const sb = sandbox();
  sb.faults.vault = 'fail-next';
  const first = await run(rec, sb);
  assert.deepEqual(first.receipt.steps.map((s) => s.status), ['done', 'failed']);
  let s = budget.status();
  assert.equal(s.allowance.blocks.left, 2); assert.equal(s.allowance.notes.left, 3, 'a write that provably did not happen is not charged');
  assert.equal(s.active.state, 'partly-done');
  const retry = await run(rec, sb);
  assert.deepEqual(retry.receipt.steps.map((s2) => s2.status), ['already-done', 'done']);
  s = budget.status();
  assert.deepEqual([s.allowance.blocks.used, s.allowance.notes.used, s.allowance.moves.used], [1, 1, 1]);
  assert.equal(s.active.state, 'done');
});

test('partial: an uncertain write stays charged (unknown counts as used) and is never charged again', async () => {
  fresh();
  const rec = stored(); const sb = sandbox();
  sb.faults.calendar = 'apply-then-throw';
  const first = await run(rec, sb);
  assert.equal(first.receipt.steps[0].status, 'failed');
  assert.equal(db.get(`SELECT state FROM saim_authority_reservations WHERE kind = 'calendar.solo'`).state, 'unknown');
  assert.equal(budget.status().allowance.blocks.left, 2, 'the uncertain block stays charged');
  const retry = await run(rec, sb);
  assert.equal(retry.receipt.steps[0].status, 'already-done');
  assert.equal(budget.usage(today()).blocks, 1);
  assert.equal((await sb.calendar._all()).length, 1);
});

// ── The emergency stop ───────────────────────────────────────────────────────

test('stop: before an action — refused unspent, nothing built; request refused too; resume needs its own confirmation', async () => {
  fresh();
  const rec = stored(); const grantId = confirmation(rec);
  budget.stop();
  let built = 0;
  const r = await exec.execute({ recordId: rec.id, grantId, adapters: () => { built += 1; return sandbox(); }, target: 'sandbox', checks: (ad) => okChecks(ad) });
  assert.equal(r.ok, false); assert.equal(r.gate, 'stop'); assert.match(r.reasons[0], /^SAiM’s actions are stopped\./);
  assert.equal(built, 0); assert.equal(ig.get(grantId).consumed_at, null);
  const req = await exec.requestForMove({ sessionId: SESSION });
  assert.equal(req.ok, false); assert.equal(req.code, 409); assert.match(req.reasons[0], /stopped/);
  assert.equal(budget.status().summary, 'All SAiM actions are stopped.');
  assert.equal(budget.resume({ confirmToken: 'ac_nope' }).ok, false, 'no resume without its confirmation');
  const p = budget.previewResume();
  assert.equal(budget.resume({ confirmToken: p.confirmToken }).ok, true);
  assert.equal(budget.stopState().stopped, false);
  assert.equal((await run(rec, sandbox())).ok, true, 'still within the same allowance after resuming');
});

test('stop: DURING an action — the step in progress finishes truthfully, the next is never attempted and is not charged', async () => {
  fresh();
  const rec = stored(); const sb = sandbox();
  const create = sb.calendar.create.bind(sb.calendar);
  sb.calendar.create = async (...a) => { const ev = await create(...a); budget.stop(); return ev; };
  const r = await run(rec, sb);
  assert.equal(r.ok, true);
  assert.deepEqual(r.receipt.steps.map((s) => s.status), ['done', 'stopped']);
  assert.equal(r.receipt.complete, false);
  assert.match(r.receipt.plain, /The note was not attempted — SAiM’s actions were stopped\. The calendar block is in place and stays\./);
  assert.equal(r.receipt.next, 'Nothing more will happen while SAiM’s actions are stopped.');
  assert.equal(await sb.vault.exists(NOTE), false, 'no note');
  const s = budget.status();
  assert.equal(s.allowance.blocks.used, 1); assert.equal(s.allowance.notes.used, 0, 'the unattempted note is not charged');
  assert.equal(s.active.state, 'partly-done');
  // After: confirming again is refused while stopped.
  const again = await run(rec, sb);
  assert.equal(again.ok, false); assert.equal(again.gate, 'stop');
});

// ── What Nick sees never claims what has not happened ────────────────────────

test('status claims nothing without a receipt: no run = "Nothing has been carried out today", no receipts', async () => {
  fresh();
  let s = budget.status();
  assert.equal(s.active.state, 'none'); assert.deepEqual(s.receipts, []);
  assert.equal(s.summary, 'SAiM can carry out three more prepared moves today, each after you confirm it.');
  await run(stored(), sandbox());
  s = budget.status();
  assert.equal(s.receipts.length, 1); assert.equal(s.receipts[0].complete, true);
  assert.equal(s.active.state, 'done'); assert.equal(s.active.practice, true);
  assert.equal(s.active.say, 'Practice run, nothing real was changed: Both are in place and checked.', 'a practice run never reads as a real one');
  const flat = JSON.stringify(s);
  assert.doesNotMatch(flat, /saim-move:|pm_[0-9a-f]|ig_[0-9a-f]|ag_[0-9a-f]|ar_[0-9a-f]/, 'no internal identifier in what Nick sees');
});

test('a refusal names the limit in plain words and never an internal identifier', async () => {
  fresh({ grant: false });
  const rec = stored();
  const r = await run(rec, sandbox());
  assert.doesNotMatch(r.reasons[0], /saim-move:|pm_|ig_|ag_|ar_|PLANNER/);
});

// ── The device lock is the Pi environment, exactly (20 Oct 2026) ─────────────

const flagsMod = require('./feature-flags');
const LOCK_KEY = `${flagsMod.STATE_PREFIX}saim_prepared_move_execution`;
const setEnv = (v) => { if (v === undefined) delete process.env.SAIM_PREPARED_MOVE_EXECUTION; else process.env.SAIM_PREPARED_MOVE_EXECUTION = v; };

test('env-only lock: only the exact value "true" opens it; a stored switch value never does', () => {
  try {
    for (const stored of [null, 'true', 'false']) {
      if (stored === null) db.run('DELETE FROM agent_state WHERE key = ?', [LOCK_KEY]); else db.setState(LOCK_KEY, stored);
      setEnv('true');
      assert.equal(flagsMod.isEnabled('saim_prepared_move_execution'), true, `env true, stored ${stored}`);
      assert.equal(budget.masterLock().open, true);
      for (const v of [undefined, '', 'TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', 'false']) {
        setEnv(v);
        assert.equal(flagsMod.isEnabled('saim_prepared_move_execution'), false, `env ${JSON.stringify(v)}, stored ${stored}`);
        assert.equal(budget.masterLock().open, false, `masterLock env ${JSON.stringify(v)}`);
      }
    }
  } finally { db.run('DELETE FROM agent_state WHERE key = ?', [LOCK_KEY]); delete process.env.SAIM_PREPARED_MOVE_EXECUTION; }
});

test('missing env is locked even when an old stored switch says enabled — and nothing is spent or written', async () => {
  fresh({ lock: false, grant: true });
  db.setState(LOCK_KEY, 'true');
  try {
    const rec = stored(); const grantId = confirmation(rec);
    let built = 0;
    const r = await exec.execute({ recordId: rec.id, option: 'approve', grantId, adapters: () => { built += 1; return sandbox(); }, target: 'sandbox', checks: () => okChecks(null) });
    assert.equal(r.ok, false); assert.equal(r.gate, 'device');
    assert.equal(built, 0, 'no adapter built');
    assert.equal(ig.get(grantId).consumed_at, null, 'confirmation not spent');
    assert.equal(db.get(`SELECT COUNT(*) n FROM saim_authority_reservations`).n, 0, 'nothing reserved');
  } finally { db.run('DELETE FROM agent_state WHERE key = ?', [LOCK_KEY]); }
});

test('a move happens only with the exact env value AND an allowance', async () => {
  // env "TRUE" (not exact) + allowance → device gate.
  fresh({ lock: false, grant: true }); setEnv('TRUE');
  let rec = stored(); let r = await run(rec, sandbox());
  assert.equal(r.ok, false); assert.equal(r.gate, 'device');
  // exact env, no allowance → no-allowance.
  fresh({ lock: true, grant: false });
  rec = stored(); r = await run(rec, sandbox());
  assert.equal(r.ok, false); assert.equal(r.budget, 'no-allowance');
  // exact env + allowance → it runs (sandbox).
  fresh({ lock: true, grant: true });
  rec = stored(); r = await run(rec, sandbox());
  assert.equal(r.ok, true, JSON.stringify(r.reasons || r));
  delete process.env.SAIM_PREPARED_MOVE_EXECUTION;
});
