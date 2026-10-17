'use strict';

/**
 * Does the Energy screen DRAW, and keep its three states apart?
 * (no reading = "—", a partial day = marked, a real total = the number; every
 * £ estimated). FuelSection and the Home card's EnergyLine take their payload
 * as props, so a real render reaches the real branches.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

async function load(file) {
  const out = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', file)],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom'],
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const apiFetch = async () => ({ ok: true, json: async () => ({}) }); export const apiUrl = (p) => p;', loader: 'js',
        }));
      },
    }],
    logLevel: 'silent',
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  return m.exports;
}

/** Rendered HTML with React's text separators removed, so a sentence reads as one. */
const r = (el) => renderToString(el).replace(/<!-- -->/g, '');

const day = (d, kwh, complete, extra = {}) => ({ day: d, kwh, complete, present: complete ? 48 : 30, expected: 48, costP: kwh == null ? null : 300, ...extra });
function fuel() {
  return {
    present: true,
    today: day('2026-10-17', 3.2, false),
    yesterday: day('2026-10-16', 9.4, false, { costP: null, costWhy: 'no tariff for this date' }),
    month: { kwh: 140, costP: null, days: 17, completeDays: 15, costedDays: 0 },
    lastMonth: { kwh: 260, costP: null }, lastMonthToDate: { kwh: 150, costP: null },
    days: [day('2026-10-15', 10.1, true), day('2026-10-16', 9.4, false), day('2026-10-17', null, false)],
    freshness: { state: 'late', ageHours: 40, usualLagHours: 26 },
    backfill: { complete: false, progressPct: 42, earliestAvailable: Date.parse('2025-09-01'), slotsMissing: 12 },
    sync: { consecutiveFailures: 0 },
  };
}

test('FuelSection: partial yesterday is marked, missing cost is "—" not £0, lag and backfill are said', async () => {
  const { FuelSection } = await load('EnergyPanel.jsx');
  const html = r(React.createElement(FuelSection, { fuel: 'electricity', f: fuel(), ins: null, range: 30 }));
  assert.match(html, /Yesterday \(incomplete\)/);
  assert.match(html, /9\.4 kWh/);
  assert.ok(!html.includes('£0.00'), 'no tariff must never render as £0');
  assert.match(html, /later than usual/);
  assert.match(html, /backfilling — 42%/);
  assert.match(html, /12 half-hours Bright has no reading for/);
});

test('FuelSection (gas): weather fit and unusual days render with their caveat', async () => {
  const { FuelSection } = await load('EnergyPanel.jsx');
  const ins = {
    baselineKwhPerDay: 40, missing: { incompleteDays: 2 }, weekly: [],
    weather: { kwhPerDegreeDay: 4.1, baseKwhPerDay: 8, r2: 0.82, n: 90, note: 'a correlation, not a cause' },
    normalised: [{ day: '2026-10-15', kwh: 60, expected: 44 }],
    unusual: [{ day: '2026-10-15', actual: 60, expected: 44, pctAbove: 36 }],
  };
  const html = r(React.createElement(FuelSection, { fuel: 'gas', f: fuel(), ins, range: 30 }));
  assert.match(html, /4\.1 kWh/);
  assert.match(html, /36% above what the weather explains/);
  assert.match(html, /correlation, not a cause/);
});

test('Home card EnergyLine: silent until connected; "(so far)" on a partial day', async () => {
  const { EnergyLine } = await load('canonical/HomeCard.jsx');
  assert.equal(r(React.createElement(EnergyLine, { energy: { connection: { configured: false }, fuels: {} } })), '');
  const html = r(React.createElement(EnergyLine, { energy: { connection: { configured: true }, fuels: { electricity: fuel() } } }));
  assert.match(html, /electricity 9\.4 kWh \(so far\)/);
  assert.ok(!html.includes('£'), 'no cost claimed when a fuel is uncosted');
});

test('VESTA Energy: a day with no reading is a gap, not a zero bar; an unread block says so', async () => {
  const out = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '..', '..', 'vesta', 'src', 'components', 'Energy.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom'], logLevel: 'silent',
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  const Energy = m.exports.default;
  const energy = { connected: true, monthCostP: 4210, note: 'Costs are estimates, not the bill.', fuels: {
    gas: { yesterday: { kwh: 41.2, costP: 310, complete: true }, month: { kwh: 520, costP: 3900 },
      days: [{ day: '2026-10-15', kwh: 40, complete: true }, { day: '2026-10-16', kwh: null, complete: false }] } } };
  const html = r(React.createElement(Energy, { energy }));
  assert.match(html, /Yesterday: 41\.2 kWh · ~£3\.10/);
  assert.match(html, /energy__bar--none/);
  assert.match(html, /estimates, not the bill/);
  assert.match(r(React.createElement(Energy, { energy: null, gap: 'could not read the energy meters' })), /couldn.t read this/);
});
