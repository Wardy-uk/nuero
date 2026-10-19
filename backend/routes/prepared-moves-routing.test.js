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
const request = (body = {}) => post('request', { option: 'approve', sessionId: SESSION, ...body });
const confirm = (r, extra = {}) => post('confirm', { recordId: r.recordId, version: r.version, option: r.option, grantId: r.grantId, ...extra });

const graphWrites = () => G.calls.filter((c) => c.method !== 'GET');
const listVault = () => { const out = []; const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else out.push(path.relative(VAULT, p).split(path.sep).join('/')); } }; walk(VAULT); return out.sort(); };
function freshMove(edit) { variant += 1; S.packet = () => fixture(edit); }
function resetWorld() {
  G.events.clear(); G.calls.length = 0; G.next = null; G.mangle = null;
  S.over = {}; S.realDiary = false; S.adapterBuilds = 0; S.checkBuilds = 0;
  fs.rmSync(NOTE_ABS, { force: true });
  db.run(`DELETE FROM external_write_ledger WHERE idempotency_key LIKE 'saim-move:%'`);
  freshMove();
}
const withSwitch = async (fn) => { flags.setEnabled('saim_prepared_move_execution', true); try { return await fn(); } finally { flags.setEnabled('saim_prepared_move_execution', false); } };

// ── Default off ──────────────────────────────────────────────────────────────

test('default off: request shows the confirmation; confirm refuses before any adapter, check, write or grant spend', async () => {
  resetWorld();
  assert.equal(flags.isEnabled('saim_prepared_move_execution'), false, 'off by default');
  const before = listVault();
  const r = await request();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.executionEnabled, false);
  assert.equal(r.json.confirmation.question, `Reserve 30 minutes on ${exec.writesFor(fixture(), 'approve').confirmation.writes[0].match(/calendar, (.+?) 10:25/)[1]} (10:25–10:55) and save the draft?`);
  assert.match(r.json.confirmation.off, /switched off, so confirming will not write anything/);
  const buildsAfterRequest = S.adapterBuilds;
  const checksAfterRequest = S.checkBuilds;
  assert.equal(buildsAfterRequest, 0, 'a request never builds the live writers');

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

test('source: the routes reach only requestForMove and confirmMove; the executor holds no other writer', () => {
  const routes = fs.readFileSync(path.join(__dirname, 'prepared-moves.js'), 'utf8');
  assert.deepEqual([...routes.matchAll(/router\.(\w+)\('([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`), ['post /request', 'post /confirm']);
  assert.deepEqual([...routes.matchAll(/exec\(\)\.(\w+)\(/g)].map((m) => m[1]), ['requestForMove', 'confirmMove']);
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'prepared-move-exec.js'), 'utf8');
  assert.doesNotMatch(src, /sendMail|sendToAll|webpush|createTask|updateTask|moveEvent\(|cancelEvent\(|unlink|rmSync|renameSync|setInterval|cron|schedule\(/, 'no mail, push, task, move/cancel, delete, timer');
  assert.equal((src.match(/writeFileSync\(/g) || []).length, 1, 'one vault write call site');
  assert.match(src, /fs\.writeFileSync\(p, content, \{ flag: 'wx' \}\)/, 'and it never overwrites');
  assert.equal((src.match(/createEvent\(/g) || []).length, 1, 'one calendar create call site');
});
