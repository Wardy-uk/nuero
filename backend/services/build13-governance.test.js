'use strict';

/**
 * Build 13K/L/M — direct external writes are ledgered, deduplicated, read back,
 * and an unknown outcome is never repeated blind.
 *
 * Jira escalation (through NOVA) and Microsoft task completion were the two
 * direct writers the 13K audit found with no ledger at all; the escalation
 * route also accepted the machine API token.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b13gov-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
const vault = path.join(tmp, 'vault');
fs.mkdirSync(path.join(vault, 'Tasks'), { recursive: true });
process.env.OBSIDIAN_VAULT_PATH = vault;

const db = require('../db/database');
const ext = require('./external-writes');
const esc = require('./nova-escalation');

test.before(async () => { await db.init(); });

const NOW = Date.parse('2026-10-06T10:00:00Z');

/** A NOVA stand-in that records every escalate call. */
function fakeNova({ escalate, comments = null } = {}) {
  const calls = [];
  return {
    calls,
    escalate: async (req) => { calls.push(req); return escalate ? escalate(req) : { ticket_key: req.ticketKey, comment_posted: true }; },
    getTicket: async () => ({ comments: comments || [{ jsdPublic: false, created: new Date(NOW).toISOString() }] }),
  };
}

// ── escalation ───────────────────────────────────────────────────────────────

test('18. an escalation is ledgered, read back, and the same ticket+reason today is NOT escalated twice', async () => {
  const nova = fakeNova();
  const first = await esc.escalate({ ticketKey: 'nt-100', reasonCode: 'vip' }, { now: () => NOW, deps: { nova } });
  assert.equal(first.outcome, 'confirmed', 'a new internal comment on readback confirms it');
  assert.equal(first.ledger.authority, 'A3');
  const again = await esc.escalate({ ticketKey: 'NT-100', reasonCode: 'vip' }, { now: () => NOW + 60000, deps: { nova } });
  assert.equal(again.outcome, 'duplicate');
  assert.equal(nova.calls.length, 1, 'NOVA was called ONCE — a double submit posts no second comment');
  const other = await esc.escalate({ ticketKey: 'NT-100', reasonCode: 'sla' }, { now: () => NOW, deps: { nova } });
  assert.equal(other.outcome, 'confirmed', 'positive control: a different reason is a different escalation');
  assert.equal(nova.calls.length, 2);
});

test('15/16. an UNCERTAIN escalation blocks a repeat until Nick says what is on the ticket', async () => {
  let n = 0;
  const nova = fakeNova({ escalate: () => { n += 1; if (n === 1) throw new Error('Request timed out'); return { comment_posted: true }; } });
  const r1 = await esc.escalate({ ticketKey: 'NT-200', reasonCode: 'vip' }, { now: () => NOW, deps: { nova } });
  assert.equal(r1.outcome, 'uncertain', 'a timeout might have landed');
  const r2 = await esc.escalate({ ticketKey: 'NT-200', reasonCode: 'vip' }, { now: () => NOW, deps: { nova } });
  assert.equal(r2.outcome, 'blocked');
  assert.equal(nova.calls.length, 1, 'never retried blind');
  const res = ext.resolveUnknown(r1.ledger.key, { applied: false, note: 'checked NT-200: no comment' });
  assert.equal(res.ok, true);
  const r3 = await esc.escalate({ ticketKey: 'NT-200', reasonCode: 'vip' }, { now: () => NOW, deps: { nova } });
  assert.equal(r3.outcome, 'confirmed', 'after Nick says it did not land, one new attempt is allowed');
  assert.equal(r3.ledger.attempts, 2);
});

test('a refusal NOVA returned (4xx) is provably not applied, so it may be retried', async () => {
  let n = 0;
  const nova = fakeNova({ escalate: () => { n += 1; if (n === 1) throw new Error('NOVA 400: unknown reason code'); return {}; } });
  const r1 = await esc.escalate({ ticketKey: 'NT-300', reasonCode: 'x' }, { now: () => NOW, deps: { nova } });
  assert.equal(r1.outcome, 'failed');
  const r2 = await esc.escalate({ ticketKey: 'NT-300', reasonCode: 'x' }, { now: () => NOW, deps: { nova } });
  assert.equal(r2.ok, true);
  assert.equal(nova.calls.length, 2);
});

test('no internal comment on readback → applied-unverified, never "confirmed"', async () => {
  const nova = fakeNova({ comments: [] });
  const r = await esc.escalate({ ticketKey: 'NT-400', reasonCode: 'vip' }, { now: () => NOW, deps: { nova } });
  assert.equal(r.outcome, 'applied-unverified');
});

test('18. a machine client cannot escalate a ticket over HTTP; Nick can', async () => {
  const novaClient = require('./nova-client');
  const realConf = novaClient.isConfigured;
  const realEsc = novaClient.escalate;
  const realGet = novaClient.getTicket;
  novaClient.isConfigured = () => true;
  let called = 0;
  novaClient.escalate = async () => { called += 1; return { comment_posted: true }; };
  novaClient.getTicket = async () => ({ comments: [{ jsdPublic: false, created: new Date().toISOString() }] });
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (req.headers['x-machine']) req.apiClient = true; next(); });
  app.use('/api/escalation', require('../routes/escalation'));
  const server = http.createServer(app).listen(0);
  const port = server.address().port;
  const post = (headers) => fetch(`http://127.0.0.1:${port}/api/escalation`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ ticket_key: 'NT-500', reason_code: 'vip' }),
  });
  try {
    const m = await post({ 'x-machine': '1' });
    assert.equal(m.status, 403);
    assert.equal(called, 0, 'refused BEFORE NOVA');
    const h = await post({});
    assert.equal(h.status, 200, 'positive control: Nick, in NEURO, can');
    assert.equal(called, 1);
    const led = await (await fetch(`http://127.0.0.1:${port}/api/escalation/ledger`)).json();
    assert.ok(led.escalations.some((e) => e.target === 'NT-500'));
  } finally {
    server.close();
    Object.assign(novaClient, { isConfigured: realConf, escalate: realEsc, getTicket: realGet });
  }
});

test('the legacy escalate_ticket card goes through the SAME ledgered write', () => {
  const src = fs.readFileSync(path.join(__dirname, 'suggestion-engine.js'), 'utf8');
  const block = src.slice(src.indexOf("case 'escalate_ticket'"), src.indexOf("case 'escalate_ticket'") + 1500);
  assert.match(block, /nova-escalation/);
  assert.doesNotMatch(block, /nova\.escalate\(/, 'no second direct NOVA write');
});

test('18. no NEURO code changes a Jira ticket except nova-escalation (detection is not action)', () => {
  const dir = __dirname;
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && !x.endsWith('.test.js'))) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    if (f !== 'nova-escalation.js' && f !== 'nova-client.js' && /\bnova\.escalate\(|client\.escalate\(/.test(s)) offenders.push(f);
  }
  const routes = path.join(dir, '..', 'routes');
  for (const f of fs.readdirSync(routes).filter((x) => x.endsWith('.js') && !x.endsWith('.test.js'))) {
    if (/\bnova\.escalate\(/.test(fs.readFileSync(path.join(routes, f), 'utf8'))) offenders.push(`routes/${f}`);
  }
  assert.deepEqual(offenders, []);
});

// ── Microsoft task completion ────────────────────────────────────────────────

const microsoft = require('./microsoft');
const msComplete = require('./ms-complete');
const realComplete = microsoft.completeMicrosoftTask;
let answer;
let graphCalls;
test.beforeEach(() => {
  graphCalls = 0;
  microsoft.completeMicrosoftTask = async () => { graphCalls += 1; return answer; };
});
test.after(() => { microsoft.completeMicrosoftTask = realComplete; });

test('19. completion is read back: confirmed only when the source says so', async () => {
  answer = { completed: true, kind: 'planner', readback: 'confirmed' };
  const r = await msComplete.completeMicrosoftTask({ msId: 'PLAN-1', source: 'MS Planner' });
  assert.equal(r.pushed, 'planner');
  const row = ext.recent({ writer: 'microsoft.task.complete' }).find((e) => e.target === 'PLAN-1');
  assert.equal(row.status, 'confirmed');
  assert.equal(row.readback, 'confirmed');
});

test('19. a 2xx the source DISAGREES with is not a completion: held for retry, ledger failed', async () => {
  answer = { completed: false, reason: 'readback_disagrees', kind: 'planner', readback: 'disagrees' };
  const r = await msComplete.completeMicrosoftTask({ msId: 'PLAN-2', source: 'MS Planner' });
  assert.equal(r.pushed, 'none');
  assert.equal(r.held, true);
  assert.match(r.warning, /still shows the task open/);
  assert.equal(ext.recent({ writer: 'microsoft.task.complete' }).find((e) => e.target === 'PLAN-2').status, 'failed');
});

test('16/27. the same task completed twice is ONE external write — and the mirror is not toggled back open', async () => {
  fs.writeFileSync(path.join(vault, 'Tasks', 'Microsoft Tasks.md'),
    '# Microsoft Tasks\n\n## MS Planner\n- [ ] Succession plan <!--id:PLAN-3-->\n');
  answer = { completed: true, kind: 'planner', readback: 'confirmed' };
  await msComplete.completeMicrosoftTask({ msId: 'PLAN-3', source: 'MS Planner' });
  const again = await msComplete.completeMicrosoftTask({ msId: 'PLAN-3', source: 'MS Planner' });
  assert.equal(again.duplicate, true);
  assert.equal(graphCalls, 1, 'Graph was asked once');
  const mirror = fs.readFileSync(path.join(vault, 'Tasks', 'Microsoft Tasks.md'), 'utf8');
  assert.match(mirror, /- \[x\] Succession plan/, 'still ticked — the second call used to UN-tick it');
});

test('a RECURRING task ticked repeatedly to catch up completes each occurrence — not a duplicate', async () => {
  answer = { completed: true, kind: 'todo', readback: 'confirmed', rolled: { nextDue: '2026-11-01' } };
  await msComplete.completeMicrosoftTask({ msId: 'TODO-R', source: 'MS ToDo' });
  const second = await msComplete.completeMicrosoftTask({ msId: 'TODO-R', source: 'MS ToDo' });
  assert.notEqual(second.duplicate, true);
  assert.equal(graphCalls, 2, 'two occurrences, two completions');
  assert.equal(ext.recent({ writer: 'microsoft.task.complete' }).filter((e) => e.target === 'TODO-R').length, 2, 'both on the ledger');
});

test('the queue settles the failed row when a retry lands', async () => {
  answer = { completed: false, reason: 'auth' };
  await msComplete.completeMicrosoftTask({ msId: 'PLAN-4', source: 'MS Planner' });
  assert.equal(ext.recent({ writer: 'microsoft.task.complete' }).find((e) => e.target === 'PLAN-4').status, 'failed');
  ext.settleLatestFailed('microsoft.task.complete', 'PLAN-4', { status: 'confirmed', readback: 'confirmed' });
  assert.equal(ext.recent({ writer: 'microsoft.task.complete' }).find((e) => e.target === 'PLAN-4').status, 'confirmed');
});

test('every path that completes a Microsoft task goes through ms-complete (no stray Graph completion)', () => {
  const allowed = new Set(['ms-complete.js', 'ms-push-queue.js', 'microsoft.js']);
  const offenders = [];
  const scan = (dir, prefix) => {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && !x.endsWith('.test.js'))) {
      if (allowed.has(f)) continue;
      const s = fs.readFileSync(path.join(dir, f), 'utf8');
      if (/microsoft['")]*\)?\.completeMicrosoftTask\(|microsoft\.completeMicrosoftTask\(/.test(s)) offenders.push(prefix + f);
    }
  };
  scan(__dirname, '');
  scan(path.join(__dirname, '..', 'routes'), 'routes/');
  assert.deepEqual(offenders, []);
});

test('an unregistered or ledger-less writer cannot claim the ledger', () => {
  assert.equal(ext.begin({ writer: 'made.up', key: 'k1' }).refused, true);
  assert.equal(ext.begin({ writer: 'notion.sync', key: 'k2' }).refused, true, 'registered honestly as ledger:false');
  for (const [id, w] of Object.entries(ext.WRITERS)) {
    assert.ok(['A2', 'A3'].includes(w.authority), `${id}: direct writers are A2/A3 — A4 goes through prepared_actions`);
    assert.ok(w.why && w.effect && w.target, `${id} states what it does and why`);
  }
});
