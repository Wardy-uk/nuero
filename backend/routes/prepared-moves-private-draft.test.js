'use strict';

/**
 * The private working draft (25 Oct 2026) — the repair of the live dead end.
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

let recordId; let recordVersion;
test('pressing prepares the PRIVATE draft straight away — no recipient question, no model call, nothing outward', async () => {
  const before = outward(); const calls0 = modelCalls;
  const r = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:322' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const mv = r.body.move;
  assert.equal(mv.plan, 'draft', 'not the stale owed question');
  assert.equal(mv.prepared.headline, 'I prepared a private draft for you — no decision made, nothing sent.');
  assert.equal(mv.privateDraft.label, 'Private draft for Nick — no decision made, nothing sent.');
  assert.equal(modelCalls, calls0, 'composed, never generated');
  assert.deepEqual(outward(), before, 'no action, ledger row, grant, People change or file');
  recordId = mv.recordId; recordVersion = mv.recordVersion;
  const rec = store.get(recordId);
  const s = rec.packet.selected;
  assert.equal(s.screens.employment.sensitive, true, 'the sensitivity is still stated, not hidden');
  assert.equal(s.screens.employment.mode, 'private-draft');
  assert.deepEqual(s.decision.proposedWrites.map((w) => w.kind).sort(), ['calendar.solo', 'vault.note']);
  assert.deepEqual(s.decision.proposedWrites.find((w) => w.kind === 'calendar.solo').attendees, []);
  assert.equal(s.decision.proposedWrites.find((w) => w.kind === 'vault.note').path, `Meetings/2026/09/${planner.safeTitle(TEXT)} – Private draft.md`, 'beside its source meeting');
  assert.deepEqual(s.authority.mustNot, planner.MUST_NOT_PRIVATE);
});

test('the draft is private and non-decisive: labelled, quotes only neutral source lines, invents no target, number or person', () => {
  const rec = store.get(recordId);
  const text = rec.packet.selected.deliverable.suggested.text;
  assert.ok(text.includes('Private draft for Nick — no decision made, nothing sent.'));
  assert.match(text, /SAiM has not set any targets, judged anyone, or contacted anyone/);
  assert.ok(text.includes(`“${TEXT}”`), 'the commitment quoted');
  assert.ok(text.includes('Consider hybrid model (e.g., two days WFH) as incentive tied to achievable targets'), 'a neutral source line quoted, cited');
  assert.doesNotMatch(text, /Stephen|Heidi|Kerr|Ford/, 'no colleague named');
  assert.doesNotMatch(text, /dipped|on leave|on hold/i, 'no line about anyone’s employment (the source NOTE’s own title is cited, nothing more)');
  assert.ok(text.startsWith(`# ${TEXT} — private draft`), 'headed with the commitment as written');
  assert.match(text, /2 lines naming colleagues or their circumstances were left out/);
  assert.match(text, /SAiM has not proposed any targets/);
  assert.match(text, /## Decisions only you can make/);
  // Every number in the draft is in the sources (the wording or a quoted line) — nothing invented.
  const sources = `${TEXT}\n${NEUTRAL}\n${SOURCE}`;
  // (Citations — `_(path:line)_` — are where a line came from, not content.)
  const content = text.replace(/_\([^)]*\)_/g, '');
  for (const n of content.match(/\d+/g) || []) assert.ok(sources.includes(n), `“${n}” is not in the sources`);
  assert.doesNotMatch(text, /- \[ \]/, 'no checkboxes a scanner could raise as commitments');
});

test('a private draft beside a meeting note is never mined back as commitments', () => {
  const ac = require('../services/action-candidates');
  const skip = ac.shouldSkipPath || (ac._internals && ac._internals.shouldSkipPath);
  assert.equal(typeof skip, 'function');
  assert.equal(skip('Meetings/2026/09/Define x – Private draft.md'), true);
  assert.equal(skip(SOURCE), false, 'the source meeting itself is still read');
});

test('a repeated press returns the same private draft — no duplicate', async () => {
  const before = db.get('SELECT COUNT(*) n FROM prepared_moves').n;
  const r = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:322' } });
  assert.equal(r.body.outcome, 'existing'); assert.equal(r.body.move.recordId, recordId);
  assert.equal(db.get('SELECT COUNT(*) n FROM prepared_moves').n, before);
});

test('the earlier "Me" answer can be removed — append-only, and the promise is not left in a wrong state', async () => {
  assert.equal(owed.answerFor('promise:322').text, 'Me');
  const r = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:322', withdraw: 'owed' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.withdrawn, { questionId: 'owed', text: 'Me' });
  assert.equal(owed.answerFor('promise:322'), null, 'it no longer counts');
  const rows = db.all('SELECT question_id q, text FROM prepared_move_answers WHERE move_key = ? ORDER BY id', [moveKey()]);
  assert.deepEqual(rows.map((x) => [x.q, x.text]), [['owed', 'Me'], ['withdraw', 'owed']], 'kept for the record');
  assert.equal(r.body.move.plan, 'draft', 'still the private draft');
  // Withdrawing again is harmless.
  const again = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:322', withdraw: 'owed' } });
  assert.equal(again.status, 200);
  // Junk is refused.
  assert.equal((await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:322', withdraw: 'folder' } })).status, 400);
  assert.equal((await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'held:email-x', withdraw: 'owed' } })).status, 400);
  // The move now carries no owed answer to show.
  const m = require('../services/promise-moves').moveFor(itemFor('promise:322', taskId, { state: 'waiting-for-Nick', missing: 'owed-to' }));
  assert.equal(m.owedAnswer, null);
  recordId = store.latest(moveKey()).id; recordVersion = store.latest(moveKey()).version;
});

test('a missing fact produces ONE precise question (where the private draft is kept), then the draft', async () => {
  const before = outward();
  const r = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: 'promise:promise:500' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.move.plan, 'ask');
  const q = r.body.move.ask.questions;
  assert.equal(q.length, 1);
  assert.equal(q[0].id, 'folder'); assert.notEqual(q[0].id, 'owed');
  assert.match(q[0].why, /private draft/);
  assert.equal(r.body.move.prepared.headline, 'I can prepare a private draft for you — I need one thing first.');
  const a = await call('/api/prepared-moves/answer', { method: 'POST', body: { recordId: r.body.move.recordId, version: r.body.move.recordVersion, questionId: 'folder', text: 'Support Hub' } });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.move.plan, 'draft');
  const s = store.latest(planner.moveKeyFor('project-note', `task:${areaTaskId}`)).packet.selected;
  assert.match(s.decision.proposedWrites.find((w) => w.kind === 'vault.note').path, /^Projects\/Support Hub\/.+ \(private draft\)\.md$/);
  assert.deepEqual(outward(), before);
});

test('a source with nothing quotable about it asks what the draft should help decide', () => {
  const r = brief.sourceLines(`# x\n${PEOPLE_LINES}`, TEXT, { full: ['Stephen Kerr', 'Heidi Ford'] });
  assert.equal(r.lines.length, 0); assert.equal(r.leftOut, 2);
});

// ── 2. The capacity card's open is not a no-op ───────────────────────────────

test('"Open State of Play" on the capacity card becomes "Open the private draft" and opens it; a card with no promise is untouched', () => {
  const cr = require('../services/canonical-read');
  const m = require('../services/promise-moves').moveFor(itemFor('promise:322', taskId, { state: 'needs-a-block' }));
  assert.ok(['needs-decision', 'ready'].includes(m.state), m.state);
  const card = { kind: 'item', type: 'capacity', actionHint: 'Open State of Play', tab: 'surface', meta: { taskId } };
  const other = { kind: 'item', type: 'capacity', actionHint: 'Open State of Play', tab: 'surface', meta: { taskId: 99999 } };
  cr.linkPromiseOpens([card, other, null], { 'promise:322': m });
  assert.equal(card.actionHint, 'Open the private draft');
  assert.deepEqual(card.open, { kind: 'promise', ref: 'promise:promise:322', recordId: m.recordId, state: m.state, show: 'draft', privateDraft: true });
  assert.equal(other.actionHint, 'Open State of Play'); assert.equal(other.open, undefined);
  // Not yet prepared → the card takes him to the promise to prepare it.
  const offer = { kind: 'item', type: 'capacity', actionHint: 'Open State of Play', meta: { taskId } };
  cr.linkPromiseOpens([offer], { 'promise:322': { state: 'offer', ref: 'promise:promise:322', moveKey: m.moveKey, privateDraft: m.privateDraft } });
  assert.equal(offer.actionHint, 'Prepare a private working draft'); assert.equal(offer.open.show, 'promise');
});

test('the phone shell opens THAT draft, and draws no button that would do nothing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'saim', 'app', 'src', 'views', 'Surface.jsx'), 'utf8');
  assert.match(src, /if \(o && o\.kind === 'promise'\) \{/);
  assert.match(src, /setShowMove\(\{ recordId: o\.recordId, n: Date\.now\(\) \}\)/);
  assert.match(src, /function canOpen\(card\)/);
  assert.match(src, /canOpen=\{canOpen\}/);
  const as = fs.readFileSync(path.join(__dirname, '..', '..', 'saim', 'shared-ui', 'AttentionSurface.jsx'), 'utf8');
  assert.equal((as.match(/\(!canOpen \|\| canOpen\(/g) || []).length, 2, 'both open buttons are guarded');
});

// ── 3. MCP: read and answer, never confirm ───────────────────────────────────

test('MCP (API token): reads the private-draft state and answers its question with a machine origin; cannot confirm or execute', async () => {
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
    const it = l.body.items[0];
    assert.equal(it.move.privateDraft.label, brief.LABEL);
    assert.deepEqual(it.missing, [], 'a private draft never needs owed-to');
    assert.equal(it.move.control, 'Prepare a private working draft');
    const p = await call('/api/prepared-moves/prepare', { method: 'POST', token: true, body: { ref: it.ref } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const after = await call('/api/prepared-moves/promises', { token: true });
    const ask = after.body.items[0];
    assert.equal(ask.move.state, 'ask'); assert.equal(ask.missing[0].questionId, 'folder');
    const a = await call('/api/prepared-moves/answer', { method: 'POST', token: true, body: { recordId: ask.missing[0].recordId, version: ask.missing[0].version, questionId: 'folder', text: 'Support Hub' } });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const row = db.get('SELECT by FROM prepared_move_answers WHERE question_id = ? ORDER BY id DESC LIMIT 1', ['folder']);
    assert.match(row.by, /^machine:/, 'an auditable machine origin');
    const req = await call('/api/prepared-moves/request', { method: 'POST', token: true, body: { option: 'approve', surface: 'neuro-web', sessionId: 'session_mcp_00002' } });
    assert.equal(req.status, 403);
    const conf = await call('/api/prepared-moves/confirm', { method: 'POST', token: true, body: { recordId: a.body.move.recordId, version: a.body.move.recordVersion, option: 'approve', grantId: 'ig_x' } });
    assert.equal(conf.status, 403);
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

test('the private block stays behind the allowance and the per-move confirmation; once confirmed, the note is labelled private and the block invites nobody', async () => {
  const rec = store.latest(moveKey());
  assert.equal(rec.packet.selected.plan, 'draft');
  // The executor accepts THIS packet, and only because it is a labelled private draft.
  const w = exec.writesFor(rec.packet, 'approve');
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.deepEqual(w.steps.map((x) => x.step).sort(), ['calendar', 'note']);
  // No allowance today → not even asked to confirm.
  budget._test.reset();
  const ask = await exec.requestForMove({ recordId: rec.id, sessionId: 'session_priv_0001', now: NOW });
  assert.equal(ask.ok, false);
  // No confirmation → nothing runs.
  process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
  try {
    const none = await exec.execute({ recordId: rec.id, option: 'approve', grantId: null, adapters: exec.liveAdapters() });
    assert.equal(none.ok, false); assert.match(none.reasons.join(' '), /confirmation/);
  } finally { delete process.env.SAIM_PREPARED_MOVE_EXECUTION; }
  assert.equal(count('SELECT COUNT(*) n FROM external_write_ledger'), 0);
  // With today's allowance and Nick's confirmation, it writes exactly the two things.
  budget._test.grantToday({ now: NOW });
  const ms = require('../services/microsoft'); const realToken = ms.getAccessToken; ms.getAccessToken = async () => 'fake-token';
  const realFetch = global.fetch; const events = fakeGraph();
  process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
  try {
    const c = exec.requestConfirmation({ recordId: rec.id, option: 'approve', sessionId: 'session_priv_0001' });
    assert.equal(c.ok, true, JSON.stringify(c));
    const live = exec.liveAdapters();
    const r = await exec.execute({ recordId: rec.id, option: 'approve', grantId: c.grantId, adapters: live, checks: {
      diary: async () => ({ known: true, clashes: [] }), availability: async () => ({ known: true, off: false, working: true }),
      candidate: async (pk) => planner.recheck(pk), noteState: exec.defaultChecks({ adapters: live }).noteState,
    } });
    assert.equal(r.receipt.complete, true, JSON.stringify(r.receipt.steps));
  } finally { delete process.env.SAIM_PREPARED_MOVE_EXECUTION; ms.getAccessToken = realToken; global.fetch = realFetch; }
  const [ev] = events.values();
  assert.deepEqual(ev.attendees, [], 'just Nick');
  const notePath = rec.packet.selected.decision.proposedWrites.find((x) => x.kind === 'vault.note').path;
  const saved = fs.readFileSync(path.join(VAULT, notePath), 'utf8');
  assert.match(saved, /^---\ntype: draft\nprivate: true\n/);
  assert.ok(saved.includes(brief.LABEL));
  assert.equal(count('SELECT COUNT(*) n FROM prepared_actions'), 0, 'no governed message, invite or reply');
});

test('PURE: the executor refuses anything private that is not exactly a labelled note + solo block', () => {
  const s = { kind: 'project-note', screens: { employment: { sensitive: true, mode: 'private-draft' } }, decision: { proposedWrites: [{ kind: 'vault.note', path: 'Meetings/2026/09/X – Private draft.md' }] } };
  assert.equal(exec.privateDraftAllowed(s, `# X\n> **${brief.LABEL}**`), true);
  assert.equal(exec.privateDraftAllowed(s, '# X without the label'), false, 'unlabelled');
  assert.equal(exec.privateDraftAllowed({ ...s, decision: { proposedWrites: [...s.decision.proposedWrites, { kind: 'governed.reply' }] } }, brief.LABEL), false, 'a reply is never part of a private draft');
  assert.equal(exec.privateDraftAllowed({ ...s, decision: { proposedWrites: [{ kind: 'vault.note', path: 'Projects/Support Hub/X (draft).md' }] } }, brief.LABEL), false, 'not a private-draft path');
  assert.equal(exec.privateDraftAllowed({ ...s, kind: 'email-reply' }, brief.LABEL), false);
  assert.equal(exec.privateDraftAllowed({ ...s, screens: { employment: { sensitive: true } } }, brief.LABEL), false, 'sensitive without the private mode stays routing only');
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
