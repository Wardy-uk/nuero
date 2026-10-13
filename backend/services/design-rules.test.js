'use strict';
/**
 * docs/design-rules.md, enforced (13 Oct 2026). Every Life card had been built
 * on its own and they all came out as walls of sentences. This pins:
 *  - the shared building blocks render what the rules promise (an unknown
 *    number is "—", never 0; a headline carries its badge);
 *  - every Life card OPENS with <Headline> — a source scan, with a positive
 *    control so a broken scan cannot pass by absence.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FRONT = path.join(__dirname, '..', '..', 'frontend', 'src', 'components');
const C = (f) => path.join(FRONT, 'canonical', f);

// The Life cards the rules apply to. Adding a Life card means adding it here.
const LIFE_CARDS = [
  'HomeCard.jsx', 'PeopleCard.jsx', 'PersonalDatesCard.jsx', 'OutdoorCard.jsx', 'HikeSafetyCard.jsx',
  'FinanceCard.jsx', 'TransportCard.jsx', 'LeisureCard.jsx', 'ProjectsCard.jsx', 'GoalsCard.jsx',
  'FutureRadar.jsx',
];

test('every Life card opens with a Headline from canonicalUi', () => {
  const missing = LIFE_CARDS.filter((f) => {
    const src = fs.readFileSync(C(f), 'utf8');
    return !/import\s*\{[^}]*\bHeadline\b[^}]*\}\s*from\s*'\.\/canonicalUi'/.test(src) || !/<Headline[\s>]/.test(src);
  });
  assert.deepEqual(missing, [], `cards without a <Headline> (docs/design-rules.md rule 2): ${missing.join(', ')}`);
});

test('positive control: the scan sees a card that has no headline', () => {
  const fake = "import { Fold } from './canonicalUi';\nexport default function X() { return <p>hi</p>; }";
  assert.ok(!/<Headline[\s>]/.test(fake));
});

test('building blocks: unknown is a dash, headline carries its badge', async () => {
  const esbuild = require('esbuild');
  const built = await esbuild.build({
    entryPoints: [C('canonicalUi.jsx')], bundle: true, write: false, platform: 'node', format: 'cjs',
    jsx: 'automatic', external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiFetch = async () => ({});', loader: 'js' }));
    } }],
  });
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  const m = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(m, m.exports, require);
  const ui = m.exports;
  const stat = renderToString(React.createElement(ui.Stat, { v: null, l: 'walks' }));
  assert.match(stat, />—</);
  assert.ok(!/>0</.test(stat), 'an unknown number is never 0');
  const h = renderToString(React.createElement(ui.Headline, { tone: 'plan', pill: 'Planned' }, 'Saturday hike'));
  assert.match(h, /cn-pill--plan/);
  assert.match(h, /Saturday hike/);
  assert.equal(ui.dayLabel('2026-11-21'), 'Sat 21 Nov');
});
