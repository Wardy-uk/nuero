'use strict';

/**
 * The one next step on SAiM's home (21 Oct 2026). Nick's live screen read
 * "In a meeting" with nothing to do, while the payload carried SAiM's own
 * hand-off ("Join in Teams", then "Open meeting prep"). These pin that the
 * hand-off becomes ONE visible control, only where the shell can complete it,
 * and that calm stays quiet — through the pure selector AND the real shared
 * surface.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');
const k = require('./keep-my-word');
const { composePresentation } = require('./presentation-intent');
const { FIXTURES } = require('../../shared/presentation-fixtures.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const NOW = Date.parse('2026-10-21T11:00:00Z');

// The LIVE in-meeting hand-off shape (pi5, 21 Oct 2026 12:15), URL shortened.
const JOIN = { name: 'Teams', label: 'Join in Teams', target: { type: 'link', href: 'https://teams.microsoft.com/l/meetup-join/x', role: 'join' } };
const PREP = { name: 'Meeting prep', label: 'Open meeting prep', target: { type: 'link', href: 'neuro:?item=meeting-prep%3AAAMkTEST', role: 'prep' } };
const handoffFor = (rule, primary, alternatives = []) => ({ contract: 'saim-handoff-v1', rule, handoff: { primary, alternatives, why: 'x' }, reason: null });
const IN_MEETING = handoffFor('S3 meeting', JOIN, [PREP]);
const PRE_MEETING = handoffFor('S3a imminent meeting transition', JOIN, [PREP]);
const PHONE = { external: true, tab: (id) => id === 'prep' || id === 'capture', desk: false, neuro: false };
const KIOSK = { ...PHONE, external: false, tab: (id) => id === 'prep' }; // the wall never offers capture

let S;
test.before(async () => { S = await import(pathToFileURL(path.join(ROOT, 'saim/shared-ui/presentation/nextStep.mjs')).href); });

// ── The selector ─────────────────────────────────────────────────────────────

test('active meeting: SAiM’s hand-off order — Join in Teams first, meeting prep second', () => {
  const s = S.nextStep({ handoff: IN_MEETING, presentation: { mode: 'in-meeting' }, context: { activity: 'in-meeting' }, can: PHONE });
  assert.equal(s.primary.label, 'Join in Teams');
  assert.deepEqual(s.primary.run, { type: 'external', href: JOIN.target.href });
  // Prep carries THIS meeting's event id (from NEURO's own link); capture follows, with the canonical meeting.
  assert.deepEqual(s.alternatives.map((a) => [a.label, a.run]), [
    ['Open meeting prep', { type: 'tab', tab: 'prep', context: { eventId: 'AAMkTEST' } }],
    ['Capture from this meeting', { type: 'tab', tab: 'capture', context: { meeting: null } }],
  ]);
  const named = S.nextStep({ handoff: IN_MEETING, presentation: { mode: 'in-meeting' }, context: { activity: 'in-meeting' }, meeting: { key: 'k', subject: ' Sprint ', scheduledEnd: 'x' }, can: PHONE });
  assert.deepEqual(named.alternatives[1].run.context, { meeting: { key: 'k', subject: 'Sprint', scheduledEnd: 'x' } });
});

test('active meeting on a wall (no external links): meeting prep, never a Teams link it cannot open', () => {
  const s = S.nextStep({ handoff: IN_MEETING, presentation: { mode: 'in-meeting' }, context: { activity: 'in-meeting' }, can: KIOSK });
  assert.equal(s.primary.label, 'Open meeting prep');
  assert.equal(s.alternatives.length, 0);
});

test('active meeting with no usable hand-off: a focused capture, through the existing Capture view', () => {
  const s = S.nextStep({ handoff: null, presentation: { mode: 'in-meeting' }, context: { activity: 'in-meeting' }, can: PHONE });
  assert.deepEqual(s.primary, { label: 'Capture from this meeting', run: { type: 'tab', tab: 'capture', context: { meeting: null } } });
  // A hand-off for a DIFFERENT rule is not a meeting destination.
  const other = S.nextStep({ handoff: handoffFor('S7 top item', JOIN), presentation: { mode: 'in-meeting' }, context: { activity: 'in-meeting' }, can: PHONE });
  assert.equal(other.primary.label, 'Capture from this meeting');
});

test('a shell that can complete nothing shows NOTHING — never a control that cannot finish', () => {
  const none = { external: false, tab: () => false, desk: false, neuro: false };
  assert.equal(S.nextStep({ handoff: IN_MEETING, presentation: { mode: 'in-meeting' }, context: { activity: 'in-meeting' }, can: none }), null);
  // A neuro: link that is not prep needs a NEURO opener this shell lacks.
  assert.equal(S.actionFor({ label: 'Open it in NEURO', target: { type: 'link', href: 'neuro:?item=task%3A5', role: 'canonical' } }, PHONE), null);
  // 'already' and 'elsewhere' are facts, not actions.
  assert.equal(S.actionFor({ label: 'Already open', target: { type: 'already', app: 'teams' } }, { ...PHONE, desk: true }), null);
  // A desk destination only when the laptop is reachable.
  assert.deepEqual(S.actionFor({ label: 'Open Teams', target: { type: 'desk', app: 'teams', mode: 'open' } }, { ...PHONE, desk: true }).run, { type: 'desk', app: 'teams' });
  assert.equal(S.actionFor({ label: 'Open Teams', target: { type: 'desk', app: 'teams', mode: 'open' } }, PHONE), null);
});

test('upcoming meeting: the existing join, then prep; without a hand-off, SAiM’s own Prep view', () => {
  const s = S.nextStep({ handoff: PRE_MEETING, presentation: { mode: 'upcoming' }, context: { activity: 'pre-meeting' }, can: PHONE });
  assert.equal(s.primary.label, 'Join in Teams');
  assert.equal(s.alternatives[0].label, 'Open meeting prep');
  const bare = S.nextStep({ handoff: null, presentation: { mode: 'upcoming' }, context: { activity: 'pre-meeting' }, can: PHONE });
  assert.deepEqual(bare.primary, { label: 'Open meeting prep', run: { type: 'tab', tab: 'prep', context: null } });
});

test('calm: quiet — no step invented, whatever hand-off rides along', () => {
  for (const activity of ['steady', 'off', 'in-focus-session', null]) {
    assert.equal(S.nextStep({ handoff: handoffFor('S7 top item', JOIN), presentation: { mode: 'calm' }, context: { activity }, can: PHONE }), null, String(activity));
  }
});

// ── The promise states: the thread carries its own one control ───────────────

const SCORE = { ratio: { kept: 7, of: 9 }, counts: { reDated: 0, pending: 0 }, entries: [], mondayReport: null };
const IT = {
  key: 'promise:31', taskIds: [31], leadTaskId: 31, title: 'Send Kit the checklist', owedTo: 'Kit Varga',
  due: { date: '2026-10-22', basis: 'set', endsAt: '2026-10-22T23:00:00.000Z', tier: 'soon', say: 'due within two days' },
  booked: [], preparation: { state: 'needs-a-draft', why: 'A message to one person.' }, because: [], evidence: [{ kind: 'due', fact: 'Due Thursday.' }],
};
const BENCH = { state: 'ok', items: [IT], withheld: {} };
const CALM = { mode: 'calm', needsYou: [], primary: null };

// ── The real shared surface ──────────────────────────────────────────────────

function stubPlugin() {
  return { name: 'stub', setup(b) {
    b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
    b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
    b.onResolve({ filter: /(^|\/)Field(\.jsx)?$/ }, () => ({ path: 'field', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default function Field() { return null; }\nexport const isPressing = () => false;\n', loader: 'js' }));
  } };
}
let Surface;
test.before(async () => {
  global.window = global.window || { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), location: { search: '' } };
  const out = await esbuild.build({ entryPoints: [path.join(ROOT, 'saim/shared-ui/AttentionSurface.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom'], plugins: [stubPlugin()], logLevel: 'silent' });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  Surface = mod.exports.default;
});

function meetingData(activity, handoff, kmwOver = {}) {
  const f = FIXTURES.find((x) => x.id === 'many-next');
  const payload = { ...f.payload, context: { ...f.payload.context, activity, quiet: activity === 'in-meeting' } };
  const p = composePresentation(payload, { now: f.at });
  p.keepMyWord = k.compose({ score: SCORE, workbench: BENCH, delivery: { sending: true, items: { 'promise:31': { addressable: true, live: null } } }, presentation: p, now: NOW, ...kmwOver });
  return { ...payload, presentation: p, handoff, poolAvailable: true };
}
const render = (data, extra = {}) => renderToString(React.createElement(Surface, { data, layout: 'situation', profile: 'desktop', onNavigate: () => {}, onStartTask: async () => ({ ok: true }), ...extra })).split('<!-- -->').join('');
const buttons = (html) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

test('render: in a meeting the step sits in the headline block, BEFORE the folded promise; the Ask bar is meeting-aware', () => {
  const data = meetingData('in-meeting', IN_MEETING);
  assert.equal(data.presentation.mode, 'in-meeting');
  const html = render(data);
  const stepAt = html.indexOf('class="sit__step"');
  assert.ok(stepAt > 0, 'the step renders');
  assert.ok(stepAt < html.indexOf('</header>'), 'inside the situation header — the main scene, not behind Show me everything');
  assert.ok(html.indexOf('kmw__fold') > stepAt, 'the promise folds beneath it');
  assert.ok(buttons(html).includes('Join in Teams'));
  assert.ok(buttons(html).includes('Open meeting prep'));
  assert.equal(data.presentation.voicePrompt.label, 'Note a decision from this meeting, or ask SAiM');
});

test('render: the kiosk gets prep, not a Teams link it cannot open', () => {
  const html = render(meetingData('in-meeting', IN_MEETING), { profile: 'kiosk' });
  assert.ok(!buttons(html).includes('Join in Teams'));
});

test('render: eligible promise on a calm screen — ONE control, Start this task (31 Oct 2026); no meeting step, no send/approve', () => {
  const data = meetingData('steady', null);
  assert.equal(data.presentation.keepMyWord.leads, true);
  const html = render(data);
  assert.ok(!html.includes('class="sit__step"'), 'calm: no invented step');
  const b = buttons(html);
  assert.ok(b.includes('Start this task'));
  assert.ok(!b.includes('Draft the delivery note'), 'the delivery note lives on the Task workflow screen');
  assert.ok(!b.includes('Open the task'), 'one control per state');
  assert.ok(!b.some((x) => /approve|send|confirm/i.test(x)), JSON.stringify(b));
});

test('render: held promise names what is missing and offers no delivery control (Start only)', () => {
  const data = meetingData('steady', null, { delivery: { sending: true, items: { 'promise:31': { addressable: false, live: null } } } });
  assert.equal(data.presentation.keepMyWord.state, 'held');
  const html = render(data);
  assert.match(html, /no single email address for Kit Varga/);
  const b = buttons(html);
  assert.ok(!b.includes('Draft the delivery note') && !b.includes('Open the task'), JSON.stringify(b));
  assert.ok(b.every((x) => x === 'Start this task' || !/draft|approve|send/i.test(x)), JSON.stringify(b));
  assert.ok(!html.includes('class="sit__step"'));
});

test('render: calm with nothing at risk stays quiet — no step, and the ask label is the plain one', () => {
  const f = FIXTURES.find((x) => x.id === 'empty');
  const p = composePresentation(f.payload, { now: f.at });
  p.keepMyWord = k.compose({ score: null, workbench: { state: 'ok', items: [], why: 'Nothing you owe is at risk.' }, presentation: p, now: NOW });
  const html = render({ ...f.payload, presentation: p, handoff: handoffFor('S11 nothing', null), poolAvailable: true });
  assert.ok(!html.includes('class="sit__step"'));
  assert.equal(p.voicePrompt.label, 'Ask SAiM');
});
