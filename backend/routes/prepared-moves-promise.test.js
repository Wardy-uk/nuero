'use strict';

/**
 * A held Keep my word promise, taken forward IN PLACE (24 Oct 2026) — over
 * real HTTP through NEURO's real api-auth and authority guard, the real store,
 * the real planner and real People notes in a temp vault. The fixture is the
 * live one: "Define achievable targets for hybrid/WFH incentive; agree plan on
 * 2026-09-02", whose notes name nobody it is owed to.
 *
 * Pins: pressing asks "Who is this owed to?"; an explicit answer is required;
 * a first name, an ambiguous name or an address is never resolved; a group is
 * kept as Nick wrote it with no address; the answer resumes the planner and
 * asks the NEXT precise question; a message to one person hands off to the
 * delivery note; nothing is sent, ledgered or written into People; MCP can
 * read the question and answer it with the API token.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-promise-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
for (const k of ['HA_TOKEN', 'HA_URL', 'SAIM_PREPARED_MOVE_EXECUTION']) delete process.env[k];
fs.mkdirSync(path.join(VAULT, 'People'), { recursive: true });
fs.mkdirSync(path.join(VAULT, 'Projects', 'Support Hub'), { recursive: true });
const person = (name, email) => fs.writeFileSync(path.join(VAULT, 'People', `${name}.md`), `---\ntype: person\n${email ? `email: ${email}\n` : ''}---\n# ${name}\n`);
person('Chris Middleton', 'chris.middleton@nurtur.test');
person('Chris Smith', 'chris.smith@nurtur.test');
person('Ricky Bostock', 'ricky.bostock@nurtur.test');
const peopleHash = () => fs.readdirSync(path.join(VAULT, 'People')).sort().map((f) => crypto.createHash('sha1').update(fs.readFileSync(path.join(VAULT, 'People', f))).digest('hex')).join(',');

const db = require('../db/database');
const planner = require('../services/prepared-move-planner');
const store = require('../services/prepared-move-store');
const owed = require('../services/promise-owed');

const NOW = Date.now();
const TEXT = 'Define achievable targets for hybrid/WFH incentive; agree plan on 2026-09-02';
const MSG_TEXT = 'Send the hybrid incentive targets to the leads';
let taskId; let msgTaskId;
const promises = new Map();
const promiseOf = (key, text, task) => ({ key, text, open: true, taskIds: [task], leadTaskId: task, owedTo: { people: [], ambiguous: [], fromNote: null, resolved: null }, sensitivity: { sensitive: false }, source: { path: 'Meetings/2026/08/2026-08-26 – Leadership.md', title: 'Leadership' } });
let drafts = 0;
Object.assign(planner.DEFAULT_DEPS, {
  promise: (key) => promises.get(key) || null,
  promiseDelivered: () => false,
  diary: () => ({ known: true, events: [], fetchedAt: new Date(NOW - 60000).toISOString() }),
  holidays: () => new Set(),
  leaveState: () => 'working',
  evidenceLines: () => [{ text: 'Hybrid incentive targets were discussed and need agreeing', cite: 'Meetings/2026/08/2026-08-26 – Leadership.md:4' }],
  draft: async () => { drafts += 1; return { ok: true, text: '## Targets\n- Hybrid incentive targets were discussed and need agreeing', gaps: ['the numbers'] }; },
});

let server; let base;
test.before(async () => {
  await db.init();
  const ts = require('../services/task-store');
  ts.createTask({ text: TEXT, source: 'manual' });
  taskId = db.get('SELECT id FROM tasks WHERE text = ?', [TEXT]).id;
  ts.createTask({ text: MSG_TEXT, source: 'manual' });
  msgTaskId = db.get('SELECT id FROM tasks WHERE text = ?', [MSG_TEXT]).id;
  promises.set('promise:322', promiseOf('promise:322', TEXT, taskId));
  promises.set('promise:900', promiseOf('promise:900', MSG_TEXT, msgTaskId));
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
const outward = () => ({
  actions: (() => { try { return db.get('SELECT COUNT(*) n FROM prepared_actions').n; } catch { return 0; } })(),
  ledger: (() => { try { return db.get('SELECT COUNT(*) n FROM external_write_ledger').n; } catch { return 0; } })(),
  grants: (() => { try { return db.get('SELECT COUNT(*) n FROM human_action_intents').n; } catch { return 0; } })(),
  people: peopleHash(),
});

// ── The pure resolver: never a guess ─────────────────────────────────────────

test('resolveAnswer: a full name or one-person alias is a person; a first name, partial or shared name is re-asked; an address is refused; a group is kept verbatim', () => {
  const roster = { full: ['Chris Middleton', 'Chris Smith', 'Ricky Bostock', 'Nick Ward'], aliases: new Map([['rb', 'Ricky Bostock']]) };
  assert.deepEqual(owed.resolveAnswer('chris middleton', roster), { kind: 'person', name: 'Chris Middleton' });
  assert.deepEqual(owed.resolveAnswer('RB', roster), { kind: 'person', name: 'Ricky Bostock' });
  const chris = owed.resolveAnswer('Chris', roster);
  assert.equal(chris.kind, 'ambiguous'); assert.deepEqual(chris.candidates, ['Chris Middleton', 'Chris Smith']);
  assert.equal(owed.nextQuestion(chris).question, 'Which Chris do you mean?');
  assert.deepEqual(owed.nextQuestion(chris).choices, ['Chris Middleton', 'Chris Smith']);
  // Even a UNIQUE first name is not taken as the person.
  const ricky = owed.resolveAnswer('Ricky', roster);
  assert.equal(ricky.kind, 'ambiguous'); assert.match(owed.nextQuestion(ricky).question, /Do you mean Ricky Bostock\? Give their full name\./);
  assert.equal(owed.resolveAnswer('chris.middleton@nurtur.test', roster).kind, 'unclear');
  assert.equal(owed.resolveAnswer('', roster).kind, 'unclear');
  assert.equal(owed.resolveAnswer('x'.repeat(121), roster).kind, 'unclear');
  assert.deepEqual(owed.resolveAnswer('Chris Middleton and Ricky Bostock', roster), { kind: 'people', names: ['Chris Middleton', 'Ricky Bostock'] });
  assert.deepEqual(owed.resolveAnswer('the TLO team', roster), { kind: 'stated', text: 'the TLO team' });
  // Nick himself is never a recipient match.
  assert.equal(owed.resolveAnswer('Nick Ward', roster).kind, 'stated');
  // A group never carries an address.
  const g = owed.owedFromResolution({ kind: 'stated', text: 'the TLO team' }, { by: 'nick', at: 'x', text: 'the TLO team' });
  assert.equal(g.resolved, null); assert.equal(g.group, 'the TLO team'); assert.equal(JSON.stringify(g).includes('@'), false);
});

// ── The held promise over HTTP ───────────────────────────────────────────────

let recordId; let version;
test('the held promise: pressing asks "Who is this owed to?" — a proposal is stored, nothing else', async () => {
  const before = outward();
  const r = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:322' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.move.plan, 'ask');
  const q = r.body.move.ask.questions[0];
  assert.equal(q.id, 'owed'); assert.equal(q.question, 'Who is this owed to?');
  assert.match(q.why, /won’t guess/);
  assert.equal(r.body.move.prepared.headline, 'I can take this forward — I need to know who it is owed to.');
  recordId = r.body.move.recordId; version = r.body.move.recordVersion;
  const rec = store.latest(planner.moveKeyFor('project-note', `task:${taskId}`));
  assert.equal(rec.packet.selected.source.promiseKey, 'promise:322', 'tied to the exact promise');
  assert.equal(drafts, 0, 'no model call before the question is answered');
  assert.deepEqual(outward(), before);
  // A repeated press returns the same question, not a second record.
  const again = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:322' } });
  assert.equal(again.body.outcome, 'existing'); assert.equal(again.body.move.recordId, recordId);
});

test('an empty answer is refused; "Chris" is re-asked with both candidates — never picked', async () => {
  const empty = await call('/api/prepared-moves/answer', { method: 'POST', body: { recordId, version, questionId: 'owed', text: '   ' } });
  assert.notEqual(empty.status, 200);
  const r = await call('/api/prepared-moves/answer', { method: 'POST', body: { recordId, version, questionId: 'owed', text: 'Chris' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const q = r.body.move.ask.questions[0];
  assert.equal(q.id, 'owed'); assert.equal(q.question, 'Which Chris do you mean?');
  assert.deepEqual(q.choices, ['Chris Middleton', 'Chris Smith']);
  assert.equal(owed.answerFor('promise:322').text, 'Chris', 'the answer is recorded against this promise');
  assert.equal(owed.answerFor('promise:900'), null, 'and no other');
  recordId = r.body.move.recordId; version = r.body.move.recordVersion;
});

test('a group is kept exactly as Nick wrote it (no address), and SAiM asks the NEXT precise question', async () => {
  const before = outward();
  const r = await call('/api/prepared-moves/answer', { method: 'POST', body: { recordId, version, questionId: 'owed', text: 'the TLO team' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const q = r.body.move.ask.questions[0];
  assert.notEqual(q.id, 'owed', 'the owed question is answered');
  assert.equal(q.id, 'folder', 'the next precise thing: where the note goes');
  const rec = store.latest(planner.moveKeyFor('project-note', `task:${taskId}`));
  assert.ok(rec.packet.selected.observed.some((o) => /owed to the TLO team \(you said\)/.test(o.fact)), 'the owed answer is cited as Nick’s own words');
  assert.equal(JSON.stringify(rec.packet).includes('@nurtur.test'), false, 'no address anywhere in the move');
  assert.deepEqual(outward(), before, 'no send, no ledger row, no grant, People notes unchanged');
  recordId = r.body.move.recordId; version = r.body.move.recordVersion;
});

test('answering the folder resumes the normal path: a draft, with a PROPOSED private block — nothing booked', async () => {
  const before = outward();
  const r = await call('/api/prepared-moves/answer', { method: 'POST', body: { recordId, version, questionId: 'folder', text: 'Support Hub' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.move.plan, 'draft');
  const rec = store.latest(planner.moveKeyFor('project-note', `task:${taskId}`));
  const w = rec.packet.selected.decision.proposedWrites.map((x) => x.kind);
  assert.ok(w.includes('vault.note'));
  assert.ok(w.includes('calendar.solo'), 'a private block is proposed');
  assert.deepEqual(rec.packet.selected.decision.proposedWrites.find((x) => x.kind === 'calendar.solo').attendees, []);
  assert.equal(store.scheduledFor(rec.moveKey), null, 'a proposed slot is not a booking');
  assert.equal(store.needsBlock(rec), true);
  assert.deepEqual(outward(), before, 'still nothing sent, booked or written');
  assert.equal(fs.existsSync(path.join(VAULT, 'Projects', 'Support Hub')) && fs.readdirSync(path.join(VAULT, 'Projects', 'Support Hub')).length, 0, 'no note written');
});

test('a message promise owed to ONE named person hands off to the delivery note — no project note, nothing sent', async () => {
  const before = outward();
  const p = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:900' } });
  assert.equal(p.body.move.ask.questions[0].id, 'owed');
  const r = await call('/api/prepared-moves/answer', { method: 'POST', body: { recordId: p.body.move.recordId, version: p.body.move.recordVersion, questionId: 'owed', text: 'Chris Middleton' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.outcome, 'handoff');
  assert.deepEqual(r.body.handoff, { to: 'promise-delivery', key: 'promise:900' });
  assert.match(r.body.say, /delivery note for your approval/);
  assert.match(r.body.say, /Nothing is sent/);
  assert.deepEqual(outward(), before, 'handing off prepares no governed action by itself');
});

test('a closed, delivered or HR-routed promise is refused before anything is asked', async () => {
  promises.set('promise:901', { ...promiseOf('promise:901', TEXT, taskId), open: false });
  promises.set('promise:902', { ...promiseOf('promise:902', TEXT, taskId), sensitivity: { sensitive: true } });
  assert.equal((await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:901' } })).status, 409);
  assert.equal((await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:902' } })).status, 409);
  assert.equal((await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:404' } })).status, 409);
});

// ── MCP: read the question, submit the answer ────────────────────────────────

test('MCP (API token): GET /promises shows what is missing and the move; prepare and answer work; the answer is stamped with the machine', async () => {
  const wb = require('../services/promise-workbench');
  const realRead = wb.read;
  const T2 = `Agree the rota targets ${Date.now()}`;
  require('../services/task-store').createTask({ text: T2, source: 'manual' });
  const t2 = db.get('SELECT id FROM tasks WHERE text = ?', [T2]).id;
  promises.set('promise:777', promiseOf('promise:777', T2, t2));
  wb.read = () => ({ state: 'at-risk', why: null, items: [{ key: 'promise:777', title: T2, taskIds: [t2], leadTaskId: t2, owedTo: null, due: '2026-10-30', preparation: { state: 'waiting-for-Nick', missing: 'owed-to' } }] });
  try {
    const list = await call('/api/prepared-moves/promises', { token: true });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const it = list.body.items[0];
    assert.equal(it.ref, 'promise:promise:777');
    assert.deepEqual(it.missing, [{ questionId: 'owed', question: 'Who is this owed to?' }]);
    assert.equal(it.move.state, 'offer'); assert.equal(it.move.control, 'Tell SAiM who it is owed to');
    const p = await call('/api/prepared-moves/prepare', { method: 'POST', token: true, body: { ref: it.ref } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const after = await call('/api/prepared-moves/promises', { token: true });
    assert.equal(after.body.items[0].move.state, 'ask');
    assert.equal(after.body.items[0].move.question.id, 'owed');
    const a = await call('/api/prepared-moves/answer', { method: 'POST', token: true, body: { recordId: after.body.items[0].move.recordId, version: after.body.items[0].move.version, questionId: 'owed', text: 'Ricky Bostock' } });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.match(owed.answerFor('promise:777').by, /^machine:/, 'an auditable origin: the machine that answered');
    // MCP still cannot confirm: request/confirm are Nick's.
    const req = await call('/api/prepared-moves/request', { method: 'POST', token: true, body: { option: 'approve', surface: 'neuro-web', sessionId: 'session_mcp_00001' } });
    assert.equal(req.status, 403);
  } finally { wb.read = realRead; }
});

// ── The workbench and the card read the answer ───────────────────────────────

test('workbench overlay: a resolved answer fills owedTo (said by Nick); the card’s move shows the right state', () => {
  const rows = owed.overlay([{ key: 'promise:777', owedTo: { people: [], ambiguous: [], resolved: null } }], { roster: { full: ['Ricky Bostock'] } });
  assert.equal(rows[0].owedTo.resolved, 'Ricky Bostock');
  assert.equal(rows[0].owedTo.stated.text, 'Ricky Bostock');
  // A promise whose own notes name someone is never overridden by an answer.
  const notes = owed.overlay([{ key: 'promise:777', owedTo: { resolved: 'Chris Smith' } }], { roster: { full: ['Ricky Bostock'] } });
  assert.equal(notes[0].owedTo.resolved, 'Chris Smith');
  const pm = require('../services/promise-moves');
  const m = pm.moveFor({ key: 'promise:322', taskIds: [taskId], leadTaskId: taskId, preparation: { state: 'waiting-for-Nick', missing: 'owed-to' } });
  assert.equal(m.state, 'needs-decision');
  assert.match(m.say, /needs your decision before I can schedule it/);
  assert.match(m.say, /nothing is booked yet/);
});
