'use strict';

// Task activity (15 Oct 2026; A + C + B, not D): Nick's choice is the only
// thing that sets a task's activity; where a task came from and app use seen in
// focus sessions are suggestions and reviewable evidence; SAiM picks the app
// per device and asks "What will you use?" when nobody has said. Real DB,
// real composer, real resolver, real HTTP behind real auth and the authority guard.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-activity-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'activity.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
fs.mkdirSync(path.join(tmp, 'vault'), { recursive: true });

const db = require('../db/database');
const TA = require('../../shared/task-activity.cjs');
const C = require('../../shared/attention-contracts.cjs');
const NH = require('./neuro-handoff');
const POL = require('../../saim/policy/attention-policy.cjs');
const H = require('../../saim/policy/handoff.cjs');
const SC = require('./saim-policy-scenarios');

let ta; let ts; let server; let base;
const T = {};
test.before(async () => {
  await db.init();
  ta = require('./task-activity');
  ts = require('./task-store');
  T.plain = ts.createTask({ text: 'Write an email in Excel about code', source: 'manual' }).id; // wording that would fool a parser
  T.fromEmail = ts.createTask({ text: 'Reply to Sandford', source: 'email-promotion', originPath: 'email:AAMkX' }).id;
  T.fromJira = ts.createTask({ text: 'NT-1 portal', source: 'jira-assigned', originPath: 'https://x.atlassian.net/browse/NT-1' }).id;
  T.other = ts.createTask({ text: 'Plan the Q4 note', source: 'meeting-promotion' }).id;
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require('./api-auth'));
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/task-activity', require('../routes/task-activity'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const req = (method, p, body, headers = { 'X-NEURO-PIN': 'pin-1234' }) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const r = http.request(`${base}${p}`, { method, headers: { ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
    let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch { /* */ } resolve({ status: res.statusCode, json }); });
  });
  r.on('error', reject); if (data) r.write(data); r.end();
});
const choiceRow = (id) => db.get('SELECT * FROM task_activity WHERE task_id = ?', [id]);

// ── Precedence (pure) ──────────────────────────────────────────────────────────

test('precedence: only Nick’s choice sets an activity; source and observed are suggestions', () => {
  const task = { source: 'email-promotion', originPath: 'email:AAMk' };
  const obs = [{ id: 7, status: 'pending', suggestedActivity: 'spreadsheet' }, { id: 8, status: 'dismissed', suggestedActivity: 'code' }];
  const none = TA.resolveActivity({ task, observations: obs });
  assert.equal(none.activity, null, 'suggestions never become the activity');
  assert.deepEqual(none.suggestions, [{ activity: 'email', basis: 'source' }, { activity: 'spreadsheet', basis: 'observed', ref: 'observation:7' }]);
  assert.ok(!none.suggestions.some((s) => s.activity === 'code'), 'a dismissed observation suggests nothing');
  const chosen = TA.resolveActivity({ choice: 'write', task, observations: obs });
  assert.deepEqual(chosen, { activity: 'write', basis: 'stated', unsure: false, suggestions: [] }, 'the choice wins outright');
  const unsure = TA.resolveActivity({ choice: 'unsure', task, observations: obs });
  assert.equal(unsure.activity, null);
  assert.equal(unsure.unsure, true);
  assert.equal(TA.resolveActivity({ choice: 'vibes', task }).activity, null, 'an unknown stored value is not an activity');
});

test('source suggestions: only routes that say something; never from wording', () => {
  assert.equal(TA.sourceSuggestion({ source: 'email-promotion' }), 'email');
  assert.equal(TA.sourceSuggestion({ source: 'personal-email-promotion' }), 'email');
  assert.equal(TA.sourceSuggestion({ source: 'manual', originPath: 'email:AAMk' }), 'email');
  for (const s of ['jira-assigned', 'meeting-promotion', 'master-todo-import', 'capability-suggestion', 'manual', null]) assert.equal(TA.sourceSuggestion({ source: s }), null, String(s));
  const src = fs.readFileSync(require.resolve('../../shared/task-activity.cjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(src.includes('resolveActivity'), 'positive control');
  for (const bad of [/\.text\b/, /\.title\b/, /\.description\b/, /\.notes\b/]) assert.ok(!bad.test(src), `never reads ${bad}`);
});

test('observed app use: active minutes per app inside the session, idle/locked/gaps excluded; suggestion needs ≥10 min and ≥50%', () => {
  const t0 = Date.parse('2026-10-15T10:00:00Z');
  const at = (min) => new Date(t0 + min * 60000).toISOString();
  const samples = [
    { at: at(-5), app: 'EXCEL' }, // before the session
    { at: at(0), app: 'WINWORD' }, { at: at(2), app: 'WINWORD' }, { at: at(4), app: 'WINWORD' }, { at: at(6), app: 'WINWORD' },
    { at: at(8), app: 'WINWORD' }, { at: at(10), app: 'WINWORD' }, { at: at(12), app: 'chrome' }, { at: at(14), app: 'WINWORD', idleSeconds: 900 },
    { at: at(16), app: null, locked: true }, { at: at(18), app: 'WINWORD' }, { at: at(40), app: 'WINWORD' }, // 22-minute gap: not desk time
  ];
  const apps = TA.observeWindow(samples, t0, t0 + 45 * 60000);
  // 0–12 min Word, 12–14 chrome, 14–18 idle/locked, 18–40 a gap (not desk time), 40–45 Word to the session’s end.
  assert.deepEqual(apps, [{ app: 'WINWORD', minutes: 17 }, { app: 'chrome', minutes: 2 }]);
  assert.deepEqual(TA.observationSuggestion(apps), { activity: 'write', minutes: 17, share: 0.89 });
  assert.equal(TA.observationSuggestion([{ app: 'WINWORD', minutes: 8 }]), null, 'under 10 minutes says nothing');
  assert.equal(TA.observationSuggestion([{ app: 'WINWORD', minutes: 12 }, { app: 'chrome', minutes: 20 }]), null, 'under half the time says nothing');
  assert.equal(TA.observationSuggestion([{ app: 'chrome', minutes: 60 }]), null, 'a browser is evidence of nothing');
});

// ── The stored choice ──────────────────────────────────────────────────────────

test('setChoice: authoritative, validated (refused, never normalised), cleared with null, every change kept', () => {
  assert.equal(ta.setChoice(T.plain, 'write').ok, true);
  assert.equal(choiceRow(T.plain).choice, 'write');
  assert.equal(ta.setChoice(T.plain, 'spreadsheet', { via: 'saim' }).ok, true, 'Nick can change his mind');
  assert.equal(choiceRow(T.plain).via, 'saim');
  assert.equal(ta.setChoice(T.plain, 'Writing').status, 400);
  assert.equal(ta.setChoice(T.plain, 'write', { via: 'observation-review' }).status, 400, 'only accepting an observation may write via observation-review');
  assert.equal(ta.setChoice(999999, 'write').status, 404);
  assert.equal(ta.setChoice(T.plain, 'unsure').ok, true);
  assert.equal(ta.setChoice(T.plain, null).ok, true);
  assert.equal(choiceRow(T.plain) ?? null, null);
  const hist = db.all('SELECT event, choice FROM task_activity_events WHERE task_id = ? ORDER BY id', [T.plain]);
  assert.deepEqual(hist.map((h) => `${h.event}:${h.choice || ''}`), ['stated:write', 'stated:spreadsheet', 'stated:unsure', 'cleared:']);
  assert.throws(() => db.run('DELETE FROM task_activity_events'), /append-only/);
  assert.throws(() => db.run("UPDATE task_activity_events SET choice = 'code'"), /append-only/);
});

// ── Observations: soft, reviewable, never a choice by themselves ───────────────

test('an observation is recorded as evidence and NEVER writes a choice; review decides', () => {
  const o = ta.recordObservation({ taskId: T.other, sessionId: 'fs_1', startedAt: '2026-10-15T10:00:00Z', endedAt: '2026-10-15T10:40:00Z', apps: [{ app: 'EXCEL', minutes: 30 }] });
  assert.equal(o.ok, true); assert.equal(o.suggested.activity, 'spreadsheet');
  assert.equal(choiceRow(T.other) ?? null, null, 'evidence is not a choice');
  assert.equal(ta.recordObservation({ taskId: T.other, sessionId: 'fs_1', startedAt: 'a', endedAt: 'b', apps: [{ app: 'EXCEL', minutes: 30 }] }).created, false, 'one per session');
  let view = ta.forTask(T.other);
  assert.equal(view.resolved.activity, null);
  assert.deepEqual(view.resolved.suggestions, [{ activity: 'spreadsheet', basis: 'observed', ref: `observation:${o.observationId}` }]);
  assert.equal(ta.reviewObservation(o.observationId, 'accept').choice, 'spreadsheet');
  assert.equal(choiceRow(T.other).via, 'observation-review');
  assert.equal(ta.reviewObservation(o.observationId, 'dismiss').status, 409, 'already reviewed');
  const o2 = ta.recordObservation({ taskId: T.other, sessionId: 'fs_2', startedAt: 'a', endedAt: 'b', apps: [{ app: 'chrome', minutes: 30 }] });
  assert.equal(o2.suggested, null);
  assert.equal(ta.reviewObservation(o2.observationId, 'accept').status, 409, 'nothing to accept when it suggests nothing');
  assert.equal(ta.reviewObservation(o2.observationId, 'dismiss').ok, true);
  view = ta.forTask(T.other);
  assert.equal(view.resolved.activity, 'spreadsheet');
});

test('a finished focus session on a task records an observation from the laptop’s samples — and no choice', () => {
  const da = require('./desktop-activity');
  const fsn = require('./focus-session');
  const t0 = Date.now() - 30 * 60000;
  const started = fsn.start({ taskId: T.fromJira, text: 'NT-1 portal', minutes: 30, force: true }, t0);
  assert.equal(started.ok, true);
  for (let m = 1; m <= 25; m += 2) da.record({ app: 'Code', at: new Date(t0 + m * 60000).toISOString(), host: 'LAPTOP' });
  fsn.finish({}, t0 + 27 * 60000);
  const obs = db.all('SELECT * FROM task_activity_observations WHERE task_id = ?', [T.fromJira]);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].suggested_activity, 'code');
  assert.equal(obs[0].status, 'pending');
  assert.equal(choiceRow(T.fromJira) ?? null, null, 'the session wrote evidence only');
  assert.ok(!/title|window/i.test(obs[0].apps_json), 'process names and minutes only');
});

// ── Into NEURO's hand-off data and SAiM's resolver ─────────────────────────────

function leadBlock(taskId, taskActivity) {
  const s = SC.SCENARIOS.find((x) => x.id === '1').build();
  const cands = JSON.parse(JSON.stringify(s.candidates));
  const block = cands.candidates.find((c) => c.id === 'block:130');
  block.facts.tasks = [{ taskId, text: 'x' }];
  Object.assign(block, NH.handoffFor(block, null, { taskActivity }));
  const now = Date.parse(s.decision.decidedAt);
  return { cands, now, decision: POL.decide(cands, { surface: 'work-desktop', now }) };
}
const APPS = [
  { id: 'claude', label: 'Claude', capabilities: ['ai'], available: true, running: null, foreground: null },
  { id: 'word', label: 'Word', capabilities: ['docs'], available: true, running: null, foreground: null },
  { id: 'excel', label: 'Excel', capabilities: ['sheets'], available: true, running: null, foreground: null },
  { id: 'outlook', label: 'Outlook', capabilities: ['mail'], available: true, running: null, foreground: null },
];
const dev = (now, extra = {}) => ({ contract: 'saim-device-v1', known: true, observedAt: new Date(now - 60000).toISOString(), apps: APPS, ...extra });
const resolve = (x, device) => { const out = H.resolveHandoff({ decision: x.decision, candidates: x.cands, device: device || dev(x.now), now: x.now }); assert.equal(C.checkHandoff(out).ok, true, C.checkHandoff(out).reason); return out; };

test('Nick’s choice becomes the intent’s activity; SAiM picks this device’s app for it', () => {
  ta.setChoice(T.plain, 'write');
  const x = leadBlock(T.plain, ta.forOpenTasks());
  const block = x.cands.candidates.find((c) => c.id === 'block:130');
  assert.deepEqual(block.handoffIntent, { kind: 'work-step', activity: 'write', basis: 'stated' });
  assert.deepEqual(block.activitySuggestions, []);
  assert.equal(resolve(x).handoff.primary.label, 'Open Word');
  ta.setChoice(T.plain, null);
});

test('a source suggestion does NOT pick an app: SAiM asks, with the suggestion first and marked', () => {
  const x = leadBlock(T.fromEmail, ta.forOpenTasks());
  const block = x.cands.candidates.find((c) => c.id === 'block:130');
  assert.equal(block.handoffIntent.activity, null, 'email-promotion is a suggestion, not an activity');
  assert.deepEqual(block.activitySuggestions, [{ activity: 'email', basis: 'source' }]);
  const out = resolve(x);
  assert.equal(out.handoff, null, 'no app is chosen from a suggestion');
  assert.equal(out.ask.question, 'What will you use?');
  assert.equal(out.ask.taskId, T.fromEmail);
  assert.deepEqual(out.ask.options[0], { choice: 'email', label: 'Outlook', app: 'outlook', suggested: true, basis: 'source' });
  assert.deepEqual(out.ask.options[out.ask.options.length - 1], { choice: 'unsure', label: 'Not sure — open the task in NEURO' });
  assert.equal(out.ask.deviceSpecific, true);
  assert.ok(out.ask.options.filter((o) => o.suggested).length === 1, 'only the suggestion is marked');
});

test('an observed suggestion is offered first, never pre-chosen; a stale device asks in plain activity words', () => {
  const x = leadBlock(T.fromJira, ta.forOpenTasks()); // has the pending 'code' observation from the session test
  const out = resolve(x);
  assert.equal(out.handoff, null);
  assert.deepEqual(out.ask.options[0], { choice: 'code', label: 'Code', suggested: true, basis: 'observed' }, 'no code app declared here → the activity word');
  const stale = resolve(x, dev(x.now, { observedAt: new Date(x.now - 3600e3).toISOString() }));
  assert.equal(stale.ask.deviceSpecific, false);
  assert.ok(stale.ask.options.every((o) => !o.app), 'no app named from an out-of-date device report');
  assert.ok(stale.ask.options.some((o) => o.label === 'Writing'));
});

test('"Not sure": the hand-off is the task in NEURO, and SAiM doesn’t ask again', () => {
  ta.setChoice(T.other, 'unsure');
  const x = leadBlock(T.other, ta.forOpenTasks());
  const block = x.cands.candidates.find((c) => c.id === 'block:130');
  assert.deepEqual(block.handoffIntent, { kind: 'work-step', activity: null, basis: 'stated', unsure: true });
  const out = resolve(x);
  assert.deepEqual(out.handoff.primary, { label: 'Open the task in NEURO', target: { type: 'link', href: `neuro:?item=task%3A${T.other}`, role: 'canonical' } });
  assert.equal(out.ask, undefined);
});

test('no task to store an answer against → no ask (never a question that can’t be saved)', () => {
  const x = leadBlock(null, ta.forOpenTasks());
  const out = resolve(x);
  assert.equal(out.handoff, null);
  assert.equal(out.ask, undefined);
});

test('malformed suggestions or an unsure-with-activity intent degrade the hand-off; the decision stands', () => {
  const x = leadBlock(T.fromEmail, ta.forOpenTasks());
  for (const corrupt of [(b) => { b.activitySuggestions = [{ activity: 'vibes', basis: 'source' }]; }, (b) => { b.activitySuggestions = [{ activity: 'email', basis: 'guess' }]; }, (b) => { b.handoffIntent = { kind: 'work-step', activity: 'write', unsure: true }; }]) {
    const y = JSON.parse(JSON.stringify(x));
    corrupt(y.cands.candidates.find((c) => c.id === 'block:130'));
    assert.equal(C.checkCandidates(y.cands).ok, true);
    const out = H.resolveHandoff({ decision: POL.decide(y.cands, { surface: 'work-desktop', now: y.now }), candidates: y.cands, device: dev(y.now), now: y.now });
    assert.equal(out.handoff, null);
    assert.match(out.reason, /malformed/);
    assert.equal(out.ask, undefined);
  }
});

// ── Routes ─────────────────────────────────────────────────────────────────────

test('routes: Nick states and reviews over HTTP; machine clients are refused; GET shows choice, suggestions and history', async () => {
  let r = await req('POST', `/api/task-activity/${T.fromEmail}`, { choice: 'email', via: 'saim' });
  assert.equal(r.status, 200); assert.equal(r.json.choice, 'email');
  r = await req('GET', `/api/task-activity/${T.fromEmail}`);
  assert.equal(r.status, 200); assert.equal(r.json.choice.choice, 'email'); assert.equal(r.json.resolved.basis, 'stated');
  assert.equal((await req('POST', `/api/task-activity/${T.fromEmail}`, { choice: 'Email' })).status, 400);
  assert.equal((await req('POST', `/api/task-activity/${T.fromEmail}`, {})).status, 400, 'choice is required; null clears');
  assert.equal((await req('POST', '/api/task-activity/999999', { choice: 'write' })).status, 404);
  const machine = await req('POST', `/api/task-activity/${T.fromEmail}`, { choice: 'code' }, { 'X-NEURO-API-TOKEN': 'tok-5678' });
  assert.equal(machine.status, 403, 'no machine states Nick’s choice');
  assert.equal(choiceRow(T.fromEmail).choice, 'email');
  const o = ta.recordObservation({ taskId: T.fromEmail, sessionId: 'fs_9', startedAt: 'a', endedAt: 'b', apps: [{ app: 'OUTLOOK', minutes: 20 }] });
  const mreview = await req('POST', `/api/task-activity/observations/${o.observationId}/review`, { decision: 'accept' }, { 'X-NEURO-API-TOKEN': 'tok-5678' });
  assert.equal(mreview.status, 403, 'no machine accepts evidence as Nick’s choice');
  r = await req('POST', `/api/task-activity/observations/${o.observationId}/review`, { decision: 'dismiss' });
  assert.equal(r.status, 200); assert.equal(r.json.status, 'dismissed');
  assert.equal((await req('GET', `/api/task-activity/${T.fromEmail}`, undefined, {})).status, 401);
});
