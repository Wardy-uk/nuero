'use strict';

/**
 * SAiM Alt v3 is a complete prepared-move surface (20 Oct 2026).
 *
 * Alt reuses the SHARED PreparedMove component (its own read, request, confirm
 * and receipt over the existing APIs). Alt adds only a pure placement rule
 * (alt-v2-manifest/prepared.mjs) and a slot in ManifestView. Pinned here:
 *   - placement: blind/refused → no move; actionable + calm lead → the move
 *     leads with its own headline (never under "Nothing needs you"); any other
 *     lead stays first; held never leads;
 *   - the slot renders ONCE (no remount mid-confirmation) and CSS order places it;
 *   - Alt's held variant: the sentence and the draft FOLDED, nothing to press;
 *   - the confirmation shows the exact writes and the allowance it would use;
 *   - Alt holds no prepared-move, authority or confirmation logic of its own.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const APP = path.resolve(__dirname, '..', '..', 'saim', 'app');
const ADAPTER = path.join(APP, 'alt-v2-manifest');
const GOLDEN = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '__golden__', 'alt-manifest', `${n}.json`), 'utf8'));
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
  b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
  b.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: 'api', namespace: 'stubapi' }));
  b.onLoad({ filter: /.*/, namespace: 'stubapi' }, () => ({ contents: 'export const apiUrl = (p) => p; export const authHeaders = () => ({});', loader: 'js' }));
} };
async function load(entry) {
  const out = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], plugins: [stub], logLevel: 'silent' });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let P; let View; let PM;
test.before(async () => {
  P = await import(pathToFileURL(path.join(ADAPTER, 'prepared.mjs')).href);
  View = (await load(path.join(ADAPTER, 'ManifestView.jsx'))).default;
  PM = await load(path.join(APP, 'src', 'components', 'PreparedMove.jsx'));
});

const ACTIONABLE = { kind: 'actionable', headline: 'I’ve made Wednesday ready.' };
const text = (h) => h.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('placement: blind shows no move; calm + actionable leads with the move’s own headline; a real lead stays first; held never leads', () => {
  const blind = GOLDEN('s01-blind');
  assert.equal(P.preparedPlacement(blind, ACTIONABLE).show, false, 'a blind read invents no move');
  assert.equal(P.preparedPlacement({ ...blind, tone: 'calm', refused: { why: 'x' } }, ACTIONABLE).show, false, 'a refused read invents no move');

  const meeting = GOLDEN('s03-meeting');
  const m = P.preparedPlacement(meeting, ACTIONABLE);
  assert.deepEqual([m.show, m.leads], [true, false], 'a meeting stays first');
  assert.equal(m.vm, meeting, 'and is not restated');
  for (const rule of ['S2 critical risk', 'S5 protected block', 'S6 judgement waiting', 'S7 top item']) {
    assert.equal(P.preparedPlacement({ ...meeting, rule }, ACTIONABLE).leads, false, `${rule} stays first`);
  }

  for (const rule of P.CALM_RULES) {
    const calm = { ...GOLDEN('s05-protected-block'), rule, tone: 'calm', state: rule === 'S11 nothing' ? 'Nothing needs you' : 'Nothing urgent', title: 'Nothing needs you' };
    const c = P.preparedPlacement(calm, ACTIONABLE);
    assert.deepEqual([c.show, c.leads], [true, true], rule);
    assert.equal(c.vm.state, 'Prepared'); assert.equal(c.vm.title, 'I’ve made Wednesday ready.'); assert.equal(c.vm.sentence, null); assert.equal(c.vm.handoffNote, null, 'no “nowhere to go” under a move that is somewhere to go');
    assert.doesNotMatch(JSON.stringify([c.vm.state, c.vm.title]), /Nothing needs you|Nothing urgent/, 'never under a quiet heading');
    const held = P.preparedPlacement(calm, { kind: 'held' });
    assert.deepEqual([held.show, held.leads], [true, false], 'held: the quiet state stands');
    assert.equal(held.vm.title, 'Nothing needs you');
  }
});

test('the slot renders ONCE, straight after the lead when it leads, otherwise after the lead’s own content (CSS order)', () => {
  const vm = GOLDEN('s05-protected-block');
  const MARK = React.createElement('div', { className: 'pm-mark' }, 'PREPARED');
  const live = (over) => ({ onAct() {}, onDeskOpen() {}, deskStates: {}, onChoose() {}, linkFor: () => null, busy: false, ...over });
  const lead = renderToString(React.createElement(View, { v: vm, live: live({ prepared: MARK, preparedLeads: true }) }));
  assert.match(lead, /class="wk__main mf__main--prep"/);
  assert.match(lead, /class="mf__prepared mf__prepared--lead"><div class="pm-mark">PREPARED<\/div><\/div>/);
  assert.equal((lead.match(/pm-mark/g) || []).length, 1, 'rendered once');
  assert.ok(lead.indexOf('wk__block') < lead.indexOf('mf__prepared'), 'directly after the lead block in the DOM');
  const after = renderToString(React.createElement(View, { v: vm, live: live({ prepared: MARK, preparedLeads: false }) }));
  assert.match(after, /class="mf__prepared"><div class="pm-mark">/);
  const none = renderToString(React.createElement(View, { v: vm, live: live({}) }));
  assert.doesNotMatch(none, /mf__main--prep|mf__prepared/);
  const css = fs.readFileSync(path.join(ADAPTER, 'manifest.css'), 'utf8');
  assert.match(css, /\.mf__main--prep > \.mf__prepared \{ order: 1; \}/);
  assert.match(css, /\.mf__main--prep > \.mf__prepared--lead \{ order: 0; \}/);
  assert.match(css, /\.mf__main--prep > \.wk__dockwrap \{ order: 2; \}/);
});

test('LiveSaim mounts the SHARED component with Alt’s held variant and learns the moment from it — no logic of its own', () => {
  const src = fs.readFileSync(path.join(ADAPTER, 'LiveSaim.jsx'), 'utf8');
  assert.match(src, /import PreparedMove from '\.\.\/src\/components\/PreparedMove';/);
  assert.match(src, /<PreparedMove onMoment=\{setMoment\} heldFolded \/>/);
  assert.match(src, /preparedPlacement\(manifest\(canonical\), moment\)/);
  const alt = ['LiveSaim.jsx', 'ManifestView.jsx', 'prepared.mjs', 'manifest.mjs'].map((f) => fs.readFileSync(path.join(ADAPTER, f), 'utf8')).join('\n')
    + fs.readFileSync(path.join(APP, 'alt-v2', 'App.jsx'), 'utf8');
  assert.doesNotMatch(alt, /\/api\/prepared-moves|\/api\/saim-authority|grantId|writeHash|intent-grants|feature-flags/, 'Alt holds no prepared-move, authority or confirmation logic of its own');
});

const MOVE = {
  title: 'x', prepared: { headline: 'I’ve drafted it.', detail: null }, whyItMatters: 'Because.', unresolved: [], options: [],
  artefact: { title: 'Triage and escalation acceptance criteria', sections: [{ heading: 'Every escalation must carry', cited: 1, items: [{ text: 'Current customer ask' }] }], decisions: null, openQuestions: [], cited: 1, openCount: 7, openLabel: '7 team decisions to agree' },
  draft: { markdown: '# T1' }, evidence: [], why: { because: [] },
};

test('held, Alt variant: the sentence and the draft FOLDED — nothing open, nothing to press', () => {
  const SAY = 'I’ve prepared this for your next working morning.';
  const state = { kind: 'ready', view: { held: { reason: 'off-duty', say: SAY }, move: { ...MOVE, held: true } } };
  const h = renderToString(React.createElement(PM.PreparedMoveView, { state, heldFolded: true }));
  const primary = text(h.replace(/<details[\s\S]*<\/details>/g, '')).trim();
  assert.equal(primary, SAY, 'outside the fold: the sentence only');
  assert.match(h, /<details class="pmo__heldfold"><summary>See what I prepared<\/summary>/);
  assert.ok(!/<details[^>]*open/.test(h)); assert.ok(!/<button/.test(h), 'nothing to press');
  assert.match(text(h), /Triage and escalation acceptance criteria/, 'the draft is there, folded');
  // The phone build is unchanged: the page shows unfolded without the prop.
  assert.match(text(renderToString(React.createElement(PM.PreparedMoveView, { state })).replace(/<details[\s\S]*?<\/details>/g, '')), /Triage and escalation acceptance criteria/);
});

test('confirmation shows the exact two writes and the allowance it would use — the server’s own words', () => {
  const request = {
    grantId: 'ig_x', expiresAt: new Date(Date.now() + 60000).toISOString(), executionEnabled: true,
    authority: { canAct: true, stopped: false, deviceOpen: true, granted: true, fits: true, summary: 'SAiM can carry out one prepared move today, after you confirm it.' },
    confirmation: { question: 'Reserve 30 minutes on Tuesday 20 Oct (10:25–10:55) and save the draft?', writes: ['Add “X” to your calendar, Tuesday 20 Oct 10:25–10:55. Just you — nobody is invited.', 'Save the draft as a new note: Projects/P/N.md'], contacts: 'Nobody else is contacted.' },
  };
  const t = text(renderToString(React.createElement(PM.PreparedMoveView, { state: { kind: 'confirming', view: { move: { ...MOVE, options: [{ id: 'approve', date: '2026-10-20', start: '10:25', end: '10:55' }] } }, request } })));
  assert.match(t, /Add “X” to your calendar, Tuesday 20 Oct 10:25–10:55\. Just you — nobody is invited\./);
  assert.match(t, /Save the draft as a new note: Projects\/P\/N\.md/);
  assert.match(t, /SAiM can carry out one prepared move today, after you confirm it\./);
  // When it would NOT fit, the limit is said instead.
  const t2 = text(renderToString(React.createElement(PM.PreparedMoveView, { state: { kind: 'confirming', view: { move: MOVE }, request: { ...request, authority: { ...request.authority, fits: false, say: 'This block is 30 minutes; today’s allowance has 20 minutes left.' } } } })));
  assert.match(t2, /This block is 30 minutes; today’s allowance has 20 minutes left\./);
  assert.doesNotMatch(t2, /SAiM can carry out one prepared move today/);
});
