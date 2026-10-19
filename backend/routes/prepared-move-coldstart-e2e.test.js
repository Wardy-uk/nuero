'use strict';

/**
 * COLD START, end to end (19 Oct 2026). The client's own read-with-retry
 * (saim/app/src/preparedMove.mjs) against NEURO's real api-auth, authority
 * guard and prepared-moves route over HTTP. The preparation is made genuinely
 * slow for its first calls — as on a cold backend — so the server answers
 * `pending`; the client must ask again quietly and the move must appear WITHOUT
 * a reload. Throughout: no packet stored, no confirmation minted, no ledger row,
 * no vault change and no outbound network call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-cold-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
process.env.SAIM_PREPARED_MOVE_EXECUTION = 'false';
for (const k of ['HA_TOKEN', 'HA_URL']) delete process.env[k];
fs.mkdirSync(path.join(VAULT, 'Projects', 'Support Improvement Plan'), { recursive: true });
fs.writeFileSync(path.join(VAULT, 'Projects', 'Support Improvement Plan', 'SIP - Action Register.md'), '| ID | Action |\n|---|---|\n| T1 | Publish triage and escalation acceptance criteria |\n');

// The client talks to the test server with the REAL fetch; anything the server
// tries to send out goes through this trap and is counted.
const clientFetch = global.fetch;
const outbound = [];
global.fetch = async (u) => { outbound.push(String(u)); throw new Error('network refused in this test'); };

const db = require('../db/database');
const view = require('../services/prepared-move-view');

const DAY = 86400000;
const NOW = Date.now();
const ymd = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
const SLOT_DAY = ymd(NOW + 2 * DAY);
const FORUM_DAY = ymd(NOW + 3 * DAY);
const NOTE_REL = 'Projects/Support Improvement Plan/SIP - T1 Acceptance Criteria (draft).md';
const packet = () => ({
  contract: 'prepared-move-v1',
  decision: { decidedAt: new Date(Date.now() - 60000).toISOString() },
  duty: { onDuty: true, why: 'working' },
  selected: {
    title: 'Written criteria for what each team accepts',
    record: { system: 'planner', msId: 'PLANNER-ID-1', plan: 'Support Improvement Plan' },
    subject: { id: 'T1', action: 'Publish triage and escalation acceptance criteria for every team, with rejections stating what is missing', project: 'Support Improvement Plan' },
    screens: { employment: { sensitive: false, categories: [] }, freshnessOk: true, recordUnique: true },
    observed: [{ id: 'line:a:1', fact: '"every escalation must show the current customer ask"', source: { kind: 'vault', observedAt: new Date().toISOString() } }],
    judgement: { summary: 'T1 has passed two dates with no draft in the vault.', confidence: 'moderate', because: [] },
    outcome: { goal: 'Arrive with it drafted.' }, authority: { mustNot: ['Email anyone'] },
    preparation: [{ did: 'drafted', sideEffect: 'none', draft: '# T1 — Triage and escalation acceptance criteria (DRAFT prepared by SAiM)\n\n## What each team accepts\n| Team | Accepts when | Rejects with |\n|---|---|---|\n| Customer Care | _to agree_ | _to agree_ |\n' }],
    decision: {
      slots: [{ id: 'approve', date: SLOT_DAY, start: '10:25', end: '10:55' }],
      proposedWrites: [{ kind: 'calendar.solo', title: 'Triage and escalation criteria draft', slot: 'chosen', attendees: [], body: 'Prepared by SAiM' }, { kind: 'vault.note', path: NOTE_REL }],
      forum: { title: 'Support Improvement Plan', start: `${FORUM_DAY}T16:00` },
    },
    verification: { checks: [] },
  },
  withheld: [],
});

// A COLD backend: the first `coldCalls` preparations genuinely take longer than the budget.
const S = { coldCalls: 0, calls: 0, absent: false };
view._setDeps({
  prepare: async () => {
    S.calls += 1;
    if (S.calls <= S.coldCalls) await new Promise((r) => setTimeout(r, view.BUDGET_MS + 150));
    return S.absent ? { contract: 'prepared-move-v1', decision: { decidedAt: new Date().toISOString() }, selected: null, withheld: [] } : packet();
  },
  checks: () => ({ diary: async () => ({ known: true, clashes: [] }), availability: async () => ({ known: true, off: false, working: true }), candidate: async () => ({ ok: true }), noteState: async () => ({ known: true, exists: false }) }),
});

let server; let base; let flow; const requests = [];
test.before(async () => {
  await db.init();
  flow = await import(pathToFileURL(path.resolve(__dirname, '..', '..', 'saim', 'app', 'src', 'preparedMove.mjs')).href);
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { requests.push(`${req.method} ${req.path}`); next(); });
  app.use('/api', require('../services/api-auth'));
  app.use('/api', require('../services/authority-guard').guard);
  app.use('/api/prepared-moves', require('./prepared-moves'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

const call = () => flow.makeCall({ fetchImpl: clientFetch, apiUrl: (p) => `${base}${p}`, authHeaders: () => ({ 'Content-Type': 'application/json', 'X-Neuro-Pin': 'pin-1234' }) });
function fingerprint() {
  const tables = db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
  const rows = {}; for (const t of tables) { try { const r = db.get(`SELECT COUNT(*) n, MAX(rowid) m FROM "${t}"`); rows[t] = `${r.n}/${r.m}`; } catch { rows[t] = 'n/a'; } }
  const files = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const st = fs.statSync(p); files.push(`${path.relative(VAULT, p)}|${st.size}|${st.mtimeMs}`); } } }; walk(VAULT);
  return JSON.stringify({ rows, files: files.sort() });
}

test('cold start: the first reads are pending, the client asks again quietly, and the real move appears without a reload — nothing written or sent', async () => {
  S.coldCalls = 2; S.calls = 0; S.absent = false; requests.length = 0; outbound.length = 0;
  const before = fingerprint();
  const seen = [];
  const t0 = Date.now();
  const s = await flow.loadWithRetry(call(), { onState: (x) => seen.push(x.kind) });
  const tookMs = Date.now() - t0;
  assert.equal(s.kind, 'ready', JSON.stringify(s));
  assert.equal(s.view.move.prepared.headline.startsWith('I’ve drafted triage and escalation acceptance criteria for Support Improvement Plan on '), true);
  assert.deepEqual(seen, ['pending', 'pending'], 'two quiet pending answers before the move');
  assert.deepEqual(requests, ['GET /api/prepared-moves/current', 'GET /api/prepared-moves/current', 'GET /api/prepared-moves/current'], 'three reads, no request or confirm');
  assert.ok(tookMs >= 1500 + 3000 && tookMs < 15000, `appeared after ${tookMs} ms`);
  assert.equal(fingerprint(), before, 'no table row and no vault file changed');
  assert.ok(!db.get(`SELECT 1 x FROM sqlite_master WHERE name='prepared_moves'`), 'no packet stored');
  assert.equal(db.get('SELECT COUNT(*) n FROM human_action_intents').n, 0, 'no confirmation minted');
  assert.deepEqual(outbound, [], 'no outbound network call');
  console.log(`  cold start: move appeared after ${tookMs} ms (${requests.length} reads)`);
});

test('a genuine "nothing prepared" is final: one read, no retry, nothing shown', async () => {
  S.coldCalls = 0; S.calls = 0; S.absent = true; requests.length = 0;
  const s = await flow.loadWithRetry(call(), { sleep: async () => assert.fail('must not wait to retry') });
  assert.equal(s.kind, 'hidden'); assert.equal(s.why, 'nothing-prepared');
  assert.equal(requests.length, 1);
});

test('a backend that never warms up: bounded retries, then quiet — never a loop', async () => {
  S.coldCalls = 99; S.calls = 0; S.absent = false; requests.length = 0;
  const waits = [];
  const s = await flow.loadWithRetry(call(), { sleep: async (ms) => { waits.push(ms); } });
  assert.equal(s.kind, 'hidden'); assert.equal(s.why, 'still-pending');
  assert.deepEqual(waits, [...flow.PENDING_RETRY_DELAYS_MS]);
  assert.equal(requests.length, 1 + flow.PENDING_RETRY_DELAYS_MS.length);
});
