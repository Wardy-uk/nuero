'use strict';

/**
 * SAiM quality pass (25 Oct 2026) — four live desktop presentation issues from
 * the Brief 004 smoke check, fixed on the SERVER and rendered verbatim:
 *
 *  1. Freshness: "every source answered" sat beside three phone sources marked
 *     Stale. `presentation.situation.honesty.freshness` now tells apart a read
 *     failure (unread), a source that stopped or can't be judged (blind), stale
 *     data (stale) and fully current data (current).
 *  2. The moment: "nothing urgent is live" sat beside "3 of them urgent" held.
 *     context-state runs before the gate, so it now states only what it checked.
 *  3. One held-work count: SAiM's lead said 5 (the gate's holds) beside
 *     workHeld's 7 (gate + held diary/commitments/reminders). The lead and the
 *     details now use the canonical workHeld; a different population is labelled.
 *  4. Labels: held items showed raw types (ticket_commitment, capacity, todo).
 *
 * Fixtures run through the REAL pipeline (context-state → gate → presentation →
 * candidates → SAiM policy) and a REAL render (esbuild + renderToString).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-saimqp-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'frontend', 'src');

const CS = require('./context-state');
const AT = require('./attention');
const PI = require('./presentation-intent');
const NC = require('./neuro-candidates');
const POL = require('../../saim/policy/attention-policy.cjs');
const { itemTypeLabel, TYPE_LABELS } = require('../../shared/item-labels.cjs');

const NOW = Date.parse('2026-10-24T10:00:00Z'); // Sat 11:00 BST — the smoke-check day

// ── fixtures ────────────────────────────────────────────────────────────────

const POOL = [
  { type: 'ticket_commitment', id: 'tc-1', score: 90, urgency: 'high', tier: 1 },
  { type: 'capacity', id: 'capacity-over-2026-10-24', title: 'More work due than time', reason: '4h short.', score: 80, urgency: 'high', tier: 1 },
  { type: 'capacity', id: 'capacity-start-2026-10-24', title: 'Cannot finish', reason: '2h short.', score: 78, urgency: 'high', tier: 1 },
  { type: 'todo', id: 'todo-overdue-top', score: 60, urgency: 'medium', tier: 2 },
  { type: 'todo', id: 'todo-overdue-summary', score: 55, urgency: 'medium', tier: 2 },
];
const STALE_SOURCES = [
  { sourceId: 'eventkit.saim-ios', label: 'Phone calendar push (SAiM app)', verdict: 'stale', verdictLabel: 'Stale' },
  { sourceId: 'reminders.neuro-ios', label: 'Phone reminders push (NEURO app)', verdict: 'stale', verdictLabel: 'Stale' },
  { sourceId: 'reminders.saim-ios', label: 'Phone reminders push (SAiM app)', verdict: 'stale', verdictLabel: 'Stale' },
];

const weekend = () => CS.resolveContext({
  calendar: { known: true, events: [] }, focusSession: { known: true, session: null }, queue: { known: true, breaching: 0, escalations: 0 },
  location: { known: true, place: 'home' }, presence: { known: true, state: 'present' }, rituals: { known: true },
  workingDay: { known: true, isWorkingDay: false, reason: 'weekend' },
}, new Date(NOW));
const offLife = { doing: 'relaxing', label: 'Relaxing', showWork: false, confidence: 'likely', place: { kind: 'home', label: 'living room' } };

/** The smoke-check shape: 5 gate holds (3 urgent) + 2 more held by composeNow = workHeld 7. */
function smokeFixture({ sources = STALE_SOURCES, gaps = [], extraHeld = 2, pool = POOL, dropExtra = [] } = {}) {
  const context = weekend();
  const g = AT.gate(AT.gateContextFor(context, offLife), pool, new Date(NOW));
  const dropped = [...g.dropped, ...dropExtra];
  const { heldWork } = require('../../shared/held-work.cjs');
  const hw = heldWork(dropped, { extra: extraHeld, onDuty: false });
  const situation = { workHeld: { count: hw.count, urgent: hw.urgent, say: hw.say }, sections: { blindness: sources.length ? sources : null } };
  const p = { context, life: offLife, poolAvailable: true, gaps, approvals: { known: true, needsApproval: 0, needsReview: 0 },
    primary: g.primary, secondary: g.secondary, dropped, quiet: g.quiet, generatedAt: new Date(NOW - 5000).toISOString(), situation };
  p.presentation = PI.composePresentation(p, { now: NOW });
  const facts = { calendar: [], calendarKnown: true, approvals: [], taskDomains: new Map(), workingWindow: { hours: '08:00-18:00', todayIsWorking: false, todayStart: null, todayEnd: null, nextStart: null } };
  p.candidates = NC.compose({ ...p, work: { atDesk: true, deskKnown: true }, utterances: [] }, { rows: [], block: null, session: null }, facts, { now: NOW });
  p.saim = POL.decide(p.candidates, { surface: 'work-desktop', now: NOW });
  return p;
}

// ── 1. freshness ────────────────────────────────────────────────────────────

test('1a. stale-but-answered: no read failed, but the state is STALE and every stale source is named', () => {
  const p = smokeFixture();
  const h = p.presentation.situation.honesty;
  assert.equal(h.complete, true, 'no read failed — `complete` keeps its meaning');
  assert.equal(h.say, null, '`say` stays null: Situation renders it as a warning on every surface');
  assert.equal(h.freshness.state, 'stale');
  assert.deepEqual(h.freshness.stale, STALE_SOURCES.map((s) => s.label));
  assert.match(h.freshness.say, /^Every read answered, but some data is out of date: Phone calendar push \(SAiM app\), Phone reminders push \(NEURO app\), Phone reminders push \(SAiM app\)\.$/);
});

test('1b. the four states never collapse: current / stale / blind (stopped or unknown) / unread', () => {
  const f = PI.freshnessOf;
  assert.equal(f({}).state, 'current');
  assert.match(f({}).say, /up to date/);
  assert.equal(f({ sources: [{ label: 'A', verdict: 'stale' }] }).state, 'stale');
  const stopped = f({ sources: [{ label: 'Calendar', verdict: 'failing' }] });
  assert.equal(stopped.state, 'blind');
  assert.match(stopped.say, /stopped answering: Calendar/);
  const unknown = f({ sources: [{ label: 'Watch', verdict: 'unknown' }] });
  assert.equal(unknown.state, 'blind');
  assert.match(unknown.say, /can’t tell whether this source is working: Watch/);
  const unread = f({ partial: true, cannotSee: ['radar'], sources: [{ label: 'A', verdict: 'stale' }] });
  assert.equal(unread.state, 'unread');
  assert.match(unread.say, /^Couldn’t read: radar\. Out of date: A\.$/);
  const poolBlind = f({ blind: true });
  assert.equal(poolBlind.state, 'unread');
  assert.match(poolBlind.say, /not an all-clear/);
  // The worst fact wins the state; every fact is still said.
  const all = f({ sources: [{ label: 'C', verdict: 'failing' }, { label: 'S', verdict: 'stale' }] });
  assert.equal(all.state, 'blind');
  assert.match(all.say, /stopped answering: C\. Out of date: S\./);
});

test('1c. NEGATIVE: no "up to date" / "every source" claim is made while anything is stale, blind or unread', () => {
  for (const args of [{ sources: [{ label: 'A', verdict: 'stale' }] }, { sources: [{ label: 'A', verdict: 'failing' }] },
    { sources: [{ label: 'A', verdict: 'unknown' }] }, { partial: true, cannotSee: ['x'] }, { blind: true }]) {
    const s = PI.freshnessOf(args).say;
    assert.doesNotMatch(s, /up to date|every source/i, JSON.stringify(args));
  }
});

// ── 2. the moment ───────────────────────────────────────────────────────────

test('2a. urgent-held: the off-day reason states only what it checked — never "nothing urgent"', () => {
  const p = smokeFixture();
  const reasons = p.context.reasons.join(' ');
  assert.match(reasons, /Today is not a working day \(weekend\)\. Nothing is breaching and no escalation is waiting, so work waits for the next working day\./);
  assert.doesNotMatch(reasons, /nothing urgent/i);
  // …while urgent work IS held — the two now read together without contradiction.
  assert.equal(p.situation.workHeld.urgent, 3);
});

// ── 3. one held-work count ──────────────────────────────────────────────────

test('3a. mixed held populations: SAiM’s lead says the CANONICAL count (7), not the gate’s subset (5)', () => {
  const p = smokeFixture();
  assert.equal(p.dropped.filter((d) => d.heldFor === 'off').length, 5, 'fixture: the gate held 5');
  assert.equal(p.situation.workHeld.count, 7, 'fixture: workHeld counts 7');
  assert.equal(p.candidates.constraints.workHeld.count, 7, 'the canonical count is handed to SAiM');
  assert.equal(p.saim.lead.rule, 'S11 nothing');
  assert.match(p.saim.lead.why, /^Nothing needs you right now — 7 work items held back while you're off duty, 3 of them urgent\.$/);
  assert.equal(p.saim.policyVersion, '2026-10-25.1');
});

test('3b. the details list says ONE held count; only a population workHeld does not cover gets its own labelled line', () => {
  const p = smokeFixture();
  const labels = p.presentation.details.filter((d) => d.kind === 'held').map((d) => d.label);
  assert.deepEqual(labels, ["7 work items held back while you're off duty, 3 of them urgent."]);
  assert.ok(!labels.some((l) => /^5 held back/.test(l)), 'the gate subset is not repeated as a second number');
  // A meeting hold is NOT inside workHeld: it keeps its own line, with its own reason.
  const q = smokeFixture({ dropExtra: [{ id: 'm1', type: 'meeting', why: 'in a meeting', urgency: 'medium', heldFor: 'meeting' }] });
  const ql = q.presentation.details.filter((d) => d.kind === 'held').map((d) => d.label);
  assert.ok(ql.includes('1 held back — in a meeting'), JSON.stringify(ql));
});

test('3c. with no canonical count (a payload that skipped composeNow) the gate count is still said, as before', () => {
  const lead = POL.decide({ ...smokeFixture().candidates, constraints: { ...smokeFixture().candidates.constraints, workHeld: null } }, { surface: 'work-desktop', now: NOW }).lead;
  assert.match(lead.why, /^Nothing needs you right now — 5 work items held back while you're off duty, 3 of them urgent\.$/);
});

test('3d. the surface silence line uses the canonical count too (and the gate count without one)', () => {
  const SS = require('./saim-surface');
  const p = smokeFixture();
  const s = SS.silenceFor({ ...p, quiet: false, primary: null });
  assert.match(s.lead, /^7 work items held back/);
  const t = SS.silenceFor({ ...p, situation: null, quiet: false, primary: null });
  assert.match(t.lead, /^5 work items held back/, 'no canonical count: the gate’s own, as before');
});

// ── 4. labels ───────────────────────────────────────────────────────────────

test('4a. every known pool type has a human label; no label is a raw id', () => {
  for (const [type, label] of Object.entries(TYPE_LABELS)) {
    assert.equal(itemTypeLabel(type), label);
    assert.doesNotMatch(label, /[_]|^[a-z]/, `${type} → ${label}`);
  }
  assert.equal(itemTypeLabel('todo', 'todo-overdue-top'), 'An overdue task');
  assert.equal(itemTypeLabel('todo', 'todo-overdue-summary'), 'Overdue tasks');
  assert.equal(itemTypeLabel('todo', 'x'), 'A task');
  assert.equal(itemTypeLabel('ticket_commitment'), 'Promised ticket update');
  assert.equal(itemTypeLabel('capacity'), 'Capacity warning');
  // An unmapped type is humanised, never shown raw.
  assert.equal(itemTypeLabel('brand_new-kind'), 'Brand new kind');
  assert.equal(itemTypeLabel(null), 'An item from NEURO');
});

test('4b. SAiM’s held list carries the labels, not the raw types', () => {
  const p = smokeFixture();
  const titles = p.saim.held.map((h) => h.title);
  for (const raw of ['ticket_commitment', 'capacity', 'todo']) assert.ok(!titles.includes(raw), `raw "${raw}" in ${JSON.stringify(titles)}`);
  assert.ok(titles.includes('Promised ticket update'), JSON.stringify(titles));
  assert.ok(titles.includes('An overdue task'), JSON.stringify(titles));
});

// ── 5. the real render ──────────────────────────────────────────────────────

const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');
let SaimWhy;
test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [path.join(SRC, 'components', 'SaimWorkspace.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom', 'idb'], logLevel: 'silent',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      b.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: "export const apiUrl=(p)=>p;export const authHeaders=()=>({});export const apiFetch=async()=>({ok:true,json:async()=>({})});export const setPin=()=>{};export const getPin=()=>null;export default {};", loader: 'js' }));
    } }],
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require); // eslint-disable-line no-new-func
  SaimWhy = mod.exports.SaimWhy;
  global.window = global.window || { location: { search: '' }, addEventListener() {}, removeEventListener() {} };
});
const FALSE_CLEAR = /nothing pressing|all clear|every source neuro read for this answered|nothing urgent is live/i;
const why = (p) => renderToString(React.createElement(SaimWhy, { data: p, now: NOW }));

test('5a. the smoke-check screen, rendered: stale named, one count, labels, no contradiction', () => {
  const html = why(smokeFixture());
  assert.match(html, /data-freshness="stale">Every read answered, but some data is out of date: Phone calendar push \(SAiM app\)/);
  assert.match(html, /class="saim-why__warn" data-freshness="stale"/, 'stale is styled as a warning');
  // One number for held work on the whole strip.
  const counts = [...html.matchAll(/(\d+) work items? held back/g)].map((m) => m[1]);
  assert.ok(counts.length >= 2, 'lead and held row both carry it');
  assert.deepEqual([...new Set(counts)], ['7'], `held counts on screen: ${counts}`);
  assert.match(html, /data-why="held-list">In SAiM’s list:/, 'the list is labelled as its own population');
  assert.match(html, /Promised ticket update/);
  assert.doesNotMatch(html, />(ticket_commitment|capacity|todo)(<!-- -->)? —/);
  assert.match(html, /Nothing is breaching and no escalation is waiting/);
  assert.doesNotMatch(html, FALSE_CLEAR);
});

test('5b. current, blind and unread each render their own words, never an all-clear unless current', () => {
  const cur = why(smokeFixture({ sources: [] }));
  assert.match(cur, /data-freshness="current">Every read answered, and the sources behind it are up to date\./);
  const blind = why(smokeFixture({ sources: [{ label: 'Phone calendar push (SAiM app)', verdict: 'failing' }] }));
  assert.match(blind, /data-freshness="blind">Every read answered, but this source has stopped answering/);
  const unread = why(smokeFixture({ gaps: [{ input: 'radar', why: 'down' }] }));
  assert.match(unread, /data-freshness="unread">Couldn’t read: radar\./);
  for (const h of [blind, unread]) assert.doesNotMatch(h, /up to date/);
});

test('5c. an older read with no freshness says only that no read failed', () => {
  const p = smokeFixture();
  delete p.presentation.situation.honesty.freshness;
  const html = why(p);
  assert.match(html, /No read failed\. Whether the sources are up to date isn’t in this read\./);
  assert.doesNotMatch(html, /Every source NEURO read for this answered/);
});

// ── 6. source boundaries ────────────────────────────────────────────────────

test('6. the client ranks nothing, maps no kinds, and gains no write path', () => {
  const src = fs.readFileSync(path.join(SRC, 'components', 'SaimWorkspace.jsx'), 'utf8');
  const codeOnly = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\{\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(codeOnly, /\.sort\(/, 'no client-side ranker');
  assert.doesNotMatch(codeOnly, /ticket_commitment|'capacity'|Capacity warning|Promised ticket update/, 'no client-side kind→label map');
  assert.doesNotMatch(codeOnly, /method:\s*['"](POST|PUT|PATCH|DELETE)/i, 'no write call');
  assert.match(codeOnly, /honesty\.freshness\.say/, 'positive control: the strip renders the server sentence');
});
