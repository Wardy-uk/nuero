'use strict';

/**
 * One light source — the cards and the field must be the same colour.
 *
 * ⚠⚠ THEY WERE NOT, AND BOTH HALVES LOOKED FINE ON THEIR OWN. `AttentionSurface`
 * hand-picked four stops and a ladder of its own — `pressing || firefighting ?
 * red : pre-meeting ? amber : blue` — under a comment claiming there was "one
 * place that decides and no component picks its own". `Field` drew from
 * `fieldDrive`. Measured 14 Sep 2026 on an ordinary steady high-confidence day:
 * the canvas behind her drew 240,134,60 (orange) while every card on top of it
 * drew 74,127,212 (blue). The two ladders did not even agree on which states
 * were distinguishable — `pre-meeting` and `steady` are one colour to the field
 * and two to the cards.
 *
 * That is the readiness inversion's exact shape: a second ladder, written from
 * a premise about the first, drifting quietly because neither half is wrong
 * when read alone. Nick's call, 14 Sep: the cards follow the field, so an
 * ordinary well-read day is orange. `surfaceRgb` is the one function; these
 * pin that nothing else picks.
 *
 * `saim/shared-ui` is ESM and this suite is CommonJS, so the module comes in by
 * dynamic import (the field-drive / vault-browser-health pattern).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const SHARED = path.resolve(__dirname, '..', '..', 'saim', 'shared-ui');
const read = (f) => fs.readFileSync(path.join(SHARED, f), 'utf8');

let m;
test.before(async () => {
  m = await import(pathToFileURL(path.join(SHARED, 'fieldDrive.mjs')).href);
});

// ── The one function ────────────────────────────────────────────────────────

test('the surface colour IS the field colour, in every state', () => {
  const states = [
    { degraded: true },
    { quiet: true, activity: 'in-meeting' },
    { quiet: true, activity: 'in-meeting', pressing: true },
    { confidenceLevel: 'low' },
    { confidenceLevel: 'moderate' },
    { confidenceLevel: 'high' },
    { confidenceLevel: 'high', activity: 'pre-meeting' },
    { confidenceLevel: 'high', activity: 'firefighting' },
    { confidenceLevel: 'high', pressing: true },
  ];
  for (const s of states) {
    const d = m.drive(s);
    const field = m.rgbText(m.colour(d.intensity, d.unresolved));
    // ⚠ THE JOIN, not the halves. Both were individually correct for months.
    assert.equal(m.surfaceRgb(s), field, `disagreed on ${JSON.stringify(s)}`);
  }
});

test('the states the old card ladder got wrong', () => {
  // The three readings that gave it away, as fixtures.
  // An ordinary well-read day is ORANGE now, not blue — the consequence Nick
  // accepted when he chose one light source over two.
  assert.equal(m.surfaceRgb({ confidenceLevel: 'high' }), '240,134,60');
  // The old ladder called this amber and the field called it the same orange as
  // a steady day; the field is right, so they are one colour.
  assert.equal(m.surfaceRgb({ confidenceLevel: 'high', activity: 'pre-meeting' }), '240,134,60');
  // Blind is GREY, never the blue of a quiet afternoon.
  assert.equal(m.surfaceRgb({ degraded: true }), '150,160,170');
  // Quiet keeps her blue.
  assert.equal(m.surfaceRgb({ quiet: true }), '114,150,211');
  // And a pressing item goes red even inside quiet: quiet means she will not
  // SPEAK, never that she may hide a breaching escalation.
  assert.equal(m.surfaceRgb({ quiet: true, pressing: true }), '240,70,60');
});

test('a junk or empty read still yields her colour, never nothing', () => {
  // A screen that has never been told is not a reason to paint it a colour
  // that means nothing — and never `undefined`, which reaches CSS as a
  // transparent border and reads as an unstyled page.
  for (const s of [undefined, {}, { confidenceLevel: 'nonsense' }]) {
    assert.match(m.surfaceRgb(s), /^\d+,\d+,\d+$/);
  }
});

// ── Nothing picks locally ───────────────────────────────────────────────────

test('⚠ AttentionSurface DERIVES its colour and holds no stops of its own', () => {
  const src = read('AttentionSurface.jsx');
  // Positive control: a wrong filename must fail HERE rather than pass by
  // finding no hardcoded colours in an empty string.
  assert.match(src, /toneRgb/, 'could not read AttentionSurface.jsx');
  assert.match(src, /surfaceRgb\(/, 'the surface must ask fieldDrive');

  // The four stops it used to carry. ⚠ Searched as literals, because that is
  // what a regression looks like: somebody re-adding one "just for this case".
  for (const stop of ['74, 127, 212', '217, 138, 58', '224, 84, 58', '107, 116, 128']) {
    assert.ok(!src.includes(`'${stop}'`), `AttentionSurface picked a colour again: ${stop}`);
  }
});

test('⚠ the dead palette copy in Approach.css is gone and stays gone', () => {
  const css = read('Approach.css');
  assert.match(css, /--approach-rgb: var\(--saim-rgb/, 'the alias must read the shell value');
  // `.approach--warm/--crit/--unresolved` were a FOURTH copy of the palette
  // that nothing applied, sitting under a comment saying the colour is never
  // picked locally. A dead stop teaches the next reader the wrong rule.
  for (const dead of ['.approach--warm', '.approach--crit', '.approach--unresolved']) {
    assert.ok(!css.includes(`${dead} {`), `${dead} is back`);
  }
});

test('⚠ the corridor reads the SHARED light levels, not its own numbers', () => {
  const css = read('Approach.css');
  // The card/fact backlight and the shelf both went to Lit.css so the corridor
  // and every screen built after it are lit to the same three strengths.
  assert.match(css, /border-color: var\(--lit-border\)/);
  assert.match(css, /box-shadow: var\(--lit-glow\)/);
  assert.match(css, /border-color: var\(--lit-shelf-border\)/);
});

// ── The primitives ──────────────────────────────────────────────────────────

test('Lit.css resolves every colour from --saim-rgb', () => {
  const css = read('Lit.css');
  assert.match(css, /--saim-rgb/, 'could not read Lit.css');

  // ⚠ ONE exemption, and it is a BLOCK rather than a list of literals: the
  // fault chip is deliberately the single place a real alarm colour appears, so
  // it is cut out whole and asserted on separately below. Exempting the
  // individual values instead would quietly license the next one.
  const withoutFault = css.replace(/\.lit-chip--fault\s*\{[^}]*\}/s, '');

  // Everything left must resolve from her, except the neutral whites — which
  // are opacity on the ground, not a claim about state — and the blue-end
  // fallback, which is a point on her own ramp rather than a fifth stop.
  const literals = (withoutFault.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/g) || [])
    .filter((c) => !/\(\s*255\s*,\s*255\s*,\s*255/.test(c))
    .filter((c) => !/\(\s*114\s*,\s*150\s*,\s*211/.test(c));
  assert.deepEqual(literals, [], `Lit.css picked its own colours: ${literals.join(' ')}`);

  // Positive control: the cut actually removed something, so a renamed class
  // cannot make this pass by exempting nothing.
  assert.ok(withoutFault.length < css.length, '.lit-chip--fault was not found to exempt');
});

test('⚠ hierarchy by LIGHT — the lead really is brighter than the rest', () => {
  const css = read('Lit.css');
  const alpha = (name) => {
    const block = css.match(new RegExp(`--${name}:\\s*rgba\\(var\\(--saim-rgb\\),\\s*([\\d.]+)\\)`));
    assert.ok(block, `--${name} must be an alpha on her colour`);
    return Number(block[1]);
  };
  // Equal light everywhere is the scatter of equal boxes wearing a glow.
  assert.ok(alpha('lit-lead-border') > alpha('lit-border'), 'the lead must outrank a card');
  assert.ok(alpha('lit-border') > alpha('lit-shelf-border'), 'a card must outrank the shelf');
});

test('⚠ THREE light states, not two', () => {
  const css = read('Lit.css');
  // Unreachable renders DASHED rather than missing: a control NEURO would
  // refuse is worse than no control, and an absent one teaches nothing at all.
  assert.match(css, /\.lit--off\s*\{[^}]*border-style:\s*dashed/s);
  assert.match(css, /\.lit--off\s*\{[^}]*box-shadow:\s*none/s, 'unreachable must gain NO glow');
  // A statement is not a control, so it carries no affordance either.
  assert.match(css, /\.lit--quiet\s*\{[^}]*box-shadow:\s*none/s);
});

test('⚠ a named gap is never styled as a fault', () => {
  const css = read('Lit.css');
  const gap = css.match(/\.lit-chip--gap\s*\{([^}]*)\}/s);
  assert.ok(gap, 'could not read .lit-chip--gap');
  // "I couldn't read the diary" is her being honest, not something failing.
  // Warning-orange on it is how he learns to ignore the real one too.
  assert.ok(!/\b(?:224|240|217)\s*,/.test(gap[1]), 'a gap must not wear an alarm colour');
  assert.match(gap[1], /rgba\(255, 255, 255/, 'a gap is muted, not coloured');
});

test('⚠ both shells light the whole app, not just the Surface', () => {
  // MANIFESTATION.md's own finding: "the secondary screens are not lit by her
  // at all ... so the app looks like two products." The phone and the kiosk
  // mount the SAME screens, so one lit and one not is that finding with a wall
  // display in it.
  const roots = [
    path.resolve(SHARED, '..', 'app', 'src', 'App.jsx'),
    path.resolve(SHARED, '..', 'frontend', 'src', 'App.jsx'),
  ];
  for (const file of roots) {
    const src = fs.readFileSync(file, 'utf8');
    assert.match(src, /useFieldDrive/, `could not read ${file}`);   // positive control
    assert.match(src, /className="app lit-scope"/, `${file} does not light the shell`);
    assert.match(src, /'--saim-rgb': surfaceRgb\(fieldDrive\)/, `${file} must derive, not pick`);
  }
});

// ── It actually RENDERS, and something actually mounts it ────────────────────

test('⚠ the primitive renders, and the scope carries her colour', async () => {
  // A vite build proves the JSX compiles, and every expensive frontend mistake
  // in this repo compiled perfectly. So it is bundled and mounted, the way
  // `surface-rooms-render.test.js` does.
  const esbuild = require('esbuild');
  const { renderToString } = require('react-dom/server');
  const React = require('react');

  const out = await esbuild.build({
    entryPoints: [path.join(SHARED, 'Lit.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node',
    jsx: 'automatic', external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{
      name: 'css',
      setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);

  const { Lit, LitChip, LitLabel, LitScope } = mod.exports;
  const h = React.createElement;

  // The scope puts ONE colour on the subtree, derived from the read.
  const scoped = renderToString(
    h(LitScope, { drive: { degraded: true } }, h(Lit, null, 'x'))
  );
  assert.match(scoped, /--saim-rgb:\s*150,160,170/, 'blind must be grey, from the one function');
  assert.match(scoped, /class="lit-scope"/);

  // Tones are MEANINGS and each has its own class.
  assert.match(renderToString(h(Lit, { tone: 'lead' }, 'x')), /lit lit--lead/);
  assert.match(renderToString(h(Lit, { tone: 'statement' }, 'x')), /lit lit--quiet/);
  assert.match(renderToString(h(Lit, { tone: 'unreachable' }, 'x')), /lit lit--off/);
  // ⚠ An unrecognised tone falls back to the ORDINARY card rather than
  // throwing or rendering unstyled — a typo must not take a screen down.
  assert.match(renderToString(h(Lit, { tone: 'nonsense' }, 'x')), /class="lit"/);

  assert.match(renderToString(h(LitChip, { tone: 'gap' }, 'no diary')), /lit-chip--gap/);
  assert.match(renderToString(h(LitChip, null, 'ok')), /class="lit-chip"/);
  assert.match(renderToString(h(LitLabel, null, 'Right now')), /class="lit-label"/);
});

test('⚠ something MOUNTS it — a primitive nobody uses is one that rots', () => {
  // The reader-with-no-writer shape, which this repo names as its own dominant
  // failure mode. The readiness card is the first real use.
  const now = fs.readFileSync(
    path.resolve(SHARED, '..', 'app', 'src', 'views', 'Now.jsx'), 'utf8');
  assert.match(now, /readiness\?\.notable/, 'could not read Now.jsx');  // positive control
  assert.match(now, /from '\.\.\/\.\.\/\.\.\/shared-ui\/Lit\.jsx'/);
  assert.match(now, /<Lit className="now__readiness">/);
});
