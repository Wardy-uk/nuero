'use strict';

/**
 * The set-up wizard: judged from evidence, never from ticks; unknown is not
 * done; skipping is reversible and never marks an item done; a device's own
 * report fills what NEURO cannot see; the next step is the most needed thing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-setup-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
const db = require('../db/database');
const S = require('./setup-check');

const NOW = Date.parse('2026-10-04T12:00:00Z');
const base = (over = {}) => ({
  microsoft: { configured: true, authenticated: true }, vault: true, ai: true, vapid: true, apns: true,
  approvalCode: true, sendingEnabled: false, sources: [], desktopHosts: [], apnsApps: [],
  containers: 0, unclassified: 0, goals: 0, companions: 0, reports: [], clients: {}, ...over,
});
const item = (out, id) => out.items.find((i) => i.id === id);

test('a sense that has never reported is TODO; one that reports is done; one gone quiet needs a look', () => {
  const out = S.assess(base({ sources: [
    { sourceId: 'healthkit.neuro-ios', verdict: 'seeing', verdictLabel: 'Seeing', transport: { lastSuccessAt: '2026-10-04T11:00:00Z' } },
    { sourceId: 'eventkit.neuro-ios', verdict: 'stale', verdictLabel: 'Stale', transport: { lastSuccessAt: '2026-10-01T09:00:00Z' } },
  ] }), { now: NOW });
  assert.equal(item(out, 'iphone-neuro.health').status, 'done');
  assert.equal(item(out, 'iphone-neuro.calendar').status, 'attention');
  assert.equal(item(out, 'iphone-saim.health').status, 'todo');
  assert.equal(item(out, 'iphone-neuro.reminders').status, 'todo', 'no row at all is never-heard, not done');
});

test('not knowing is not done: a fact only the laptop can see is unknown until the laptop reports', () => {
  const out = S.assess(base(), { now: NOW });
  assert.equal(item(out, 'windows.saim').status, 'unknown');
  assert.match(item(out, 'windows.saim').evidence, /laptop/);
  const reported = S.assess(base({ reports: [{ platform: 'windows', host: 'DESKTOP', at: '2026-10-04T10:00:00Z',
    checks: [{ id: 'saim-electron', ok: true, detail: 'installed' }, { id: 'mcp', ok: false }] }] }), { now: NOW });
  assert.equal(item(reported, 'windows.saim').status, 'done');
  assert.equal(item(reported, 'windows.mcp').status, 'todo');
});

test('a report older than a fortnight is not evidence about the machine as it is now', () => {
  const out = S.assess(base({ reports: [{ platform: 'windows', host: 'D', at: '2026-09-01T10:00:00Z', checks: [{ id: 'saim-electron', ok: true }] }] }), { now: NOW });
  assert.equal(item(out, 'windows.saim').status, 'unknown');
});

test('skipping never marks done, and a done item is not hidden by an old skip', () => {
  const out = S.assess(base({ goals: 0 }), { now: NOW, skipped: { 'life.goals': { at: 'x' }, 'server.microsoft': { at: 'x' } } });
  assert.equal(item(out, 'life.goals').status, 'skipped');
  assert.equal(item(out, 'server.microsoft').status, 'done', 'evidence beats a skip');
});

test('sending switched off is optional and never the next step', () => {
  const out = S.assess(base(), { now: NOW });
  assert.equal(item(out, 'server.sending').need, 'optional');
  assert.notEqual(out.nextStep, 'server.sending');
});

test('the next step is the most needed thing: required before recommended before optional', () => {
  const out = S.assess(base({ microsoft: { configured: true, authenticated: false } }), { now: NOW });
  assert.equal(out.nextStep, 'server.microsoft');
  const noRequired = S.assess(base({ apns: false }), { now: NOW });
  const next = item(noRequired, noRequired.nextStep);
  assert.notEqual(next.need, 'optional');
  // Positive control: with everything evidenced, the next step is an optional one or nothing.
  const done = S.assess(base({ sources: ['healthkit', 'eventkit', 'reminders'].flatMap((k) => ['neuro', 'saim'].map((a) => ({ sourceId: `${k}.${a}-ios`, verdict: 'seeing' })))
    .concat([{ sourceId: 'location.neuro-ios', verdict: 'seeing' }, { sourceId: 'device.neuro-ios', verdict: 'seeing' }]),
  apnsApps: ['neuro', 'saim'], clients: { neuro: 'x', saim: 'y' }, desktopHosts: [{ host: 'DESKTOP-1', lastAt: 'x', canOpen: ['browser'] }] }), { now: NOW });
  assert.equal(done.complete, false, 'windows.saim is still unknown and recommended');
});

test('classification waits for calendars to exist rather than nagging', () => {
  assert.equal(item(S.assess(base({ containers: 0 }), { now: NOW }), 'life.calendars').status, 'unknown');
  assert.equal(item(S.assess(base({ containers: 4, unclassified: 3 }), { now: NOW }), 'life.calendars').status, 'todo');
  assert.equal(item(S.assess(base({ containers: 4, unclassified: 0 }), { now: NOW }), 'life.calendars').status, 'done');
});

test('every item says why and how, and every fix that opens a screen names one that exists', () => {
  const views = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'App.jsx'), 'utf8');
  for (const i of S.assess(base(), { now: NOW }).items) {
    assert.ok(i.why && i.title && i.fix && i.fix.where, i.id);
    if (i.fix.open) assert.match(views, new RegExp(`case '${i.fix.open}'`), `${i.id} opens a real view`);
  }
});

// ── real HTTP through a scratch DB ──
let server; let url;
test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/setup', require('../routes/setup'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); });

test('a device report round-trips into the wizard, and junk is refused', async () => {
  const post = (p, body) => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/api/setup/report', { platform: 'linux', host: 'x', checks: [] })).status, 400);
  assert.equal((await post('/api/setup/report', { platform: 'windows', checks: [] })).status, 400);
  const ok = await post('/api/setup/report', { platform: 'windows', host: 'DESKTOP-T', checks: [{ id: 'saim-electron', ok: true, detail: 'installed' }] });
  assert.equal(ok.status, 200);
  const res = await fetch(`${url}/api/setup`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.items.find((i) => i.id === 'windows.saim').status, 'done');
  assert.ok(body.reports.some((r) => r.host === 'DESKTOP-T'));
});

test('skip and un-skip over HTTP', async () => {
  await fetch(`${url}/api/setup/skip/life.ember`, { method: 'POST' });
  let body = await (await fetch(`${url}/api/setup`)).json();
  assert.equal(body.items.find((i) => i.id === 'life.ember').status, 'skipped');
  await fetch(`${url}/api/setup/skip/life.ember`, { method: 'DELETE' });
  body = await (await fetch(`${url}/api/setup`)).json();
  assert.equal(body.items.find((i) => i.id === 'life.ember').status, 'todo');
});

test('the Windows script stays Windows PowerShell 5.1 safe and reports back', () => {
  const ps = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop-agent', 'setup.ps1'), 'utf8')
    .replace(/<#[\s\S]*?#>/, '').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(ps, /\?\?/, 'no null-coalescing (PS 7 only)');
  assert.match(ps, /\/api\/setup\/report/);
  assert.match(ps, /if \(\$Check\) \{ return \$false \}/, '-Check never changes anything');
  assert.match(ps, /App Paths/, 'chrome resolves through App Paths, not only PATH');
});

test('both iOS apps reach the Set up screen (cross-repo guard)', (t) => {
  const IOS = path.resolve(__dirname, '..', '..', '..', 'nuero-ios');
  if (!fs.existsSync(IOS)) { t.skip('nuero-ios not beside this repo'); return; }
  const neuro = fs.readFileSync(path.join(IOS, 'Neuro', 'Features', 'MenuViews.swift'), 'utf8');
  const saim = fs.readFileSync(path.join(IOS, 'Saim', 'SaimControlsView.swift'), 'utf8');
  assert.match(neuro, /SetupView\(client: state\.client, app: "neuro"/);
  assert.match(saim, /SetupView\(client: state\.client, app: "saim"/);
  assert.match(saim, /\.sheet\(isPresented: \$showSetup\)/, 'SAiM Controls has no NavigationStack, so it must be a sheet');
});
