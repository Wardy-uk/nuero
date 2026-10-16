'use strict';

/**
 * SAiM Alt batch, 16 Oct 2026 — Nick's feedback on the live policy-driven desktop.
 *
 *   1. Jira hand-off: a block / task that IS a Jira ticket opens "Open NT-… in Jira",
 *      from NEURO's ledger link first, a configured-base URL from the key second, and
 *      only a strictly recognised key at the START of the wording third.
 *   2. Standup priority: a ritual NEURO says is due now, comes first and takes a few
 *      minutes leads over a running block (S4r); the block stays protected and resumes.
 *      A ritual that is merely later never interrupts.
 *   3. Block clock parity: "Start focus" (the route NEURO's task list uses), then the
 *      session's own clock and verbs. No timer of SAiM's own.
 *   4. Meeting attendance: "I'm not going" on the next / imminent meeting, NEURO's own
 *      route; a skipped meeting leaves the candidates and the decision.
 *
 * Real composer → real policy → real resolver → real adapter, with the live payload's
 * wording (block 123 / task 345 / Team Standup, 16 Oct 2026) as fixtures.
 *
 *   run: node --test backend/services/saim-alt-batch-1016.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const NC = require('./neuro-candidates');
const NH = require('./neuro-handoff');
const JK = require('../../shared/jira-key.cjs');
const C = require('../../shared/attention-contracts.cjs');
const POL = require('../../saim/policy/attention-policy.cjs');
const H = require('../../saim/policy/handoff.cjs');
const MF = require('./meeting-finish');

const ROOT = path.resolve(__dirname, '..', '..');
const ADAPTER_DIR = path.join(ROOT, 'saim', 'app', 'alt-v2-manifest');
const JIRA = 'https://nurturtech.atlassian.net';

const at = (h, m) => new Date(2026, 9, 16, h, m).getTime();
const iso = (h, m) => new Date(at(h, m)).toISOString();
const wall = (h, m) => `2026-10-16T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.0000000`;
const WORK = { value: 'work', basis: 'classified', why: 'you classified the Outlook calendar as work' };
const TASK = 'NT-24162: Survey West Hants Responses not showing on CSV and Being recorded';
const STANDUP_EVENT_ID = 'AAMkAGI1team-standup-occurrence';
const standupMeeting = { eventId: STANDUP_EVENT_ID, source: 'graph', subject: 'Team Standup', start: wall(10, 0), end: wall(10, 15), startAt: iso(10, 0), endAt: iso(10, 15), allDay: false, showAs: 'free', attendeesOther: true, sphere: WORK };
const ritualCard = (meta, reason = '2 minutes — do it before anything else', urgency = 'critical') => ({ kind: 'item', type: 'nudge', urgency, title: 'Do your standup', recordId: 'att_standup', reason, meta });
const STANDUP_NOW = ritualCard({ type: 'standup', nagCount: 0, estimateMinutes: 2, doFirst: true });

/** One moment → candidates → decision → hand-off. */
function build({ now = at(9, 40), session = null, primary = null, secondary = [], calendar = [standupMeeting], links = new Map([[345, { key: 'NT-24162', url: `${JIRA}/browse/NT-24162` }]]), projects = ['NT', 'NF'], text = TASK, block = true, jiraBase = JIRA } = {}) {
  const rows = block ? [{ blockId: 123, dateKey: '2026-10-16', startTime: '09:25', endTime: '09:55', status: 'scheduled', passed: false, tasks: [{ taskId: 345, text }] }] : [];
  const live = { rows, session, block: block ? { blockId: 123, startTime: '09:25', endTime: '09:55', running: true, tasks: [{ taskId: 345, text, running: Boolean(session) }], allTicked: false } : null };
  const payload = {
    poolAvailable: true, context: { activity: 'working', duty: { onDuty: true } }, work: { atDesk: true, deskKnown: true },
    primary, secondary, dropped: [], utterances: [],
    approvals: { known: true, needsApproval: 0, where: 'Actions, in NEURO on the desktop' },
    situation: { sections: { commitments: [] } }, home: { needsYou: [], exceptions: [] },
  };
  const facts = {
    calendar, calendarKnown: true, approvals: [], taskDomains: new Map([[345, { domain: 'work', basis: 'set' }]]),
    workingWindow: { hours: '08:00-18:00', todayIsWorking: true, todayStart: iso(8, 0), todayEnd: iso(18, 0), nextStart: iso(8, 0) },
    gaps: [], jiraBase, taskJira: links, jiraProjects: projects,
  };
  const candidates = NC.compose(payload, live, facts, { now });
  const decision = POL.decide(candidates, { surface: 'work-desktop', now });
  const device = { contract: 'saim-device-v1', known: true, observedAt: new Date(now - 60000).toISOString(), apps: [{ id: 'chrome', label: 'Chrome', available: true, running: null, foreground: null, capabilities: ['browser'] }] };
  const handoff = H.resolveHandoff({ decision, candidates, device, now });
  return { candidates, decision, handoff, payload: { candidates, saim: decision, handoff, work: payload.work, utterances: [] } };
}
const SESSION = (status = 'active', over = {}) => ({ id: 's1', taskId: 345, text: TASK, status, startedAt: iso(9, 28), startedTime: '09:28', elapsedMinutes: 12, plannedMinutes: 27, plannedAssumed: false, ...over });

let M; let View;
test.before(async () => {
  M = await import(pathToFileURL(path.join(ADAPTER_DIR, 'manifest.mjs')).href);
  const out = await esbuild.build({
    entryPoints: [path.join(ADAPTER_DIR, 'ManifestView.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node',
    jsx: 'automatic', external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{ name: 'css', setup(b) { b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' })); b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' })); } }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  View = mod.exports.default;
});
const noop = () => {};
const LIVE = (over = {}) => ({ onAct: noop, onDeskOpen: noop, deskStates: {}, onChoose: noop, linkFor: (h) => M.linkHref('https://neuro.example', h), busy: false, ...over });
const html = (vm, live = LIVE()) => renderToString(React.createElement(View, { v: vm, live }));
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
function clickables(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => clickables(n, out)); return out; }
  if (node.props && typeof node.props.onClick === 'function') out.push(node);
  if (typeof node.type === 'function') return clickables(node.type(node.props), out);
  if (node.props) clickables(node.props.children, out);
  return out;
}
const label = (e) => { const t = []; const walk = (n) => { if (typeof n === 'string' || typeof n === 'number') t.push(String(n)); else if (Array.isArray(n)) n.forEach(walk); else if (n && n.props) walk(n.props.children); }; walk(e.props.children); return t.join(''); };

// ── 1. Jira hand-off ────────────────────────────────────────────────────────

test('jira: the ledger link leads — "Open NT-24162 in Jira" to the ticket’s own URL; the task in NEURO is the alternative', () => {
  const { decision, handoff, candidates } = build();
  assert.equal(decision.lead.rule, 'S5 protected block');
  assert.equal(handoff.handoff.primary.label, 'Open NT-24162 in Jira');
  assert.equal(handoff.handoff.primary.name, 'NT-24162 in Jira');
  assert.deepEqual(handoff.handoff.primary.target, { type: 'link', href: `${JIRA}/browse/NT-24162`, role: 'control' });
  assert.deepEqual(handoff.handoff.alternatives.map((a) => a.label), ['Open the task in NEURO']);
  const block = candidates.candidates.find((c) => c.id === 'block:123');
  assert.equal(block.facts.tasks[0].jira.basis, 'ledger');
  assert.equal(C.targetsProblem(block.targets, 't'), null, 'the Jira target is a valid contract target');
});

test('jira: a ledger key with no stored URL → the configured base’s browse URL for that key', () => {
  const { handoff } = build({ links: new Map([[345, { key: 'NT-24162', url: null }]]) });
  assert.equal(handoff.handoff.primary.target.href, `${JIRA}/browse/NT-24162`);
});

test('jira: text only — a recognised key at the START of the wording is used; anywhere else, or an unknown project, is not', () => {
  const none = new Map();
  assert.equal(build({ links: none }).handoff.handoff.primary.label, 'Open NT-24162 in Jira', 'leading key, known project');
  assert.equal(build({ links: none, text: '[NT-24162] Survey responses' }).handoff.handoff.primary.label, 'Open NT-24162 in Jira', 'bracketed');
  for (const t of ['Chase Sam about NT-24162 tomorrow', 'ZZ-1: unknown project', 'NT-24162x: not a key', 'https://evil.example/browse/NT-1 fix']) {
    const { handoff } = build({ links: none, text: t });
    assert.ok(!(handoff.handoff && /Jira/.test(handoff.handoff.primary.label)), `no Jira hand-off for “${t}”`);
  }
  assert.deepEqual(JK.ticketFor(1, 'NT-1 thing', { links: null, projects: null }), null, 'no recognised projects → nothing');
});

test('jira: no configured https base → no Jira link is invented (the work step falls back honestly)', () => {
  const { handoff } = build({ jiraBase: null });
  assert.ok(!(handoff.handoff && /Jira/.test(handoff.handoff.primary.label)));
  assert.equal(NH.jiraTarget({ key: 'NT-1', url: null, basis: 'ledger' }, 'http://insecure.example'), null);
});

test('jira: a malformed key on a target is refused by the contract and degrades to no hand-off', () => {
  assert.match(C.targetsProblem([{ role: 'control', href: `${JIRA}/browse/x`, provider: 'jira', key: 'not a key' }], 't'), /ticket key/);
  const b = build();
  const lead = b.candidates.candidates.find((c) => c.id === 'block:123');
  lead.targets[0].key = '<script>';
  const out = H.resolveHandoff({ decision: b.decision, candidates: b.candidates, device: { contract: 'saim-device-v1', known: false, observedAt: null, apps: [] }, now: at(9, 40) });
  assert.equal(out.handoff, null);
  assert.match(out.reason, /malformed/);
});

test('jira: the adapter shows the destination in the card and the verb on the button, as a real link', () => {
  const vm = M.manifest(build().payload);
  assert.equal(vm.handoff.primary.name, 'NT-24162 in Jira');
  const h = html(vm);
  assert.match(h, new RegExp(`<a class="wk__open" href="${JIRA}/browse/NT-24162"[^>]*>Open NT-24162 in Jira</a>`));
});

// ── 2. Standup priority (S4r) ───────────────────────────────────────────────

test('standup: due now, do-first, 2 minutes → leads over the running block; the block stays protected and resumes after', () => {
  const { decision, handoff, payload } = build({ primary: STANDUP_NOW });
  assert.equal(decision.lead.rule, 'S4r short ritual due now');
  assert.equal(decision.lead.ref, 'item:att_standup');
  assert.equal(decision.protected.ref, 'block:123', 'the block is still what SAiM guards');
  assert.ok(!(Array.isArray(decision.held) && decision.held.some((h) => h.ref === 'block:123')), 'the block is not demoted to held');
  assert.equal(decision.recommended.say, 'Start the standup');
  assert.deepEqual(decision.recommended.intent, { kind: 'navigate', tab: 'review' });
  assert.equal(handoff.handoff, null);
  assert.match(handoff.reason, /block picks up straight after/);
  assert.ok(C.checkAttention(decision).ok);
  const vm = M.manifest(payload);
  assert.equal(vm.state, 'Due now · before anything else');
  assert.equal(vm.guard.verb, 'protected — resumes right after the standup');
  assert.match(vm.sentence, /About 2 minutes, and it comes before anything else\. NT-24162: Survey West Hants/);
  assert.deepEqual(M.visibleStrings(vm).filter((s) => !require('../../shared/display-text.cjs').isSafeDisplay(s)), []);
});

test('standup: the rule reads NEURO’s structured fields only — the reason line alone never triggers it', () => {
  for (const meta of [
    { type: 'standup', nagCount: 0 }, // after 11: no do-first, no estimate
    { type: 'standup', nagCount: 0, estimateMinutes: 15, doFirst: true }, // not short
    { type: 'standup', nagCount: 0, estimateMinutes: 2, doFirst: false },
  ]) {
    const { decision } = build({ primary: ritualCard(meta, '2 minutes — do it before anything else') });
    assert.equal(decision.lead.rule, 'S5 protected block', JSON.stringify(meta));
  }
  // Not due now: NEURO did not rate it critical for its clock.
  assert.equal(build({ primary: ritualCard({ type: 'standup', nagCount: 0, estimateMinutes: 2, doFirst: true }, 'x', 'medium') }).decision.lead.rule, 'S5 protected block');
});

test('standup: an imminent meeting with other people still outranks it (S3a before S4r)', () => {
  const { decision } = build({ primary: STANDUP_NOW, now: at(9, 52) });
  assert.equal(decision.lead.rule, 'S3a imminent meeting transition');
});

test('standup: a standup that is merely LATER (the 10:00 Team Standup, 20 min off) stays Next — never an interruption', () => {
  const { decision } = build({ now: at(9, 40) });
  assert.equal(decision.lead.rule, 'S5 protected block');
  assert.equal(decision.next.title, 'Team Standup');
  assert.equal(decision.next.inMinutes, 20);
});

// ── 3. Block clock parity ───────────────────────────────────────────────────

test('clock: a block not started offers exactly "Start focus" — NEURO’s session start for this task, for the minutes left', () => {
  const { decision } = build();
  assert.deepEqual(decision.recommended, { say: 'Start focus', intent: { kind: 'start-block', taskId: 345, text: TASK, blockId: 123, minutes: 15 } });
  assert.ok(!JSON.stringify(decision).includes('I’m on it'), '"I’m on it" is gone');
  assert.equal(decision.display.lead.clock, null, 'no clock before a session exists');
});

test('clock: a session on this block’s task → its own elapsed + the block’s remaining, and pause / done / something came up', () => {
  const { decision, payload } = build({ session: SESSION('active') });
  assert.deepEqual([decision.recommended, ...decision.alternatives].map((a) => a.say), ['Pause', 'That’s done', 'Something came up']);
  assert.deepEqual(decision.alternatives.concat([decision.recommended]).map((a) => a.intent.kind), ['session', 'session', 'session']);
  assert.deepEqual(decision.display.lead.clock, { state: 'running', elapsed: '12 min in', remaining: '15 min left in this block', started: 'started 09:28' });
  const vm = M.manifest(payload);
  const t = text(html(vm));
  assert.match(t, /12 min in · 15 min left in this block · started 09:28/);
  assert.ok(!/Start focus/.test(t), 'no second start once it is started');
});

test('clock: paused → Resume and That’s done; the clock says paused', () => {
  const { decision } = build({ session: SESSION('paused') });
  assert.deepEqual([decision.recommended, ...decision.alternatives].map((a) => a.say), ['Resume', 'That’s done']);
  assert.equal(decision.display.lead.clock.elapsed, '12 min in — paused');
});

test('clock: a session on ANOTHER task is not this block’s clock — still "Start focus", no clock', () => {
  const { decision, candidates } = build({ session: SESSION('active', { taskId: 999 }) });
  assert.equal(decision.recommended.say, 'Start focus');
  assert.equal(decision.display.lead.clock, null);
  assert.equal(candidates.candidates.find((c) => c.id === 'block:123').facts.otherSessionRunning, true);
});

test('clock: the press sends SAiM’s own intent; the shell posts it to /api/session/start with the minutes (source scan)', () => {
  const calls = [];
  const vm = M.manifest(build().payload);
  const els = clickables(View({ v: vm, live: LIVE({ onAct: (a) => calls.push(a) }) }));
  els.find((e) => label(e) === 'Start focus').props.onClick();
  assert.deepEqual(calls[0].intent, { kind: 'start-block', taskId: 345, text: TASK, blockId: 123, minutes: 15 });
  const app = fs.readFileSync(path.join(ROOT, 'saim', 'app', 'alt-v2', 'App.jsx'), 'utf8');
  assert.match(app, /apiFetch\('\/api\/session\/start'[\s\S]{0,400}source: 'task-block', \.\.\.\(Number\.isFinite\(intent\.minutes\) \? \{ minutes: intent\.minutes \}/);
  assert.ok(!/setInterval\([^)]*clock|new Date\(\)\.getTime\(\) - .*startedAt/.test(fs.readFileSync(path.join(ADAPTER_DIR, 'ManifestView.jsx'), 'utf8')), 'no client-side timer');
});

// ── 4. Meeting attendance ───────────────────────────────────────────────────

test('attendance: the next meeting carries NEURO’s "I’m not going" with the occurrence key its route takes', () => {
  const { candidates, decision } = build();
  const m = candidates.candidates.find((c) => c.kind === 'meeting');
  const key = MF.keyFor({ id: STANDUP_EVENT_ID, start: wall(10, 0), subject: 'Team Standup' });
  assert.deepEqual(m.actions, [{ say: 'I’m not going', intent: { kind: 'meeting', action: 'not-attending', key } }]);
  assert.deepEqual(decision.next.actions, m.actions);
});

test('attendance: a solo diary entry or a running meeting is never offered "I’m not going" from the diary', () => {
  const solo = { ...standupMeeting, eventId: 'solo', subject: 'Focus', attendeesOther: false };
  const running = { ...standupMeeting, eventId: 'run', subject: 'Live call', start: wall(9, 30), end: wall(10, 30), startAt: iso(9, 30), endAt: iso(10, 30) };
  const { candidates } = build({ calendar: [solo, running], block: false });
  for (const c of candidates.candidates) assert.ok(!(c.actions || []).some((a) => a.intent && a.intent.action === 'not-attending'), c.id);
});

test('attendance: imminent meeting (S3a) — "I’m not going" is offered, never the recommendation', () => {
  const { decision, payload } = build({ now: at(9, 52) });
  assert.equal(decision.lead.rule, 'S3a imminent meeting transition');
  assert.ok(!(decision.recommended && decision.recommended.say === 'I’m not going'));
  assert.ok([decision.recommended, ...decision.alternatives].filter(Boolean).some((a) => a.say === 'I’m not going'));
  const vm = M.manifest(payload);
  const btn = vm.actions.find((a) => a.say === 'I’m not going');
  assert.ok(!btn.lead, 'not styled as the lead');
});

test('attendance: the Next rail button calls the shell with NEURO’s attendance intent', () => {
  const calls = [];
  const vm = M.manifest(build().payload);
  assert.equal(vm.rail.next.actions[0].say, 'I’m not going');
  const els = clickables(View({ v: vm, live: LIVE({ onAct: (a) => calls.push(a) }) }));
  els.find((e) => label(e) === 'I’m not going').props.onClick();
  assert.equal(calls[0].intent.action, 'not-attending');
  assert.equal(calls[0].intent.key, MF.keyFor({ id: STANDUP_EVENT_ID, start: wall(10, 0), subject: 'Team Standup' }));
  const app = fs.readFileSync(path.join(ROOT, 'saim', 'app', 'alt-v2', 'App.jsx'), 'utf8');
  assert.match(app, /'not-attending': 'not-attending'/, 'the shell posts to NEURO’s existing attendance route');
});
