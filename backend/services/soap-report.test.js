'use strict';

/**
 * The SOAP report (15 Oct 2026). Pure rules, the gather's gap handling, the
 * governed send's Monday checks, and the routes over real HTTP + scratch SQLite.
 *
 * The two rules everything else rests on:
 *   • the Monday send is held on the VERDICTS (success, star, amber, red), not
 *     the numbers — and never on the worst-customer list;
 *   • a source NEURO could not read is a named gap, and a gap in a VERDICT source
 *     means the verdicts cannot be confirmed, so the send is held.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-soap-'));
process.env.NEURO_DB_PATH = path.join(scratch, 'scratch.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(scratch, 'vault');
fs.mkdirSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'People'), { recursive: true });

const express = require('express');
const db = require('../db/database');
const soap = require('./soap-report');
const registry = require('./action-registry');
const executor = require('./action-executor');

let server;
let base;

before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/soap', require('../routes/soap'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
});

// Friday 16 Oct 2026, 16:00 local; the following Monday is 19 Oct.
const FRIDAY = new Date(2026, 9, 16, 16, 0, 0);
const MONDAY = new Date(2026, 9, 19, 7, 0, 0);

// ── Pure ─────────────────────────────────────────────────────────────────────

test('weeks: Friday provisional and Monday final describe the SAME Monday–Sunday', () => {
  const p = soap.weekFor('provisional', FRIDAY);
  const f = soap.weekFor('final', MONDAY);
  assert.equal(p.from, '2026-10-12');
  assert.equal(p.upTo, '2026-10-16');
  assert.equal(f.from, '2026-10-12');
  assert.equal(f.to, '2026-10-18');
  assert.equal(p.fileWeek, '2026-10-19', 'weekly-risk reports the week BEFORE the one it is given');
  assert.equal(f.fileWeek, '2026-10-19');
  const at = new Date(soap.sendAtFor('2026-10-12'));
  assert.equal(at.getDate(), 19);
  assert.equal(at.getHours(), 8);
});

const finding = (severity, kind, title) => ({ severity, kind, title, detail: 'd' });
const sla = (pct, target = 95) => ({ label: 'FRT compliance % (Support)', now: { pct }, target, delta: null });

test('verdicts: escalate is red, warn is amber, Nick\'s own PIP bookkeeping is left out', () => {
  const v = soap.verdicts({
    assessment: { positives: [{ kpi: 'CSAT', value: 100, target: 95 }], findings: [
      finding('escalate', 'compliance-slide', 'FRT (Tier 2) below target for 3 weeks'),
      finding('warn', 'ageing-backlog', 'Tier 2 ageing 12 days'),
      finding('escalate', 'overtime-checklist-gap', '2 overtime approvals'),
      finding('blocked', 'source-unavailable', 'x unavailable'),
    ] },
    supportSla: null, leaderboard: null, plan: null,
  });
  assert.deepEqual(v.reds.map((r) => r.text), ['FRT (Tier 2) below target for 3 weeks']);
  assert.deepEqual(v.ambers.map((r) => r.text), ['Tier 2 ageing 12 days']);
  assert.equal(v.success[0].text, 'CSAT: 100 (target 95)');
  assert.equal(v.star, null);
});

test('verdicts: Support SLA week judged by weekly-risk\'s band — green at target, amber within 20, red beyond', () => {
  assert.equal(soap.slaLight(95, 95), 'green');
  assert.equal(soap.slaLight(80, 95), 'amber');
  assert.equal(soap.slaLight(74.9, 95), 'red');
  assert.equal(soap.slaLight(null, 95), null, 'no figure is no verdict, never red');
  const v = soap.verdicts({ assessment: null, supportSla: { frt: sla(70) }, leaderboard: null, plan: null });
  assert.equal(v.reds[0].key, 'sla:frt');
});

test('verdict hash ignores a changed NUMBER and changes on a changed VERDICT', () => {
  const base = (n) => ({ assessment: { positives: [], findings: [finding('escalate', 'ageing-backlog', `Tier 2 ageing ${n} days`)] }, supportSla: null, leaderboard: { top: { agentName: 'A' } }, plan: null });
  const a = soap.verdicts(base(12));
  const b = soap.verdicts(base(14));
  assert.equal(soap.verdictHash(a), soap.verdictHash(b), 'twelve days becoming fourteen is the same red');
  const c = soap.verdicts({ ...base(12), leaderboard: { top: { agentName: 'B' } } });
  assert.notEqual(soap.verdictHash(a), soap.verdictHash(c), 'a different star holds the send');
  assert.deepEqual(soap.verdictDiff(a, c), ['star of the week: was A, now B']);
});

test('last week\'s reds: delivered green, or still red', () => {
  const out = soap.carriedForward([{ key: 'k1', text: 'one' }, { key: 'k2', text: 'two' }], [{ key: 'k2', text: 'two' }]);
  assert.deepEqual(out.map((c) => [c.key, c.green]), [['k1', true], ['k2', false]]);
});

test('blockers: every red needs an action; every still-red needs a why (no consequences box)', () => {
  const report = { verdicts: { reds: [{ key: 'r1', text: 'Red one' }] }, carried: [{ key: 'c1', text: 'Old', green: false }, { key: 'c2', text: 'Done', green: true }] };
  assert.equal(soap.blockers(report, soap.emptyManual()).length, 2);
  const m = { ...soap.emptyManual(), reds: { r1: { action: 'fix it' } }, carried: { c1: { why: '' } } };
  assert.equal(soap.blockers(report, m).length, 1, 'a missing why still blocks');
  m.carried.c1.why = 'because';
  assert.deepEqual(soap.blockers(report, m), [], 'why alone is enough');
});

test('improvement plan: delivered this week, past due, and the dd/mm year rule', () => {
  assert.equal(soap.parseDue('21/08, 24/08', '2026-10-16'), '2026-08-24');
  assert.equal(soap.parseDue('None set', '2026-10-16'), null);
  assert.equal(soap.parseDue('20/12', '2026-01-10'), '2025-12-20', 'a date half a year ahead is last year');
  const plan = { readAt: 'x', actions: [
    { id: 'Q1', action: 'Done one', ownership: 'mine', status: 'Done', due: '04/09', planner: [{ percent: 100, completed: '2026-10-13' }] },
    { id: 'T1', action: 'Late one', ownership: 'mine', status: 'Added', due: '02/10', planner: [{ percent: 0, completed: null }] },
    { id: 'T2', action: 'Not mine', ownership: 'unknown', status: 'Added', due: '01/10', planner: [] },
    { id: 'T3', action: 'Dropped', ownership: 'mine', status: 'Not adding', due: '01/10', planner: [] },
  ] };
  const p = soap.initiatives(plan, soap.weekFor('provisional', FRIDAY));
  assert.deepEqual(p.doneThisWeek.map((d) => d.id), ['Q1']);
  assert.deepEqual(p.overdue.map((d) => d.id), ['T1']);
  assert.equal(p.totals.mine, 2);
});

test('SLA day on day: a day with no counts is unmeasured, never 0%', () => {
  const week = soap.weekFor('provisional', FRIDAY);
  const series = { series: [
    { key: 'nt_sla_frt_tier_2_met', points: [{ day: '2026-10-12', value: 9 }] },
    { key: 'nt_sla_frt_tier_2_breached', points: [{ day: '2026-10-12', value: 1 }] },
  ] };
  const rows = soap.slaDaily(series, week, { queues: [['tier_2', 'Tier 2']], metrics: [['frt', 'FRT']] });
  assert.equal(rows.length, 5, 'Monday to Friday — the provisional stops at today');
  assert.equal(rows[0].frt.pct, 90);
  assert.equal(rows[1].frt, null);
});

// ── Gather: gaps ─────────────────────────────────────────────────────────────

const okOverrides = (extra = {}) => ({
  kpi: async () => ({ positives: [], findings: [finding('escalate', 'ageing-backlog', 'Tier 2 ageing 12 days')] }),
  series: async () => ({ series: [] }),
  leaderboard: async () => ({ ranked: [{ agentName: 'Star' }, { agentName: 'Weak', qaOverall: null }] }),
  plan: async () => ({ actions: [] }),
  customers: async () => { throw new Error('NOVA has no worst-customer route yet'); },
  ...extra,
});

test('a missing customer list is a named gap that does NOT stop the verdicts being confirmed', async () => {
  const r = await soap.gather({ kind: 'provisional', now: FRIDAY, overrides: okOverrides() });
  assert.equal(r.verdictComplete, true);
  assert.ok(r.gaps.some((g) => g.source === 'worst customers from NOVA' && g.verdict === false));
  assert.match(soap.render({ ...r, carried: [] }, soap.emptyManual()), /Worst 5 customers[\s\S]*Not available — NOVA has no worst-customer route yet/);
});

test('an unreadable leaderboard is a gap in a VERDICT source — the report says so', async () => {
  const r = await soap.gather({ kind: 'final', now: MONDAY, overrides: okOverrides({ leaderboard: async () => { throw new Error('NOVA timed out'); } }) });
  assert.equal(r.verdictComplete, false);
  assert.equal(r.verdicts.star, null);
  assert.match(soap.render({ ...r, carried: [] }, soap.emptyManual()), /Star of the week[\s\S]*Not available — NOVA timed out/);
});

// ── The governed send ────────────────────────────────────────────────────────

test('the registry knows send_soap_report: A4, two recipients, html, bound to verdicts and send time', () => {
  assert.deepEqual(registry.validateRegistry(), []);
  const p = registry.policyFor('send_soap_report');
  assert.equal(p.authority, 'A4');
  assert.equal(p.maxRecipients, 10, 'a configurable list, up to ten');
  assert.ok(p.approvalTtlHours >= 66, 'a Friday 16:00 approval must survive to Monday 08:00 plus the hold window');
  const t = { weekFrom: '2026-10-12', verdictHash: 'a', notBefore: '2026-10-19T07:00:00.000Z' };
  const d = { to: [{ email: 'x@y.z' }], subject: 's', body: 'b', html: '<p>x</p>' };
  const h1 = registry.payloadHash({ actionType: 'send_soap_report', version: 1, commitmentId: 'soap:2026-10-12', target: t, draft: d });
  const h2 = registry.payloadHash({ actionType: 'send_soap_report', version: 1, commitmentId: 'soap:2026-10-12', target: { ...t, verdictHash: 'b' }, draft: d });
  assert.notEqual(h1, h2, 'the verdicts are inside the approval');
});

const NOT_BEFORE = new Date(2026, 9, 19, 8, 0, 0);
const action = (target = {}) => ({
  actionId: 'pa_soap_test', actionType: 'send_soap_report', commitmentId: 'soap:2026-10-12', createdAt: FRIDAY.toISOString(),
  target: { weekFrom: '2026-10-12', verdictHash: 'H', notBefore: NOT_BEFORE.toISOString(), ...target },
  draft: { to: [{ email: 'chris@example.com' }, { email: 'ricky@example.com' }], subject: 'SOAP — week of 12 Oct', html: '<p>x</p>' },
});
const deps = (final, sent = { count: 0, subjects: [] }) => ({ soapFinal: () => final, mailApi: { sentToSince: async () => sent } });
const run = (a, d, at) => executor.PREFLIGHT.send_soap_report(a, registry.policyFor('send_soap_report'), d, at.getTime());

test('preflight WAITS before Monday 08:00 and while the final is not built yet', async () => {
  const early = await run(action(), deps({ verdictHash: 'H', verdictComplete: true }), new Date(2026, 9, 19, 7, 30));
  assert.equal(early.ok, false); assert.equal(early.terminal, false); assert.equal(early.code, 'not-yet');
  const noFinal = await run(action(), deps(null), new Date(2026, 9, 19, 8, 5));
  assert.equal(noFinal.terminal, false); assert.equal(noFinal.code, 'final-missing');
  const tooLate = await run(action(), deps(null), new Date(2026, 9, 19, 12, 30));
  assert.equal(tooLate.terminal, true, 'a final never built holds it, rather than sending unchecked');
});

test('preflight HOLDS on changed verdicts or an unreadable verdict source, and SENDS when they match', async () => {
  const at = new Date(2026, 9, 19, 8, 2);
  const changed = await run(action(), deps({ verdictHash: 'OTHER', verdictComplete: true }), at);
  assert.equal(changed.terminal, true); assert.equal(changed.code, 'verdicts-changed');
  const incomplete = await run(action(), deps({ verdictHash: 'H', verdictComplete: false, gaps: [{ source: 'the agent leaderboard from NOVA', verdict: true }] }), at);
  assert.equal(incomplete.code, 'final-incomplete');
  assert.match(incomplete.why, /agent leaderboard/);
  const ok = await run(action(), deps({ verdictHash: 'H', verdictComplete: true }), at);
  assert.deepEqual(ok, { ok: true });
  const byHand = await run(action(), deps({ verdictHash: 'H', verdictComplete: true }, { count: 1, subjects: ['SOAP — week of 12 Oct'] }), at);
  assert.equal(byHand.code, 'already-emailed');
});

// ── Routes, real HTTP ────────────────────────────────────────────────────────

const post = async (p, body) => {
  const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json() };
};

test('routes: build refuses an unknown kind; manual saves; queue-send refuses an unfinished report', async () => {
  assert.equal((await post('/api/soap/build', { kind: 'weekly' })).status, 400);

  // A stored provisional with one red and no recipients' notes yet.
  const r = await soap.gather({ kind: 'provisional', now: FRIDAY, overrides: okOverrides() });
  r.carried = [];
  db.run(`INSERT INTO soap_reports (week_from, kind, week_to, generated_at, data_json, verdict_hash) VALUES (?, 'provisional', ?, ?, ?, ?)`,
    [r.from, r.to, r.generatedAt, JSON.stringify(r), r.verdictHash]);

  const q1 = await post(`/api/soap/${r.from}/queue-send`);
  assert.equal(q1.status, 409);
  assert.match(q1.body.blockers[0], /Red needs what you will do/);

  const key = r.verdicts.reds[0].key;
  const m = await post(`/api/soap/${r.from}/manual`, { reds: { [key]: { action: 'Pair Tier 2 with T3 on the aged queue' } } });
  assert.equal(m.status, 200);
  const got = await fetch(`${base}/api/soap/${r.from}/provisional`).then((x) => x.json());
  assert.deepEqual(got.view.blockers, []);
  assert.match(got.view.markdown, /I will: Pair Tier 2 with T3/);

  const q2 = await post(`/api/soap/${r.from}/queue-send`);
  assert.equal(q2.status, 409, 'nobody resolvable to send to in the scratch vault');
  assert.ok(q2.body.blockers.some((b) => /Chris Middleton/.test(b)));
});

test('the Monday build retries a verdict source that failed, and stops once it reads', async () => {
  let calls = 0;
  const r = await soap.mondayFinal({ now: MONDAY, pauseMs: 0, overrides: okOverrides({
    leaderboard: async () => { calls += 1; if (calls === 1) throw new Error('NOVA timed out'); return { ranked: [{ agentName: 'Star' }] }; },
  }) });
  assert.equal(calls, 2);
  assert.equal(r.verdictComplete, true);
  assert.equal(soap.finalFor(r.from).verdictComplete, true, 'the stored final is the complete one');
});

test('a sent week FREEZES: no rebuild, no edits, the sent words are shown; reopen unfreezes and keeps the record', async () => {
  const wk = '2026-10-12';
  const before = soap.view(wk, 'provisional');
  assert.ok(before, 'the provisional stored by the routes test');
  const r = soap.markSentByHand(wk, 'provisional', {});
  assert.equal(r.ok, true);
  assert.equal(r.sent.reportedByNick, true);
  assert.equal(soap.isLocked(wk), true);
  await assert.rejects(() => soap.build({ kind: 'provisional', now: FRIDAY, overrides: okOverrides() }), /frozen/);
  const m = await post(`/api/soap/${wk}/manual`, { notes: 'late change' });
  assert.equal(m.status, 409);
  assert.equal((await post(`/api/soap/${wk}/mark-sent`, { kind: 'provisional' })).status, 409, 'cannot be sent twice');
  const reo = await post(`/api/soap/${wk}/reopen`);
  assert.equal(reo.status, 200);
  assert.equal(soap.isLocked(wk), false);
  assert.ok(soap.sentRecord(wk).reopenedAt, 'reopening keeps the fact that it was sent');
});

test('publish writes the note to the vault and records it', async () => {
  const wk = '2026-10-12';
  const r = await post(`/api/soap/${wk}/publish`, { kind: 'provisional' });
  assert.equal(r.status, 200);
  const abs = path.join(process.env.OBSIDIAN_VAULT_PATH, r.body.path);
  assert.match(fs.readFileSync(abs, 'utf-8'), /^---\ntype: report\nreport: soap/);
  assert.ok(soap.view(wk, 'provisional').published.publishedAt);
});

test('the executor records a governed send, so the page and Actions cannot disagree', () => {
  const ex = require('./action-executor');
  assert.match(require('fs').readFileSync(require.resolve('./action-executor'), 'utf-8'), /send_soap_report'\) \{\r?\n\s+d\.recordSoap\(a\)/);
  assert.ok(ex);
});


test('distribution list: names only, refused (not clamped) when empty, duplicated, an address, or too long; unresolved names are reported', async () => {
  assert.equal((await post('/api/soap/recipients', { names: [] })).status, 400);
  assert.equal((await post('/api/soap/recipients', { names: ['Chris Middleton', 'chris middleton'] })).status, 400);
  assert.equal((await post('/api/soap/recipients', { names: ['chris@nurtur.tech'] })).status, 400);
  assert.equal((await post('/api/soap/recipients', { names: Array.from({ length: 11 }, (_, i) => `Person ${i}`) })).status, 400);
  fs.writeFileSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'People', 'Liam Sims.md'), '---\nemail: liams@example.com\n---\n');
  const ok = await post('/api/soap/recipients', { names: ['Liam Sims', 'Nobody Here'] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.names, ['Liam Sims', 'Nobody Here']);
  assert.deepEqual(ok.body.recipients, [{ name: 'Liam Sims', email: 'liams@example.com' }]);
  assert.match(ok.body.problems[0], /^Nobody Here:/);
  const got = await fetch(`${base}/api/soap/recipients`).then((r) => r.json());
  assert.deepEqual(got.names, ['Liam Sims', 'Nobody Here']);
});

test('plan RAG: green with nothing past due, amber up to 10% of open actions, red beyond (Nick, 15 Oct)', () => {
  assert.equal(soap.planRag(42, 0).rag, 'green');
  assert.equal(soap.planRag(42, 4).rag, 'amber', '4 of 42 is 9.5%');
  assert.equal(soap.planRag(42, 5).rag, 'red', '5 of 42 is 11.9%');
  assert.equal(soap.planRag(0, 0).rag, 'green');
});

test('per-queue table: only SLA compliance rows, and a queue that solved nothing is null — never 0', () => {
  const rows = soap.perQueueRows({ kpis: [
    { colA: 'SLA', key: 'nt_sla_res_tier_2_compliance', label: 'Resolution compliance % (Tier 2)', value: 45.3, target: 95, rag: 'red' },
    { colA: 'SLA', key: 'nt_sla_res_tier_3_compliance', label: 'Resolution compliance % (Tier 3)', value: null, target: 95, rag: null },
    { colA: 'SLA', key: 'nt_sla_res_tier_2_breached', label: 'breached', value: 12 },
    { colA: 'Volume', key: 'nt_x_compliance', label: 'not SLA', value: 1 },
  ] });
  assert.deepEqual(rows.map((r) => [r.key, r.value]), [['nt_sla_res_tier_2_compliance', 45.3], ['nt_sla_res_tier_3_compliance', null]]);
});

test('sentiment stays four separate measures, never one averaged figure', () => {
  const s = soap.sentimentSummary({ window: { days: 7 },
    portalCsat: { ok: true, data: { sent: 427, responded: 2, responseRatePct: 0.5, thin: true } },
    ai: { ok: true, data: { scored: 3, negative: 1, average: -0.2 } },
    jiraCsat: { ok: false, error: 'Timeout' },
    surveys: { ok: true, data: { byCategory: { team_satisfaction: [{ title: 'Support Team Satisfaction', responses: 10, avgScore: 3.04, thin: false }] } } },
    unavailable: [{ name: 'jiraCsat' }] });
  assert.deepEqual(s.survey, { sent: 427, responded: 2, ratePct: 0.5, thin: true });
  assert.equal(s.tickets.negative, 1);
  assert.equal(s.team.avg, 3.04);
  assert.deepEqual(s.unavailable, ['jiraCsat']);
  assert.equal(s.average, undefined, 'no combined figure');
});

test('the SOAP carries the new sections; resolved findings and escalation reasons stay out', async () => {
  const r = await soap.gather({ kind: 'final', now: MONDAY, overrides: okOverrides({
    kpi: async () => ({ positives: [], csatRows: [{ label: 'CSAT average score', now: '4.2 (3 ratings)', was: '—', delta: '—' }],
      ageing: [{ kpi: 'Oldest actionable (days): Tier 2', value: 196, target: 5, ratio: 39.2 }],
      findings: [finding('warn', 'reason-capture-broken', '96% of escalations logged as unknown'), finding('escalate', 'ageing-backlog', 'Tier 2 ageing 12 days')] }),
    perQueue: async () => ({ kpis: [{ colA: 'SLA', key: 'nt_sla_res_tier_2_compliance', label: 'Resolution compliance % (Tier 2)', value: 45.3, target: 95, rag: 'red' }] }),
    perQueuePrior: async () => ({ kpis: [{ colA: 'SLA', key: 'nt_sla_res_tier_2_compliance', label: 'Resolution compliance % (Tier 2)', value: 58, target: 95, rag: 'red' }] }),
    winning: async () => ({ status: 'ok', rows: [{ rank: 1, name: 'Fine & Country', why: '2 of 2 tickets resolved this week ending Neutral' }] }),
    findings: async () => [{ id: 1, title: 'Open one', severity: 'high', status: 'open' }, { id: 2, title: 'Closed one', severity: 'high', status: 'resolved' }],
    leading: async () => ({ available: true, asOf: '2026-10-18', indicators: [], quiet: ['A', 'T1'] }),
    slm: async () => ({ known: true, highlights: ['KBA usage up'], lowlights: ['Tier 2 res'], blockers: ['200 dev tickets'] }),
    sentiment: async () => ({ portalCsat: { ok: true, data: { sent: 10, responded: 1, responseRatePct: 10, thin: true } }, unavailable: [] }),
  }) });
  assert.equal(r.perQueue[0].was, 58);
  assert.deepEqual(r.findings.map((f) => f.title), ['Open one']);
  assert.ok(!r.verdicts.ambers.some((a) => /logged as unknown/.test(a.text)), 'escalation reasons are out of the SOAP');
  const md = soap.render({ ...r, carried: [] }, soap.emptyManual());
  for (const h of ['SLA compliance by queue', 'Ageing vs target', 'Volumes and backlog', 'CSAT', 'Sentiment', 'Customers winning after support', 'Open findings', 'Leading indicators', 'Friday Support Leadership Meeting', 'Completed this week']) {
    assert.ok(md.includes(h), `missing section: ${h}`);
  }
  assert.match(md, /\| Tier 2 \| 196 \| 5 \| 39.2× \|/);
  assert.match(md, /No early warning this week \(2 checks running/);
});

test("a red whose measure was replaced is never carried as 'delivered green'", () => {
  const prev = [{ key: 'ping-pong:# tickets crossed queues #+ times', text: '136 tickets crossed queues 3+ times' }];
  const [c] = soap.carriedForward(prev, []);
  assert.equal(c.green, false);
  assert.match(c.retired, /measure replaced/);
  const report = { verdicts: { reds: [] }, carried: [c] };
  assert.deepEqual(soap.blockers(report, soap.emptyManual()), [], 'a replaced measure asks for no why');
});
