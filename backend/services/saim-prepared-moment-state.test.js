'use strict';

/**
 * The Surface's semantic state around a prepared move (20 Oct 2026).
 *
 * An ACTIONABLE prepared move must never sit under "Quiet <day>" or "Nothing
 * needs you". Three states, pinned on the REAL Situation component rendered
 * over the canonical presentation fixtures:
 *   - held (off duty): the quiet state is kept; the move says it is held;
 *   - actionable, nothing needing him: the move's own state leads, from the
 *     packet ("I’ve made Wednesday ready.") — the quiet heading is gone;
 *   - actionable, a genuine Needs-you item: that keeps the headline and comes
 *     first; the prepared moment follows it.
 * Plus: the wiring (PreparedMove → Surface → AttentionSurface → Situation) and
 * the headline composed from the forum date, never hard-coded.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');
const { composePresentation } = require('./presentation-intent');
const { FIXTURES } = require('../../shared/presentation-fixtures.cjs');
const { momentFor } = require('./prepared-move-artefact');

const ROOT = path.resolve(__dirname, '..', '..');
const SHARED = path.join(ROOT, 'saim', 'shared-ui');
const APP = path.join(ROOT, 'saim', 'app', 'src');

function stubs() {
  return {
    name: 'stubs',
    setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      b.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: 'api', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl = (p) => p; export const authHeaders = () => ({});', loader: 'js' }));
    },
  };
}
async function load(entry) {
  const out = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], plugins: [stubs()], logLevel: 'silent' });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let Situation; let PM;
const composed = {};
test.before(async () => {
  Situation = (await load(path.join(SHARED, 'presentation', 'Situation.jsx'))).default;
  PM = await load(path.join(APP, 'components', 'PreparedMove.jsx'));
  for (const f of FIXTURES) composed[f.id] = composePresentation(f.payload, { now: f.at });
});

const text = (h) => h.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const PREPARED = React.createElement('div', { className: 'pmo-marker' }, 'PREPARED-MOMENT');
const render = (id, profile, preparedMoment) => renderToString(React.createElement(Situation, {
  presentation: composed[id], profile, prepared: PREPARED, preparedMoment, onOpen() {}, onCorrect() {}, onNotNow() {}, onOffer() {},
}));
const headlineOf = (h) => text((/<h2 class="sit__headline">([\s\S]*?)<\/h2>/.exec(h) || [])[1] || '').trim();
const ACTIONABLE = { kind: 'actionable', headline: momentFor({ start: '2026-10-21T16:00' }).headline };

test('the state headline comes from the packet’s forum date — never hard-coded', () => {
  assert.equal(momentFor({ start: '2026-10-21T16:00' }).headline, 'I’ve made Wednesday ready.');
  assert.equal(momentFor({ start: '2026-10-23T09:30' }).headline, 'I’ve made Friday ready.');
  assert.equal(momentFor(null), null, 'no forum → no invented state');
  assert.equal(momentFor({ start: 'whenever' }), null);
  const src = fs.readFileSync(path.join(SHARED, 'presentation', 'Situation.jsx'), 'utf8') + fs.readFileSync(path.join(APP, 'components', 'PreparedMove.jsx'), 'utf8');
  assert.doesNotMatch(src, /made \w+day ready|Triage|Support Improvement/i, 'the client composes no state sentence and holds no move words');
});

test('held (off duty): the quiet state is kept, exactly as without a move', () => {
  for (const profile of ['phone', 'desktop']) {
    const without = render('empty', profile, null);
    const held = render('empty', profile, { kind: 'held' });
    assert.equal(headlineOf(held), headlineOf(without), profile);
    assert.match(text(held), /PREPARED-MOMENT/);
    assert.match(held, /sit--with-moment/); assert.doesNotMatch(held, /sit--moment-leads/);
  }
});

test('actionable, nothing needing him: the move’s own state leads — never a quiet / nothing-needs-you heading', () => {
  const QUIET = /\bQuiet\b|Nothing needs you|Nothing to do|All clear/i;
  for (const id of ['empty', 'calm-saturday', 'live-sunday', 'many-next', 'working-busy']) {
    for (const profile of ['phone', 'desktop']) {
      const quietBefore = text(render(id, profile, null));
      const h = render(id, profile, ACTIONABLE);
      assert.equal(headlineOf(h), 'I’ve made Wednesday ready.', `${id}/${profile}`);
      // Whatever quiet wording the plain situation used is gone from the heading block.
      const head = text((/<header class="sit__situation[\s\S]*?<\/header>/.exec(h) || [''])[0]);
      assert.doesNotMatch(head, QUIET, `${id}/${profile}: ${head}`);
      assert.ok(text(h).indexOf('I’ve made Wednesday ready.') < text(h).indexOf('PREPARED-MOMENT'), 'the state, then the moment');
      assert.match(h, /sit--moment-leads/);
      void quietBefore;
    }
  }
  // Positive control: the fixture really is a quiet one without the move.
  assert.match(text(render('empty', 'phone', null)), /\bQuiet\b|Nothing needs you|nothing/i);
});

test('actionable with a genuine Needs-you item: that keeps the headline and comes first; the moment follows', () => {
  for (const profile of ['phone', 'desktop']) {
    const without = render('approval', profile, null);
    const h = render('approval', profile, ACTIONABLE);
    assert.equal(headlineOf(h), headlineOf(without), `${profile}: Needs-you keeps the headline`);
    assert.notEqual(headlineOf(h), 'I’ve made Wednesday ready.');
    const t = text(h);
    const needsYouAt = h.indexOf('Needs you') >= 0 ? h.indexOf('Needs you') : h.search(/sit__(needs|object)/);
    assert.ok(needsYouAt >= 0, 'the Needs-you block is drawn');
    assert.ok(needsYouAt < h.indexOf('PREPARED-MOMENT'), `${profile}: Needs you before the prepared moment`);
    assert.doesNotMatch(h, /sit--moment-leads/);
    void t;
  }
});

test('a degraded read keeps saying it cannot see, even with a move prepared', () => {
  const h = render('degraded', 'phone', ACTIONABLE);
  assert.equal(headlineOf(h), headlineOf(render('degraded', 'phone', null)));
});

test('momentOf reads the move’s state: actionable / held / nothing — and the Surface wires it through', () => {
  const view = (move, extra = {}) => ({ kind: 'ready', view: { move, ...extra } });
  assert.deepEqual(PM.momentOf(view({ moment: { headline: 'I’ve made Friday ready.' }, prepared: { headline: 'x' }, forum: { title: 'x', start: '2026-10-23T09:30' } })), { kind: 'actionable', headline: 'I’ve made Friday ready.', entry: 'Prepared for Friday' });
  assert.deepEqual(PM.momentOf(view({ prepared: { headline: 'I’ve drafted it.' } })), { kind: 'actionable', headline: 'I’ve drafted it.', entry: 'Prepared work' });
  assert.deepEqual(PM.momentOf(view({ held: true, prepared: { headline: 'x' } }, { held: { say: 'x' } })), { kind: 'held', entry: 'Prepared for your next working morning' });
  for (const k of ['loading', 'pending', 'hidden']) assert.equal(PM.momentOf({ kind: k }), null, k);
  const surface = fs.readFileSync(path.join(APP, 'views', 'Surface.jsx'), 'utf8');
  assert.match(surface, /prepared=\{<PreparedMove onMoment=\{setPreparedMoment\} onOpenAuthority=\{\(\) => onNavigate\?\.\('authority'\)\} \/>\}/);
  assert.match(surface, /preparedMoment=\{preparedMoment\}/);
  const as = fs.readFileSync(path.join(SHARED, 'AttentionSurface.jsx'), 'utf8');
  assert.match(as, /preparedMoment=\{preparedMoment\}/, 'AttentionSurface hands it to Situation');
});
