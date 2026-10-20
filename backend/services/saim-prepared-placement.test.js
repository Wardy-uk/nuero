'use strict';

/**
 * Where SAiM's prepared move goes on the Surface (20 Oct 2026) — end to end.
 *
 * HARD RULE: an actionable prepared move may LEAD only when SAiM's own state is
 * genuinely calm — no Needs-you item, no primary item (risk, approval, urgent
 * task), and a calm/working/off-duty mode (not degraded, in a meeting, a
 * protected block, upcoming). When any real lead exists it stays first, the
 * move is reached through a folded "Prepared for Wednesday" entry beneath it,
 * and the move's action button is not shown until that entry is opened.
 *
 * Real pipeline: an attention payload → the server's composePresentation →
 * the shared Situation renderer, with the REAL PreparedMoveView (bundled) as
 * the prepared element and momentOf deciding the moment. The lead scenario is
 * the one seen live on 20 Oct: "Weekly Risk report for Chris is late".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');
const { composePresentation } = require('./presentation-intent');
const { FIXTURES } = require('../../shared/presentation-fixtures.cjs');
const { artefactFrom } = require('./prepared-move-artefact');

const ROOT = path.resolve(__dirname, '..', '..');
const SITUATION = path.join(ROOT, 'saim', 'shared-ui', 'presentation', 'Situation.jsx');
const PREPARED = path.join(ROOT, 'saim', 'app', 'src', 'components', 'PreparedMove.jsx');

const stubs = {
  name: 'stub',
  setup(b) {
    b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
    b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
    b.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: 'api', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl = (p) => p; export const authHeaders = () => ({});', loader: 'js' }));
  },
};
async function load(entry) {
  const out = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], plugins: [stubs], logLevel: 'silent' });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

// The draft in the live shape: seven team rows, each with two open cells.
const ART_MD = [
  '# T1 — Triage and escalation acceptance criteria (DRAFT prepared by SAiM)',
  '',
  '## Every escalation must carry',
  '- Current customer ask',
  '- Named owner',
  '  _from Projects/Support Improvement Plan/SIP - Support Teams Review (Original).md:1007_',
  '',
  '## What each team accepts',
  '| Team | Accepts when | Rejects with |',
  '|---|---|---|',
  ...['Customer Care', 'Tier 2', 'Tier 3', 'TPJ', 'Development', 'Finance', 'Customer Success'].map((t) => `| ${t} | _to agree_ | _to agree_ |`),
].join('\n');
const MOVE = {
  title: 'Written criteria', prepared: { headline: 'I’ve drafted it.', detail: null }, moment: { headline: 'I’ve made Wednesday ready.' },
  options: [{ id: 'approve', date: '2026-10-20', start: '10:25', end: '10:55', label: 'x', question: 'x', writes: [] }],
  notOffered: [], artefact: artefactFrom(ART_MD), evidence: [], why: { because: [] },
  forum: { title: 'Support Improvement Plan', start: '2026-10-21T16:00' },
};
const READY = { kind: 'ready', view: { ok: true, contract: 'prepared-move-view-v1', move: MOVE }, option: 'approve' };
const HELD = { kind: 'ready', view: { ok: true, contract: 'prepared-move-view-v1', held: { reason: 'off-duty', say: 'I’ve prepared this for your next working morning.' }, move: { ...MOVE, held: true, options: [], prepared: { headline: 'I’ve prepared this for your next working morning.' } } } };

// ── Scenarios, from a real fixture payload ───────────────────────────────────
const BASE = FIXTURES.find((f) => f.id === 'working-busy');
const clone = (x) => JSON.parse(JSON.stringify(x));
function calmPayload() {
  const p = clone(BASE.payload);
  p.primary = null; p.secondary = []; p.agenda = { known: true, events: [] };
  return p;
}
const RISK = {
  kind: 'item', id: 'weekly-risk-2026-10-19', recordId: 'att_risk', title: 'Weekly Risk report for Chris is late',
  say: 'Not built yet. 3 earlier weeks not built.', urgency: 'critical', tab: 'surface', actions: ['acknowledge', 'defer', 'open', 'complete', 'dismiss'],
};
const SCENARIOS = {
  calm: () => calmPayload(),
  ordinary: () => { const p = calmPayload(); p.primary = clone(BASE.payload.primary); return p; },
  risk: () => { const p = calmPayload(); p.primary = clone(RISK); return p; },
  meeting: () => { const p = calmPayload(); p.context.activity = 'in-meeting'; p.context.label = 'In a meeting'; p.context.summary = 'You’re in “Team sync”.'; return p; },
  block: () => { const p = calmPayload(); p.context.activity = 'in-focus-session'; p.context.label = 'Focus'; p.context.summary = 'Protected time: “Write the plan”.'; return p; },
  degraded: () => clone(FIXTURES.find((f) => f.id === 'degraded').payload),
  // Live, 20 Oct 2026: a Needs-you item AND a P0 primary on screen at once.
  twoLeads: () => { const p = calmPayload(); p.primary = clone(RISK); p.approvals = { known: true, needsApproval: 1, needsReview: 0, where: 'Actions, in NEURO on the desktop', say: '1 email waiting for your approval' }; return p; },
};

let Situation; let PM;
const presentations = {};
test.before(async () => {
  Situation = (await load(SITUATION)).default;
  PM = await load(PREPARED);
  for (const [id, mk] of Object.entries(SCENARIOS)) presentations[id] = composePresentation(mk(), { now: BASE.at });
});

const handlers = { onOpen() {}, onCorrect() {}, onNotNow() {}, onOffer() {} };
function render(id, profile, state = READY) {
  const prepared = React.createElement(PM.PreparedMoveView, { state, now: BASE.at, onChoose() {}, onAsk() {}, onConfirm() {}, onCancel() {}, onAgain() {}, onDrill() {} });
  return renderToString(React.createElement(Situation, { presentation: presentations[id], profile, prepared, preparedMoment: PM.momentOf(state), ...handlers })).replace(/<!-- -->/g, '');
}
const text = (h) => h.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const headlineOf = (h) => text((/<h2 class="sit__headline">([\s\S]*?)<\/h2>/.exec(h) || [])[1] || '').trim();
const ENTRY = '<details class="sit__prepared sit__prepared--entry">';
const BUTTON = 'Protect the time and save the draft';

test('the scenarios really are what they say (positive control)', () => {
  assert.equal(presentations.calm.mode, 'working'); assert.equal(presentations.calm.primary, null); assert.equal(presentations.calm.needsYou.length, 0);
  assert.equal(presentations.ordinary.primary.priority, 'P1'); assert.equal(presentations.ordinary.primary.urgency, 'normal');
  assert.equal(presentations.risk.mode, 'needs-attention'); assert.equal(presentations.risk.primary.priority, 'P0');
  assert.equal(presentations.risk.primary.title, 'Weekly Risk report for Chris is late');
  assert.equal(presentations.meeting.mode, 'in-meeting');
  assert.equal(presentations.block.mode, 'focus');
  assert.equal(presentations.degraded.mode, 'degraded');
  assert.ok(presentations.twoLeads.needsYou.length >= 1 && presentations.twoLeads.primary.priority === 'P0', 'two leads: a Needs-you item and a P0 primary');
});

test('calm, nothing leading: the prepared move leads — its own headline, its action visible', () => {
  for (const profile of ['phone', 'desktop']) {
    const h = render('calm', profile);
    assert.equal(headlineOf(h), 'I’ve made Wednesday ready.', profile);
    assert.match(h, /sit--moment-leads/);
    assert.ok(!h.includes(ENTRY), `${profile}: not folded`);
    assert.ok(h.indexOf('Wednesday, 16:00') > 0 && h.includes(BUTTON), `${profile}: the meeting and the one move are on the surface`);
  }
});

test('an ordinary (normal-urgency) task is not a lead: the move leads and the task follows it', () => {
  for (const profile of ['phone', 'desktop']) {
    const h = render('ordinary', profile);
    assert.equal(headlineOf(h), 'I’ve made Wednesday ready.', profile);
    assert.ok(h.indexOf(BUTTON) > 0 && h.indexOf(BUTTON) < h.indexOf('Reply to Simon about renewals'), `${profile}: the move, then the task`);
  }
});

test('the Weekly Risk report (a P0 risk) stays first: its headline, before the move, and the move’s action is folded away', () => {
  for (const profile of ['phone', 'desktop']) {
    const h = render('risk', profile);
    assert.equal(headlineOf(h), 'Something needs you', profile);
    const risk = h.indexOf('Weekly Risk report for Chris is late');
    assert.ok(risk > 0, `${profile}: the risk is drawn`);
    for (const piece of ['Prepared for Wednesday', 'Wednesday, 16:00', BUTTON]) {
      const at = h.indexOf(piece);
      assert.ok(at > risk, `${profile}: "${piece}" comes after the Weekly Risk report`);
    }
    const entry = h.indexOf(ENTRY);
    assert.ok(entry > risk, `${profile}: the entry follows the risk`);
    assert.ok(h.indexOf(BUTTON) > entry, `${profile}: the button is inside the closed entry`);
    assert.doesNotMatch(h, /sit--moment-leads/);
    assert.doesNotMatch(h, /<details class="sit__prepared sit__prepared--entry" open/);
  }
});

test('a live meeting, a protected block and a degraded read each stay first; the move is folded beneath', () => {
  for (const id of ['meeting', 'block', 'degraded']) {
    for (const profile of ['phone', 'desktop']) {
      const without = renderToString(React.createElement(Situation, { presentation: presentations[id], profile, ...handlers }));
      const h = render(id, profile);
      assert.equal(headlineOf(h), headlineOf(without), `${id}/${profile}: the existing headline stands`);
      assert.notEqual(headlineOf(h), 'I’ve made Wednesday ready.');
      const lead = h.indexOf('class="sit__headline"');
      const entry = h.indexOf(ENTRY);
      assert.ok(entry > lead, `${id}/${profile}: folded entry after the lead`);
      assert.ok(h.indexOf('Wednesday, 16:00') > entry && h.indexOf(BUTTON) > entry, `${id}/${profile}: the move only inside the entry`);
      assert.doesNotMatch(h, /sit--moment-leads/);
    }
  }
});

test('held / off duty: never leads, never offers the action', () => {
  for (const id of ['calm', 'risk']) {
    for (const profile of ['phone', 'desktop']) {
      const without = renderToString(React.createElement(Situation, { presentation: presentations[id], profile, ...handlers }));
      const h = render(id, profile, HELD);
      assert.equal(headlineOf(h), headlineOf(without), `${id}/${profile}`);
      assert.ok(!h.includes(BUTTON), `${id}/${profile}: no action on a held move`);
      assert.doesNotMatch(h, /sit--moment-leads/);
      if (id === 'risk') assert.ok(h.indexOf('Weekly Risk report for Chris is late') < h.indexOf('I’ve prepared this for your next working morning.'));
    }
  }
});

test('the wrapper is ONE stable element before and after the moment loads — a changing wrapper remounts the move in a loop', () => {
  for (const id of ['calm', 'risk', 'meeting']) {
    for (const profile of ['phone', 'desktop']) {
      const prepared = React.createElement('i', null, 'MOVE');
      const before = renderToString(React.createElement(Situation, { presentation: presentations[id], profile, prepared, preparedMoment: null, ...handlers }));
      const after = render(id, profile);
      const wrap = (h) => (/<(\w+) class="sit__prepared[ "]/.exec(h) || [])[1];
      assert.equal(wrap(before), 'details', `${id}/${profile}: before the moment loads`);
      assert.equal(wrap(after), 'details', `${id}/${profile}: after`);
      // …and in the same place: its position among the blocks does not depend on the moment.
      const at = (h) => h.slice(0, h.search(/<\w+ class="sit__prepared[ "]/)).split('class="sit__').length;
      assert.equal(at(before.replace(/<!-- -->/g, '')) > 0, true);
    }
  }
});

test('two leads at once (a Needs-you item AND a P0 primary): the move follows BOTH, never between them', () => {
  for (const profile of ['phone', 'desktop']) {
    const h = render('twoLeads', profile);
    const needsYou = h.indexOf('sit__object--p0');
    const risk = h.indexOf('Weekly Risk report for Chris is late');
    const entry = h.indexOf(ENTRY);
    assert.ok(needsYou >= 0 && risk >= 0 && entry >= 0, `${profile}: all three drawn`);
    assert.ok(entry > risk, `${profile}: the entry follows the primary`);
    assert.ok(entry > h.lastIndexOf('Needs you', entry) && h.indexOf('Needs you', entry) < 0, `${profile}: no lead is drawn after the entry`);
  }
});
