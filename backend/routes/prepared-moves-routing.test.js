'use strict';

/**
 * POST /api/prepared-moves/{request,confirm} over real HTTP, through NEURO's
 * real api-auth and authority guard, with the real prepared_moves store, intent
 * grants, external-write ledger and executor. Only these are fakes:
 *   - the packet source (prepare) — a fixed fixture, so no live decision is read;
 *   - Graph, at the fetch layer (with a stubbed token), recording every request;
 *   - the vault — a temp folder as OBSIDIAN_VAULT_PATH, so routes/vault.js's
 *     real path guard is what runs;
 *   - the diary/leave/commitment readers, except where a test uses the real one.
 * Nothing touches Microsoft, the Pi or the real vault. Fixtures are dated off the
 * wall clock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-routes-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
for (const k of ['HA_TOKEN', 'HA_URL', 'SAIM_PREPARED_MOVE_EXECUTION']) delete process.env[k];
const FOLDER = path.join(VAULT, 'Projects', 'Support Improvement Plan');
fs.mkdirSync(FOLDER, { recursive: true });
fs.writeFileSync(path.join(FOLDER, 'SIP - Action Register.md'), 'Nick\'s register — never touched by these tests\n');

const db = require('../db/database');
const exec = require('../services/prepared-move-exec');
const ig = require('../services/intent-grants');
const flags = require('../services/feature-flags');

const DAY = 86400000;
const NOW = Date.now();
const ymd = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
const SLOT_DAY = ymd(NOW + 2 * DAY);
const FORUM_DAY = ymd(NOW + 3 * DAY);
const NOTE_REL = 'Projects/Support Improvement Plan/SIP - T1 Acceptance Criteria (draft).md';
const NOTE_ABS = path.join(VAULT, ...NOTE_REL.split('/'));
const TITLE = 'Triage and escalation criteria draft';
const SESSION = 'session_routes_0001';
const DRAFT = '# T1 — Triage and escalation acceptance criteria (DRAFT prepared by SAiM)\n\n## Every escalation must carry\n- Current customer ask\n';

let variant = 0;
function fixture(edit = () => {}) {
  const p = {
    contract: 'prepared-move-v1',
    decision: { decidedAt: new Date(NOW - 5 * 60000).toISOString() },
    duty: { onDuty: true, why: 'working' },
    selected: {
      title: 'Written criteria for what each team accepts',
      record: { system: 'planner', msId: 'PLANNER-ID-1', plan: 'Support Improvement Plan' },
      screens: { employment: { sensitive: false, categories: [] }, freshnessOk: true, recordUnique: true },
      preparation: [{ did: 'drafted', sideEffect: 'none', draft: `${DRAFT}\n<!-- v${variant} -->\n` }],
      decision: {
        slots: [{ id: 'approve', date: SLOT_DAY, start: '10:25', end: '10:55' }, { id: 'slot-1', date: SLOT_DAY, start: '15:30', end: '16:00' }],
        proposedWrites: [
          { kind: 'calendar.solo', title: TITLE, slot: 'chosen', attendees: [], body: 'Prepared by SAiM' },
          { kind: 'vault.note', path: NOTE_REL },
        ],
        forum: { title: 'Support Improvement Plan', start: `${FORUM_DAY}T16:00` },
      },
      verification: { checks: [] },
    },
  };
  edit(p);
  return p;
}

// ── fakes ────────────────────────────────────────────────────────────────────
const S = { packet: () => fixture(), over: {}, realDiary: false, adapterBuilds: 0, checkBuilds: 0 };
const okReaders = { diary: async () => ({ known: true, clashes: [] }), availability: async () => ({ known: true, off: false, working: true }), candidate: async () => ({ ok: true }) };
exec._setDeps({
  prepare: async () => S.packet(),
  readDuty: async () => S.duty || { onDuty: true, why: 'working' },
  liveAdapters: () => { S.adapterBuilds += 1; return exec.liveAdapters(); },
  defaultChecks: (opts) => {
    S.checkBuilds += 1;
    const real = exec.defaultChecks(opts);
    return { ...okReaders, noteState: real.noteState, ...(S.realDiary ? { diary: real.diary } : {}), ...S.over };
  },
});

const G = { events: new Map(), calls: [], next: null, mangle: null };
const MARKER = require('../services/calendar-read').MARKER_PROP;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url); const method = opts.method || 'GET';
  G.calls.push({ method, path: u.pathname, body: opts.body ? JSON.parse(opts.body) : null });
  const json = (status, body) => ({ status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  if (u.hostname !== 'graph.microsoft.com') throw new Error(`unexpected host ${u.hostname}`);
  if (method === 'POST' && u.pathname === '/v1.0/me/events') {
    if (G.next === 'reject') { G.next = null; return json(400, { error: { code: 'ErrorInvalidRequest' } }); }
    const b = JSON.parse(opts.body); const id = `evt${G.events.size + 1}`; G.events.set(id, { id, ...b });
    if (G.next === 'timeout-after') { G.next = null; const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; }
    return json(201, G.events.get(id));
  }
  if (method === 'GET' && u.pathname === '/v1.0/me/events') {
    const want = /ep\/value eq '([^']+)'/.exec(decodeURIComponent(u.search))[1];
    return json(200, { value: [...G.events.values()].filter((e) => (e.singleValueExtendedProperties || []).some((p) => p.id === MARKER && p.value === want)) });
  }
  const one = /^\/v1\.0\/me\/events\/([^/]+)$/.exec(u.pathname);
  if (method === 'GET' && one) {
    const e = G.events.get(decodeURIComponent(one[1]));
    if (!e) return json(404, {});
    return json(200, G.mangle === 'title' ? { ...e, subject: `${e.subject} (edited)` } : e);
  }
  return json(500, {});
};
const ms = require('../services/microsoft');
ms.getAccessToken = async () => 'fake-token';

// ── NEURO's real auth stack over HTTP ────────────────────────────────────────
let server; let base;
test.before(async () => {
  await db.init();
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
test.after(async () => { await new Promise((r) => server.close(r)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

const PIN = { 'X-NEURO-PIN': 'pin-1234' };
async function post(route, body, headers = PIN) {
  const r = await fetchLocal(`${base}/api/prepared-moves/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}
// The test's own HTTP client — global.fetch is the fake Graph.
function fetchLocal(url, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(s || '{}') }));
    });
    req.on('error', reject); req.end(body);
  });
}
const requestRaw = (body = {}) => post('request', { option: 'approve', sessionId: SESSION, ...body });
// 20 Oct 2026: a request is only answered with a confirmation when SAiM could
// act on a yes — lock open AND today's allowance. Most tests here are about
// what happens AFTER that, so `request` opens both for the request alone; the
// confirm then runs with the lock closed unless wrapped in withSwitch.
const request = (body = {}) => withSwitch(() => requestRaw(body));
const confirm = (r, extra = {}) => post('confirm', { recordId: r.recordId, version: r.version, option: r.option, grantId: r.grantId, ...extra });

const graphWrites = () => G.calls.filter((c) => c.method !== 'GET');
const listVault = () => { const out = []; const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else out.push(path.relative(VAULT, p).split(path.sep).join('/')); } }; walk(VAULT); return out.sort(); };
function freshMove(edit) { variant += 1; S.packet = () => fixture(edit); }
function resetWorld() {
  G.events.clear(); G.calls.length = 0; G.next = null; G.mangle = null;
  S.over = {}; S.realDiary = false; S.adapterBuilds = 0; S.checkBuilds = 0;
  fs.rmSync(NOTE_ABS, { force: true });
  db.run(`DELETE FROM external_write_ledger WHERE idempotency_key LIKE 'saim-move:%'`);
  budget._test.reset(); // every allowance back to zero
  freshMove();
}
const budget = require('../services/authority-budget');
// "Switched on" means BOTH gates: the device lock open AND an allowance for today.
// (The allowance persists across a retry inside one test; resetWorld clears it.)
// 20 Oct 2026: the device lock is env-only — the Pi's SAIM_PREPARED_MOVE_EXECUTION
// exactly 'true' — so the test opens it the one way production can.
const withSwitch = async (fn) => {
  const prior = process.env.SAIM_PREPARED_MOVE_EXECUTION;
  process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
  if (!budget.status().grant) budget._test.grantToday();
  try { return await fn(); } finally {
    if (prior === undefined) delete process.env.SAIM_PREPARED_MOVE_EXECUTION; else process.env.SAIM_PREPARED_MOVE_EXECUTION = prior;
  }
};

// ── Default off ──────────────────────────────────────────────────────────────

const counts = () => ({
  records: (db.get(`SELECT COUNT(*) n FROM sqlite_master WHERE name = 'prepared_moves'`).n ? db.get('SELECT COUNT(*) n FROM prepared_moves').n : 0),
  grants: db.get('SELECT COUNT(*) n FROM human_action_intents').n,
});

test('the boundary: lock closed or no allowance — the request stores no record, mints no confirmation, and names the one boundary', async () => {
  resetWorld();
  assert.equal(flags.isEnabled('saim_prepared_move_execution'), false, 'off by default');
  const before = counts();
  // Device lock closed (an allowance would not matter): the device is named.
  budget._test.grantToday();
  let r = await requestRaw();
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.gate, 'device'); assert.equal(r.json.boundary.gate, 'device');
  assert.equal(r.json.error, budget.BOUNDARY.device);
  assert.equal(r.json.grantId, undefined); assert.equal(r.json.confirmation, undefined);
  assert.deepEqual(counts(), before, 'nothing stored, nothing minted');
  // Lock open, no allowance: the allowance is named, and only it.
  budget._test.reset();
  process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
  try { r = await requestRaw(); } finally { delete process.env.SAIM_PREPARED_MOVE_EXECUTION; }
  assert.equal(r.status, 409); assert.equal(r.json.gate, 'allowance');
  assert.equal(r.json.error, budget.BOUNDARY.allowance);
  assert.deepEqual(counts(), before, 'nothing stored, nothing minted');
  assert.equal(S.adapterBuilds, 0); assert.equal(G.calls.length, 0);
});

test('a confirmation minted while open, used after the lock closed: refused before any adapter, check, write or grant spend', async () => {
  resetWorld();
  const before = listVault();
  const r = await request();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.executionEnabled, true);
  assert.equal(r.json.confirmation.question, `Reserve 30 minutes on ${exec.writesFor(fixture(), 'approve').confirmation.writes[0].match(/calendar, (.+?) 10:25/)[1]} (10:25–10:55) and save the draft?`);
  const checksAfterRequest = S.checkBuilds;
  assert.equal(S.adapterBuilds, 0, 'a request never builds the live writers');

  const c = await confirm(r.json);
  assert.equal(c.status, 409); assert.equal(c.json.disabled, true);
  assert.match(c.json.error, /switched off \(saim_prepared_move_execution\) — nothing was written and your confirmation was not used/);
  assert.equal(S.adapterBuilds, 0, 'no live adapter built');
  assert.equal(S.checkBuilds, checksAfterRequest, 'no fresh check run');
  assert.equal(G.calls.length, 0, 'Graph never called');
  assert.deepEqual(listVault(), before, 'vault unchanged');
  assert.equal(ig.get(r.json.grantId).consumed_at, null, 'the confirmation was not spent');
  assert.equal(db.get(`SELECT COUNT(*) n FROM external_write_ledger WHERE idempotency_key LIKE 'saim-move:%'`).n, 0, 'no ledger row');
});

// ── Machine callers ──────────────────────────────────────────────────────────

test('machine callers are refused on both routes — API token, declared machine, and in the gateway', async () => {
  resetWorld();
  for (const headers of [{ 'X-NEURO-API-TOKEN': 'tok-5678' }, { ...PIN, 'X-Neuro-Machine-Client': 'mcp-local' }]) {
    assert.equal((await post('request', { option: 'approve', sessionId: SESSION }, headers)).status, 403);
    assert.equal((await post('confirm', { recordId: 'pm_0123456789abcdef0123', version: 1, option: 'approve', grantId: `ig_${'a'.repeat(32)}` }, headers)).status, 403);
  }
  const m = require('../services/authority-matrix');
  assert.equal(m.CAPABILITIES['saim.prepared-move'].machine, 'refuse');
  const policy = fs.readFileSync(path.join(__dirname, '..', '..', 'mcp-server', 'remote', 'api-policy.js'), 'utf8');
  assert.match(policy, /post_prepared_moves_request:/); assert.match(policy, /post_prepared_moves_confirm:/);
});

// ── No other choice can be made through the routes ───────────────────────────

test('routes cannot choose a date, note path, recipient, title, body or write type — those fields are refused, not ignored', async () => {
  resetWorld();
  for (const extra of [{ date: '2026-12-25' }, { start: '09:00' }, { path: 'People/Mel.md' }, { notePath: 'x.md' }, { to: ['mel@example.test'] }, { attendees: ['x'] }, { title: 'Anything' }, { body: 'x' }, { type: 'email.send' }, { kind: 'calendar.solo' }, { writes: [] }]) {
    const r = await request(extra);
    assert.equal(r.status, 400, JSON.stringify(extra)); assert.match(r.json.error, /takes only option, surface, sessionId/);
  }
  assert.equal((await request({ option: 'tomorrow-at-9' })).status, 400);
  const notOffered = await request({ option: 'slot-7' });
  assert.equal(notOffered.status, 409); assert.match(notOffered.json.error, /not one of the times this move offered/);
  const r = await request();
  for (const extra of [{ date: SLOT_DAY }, { path: NOTE_REL }, { title: TITLE }, { to: [] }, { writeHash: 'x' }]) {
    const c = await confirm(r.json, extra);
    assert.equal(c.status, 400, JSON.stringify(extra)); assert.match(c.json.error, /takes only recordId, version, option, grantId/);
  }
  assert.equal(ig.get(r.json.grantId).consumed_at, null);
});

// ── Packets that must never be confirmable ───────────────────────────────────

test('stale, ambiguous and employment packets are refused at request — nothing is minted', async () => {
  const cases = [
    ['nothing selected (employment withheld)', () => ({ contract: 'prepared-move-v1', decision: { decidedAt: new Date(NOW).toISOString() }, selected: null, withheld: [{ title: 'Weekly risk report', reason: 'employment matter — routing only' }] }), /no prepared move to confirm right now — Weekly risk report: employment matter/],
    ['employment screen', () => fixture((x) => { x.selected.screens.employment = { sensitive: true, categories: ['hr-wording'] }; }), /employment matter/],
    ['draft reads as employment', () => fixture((x) => { x.selected.preparation[0].draft += '\n- the disciplinary outcome for Mel\n'; }), /employment matter/],
    ['ambiguous record', () => fixture((x) => { x.selected.screens.recordUnique = false; }), /exactly one record/],
    ['stale source', () => fixture((x) => { x.selected.screens.freshnessOk = false; }), /stale when it was prepared/],
    ['stale evidence', () => fixture((x) => { x.decision.decidedAt = new Date(NOW - 3 * 3600000).toISOString(); }), /expired/],
  ];
  for (const [name, packet, re] of cases) {
    resetWorld(); S.packet = packet;
    const grantsBefore = db.get('SELECT COUNT(*) n FROM human_action_intents').n;
    const r = await request();
    assert.equal(r.status, 409, name); assert.match(r.json.error, re, name);
    assert.equal(r.json.grantId, undefined, name);
    assert.equal(db.get('SELECT COUNT(*) n FROM human_action_intents').n, grantsBefore, `${name}: nothing minted`);
  }
});

test('stale diary, leave and an ambiguous commitment are refused at request AND at confirm', async () => {
  const fresh = new Date(NOW - 5 * 60000).toISOString().replace('T', ' ').slice(0, 19);
  const stale = new Date(NOW - 40 * 60000).toISOString().replace('T', ' ').slice(0, 19);
  const cases = [
    ['stale diary (real reader)', () => { S.realDiary = true; db.run('DELETE FROM calendar_cache'); db.run(`INSERT INTO calendar_cache (event_id, subject, start_time, end_time, is_all_day, show_as, fetched_at, source) VALUES ('x','x',?,?,0,'busy',?,'graph')`, [`${SLOT_DAY}T08:00:00`, `${SLOT_DAY}T08:30:00`, stale]); }, /has not synced in the last 15 minutes/],
    ['clash (real reader)', () => { S.realDiary = true; db.run('DELETE FROM calendar_cache'); db.run(`INSERT INTO calendar_cache (event_id, subject, start_time, end_time, is_all_day, show_as, fetched_at, source, attendees_other, is_organizer) VALUES ('y','1-2-1',?,?,0,'busy',?,'graph',1,1)`, [`${SLOT_DAY}T10:30:00`, `${SLOT_DAY}T11:00:00`, fresh]); }, /no longer free/],
    ['leave', () => { S.over.availability = async () => ({ known: true, off: true, working: true }); }, /now booked off/],
    ['leave unknown', () => { S.over.availability = async () => ({ known: false, why: 'roster empty' }); }, /couldn’t check your leave/],
    ['ambiguous commitment', () => { S.over.candidate = async () => ({ ok: false, why: 'the commitment is now ambiguous — more than one record carries its words' }); }, /now ambiguous/],
  ];
  for (const [name, arrange, re] of cases) {
    // At request.
    resetWorld(); arrange();
    const r = await request();
    assert.equal(r.status, 409, name); assert.match(r.json.error, re, name);
    // At confirm: valid when requested, the world changes before the yes.
    resetWorld();
    const ok = await request(); assert.equal(ok.status, 200, name);
    arrange();
    const c = await withSwitch(() => confirm(ok.json));
    assert.equal(c.status, 409, name); assert.match(c.json.error, re, name);
    assert.deepEqual(graphWrites(), [], `${name}: no Graph write`);
    assert.equal(fs.existsSync(NOTE_ABS), false, `${name}: no note`);
  }
  db.run('DELETE FROM calendar_cache');
});

// ── Binding ──────────────────────────────────────────────────────────────────

test('the confirmation binds to move, version, option and write hash', async () => {
  // Another option.
  resetWorld();
  let r = await request();
  let c = await withSwitch(() => confirm({ ...r.json, option: 'slot-1' }));
  assert.equal(c.status, 409); assert.match(c.json.error, /changed since it was shown/);
  // Another version: the move is prepared again with different content.
  resetWorld();
  r = await request();
  freshMove(); const v2 = await request(); assert.equal(v2.json.version, r.json.version + 1);
  c = await withSwitch(() => confirm(r.json));
  assert.equal(c.status, 409); assert.match(c.json.error, /changed since it was shown/);
  // A version number that is not the record's.
  c = await withSwitch(() => confirm({ ...v2.json, version: v2.json.version + 5 }));
  assert.equal(c.status, 409);
  // A grant minted for one record cannot run another.
  resetWorld();
  const a = await request(); freshMove(); const b = await request();
  c = await withSwitch(() => confirm({ ...b.json, grantId: a.json.grantId }));
  assert.equal(c.status, 409);
  // The stored grant names the record, its version and the exact write hash.
  const g = ig.get(b.json.grantId);
  assert.equal(g.action_capability, 'saim.prepared-move');
  assert.equal(g.action_id, b.json.recordId); assert.equal(Number(g.action_version), b.json.version); assert.equal(g.payload_hash, b.json.writeHash);
  assert.ok(b.json.moveKey.startsWith('saim-move:planner:PLANNER-ID-1@'));
  assert.deepEqual(graphWrites(), []);
});

// ── The only writes possible ─────────────────────────────────────────────────

test('switched on: exactly one attendee-free create-event with marker and transaction id, and one new note in the pinned folder', async () => {
  resetWorld();
  const before = listVault();
  const r = await request();
  const c = await withSwitch(() => confirm(r.json));
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.receipt.complete, true);
  assert.deepEqual(c.json.receipt.contacted, []);
  const w = graphWrites();
  assert.equal(w.length, 1, 'one Graph write');
  assert.equal(w[0].method, 'POST'); assert.equal(w[0].path, '/v1.0/me/events');
  assert.deepEqual(w[0].body.attendees, [], 'nobody invited');
  assert.equal(w[0].body.subject, TITLE);
  assert.ok(w[0].body.transactionId, 'transaction id');
  assert.equal(w[0].body.singleValueExtendedProperties[0].value, r.json.moveKey, 'NEURO marker');
  const after = listVault();
  assert.deepEqual(after.filter((f) => !before.includes(f)), [NOTE_REL], 'one new file, in the pinned folder');
  assert.equal(before.filter((f) => !after.includes(f)).length, 0);
  assert.equal(fs.readFileSync(path.join(FOLDER, 'SIP - Action Register.md'), 'utf8'), 'Nick\'s register — never touched by these tests\n');

  // Idempotent: request + confirm again writes nothing.
  const again = await request();
  const c2 = await withSwitch(() => confirm(again.json));
  assert.deepEqual(c2.json.receipt.steps.map((s) => s.status), ['already-done', 'already-done']);
  assert.equal(graphWrites().length, 1);
  assert.deepEqual(listVault(), after);
  // A spent confirmation cannot be replayed.
  const replay = await withSwitch(() => confirm(r.json));
  assert.equal(replay.status, 409); assert.match(replay.json.error, /already been used/);
});

test('never an overwrite: an existing note at the path is refused at request and at confirm, untouched', async () => {
  resetWorld();
  fs.writeFileSync(NOTE_ABS, 'Nick started this himself');
  const r = await request();
  assert.equal(r.status, 409); assert.match(r.json.error, /won’t overwrite/);
  fs.rmSync(NOTE_ABS);
  const ok = await request();
  fs.writeFileSync(NOTE_ABS, 'Nick started this himself');
  const c = await withSwitch(() => confirm(ok.json));
  assert.equal(c.status, 409); assert.match(c.json.error, /won’t overwrite/);
  assert.equal(fs.readFileSync(NOTE_ABS, 'utf8'), 'Nick started this himself');
  assert.deepEqual(graphWrites(), []);
});

test('a timeout after Graph created the block: reported as uncertain, found by marker on retry, never created twice', async () => {
  resetWorld();
  G.next = 'timeout-after';
  const r = await request();
  const c = await withSwitch(() => confirm(r.json));
  assert.equal(c.json.receipt.steps[0].status, 'failed');
  assert.equal(c.json.receipt.steps[0].provablyNotApplied, false);
  assert.match(c.json.receipt.plain, /may not have been saved/);
  const again = await request();
  const c2 = await withSwitch(() => confirm(again.json));
  assert.equal(c2.json.receipt.steps[0].status, 'already-done');
  assert.equal(G.events.size, 1); assert.equal(graphWrites().length, 1);
});

test('read-back mismatch: the block is reported unverified, never papered over, and not created again', async () => {
  resetWorld();
  G.mangle = 'title';
  const r = await request();
  const c = await withSwitch(() => confirm(r.json));
  assert.equal(c.json.receipt.complete, false);
  assert.equal(c.json.receipt.steps[0].status, 'unverified');
  assert.ok(c.json.receipt.steps[0].verified.some((v) => v.what === 'title matches' && v.ok === false));
  assert.match(c.json.receipt.plain, /did not read back as confirmed/);
  const again = await request();
  await withSwitch(() => confirm(again.json));
  assert.equal(graphWrites().length, 1, 'no second block');
});

test('partial: the calendar refuses, the note lands — the note stays and a retry makes only the block', async () => {
  resetWorld();
  G.next = 'reject';
  const r = await request();
  const c = await withSwitch(() => confirm(r.json));
  assert.deepEqual(c.json.receipt.steps.map((s) => s.status), ['failed', 'done']);
  assert.equal(c.json.receipt.steps[0].provablyNotApplied, true);
  assert.match(c.json.receipt.plain, /The calendar block was not saved: .* The note is saved and stays\./);
  const note = fs.readFileSync(NOTE_ABS, 'utf8');
  const again = await request();
  const c2 = await withSwitch(() => confirm(again.json));
  assert.deepEqual(c2.json.receipt.steps.map((s) => s.status), ['done', 'already-done']);
  assert.equal(G.events.size, 1);
  assert.equal(fs.readFileSync(NOTE_ABS, 'utf8'), note, 'the note is not rewritten');
  const rows = db.all(`SELECT idempotency_key k, status, attempts FROM external_write_ledger WHERE idempotency_key LIKE 'saim-move:%' ORDER BY id`);
  assert.deepEqual(rows.map((x) => [x.k.split(':').pop(), x.status, x.attempts]), [['calendar', 'confirmed', 2], ['note', 'confirmed', 1]]);
});

// ── Nothing else is reachable ────────────────────────────────────────────────

test('source: the routes reach only the view (read), the planner + store (proposals), requestForMove and confirmMove; the executor holds no other writer', () => {
  const routes = fs.readFileSync(path.join(__dirname, 'prepared-moves.js'), 'utf8');
  assert.deepEqual([...routes.matchAll(/router\.(\w+)\('([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`), ['get /current', 'get /eligible', 'get /promises', 'post /prepare', 'post /respond', 'post /answer', 'post /request', 'post /confirm']);
  assert.deepEqual([...routes.matchAll(/exec\(\)\.(\w+)\(/g)].map((m) => m[1]), ['requestForMove', 'confirmMove']);
  assert.deepEqual([...new Set([...routes.matchAll(/view\(\)\.(\w+)\(/g)].map((m) => m[1]))].sort(), ['currentView', 'v2View']);
  assert.deepEqual([...new Set([...routes.matchAll(/planner\(\)\.(\w+)\(/g)].map((m) => m[1]))].sort(), ['eligibleNow', 'moveKeyFor', 'planAndStore'], 'proposals, a PURE key and a read only — the planner writes nothing outside NEURO');
  assert.deepEqual([...new Set([...routes.matchAll(/pstore\(\)\.(\w+)\(/g)].map((m) => m[1]))].sort(), ['addAnswer', 'respond', 'withdrawAnswer'], 'answers (append-only, incl. a withdrawal) and responses — all inside NEURO');
  const viewSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'prepared-move-view.js'), 'utf8');
  assert.doesNotMatch(viewSrc, /\.store\(|mintForPreparedMove|requestConfirmation|\.execute\(|liveAdapters|writeNew|createEvent|setState|db\.run/, 'the view stores, mints and writes nothing');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'prepared-move-exec.js'), 'utf8');
  assert.doesNotMatch(src, /sendMail|sendToAll|webpush|createTask|updateTask|moveEvent\(|cancelEvent\(|unlink|rmSync|renameSync|setInterval|cron|schedule\(/, 'no mail, push, task, move/cancel, delete, timer');
  assert.equal((src.match(/writeFileSync\(/g) || []).length, 1, 'one vault write call site');
  assert.match(src, /fs\.writeFileSync\(p, content, \{ flag: 'wx' \}\)/, 'and it never overwrites');
  assert.equal((src.match(/createEvent\(/g) || []).length, 1, 'one calendar create call site');
});

// ── Off duty / on leave: prepared, HELD, never offered to commit ─────────────

const HELD_SAY = 'I’ve prepared this for your next working morning.';
const view = require('../services/prepared-move-view');
const pmRows = () => { try { return db.get('SELECT COUNT(*) n FROM prepared_moves').n; } catch { return 0; } };
const grantRows = () => db.get('SELECT COUNT(*) n FROM human_action_intents').n;
const ledgerRows = () => db.get(`SELECT COUNT(*) n FROM external_write_ledger WHERE idempotency_key LIKE 'saim-move:%'`).n;
const okChecks = () => ({ diary: async () => ({ known: true, clashes: [] }), availability: async () => ({ known: true, off: false, working: true }), candidate: async () => ({ ok: true }), noteState: async () => ({ known: true, exists: false }) });
const noChecks = () => { throw new Error('a held move must not run fresh checks'); };
const HOUR = 3600000;
// Words that commit work or speak of execution — none may appear while held.
const COMMIT_WORDS = /Reserve|minutes on|Ask to confirm|confirm|Changes aren|enabled|calendar block|Save note/i;

async function assertHeld(name, duty) {
  resetWorld();
  freshMove((x) => { x.duty = duty; x.selected.observed = [{ id: 'planner', fact: 'It is a card on the Planner board, open, due 16 Oct.', source: { kind: 'planner-mirror', observedAt: new Date(NOW).toISOString() } }]; });
  const before ={ pm: pmRows(), grants: grantRows(), ledger: ledgerRows(), vault: listVault() };
  // The Surface read: held, one sentence, the draft and evidence folded behind it.
  const v = await view.currentView({ deps: { prepare: async () => S.packet(), checks: noChecks } });
  assert.equal(v.held && v.held.say, HELD_SAY, `${name}: held sentence`);
  assert.equal(v.held.reason, duty ? duty.why : 'unknown', `${name}: reason`);
  assert.equal(v.move.prepared.headline, HELD_SAY);
  assert.deepEqual(v.move.options, [], `${name}: no time choices`);
  for (const k of ['contacts', 'nothingElse', 'notOffered', 'evidenceExpiresAt', 'forum']) assert.equal(k in v.move, false, `${name}: no ${k}`);
  assert.doesNotMatch(JSON.stringify({ held: v.held, prepared: v.move.prepared, options: v.move.options }), COMMIT_WORDS, `${name}: no commitment or execution language`);
  assert.match(v.move.draft.markdown, /Triage and escalation acceptance criteria/, `${name}: the draft can be seen`);
  assert.ok(v.move.evidence.length > 0, `${name}: the evidence can be seen`);
  assert.equal(v.readOnlyPass.writesRefused, 0);
  // An explicit later request can inspect, never confirm.
  const r = await request();
  assert.equal(r.status, 409, name); assert.equal(r.json.held, true, name);
  assert.equal(r.json.error, HELD_SAY, `${name}: the refusal is the held sentence, no confirmation wording`);
  assert.equal(r.json.grantId, undefined);
  assert.deepEqual({ pm: pmRows(), grants: grantRows(), ledger: ledgerRows(), vault: listVault() }, before, `${name}: nothing stored, minted, ledgered or written`);
  assert.equal(G.calls.length, 0, `${name}: Graph never called`);
}

test('off duty (evening / weekend — life says not working): prepared but HELD; nothing to commit, nothing minted', async () => {
  await assertHeld('evening', { onDuty: false, why: 'off-duty' });
});

test('on leave: HELD, whatever the time of day', async () => {
  await assertHeld('leave', { onDuty: false, why: 'leave' });
});

test('unknown (no life read, or a packet that does not say): HELD — fails closed', async () => {
  await assertHeld('no duty on packet', undefined);
  await assertHeld('unknown', { onDuty: false, why: 'unknown' });
});

test('dutyFor: leave beats everything; only a positive "working" read is on duty', () => {
  const { dutyFor } = require('../services/prepared-move');
  assert.deepEqual(dutyFor({ life: { showWork: true }, leave: { off: true } }), { onDuty: false, why: 'leave' });
  assert.deepEqual(dutyFor({ life: { showWork: false } }), { onDuty: false, why: 'off-duty' });
  assert.deepEqual(dutyFor({ life: null }), { onDuty: false, why: 'unknown' });
  assert.deepEqual(dutyFor({ life: { showWork: 'yes' } }), { onDuty: false, why: 'unknown' });
  assert.deepEqual(dutyFor({ life: { showWork: true } }), { onDuty: true, why: 'working' });
});

test('a confirmation minted in working hours cannot be used once he is off duty — refused before any record, check or write', async () => {
  resetWorld();
  const r = await request();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await withSwitch(async () => {
    S.duty = { onDuty: false, why: 'off-duty' };
    try {
      const checks = S.checkBuilds;
      const c = await confirm(r.json);
      assert.equal(c.status, 409); assert.equal(c.json.held, true); assert.equal(c.json.error, HELD_SAY);
      assert.equal(S.adapterBuilds, 0, 'no live adapter built');
      assert.equal(S.checkBuilds, checks, 'no fresh check run');
      assert.equal(ig.get(r.json.grantId).consumed_at, null, 'the confirmation was not spent');
      assert.equal(graphWrites().length, 0); assert.equal(fs.existsSync(NOTE_ABS), false);
      assert.equal(ledgerRows(), 0);
    } finally { S.duty = null; }
  });
});

test('the next working morning: the same move is prepared afresh, re-checked, and only then offered', async () => {
  resetWorld();
  // Evening: held.
  freshMove((x) => { x.duty = { onDuty: false, why: 'off-duty' }; });
  const evening = await view.currentView({ deps: { prepare: async () => S.packet(), checks: noChecks } });
  assert.equal(evening.held.say, HELD_SAY);
  // Morning: a fresh preparation (fresh decision time, on duty) and fresh checks.
  let checked = 0;
  freshMove();
  const morning = await view.currentView({ deps: { prepare: async () => S.packet(), checks: () => { checked += 1; return okChecks(); } } });
  assert.equal(checked, 1, 'fresh checks ran before anything was offered');
  assert.equal(morning.held, undefined);
  assert.ok(morning.move.options.length > 0);
  assert.match(morning.move.options[0].question, /^Reserve 30 minutes on /);
  assert.match(morning.move.prepared.headline, /^I’ve drafted /);
  const r = await request();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.grantId, 'actionable now');
});

test('stale evidence across the boundary: an evening preparation is not offered in the morning — nothing minted', async () => {
  resetWorld();
  // On duty in the morning, but the packet was decided the evening before (13 h).
  freshMove((x) => { x.decision.decidedAt = new Date(NOW - 13 * HOUR).toISOString(); });
  const v = await view.currentView({ deps: { prepare: async () => S.packet(), checks: okChecks } });
  assert.deepEqual(v.move.options, [], 'no time is offered on old evidence');
  assert.ok(v.move.notOffered.length > 0);
  for (const n of v.move.notOffered) assert.match(n.why, /expired/);
  const grants = grantRows();
  const r = await request();
  assert.equal(r.status, 409); assert.match(r.json.error, /expired/);
  assert.equal(grantRows(), grants, 'nothing minted');
});

test('an employment-sensitive move is never shown — not even as held — and is refused as itself', async () => {
  resetWorld();
  freshMove((x) => { x.duty = { onDuty: false, why: 'off-duty' }; x.selected.screens.employment = { sensitive: true, categories: ['hr-wording'] }; });
  const v = await view.currentView({ deps: { prepare: async () => S.packet(), checks: noChecks } });
  assert.equal(v.move, null); assert.equal(v.held, undefined);
  assert.equal(v.unavailable.reason, 'nothing-prepared');
  const grants = grantRows();
  const r = await request();
  assert.equal(r.status, 409); assert.match(r.json.error, /employment matter/);
  assert.notEqual(r.json.held, true);
  assert.equal(grantRows(), grants);
});
