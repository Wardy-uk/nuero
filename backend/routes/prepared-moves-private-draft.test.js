'use strict';

/**
 * The private working draft (25 Oct 2026) — the repair of the live dead end —
 * and its short in-place INTERVIEW and destination rule (26 Oct 2026).
 *
 * Live: Nick pressed "Tell SAiM who it is owed to" on "Define achievable
 * targets for hybrid/WFH incentive; agree plan on 2026-09-02", answered "Me",
 * the answer was saved, and the re-plan refused because the source meeting
 * note discusses named colleagues' employment — a dead end, with the saved
 * "Me" trapping the promise.
 *
 * Over real HTTP (real api-auth + authority guard), the real store, planner,
 * executor and a temp vault holding a source note shaped like the live one:
 *   - this promise is offered and prepared as a PRIVATE draft despite the
 *     employment-sensitive source; "who is it owed to?" is never asked first;
 *   - the draft is labelled private and non-decisive, quotes only neutral
 *     source lines, and invents no target, number, person or policy;
 *   - nothing outward or employment-shaped is created (no prepared action,
 *     no ledger row, no grant, People notes untouched, no file written);
 *   - a missing fact produces one precise question;
 *   - the earlier "Me" answer can be removed safely (append-only);
 *   - the capacity card's open is not a no-op;
 *   - MCP can read and answer, never confirm;
 *   - the private block stays behind the allowance and the per-move confirmation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-private-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
for (const k of ['HA_TOKEN', 'HA_URL', 'SAIM_PREPARED_MOVE_EXECUTION']) delete process.env[k];
for (const d of ['People', 'Meetings/2026/09', 'Areas', 'Projects/Support Hub']) fs.mkdirSync(path.join(VAULT, d), { recursive: true });
const person = (name) => fs.writeFileSync(path.join(VAULT, 'People', `${name}.md`), `---\ntype: person\nemail: ${name.split(' ')[0].toLowerCase()}@nurtur.test\n---\n# ${name}\n`);
person('Stephen Kerr'); person('Heidi Ford'); person('Ricky Bostock');
const peopleHash = () => fs.readdirSync(path.join(VAULT, 'People')).sort().map((f) => crypto.createHash('sha1').update(fs.readFileSync(path.join(VAULT, 'People', f))).digest('hex')).join(',');

const SOURCE = 'Meetings/2026/09/2026-09-01 – Weekly Meeting Ticket Health, AI Integration, and Team Performance.md';
const TEXT = 'Define achievable targets for hybrid/WFH incentive; agree plan on 2026-09-02';
const NEUTRAL = '- Weekly meeting notes.\n\n### Return-to-Office Policy and Incentives\n- Consider hybrid model (e.g., two days WFH) as incentive tied to achievable targets, leveraging AI efficiency gains; stagger WFH to maintain coverage.\n\n## Actions\n- [ ] Define achievable targets for hybrid/WFH incentive; agree plan on 2026-09-02.\n';
// The two lines that make the note an employee-cases note (named person + employment context).
const PEOPLE_LINES = '\n### Team Performance\n- Stephen Kerr’s performance on hybrid WFH targets has dipped this month.\n- Heidi Ford is on leave next week; her WFH incentive is on hold.\n';
const writeSource = (sensitive) => fs.writeFileSync(path.join(VAULT, SOURCE), `---\ntype: meeting\n---\n# Weekly Meeting\n${NEUTRAL}${sensitive ? PEOPLE_LINES : ''}`);

const db = require('../db/database');
const planner = require('../services/prepared-move-planner');
const store = require('../services/prepared-move-store');
const exec = require('../services/prepared-move-exec');
const owed = require('../services/promise-owed');
const budget = require('../services/authority-budget');
const brief = require('../services/private-brief');

const NOW = Date.now();
const promises = new Map();
let taskId; let areaTaskId;
const promiseOf = (key, text, task) => ({ key, text, open: true, taskIds: [task], leadTaskId: task, owedTo: { people: [], ambiguous: [], fromNote: null, resolved: null }, sensitivity: { sensitive: false }, source: { path: SOURCE, title: 'Weekly Meeting' } });
let modelCalls = 0;
Object.assign(planner.DEFAULT_DEPS, {
  promise: (key) => promises.get(key) || null,
  promiseDelivered: () => false,
  diary: () => ({ known: true, events: [], fetchedAt: new Date(NOW - 60000).toISOString() }),
  holidays: () => new Set(),
  leaveState: () => 'working',
  evidenceLines: () => [{ text: 'Hybrid incentive targets need agreeing', cite: `${SOURCE}:8` }],
  draft: async () => { modelCalls += 1; return { ok: true, text: '## Draft\n- Hybrid incentive targets need agreeing', gaps: ['the numbers'] }; },
});
exec._setDeps({ readDuty: async () => ({ onDuty: true, why: 'working' }) });
require('../services/prepared-move').readDuty = async () => ({ onDuty: true, why: 'working' });

let server; let base;
test.before(async () => {
  await db.init();
  const ts = require('../services/task-store');
  ts.createTask({ text: TEXT, source: 'meeting-promotion', origin_path: SOURCE });
  taskId = db.get('SELECT id FROM tasks WHERE text = ?', [TEXT]).id;
  promises.set('promise:322', promiseOf('promise:322', TEXT, taskId));
  const AT = 'Agree the hybrid WFH incentive targets with the leads';
  fs.writeFileSync(path.join(VAULT, 'Areas', 'Team notes.md'), `# Team notes\n- Agree the hybrid WFH incentive targets with the leads.\n${PEOPLE_LINES}`);
  ts.createTask({ text: AT, source: 'manual', origin_path: 'Areas/Team notes.md' });
  areaTaskId = db.get('SELECT id FROM tasks WHERE text = ?', [AT]).id;
  promises.set('promise:500', promiseOf('promise:500', AT, areaTaskId));
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require('../services/api-auth'));
  app.use('/api', require('../services/authority-guard').guard);
  app.use('/api/prepared-moves', require('./prepared-moves'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

async function call(p, { method = 'GET', body = null, token = false } = {}) {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-NEURO-API-TOKEN': 'tok-5678' } : { 'X-NEURO-PIN': 'pin-1234' }) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
const count = (sql) => { try { return db.get(sql).n; } catch { return 0; } };
const outward = () => ({
  actions: count('SELECT COUNT(*) n FROM prepared_actions'),
  ledger: count('SELECT COUNT(*) n FROM external_write_ledger'),
  grants: count('SELECT COUNT(*) n FROM human_action_intents'),
  people: peopleHash(),
  files: fs.readdirSync(path.join(VAULT, 'Meetings/2026/09')).sort().join('|'),
  projects: fs.readdirSync(path.join(VAULT, 'Projects')).sort().join('|'),
});
const moveKey = () => planner.moveKeyFor('project-note', `task:${taskId}`);
const itemFor = (key, tid, prep = { state: 'waiting-for-Nick', missing: 'owed-to' }, extra = {}) => ({ key, title: TEXT, taskIds: [tid], leadTaskId: tid, preparation: prep, ...extra });

// ── 1. Reproduce the live trap, then repair it ───────────────────────────────

test('the live trap: an owed question answered "Me" — with the source now employment-sensitive, the card offers a PRIVATE draft, not the stale question', async () => {
  // As it was before: an ordinary source, so the owed question is asked and "Me" saved.
  writeSource(false);
  const p = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:322' } });
  assert.equal(p.body.move.ask.questions[0].id, 'owed', 'the old flow asked who it is owed to');
  const a = await call('/api/prepared-moves/answer', { method: 'POST', body: { recordId: p.body.move.recordId, version: p.body.move.recordVersion, questionId: 'owed', text: 'Me' } });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  // "Me" now means it is his own — never a group called "Me".
  const st = owed.stateFor({ key: 'promise:322', owedTo: { resolved: null } }, { roster: { full: ['Stephen Kerr'] } });
  assert.equal(st.owedTo.self, true); assert.equal(st.owedTo.group, null);
  // The live state: the meeting note DOES discuss colleagues' employment.
  writeSource(true);
  const pm = require('../services/promise-moves');
  const m = pm.moveFor(itemFor('promise:322', taskId, { state: 'needs-a-block' }, { owedToSaidBy: { by: 'nick', at: 'x', text: 'Me' } }));
  assert.equal(m.state, 'offer', 'the stale owed question is not shown any more');
  assert.equal(m.control, 'Prepare a private working draft');
  assert.equal(m.say, 'SAiM will prepare a private draft for you. It will not make an employment decision, contact anyone, or send anything.');
  assert.equal(m.question, null);
  assert.equal(m.privateDraft.cannot, 'SAiM can’t carry out an employment action for this.');
  assert.equal(m.privateDraft.can, 'SAiM can prepare a private draft for you.');
  assert.equal(m.owedAnswer.ignored, true); assert.equal(m.owedAnswer.control, 'Remove that answer');
  // Keep my word's thread: not held, no delivery note, no "owed to Me", the two sentences distinguished.
  const kmw = require('../services/keep-my-word');
  const t = kmw.compose({ workbench: { state: 'ok', items: [{ ...itemFor('promise:322', taskId, { state: 'needs-a-block', why: 'x' }), owedTo: 'Me', due: { date: '2026-10-16', say: 'overdue', endsAt: '' }, evidence: [], because: [] }] }, moves: { 'promise:322': m } }).thread;
  assert.equal(t.held, null); assert.equal(t.draft, null); assert.equal(t.owedTo, null);
  assert.equal(t.preparation.label, 'Private draft');
  assert.equal(t.preparation.why, 'SAiM can’t carry out an employment action for this. SAiM can prepare a private draft for you.');
  assert.equal(t.move.control, 'Prepare a private working draft');
});


let recordId;
const latest = () => store.latest(moveKey());
const ask = async (rec, questionId, text, opts = {}) => call('/api/prepared-moves/answer', { method: 'POST', token: opts.token, body: { recordId: rec.id, version: rec.version, questionId, ...(text === null ? { park: true } : { text }) } });
const PROJ = (f) => path.join(VAULT, 'Projects', f);

test('pressing prepares the PRIVATE draft straight away — no recipient question, no model call, nothing outward — and NOT beside the meeting', async () => {
  const before = outward(); const calls0 = modelCalls;
  const r = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:322' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const mv = r.body.move;
  assert.equal(mv.plan, 'draft', 'not the stale owed question');
  assert.equal(mv.prepared.headline, 'I prepared a private draft for you — no decision made, nothing sent.');
  assert.equal(mv.privateDraft.label, 'Private draft for Nick — no decision made, nothing sent.');
  assert.equal(modelCalls, calls0, 'composed, never generated');
  assert.deepEqual(outward(), before, 'no action, ledger row, grant, People change or file');
  recordId = mv.recordId;
  const s = latest().packet.selected;
  assert.equal(s.screens.employment.sensitive, true, 'the sensitivity is still stated, not hidden');
  assert.equal(s.screens.employment.mode, 'private-draft');
  // Meeting-only evidence: the meeting is evidence, not a destination.
  const note = s.decision.proposedWrites.find((w) => w.kind === 'vault.note').path;
  assert.equal(note, `Projects/Working/${planner.safeTitle(TEXT)} (private draft).md`);
  assert.doesNotMatch(note, /^Meetings\//);
  assert.deepEqual(s.deliverable.destination, { folder: 'Projects/Working', project: null, basis: 'none', candidates: [] });
  assert.ok(s.observed.some((o) => /No single project is evidenced/.test(o.fact)));
  assert.equal(fs.existsSync(PROJ('Working')), false, 'nothing created by preparing');
  assert.deepEqual(s.authority.mustNot, planner.MUST_NOT_PRIVATE);
});

test('the initial draft asks ONE answerable question, with progress — and cannot be saved as finished yet', () => {
  const rec = latest(); const s = rec.packet.selected;
  assert.equal(s.interview.total, 4);
  assert.equal(s.interview.next.id, 'achievable');
  assert.equal(s.interview.next.question, 'What does ‘achievable’ mean here, and how will you measure it?');
  assert.equal(s.interview.open, 4);
  assert.deepEqual(Object.keys(rec.options), ['unfinished'], 'the only confirmable choice is saving it unfinished');
  const approve = exec.writesFor(rec.packet, 'approve');
  assert.equal(approve.ok, false); assert.match(approve.reasons.join(' '), /4 questions are still open/);
  const unf = exec.writesFor(rec.packet, 'unfinished');
  assert.equal(unf.ok, true, JSON.stringify(unf));
  assert.deepEqual(unf.steps.map((x) => x.step), ['note'], 'no block');
  assert.equal(unf.confirmation.question, 'Save this unfinished draft? No time will be booked.');
  assert.ok(unf.confirmation.writes.some((w) => /^Save your unfinished private draft as a new note — Working drafts: Projects\/Working\//.test(w)));
  assert.ok(unf.confirmation.writes.some((w) => /^No time is booked\. 4 questions are still open/.test(w)));
});

test('the draft is private and non-decisive: labelled, neutral source lines only, nothing invented', () => {
  const text = latest().packet.selected.deliverable.suggested.text;
  assert.ok(text.includes('Private draft for Nick — no decision made, nothing sent.'));
  assert.match(text, /SAiM has not set any targets, judged anyone, or contacted anyone/);
  assert.ok(text.includes(`“${TEXT}”`));
  assert.ok(text.includes('Consider hybrid model (e.g., two days WFH) as incentive tied to achievable targets'));
  assert.doesNotMatch(text, /Stephen|Heidi|Kerr|Ford|dipped|on leave|on hold/i);
  assert.match(text, /2 lines naming colleagues or their circumstances were left out/);
  assert.match(text, /## Still to decide/);
  assert.doesNotMatch(text, /## You said/, 'nothing said yet');
  const content = text.replace(/_\([^)]*\)_/g, '');
  const sources = `${TEXT}\n${NEUTRAL}\n${SOURCE}`;
  for (const n of content.match(/\d+/g) || []) assert.ok(sources.includes(n), `“${n}” is not in the sources`);
  assert.doesNotMatch(text, /- \[ \]/);
});

test('a repeated press returns the same private draft — no duplicate', async () => {
  const before = db.get('SELECT COUNT(*) n FROM prepared_moves').n;
  const r = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:322' } });
  assert.equal(r.body.outcome, 'existing'); assert.equal(r.body.move.recordId, recordId);
  assert.equal(db.get('SELECT COUNT(*) n FROM prepared_moves').n, before);
});

test('an answer is attached to THIS move only, appears under "You said", makes a fresh version, and the next question is asked', async () => {
  const before = outward();
  const v1 = latest();
  const r = await ask(v1, 'achievable', 'Two days WFH for anyone who hits 90% of their FRT target for the month');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const v2 = latest();
  assert.ok(v2.version > v1.version, 'a fresh version');
  assert.equal(r.body.move.recordId, v2.id);
  const row = db.get('SELECT move_key, record_id, version, by FROM prepared_move_answers WHERE question_id = ? ORDER BY id DESC LIMIT 1', ['achievable']);
  assert.deepEqual(row, { move_key: moveKey(), record_id: v1.id, version: v1.version, by: 'nick' }, 'against the exact move and version it answered, by Nick');
  const text = v2.packet.selected.deliverable.suggested.text;
  assert.match(text, /## You said[\s\S]*_Your own words — not SAiM’s conclusions\._[\s\S]*\*\*What “achievable” means, and how it is measured:\*\* Two days WFH for anyone who hits 90% of their FRT target for the month/);
  assert.equal(v2.packet.selected.interview.next.id, 'incentive', 'the next question');
  assert.equal(v2.packet.selected.interview.done, 1);
  assert.deepEqual(outward(), before, 'still nothing written, sent or booked');
  // Nick's own words may say anything — they never turn his draft into a routing-only matter.
  assert.equal((await planner.recheck(v2.packet)).ok, true);
});

test('park is explicit, auditable and visible in the draft — and the next question follows', async () => {
  const v = latest();
  const bad = await call('/api/prepared-moves/answer', { method: 'POST', body: { recordId: v.id, version: v.version, questionId: 'incentive', park: true, text: 'x' } });
  assert.equal(bad.status, 400, 'park OR answer, never both');
  const r = await ask(v, 'incentive', null);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = db.get('SELECT question_id q, text, by, record_id FROM prepared_move_answers ORDER BY id DESC LIMIT 1');
  assert.deepEqual(row, { q: 'park', text: 'incentive', by: 'nick', record_id: v.id });
  const s = latest().packet.selected;
  assert.match(s.deliverable.suggested.text, /## Parked — still unresolved\n\n- What the incentive is, and what earns it — you parked this; it is not decided\./);
  assert.equal(s.interview.questions.find((q) => q.id === 'incentive').state, 'parked');
  assert.equal(s.interview.next.id, 'applies');
  assert.deepEqual(Object.keys(latest().options), ['unfinished'], 'still not saveable as finished');
});

test('save-and-protect becomes available only when every question is answered or parked', async () => {
  // Nick's own words may mention HR or a pay review — they are his, in his own note, and never make his draft routing-only.
  let r = await ask(latest(), 'applies', 'Everyone on the 1st and 2nd line rota; I will ask the team at the next standup and check the pay review timing with HR');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!('approve' in latest().options), 'one still open');
  r = await ask(latest(), 'agree', null);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rec = latest(); const s = rec.packet.selected;
  assert.equal(s.interview.open, 0); assert.equal(s.interview.next, null);
  assert.deepEqual(Object.keys(rec.options), ['approve'], 'save and protect the time — and no unfinished option any more');
  const w = exec.writesFor(rec.packet, 'approve');
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.deepEqual(w.steps.map((x) => x.step).sort(), ['calendar', 'note']);
  assert.ok(w.confirmation.writes.some((x) => /^Save your private draft as a new note — Working drafts: /.test(x)));
  assert.match(s.deliverable.suggested.text, /check the pay review timing with HR/, 'his words, verbatim, under You said');
  assert.equal((await planner.recheck(rec.packet)).ok, true);
  assert.equal(exec.writesFor(rec.packet, 'unfinished').ok, false);
  assert.match(s.deliverable.suggested.text, /## Parked — still unresolved[\s\S]*incentive[\s\S]*Who you agree the plan with/);
  assert.doesNotMatch(s.deliverable.suggested.text, /## Still to decide/);
});

test('the earlier "Me" answer can be removed — append-only, and the promise is not left in a wrong state', async () => {
  assert.equal(owed.answerFor('promise:322').text, 'Me');
  const r = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:322', withdraw: 'owed' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.withdrawn, { questionId: 'owed', text: 'Me' });
  assert.equal(owed.answerFor('promise:322'), null);
  const rows = db.all('SELECT question_id q, text FROM prepared_move_answers WHERE move_key = ? AND question_id IN (\'owed\', \'withdraw\') ORDER BY id', [moveKey()]);
  assert.deepEqual(rows.map((x) => [x.q, x.text]), [['owed', 'Me'], ['withdraw', 'owed']]);
  assert.equal(r.body.move.plan, 'draft');
  assert.equal((await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:322', withdraw: 'folder' } })).status, 400);
  assert.equal(require('../services/promise-moves').moveFor(itemFor('promise:322', taskId)).owedAnswer, null);
});

// ── Where a private draft is kept ────────────────────────────────────────────

test('destination: exactly one evidenced project (task origin, or Nick’s explicit link) → that project; none or a conflict → Projects/Working', () => {
  const D = (task, links = []) => planner.destinationFor(task, { projectLinks: () => links });
  assert.deepEqual(D({ id: 1, origin_path: 'Projects/Support Hub/Hub.md' }), { folder: 'Projects/Support Hub', project: 'Support Hub', basis: 'task-origin', candidates: ['Support Hub'] });
  assert.deepEqual(D({ id: 1, origin_path: SOURCE }, ['Projects/Support Hub']), { folder: 'Projects/Support Hub', project: 'Support Hub', basis: 'project-link', candidates: ['Support Hub'] });
  assert.deepEqual(D({ id: 1, origin_path: 'Projects/Support Hub/x.md' }, ['Projects/Support Hub']).project, 'Support Hub', 'two kinds of evidence, one project');
  assert.equal(D({ id: 1, origin_path: 'Projects/Support Hub/x.md' }, ['Projects/TOM']).project, 'Support Hub', 'a link to a project whose folder does not exist is not evidence');
  fs.mkdirSync(PROJ('TOM'), { recursive: true });
  assert.equal(D({ id: 1, origin_path: 'Projects/Support Hub/x.md' }, ['Projects/TOM']).basis, 'conflict', 'two projects → not demonstrable');
  assert.equal(D({ id: 1, origin_path: 'Projects/Support Hub/x.md' }, ['Projects/TOM']).folder, 'Projects/Working');
  assert.deepEqual(D({ id: 1, origin_path: SOURCE }), { folder: 'Projects/Working', project: null, basis: 'none', candidates: [] }, 'meeting-only evidence → working drafts');
  assert.equal(D({ id: 1, origin_path: 'Projects/Archive/x.md' }).folder, 'Projects/Working', 'Archive is never a home');
  assert.equal(D({ id: 1, origin_path: 'Projects/Made Up/x.md' }).folder, 'Projects/Working', 'a folder that does not exist is never created or chosen');
});

test('a uniquely evidenced project: the draft is kept in THAT project, and the confirmation says so', async () => {
  const T = 'Agree the hybrid WFH incentive targets for the Support Hub rota';
  fs.writeFileSync(path.join(PROJ('Support Hub'), 'Rota.md'), `# Rota\n- ${T}.\n${PEOPLE_LINES}`);
  require('../services/task-store').createTask({ text: T, source: 'manual', origin_path: 'Projects/Support Hub/Rota.md' });
  const tid = db.get('SELECT id FROM tasks WHERE text = ?', [T]).id;
  promises.set('promise:600', promiseOf('promise:600', T, tid));
  const r = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:600' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rec = store.latest(planner.moveKeyFor('project-note', `task:${tid}`));
  assert.equal(rec.packet.selected.decision.proposedWrites.find((w) => w.kind === 'vault.note').path, `Projects/Support Hub/${planner.safeTitle(T)} (private draft).md`);
  const w = exec.writesFor(rec.packet, 'unfinished');
  assert.ok(w.confirmation.writes.some((x) => x.includes('— Linked to project: Support Hub: Projects/Support Hub/')), JSON.stringify(w.confirmation.writes));
  assert.deepEqual(w.destination, { folder: 'Projects/Support Hub', project: 'Support Hub', say: 'Linked to project: Support Hub' });
});

test('missing facts produce one precise question: nothing quotable → what the draft should help decide', async () => {
  const T = 'Settle the hybrid WFH incentive approach';
  fs.writeFileSync(path.join(VAULT, 'Areas', 'Quiet.md'), `# Quiet\n- Stephen Kerr to settle the hybrid WFH incentive approach.\n${PEOPLE_LINES}`);
  require('../services/task-store').createTask({ text: T, source: 'manual', origin_path: 'Areas/Quiet.md' });
  const tid = db.get('SELECT id FROM tasks WHERE text = ?', [T]).id;
  promises.set('promise:650', promiseOf('promise:650', T, tid));
  const r = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:650' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.move.plan, 'ask');
  assert.deepEqual(r.body.move.ask.questions.map((q) => q.id), ['purpose'], 'one question, and never "where" or "who is it owed to"');
  const a = await call('/api/prepared-moves/answer', { method: 'POST', body: { recordId: r.body.move.recordId, version: r.body.move.recordVersion, questionId: 'purpose', text: 'Whether to run it as a three-month trial' } });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.move.plan, 'draft');
  assert.ok(a.body.move.interview && a.body.move.interview.next, 'then the interview');
});

// ── Capacity card + MCP ──────────────────────────────────────────────────────

test('the capacity card opens the draft at its next question; a card with no promise is untouched', async () => {
  // A fresh promise still mid-interview.
  const rec = store.latest(planner.moveKeyFor('project-note', `task:${db.get("SELECT id FROM tasks WHERE text LIKE 'Agree the hybrid WFH incentive targets for the Support Hub%'").id}`));
  const tid = rec.packet.selected.source.taskId;
  const m = require('../services/promise-moves').moveFor(itemFor('promise:600', tid, { state: 'needs-a-block' }));
  assert.equal(m.state, 'interview');
  assert.equal(m.question.id, 'achievable'); assert.equal(m.question.canPark, true);
  assert.match(m.say, /^Decision 1 of 4: What does ‘achievable’ mean here/);
  assert.equal(m.destinationSay, 'Not saved yet. When you choose to save it, this draft will go in the Support Hub project.');
  const cr = require('../services/canonical-read');
  const card = { kind: 'item', type: 'capacity', actionHint: 'Open State of Play', meta: { taskId: tid } };
  const other = { kind: 'item', type: 'capacity', actionHint: 'Open State of Play', meta: { taskId: 99999 } };
  cr.linkPromiseOpens([card, other], { 'promise:600': m });
  assert.equal(card.actionHint, 'Answer SAiM’s question');
  assert.equal(card.open.show, 'promise', 'mid-interview the question is on the promise card'); assert.equal(card.open.recordId, rec.id);
  assert.equal(other.actionHint, 'Open State of Play'); assert.equal(other.open, undefined);
});

test('the phone shell opens THAT draft, and draws no button that would do nothing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'saim', 'app', 'src', 'views', 'Surface.jsx'), 'utf8');
  // Since 22 Oct 2026 a draft opens on its exact entry in Drafts (a private draft's opens stay on its card).
  assert.match(src, /onNavigate\?\.\('drafts', \{ context: \{ recordId: o\.recordId \} \}\)/);
  assert.match(src, /canOpen=\{canOpen\}/);
  const as = fs.readFileSync(path.join(__dirname, '..', '..', 'saim', 'shared-ui', 'AttentionSurface.jsx'), 'utf8');
  assert.equal((as.match(/\(!canOpen \|\| canOpen\(/g) || []).length, 2);
});

test('MCP (API token): reads the exact next question, answers and parks it with a machine origin; cannot confirm or execute', async () => {
  const wb = require('../services/promise-workbench');
  const realRead = wb.read;
  const T3 = `Review the hybrid WFH incentive targets ${Date.now()}`;
  fs.writeFileSync(path.join(VAULT, 'Areas', 'Leads.md'), `# Leads\n- Review the hybrid WFH incentive targets.\n${PEOPLE_LINES}`);
  require('../services/task-store').createTask({ text: T3, source: 'manual', origin_path: 'Areas/Leads.md' });
  const t3 = db.get('SELECT id FROM tasks WHERE text = ?', [T3]).id;
  promises.set('promise:777', promiseOf('promise:777', T3, t3));
  wb.read = () => ({ state: 'at-risk', why: null, items: [{ key: 'promise:777', title: T3, taskIds: [t3], leadTaskId: t3, owedTo: null, due: '2026-10-30', preparation: { state: 'waiting-for-Nick', missing: 'owed-to' } }] });
  try {
    const l = await call('/api/prepared-moves/promises', { token: true });
    assert.equal(l.status, 200, JSON.stringify(l.body));
    assert.equal(l.body.items[0].move.control, 'Prepare a private working draft');
    assert.deepEqual(l.body.items[0].missing, []);
    const p = await call('/api/prepared-moves/prepare', { method: 'POST', token: true, body: { ref: l.body.items[0].ref } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const read = async () => (await call('/api/prepared-moves/promises', { token: true })).body.items[0];
    let it = await read();
    assert.equal(it.move.state, 'interview');
    assert.deepEqual(it.missing.map((m) => [m.questionId, m.canPark]), [['achievable', true]]);
    assert.equal(it.missing[0].question, 'What does ‘achievable’ mean here, and how will you measure it?');
    const a = await call('/api/prepared-moves/answer', { method: 'POST', token: true, body: { recordId: it.missing[0].recordId, version: it.missing[0].version, questionId: 'achievable', text: 'Measured monthly against FRT' } });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    it = await read();
    assert.equal(it.missing[0].questionId, 'incentive');
    const pk = await call('/api/prepared-moves/answer', { method: 'POST', token: true, body: { recordId: it.missing[0].recordId, version: it.missing[0].version, questionId: 'incentive', park: true } });
    assert.equal(pk.status, 200, JSON.stringify(pk.body));
    const rows = db.all('SELECT question_id q, by FROM prepared_move_answers WHERE move_key = ? ORDER BY id', [planner.moveKeyFor('project-note', `task:${t3}`)]);
    assert.ok(rows.length >= 2 && rows.every((x) => /^machine:/.test(x.by)), JSON.stringify(rows));
    const rec = store.latest(planner.moveKeyFor('project-note', `task:${t3}`));
    assert.equal((await call('/api/prepared-moves/request', { method: 'POST', token: true, body: { option: 'unfinished', surface: 'neuro-web', sessionId: 'session_mcp_00002', recordId: rec.id } })).status, 403);
    assert.equal((await call('/api/prepared-moves/confirm', { method: 'POST', token: true, body: { recordId: rec.id, version: rec.version, option: 'unfinished', grantId: 'ig_x' } })).status, 403);
  } finally { wb.read = realRead; }
});

// ── 4. The private block: allowance + per-move confirmation, then the real write ─

function fakeGraph() {
  const events = new Map();
  const MARKER = require('../services/calendar-read').MARKER_PROP;
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url); const method = opts.method || 'GET';
    const json = (status, body) => ({ status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
    if (u.hostname !== 'graph.microsoft.com') throw new Error(`unexpected host ${u.hostname}`);
    if (method === 'POST' && u.pathname === '/v1.0/me/events') { const id = `evt${events.size + 1}`; events.set(id, { id, ...JSON.parse(opts.body) }); return json(201, events.get(id)); }
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


// ── The governed save: allowance + per-move confirmation, then the real write ─

const checksFor = (live) => ({
  diary: async () => ({ known: true, clashes: [] }), availability: async () => ({ known: true, off: false, working: true }),
  candidate: async (pk) => planner.recheck(pk), noteState: exec.defaultChecks({ adapters: live }).noteState,
});
async function confirmLive(rec, option, { graph = true } = {}) {
  const ms = require('../services/microsoft'); const realToken = ms.getAccessToken; ms.getAccessToken = async () => 'fake-token';
  const realFetch = global.fetch; let graphCalls = 0;
  const events = graph ? fakeGraph() : new Map();
  if (!graph) global.fetch = async () => { graphCalls += 1; throw new Error('no network expected'); };
  process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
  try {
    const c = exec.requestConfirmation({ recordId: rec.id, option, sessionId: 'session_priv_0001' });
    assert.equal(c.ok, true, JSON.stringify(c));
    const live = exec.liveAdapters();
    const r = await exec.execute({ recordId: rec.id, option, grantId: c.grantId, adapters: live, checks: checksFor(live) });
    return { r, events, graphCalls };
  } finally { delete process.env.SAIM_PREPARED_MOVE_EXECUTION; ms.getAccessToken = realToken; global.fetch = realFetch; }
}

test('saving is still allowance-gated and individually confirmed', async () => {
  const rec = latest();
  budget._test.reset();
  const ask0 = await exec.requestForMove({ recordId: rec.id, sessionId: 'session_priv_0001', now: NOW });
  assert.equal(ask0.ok, false, 'no allowance today → not even asked');
  process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
  try {
    const none = await exec.execute({ recordId: rec.id, option: 'approve', grantId: null, adapters: exec.liveAdapters() });
    assert.equal(none.ok, false); assert.match(none.reasons.join(' '), /confirmation/);
  } finally { delete process.env.SAIM_PREPARED_MOVE_EXECUTION; }
  assert.equal(count('SELECT COUNT(*) n FROM external_write_ledger'), 0);
});

test('an explicitly UNFINISHED save books no time — the note says so, the receipt names its project', async () => {
  budget._test.reset(); budget._test.grantToday({ now: NOW });
  const tid = db.get("SELECT id FROM tasks WHERE text LIKE 'Agree the hybrid WFH incentive targets for the Support Hub%'").id;
  const rec = store.latest(planner.moveKeyFor('project-note', `task:${tid}`));
  assert.ok(rec.packet.selected.interview.open > 0);
  const { r, graphCalls } = await confirmLive(rec, 'unfinished', { graph: false });
  assert.equal(r.receipt.complete, true, JSON.stringify(r.receipt.steps));
  assert.deepEqual(r.receipt.steps.map((x) => x.step), ['note'], 'no calendar step at all');
  assert.equal(graphCalls, 0, 'the calendar was never touched');
  assert.match(r.receipt.plain, /Linked to project: Support Hub\.$/);
  assert.deepEqual(r.receipt.destination, { folder: 'Projects/Support Hub', project: 'Support Hub', say: 'Linked to project: Support Hub' });
  const saved = fs.readFileSync(path.join(VAULT, rec.packet.selected.decision.proposedWrites.find((w) => w.kind === 'vault.note').path), 'utf8');
  assert.match(saved, /^---\ntype: draft\nprivate: true\nunfinished: true\n/);
  assert.match(saved, /## Still to decide/);
});

test('all answered/parked → the governed save-and-protect path: Projects/Working is created, the block invites nobody, the receipt says where it went', async () => {
  const rec = latest();
  assert.equal(rec.packet.selected.interview.open, 0);
  assert.equal(fs.existsSync(PROJ('Working')), false);
  const { r, events } = await confirmLive(rec, 'approve');
  assert.equal(r.receipt.complete, true, JSON.stringify(r.receipt.steps));
  assert.deepEqual(r.receipt.steps.map((x) => x.step).sort(), ['calendar', 'note']);
  const [ev] = events.values();
  assert.deepEqual(ev.attendees, [], 'just Nick');
  assert.ok(fs.statSync(PROJ('Working')).isDirectory(), 'the one folder a save may create');
  const notePath = rec.packet.selected.decision.proposedWrites.find((x) => x.kind === 'vault.note').path;
  assert.match(notePath, /^Projects\/Working\//);
  const saved = fs.readFileSync(path.join(VAULT, notePath), 'utf8');
  assert.match(saved, /^---\ntype: draft\nprivate: true\n/);
  assert.doesNotMatch(saved, /unfinished: true/);
  assert.match(saved, /## You said/);
  assert.match(r.receipt.plain, /Kept in your working drafts \(Projects\/Working\)\.$/);
  assert.equal(r.receipt.destination.say, 'Working drafts');
  assert.equal(count('SELECT COUNT(*) n FROM prepared_actions'), 0, 'no governed message, invite or reply');
  assert.equal(fs.readdirSync(path.join(VAULT, 'Meetings/2026/09')).length, 1, 'nothing saved beside the meeting');
});

test('the live vault creates ONLY Projects/Working — never a folder a move names', async () => {
  const live = exec.liveAdapters();
  await assert.rejects(() => live.vault.writeNew('Projects/Invented/x (private draft).md', 'x'), /not creating folders/);
  assert.equal(fs.existsSync(PROJ('Invented')), false);
});

test('PURE: the executor refuses anything private that is not exactly a labelled note + solo block in a project or Working', () => {
  const s = { kind: 'project-note', screens: { employment: { sensitive: true, mode: 'private-draft' } }, decision: { proposedWrites: [{ kind: 'vault.note', path: 'Projects/Working/X (private draft).md' }] } };
  assert.equal(exec.privateDraftAllowed(s, `# X\n> **${brief.LABEL}**`), true);
  assert.equal(exec.privateDraftAllowed({ ...s, decision: { proposedWrites: [{ kind: 'vault.note', path: 'Meetings/2026/09/X – Private draft.md' }] } }, brief.LABEL), false, 'never beside a meeting');
  assert.equal(exec.privateDraftAllowed(s, '# X without the label'), false);
  assert.equal(exec.privateDraftAllowed({ ...s, decision: { proposedWrites: [...s.decision.proposedWrites, { kind: 'governed.reply' }] } }, brief.LABEL), false);
  assert.equal(exec.privateDraftAllowed({ ...s, decision: { proposedWrites: [{ kind: 'vault.note', path: 'Projects/Support Hub/X (draft).md' }] } }, brief.LABEL), false);
  assert.equal(exec.privateDraftAllowed({ ...s, screens: { employment: { sensitive: true } } }, brief.LABEL), false);
  assert.deepEqual(exec.destinationOf('Projects/Working/x.md'), { folder: 'Projects/Working', project: null, say: 'Working drafts' });
  assert.deepEqual(exec.destinationOf('Projects/TOM/x.md'), { folder: 'Projects/TOM', project: 'TOM', say: 'Linked to project: TOM' });
});

test('the policy boundary holds: an HR-worded promise, or one the ledger marks sensitive, is still a hard stop', async () => {
  const HR = 'Prepare the disciplinary letter for the hybrid WFH case';
  fs.writeFileSync(path.join(VAULT, 'Areas', 'HR.md'), `# x\n- ${HR}.\n${PEOPLE_LINES}`);
  require('../services/task-store').createTask({ text: HR, source: 'manual', origin_path: 'Areas/HR.md' });
  const hid = db.get('SELECT id FROM tasks WHERE text = ?', [HR]).id;
  promises.set('promise:901', promiseOf('promise:901', HR, hid));
  promises.set('promise:902', { ...promiseOf('promise:902', TEXT, taskId), sensitivity: { sensitive: true } });
  const a = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:901' } });
  assert.equal(a.status, 409); assert.match(a.body.error, /employment matter/);
  const b = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:902' } });
  assert.equal(b.status, 409);
});

test('a private draft prepared under the 25 Oct rule (no interview, beside the meeting) is never handed back — pressing prepares it again with the interview, in Working', async () => {
  const T = 'Define the hybrid WFH incentive measures for the leads';
  fs.writeFileSync(path.join(VAULT, 'Areas', 'Old.md'), `# Old\n- Define the hybrid WFH incentive measures for the leads.\n${PEOPLE_LINES}`);
  require('../services/task-store').createTask({ text: T, source: 'manual', origin_path: 'Areas/Old.md' });
  const tid = db.get('SELECT id FROM tasks WHERE text = ?', [T]).id;
  promises.set('promise:880', promiseOf('promise:880', T, tid));
  const first = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:880' } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  // Re-store it as the OLD shape: no interview, a Meetings/ path.
  const cur = store.latest(planner.moveKeyFor('project-note', `task:${tid}`));
  const old = JSON.parse(JSON.stringify(cur.packet));
  delete old.selected.interview;
  old.selected.decision.slots = old.selected.decision.slots.filter((x) => x.id !== 'unfinished');
  old.selected.decision.proposedWrites.find((w) => w.kind === 'vault.note').path = `Meetings/2026/09/${planner.safeTitle(T)} – Private draft.md`;
  old.selected.evidenceHash = 'old-rule';
  // Rows are immutable (a trigger), so the old shape goes in as the NEXT version — as the live one is.
  const row = db.get('SELECT * FROM prepared_moves WHERE id = ?', [cur.id]);
  const oldId = `pm_${'0'.repeat(14)}old1`.slice(0, 23);
  db.run('INSERT INTO prepared_moves (id, move_key, version, contract, packet_json, packet_hash, options_json, decided_at, evidence_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [oldId, row.move_key, row.version + 1, row.contract, JSON.stringify(old), 'old-rule', JSON.stringify({ approve: {} }), row.decided_at, row.evidence_expires_at, new Date().toISOString()]);
  const stale = store.get(oldId);
  assert.equal(store.latest(planner.moveKeyFor('project-note', `task:${tid}`)).id, oldId);
  assert.equal((await planner.recheck(stale.packet)).ok, false, 'never confirmed or handed back');
  assert.equal(exec.writesFor(stale.packet, 'approve').ok, false, 'its Meetings/ path is refused');
  const m = require('../services/promise-moves').moveFor(itemFor('promise:880', tid, { state: 'needs-a-block' }));
  assert.equal(m.state, 'offer', 'offered again, not shown as finished');
  const again = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:880' } });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.notEqual(again.body.outcome, 'existing');
  const s = store.latest(planner.moveKeyFor('project-note', `task:${tid}`)).packet.selected;
  assert.ok(s.interview && s.interview.next, 'with the interview');
  assert.match(s.decision.proposedWrites.find((w) => w.kind === 'vault.note').path, /^Projects\/Working\//);
});

test('THE LIVE FAILURE (26 Oct 2026): an older private draft whose evidence hash matches is never handed back — the press re-plans and returns the interview', async () => {
  const T = 'Define the hybrid WFH incentive targets for the second line';
  fs.writeFileSync(path.join(VAULT, 'Areas', 'Live.md'), `# Live\n- Define the hybrid WFH incentive targets for the second line.\n${PEOPLE_LINES}`);
  require('../services/task-store').createTask({ text: T, source: 'manual', origin_path: 'Areas/Live.md' });
  const tid = db.get('SELECT id FROM tasks WHERE text = ?', [T]).id;
  promises.set('promise:990', promiseOf('promise:990', T, tid));
  const mk = planner.moveKeyFor('project-note', `task:${tid}`);
  const first = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:990' } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const cur = store.latest(mk);
  // The live shape: the 25 Oct packet (no interview, beside the meeting) carrying the SAME evidence hash a fresh gather produces.
  const old = JSON.parse(JSON.stringify(cur.packet));
  delete old.selected.interview;
  old.selected.decision.slots = old.selected.decision.slots.filter((x) => x.id !== 'unfinished');
  old.selected.decision.proposedWrites.find((w) => w.kind === 'vault.note').path = `Meetings/2026/09/${planner.safeTitle(T)} – Private draft.md`;
  const row = db.get('SELECT * FROM prepared_moves WHERE id = ?', [cur.id]);
  const oldId = 'pm_00000000000000live01';
  db.run('INSERT INTO prepared_moves (id, move_key, version, contract, packet_json, packet_hash, options_json, decided_at, evidence_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [oldId, mk, row.version + 1, row.contract, JSON.stringify(old), 'live-shape', JSON.stringify({ approve: {} }), row.decided_at, row.evidence_expires_at, new Date().toISOString()]);
  assert.equal(store.latest(mk).packet.selected.evidenceHash, cur.packet.selected.evidenceHash, 'the hash collides, as it did live');
  const before = outward();
  const r = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:990' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.notEqual(r.body.outcome, 'unchanged', 'the old record is NOT handed back');
  assert.notEqual(store.latest(mk).id, oldId);
  assert.ok(r.body.move, 'something to show');
  assert.equal(r.body.promiseMove.state, 'interview');
  assert.equal(r.body.promiseMove.question.id, 'achievable');
  assert.equal(r.body.promiseMove.question.canPark, true);
  assert.equal(r.body.promiseMove.recordId, store.latest(mk).id);
  assert.equal(r.body.promiseMove.version, store.latest(mk).version);
  assert.equal(r.body.promiseMove.destinationSay, 'Not saved yet. When you choose to save it, this draft will go in Working drafts.');
  assert.doesNotMatch(JSON.stringify(r.body), /Nothing more to prepare/);
  assert.deepEqual(outward(), before, 'still nothing written, sent or booked');
  // The answer comes back in the SAME contract, with the next question.
  const a = await call('/api/prepared-moves/answer', { method: 'POST', body: { recordId: r.body.promiseMove.recordId, version: r.body.promiseMove.version, questionId: 'achievable', text: 'Measured monthly' } });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.promiseMove.state, 'interview');
  assert.equal(a.body.promiseMove.question.id, 'incentive');
  assert.deepEqual(a.body.promiseMove.interview.said.map((x) => x.answer), ['Measured monthly']);
});

test('the route never answers success with nothing to show: a record the view refuses is a 409 that says why — never "Nothing more to prepare"', async () => {
  const T = 'Define the hybrid WFH incentive targets for third line';
  fs.writeFileSync(path.join(VAULT, 'Areas', 'Refused.md'), `# R\n- Define the hybrid WFH incentive targets for third line.\n${PEOPLE_LINES}`);
  require('../services/task-store').createTask({ text: T, source: 'manual', origin_path: 'Areas/Refused.md' });
  const tid = db.get('SELECT id FROM tasks WHERE text = ?', [T]).id;
  promises.set('promise:991', promiseOf('promise:991', T, tid));
  const view = require('../services/prepared-move-view');
  const real = view.v2View;
  view.v2View = async () => ({ move: null, why: 'the view refused it' });
  try {
    const r = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:991' } });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /SAiM couldn’t show what it prepared \(the view refused it\)\. Nothing was saved, booked or sent\./);
    const res = await import(require('url').pathToFileURL(path.join(__dirname, '..', '..', 'saim', 'shared-ui', 'presentation', 'promiseMove.mjs')).href);
    const shown = res.promiseMoveResult(r.body);
    assert.equal(shown.kind, 'refused');
    assert.doesNotMatch(shown.message, /Nothing more to prepare/);
    assert.doesNotMatch(JSON.stringify(res.promiseMoveResult({ ok: true })), /Nothing more to prepare/, 'not even for a bare ok');
  } finally { view.v2View = real; }
});

test('the card read off canonical Now carries the SAME contract as the route: canPark, the not-saved-yet line, the record and version', async () => {
  const tid = db.get("SELECT id FROM tasks WHERE text = 'Define the hybrid WFH incentive targets for the second line'").id;
  const item = { ...itemFor('promise:990', tid, { state: 'needs-a-block', why: 'x' }), owedTo: null, due: { date: '2026-10-16', say: 'overdue', endsAt: '' }, evidence: [], because: [] };
  const m = require('../services/promise-moves').moveFor(item);
  assert.equal(m.state, 'interview');
  const t = require('../services/keep-my-word').compose({ workbench: { state: 'ok', items: [item] }, moves: { 'promise:990': m } }).thread;
  assert.equal(t.move.question.canPark, true, 'Park survives the trip through Now');
  assert.equal(t.move.destinationSay, 'Not saved yet. When you choose to save it, this draft will go in Working drafts.');
  assert.equal(t.move.recordId, m.recordId); assert.equal(t.move.version, m.version);
  assert.equal(t.move.moveKey, m.moveKey);
  assert.deepEqual(t.move.interview.said.map((x) => x.answer), ['Measured monthly']);
});
