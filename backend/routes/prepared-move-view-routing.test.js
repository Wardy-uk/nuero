'use strict';

/**
 * GET /api/prepared-moves/current — the read the approval surface is built on.
 * Real HTTP through NEURO's api-auth and authority guard; the packet source and
 * the diary/leave/commitment readers are fakes. Proves it STORES NOTHING and
 * MINTS NOTHING, offers only times that pass the fresh checks now, and never
 * names a withheld item.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-view-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
process.env.SAIM_PREPARED_MOVE_EXECUTION = 'false'; // as on the Pi: environment-locked off
for (const k of ['HA_TOKEN', 'HA_URL']) delete process.env[k];
fs.mkdirSync(path.join(VAULT, 'Projects', 'Support Improvement Plan'), { recursive: true });
global.fetch = async (u) => { throw new Error(`no network in this test (${u})`); };

const db = require('../db/database');
const view = require('../services/prepared-move-view');
const exec = require('../services/prepared-move-exec');

const DAY = 86400000;
const NOW = Date.now();
const ymd = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
const SLOT_DAY = ymd(NOW + 2 * DAY);
const FORUM_DAY = ymd(NOW + 3 * DAY);
const NOTE_REL = 'Projects/Support Improvement Plan/SIP - T1 Acceptance Criteria (draft).md';
const DRAFT = [
  '# T1 — Triage and escalation acceptance criteria (DRAFT prepared by SAiM)',
  '', '## Every escalation must carry', '- Current customer ask', '  _from Projects/Support Improvement Plan/Review.md:12_',
  '', '## What each team accepts', '| Team | Accepts when | Rejects with |', '|---|---|---|',
  '| Customer Care | _to agree_ | _to agree_ |', '| Production | _to agree_ | _to agree_ |',
  '', '## Open questions for the meeting', '- Does the consolidation change who receives escalations? _from Meetings/2026/10/x.md:4_',
].join('\n');

function fixture(edit = () => {}) {
  const p = {
    contract: 'prepared-move-v1',
    decision: { decidedAt: new Date(NOW - 5 * 60000).toISOString() },
    duty: { onDuty: true, why: 'working' },
    selected: {
      title: 'Written criteria for what each team accepts',
      record: { system: 'planner', msId: 'PLANNER-ID-1', plan: 'Support Improvement Plan' },
      subject: { id: 'T1', action: 'Publish triage and escalation acceptance criteria for every team, with rejections stating what is missing', project: 'Support Improvement Plan' },
      screens: { employment: { sensitive: false, categories: [] }, freshnessOk: true, recordUnique: true },
      observed: [
        { id: 'planner', fact: 'It is a card on the Planner board, open, due 16 Oct.', source: { kind: 'planner-mirror', observedAt: new Date(NOW).toISOString() } },
        { id: 'line:a:1', fact: '"every escalation must show the current customer ask"', source: { kind: 'vault', observedAt: new Date(NOW).toISOString() } },
        { id: 'line:b:2', fact: '"criteria for Customer Care, Production and Tier 2."', source: { kind: 'vault', observedAt: new Date(NOW).toISOString() } },
      ],
      judgement: { summary: 'T1 has passed two dates with no draft in the vault.', confidence: 'moderate', because: ['Its Planner date has passed (observed).'] },
      outcome: { goal: 'Arrive with T1 drafted.', doneWhen: 'Agreed in the meeting.' },
      authority: { mustNot: ['Email anyone'] },
      preparation: [{ did: 'drafted', sideEffect: 'none', draft: DRAFT }],
      decision: {
        slots: [{ id: 'approve', date: SLOT_DAY, start: '10:25', end: '10:55' }, { id: 'slot-1', date: SLOT_DAY, start: '15:30', end: '16:00' }],
        proposedWrites: [
          { kind: 'calendar.solo', title: 'Triage and escalation criteria draft', slot: 'chosen', attendees: [], body: 'Prepared by SAiM' },
          { kind: 'vault.note', path: NOTE_REL },
        ],
        forum: { title: 'Support Improvement Plan', start: `${FORUM_DAY}T16:00` },
      },
      verification: { checks: [] },
    },
    withheld: [{ title: 'Weekly risk report', reason: 'employment matter — routing only' }],
  };
  edit(p);
  return p;
}

const S = { packet: () => fixture(), over: {} };
view._setDeps({
  prepare: async () => S.packet(),
  checks: ({ now }) => {
    const real = exec.defaultChecks({ adapters: { vault: exec.readOnlyVault() }, now });
    return { diary: async () => ({ known: true, clashes: [] }), availability: async () => ({ known: true, off: false, working: true }), candidate: async () => ({ ok: true }), noteState: real.noteState, ...S.over };
  },
});
// /request too, so the question wording can be compared with the view's.
exec._setDeps({
  prepare: async () => S.packet(),
  defaultChecks: () => ({ diary: async () => ({ known: true, clashes: [] }), availability: async () => ({ known: true, off: false, working: true }), candidate: async () => ({ ok: true }), noteState: async () => ({ known: true, exists: false }) }),
});

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

function req(method, route, headers = { 'X-NEURO-PIN': 'pin-1234' }, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(`${base}/api/prepared-moves/${route}`, { method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s || '{}') }));
    });
    r.on('error', reject); r.end(body ? JSON.stringify(body) : undefined);
  });
}
const get = (h) => req('GET', 'current', h);
const counts = () => ({
  table: Boolean(db.get(`SELECT 1 x FROM sqlite_master WHERE name='prepared_moves'`)),
  grants: db.get('SELECT COUNT(*) n FROM human_action_intents').n,
  ledger: db.get('SELECT COUNT(*) n FROM external_write_ledger').n,
});

test('a trustworthy move: what was prepared, why, what is unresolved, the exact writes — and nothing stored or minted', async () => {
  S.packet = () => fixture(); S.over = {};
  const before = counts();
  const r = await get();
  assert.equal(r.status, 200);
  const v = r.json;
  assert.equal(v.contract, 'prepared-move-view-v1');
  assert.deepEqual(v.execution, { enabled: false, lockedByEnv: true, envVar: 'SAIM_PREPARED_MOVE_EXECUTION', flag: 'saim_prepared_move_execution' });
  const m = v.move;
  assert.match(m.prepared.headline, /^I’ve drafted triage and escalation acceptance criteria for Support Improvement Plan on \w+ \d+ \w+\.$/);
  assert.doesNotMatch(m.prepared.headline, /\bT1\b/, 'the register id stays out of the opening');
  assert.match(m.draft.markdown, /^# T1 — /, 'and stays in the draft, for traceability');
  assert.equal(m.prepared.detail, 'It is arranged from 2 lines already in your notes, each one cited. Nothing in it has been agreed yet.');
  assert.equal(m.whyItMatters, 'T1 has passed two dates with no draft in the vault.');
  assert.deepEqual(m.unresolved.map((u) => u.what), ['What each team accepts is not agreed yet for 2 teams.', 'Does the consolidation change who receives escalations?']);
  assert.deepEqual(m.unresolved[0].detail, ['Customer Care', 'Production']);
  assert.deepEqual(m.options.map((o) => o.id), ['approve', 'slot-1']);
  assert.match(m.options[0].writes[0], /^Add “Triage and escalation criteria draft” to your calendar, .* 10:25–10:55\. Just you — nobody is invited\.$/);
  assert.equal(m.options[0].writes[1], `Save the draft as a new note: ${NOTE_REL}`);
  assert.equal(m.draft.path, NOTE_REL); assert.match(m.draft.markdown, /_to agree_/);
  assert.equal(m.evidence.length, 3); assert.deepEqual(m.why.willNot, ['Email anyone']);
  assert.equal(v.withheldCount, 1);
  assert.ok(!JSON.stringify(v).includes('Weekly risk report'), 'a withheld item is counted, never named');
  assert.deepEqual(counts(), before, 'nothing stored, minted or ledgered');
  assert.equal(counts().table, false, 'not even the prepared_moves table exists');
});

test('the view asks the same question /request will — one wording, never two', async () => {
  S.packet = () => fixture(); S.over = {};
  const v = (await get()).json.move;
  // The question is only asked when SAiM could act on a yes (20 Oct 2026):
  // open the lock and grant today's allowance for the request alone.
  const budget = require('../services/authority-budget');
  const prior = process.env.SAIM_PREPARED_MOVE_EXECUTION;
  process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
  if (!budget.status().grant) budget._test.grantToday();
  let r;
  try { r = await req('POST', 'request', undefined, { option: 'approve', sessionId: 'view_test_0001' }); }
  finally { process.env.SAIM_PREPARED_MOVE_EXECUTION = prior; budget._test.reset(); }
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.confirmation.question, v.options[0].question);
  assert.deepEqual(r.json.confirmation.writes, v.options[0].writes);
  assert.equal(r.json.confirmation.contacts, v.contacts);
  assert.equal(r.json.confirmation.nothingElse, v.nothingElse);
});

test('no availability is speculative: a time that cannot be confirmed free NOW is not offered, and says why', async () => {
  S.packet = () => fixture();
  S.over = { diary: async () => ({ known: false, why: 'the calendar has not synced in the last 15 minutes' }) };
  let m = (await get()).json.move;
  assert.deepEqual(m.options, []);
  assert.match(m.notOffered[0].why, /couldn’t confirm 10:25–10:55 is still free \(the calendar has not synced/);
  S.over = { diary: async (slot) => ({ known: true, clashes: slot.start === '10:25' ? ['1-2-1'] : [] }) };
  m = (await get()).json.move;
  assert.deepEqual(m.options.map((o) => o.id), ['slot-1']);
  assert.match(m.notOffered[0].why, /no longer free/);
  S.over = { availability: async () => ({ known: true, off: true, working: true }) };
  m = (await get()).json.move;
  assert.deepEqual(m.options, []); assert.match(m.notOffered[0].why, /booked off/);
  S.over = {};
});

test('nothing trustworthy → move: null — no candidate, stale, ambiguous, out of scope', async () => {
  const cases = [
    ['no candidate', () => ({ contract: 'prepared-move-v1', decision: { decidedAt: new Date(NOW).toISOString() }, selected: null, withheld: [{ title: 'Disciplinary prep for Mel', reason: 'employment matter' }] })],
    ['stale source', () => fixture((x) => { x.selected.screens.freshnessOk = false; })],
    ['ambiguous record', () => fixture((x) => { x.selected.screens.recordUnique = false; })],
    ['out-of-scope note path', () => fixture((x) => { x.selected.decision.proposedWrites[1].path = 'People/Mel.md'; })],
    ['attendees', () => fixture((x) => { x.selected.decision.proposedWrites[0].attendees = ['mel@example.test']; })],
  ];
  for (const [name, packet] of cases) {
    S.packet = packet;
    const r = await get();
    assert.equal(r.status, 200, name); assert.equal(r.json.move, null, name);
    assert.ok(!JSON.stringify(r.json).match(/Disciplinary|Mel\b|disciplinary/), `${name}: nothing withheld is named`);
  }
  S.packet = () => fixture();
});

// 21 Oct 2026 (Nick: "make sure this is built into the MCP"): desktop chats may
// READ what SAiM prepared. The read stores and mints nothing; asking to confirm
// and confirming stay his (prepared-moves-routing pins those refusals).
test('machine callers may read what SAiM prepared — the read stores and mints nothing', async () => {
  const before = db.get('SELECT COUNT(*) n FROM human_action_intents').n;
  assert.equal((await get({ 'X-NEURO-API-TOKEN': 'tok-5678' })).status, 200);
  assert.equal((await get({ 'X-NEURO-PIN': 'pin-1234', 'X-Neuro-Machine-Client': 'mcp-local' })).status, 200);
  assert.equal(db.get('SELECT COUNT(*) n FROM human_action_intents').n, before, 'no confirmation minted');
  assert.equal(require('../services/authority-matrix').resolve('GET', '/api/prepared-moves/current').capability, 'read');
  assert.equal(require('../services/authority-matrix').resolve('POST', '/api/prepared-moves/request').capability, 'saim.prepared-move');
});

// ── The 1.5 s budget ─────────────────────────────────────────────────────────

test('budget: the deadline reaches preparation, and a preparation that overruns offers NOTHING — never stale or partial', async () => {
  assert.equal(view.BUDGET_MS, 1500);
  let t = 1000; const clock = () => t;
  let seen = null;
  // Preparation is handed the deadline.
  await view.currentView({ clock, deps: { prepare: async (o) => { seen = o.budgetBy; return fixture(); }, checks: () => ({ diary: async () => ({ known: true, clashes: [] }), availability: async () => ({ known: true, off: false, working: true }), candidate: async () => ({ ok: true }), noteState: async () => ({ known: true, exists: false }) }) } });
  assert.equal(seen, 1000 + 1500);
  // Overruns: finished late → no move, truthful reason.
  const late = await view.currentView({ clock, deps: { prepare: async () => { t += 1600; return fixture(); } } });
  assert.equal(late.move, null); assert.equal(late.unavailable.reason, 'not-ready-in-time'); assert.match(late.unavailable.say, /couldn’t check everything within 1500 ms/);
  // Stopped by its own deadline.
  const { BudgetExceeded } = require('../services/prepared-move');
  const stopped = await view.currentView({ clock, deps: { prepare: async () => { throw new BudgetExceeded('over'); } } });
  assert.equal(stopped.move, null); assert.equal(stopped.unavailable.reason, 'not-ready-in-time');
  // The fresh checks count too.
  const slowChecks = await view.currentView({ clock, deps: { prepare: async () => fixture(), checks: () => ({ diary: async () => { t += 1600; return { known: true, clashes: [] }; }, availability: async () => ({ known: true, off: false, working: true }), candidate: async () => ({ ok: true }), noteState: async () => ({ known: true, exists: false }) }) } });
  assert.equal(slowChecks.move, null); assert.equal(slowChecks.unavailable.reason, 'not-ready-in-time');
  // A genuine absence says so too.
  const none = await view.currentView({ clock, deps: { prepare: async () => ({ contract: 'prepared-move-v1', decision: { decidedAt: new Date(NOW).toISOString() }, selected: null, withheld: [] }) } });
  assert.equal(none.unavailable.reason, 'nothing-prepared');
});

test('budget: the real preparation stops at its deadline instead of finishing the scan', async () => {
  const pm = require('../services/prepared-move');
  const readDecision = async () => ({ nowView: { saim: { decidedAt: new Date(NOW).toISOString(), lead: null, held: [] } }, pool: [], gaps: [] });
  await assert.rejects(pm.prepare({ budgetBy: Date.now() - 1, deps: { readDecision } }), pm.BudgetExceeded);
  const ok = await pm.prepare({ budgetBy: Date.now() + 60000, deps: { readDecision } });
  assert.equal(ok.selected, null, 'with time to spare it completes normally');
});

test('the read reports its own time and stays inside the budget here', async () => {
  S.packet = () => fixture(); S.over = {};
  const r = await get();
  assert.equal(r.status, 200); assert.ok(r.json.move);
  assert.ok(Number.isFinite(r.json.elapsedMs) && r.json.elapsedMs <= 1500, `elapsedMs ${r.json.elapsedMs}`);
  assert.equal(r.json.budgetMs, 1500);
});

test('the opening names the work in plain words, derived from the register row — never its id', () => {
  const h = view.humanTitle;
  assert.equal(h({ action: 'Publish triage and escalation acceptance criteria for every team, with rejections stating what is missing' }), 'triage and escalation acceptance criteria');
  assert.equal(h({ action: 'Write the escalation handbook so that every team uses one route' }), 'the escalation handbook');
  assert.equal(h({ action: 'Agree on-call rota with Production (draft first)' }), 'on-call rota');
  // Not a known imperative → the draft heading, with any register id removed.
  assert.equal(h({ action: 'Triage criteria review' }, 'T1 — Triage and escalation acceptance criteria'), 'Triage and escalation acceptance criteria');
  assert.equal(h(null, 'R12a – Call routing review'), 'Call routing review');
  assert.equal(h(null, ''), 'a draft');
});

test('pending is not absence: a read that ran out of time says so; a genuine absence does not', async () => {
  let t = 0; const clock = () => t;
  const late = await view.currentView({ clock, deps: { prepare: async () => { t += 1600; return fixture(); } } });
  assert.equal(late.move, null); assert.equal(late.pending, true);
  const none = await view.currentView({ clock, deps: { prepare: async () => ({ contract: 'prepared-move-v1', decision: { decidedAt: new Date(NOW).toISOString() }, selected: null, withheld: [] }) } });
  assert.equal(none.move, null); assert.equal(none.pending, false);
});
