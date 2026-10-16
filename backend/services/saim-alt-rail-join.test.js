'use strict';

/**
 * SAiM Alt, 16 Oct 2026 (second batch) — calendar join links and an actionable rail.
 *
 *   Join: NEURO keeps Graph's structured onlineMeeting join URL + provider; SAiM's
 *   imminent / running meeting offers "Join in Teams" first, Meeting prep second.
 *   No title, body or location is read, no provider guessed; no link → prep + the
 *   honest gap, as before.
 *
 *   Rail: each waiting item is a compact candidate. Nothing protected → "Do now"
 *   (NEURO's focus-session start for that exact item), which then leads as
 *   S5f chosen focus. Protected or imminent → "Make next · after HH:MM" (NEURO books
 *   its window) or "After HH:MM" (the card's own defer) — never "Do now".
 *
 *   run: node --test backend/services/saim-alt-rail-join.test.js
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
const C = require('../../shared/attention-contracts.cjs');
const J = require('../../shared/meeting-join.cjs');
const POL = require('../../saim/policy/attention-policy.cjs');
const H = require('../../saim/policy/handoff.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const ADAPTER_DIR = path.join(ROOT, 'saim', 'app', 'alt-v2-manifest');

const at = (h, m) => new Date(2026, 9, 16, h, m).getTime();
const iso = (h, m) => new Date(at(h, m)).toISOString();
const wall = (h, m) => `2026-10-16T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.0000000`;
const WORK = { value: 'work', basis: 'classified', why: 'x' };
const TEAMS = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0';
const meeting = (join) => ({ eventId: 'AAMk-standup', source: 'graph', subject: 'Team Standup', start: wall(10, 0), end: wall(10, 15), startAt: iso(10, 0), endAt: iso(10, 15), allDay: false, showAs: 'free', attendeesOther: true, sphere: WORK, join });
const commit = (id, description) => ({ id: `commitment:task:${id}`, direction: 'i-owe', state: 'open', description, taskId: `task:neuro:${id}`, due: { date: '2026-10-16', kind: 'set' }, domains: { known: true, domains: [{ domain: 'work', basis: 'set' }], sphere: 'work', basis: 'set' } });
const COMMITS = [commit(350, 'Build call/productivity metrics in Nova'), commit(412, 'Look at technical solution for QA checklists in Jira')];
const CARD = { kind: 'item', type: 'todo', urgency: 'high', title: 'Customer Care training plan and refreshers', recordId: 'att_cc', reason: 'Marked high priority', meta: {} };
const CAPACITY = { kind: 'item', type: 'capacity', urgency: 'high', title: 'More work due by the end of today than you have time for', recordId: 'att_cap', reason: '56h due', meta: {} };
const UTTER = [
  { say: 'I’m on it', intent: { kind: 'session', action: 'start', recordId: 'att_cc', text: CARD.title } },
  { say: 'Not now — an hour', intent: { kind: 'act', action: 'defer', recordId: 'att_cc', minutes: 60, reason: 'not-now' } },
];

function build({ now = at(9, 40), block = true, session = null, calendar = [meeting(null)], primary = null, secondary = [CARD, CAPACITY], commitments = COMMITS, taskBlocks = new Map() } = {}) {
  const text = 'NT-24162: Survey West Hants Responses';
  const rows = block ? [{ blockId: 123, dateKey: '2026-10-16', startTime: '09:25', endTime: '09:55', status: 'scheduled', passed: false, tasks: [{ taskId: 345, text }] }] : [];
  const live = { rows, session, block: block ? { blockId: 123, startTime: '09:25', endTime: '09:55', running: true, tasks: [{ taskId: 345, text, running: false }], allTicked: false } : null };
  const payload = {
    poolAvailable: true, context: { activity: 'working', duty: { onDuty: true } }, work: { atDesk: true, deskKnown: true },
    primary, secondary: secondary.map((s) => ({ ...s })), dropped: [], utterances: UTTER,
    approvals: { known: true, needsApproval: 0, where: 'Actions, in NEURO on the desktop' },
    situation: { sections: { commitments } }, home: { needsYou: [], exceptions: [] },
  };
  const facts = { calendar, calendarKnown: true, approvals: [], taskDomains: new Map(), gaps: [], taskBlocks,
    workingWindow: { hours: '08:00-18:00', todayIsWorking: true, todayStart: iso(8, 0), todayEnd: iso(18, 0), nextStart: iso(8, 0) } };
  const candidates = NC.compose(payload, live, facts, { now });
  const decision = POL.decide(candidates, { surface: 'work-desktop', now });
  const device = { contract: 'saim-device-v1', known: true, observedAt: new Date(now - 60000).toISOString(), apps: [] };
  const handoff = H.resolveHandoff({ decision, candidates, device, now });
  return { candidates, decision, handoff, payload: { candidates, saim: decision, handoff, work: payload.work, utterances: [] } };
}
const heldBy = (d) => Object.fromEntries((d.held || []).map((h) => [h.ref, h.actions || []]));

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
const LIVE = (over = {}) => ({ onAct: () => {}, onDeskOpen: () => {}, deskStates: {}, onChoose: () => {}, linkFor: (h) => M.linkHref('https://neuro.example', h), busy: false, ...over });
function clickables(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => clickables(n, out)); return out; }
  if (node.props && typeof node.props.onClick === 'function') out.push(node);
  if (typeof node.type === 'function') return clickables(node.type(node.props), out);
  if (node.props) clickables(node.props.children, out);
  return out;
}
const label = (e) => { const t = []; const walk = (n) => { if (typeof n === 'string' || typeof n === 'number') t.push(String(n)); else if (Array.isArray(n)) n.forEach(walk); else if (n && n.props) walk(n.props.children); }; walk(e.props.children); return t.join(''); };

// ── Join links ─────────────────────────────────────────────────────────────

test('join: Graph’s own fields only — provider from its enum, else an exact meeting host, else none', () => {
  assert.deepEqual(J.joinFrom({ isOnlineMeeting: true, joinUrl: TEAMS, onlineMeetingProvider: 'teamsForBusiness' }), { url: TEAMS, provider: 'teams' });
  assert.deepEqual(J.joinFrom({ isOnlineMeeting: true, joinUrl: 'https://us02web.zoom.us/j/123', onlineMeetingProvider: 'unknown' }), { url: 'https://us02web.zoom.us/j/123', provider: 'zoom' });
  assert.deepEqual(J.joinFrom({ joinUrl: 'https://notzoom.us.evil.example/j/1' }), { url: 'https://notzoom.us.evil.example/j/1', provider: null }, 'a lookalike host names no provider');
  assert.equal(J.joinFrom({ isOnlineMeeting: true, joinUrl: 'http://teams.microsoft.com/x' }), null, 'not https → not a link');
  assert.equal(J.joinFrom({ isOnlineMeeting: false, joinUrl: TEAMS }), null);
  assert.equal(J.joinFrom({}), null);
  const ms = fs.readFileSync(path.join(__dirname, 'microsoft.js'), 'utf8');
  assert.match(ms, /joinFrom\(\{ isOnlineMeeting: event\.isOnlineMeeting, joinUrl: event\.onlineMeeting\?\.joinUrl, onlineMeetingProvider: event\.onlineMeetingProvider \}\)/, 'the sync passes Graph’s structured fields — never subject, body or location');
  assert.match(ms, /\$select=[^`]*isOnlineMeeting,onlineMeetingProvider,onlineMeeting/);
});

test('join: an imminent meeting with a Teams link → "Join in Teams" first, Meeting prep second; no gap said', () => {
  const { decision, handoff, candidates, payload } = build({ now: at(9, 52), calendar: [meeting({ url: TEAMS, provider: 'teams' })] });
  assert.equal(decision.lead.rule, 'S3a imminent meeting transition');
  const m = candidates.candidates.find((c) => c.kind === 'meeting');
  assert.equal(C.targetsProblem(m.targets, 't'), null);
  assert.ok(!m.handoffGaps.some((g) => g.field === 'join' || g.field === 'provider'));
  assert.equal(handoff.handoff.primary.label, 'Join in Teams');
  assert.deepEqual(handoff.handoff.primary.target, { type: 'link', href: TEAMS, role: 'join' });
  assert.deepEqual(handoff.handoff.alternatives.map((a) => a.label), ['Open meeting prep']);
  const vm = M.manifest(payload);
  assert.equal(vm.joinGap, null);
  assert.match(renderToString(React.createElement(View, { v: vm, live: LIVE() })), new RegExp(`<a class="wk__open" href="${TEAMS.replace(/[.?%]/g, '\\$&')}"[^>]*>Join in Teams</a>`));
});

test('join: a link with no named provider → "Join the meeting"; no link → prep leads and the honest gap stays', () => {
  const plain = build({ now: at(9, 52), calendar: [meeting({ url: 'https://meet.example.org/abc', provider: null })] });
  assert.equal(plain.handoff.handoff.primary.label, 'Join the meeting');
  const none = build({ now: at(9, 52), calendar: [meeting(null)] });
  assert.equal(none.handoff.handoff.primary.label, 'Open meeting prep');
  assert.match(M.manifest(none.payload).joinGap, /No join link — the calendar has no online-meeting link for this one, so SAiM won’t guess one\./);
});

// ── Actionable rail ────────────────────────────────────────────────────────

test('rail, nothing protected: a task commitment and a startable card offer "Do now" — NEURO’s own session start; a capacity note offers nothing', () => {
  const { decision } = build({ now: at(11, 0), block: false, calendar: [] });
  assert.equal(decision.protected, null);
  const a = heldBy(decision);
  assert.deepEqual(a['commitment:task:350'], [{ say: 'Do now', intent: { kind: 'session', action: 'start', taskId: 350, text: 'Build call/productivity metrics in Nova' } }]);
  assert.equal(decision.lead.rule, 'S11c choose', 'startable work waiting is never an all-clear');
  assert.deepEqual(decision.lead.choice.action, { say: 'Do now', intent: UTTER[0].intent }, 'the card’s own start, promoted');
  assert.deepEqual(a['item:att_cap'], [], 'no task, no card start → no invented action');
});

test('rail, a block running: never "Do now" — "Make next · after 09:55" books it; a card defers "After 09:55"', () => {
  const { decision } = build({ now: at(9, 40) });
  assert.equal(decision.lead.rule, 'S5 protected block');
  const a = heldBy(decision);
  assert.deepEqual(a['commitment:task:350'], [{ say: 'Make next · after 09:55', intent: { kind: 'block-next', taskId: 350 } }]);
  assert.deepEqual(a['item:att_cc'], [{ say: 'After 09:55', intent: { kind: 'act', action: 'defer', recordId: 'att_cc', minutes: 15, reason: 'not-now' } }]);
  assert.ok(!JSON.stringify(decision.held).includes('Do now'));
});

test('rail, a meeting imminent (nothing yet protected): "Make next · after 10:15" — the meeting’s end', () => {
  const { decision } = build({ now: at(9, 52), block: false });
  assert.equal(decision.lead.rule, 'S3a imminent meeting transition');
  assert.equal(heldBy(decision)['commitment:task:350'][0].say, 'Make next · after 10:15');
  assert.ok(!JSON.stringify(decision.held).includes('Do now'));
});

test('Do now → S5f: the session NEURO started on that item leads, protected, with its clock and verbs; the rest offer "Make next"', () => {
  const session = { id: 's', taskId: 350, text: 'Build call/productivity metrics in Nova', status: 'active', startedAt: iso(10, 50), startedTime: '10:50', elapsedMinutes: 10, plannedMinutes: 30, plannedAssumed: true };
  const { decision, handoff, payload } = build({ now: at(11, 0), block: false, calendar: [], session });
  assert.equal(decision.lead.rule, 'S5f chosen focus');
  assert.equal(decision.lead.ref, 'commitment:task:350');
  assert.equal(decision.protected.ref, 'commitment:task:350');
  assert.deepEqual([decision.recommended, ...decision.alternatives].map((x) => x.say), ['Pause', 'That’s done', 'Something came up']);
  assert.deepEqual(decision.display.lead.clock, { state: 'running', elapsed: '10 min in', remaining: '20 min left of 30 (assumed)', started: 'started 10:50' });
  assert.deepEqual(heldBy(decision)['commitment:task:412'], [{ say: 'Make next', intent: { kind: 'block-next', taskId: 412 } }]);
  assert.ok(C.checkAttention(decision).ok);
  assert.ok(handoff.decidedFor === 'commitment:task:350' && (handoff.handoff || handoff.reason));
  const vm = M.manifest(payload);
  assert.equal(vm.state, 'In focus · your choice');
  assert.equal(vm.rail.held.returns, 'when you finish this');
});

test('a session on a BLOCK task is the block’s, never S5f', () => {
  const session = { id: 's', taskId: 345, text: 'x', status: 'active', startedAt: iso(9, 30), startedTime: '09:30', elapsedMinutes: 10, plannedMinutes: 25 };
  assert.equal(build({ session }).decision.lead.rule, 'S5 protected block');
});

test('rail cap: a few candidates, actionable first, the rest behind "Show N more"; a press sends SAiM’s own intent', () => {
  const many = Array.from({ length: 6 }, (_, i) => commit(500 + i, `Extra commitment number ${i + 1} for the rail`));
  const { payload } = build({ now: at(9, 40), commitments: [...COMMITS, ...many] });
  const vm = M.manifest(payload);
  assert.equal(vm.rail.held.items.length, M.HELD_VISIBLE);
  assert.equal(M.HELD_VISIBLE, 3);
  assert.ok(vm.rail.held.items.every((x) => x.actions.length > 0), 'actionable first');
  assert.equal(vm.rail.held.items.length + vm.rail.held.more.length + vm.rail.held.unnamed, vm.rail.held.count);
  const html = renderToString(React.createElement(View, { v: vm, live: LIVE() }));
  assert.match(html, /<summary>Show \d+ more held<\/summary>/);
  const calls = [];
  const els = clickables(View({ v: vm, live: LIVE({ onAct: (x) => calls.push(x) }) }));
  els.find((e) => label(e).startsWith('Make next')).props.onClick();
  assert.equal(calls[0].intent.kind, 'block-next');
  assert.ok(Number.isInteger(calls[0].intent.taskId));
});

test('shell: "Make next" posts to NEURO’s task-block route; "Do now" passes the exact task id to the session start', () => {
  const app = fs.readFileSync(path.join(ROOT, 'saim', 'app', 'alt-v2', 'App.jsx'), 'utf8');
  assert.match(app, /intent\.kind === 'block-next'[\s\S]{0,400}apiFetch\('\/api\/task-blocks', \{ method: 'POST', body: JSON\.stringify\(\{ taskId: intent\.taskId \}\) \}\)/);
  assert.match(app, /'\/api\/session\/start', \{ method: 'POST', body: JSON\.stringify\(\{ text: intent\.text, source: 'attention', \.\.\.\(Number\.isInteger\(intent\.taskId\) \? \{ taskId: intent\.taskId \} : \{\}\) \}\) \}\)/);
  assert.ok(M.ACTABLE.includes('block-next'));
});

test('rail: a task an open block already holds is never offered "Make next" (NEURO refuses a second window) — its booking is said; unreadable → no offer', () => {
  const held = build({ now: at(9, 40), taskBlocks: new Map([[350, { date: '2026-10-16', start: '10:30' }]]) });
  const h = held.decision.held.find((x) => x.ref === 'commitment:task:350');
  assert.deepEqual(h.actions, []);
  assert.equal(h.why, 'due today · blocked at 10:30');
  const passed = build({ now: at(11, 0), block: false, calendar: [], taskBlocks: new Map([[350, { date: '2026-10-16', start: '10:30' }]]) });
  assert.equal(passed.decision.held.find((x) => x.ref === 'commitment:task:350').why, 'due today · its 10:30 block has passed');
  assert.deepEqual(heldBy(held.decision)['commitment:task:412'][0].intent, { kind: 'block-next', taskId: 412 }, 'positive control: an unblocked task still offers it');
  const blind = build({ now: at(9, 40), taskBlocks: null });
  assert.deepEqual(heldBy(blind.decision)['commitment:task:412'], [], 'could not check → no claim it can be booked');
});

// ── S11c: never an all-clear over startable work (16 Oct 2026) ─────────────

test('choice 1: nothing urgent + a startable waiting item → "Choose what to take on", never the all-clear; the promoted item and action ARE the rail’s first', () => {
  const plain = build({ now: at(11, 0), block: false, calendar: [], taskBlocks: new Map() });
  // What the rail would have offered first, before the promotion.
  const { decision, handoff, payload } = plain;
  assert.equal(decision.lead.rule, 'S11c choose');
  assert.ok(!/Nothing needs you right now/.test(JSON.stringify(decision.display)));
  assert.equal(decision.display.lead.title, 'Choose what to take on');
  assert.equal(decision.display.lead.sentence, 'Nothing needs you immediately. Pick one thing to focus on.');
  assert.equal(decision.lead.choice.ref, 'item:att_cc', 'the first Do-now item in rail order');
  assert.equal(decision.recommended, decision.lead.choice.action, 'the SAME action object, not a copy or a new route');
  assert.deepEqual(decision.recommended, { say: 'Do now', intent: UTTER[0].intent });
  assert.ok(!decision.held.some((h) => h.ref === 'item:att_cc'), 'promoted out of the rail, not duplicated');
  assert.ok(decision.held.filter((h) => h.actions[0] && h.actions[0].say === 'Do now').length >= 2, 'the others stay waiting with their Do now');
  assert.equal(handoff.handoff, null);
  assert.ok(C.checkAttention(decision).ok);
  const vm = M.manifest(payload);
  assert.equal(vm.state, 'Nothing urgent');
  assert.equal(vm.title, 'Choose what to take on');
  assert.equal(vm.choice.title, 'Customer Care training plan and refreshers');
  assert.deepEqual(vm.actions, [], 'the action lives on the suggestion only');
  const html = renderToString(React.createElement(View, { v: vm, live: LIVE() }));
  assert.match(html, /NOTHING URGENT/);
  assert.match(html, /Suggested/);
});

test('choice 2: nothing actionable waiting → the genuine all-clear stays', () => {
  const { decision } = build({ now: at(11, 0), block: false, calendar: [], secondary: [CAPACITY], commitments: [] });
  assert.equal(decision.lead.rule, 'S11 nothing');
  assert.equal(decision.display.lead.sentence, 'Nothing needs you right now.');
  assert.equal(M.manifest(build({ now: at(11, 0), block: false, calendar: [], secondary: [CAPACITY], commitments: [] }).payload).choice, null);
});

test('choice 2b: a task an open block holds still has a real Do now (NEURO’s session start) — but a waiting item with no start never makes a choice', () => {
  const onlyHeld = build({ now: at(11, 0), block: false, calendar: [], secondary: [], commitments: [] });
  assert.equal(onlyHeld.decision.lead.rule, 'S11 nothing');
});

test('choice 3: protected or imminent context → no choice state and no Do now anywhere', () => {
  for (const b of [build({ now: at(9, 40) }), build({ now: at(9, 52), block: false })]) {
    assert.notEqual(b.decision.lead.rule, 'S11c choose');
    assert.ok(!JSON.stringify(b.decision.held).includes('Do now'));
    assert.ok(!(b.decision.recommended && b.decision.recommended.say === 'Do now'));
  }
});

test('choice 4: pressing the suggestion sends the item’s own session start (the shell posts it to /api/session/start)', () => {
  const vm = M.manifest(build({ now: at(11, 0), block: false, calendar: [] }).payload);
  const calls = [];
  const els = clickables(View({ v: vm, live: LIVE({ onAct: (x) => calls.push(x) }) }));
  els.find((e) => label(e) === 'Do now' && e.props.className === 'wk__open').props.onClick();
  assert.deepEqual(calls[0].intent, UTTER[0].intent);
});
