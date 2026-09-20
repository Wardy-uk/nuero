'use strict';

/**
 * Does the operation phase actually REACH the screen, on both shells?
 *
 * `AttentionSurface` is shared file-for-file by the phone and the Pi kiosk and
 * neither has a test runner. A vite build proves the JSX compiles; it does not
 * run it, and the three most expensive frontend mistakes in this repo all
 * compiled perfectly. So this bundles the real shared component with esbuild
 * and mounts it, the way `surface-rooms-render.test.js` does.
 *
 * The rules under test are not cosmetic:
 *   * a phase the composer emitted must be VISIBLE, or this is another payload
 *     field with no reader — the dominant failure mode in this codebase;
 *   * a resting phase must not print a detail line, because a line that is
 *     there all day is one nobody reads;
 *   * an unrecognised phase must print NOTHING rather than its own raw id.
 *
 * Lives in backend/services because `node --test` is only run from backend/.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const { composeOperation } = require('./attention-operation');

const SURFACE = path.resolve(__dirname, '..', '..', 'saim', 'shared-ui', 'AttentionSurface.jsx');

const FIELD_STUB = 'export default function Field() { return null; }\nexport const isPressing = () => false;\n';

function stubPlugin() {
  return {
    name: 'stub',
    setup(build) {
      build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      build.onResolve({ filter: /(^|\/)Field(\.jsx)?$/ }, () => ({ path: 'field', namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: FIELD_STUB, loader: 'js' }));
    },
  };
}

let Surface;

test.before(async () => {
  global.window = global.window || {
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  const out = await esbuild.build({
    entryPoints: [SURFACE],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom'],
    plugins: [stubPlugin()],
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  Surface = mod.exports.default;
  assert.ok(Surface, 'AttentionSurface has a default export');
});

function payload(operation, extra = {}) {
  return {
    context: { activity: 'steady', label: 'Steady', known: true, confidence: { level: 'high' } },
    primary: null,
    secondary: [],
    dropped: [],
    quiet: false,
    rationale: [],
    poolAvailable: true,
    gaps: [],
    operation,
    ...extra,
  };
}

const render = (props) => renderToString(React.createElement(Surface, props));

// ── The phase reaches the screen ────────────────────────────────────────────

test('a calm day renders STANDING BY, and no lifecycle line', () => {
  const op = composeOperation({ poolAvailable: true });
  const html = render({ data: payload(op) });
  assert.match(html, /STANDING BY/);
  // ⚠ The resting phases carry no detail by design, and the renderer must not
  //   manufacture one from the phase name.
  assert.doesNotMatch(html, /surface__opdetail/);
});

test('a meeting renders QUIET beside the context word, and prompts for nothing', () => {
  const op = composeOperation({ poolAvailable: true, quiet: true });
  const html = render({
    data: payload(op, { quiet: true, context: { activity: 'in-meeting', label: 'In a meeting', known: true } }),
  });
  assert.match(html, /QUIET/);
  assert.match(html, /in a meeting/i, 'the context word is still there — they are different facts');
  assert.doesNotMatch(html, /surface__opdetail/);
});

test('an unreadable pool renders UNAVAILABLE with its named-gap sentence', () => {
  const op = composeOperation({ poolAvailable: false });
  const html = render({ data: payload(op, { poolAvailable: false }) });
  assert.match(html, /UNAVAILABLE/);
  assert.match(html, /all-clear/i, 'and says it is not one');
});

test('a request in flight renders EXECUTING and what was asked', () => {
  const op = composeOperation({
    poolAvailable: true,
    desk: { known: true, requested: [{ id: 'di_a', app: 'code', label: 'VS Code', at: '2026-09-20T10:00:00.000Z' }], taken: [] },
  });
  const html = render({ data: payload(op) });
  assert.match(html, /EXECUTING/);
  assert.match(html, /VS Code/);
  // ⚠ And it never claims the thing happened — the whole point of the phase.
  assert.doesNotMatch(html, /\b(opened|completed)\b/i);
});

test('a claimed request renders VERIFYING — taken, outcome unknown', () => {
  const op = composeOperation({
    poolAvailable: true,
    desk: { known: true, requested: [], taken: [{ id: 'di_b', app: 'browser', label: 'your browser', at: '2026-09-20T10:01:00.000Z' }] },
  });
  const html = render({ data: payload(op) });
  assert.match(html, /VERIFYING/);
  assert.match(html, /what happened/i);
});

test('an offer renders AWAITING AUTHORISATION in the offer own words', () => {
  const offer = { key: 'room:lr:lights-on#e1', kind: 'lights-on', area: 'Living Room', say: 'Want the living room lights on?' };
  const op = composeOperation({ poolAvailable: true, rooms: { known: true, offers: [offer] } });
  const html = render({ data: payload(op) });
  assert.match(html, /AWAITING AUTHORISATION/);
  assert.match(html, /Want the living room lights on\?/);
});

// ── Degradation ─────────────────────────────────────────────────────────────

test('⚠ a payload with no operation renders exactly as it did before this existed', () => {
  // The contract `surface` and `field` already have: null means "draw it the way
  // you knew how to". A phone on an older bundle, or a composition that failed,
  // must not lose the screen.
  const html = render({ data: payload(null) });
  assert.doesNotMatch(html, /surface__op\b/);
  assert.match(html, /SAiM/, 'and the rest of the surface is untouched');
});

test('⚠ NEGATIVE: an unrecognised phase prints nothing rather than its own id', () => {
  // A payload from a newer backend must degrade to showing LESS, never to
  // printing an identifier at Nick. An id is never a label — the rule the
  // review queue and the meeting card both paid for.
  const html = render({ data: payload({ phase: 'teleporting', label: null, detail: null, active: false }) });
  assert.doesNotMatch(html, /teleporting/);
});

test('⚠ the shell own phase wins while it is mid-request, and borrows no sentence', () => {
  const op = composeOperation({
    poolAvailable: true,
    desk: { known: true, requested: [], taken: [{ id: 'di_b', app: 'browser', label: 'your browser', at: '2026-09-20T10:01:00.000Z' }] },
  });
  const html = render({ data: payload(op), localPhase: 'assessing' });
  assert.match(html, /ASSESSING/);
  assert.doesNotMatch(html, /VERIFYING/);
  // ⚠ The server's sentence was composed for a DIFFERENT state. Printing it
  //   under this one would move a fact onto a phase it was not about.
  assert.doesNotMatch(html, /what happened/i);
});

// ── The wording ─────────────────────────────────────────────────────────────

test('⚠ FORBIDDEN WORDING: no phase label is a verdict, a score or a mood', () => {
  const { LABELS } = require('../../shared/operation-phase.cjs');
  for (const [phase, label] of Object.entries(LABELS)) {
    assert.doesNotMatch(label, /\b(good|bad|behind|ahead|failing|great|ok|fine|busy)\b/i, phase);
    assert.equal(label, label.toUpperCase(), `${phase} is a terse state, not a sentence`);
    assert.ok(label.length <= 24, `${phase} fits a crown`);
  }
});

test('positive control: the harness really does see the crown it is asserting on', () => {
  // Without this a broken bundle would pass every `doesNotMatch` above by
  // rendering nothing at all — the absence-of-evidence trap this repo keeps
  // finding in its own scans.
  const html = render({ data: payload(composeOperation({ poolAvailable: true })) });
  assert.match(html, /surface__crown/);
  assert.match(html, /surface__op\b/);
});
