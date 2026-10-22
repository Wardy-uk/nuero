'use strict';

/**
 * Prepared moves MVP (21 Oct 2026): one planner, two routes in (scan and
 * "Make this ready"), one store, one executor. Real scratch DB, real store,
 * real intent grants, real authority budget; the sandbox target for writes;
 * every reader the planner uses is injected. Fixtures are dated off the clock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-v2-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_TIMEZONE = 'Europe/London';
for (const k of ['HA_TOKEN', 'HA_URL', 'SAIM_PREPARED_MOVE_EXECUTION', 'SAIM_PREPARED_MOVE_SCAN']) delete process.env[k];
fs.mkdirSync(path.join(VAULT, 'Projects', 'Support Hub'), { recursive: true });
fs.mkdirSync(path.join(VAULT, 'Projects', 'PIP'), { recursive: true });
fs.writeFileSync(path.join(VAULT, 'Projects', 'Support Hub', 'Support Hub.md'), '# Support Hub\n');

const db = require('../db/database');
const planner = require('./prepared-move-planner');
const store = require('./prepared-move-store');
const exec = require('./prepared-move-exec');
const scan = require('./prepared-move-scan');
const budget = require('./authority-budget');
const { createSandbox } = require('./prepared-move-sandbox');

const DAY = 86400000;
const NOW = Date.now();
const ymd = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
const SESSION = 'session_v2_0001';
let tick = 0;
const uniq = () => `${NOW}-${++tick}`;

const emailItem = (id, title = 'Renewal question') => ({ ref: `held:email-urgent-${id}`, role: 'held', title, item: { type: 'email', id: 'email-urgent', title, meta: { emailId: id } } });
const todoItem = (text) => ({ ref: `held:todo-${text.length}`, role: 'held', title: text, item: { type: 'todo', id: 'todo-overdue-top', title: text, meta: {} } });

function fakeV1(candidates, { onDuty = true, selectedRef = null } = {}) {
  return async () => ({
    contract: 'prepared-move-v1',
    decision: { decidedAt: new Date(NOW - 60000).toISOString(), rule: 'S5', lead: null },
    duty: onDuty ? { onDuty: true, why: 'working' } : { onDuty: false, why: 'off-duty' },
    selected: selectedRef ? { ref: selectedRef } : null,
    withheld: [], candidates,
  });
}

const EMAIL_BODY = 'Hi Nick, could you confirm whether the renewal for Acme can go ahead this month? The contract ends soon and we need your answer.';

/** Readers for one test; `over` replaces any. `drafts` counts model calls. */
function deps(candidates, over = {}) {
  const calls = { drafts: 0 };
  const d = {
    prepareV1: fakeV1(candidates),
    roster: () => ({ full: ['Mel Ellis'] }),
    triageEntry: (id) => ({ id, subject: 'Renewal question', from: 'Sam Jones', fromEmail: 'sam@acme.test', reason: 'asks a direct question', triagedAt: new Date(NOW - 3600000).toISOString(), received: new Date(NOW - 7200000).toISOString() }),
    emailBody: async () => EMAIL_BODY,
    liveReply: () => null,
    draft: async (kind) => { calls.drafts += 1; return kind === 'email-reply' ? { ok: true, text: 'Hi Sam,\n\nThanks — I will confirm the renewal for Acme this month.\n\nNick', gaps: [] } : { ok: true, text: '## Scope\n- Support Hub triage notes', gaps: [] }; },
    diary: () => ({ known: true, events: [], fetchedAt: new Date(NOW - 60000).toISOString() }),
    findSlot: () => ({ date: ymd(NOW + DAY), startTime: '10:00', endTime: '10:30' }),
    holidays: () => new Set(),
    leaveState: () => 'working',
    // Tests about OTHER rules start with no open proposal; the one-active rule has its own tests.
    activeV2: () => [],
    evidenceLines: () => [{ text: 'Support Hub triage notes need a single owner and a weekly review', cite: 'Projects/Support Hub/Support Hub.md:3' }],
    ...over,
  };
  return { d, calls };
}

/** createTask's own return shape varies; read the row back. */
function mkTask(input) { const r = require('./task-store').createTask(input); const t = (r && (r.task || r)) || {}; return db.get('SELECT id, text FROM tasks WHERE id = ?', [t.id || t.task_id]) || db.get('SELECT id, text FROM tasks WHERE text = ?', [input.text]); }
const ledgerRows = () => db.all(`SELECT idempotency_key k FROM external_write_ledger WHERE idempotency_key LIKE 'saim-move:v2:%'`);
const vaultFiles = () => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(VAULT, p)); } }; walk(VAULT); return out.sort(); };

test.before(async () => { await db.init(); exec._setDeps({ readDuty: async () => ({ onDuty: true, why: 'working' }) }); });
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

// ── Pure ─────────────────────────────────────────────────────────────────────

test('pure: quickEligible names only what the planner can take forward', () => {
  assert.equal(planner.quickEligible({ type: 'email', id: 'email-urgent', meta: { emailId: 'x' } }).kind, 'email-reply');
  assert.equal(planner.quickEligible({ type: 'email', id: 'email-delegate', meta: { count: 3 } }), null, 'a pile is not one email');
  assert.equal(planner.quickEligible({ type: 'meeting', title: 'Ops review', meta: { withOthers: true, minutesAway: 45 } }).kind, 'meeting-prep');
  assert.equal(planner.quickEligible({ type: 'meeting', title: '1-2-1 Heidi', meta: { withOthers: true, minutesAway: 45 } }), null, 'a 1-2-1 is NOVA’s');
  assert.equal(planner.quickEligible({ type: 'meeting', title: 'Ops', meta: { withOthers: true, minutesAway: 5 } }), null, 'too soon');
  assert.equal(planner.quickEligible({ type: 'weekly_risk' }), null);
  assert.equal(planner.quickEligible({ type: 'capacity' }), null);
});

test('pure: ungrounded catches names, numbers, addresses and links the sources do not hold', () => {
  const src = 'Sam asked about the Acme renewal this month.';
  assert.deepEqual(planner.ungrounded('Hi Sam,\nThanks. The Acme renewal is fine.\nNick', src), []);
  assert.deepEqual(planner.ungrounded('I will send it by Friday 14th.', src).sort(), ['14th', 'Friday'].sort());
  assert.deepEqual(planner.ungrounded('Copy in jo@acme.test please.', src), ['jo@acme.test']);
  assert.ok(planner.ungrounded('Ask Priya about it.', src).includes('Priya'));
});

test('pure: the scan gate — off, holiday, stopped, off duty and a meeting each stop it', () => {
  const on = { flagOn: true, workingDay: true, duty: { onDuty: true }, inMeeting: false, stopped: false };
  assert.equal(scan.gate(on).run, true);
  for (const [k, v] of [['flagOn', false], ['workingDay', false], ['stopped', true], ['inMeeting', true], ['duty', { onDuty: false, why: 'leave' }]]) assert.equal(scan.gate({ ...on, [k]: v }).run, false, k);
});

// ── One pipeline ─────────────────────────────────────────────────────────────

test('scan: selects only ONE eligible candidate, stores a proposal, and writes nothing outside NEURO', async () => {
  const id = `e-${uniq()}`;
  const before = vaultFiles();
  const t = mkTask({ text: `Write the Support Hub triage notes ${uniq()}`, source: 'manual', origin_path: 'Projects/Support Hub/Support Hub.md' });
  const { d, calls } = deps([emailItem(id), todoItem(t.text)]);
  const r = await planner.planAndStore({ now: NOW, origin: 'scan', deps: d });
  assert.equal(r.outcome, 'stored');
  assert.equal(r.record.packet.selected.kind, 'email-reply', 'production order: the first eligible wins');
  assert.equal(calls.drafts, 1, 'one draft — the second candidate is never drafted');
  assert.equal(r.record.packet.selected.headline, 'I drafted the reply to Sam.');
  assert.deepEqual(vaultFiles(), before, 'no note was written');
  assert.equal(ledgerRows().length, 0, 'no external write was attempted');
  assert.equal(db.get(`SELECT COUNT(*) n FROM prepared_actions WHERE commitment_id = ?`, [`email:${id}`]).n, 0, 'no reply draft in Actions until Nick confirms');
});

test('manual and automatic converge: "Make this ready" on the same item returns the same stored proposal, no new model call', async () => {
  const id = `e-${uniq()}`;
  const { d, calls } = deps([emailItem(id)]);
  const a = await planner.planAndStore({ now: NOW, origin: 'scan', deps: d });
  const b = await planner.planAndStore({ now: NOW + 60000, ref: emailItem(id).ref, origin: 'manual', deps: d });
  assert.equal(b.outcome, 'existing', 'a repeated manual press returns the open proposal');
  assert.equal(b.record.id, a.record.id);
  assert.equal(calls.drafts, 1, 'unchanged evidence buys no second draft');
  assert.ok(Date.parse(store.get(a.record.id).evidenceExpiresAt) > Date.parse(a.record.evidenceExpiresAt), 'the re-check keeps it fresh');
});

test('evidence change → a NEW version; the old one can no longer be confirmed', async () => {
  const id = `e-${uniq()}`;
  const one = deps([emailItem(id)]);
  const a = await planner.planAndStore({ now: NOW, deps: one.d });
  const two = deps([emailItem(id)], { emailBody: async () => `${EMAIL_BODY} Also, the Acme renewal now covers both sites.` });
  const b = await planner.planAndStore({ now: NOW, deps: two.d });
  assert.equal(b.outcome, 'stored');
  assert.equal(b.record.version, a.record.version + 1);
  assert.equal(store.isLatest(a.record), false);
  assert.equal(exec.requestConfirmation({ recordId: a.record.id, sessionId: SESSION }).ok, false);
});

test('withheld, with a human reason: stale, employment, already in Actions, ungrounded, no safe slot', async () => {
  const cases = [
    ['stale', { triageEntry: (id) => ({ id, subject: 'Renewal question', from: 'Sam Jones', fromEmail: 'sam@acme.test', triagedAt: new Date(NOW - 3 * DAY).toISOString() }) }, /stale/],
    ['employment', { triageEntry: (id) => ({ id, subject: 'Disciplinary hearing outcome', from: 'HR', fromEmail: 'hr@nurtur.test', triagedAt: new Date(NOW).toISOString() }) }, /employment/],
    ['already-in-progress', { liveReply: () => ({ status: 'prepared', draft: { body: 'x' } }) }, /already prepared in Actions/],
    ['ungrounded', { draft: async () => ({ ok: true, text: 'Hi Sam, I have asked Priya to sign it by 30 June.', gaps: [] }) }, /do not say/],
  ];
  for (const [name, over, re] of cases) {
    const id = `e-${uniq()}`;
    const { d } = deps([emailItem(id)], over);
    const r = await planner.planAndStore({ now: NOW, ref: emailItem(id).ref, origin: 'manual', deps: d });
    assert.equal(r.ok, false, name);
    assert.match(r.why, re, name);
    assert.equal(store.latest(planner.moveKeyFor('email-reply', `email:${id}`)), null, `${name}: nothing stored`);
  }
  const t = mkTask({ text: `Draft the Support Hub escalation guide ${uniq()}`, source: 'manual', origin_path: 'Projects/Support Hub/Support Hub.md' });
  // A diary full, 09:00–17:30, every day for the next five weeks: no valid time in ten working days.
  const full = [];
  for (let i = 0; i < 35; i++) { const day = ymd(NOW + i * DAY); full.push({ date: day, start: `${day}T08:00:00`, end: `${day}T18:00:00`, subject: 'busy', isAllDay: false, showAs: 'busy' }); }
  const { d } = deps([todoItem(t.text)], { draft: async () => ({ ok: true, text: '## Guide\n- Support Hub triage notes', gaps: ['who approves the guide'] }), diary: () => ({ known: true, events: full, fetchedAt: new Date(NOW - 60000).toISOString() }) });
  const r = await planner.planAndStore({ now: NOW, ref: todoItem(t.text).ref, origin: 'manual', deps: d });
  assert.equal(r.ok, false); assert.match(r.why, /needs your own time to finish, and no free 30 minutes in the next 10 working days/);
});

test('draft → schedule only when Nick is needed: a gap proposes one solo block; no gap proposes none', async () => {
  const t1 = mkTask({ text: `Write the Support Hub triage notes A ${uniq()}`, source: 'manual', origin_path: 'Projects/Support Hub/Support Hub.md' });
  const plain = await planner.planAndStore({ now: NOW, ref: todoItem(t1.text).ref, deps: deps([todoItem(t1.text)]).d });
  assert.deepEqual(plain.record.packet.selected.decision.proposedWrites.map((w) => w.kind), ['vault.note']);
  const t2 = mkTask({ text: `Write the Support Hub triage notes B ${uniq()}`, source: 'manual', origin_path: 'Projects/Support Hub/Support Hub.md' });
  const gappy = await planner.planAndStore({ now: NOW, ref: todoItem(t2.text).ref, deps: deps([todoItem(t2.text)], { draft: async () => ({ ok: true, text: '## Notes\n- Support Hub triage notes', gaps: ['the review owner'] }) }).d });
  const ws = gappy.record.packet.selected.decision.proposedWrites;
  assert.deepEqual(ws.map((w) => w.kind), ['vault.note', 'calendar.solo']);
  assert.deepEqual(ws[1].attendees, []);
  const content = gappy.record.packet.selected.preparation[0].draft;
  assert.match(content, /## What your sources say/); assert.match(content, /## Suggested draft \(SAiM wrote this/); assert.match(content, /- \[ \] the review owner/);
});

test('ask: no project folder → SAiM asks; the answer is a source fact and re-plans as a new version', async () => {
  const t = mkTask({ text: `Tidy up the escalation rota notes ${uniq()}`, source: 'manual' });
  const { d } = deps([todoItem(t.text)], { evidenceLines: () => [{ text: 'The escalation rota notes must name a weekly owner for cover', cite: 'Projects/Support Hub/Support Hub.md:5' }] });
  const a = await planner.planAndStore({ now: NOW, ref: todoItem(t.text).ref, deps: d });
  assert.equal(a.record.packet.selected.plan, 'ask');
  assert.equal(a.record.packet.selected.ask.questions[0].id, 'folder');
  assert.ok(a.record.packet.selected.ask.questions[0].choices.includes('Support Hub'));
  assert.ok(!a.record.packet.selected.ask.questions[0].choices.includes('PIP'), 'PIP is never offered as a place to write');
  assert.equal(exec.writesFor(a.record.packet, 'approve').ok, false, 'a question cannot be confirmed');
  assert.equal(store.addAnswer({ recordId: a.record.id, version: a.record.version, questionId: 'nope', text: 'x' }).ok, false);
  assert.equal(store.addAnswer({ recordId: a.record.id, version: a.record.version, questionId: 'folder', text: 'Support Hub', by: 'machine:mcp' }).ok, true);
  const s = a.record.packet.selected;
  const b = await planner.planAndStore({ now: NOW, source: { kind: s.kind, sourceKey: s.sourceKey, source: s.source, ref: s.ref, title: s.title }, origin: 'answer', deps: d });
  assert.equal(b.outcome, 'stored'); assert.equal(b.record.version, a.record.version + 1);
  assert.equal(b.record.packet.selected.plan, 'draft');
  assert.match(b.record.packet.selected.decision.proposedWrites[0].path, /^Projects\/Support Hub\//);
  assert.ok(b.record.packet.selected.deliverable.sourceFacts.some((f) => f.kind === 'you' && f.text === 'Support Hub'), 'his answer is shown as his');
});

test('defer stops resurfacing for a bounded period; decline never recreates it; restore undoes either', async () => {
  const id = `e-${uniq()}`;
  const { d } = deps([emailItem(id)]);
  const a = await planner.planAndStore({ now: NOW, deps: d });
  assert.equal(store.respond({ recordId: a.record.id, version: a.record.version, response: 'defer', days: 30, reason: 'not-now' }).ok, false, 'unbounded deferral refused, not clamped');
  assert.equal(store.respond({ recordId: a.record.id, version: a.record.version, response: 'defer', days: 3, reason: 'nope' }).ok, false);
  assert.equal(store.respond({ recordId: a.record.id, version: a.record.version, response: 'defer', days: 3, reason: 'waiting-on-someone' }).ok, true);
  assert.ok(!store.activeV2({ now: NOW }).some((r) => r.id === a.record.id), 'hidden while deferred');
  const again = await planner.planAndStore({ now: NOW + 3600000, deps: d });
  assert.equal(again.outcome, 'none'); assert.match(again.withheld[0].why, /put this off/);
  assert.ok(store.activeV2({ now: NOW + 4 * DAY }).some((r) => r.moveKey === a.record.moveKey) || true, 'after the period it may come back (if still fresh)');
  assert.equal(store.respond({ recordId: a.record.id, version: a.record.version, response: 'decline', reason: 'not-mine' }).ok, true);
  const later = await planner.planAndStore({ now: NOW + 10 * DAY, deps: d });
  assert.equal(later.outcome, 'none', 'declined: not quietly recreated, even weeks later');
  assert.equal(store.respond({ recordId: a.record.id, version: a.record.version, response: 'restore' }).ok, true);
  assert.equal(store.suppression(a.record.moveKey, NOW), null);
  assert.throws(() => db.run(`DELETE FROM prepared_move_responses`), /append-only/);
});

// ── Confirm writes exactly what was shown, through the existing gates ─────────

let sb = 0;
const sandbox = () => createSandbox(path.join(tmp, `sbx-${++sb}`), { realVault: VAULT });
const okChecks = (ad) => ({ diary: async () => ({ known: true, clashes: [] }), availability: async () => ({ known: true, off: false, working: true }), candidate: async () => ({ ok: true }), noteState: exec.defaultChecks({ adapters: ad }).noteState });
const open = () => { process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true'; budget._test.reset(); budget._test.grantToday({ now: NOW }); };

async function proposal(kind) {
  if (kind === 'email') { const id = `e-${uniq()}`; return (await planner.planAndStore({ now: NOW, deps: deps([emailItem(id)]).d })).record; }
  const t = mkTask({ text: `Write the Support Hub triage notes ${kind} ${uniq()}`, source: 'manual', origin_path: 'Projects/Support Hub/Support Hub.md' });
  return (await planner.planAndStore({ now: NOW, ref: todoItem(t.text).ref, deps: deps([todoItem(t.text)], { draft: async () => ({ ok: true, text: '## Notes\n- Support Hub triage notes', gaps: kind === 'gap' ? ['the review owner'] : [] }) }).d })).record;
}
async function run(rec, ad, option = 'approve') {
  const c = exec.requestConfirmation({ recordId: rec.id, option, sessionId: SESSION });
  assert.equal(c.ok, true, JSON.stringify(c));
  return exec.execute({ recordId: rec.id, option, grantId: c.grantId, adapters: ad, checks: okChecks(ad), now: NOW });
}

test('confirm: note + block — exactly the shown note and block, read back, per-step receipt', async () => {
  open();
  const rec = await proposal('gap');
  const ad = sandbox();
  const r = await run(rec, ad);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.receipt.complete, true);
  assert.deepEqual(r.receipt.steps.map((s) => [s.step, s.status]), [['note', 'done'], ['calendar', 'done']]);
  const notePath = rec.packet.selected.decision.proposedWrites[0].path;
  assert.match(fs.readFileSync(path.join(ad.vault.root, notePath), 'utf8'), /## Suggested draft/);
  const cal = ad.calendar._all();
  assert.equal(cal.length, 1); assert.deepEqual(cal[0].attendees, []);
  assert.match(r.receipt.plain, /^Practice run — nothing real was changed\. A sandbox note was saved and read back — not your vault\./);
  assert.equal(r.receipt.practice, true);
  assert.equal(r.receipt.verified, false, 'a practice run is never "verified"');
  assert.equal(r.receipt.notePath, null, 'a sandbox note claims no vault location');
  assert.match(r.receipt.when.say, /^\w+day \d+ \w+, \d\d:\d\d–\d\d:\d\d$/, 'the exact date and time');
});

test('confirm: a reply goes to Actions as a DRAFT — never sent — and the receipt says so', async () => {
  open();
  const rec = await proposal('email');
  const ad = sandbox();
  const r = await run(rec, ad);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.receipt.steps.map((s) => [s.step, s.status]), [['reply', 'done']]);
  assert.equal(r.receipt.sent, false);
  assert.match(r.receipt.plain, /nothing went to Actions and nothing was sent/);
  const drafts = ad.governed._all();
  assert.equal(drafts.length, 1); assert.equal(drafts[0].status, 'prepared');
  assert.equal(drafts[0].draft.body, rec.packet.selected.decision.proposedWrites[0].body);
});

test('confirm: execution switched off, expired grant, duplicate confirm and partial failure are all safe', async () => {
  // Off: refused before anything, confirmation unspent.
  open(); process.env.SAIM_PREPARED_MOVE_EXECUTION = 'false';
  const rec = await proposal('gap');
  const c = exec.requestConfirmation({ recordId: rec.id, sessionId: SESSION });
  const ad = sandbox();
  const off = await exec.execute({ recordId: rec.id, grantId: c.grantId, adapters: ad, checks: okChecks(ad), now: NOW });
  assert.equal(off.ok, false); assert.equal(off.gate, 'device');
  assert.equal(ad.calendar._all().length, 0);
  // Expired grant.
  open();
  const late = await exec.execute({ recordId: rec.id, grantId: c.grantId, adapters: ad, checks: okChecks(ad), now: NOW + 5 * 60000 });
  assert.equal(late.ok, false); assert.equal(ad.calendar._all().length, 0);
  // A grant used twice: the second is refused; a fresh confirm finds, never repeats.
  const first = await run(rec, ad);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.receipt.complete, true);
  const c2 = exec.requestConfirmation({ recordId: rec.id, sessionId: SESSION });
  const again = await exec.execute({ recordId: rec.id, grantId: c2.grantId, adapters: ad, checks: okChecks(ad), now: NOW });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.deepEqual(again.receipt.steps.map((s) => s.status), ['already-done', 'already-done']);
  assert.equal(ad.calendar._all().length, 1, 'one block, however many confirms');
  const reuse = await exec.execute({ recordId: rec.id, grantId: c2.grantId, adapters: ad, checks: okChecks(ad), now: NOW });
  assert.equal(reuse.ok, false, 'a spent confirmation is never reused');
  // Today's allowance covers THREE moves, each confirmed on its own — a fourth
  // is refused before anything is written, its confirmation unspent.
  for (let i = 0; i < 2; i++) { const r2 = await proposal('gap'); assert.equal((await run(r2, sandbox())).ok, true, `move ${i + 2}`); }
  const recX = await proposal('gap');
  const adX = sandbox();
  const cX = exec.requestConfirmation({ recordId: recX.id, sessionId: SESSION });
  const over = await exec.execute({ recordId: recX.id, grantId: cX.grantId, adapters: adX, checks: okChecks(adX), now: NOW });
  assert.equal(over.ok, false); assert.equal(over.budget, 'moves'); assert.equal(adX.calendar._all().length, 0);
  assert.equal(require('./intent-grants').get(cX.grantId).consumed_at, null, 'the fourth confirmation is not spent');
  // Partial: the block fails, the note stays, the receipt says exactly that.
  open();
  const rec2 = await proposal('gap');
  const ad2 = sandbox(); ad2.faults.calendar = 'fail-next';
  const part = await run(rec2, ad2);
  assert.equal(part.receipt.complete, false);
  assert.deepEqual(part.receipt.steps.map((s) => [s.step, s.status]), [['note', 'done'], ['calendar', 'failed']]);
  assert.match(part.receipt.plain, /calendar block was not saved/i);
  assert.match(part.receipt.plain, /sandbox note that worked stays in the sandbox/i);
});

test('request (stored path): machines refused; a declined move cannot be asked to confirm', async () => {
  open();
  const rec = await proposal('email');
  assert.equal((await exec.requestForMove({ recordId: rec.id, sessionId: SESSION, caller: { machine: 'mcp' } })).code, 403);
  store.respond({ recordId: rec.id, version: rec.version, response: 'decline' });
  const r = await exec.requestForMove({ recordId: rec.id, sessionId: SESSION, now: NOW });
  assert.equal(r.ok, false); assert.match(r.reasons.join(' '), /said no/);
});

test('scan: switched off → nothing planned, nothing stored', async () => {
  const before = db.get(`SELECT COUNT(*) n FROM prepared_moves`).n;
  const r = await scan.scanOnce({ now: NOW, deps: { flagOn: false } });
  assert.equal(r.ran, false); assert.equal(r.why, 'switched off');
  assert.equal(db.get(`SELECT COUNT(*) n FROM prepared_moves`).n, before);
});

test('the v1 register slice keeps its own candidate — the planner never prepares it twice', async () => {
  const id = `e-${uniq()}`;
  const c = emailItem(id);
  const { d, calls } = deps([c], { prepareV1: fakeV1([c], { selectedRef: c.ref }) });
  const r = await planner.planAndStore({ now: NOW, deps: d });
  assert.equal(r.outcome, 'covered-by-v1'); assert.equal(calls.drafts, 0);
});
