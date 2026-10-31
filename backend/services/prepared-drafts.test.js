'use strict';

/**
 * Drafts (22 Oct 2026): the status rules (pure), the list over the real store
 * (read-only), the manual-press rule against the scan cap, the record id
 * /eligible now carries, and the one meeting "I'm not attending" may name.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-drafts-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
for (const k of ['HA_TOKEN', 'HA_URL', 'SAIM_PREPARED_MOVE_EXECUTION', 'SAIM_PREPARED_MOVE_SCAN']) delete process.env[k];
for (const d of ['People', 'Meetings/2026/09', 'Projects/Support Hub']) fs.mkdirSync(path.join(VAULT, d), { recursive: true });
for (const n of ['Stephen Kerr', 'Heidi Ford']) fs.writeFileSync(path.join(VAULT, 'People', `${n}.md`), `---\ntype: person\n---\n# ${n}\n`);
const SOURCE = 'Meetings/2026/09/2026-09-01 – Weekly Meeting Ticket Health, AI Integration, and Team Performance.md';
const TEXT = 'Define achievable targets for hybrid/WFH incentive; agree plan on 2026-09-02';
fs.writeFileSync(path.join(VAULT, SOURCE), `---\ntype: meeting\n---\n# Weekly Meeting\n\n### Return-to-Office Policy and Incentives\n- Consider hybrid model (e.g., two days WFH) as incentive tied to achievable targets, leveraging AI efficiency gains; stagger WFH to maintain coverage.\n\n## Actions\n- [ ] ${TEXT}.\n\n### Team Performance\n- Stephen Kerr’s performance on hybrid WFH targets has dipped this month.\n- Heidi Ford is on leave next week; her WFH incentive is on hold.\n`);

const db = require('../db/database');
const planner = require('./prepared-move-planner');
const store = require('./prepared-move-store');
const drafts = require('./prepared-drafts');
const working = async () => ({ onDuty: true, why: 'working' });
require('./prepared-move').readDuty = working;
require('./prepared-move-exec')._setDeps({ readDuty: working });

const TASKS = {};
const COPIES = ['a', 'b', 'c', 'd', 'e'];
const keyOf = (c) => `promise:${901 + COPIES.indexOf(c)}`;
Object.assign(planner.DEFAULT_DEPS, {
  promise: (key) => { const c = COPIES.find((x) => keyOf(x) === key); return c ? { key, text: TEXT, open: true, taskIds: [TASKS[c]], leadTaskId: TASKS[c], owedTo: { people: [], ambiguous: [], fromNote: null, resolved: null }, sensitivity: { sensitive: false }, source: { path: SOURCE, title: 'Weekly Meeting' } } : null; },
  promiseDelivered: () => false,
  diary: () => ({ known: true, events: [], fetchedAt: new Date(Date.now() - 60000).toISOString() }),
  holidays: () => new Set(), leaveState: () => 'working',
});

// ── PURE: one status per item, from what the view and the boundary say ──
const rec = (selected) => ({ packet: { selected } });
test('statusFor: each status, and its reason', () => {
  const s = drafts.statusFor;
  assert.equal(s({ record: rec({}), view: { move: null, why: 'the email is no longer waiting in triage' } }).status, 'held');
  assert.match(s({ record: rec({}), view: { move: null, why: 'x' } }).say, /can’t be offered as it stands: x/);
  assert.match(s({ record: rec({}), view: { move: { held: true }, held: { reason: 'off-duty' } } }).say, /next working morning/);
  assert.match(s({ record: rec({}), view: { move: { held: true }, held: { reason: 'leave' } } }).say, /on leave/);
  assert.equal(s({ record: rec({}), view: { move: { plan: 'ask', ask: { questions: [{ question: 'Which folder?' }] } } } }).say, 'Which folder?');
  const iv = { next: { id: 'incentive', question: 'What is the incentive?' }, total: 4, questions: [{ id: 'achievable' }, { id: 'incentive' }] };
  assert.deepEqual(s({ record: rec({ interview: iv }), view: { move: { plan: 'draft', options: [{ id: 'unfinished' }] } } }), { status: 'needs-answer', say: 'Decision 2 of 4: What is the incentive?' });
  const opt = { id: 'approve', writes: ['Save the draft as a new note: Projects/X/y.md'] };
  assert.equal(s({ record: rec({ kind: 'project-note' }), view: { move: { plan: 'draft', options: [opt] } } }).status, 'ready-to-save');
  assert.equal(s({ record: rec({ kind: 'email-reply' }), view: { move: { plan: 'draft', options: [opt] } } }).status, 'ready-to-confirm');
  assert.equal(s({ record: rec({}), view: { move: { plan: 'draft', options: [opt] } }, boundary: { gate: 'allowance', say: 'allow' } }).status, 'waiting-allowance');
  assert.equal(s({ record: rec({}), view: { move: { plan: 'draft', options: [opt] } }, boundary: { gate: 'stop', say: 'stopped' } }).status, 'waiting-allowance');
  for (const gate of ['device', 'used', 'unreadable']) assert.equal(s({ record: rec({}), view: { move: { plan: 'draft', options: [opt] } }, boundary: { gate, say: gate } }).status, 'held', `${gate}: nothing here can change it`);
  assert.match(s({ record: rec({}), view: { move: { plan: 'draft', options: [], notOffered: [{ label: 'Thu 10:00', why: 'no longer free' }] } } }).say, /Thu 10:00: no longer free/);
});
test('shape: fixed order, plain labels, and NO action on a held item', () => {
  const out = drafts.shape([{ status: 'held', updatedAt: '2026-10-22T10:00:00Z' }, { status: 'ready-to-save', updatedAt: '2026-10-22T09:00:00Z' }, { status: 'needs-answer', updatedAt: '2026-10-21T09:00:00Z' }, { status: 'waiting-allowance' }, { status: 'ready-to-confirm' }]);
  assert.deepEqual(out.map((r) => r.status), ['needs-answer', 'ready-to-confirm', 'ready-to-save', 'waiting-allowance', 'held']);
  assert.deepEqual(out.map((r) => r.statusLabel), ['Needs your answer', 'Ready to confirm', 'Ready to save', 'Waiting for allowance', 'Held']);
  assert.deepEqual(out.map((r) => r.action && r.action.open), ['question', 'confirm', 'save', 'authority', null]);
});

// ── The list over the real store, the route, and the manual-press rule ──
let server; let base;
async function call(p, { method = 'GET', body = null, token = false } = {}) {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-NEURO-API-TOKEN': 'tok-5678' } : { 'X-NEURO-PIN': 'pin-1234' }) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
test.before(async () => {
  await db.init(); store.ensure();
  const ts = require('./task-store');
  for (const c of COPIES) {
    const r = ts.createTask({ text: TEXT, source: 'meeting-promotion', origin_path: SOURCE, distinct: true });
    TASKS[c] = (r && (r.id || (r.task && r.task.id))) || db.get('SELECT id FROM tasks WHERE text LIKE ? ORDER BY id DESC LIMIT 1', [`${TEXT}%`]).id;
  }
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require('./api-auth'));
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/prepared-moves', require('../routes/prepared-moves'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

test('a MANUAL press prepares its item even with three scan-started drafts open (the scan cap is the scan’s, never his)', async () => {
  for (const c of ['a', 'b', 'c']) {
    const r = await planner.planAndStore({ ref: `promise:${keyOf(c)}`, origin: 'scan' });
    assert.ok(r.ok && r.record, JSON.stringify(r));
  }
  assert.equal(store.activeV2({ limit: 50 }).filter((r) => r.packet.firstOrigin === 'scan').length, 3);
  const p = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: `promise:${keyOf('d')}` } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(store.get(p.body.promiseMove.recordId).packet.firstOrigin, 'manual');
});

test('GET /drafts lists every active item from the store, one status each — and writes NOTHING', async () => {
  const snap = () => db.all('SELECT id, version, created_at FROM prepared_moves ORDER BY id').map((r) => JSON.stringify(r)).join('|') + db.get('SELECT COUNT(*) n FROM human_action_intents').n + JSON.stringify(db.all("SELECT key, value FROM agent_state WHERE key LIKE 'saim_move%' ORDER BY key"));
  const before = snap();
  const r = await call('/api/prepared-moves/drafts');
  assert.equal(r.status, 200);
  assert.equal(r.body.contract, 'prepared-drafts-v2');
  assert.equal(r.body.items.length, store.activeV2({ limit: 50 }).length, 'one row per active move — no second list, no duplicates');
  assert.equal(new Set(r.body.items.map((x) => x.moveKey)).size, r.body.items.length);
  for (const x of r.body.items) {
    assert.equal(x.kindLabel, 'Prepared note');
    assert.equal(x.status, 'needs-answer');
    assert.ok(x.say, 'it says what SAiM needs');
    assert.deepEqual(x.action, { open: 'question', label: 'Answer the question' });
  }
  assert.deepEqual(r.body.items.map((x) => x.startedBy).sort(), ['manual', 'scan', 'scan', 'scan'], 'however it began');
  assert.equal(snap(), before, 'reading Drafts stores, mints and stamps nothing');
  // The kiosk proxy may read this exact path and nothing else in prepared-moves.
  const { DOORS } = require('../../saim/backend/src/routes/neuroProxy');
  assert.equal(DOORS.has('prepared-moves'), false, 'the segment that acts stays closed on the wall');
  assert.match(fs.readFileSync(path.join(__dirname, '..', '..', 'saim/backend/src/routes/neuroProxy.js'), 'utf8'), /'\/prepared-moves\/drafts',/);
});

test('/eligible carries the prepared record id, so a row that is already prepared opens THAT entry', async () => {
  const em = { ref: 'held:email-x1', role: 'held', title: 'Renewal question', item: { type: 'email', id: 'email-urgent', title: 'Renewal question', meta: { emailId: 'x1' } } };
  const latest = { id: 'pm_abcdef0123456789abcd', evidenceExpiresAt: new Date(Date.now() + 3600000).toISOString() };
  const r = await planner.eligibleNow({ deps: {
    prepareV1: async () => ({ duty: { onDuty: true }, candidates: [em], selected: null }),
    suppression: () => null, completed: () => false, latest: () => latest,
    triageEntry: (id) => ({ id, subject: 'Renewal question', fromEmail: 'sam@acme.test' }), liveReply: () => null,
  } });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].prepared, true);
  assert.equal(r.items[0].recordId, latest.id);
});

// ── "I'm not attending": exactly the meeting on screen ──
test('notAttendingTarget: in a meeting the RUNNING one; before one only the next meeting SAiM’s hand-off names; otherwise none', async () => {
  const ns = await import(pathToFileURL(path.join(__dirname, '..', '..', 'saim', 'shared-ui', 'presentation', 'nextStep.mjs')).href);
  const meeting = { key: 'id:cur::2026-10-22T10:00:00', subject: 'Weekly Ops' };
  const nextMeeting = { key: 'id:nxt::2026-10-22T11:00:00', subject: 'Planning' };
  const prep = (id) => [{ label: 'Open meeting prep', target: { type: 'link', role: 'prep', href: `neuro:?item=meeting-prep:${id}` } }];
  assert.deepEqual(ns.notAttendingTarget({ inMeeting: true, meeting, nextMeeting, dests: prep('nxt') }), { key: meeting.key, subject: 'Weekly Ops' }, 'the running meeting — never the next');
  assert.deepEqual(ns.notAttendingTarget({ preMeeting: true, meeting: null, nextMeeting, dests: prep('nxt') }), { key: nextMeeting.key, subject: 'Planning' });
  assert.equal(ns.notAttendingTarget({ preMeeting: true, nextMeeting, dests: prep('other') }), null, 'the hand-off names a different event');
  assert.equal(ns.notAttendingTarget({ preMeeting: true, nextMeeting, dests: [] }), null, 'nothing proves which meeting is shown');
  // Through nextStep: only where the shell can record it.
  const handoff = { rule: 'S3 meeting', handoff: { primary: { label: 'Join in Teams', target: { type: 'link', href: 'https://teams.microsoft.com/l/x' } }, alternatives: prep('cur') } };
  const can = { external: true, tab: () => true };
  const ctx = { activity: 'in-meeting' };
  assert.equal(ns.nextStep({ handoff, context: ctx, meeting, nextMeeting, can }).notAttending, null, 'no recorder (kiosk, watch) → no control');
  assert.deepEqual(ns.nextStep({ handoff, context: ctx, meeting, nextMeeting, can: { ...can, notAttending: true } }).notAttending, { key: meeting.key, subject: 'Weekly Ops' });
  assert.deepEqual(ns.nextStep({ handoff, context: ctx, meeting, can: { ...can, notAttending: true } }).primary.label, 'Join in Teams', 'Join stays first');
});

// ── Saved work (22 Oct 2026): "executor completed" is not "Nick's work completed" ──
function fakeDb(receipts, { actions = {}, outcomes = [], ledger = {} } = {}) {
  return {
    all: (sql) => (/agent_state/.test(sql) ? Object.entries(receipts).map(([k, v]) => ({ key: `saim_move_receipt:${k}`, value: JSON.stringify(v) })) : []),
    get: (sql, params) => {
      if (/prepared_actions/.test(sql)) return actions[params[0]] || null;
      if (/prepared_move_outcomes/.test(sql)) return outcomes.filter((o) => o.move_key === params[0]).slice(-1)[0] || null;
      if (/external_write_ledger/.test(sql)) return ledger[params[0]] ? { result_json: JSON.stringify({ id: ledger[params[0]] }) } : null;
      return null;
    },
    getState: (k) => (receipts[k.replace('saim_move_receipt:', '')] ? JSON.stringify(receipts[k.replace('saim_move_receipt:', '')]) : null),
  };
}
const fakeStore = (titles) => ({
  get: (id) => ({ packet: { selected: titles[id] } }),
  scheduledFor: (k) => (k === 'saim-move:v2:project-note:task:7' ? { date: '2026-10-23', start: '10:30', end: '11:00' } : null),
});

test('saved work: a saved note is work; a practice run, a failed note and a still-unsaved proposal are not', () => {
  const pd = require('./prepared-drafts');
  const R = {
    'saim-move:v2:project-note:task:7': { recordId: 'r7', moveKey: 'saim-move:v2:project-note:task:7', target: 'live', option: 'approve', at: '2026-10-22T10:32:53Z', steps: [{ step: 'note', status: 'done', target: 'Projects/Working/A (private draft).md' }, { step: 'calendar', status: 'done', target: '2026-10-23 10:30–11:00 “Finish A”' }] },
    'saim-move:v2:project-note:task:8': { recordId: 'r8', moveKey: 'saim-move:v2:project-note:task:8', target: 'sandbox', steps: [{ step: 'note', status: 'done', target: 'x.md' }] },
    'saim-move:v2:project-note:task:9': { recordId: 'r9', moveKey: 'saim-move:v2:project-note:task:9', target: 'live', steps: [{ step: 'note', status: 'failed', target: 'y.md' }] },
  };
  const w = pd.savedWork({ now: Date.parse('2026-10-22T12:00:00Z'), deps: {
    db: fakeDb(R, { ledger: { 'saim-move:v2:project-note:task:7:calendar': 'EVT7' } }),
    store: fakeStore({ r7: { title: 'A', privateDraft: { label: 'x' }, source: { taskId: 7 } } }),
    getTask: (id) => ({ id, text: 'Task seven', status: 'open' }),
  } });
  assert.deepEqual(w.work.map((x) => x.moveKey), ['saim-move:v2:project-note:task:7']);
  const a = w.work[0];
  assert.equal(a.status, 'Draft saved · scheduled for Friday 23 October, 10:30');
  assert.equal(a.block.eventId, 'EVT7');
  assert.equal(a.task.id, 7);
  assert.equal(a.kindLabel, 'Private working draft');
  assert.equal(w.history.length, 0);
});

test('saved work: the booked time passing does NOT finish the work; only the task or Nick does', () => {
  const pd = require('./prepared-drafts');
  const R = { 'saim-move:v2:project-note:task:7': { recordId: 'r7', moveKey: 'saim-move:v2:project-note:task:7', target: 'live', at: '2026-10-22T10:00:00Z', steps: [{ step: 'note', status: 'done', target: 'Projects/Working/A.md' }, { step: 'calendar', status: 'done', target: '2026-10-23 10:30–11:00 “Finish A”' }] } };
  const deps = (task, outcomes = []) => ({ db: fakeDb(R, { outcomes }), store: fakeStore({ r7: { title: 'A', source: { taskId: 7 } } }), getTask: () => task });
  const later = Date.parse('2026-10-24T09:00:00Z');
  const open = pd.savedWork({ now: later, deps: deps({ id: 7, status: 'open' }) });
  assert.match(open.work[0].status, /has passed — the work is still open/);
  const done = pd.savedWork({ now: later, deps: deps({ id: 7, status: 'done', completed_at: '2026-10-24' }) });
  assert.equal(done.work.length, 0); assert.equal(done.history[0].status, 'Done — you ticked the task');
  const ab = pd.savedWork({ now: later, deps: deps({ id: 7, status: 'open' }, [{ move_key: 'saim-move:v2:project-note:task:7', outcome: 'abandoned', at: '2026-10-24T08:00:00Z' }]) });
  assert.equal(ab.history[0].outcome, 'abandoned'); assert.equal(ab.history[0].canRestore, true);
});

test('communication drafts: a confirmed reply is listed apart, with what really happened to it', () => {
  const pd = require('./prepared-drafts');
  const R = { 'saim-move:v2:email-reply:email:abc': { recordId: 'rr', moveKey: 'saim-move:v2:email-reply:email:abc', target: 'live', at: '2026-10-22T09:00:00Z', steps: [{ step: 'reply', status: 'done', id: 'pa_1' }] } };
  const w = (status) => pd.savedWork({ deps: { db: fakeDb(R, { actions: { pa_1: { status } } }), store: fakeStore({ rr: { title: 'Re: renewal', kind: 'email-reply' } }), getTask: () => null } });
  assert.equal(w('prepared').communication[0].status, 'In Actions — waiting for your approval code. Not sent.');
  assert.equal(w('verified').communication[0].status, 'Sent — read back in Sent Items');
  assert.equal(w('prepared').work.length, 0, 'a reply never crowds the saved work');
});
