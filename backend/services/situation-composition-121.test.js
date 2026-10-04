'use strict';

/**
 * Build 12.1 — visual composition refinement, pinned as SEMANTIC properties of
 * the real rendered tree (and, where the property is a styling one, of the real
 * stylesheet). Pixels are judged on a screen; these stop the composition rules
 * quietly regressing:
 *   one focal object when there is a next thing, none when there is not;
 *   P0 outranks it; context is grouped, not a telemetry line; the activity read
 *   and the unknown pill differ; diagnostics attach to the read; one dock with
 *   one text and one voice affordance; no dead space; a reading scrim; and the
 *   server's order survives all of it.
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
const DIR = path.join(ROOT, 'saim', 'shared-ui', 'presentation');
const CSS = fs.readFileSync(path.join(DIR, 'Situation.css'), 'utf8');

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

let Situation; let AskDock; let budget; let inSentence;
const composed = {};
test.before(async () => {
  const sit = await load(path.join(DIR, 'Situation.jsx'));
  Situation = sit.default; inSentence = sit.inSentence;
  AskDock = (await load(path.join(DIR, 'AskDock.jsx'))).default;
  budget = await load(path.join(DIR, 'budget.mjs'));
  for (const f of FIXTURES) composed[f.id] = composePresentation(f.payload, { now: f.at });
});

const handlers = { onOpen() {}, onCorrect() {}, onNotNow() {}, onOffer() {} };
const render = (pres, extra = {}) => renderToString(React.createElement(Situation, { presentation: pres, profile: 'phone', ...handlers, ...extra }));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const count = (hay, needle) => hay.split(needle).length - 1;
const plan = (id) => budget.composeForSurface(composed[id], 'phone');

test('positive control: the 12.1 fixture set covers the ten states in the brief', () => {
  const ids = FIXTURES.map((f) => f.id);
  for (const id of ['live-sunday', 'approval', 'meeting-soon', 'personal-deadline', 'degraded', 'working-busy', 'travelling', 'bedtime', 'empty', 'many-next']) {
    assert.ok(ids.includes(id), id);
  }
});

test('1. a focal object appears when there is a next thing and nothing needs him', () => {
  for (const id of ['live-sunday', 'calm-saturday', 'many-next', 'meeting-soon', 'personal-deadline']) {
    const html = render(composed[id]);
    assert.equal(count(html, 'class="sit__focal"'), 1, id);
  }
  // The live screenshot's case: "Next / Tracey Allen’s 16th Birthday / Friday" is ONE object.
  const live = render(composed['live-sunday']);
  assert.match(live, /sit__focal-eyebrow">Next<\/span><span class="sit__focal-title">Tracey Allen’s 16th Birthday<\/span><span class="sit__focal-meta"><span class="sit__focal-when">Friday/);
});

test('2. no focal object without a next thing, or where something needs him / is current', () => {
  assert.doesNotMatch(render(composed.empty), /sit__focal/, 'nothing next → no object invented');
  assert.doesNotMatch(render(composed.approval), /class="sit__focal"/, 'P0 is the object');
  assert.doesNotMatch(render(composed['working-busy']), /class="sit__focal"/, 'the current thing is the object');
  for (const p of ['kiosk', 'watch', 'desktop']) {
    assert.ok(!budget.composeForSurface(composed['many-next'], p).blocks.some((b) => b.type === 'focal'), `${p} draws no focal block`);
  }
});

test('3. context is grouped — an eyebrow and short lines, never one long dotted string', () => {
  const html = render(composed['live-sunday']);
  assert.match(html, /class="sit__ctx-place">Home</);
  const lines = [...html.matchAll(/<p class="sit__ctx-line">([\s\S]*?)<\/p>/g)].map((m) => text(m[1]).trim());
  assert.ok(lines.length >= 2, `grouped into lines: ${JSON.stringify(lines)}`);
  for (const l of lines) assert.ok(count(l, ' · ') <= 2, `line stays short: ${l}`);
  assert.ok(lines.includes('Helen and Isaac are home'), 'people read as a sentence, on their own line');
  assert.ok(lines.some((l) => l.startsWith('Living Room 19°') && l.includes('10° outside')), 'room and weather together');
  assert.doesNotMatch(html, /class="sit__context"/);
});

test('3b. groupContext arranges and never adds or drops (activity goes to the correction row)', () => {
  const ctx = composed['calm-saturday'].context;
  const g = budget.groupContext(ctx);
  const placed = g.lines.flatMap((l) => l.items.map((i) => i.id));
  const expected = ctx.filter((c) => c.kind !== 'place' && c.kind !== 'activity').map((c) => c.id);
  assert.deepEqual([...placed].sort(), [...expected].sort());
  assert.equal(g.place, 'Home');
  assert.equal(g.activity && g.activity.id, 'activity');
  // Within the surroundings line the server's order holds.
  const sur = g.lines.find((l) => l.id === 'surroundings');
  assert.deepEqual(sur.items.map((i) => i.id), ctx.filter((c) => c.kind === 'room' || c.kind === 'weather').map((c) => c.id));
});

test('4. an inferred activity and an unknown one render differently', () => {
  const inferred = render(composed['calm-saturday']);
  assert.match(inferred, /sit__activity-read">Looks like you’re watching TV/);
  assert.match(inferred, /class="sit__pill"[^>]*>Not quite\?/);
  const unknown = render(composed['live-sunday']);
  assert.match(unknown, /sit__activity sit__activity--unknown/);
  assert.doesNotMatch(unknown, /sit__activity-read/);
  assert.match(unknown, /class="sit__pill"[^>]*>What are you up to\?/);
  // Declared reads as his own words, not her guess.
  const declared = { ...composed['calm-saturday'], context: composed['calm-saturday'].context.map((c) => (c.kind === 'activity' ? { ...c, basis: 'declared' } : c)) };
  assert.ok(text(render(declared)).includes('You said you’re watching TV'));
  assert.equal(inSentence('Watching TV'), 'watching TV');
  assert.equal(inSentence('TV off'), 'TV off', 'an acronym keeps its capitals');
});

test('5. the activity chooser is folded until tapped — options are not in the first render', () => {
  for (const id of ['live-sunday', 'calm-saturday']) {
    const t = text(render(composed[id]));
    for (const o of composed[id].correction.options) if (o.label !== 'Watching TV') assert.ok(!t.includes(o.label), `${id}: "${o.label}" hidden`);
    assert.doesNotMatch(render(composed[id]), /sit__correct-opts/);
  }
});

test('6. "Behind this" is gone; diagnostics attach to the read, or say what she cannot see', () => {
  for (const f of FIXTURES) assert.ok(!text(render(composed[f.id])).includes('Behind this'), f.id);
  const live = render(composed['live-sunday']);
  assert.equal(count(live, '<details'), 1, 'drawn once — attached, not also floating below');
  assert.match(live, /<div class="sit__ctxblock">[\s\S]*<details class="sit__details"><summary>What this is based on<\/summary>[\s\S]*<\/div>/);
  const deg = render(composed.degraded);
  assert.match(deg, /<details class="sit__details" open=""><summary>What I can’t see/);
});

test('7. "Show me everything" is a disclosure after the content and before the dock', () => {
  const foot = React.createElement('div', { className: 'surface__footrow' }, React.createElement('button', { className: 'surface__all' }, 'Show me everything'));
  const dock = React.createElement('form', { className: 'dock-probe' });
  const html = render(composed['live-sunday'], { foot, ask: dock });
  const iCtx = html.indexOf('sit__ctxblock'); const iFoot = html.indexOf('surface__all'); const iDock = html.indexOf('dock-probe');
  assert.ok(iCtx > 0 && iFoot > iCtx && iDock > iFoot, `ctx ${iCtx} < foot ${iFoot} < dock ${iDock}`);
  assert.match(CSS, /\.sit__foot \.surface__all::after \{ content: '›'/, 'drawn as a disclosure');
  // The phone shell must not stand the hatch down on a layout that does not draw the sentence.
  const shell = fs.readFileSync(path.join(ROOT, 'saim', 'app', 'src', 'views', 'Surface.jsx'), 'utf8');
  assert.match(shell, /const hasRevealUtterance = look !== 'situation' &&/);
});

test('8 + 9. the dock is ONE text affordance and ONE voice affordance — never both buttons, never two fields', () => {
  const withMic = renderToString(React.createElement(AskDock, { onAsk() {}, canListen: true, onMic() {} }));
  assert.equal(count(withMic, '<input'), 1);
  assert.equal(count(withMic, '<button'), 1);
  assert.match(withMic, /aria-label="Talk to SAiM"/);
  const noMic = renderToString(React.createElement(AskDock, { onAsk() {}, canListen: false, onMic() {} }));
  assert.equal(count(noMic, '<input'), 1);
  assert.equal(count(noMic, '<button'), 1);
  assert.match(noMic, /aria-label="Send"/);
  assert.doesNotMatch(noMic, /Talk to SAiM/, 'no mic where there is no recogniser');
  assert.match(withMic, /placeholder="Ask SAiM"/);
  const page = render(composed['live-sunday'], { ask: React.createElement(AskDock, { onAsk() {}, canListen: true, onMic() {} }) });
  assert.equal(count(page, '<input'), 1, 'one composer on the surface');
  assert.ok(!/Ask her something|Talk to me/.test(text(page)), 'no second wording of the same control');
});

test('10. the headline scales with text size and is never clipped', () => {
  const rule = CSS.match(/\.sit--phone \.sit__headline \{([^}]*)\}/)[1];
  assert.match(rule, /clamp\([0-9.]+rem,[^,]+,\s*[0-9.]+rem\)/, 'rem-bound, so it follows the user font size');
  assert.doesNotMatch(CSS.match(/\.sit__headline \{([^}]*)\}/)[1], /overflow:\s*hidden|white-space:\s*nowrap|(?<![-\w])(max-)?height:/);
});

test('11. reduced motion is still respected', () => {
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.sit__body \{ animation: none; \}/);
  assert.doesNotMatch(CSS, /animation:[^;]*infinite/);
});

test('12. P0 outranks the focal object: tinted, full attention edge, heavier title; the focal has none of that', () => {
  const html = render(composed.approval);
  assert.match(html, /sit__object sit__object--p0/);
  const p0 = CSS.match(/\.sit__object--p0 \{([^}]*)\}/)[1];
  assert.match(p0, /background: rgba\(255, 180, 92/);
  assert.match(p0, /border-left-color: var\(--sit-attn-edge\)/);
  const focal = CSS.match(/\.sit__focal \{([^}]*)\}/)[1];
  assert.doesNotMatch(focal, /sit-attn|255, 180, 92|border-left/);
});

test('13. no fixed-height dead space on the phone', () => {
  const body = CSS.match(/\.sit--phone \.sit__body \{([^}]*)\}/)[1];
  assert.doesNotMatch(body, /\b(9|1[0-9])vh/, 'no tall vh drop above the headline');
  assert.doesNotMatch(body, /min-height|height:/);
  assert.doesNotMatch(CSS, /\.sit--phone\.sit--level-none \.sit__body \{ padding-top: 16vh/);
});

test('14. a reading scrim lays the ground over the mesh where the headline and dock sit', () => {
  const m = CSS.match(/\.sit--phone \.sit__field::after \{([\s\S]*?)\}/);
  assert.ok(m, 'scrim present');
  const stops = [...m[1].matchAll(/rgba\(11, 15, 20, ([0-9.]+)\) (\d+)%/g)].map((x) => [Number(x[1]), Number(x[2])]);
  assert.ok(stops[0][1] === 0 && stops[0][0] >= 0.7, 'headline band is shaded');
  assert.ok(stops.some(([a, at]) => at >= 25 && at <= 40 && a >= 0.55), 'the content band beneath it is shaded');
  assert.ok(stops[stops.length - 1][0] <= 0.3, 'the open lower screen is the mesh, not a flat band');
  // The dock carries its own ground instead of a band.
  const dock = CSS.match(/\.sit-dock \{([^}]*)\}/)[1];
  assert.ok(Number(dock.match(/background: rgba\([^)]*, ([0-9.]+)\)/)[1]) >= 0.8, 'dock is opaque enough to read on any mesh');
});

test('15. usable with no context at all', () => {
  const bare = { ...composed['live-sunday'], context: [], correction: null };
  const html = render(bare);
  assert.ok(text(html).includes('Quiet Sunday'));
  assert.doesNotMatch(html, /sit__ctx-place|sit__ctx-line/);
});

test('16. usable with no next item', () => {
  const html = render(composed.empty);
  assert.ok(text(html).includes(composed.empty.situation.headline));
  assert.doesNotMatch(html, /sit__focal|sit__nextblock/);
});

test('17. block order still follows the presentation, and the focal is the server’s own choice', () => {
  const ORDER = ['situation', 'needsYou', 'primary', 'focal', 'offers', 'next', 'observations', 'context', 'tracked', 'details', 'ask'];
  for (const f of FIXTURES) {
    const types = plan(f.id).blocks.map((b) => b.type);
    const idx = types.map((t) => ORDER.indexOf(t));
    assert.deepEqual(idx, [...idx].sort((a, b) => a - b), `${f.id}: ${types.join(',')}`);
    const focal = plan(f.id).blocks.find((b) => b.type === 'focal');
    if (focal) {
      const pr = composed[f.id];
      const want = (pr.situation.about && pr.next.find((n) => n.id === pr.situation.about)) || pr.next[0];
      assert.equal(focal.items[0].id, want.id, `${f.id}: focal is the about-item, else Next[0]`);
      const next = plan(f.id).blocks.find((b) => b.type === 'next');
      if (next) assert.ok(!next.items.some((n) => n.id === focal.items[0].id), `${f.id}: not said twice`);
    }
  }
  // Positive control on the ORDER rule: reverse Next and the focal follows the server.
  const rev = { ...composed['many-next'], next: [...composed['many-next'].next].reverse() };
  assert.equal(budget.composeForSurface(rev, 'phone').blocks.find((b) => b.type === 'focal').items[0].id, rev.next[0].id);
});

test('an inferred activity does not cost the phone its weather (the live Sunday read, 4 Oct)', () => {
  // Place, room, activity, household, weather, sleep — activity is drawn as the
  // correction row, so the four context lines must still include the weather.
  const live = FIXTURES.find((f) => f.id === 'live-sunday');
  const payload = { ...live.payload, life: { ...live.payload.life, doing: 'watching-tv', label: 'Watching TV', ask: null, confidence: 'likely' } };
  const pres = composePresentation(payload, { now: live.at });
  assert.deepEqual(pres.context.slice(0, 5).map((c) => c.kind), ['place', 'room', 'activity', 'household', 'weather'], 'fixture reaches the rule');
  const html = render(pres);
  const lines = [...html.matchAll(/<p class="sit__ctx-line">([\s\S]*?)<\/p>/g)].map((m) => text(m[1]));
  assert.ok(lines.some((l) => l.includes('outside')), JSON.stringify(lines));
  assert.match(html, /Looks like you’re watching TV/);
});

test('the meeting-in-20 is the focal object, said once (summary dropped for it)', () => {
  const t = text(render(composed['meeting-soon']));
  assert.equal(count(t, 'Tech Leadership'), 1);
  assert.match(render(composed['meeting-soon']), /sit__focal-title">Tech Leadership/);
});
