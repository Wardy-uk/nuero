'use strict';

/**
 * The ONE off-duty exception (21–22 Oct 2026), and how narrow it is. Outside
 * working hours a prepared move may be saved ONLY when it is a v2 PRIVATE PROMISE
 * DRAFT whose immutable `firstOrigin` is exactly 'manual' — Nick's own press on
 * the promise card. Over real HTTP (real api-auth + authority guard), the real
 * store, planner, view and executor, a temp vault and a fake Graph:
 *   1. a manual private promise draft is requested, confirmed and EXECUTED off
 *      duty — and the switch, the stop and the allowance still refuse it;
 *   2. an otherwise identical draft with firstOrigin 'scan' is held in the view,
 *      /request, /confirm and the executor;
 *   3. the same for firstOrigin 'mcp' (prepared with the API token);
 *   4. leave, or an unknown duty, holds even the manual draft — everywhere;
 *   5. every answer/park re-plans with origin 'answer' and KEEPS firstOrigin —
 *      that is what makes (1) eligible and (2)/(3) not.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-offduty-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
for (const k of ['HA_TOKEN', 'HA_URL', 'SAIM_PREPARED_MOVE_EXECUTION']) delete process.env[k];
for (const d of ['People', 'Meetings/2026/09', 'Projects/Support Hub']) fs.mkdirSync(path.join(VAULT, d), { recursive: true });
for (const n of ['Stephen Kerr', 'Heidi Ford']) fs.writeFileSync(path.join(VAULT, 'People', `${n}.md`), `---\ntype: person\n---\n# ${n}\n`);
const SOURCE = 'Meetings/2026/09/2026-09-01 – Weekly Meeting Ticket Health, AI Integration, and Team Performance.md';
const TEXT = 'Define achievable targets for hybrid/WFH incentive; agree plan on 2026-09-02';
fs.writeFileSync(path.join(VAULT, SOURCE), `---\ntype: meeting\n---\n# Weekly Meeting\n\n### Return-to-Office Policy and Incentives\n- Consider hybrid model (e.g., two days WFH) as incentive tied to achievable targets, leveraging AI efficiency gains; stagger WFH to maintain coverage.\n\n## Actions\n- [ ] ${TEXT}.\n\n### Team Performance\n- Stephen Kerr’s performance on hybrid WFH targets has dipped this month.\n- Heidi Ford is on leave next week; her WFH incentive is on hold.\n`);

const db = require('../db/database');
const planner = require('../services/prepared-move-planner');
const store = require('../services/prepared-move-store');
const exec = require('../services/prepared-move-exec');
const budget = require('../services/authority-budget');

// Duty is whatever each test says it is — the SAME reading for the view, /request, /confirm and the executor.
let DUTY = { onDuty: false, why: 'off-duty' };
const readDuty = async () => DUTY;
exec._setDeps({ readDuty });
require('../services/prepared-move').readDuty = readDuty;
require('../services/team-availability').selfAbsenceOn = () => ({ known: true, off: false }); // his leave, read (no feed offline)

const COPIES = ['manual', 'manual2', 'scan', 'mcp'];
const TASKS = {};
const keyOf = (c) => `promise:${701 + COPIES.indexOf(c)}`;
Object.assign(planner.DEFAULT_DEPS, {
  promise: (key) => {
    const c = COPIES.find((x) => keyOf(x) === key);
    return c ? { key, text: TEXT, open: true, taskIds: [TASKS[c]], leadTaskId: TASKS[c], owedTo: { people: [], ambiguous: [], fromNote: null, resolved: null }, sensitivity: { sensitive: false }, source: { path: SOURCE, title: 'Weekly Meeting' } } : null;
  },
  promiseDelivered: () => false,
  diary: () => ({ known: true, events: [], fetchedAt: new Date(Date.now() - 60000).toISOString() }),
  holidays: () => new Set(), leaveState: () => 'working',
});

let server; let base;
async function call(p, { method = 'GET', body = null, token = false } = {}) {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-NEURO-API-TOKEN': 'tok-5678' } : { 'X-NEURO-PIN': 'pin-1234' }) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
/** Walk the whole interview: answer, park, answer, park — each a fresh version with origin 'answer'. */
async function interview(prepared, { token = false } = {}) {
  let m = prepared;
  const plan = [['text', 'Two days WFH a week at or above 90% of FRT target'], ['park'], ['text', 'Everyone on the service desk, heard in their 1-2-1s'], ['park']];
  for (const [kind, text] of plan) {
    assert.ok(m && m.question && m.question.id, `a question to answer (${JSON.stringify(m)})`);
    const body = { recordId: m.recordId, version: m.version, questionId: m.question.id, ...(kind === 'park' ? { park: true } : { text }) };
    const r = await call('/api/prepared-moves/answer', { method: 'POST', body, token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    m = r.body.promiseMove;
  }
  assert.equal(m.state, 'needs-decision', 'all four answered or parked');
  return store.get(m.recordId);
}
const REC = {};
const live = (c) => store.latest(REC[c].moveKey);
const view = async (rec) => (await call(`/api/prepared-moves/current?recordId=${rec.id}`)).body;
const held = (v) => Boolean(v.held || (v.move && v.move.held)) && !((v.move || {}).options || []).length;
const request = (rec, option = 'approve') => call('/api/prepared-moves/request', { method: 'POST', body: { option, surface: 'neuro-web', sessionId: 'session_offduty_01', recordId: rec.id } });
const confirm = (rec, grantId, option = 'approve') => call('/api/prepared-moves/confirm', { method: 'POST', body: { recordId: rec.id, version: rec.version, option, grantId } });
/** A confirmation minted while ON duty — the only way to reach /confirm and the executor for a held record. */
async function grantOnDuty(rec, option = 'approve') {
  const was = DUTY; DUTY = { onDuty: true, why: 'working' };
  try { const r = await request(rec, option); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.grantId; } finally { DUTY = was; }
}
const count = (t) => { try { return db.get(`SELECT COUNT(*) n FROM ${t}`).n; } catch { return 0; } };
const writes = () => ({ ledger: count('external_write_ledger'), reservations: count('saim_authority_reservations'), working: fs.existsSync(path.join(VAULT, 'Projects', 'Working')) });

function fakeGraph() {
  const events = new Map();
  const MARKER = require('../services/calendar-read').MARKER_PROP;
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url); const method = opts.method || 'GET';
    if (u.hostname === '127.0.0.1') return realFetch(url, opts);
    const json = (status, b) => ({ status, text: async () => (b === undefined ? '' : JSON.stringify(b)) });
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
const realFetch = global.fetch;

test.before(async () => {
  await db.init();
  store.ensure();
  const ts = require('../services/task-store');
  for (const c of COPIES) {
    const r = ts.createTask({ text: TEXT, source: 'meeting-promotion', origin_path: SOURCE, distinct: true });
    TASKS[c] = (r && (r.id || (r.task && r.task.id))) || db.get('SELECT id FROM tasks WHERE text LIKE ? ORDER BY id DESC LIMIT 1', [`${TEXT}%`]).id;
  }
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require('../services/api-auth'));
  app.use('/api', require('../services/authority-guard').guard);
  app.use('/api/prepared-moves', require('./prepared-moves'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // A diary that has just synced, so the slot's fresh check can pass.
  db.run(`INSERT INTO calendar_cache (event_id, subject, start_time, end_time, show_as, source, fetched_at) VALUES ('sync-marker', 'Sync marker', '2020-01-01T09:00:00', '2020-01-01T09:30:00', 'busy', 'graph', CURRENT_TIMESTAMP)`);

  // Each copy is identical except who STARTED it. Prepared on duty, then walked through all four decisions.
  DUTY = { onDuty: true, why: 'working' };
  for (const c of ['manual', 'manual2']) {
    const p = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: `promise:${keyOf(c)}` } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    REC[c] = await interview(p.body.promiseMove);
  }
  {
    const p = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: `promise:${keyOf('mcp')}` }, token: true });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    REC.mcp = await interview(p.body.promiseMove, { token: true });
  }
  {
    const r = await planner.planAndStore({ ref: `promise:${keyOf('scan')}`, origin: 'scan' });
    assert.ok(r.ok && r.record, JSON.stringify(r));
    const m = require('../services/promise-moves').fromRecord(r.record);
    REC.scan = await interview(m);
  }
  DUTY = { onDuty: false, why: 'off-duty' };
});
test.after(() => { global.fetch = realFetch; server.close(); delete process.env.SAIM_PREPARED_MOVE_EXECUTION; try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

test('5. answering and parking re-plans with origin "answer" and KEEPS the immutable firstOrigin', () => {
  for (const [c, first] of [['manual', 'manual'], ['manual2', 'manual'], ['scan', 'scan'], ['mcp', 'mcp']]) {
    const rec = live(c);
    assert.equal(rec.version, 5, `${c}: prepared + four re-plans`);
    assert.equal(rec.packet.origin, 'answer', `${c}: the latest origin is the answer`);
    assert.equal(rec.packet.firstOrigin, first, `${c}: firstOrigin is still ${first}`);
    assert.ok(rec.packet.selected.privateDraft && rec.packet.selected.source.promiseKey, `${c}: a private promise draft`);
  }
  // The original version still says how it started (rows are immutable).
  const first = db.get('SELECT packet_json FROM prepared_moves WHERE move_key = ? AND version = 1', [REC.manual.moveKey]);
  assert.equal(JSON.parse(first.packet_json).origin, 'manual');
  // And the rule reads firstOrigin, never origin: the latest 'answer' alone earns nothing.
  const asAnswerOnly = { packet: { ...live('manual').packet, firstOrigin: 'answer' } };
  assert.equal(exec.dutyPermits({ onDuty: false, why: 'off-duty' }, asAnswerOnly), false);
  assert.equal(exec.dutyPermits({ onDuty: false, why: 'off-duty' }, live('manual')), true);
});

for (const c of ['scan', 'mcp']) {
  test(`${c === 'scan' ? '2' : '3'}. firstOrigin '${c}', off duty: held in the view, /request, /confirm and the executor`, async () => {
    DUTY = { onDuty: false, why: 'off-duty' };
    budget._test.reset(); budget._test.grantToday();
    process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
    const before = writes();
    try {
      const rec = live(c);
      assert.ok(held(await view(rec)), 'the view holds it: no options');
      const rq = await request(rec);
      assert.equal(rq.status, 409); assert.equal(rq.body.held, true, JSON.stringify(rq.body));
      const grantId = await grantOnDuty(rec);
      const cf = await confirm(rec, grantId);
      assert.equal(cf.status, 409); assert.equal(cf.body.held, true, JSON.stringify(cf.body));
      const grant2 = await grantOnDuty(rec);
      const ex = await exec.execute({ recordId: rec.id, option: 'approve', grantId: grant2, adapters: exec.liveAdapters() });
      assert.equal(ex.ok, false); assert.equal(ex.held, true, JSON.stringify(ex));
    } finally { delete process.env.SAIM_PREPARED_MOVE_EXECUTION; }
    assert.deepEqual(writes(), before, 'nothing written, booked or reserved');
  });
}

for (const why of ['leave', 'unknown']) {
  test(`4. ${why}: even the MANUAL private draft is held in the view, /request, /confirm and the executor`, async () => {
    budget._test.reset(); budget._test.grantToday();
    process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
    const before = writes();
    try {
      const rec = live('manual2');
      DUTY = { onDuty: false, why };
      assert.ok(held(await view(rec)), 'held in the view');
      const rq = await request(rec);
      assert.equal(rq.status, 409); assert.equal(rq.body.held, true);
      const grantId = await grantOnDuty(rec);
      const cf = await confirm(rec, grantId);
      assert.equal(cf.status, 409); assert.equal(cf.body.held, true);
      const grant2 = await grantOnDuty(rec);
      const ex = await exec.execute({ recordId: rec.id, option: 'approve', grantId: grant2, adapters: exec.liveAdapters() });
      assert.equal(ex.ok, false); assert.equal(ex.held, true);
    } finally { delete process.env.SAIM_PREPARED_MOVE_EXECUTION; DUTY = { onDuty: false, why: 'off-duty' }; }
    assert.deepEqual(writes(), before);
  });
}

test('1a. manual, off duty: the normal gates still refuse, in their own order — the server switch, a missing allowance, the stop', async () => {
  DUTY = { onDuty: false, why: 'off-duty' };
  const rec = live('manual');
  const before = writes();
  try {
    // The server switch off: refused at /request, nothing minted.
    budget._test.reset(); budget._test.grantToday();
    delete process.env.SAIM_PREPARED_MOVE_EXECUTION;
    const off = await request(rec);
    assert.equal(off.status, 409); assert.equal(off.body.gate, 'device', JSON.stringify(off.body));
    // Switch on, no allowance today: the allowance boundary.
    process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
    budget._test.reset();
    const noAllow = await request(rec);
    assert.equal(noAllow.status, 409); assert.equal(noAllow.body.gate, 'allowance', JSON.stringify(noAllow.body));
    // Allowance granted, a confirmation minted — then the stop: /confirm refuses and spends nothing.
    budget._test.grantToday();
    const ok = await request(rec);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    budget.stop({ now: Date.now() });
    const stopped = await confirm(rec, ok.body.grantId);
    assert.equal(stopped.status, 409); assert.equal(stopped.body.gate, 'stop', JSON.stringify(stopped.body));
  } finally { delete process.env.SAIM_PREPARED_MOVE_EXECUTION; budget._test.reset(); }
  assert.deepEqual(writes(), before, 'nothing written by a refused gate');
});

test('1b. manual, off duty, every gate open: requested, confirmed and EXECUTED — the note in Working drafts and a solo block, nobody invited', async () => {
  DUTY = { onDuty: false, why: 'off-duty' };
  budget._test.reset(); budget._test.grantToday();
  const rec = live('manual');
  const v = await view(rec);
  assert.ok(!held(v) && v.move.options.some((o) => o.id === 'approve'), `the view offers the save off duty (${JSON.stringify(v.held || null)})`);
  const ms = require('../services/microsoft'); const realToken = ms.getAccessToken; ms.getAccessToken = async () => 'fake-token';
  const events = fakeGraph();
  process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
  try {
    const rq = await request(rec);
    assert.equal(rq.status, 200, JSON.stringify(rq.body));
    assert.ok(rq.body.confirmation.writes.some((w) => /Working drafts: Projects\/Working\//.test(w)));
    const cf = await confirm(rec, rq.body.grantId);
    assert.equal(cf.status, 200, JSON.stringify(cf.body));
    const receipt = cf.body.receipt || cf.body;
    assert.equal(receipt.complete, true, JSON.stringify(receipt.steps));
    assert.deepEqual(receipt.steps.map((x) => x.step).sort(), ['calendar', 'note']);
    const [ev] = events.values();
    assert.deepEqual(ev.attendees, [], 'a solo block');
    assert.ok(fs.readdirSync(path.join(VAULT, 'Projects', 'Working')).some((f) => /private draft/.test(f)));
    // The one-use confirmation is spent: the same grant cannot be used again.
    const again = await confirm(rec, rq.body.grantId);
    assert.notEqual(again.status, 200);
  } finally { delete process.env.SAIM_PREPARED_MOVE_EXECUTION; ms.getAccessToken = realToken; global.fetch = realFetch; }
});
