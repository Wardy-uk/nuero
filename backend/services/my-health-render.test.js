'use strict';

/**
 * My Health renders the picture the server composed — a REAL render via esbuild.
 * The panel fetches in useEffect, which renderToString never runs, so the pure
 * MyHealthView is mounted with a payload produced by the real compose(), not a
 * hand-written one: a field renamed on one side fails here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');
const hp = require('./health-picture');

const COMPONENTS = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components');

let mod = null;
async function load() {
  if (mod) return mod;
  const out = await esbuild.build({
    entryPoints: [path.join(COMPONENTS, 'MyHealthPanel.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'],
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const apiFetch = async () => ({ ok: true, json: async () => ({}) });', loader: 'js',
        }));
      },
    }],
    logLevel: 'silent',
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  mod = m.exports;
  return mod;
}

function picture(over = {}) {
  const days = Array.from({ length: 20 }, (_, i) => ({
    day: new Date(Date.UTC(2026, 9, 12 - i)).toISOString().slice(0, 10), complete: i > 0,
    bpSystolic: 144, bpDiastolic: 86, daylightMinutes: 12,
  }));
  return hp.compose({ today: '2026-10-12', nowMs: Date.parse('2026-10-12T10:00:00Z'), days,
    medical: { total: 0, diagnoses: [], prescriptions: [] },
    sources: { watchMs: Date.parse('2026-10-12T09:50:00Z') }, ...over });
}

test('positive control: the export exists', async () => {
  assert.equal(typeof (await load()).MyHealthView, 'function');
});

test('the act item, its action and its tile are drawn', async () => {
  const { MyHealthView } = await load();
  const html = renderToString(React.createElement(MyHealthView, { data: picture(), onNavigate: () => {} }));
  assert.match(html, /What to do/);
  assert.match(html, /Blood pressure is averaging 144\/86/);
  assert.match(html, /Book a blood-pressure review/);
  assert.match(html, /mh-tile--act/);
  assert.match(html, /What NEURO can’t see/);
  assert.match(html, /No medical records in NEURO yet/);
  assert.match(html, /Apple Watch/);
});

test('an incomplete picture says it is not an all-clear', async () => {
  const { MyHealthView } = await load();
  const html = renderToString(React.createElement(MyHealthView, { data: picture({ unread: [{ input: 'days', why: 'x' }] }) }));
  assert.match(html, /not an all-clear/);
});

// ── Blood pressure against sleep and meetings (7 Nov 2026) ──────────────────
test('BP context: renders the real bpContext() verdict, the table, and an unknown row with its reason', async () => {
  const { BpContextView } = await load();
  const pi = require('./performance-insights');
  const days = Array.from({ length: 30 }, (_, i) => ({ day: `d${i}`, asleepHours: 6 + (i % 4), bpSystolic: 140 + ((i * 7) % 9), bpDiastolic: 86 }));
  const data = { ok: true, known: true, ...pi.bpContext(days, new Map()) };
  const html = renderToString(React.createElement(BpContextView, { data }));
  assert.match(html, /No clear link between your blood pressure and sleep the night before/);
  assert.match(html, /mh-bp-table/);
  assert.match(html, /need 20/);            // the meetings rows say why they are unknown
  assert.match(html, /corrected threshold/);
});

test('BP context: a failed read says so — never a blank or an all-clear', async () => {
  const { BpContextView } = await load();
  const html = renderToString(React.createElement(BpContextView, { data: { ok: false, error: 'boom' } }));
  assert.match(html, /Couldn’t test blood pressure/);
});
