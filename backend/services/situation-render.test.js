'use strict';

/**
 * Build 12S/T — the adaptive composition, rendered for real, across every
 * canonical fixture and every surface profile.
 *
 * Not pixels: SEMANTIC properties of the rendered tree. Same meaning on every
 * surface (the headline is identical), different composition (the blocks are
 * not), and the rules each surface must never break — P0 visible, no
 * duplicate event, no diagnostics or controls on the kiosk, no oversized
 * activity chooser, no false all-clear.
 *
 * Bundles the real `saim/shared-ui/presentation/Situation.jsx` with esbuild the
 * way the other render tests here do; a vite build proves JSX compiles, not
 * that a block renders.
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

const ROOT = path.resolve(__dirname, '..', '..');
const SITUATION = path.join(ROOT, 'saim', 'shared-ui', 'presentation', 'Situation.jsx');
const BUDGET = path.join(ROOT, 'saim', 'shared-ui', 'presentation', 'budget.mjs');

function cssStub() {
  return {
    name: 'css-stub',
    setup(build) {
      build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
    },
  };
}

async function load(entry) {
  const out = await esbuild.build({
    entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node',
    jsx: 'automatic', external: ['react', 'react-dom'], plugins: [cssStub()], logLevel: 'silent',
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let Situation; let budget;
const PROFILES = ['phone', 'kiosk', 'desktop', 'watch'];
const composed = {};

test.before(async () => {
  Situation = (await load(SITUATION)).default;
  budget = await load(BUDGET);
  assert.equal(typeof Situation, 'function', 'Situation has a default export');
  for (const f of FIXTURES) composed[f.id] = composePresentation(f.payload, { now: f.at });
});

const handlers = { onOpen() {}, onCorrect() {}, onNotNow() {}, onOffer() {} };
function render(id, profile, extra = {}) {
  return renderToString(React.createElement(Situation, { presentation: composed[id], profile, ...handlers, ...extra }));
}
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const count = (hay, needle) => hay.split(needle).length - 1;

test('positive control: every fixture renders on every profile, and the headline is the SAME everywhere', () => {
  for (const f of FIXTURES) {
    const headline = composed[f.id].situation.headline;
    for (const p of PROFILES) {
      const html = render(f.id, p);
      assert.match(html, new RegExp(`data-profile="${p}"`), `${f.id}/${p}`);
      assert.ok(text(html).includes(headline), `${f.id}/${p} carries "${headline}"`);
    }
  }
});

test('same meaning, different composition: the block plan differs between phone, kiosk and desktop', () => {
  let differing = 0;
  for (const f of FIXTURES) {
    const plans = ['phone', 'kiosk', 'desktop'].map((p) => budget.composeForSurface(composed[f.id], p).blocks.map((b) => `${b.type}:${b.variant || ''}:${(b.items || []).length}:${b.correction ? 'c' : ''}`).join('|'));
    if (new Set(plans).size === 3) differing += 1;
    assert.notEqual(plans[0], plans[1], `${f.id}: phone and kiosk must not be the same dashboard resized`);
  }
  assert.ok(differing >= FIXTURES.length - 3, `most fixtures compose three different ways (${differing})`);
});

test('the budget only ever CUTS, never re-orders', () => {
  const base = composed['working-busy'];
  const reversed = { ...base, next: [...base.next].reverse(), context: [...base.context].reverse() };
  for (const p of ['phone', 'desktop']) {
    const a = budget.composeForSurface(reversed, p);
    const nextBlock = a.blocks.find((b) => b.type === 'next');
    const ctxBlock = a.blocks.find((b) => b.type === 'context');
    assert.deepEqual(nextBlock.items.map((i) => i.id), reversed.next.filter((n) => n.id !== base.situation.about).slice(0, nextBlock.items.length).map((i) => i.id));
    assert.deepEqual(ctxBlock.items.map((i) => i.id), reversed.context.slice(0, ctxBlock.items.length).map((i) => i.id));
  }
  const src = fs.readFileSync(BUDGET, 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /\.sort\(/, 'budget.mjs never sorts');
});

test('kiosk: no buttons, no details, no diagnostics, no tracked list — on any fixture', () => {
  for (const f of FIXTURES) {
    const html = render(f.id, 'kiosk');
    assert.doesNotMatch(html, /<button/, `${f.id}: kiosk has no controls`);
    assert.doesNotMatch(html, /<details/, `${f.id}: kiosk has no drill-down`);
    for (const d of composed[f.id].details) assert.ok(!text(html).includes(d.label), `${f.id}: kiosk shows no "${d.label}"`);
    const plan = budget.composeForSurface(composed[f.id], 'kiosk');
    for (const t of budget.FORBIDDEN.kiosk) assert.ok(!plan.blocks.some((b) => b.type === t), `${f.id}: kiosk never draws ${t}`);
    assert.ok((plan.blocks.find((b) => b.type === 'next')?.items.length || 0) <= 1, `${f.id}: at most one next on the wall`);
  }
});

test('positive control: the same diagnostics DO render on the desktop', () => {
  const html = render('live-sunday', 'desktop');
  assert.ok(text(html).includes('MacBook Air · Claude'));
  assert.match(html, /<details[^>]*open/);
});

test('P0 is visible on every surface that can show anything', () => {
  for (const p of ['phone', 'desktop']) {
    const html = render('approval', p);
    assert.match(html, /sit__object--p0/, `${p}: the approval is an object`);
    assert.ok(text(html).includes('The weekly report is ready for your approval.'));
  }
  const wall = text(render('approval', 'kiosk'));
  assert.ok(wall.includes('Something needs you'));
  assert.ok(wall.includes('The weekly report is ready for your approval.'));
  assert.ok(wall.includes('Review in Actions, in NEURO on the desktop.'), 'the wall says where to go');
  const watch = text(render('approval', 'watch'));
  assert.ok(watch.includes('Something needs you'));
});

test('the approval is said once on the phone: card shown, summary sentence dropped', () => {
  const t = text(render('approval', 'phone'));
  assert.equal(count(t, 'The weekly report is ready for your approval.'), 1);
});

test('no duplicate event: the live double birthday renders once on every profile', () => {
  for (const p of PROFILES) {
    const t = text(render('live-sunday', p));
    assert.ok(count(t, 'Tracey Allen') <= 1, `${p}: ${count(t, 'Tracey Allen')}`);
  }
  assert.equal(count(text(render('live-sunday', 'phone')), 'Tracey Allen’s 16th Birthday'), 1);
});

test('the meeting-in-20 is not listed under the situation that already says it', () => {
  for (const p of ['phone', 'kiosk', 'desktop']) {
    const t = text(render('meeting-soon', p));
    assert.equal(count(t, 'Tech Leadership'), 1, `${p}`);
  }
});

test('no oversized activity chooser: the correction is ONE quiet control until asked', () => {
  const html = render('live-sunday', 'phone');
  // Build 12.1G: one pill, not a dotted hyperlink.
  assert.equal(count(html, 'class="sit__pill"'), 1);
  assert.doesNotMatch(html, /sit__correct-btn/);
  assert.ok(!text(html).includes('My own project'), 'options stay folded until he taps');
  assert.doesNotMatch(html, /surface__lifeask|LifeAsk/);
  const inferred = text(render('calm-saturday', 'phone'));
  assert.ok(inferred.includes('Looks like you’re watching TV'));
  assert.ok(inferred.includes('Not quite?'));
});

test('calm has negative space: few blocks, no objects, level none', () => {
  for (const id of ['calm-saturday', 'empty']) {
    const html = render(id, 'phone');
    assert.match(html, /sit--level-none/);
    // No card that claims his attention (P0 / current). Build 12.1 allows ONE
    // focal object for the next thing — never more.
    assert.doesNotMatch(html, /sit__object--/);
    assert.ok(count(html, 'class="sit__focal"') <= 1, `${id}: at most one focal object`);
    assert.ok(budget.composeForSurface(composed[id], 'kiosk').blocks.filter((b) => b.type !== 'ask').length <= 3, `${id}: wall stays sparse`);
  }
});

test('degraded never reads as an all-clear on any surface', () => {
  for (const p of PROFILES) {
    const t = text(render('degraded', p));
    assert.ok(!/Nothing needs you|All quiet|all clear\b|You’re clear/i.test(t.replace(/isn’t an all-clear/g, '')), p);
    assert.ok(t.includes('isn’t an all-clear'), p);
  }
});

test('ordinary context is an annotation, not a card; a promoted reading has weight', () => {
  const calm = render('calm-saturday', 'phone');
  assert.match(calm, /class="sit__ctx"/, 'near surfaces group the context (12.1F)');
  assert.match(render('calm-saturday', 'kiosk'), /class="sit__context"/, 'the wall keeps its one line');
  assert.doesNotMatch(calm, /sit__object[^"]*"[^>]*>[^<]*Living Room/);
  const bed = render('bedtime', 'phone');
  assert.match(bed, /sit__ob--promoted/);
  assert.ok(text(bed).includes('Bedroom is 31°'));
});

test('the watch shows one thing only', () => {
  for (const f of FIXTURES) {
    const plan = budget.composeForSurface(composed[f.id], 'watch');
    for (const t of budget.FORBIDDEN.watch) assert.ok(!plan.blocks.some((b) => b.type === t), `${f.id}: watch never draws ${t}`);
  }
});

test('profileFor reads the DECLARED platform; only viewport class is measured', () => {
  assert.equal(budget.profileFor({ platform: 'kiosk', width: 400 }), 'kiosk');
  assert.equal(budget.profileFor({ platform: 'electron', width: 400 }), 'desktop');
  assert.equal(budget.profileFor({ platform: 'phone-app', width: 390 }), 'phone');
  assert.equal(budget.profileFor({ platform: 'phone-app', width: 1280 }), 'desktop');
  assert.equal(budget.profileFor({ platform: 'phone-app', width: 820 }), 'phone', 'an iPad in portrait is a big phone');
});

test('reduced motion is honoured and nothing pulses on a loop', () => {
  const css = fs.readFileSync(path.join(ROOT, 'saim', 'shared-ui', 'presentation', 'Situation.css'), 'utf8');
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css, /animation:[^;]*infinite/);
  assert.match(css, /"needs you", always with the words/, 'colour is never the only signal');
  // ...and the renderer really does pair it: the P0 object carries the words.
  assert.match(fs.readFileSync(SITUATION, 'utf8'), /sit__object-tag">Needs you/);
});

test('the shell foot (laptop launch, escape hatch) never reaches the wall; it does reach the phone', () => {
  const foot = React.createElement('button', { className: 'foot-probe' }, 'VS Code');
  assert.doesNotMatch(render('live-sunday', 'kiosk', { foot }), /foot-probe/);
  assert.match(render('live-sunday', 'phone', { foot }), /foot-probe/);
});
