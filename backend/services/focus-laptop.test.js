'use strict';

/**
 * Focus blocks on the laptop (1 Nov 2026): the laptop opens what the picked
 * task needs, and the card says whether the laptop is quiet.
 *
 * What is mostly under test is what it REFUSES — this ends in something
 * opening on Nick's work machine:
 *  - only three URL shapes NEURO builds, refused at queue AND at claim
 *  - nothing handed to an agent that has not declared `open-url`
 *  - nothing queued into a locked, silent or old-agent laptop (the card says why)
 *  - at most three opens, once per block and task
 *  - the agent's own PowerShell check (run in a real Windows PowerShell with
 *    NEURO_AGENT_TEST=1 and Start-Process/Add-Type shadowed, so nothing opens)
 *  - Do Not Disturb is a closed, read-only shape
 *  - GET /api/focus-blocks/focus-state, over real HTTP
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-flaptop-'));
process.env.NEURO_DB_PATH = path.join(root, 'flaptop.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });
process.env.JIRA_BASE_URL = 'https://nurturtech.atlassian.net';
process.env.NEURO_DESKTOP_URL = 'https://neuro.nickward.co.uk';
process.env.OBSIDIAN_VAULT_NAME = 'Nicks knowledge base';
process.env.PUSH_QUIET_HOURS = 'off';
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

const db = require('../db/database');
const di = require('./desk-intents');
const fl = require('./focus-laptop');
const desktop = require('./desktop-activity');
const focusBlocks = require('./focus-blocks');
const focusHold = require('./focus-hold');
const taskStore = require('./task-store');

test.before(async () => { await db.init(); });

const NOTE = 'obsidian://open?vault=Nicks%20knowledge%20base&file=Projects%2FSupport%2FRota%20plan';
const JIRA = 'https://nurturtech.atlassian.net/browse/NT-14855';
const TASK = 'https://neuro.nickward.co.uk/?view=task&taskId=42';
const DRAFTS = 'https://neuro.nickward.co.uk/?view=drafts';

function resetQueue() { db.setState(di.STATE_KEY, ''); }

// ── The allowlist: three shapes, nothing else ────────────────────────────────

test('the three NEURO-built shapes are allowed', () => {
  for (const u of [NOTE, JIRA, TASK, DRAFTS]) assert.equal(di.urlAllowed(u), true, u);
});

test('⚠ NEGATIVE: anything that is not a NEURO-built link is refused', () => {
  const bad = [
    'https://evil.example.com/browse/NT-1',
    'https://nurturtech.atlassian.net.evil.com/browse/NT-1',
    'https://evilnurturtech.atlassian.net/browse/NT-1',
    'https://x.nurturtech.atlassian.net/browse/NT-1',
    'obsidian://new?vault=Nicks%20knowledge%20base&file=x',
    'http://nurturtech.atlassian.net/browse/NT-1',
    'https://nurturtech.atlassian.net:8443/browse/NT-1',
    'https://user:pw@nurturtech.atlassian.net/browse/NT-1',
    'https://nurturtech.atlassian.net/browse/NT-1?x=1',
    'https://nurturtech.atlassian.net/browse/NT-1#c',
    'https://nurturtech.atlassian.net/secure/admin',
    'https://neuro.nickward.co.uk/?view=settings',
    'https://neuro.nickward.co.uk/?view=task&taskId=42&pin=1',
    'https://neuro.nickward.co.uk/?view=drafts&x=1',
    'https://neuro.nickward.co.uk/api/actions/1/approve',
    'https://neuro.nickward.co.uk/?view=task&taskId=abc',
    'obsidian://open?vault=Other&file=x',
    'obsidian://open?vault=Nicks%20knowledge%20base&file=..%2F..%2Fsecret',
    'obsidian://open?vault=Nicks%20knowledge%20base&file=x&extra=1',
    'obsidian://new?vault=Nicks%20knowledge%20base&file=x&content=y',
    'obsidian://advanced-uri?vault=Nicks%20knowledge%20base&commandid=x',
    'javascript:alert(1)',
    'file:///C:/Windows/System32/cmd.exe',
    'data:text/html,hi',
    'ms-settings:privacy',
    'https://neuro.nickward.co.uk/?view=drafts extra',
    'https://neuro.nickward.co.uk/?view=drafts\\',
    'https://neuro.nickward.co.uk/?view=drafts\n',
    `https://neuro.nickward.co.uk/?view=task&taskId=${'1'.repeat(700)}`,
    '', null, 42,
  ];
  for (const u of bad) assert.equal(di.urlAllowed(u), false, JSON.stringify(u));
});

test('the Jira host comes from JIRA_BASE_URL; with none set, no Jira link is allowed', () => {
  const was = process.env.JIRA_BASE_URL;
  delete process.env.JIRA_BASE_URL;
  try { assert.equal(di.urlAllowed(JIRA), false); } finally { process.env.JIRA_BASE_URL = was; }
});

// ── The queue: a separate narrow kind ────────────────────────────────────────

test('⚠ queue() never takes open-url — it is not a button', () => {
  resetQueue();
  assert.equal(di.queue('open-url').ok, false);
  assert.equal(di.queue(di.URL_APP, { paste: 'x' }).ok, false);
  assert.equal(di.offer({ canOpen: ['open-url', 'music'], atDesk: true, host: 'L' }).apps.some((a) => a.id === 'open-url'), false);
});

test('⚠ queueUrl refuses a non-NEURO URL and nothing reaches the queue', () => {
  resetQueue();
  const r = di.queueUrl('https://evil.example.com/x', { host: 'L' });
  assert.equal(r.ok, false);
  assert.deepEqual(di.claim({ host: 'L', canOpen: ['open-url'] }).intents, []);
});

test('⚠ nothing is handed to an agent that has not declared open-url — and it stays queued', () => {
  resetQueue();
  assert.equal(di.queueUrl(JIRA, { host: 'L', label: 'NT-14855 in Jira' }).ok, true);
  assert.deepEqual(di.claim({ host: 'L', canOpen: ['music', 'browser'] }).intents, [], 'an older agent');
  assert.deepEqual(di.claim({ host: 'L' }).intents, [], 'an agent that said nothing');
  const { intents } = di.claim({ host: 'L', canOpen: ['music', 'open-url'] });
  assert.equal(intents.length, 1);
  assert.deepEqual(Object.keys(intents[0]).sort(), ['app', 'id', 'url']);
  assert.equal(intents[0].url, JIRA);
});

test('⚠ claim re-checks the shape: a bad entry written straight into the queue is never handed over', () => {
  resetQueue();
  db.setState(di.STATE_KEY, JSON.stringify({
    pending: [{ id: 'di_bad', app: 'open-url', url: 'https://evil.example.com/x', host: null, at: new Date().toISOString() }],
    outcomes: [], claimed: [],
  }));
  assert.deepEqual(di.claim({ canOpen: ['open-url'] }).intents, []);
});

test('a link intent reports like any other: waiting → claimed → opened, and is in flight meanwhile', () => {
  resetQueue();
  const q = di.queueUrl(TASK, { host: 'L', label: 'the task in NEURO' });
  assert.equal(di.status(q.intent.id).state, 'waiting');
  assert.equal(di.inFlight().requested[0].label, 'the task in NEURO');
  di.claim({ host: 'L', canOpen: ['open-url'] });
  assert.equal(di.status(q.intent.id).state, 'claimed');
  assert.equal(di.inFlight().taken[0].label, 'the task in NEURO');
  di.record(q.intent.id, true, 'opened');
  assert.equal(di.status(q.intent.id).state, 'opened');
});

// ── What gets opened ─────────────────────────────────────────────────────────

test('opensFor: note, Jira, draft — at most three, every one on the allowlist', () => {
  const ctx = {
    notes: [{ title: 'Rota plan', open: { kind: 'note', path: 'Projects/Support/Rota plan.md' } }],
    jira: 'NT-14855',
    draft: { title: 'Cover plan', path: 'Projects/Working/Cover plan (draft).md' },
  };
  const o = fl.opensFor(42, ctx);
  assert.deepEqual(o.map((x) => x.kind), ['note', 'jira', 'draft']);
  assert.equal(o[0].url, NOTE);
  assert.equal(o[1].url, JIRA);
  assert.equal(o[2].url, DRAFTS);
  for (const x of o) assert.equal(di.urlAllowed(x.url), true);
});

test('opensFor: with nothing known, the task in NEURO; never more than three', () => {
  assert.deepEqual(fl.opensFor(42, {}).map((x) => x.url), [TASK]);
  const many = { notes: [{ title: 'n', open: { kind: 'note', path: 'a.md' } }], jira: 'NT-1', draft: { title: 'd' } };
  assert.ok(fl.opensFor(7, many).length <= fl.MAX_OPENS);
});

test('opensFor drops a URL the allowlist refuses rather than sending it', () => {
  const o = fl.opensFor(42, { jira: 'not a key' });
  assert.equal(o.some((x) => x.kind === 'jira'), false);
});

// ── Never into a locked, silent or old laptop ────────────────────────────────

test('reachable: unknown, locked/away and an agent without open-url are all refused, each with a reason', () => {
  assert.equal(fl.reachable({ known: false }).ok, false);
  assert.match(fl.reachable({ known: true, app: null, host: 'L', canOpen: ['open-url'] }).why, /locked|away/);
  assert.match(fl.reachable({ known: true, app: 'Code', host: 'L', canOpen: ['music'] }).why, /restart/);
  assert.deepEqual(fl.reachable({ known: true, app: 'Code', host: 'L', canOpen: ['open-url'] }), { ok: true, host: 'L' });
});

test('⚠ a locked laptop: nothing is queued, and the card says it is not reachable', () => {
  resetQueue();
  const calls = [];
  const r = fl.openForBlock({ blockId: 9001, taskId: 42, context: { jira: 'NT-1' }, deps: {
    run: () => ({ known: true, app: null, host: 'L', canOpen: ['open-url'] }),
    queueUrl: (...a) => { calls.push(a); return { ok: true, intent: { id: 'x' } }; },
  } });
  assert.equal(calls.length, 0);
  assert.deepEqual(r.opens, []);
  const v = fl.viewFor(9001, { deps: { hosts: () => [] } });
  assert.match(v.unreachable, /isn’t reachable/);
});

test('reachable laptop: queued once, host-scoped, and a second choose of the same task opens nothing new', () => {
  resetQueue();
  const deps = { run: () => ({ known: true, app: 'Code', host: 'LAPTOP', canOpen: ['open-url', 'music'] }) };
  const ctx = { notes: [{ title: 'Rota plan', open: { kind: 'note', path: 'Projects/Support/Rota plan.md' } }], jira: 'NT-14855' };
  const r = fl.openForBlock({ blockId: 9002, taskId: 42, context: ctx, deps });
  assert.equal(r.opens.length, 2);
  const again = fl.openForBlock({ blockId: 9002, taskId: 42, context: ctx, deps });
  assert.equal(again.already, true);
  const claimed = di.claim({ host: 'LAPTOP', canOpen: ['open-url'] }).intents;
  assert.equal(claimed.length, 2, 'not four');
  assert.deepEqual(di.claim({ host: 'OTHER', canOpen: ['open-url'] }).intents, []);
  // The card follows the outcome.
  di.record(claimed[0].id, true, 'opened');
  const v = fl.viewFor(9002, { deps: { hosts: () => [] } });
  assert.deepEqual(v.opens.map((o) => o.state), ['opened', 'claimed']);
  assert.match(v.opens[0].say, /^Opened “Rota plan” in Obsidian on your laptop$/);
  assert.match(v.opens[1].say, /^Opening NT-14855 in Jira on your laptop$/);
});

// ── Do Not Disturb: read-only, closed shape ──────────────────────────────────

test('sanitiseDnd keeps only on/off/unknown; a sample carries it to hosts()', () => {
  assert.deepEqual(desktop.sanitiseDnd({ state: 'on', extra: 'x' }), { state: 'on' });
  assert.equal(desktop.sanitiseDnd({ state: 'priority' }), null);
  assert.equal(desktop.sanitiseDnd('on'), null);
  db.setState(desktop.STATE_KEY, '');
  desktop.record({ app: 'Code', host: 'LAPTOP', dnd: { state: 'off', profile: 0, secret: 'no' } });
  desktop.record({ app: 'Code', host: 'LAPTOP' }); // an older agent: keeps what it had
  const h = desktop.hosts().find((x) => x.host === 'LAPTOP');
  assert.equal(h.dnd.state, 'off');
  assert.deepEqual(Object.keys(h.dnd).sort(), ['at', 'state']);
});

test('dndSay: only during the hold, and never claims NEURO turned it on', () => {
  assert.equal(fl.dndSay({ state: 'on' }, false), null);
  assert.equal(fl.dndSay({ state: 'on' }, true), 'Laptop: Do not disturb is on');
  assert.match(fl.dndSay({ state: 'off' }, true), /still on — Win\+N/);
  assert.equal(fl.dndSay({ state: 'unknown' }, true), null);
});

// ── Wiring into focus blocks ─────────────────────────────────────────────────

function fakeGraph() {
  let n = 0;
  return {
    create: async () => { n++; return { created: true, event: { id: `ev-${n}-${Date.now()}`, webLink: null } }; },
    update: async () => ({ updated: true }),
    remove: async () => ({ deleted: true }),
  };
}

test('choosing a task asks the laptop to get ready for THAT task', async () => {
  const t = taskStore.createTask({ text: 'Write the laptop-ready test task', moscow: 'must', source: 'manual' }).id;
  const calls = [];
  const deps = { graph: fakeGraph(), push: async () => {}, laptop: { openForBlock: (a) => { calls.push(a); return { opens: [{ label: 'x' }] }; }, viewFor: () => null } };
  const { blockId } = await focusBlocks.createOpenBlock({ date: '2026-11-02', startTime: '10:30', minutes: 45, deps });
  const r = await focusBlocks.choose(blockId, { taskId: t }, { now: new Date(2026, 10, 2, 10, 31), deps });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskId, t);
  assert.equal(calls[0].blockId, blockId);
  assert.deepEqual(r.laptop, { opens: [{ label: 'x' }] });
});

test('ready: a hand-made block with ONE task opens for it; an open block does not', async () => {
  const t = taskStore.createTask({ text: 'Hand-made block single task', moscow: 'must', source: 'manual' }).id;
  const calls = [];
  const deps = { graph: fakeGraph(), push: async () => {}, laptop: { openForBlock: (a) => { calls.push(a); return { opens: [] }; } } };
  const manual = await focusBlocks.createOpenBlock({ date: '2026-11-03', startTime: '14:00', minutes: 30, deps });
  db.addTaskBlockItem(manual.blockId, t, null);
  focusBlocks.putState(manual.blockId, { kind: 'manual' });
  await focusBlocks.createOpenBlock({ date: '2026-11-03', startTime: '16:00', minutes: 30, deps });
  await focusBlocks.tick({ now: new Date(2026, 10, 3, 13, 56), deps });
  await focusBlocks.tick({ now: new Date(2026, 10, 3, 15, 56), deps });
  assert.deepEqual(calls.map((c) => [c.blockId, c.taskId]), [[manual.blockId, t]]);
});

// ── GET /api/focus-blocks/focus-state ───────────────────────────────────────

test('focus-state over HTTP: false with no hold; true with the task and end while held', async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/focus-blocks', require('../routes/focus-blocks'));
  const server = http.createServer(app).listen(0);
  const port = server.address().port;
  const get = () => new Promise((resolve, reject) => {
    http.get({ port, path: '/api/focus-blocks/focus-state' }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(JSON.parse(b)));
    }).on('error', reject);
  });
  try {
    db.setState(focusHold.KEY, '');
    assert.deepEqual(await get(), { ok: true, inFocus: false, until: null, task: null, blockId: null });
    const until = new Date(Date.now() + 30 * 60000);
    focusHold.set({ blockId: 77, until, taskText: 'Rota plan' });
    const r = await get();
    assert.equal(r.inFocus, true);
    assert.equal(r.task, 'Rota plan');
    assert.equal(r.until, until.toISOString());
    assert.equal(r.blockId, 77);
    focusHold.set({ blockId: 77, until: new Date(Date.now() - 1000) });
    assert.equal((await get()).inFocus, false, 'an expired hold is not focus');
  } finally {
    db.setState(focusHold.KEY, '');
    server.close();
  }
});

// ── The agent's own check, in a real Windows PowerShell ──────────────────────

const PS = process.platform === 'win32' ? 'powershell.exe' : null;
const skip = !PS && 'no Windows PowerShell here — the agent check was NOT exercised';
const MODULE = path.resolve(__dirname, '..', '..', 'desktop-agent', 'focus-laptop.ps1');
const BLOCKERS = [
  "function global:Start-Process { throw 'test harness: Start-Process is blocked' }",
  "function global:Add-Type { throw 'test harness: Add-Type is blocked' }",
].join('\n');
function runPs(script) {
  const file = path.join(root, `h${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(file, BLOCKERS + '\n' + script, 'utf8');
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
    encoding: 'utf8', env: { ...process.env, NEURO_AGENT_TEST: '1' }, timeout: 60000,
  });
  if (r.status !== 0) throw new Error(`powershell failed (${r.status}): ${r.stderr || r.stdout}`);
  const line = r.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith('JSON:')).pop();
  return JSON.parse(line.slice(5));
}
const q = (p) => `'${p.replace(/'/g, "''")}'`;

test('agent: the same shapes pass and the same bad URLs fail, on the laptop’s OWN host list', { skip }, () => {
  const good = [NOTE, JIRA, TASK, DRAFTS];
  const bad = [
    'https://evil.example.com/browse/NT-1', 'http://nurturtech.atlassian.net/browse/NT-1',
    'https://nurturtech.atlassian.net/browse/NT-1?x=1', 'https://neuro.nickward.co.uk/?view=settings',
    'obsidian://open?vault=Other&file=x', 'obsidian://open?vault=Nicks%20knowledge%20base&file=..%2Fx',
    'obsidian://new?vault=Nicks%20knowledge%20base&file=x', 'javascript:alert(1)', 'file:///C:/Windows/System32/cmd.exe',
    'https://neuro.nickward.co.uk/?view=drafts&x=1', 'https://user@neuro.nickward.co.uk/?view=drafts',
  ];
  const json = path.join(root, 'urls.json');
  fs.writeFileSync(json, JSON.stringify({ good, bad }), 'utf8');
  const r = runPs(`
$ErrorActionPreference = 'Stop'
. ${q(MODULE)}
$u = Get-Content -Raw ${q(json)} | ConvertFrom-Json
$out = @{ good = @($u.good | ForEach-Object { [bool](Test-NeuroOpenUrl $_) }); bad = @($u.bad | ForEach-Object { [bool](Test-NeuroOpenUrl $_) });
  narrowed = [bool](Test-NeuroOpenUrl '${JIRA}' @('neuro.nickward.co.uk')) }
"JSON:" + ($out | ConvertTo-Json -Compress)
`);
  assert.deepEqual(r.good, good.map(() => true));
  assert.deepEqual(r.bad, bad.map(() => false));
  assert.equal(r.narrowed, false, 'a host the laptop does not list is refused even if NEURO built it');
});

test('agent: a refused URL and a locked session never reach the native open; the native open refuses in test mode', { skip }, () => {
  const r = runPs(`
$ErrorActionPreference = 'Stop'
. ${q(MODULE)}
$script:calls = 0
$rec = { param($u) $script:calls++; $true }
$bad = Invoke-NeuroOpenUrlIntent ([pscustomobject]@{ url = 'https://evil.example.com/x' }) $script:NeuroDefaultOpenHosts 'Nicks knowledge base' { $false } $rec
$locked = Invoke-NeuroOpenUrlIntent ([pscustomobject]@{ url = '${TASK}' }) $script:NeuroDefaultOpenHosts 'Nicks knowledge base' { $true } $rec
$afterRefusals = $script:calls
$good = Invoke-NeuroOpenUrlIntent ([pscustomobject]@{ url = '${TASK}' }) $script:NeuroDefaultOpenHosts 'Nicks knowledge base' { $false } $rec
$real = Invoke-NeuroOpenUrlIntent ([pscustomobject]@{ url = '${TASK}' }) $script:NeuroDefaultOpenHosts 'Nicks knowledge base' { $false } \${function:Invoke-NeuroOpenUrlNative}
$dnd = @( (ConvertTo-NeuroDndState 0), (ConvertTo-NeuroDndState 1), (ConvertTo-NeuroDndState 2), (ConvertTo-NeuroDndState 7), (ConvertTo-NeuroDndState $null), (Read-WindowsDndState) )
"JSON:" + (@{ bad = $bad; locked = $locked; afterRefusals = $afterRefusals; good = $good; calls = $script:calls; real = $real; dnd = $dnd } | ConvertTo-Json -Compress -Depth 4)
`);
  assert.equal(r.bad.ok, false);
  assert.equal(r.locked.ok, false);
  assert.match(r.locked.detail, /locked/);
  assert.equal(r.afterRefusals, 0, 'nothing opened for a refused URL or a locked session');
  assert.equal(r.good.ok, true);
  assert.equal(r.calls, 1);
  assert.equal(r.real.ok, false);
  assert.match(r.real.detail, /test mode forbids/);
  assert.deepEqual(r.dnd, ['off', 'on', 'on', 'unknown', 'unknown', 'unknown'], 'the WNF read is blocked by the harness and reads unknown');
});
