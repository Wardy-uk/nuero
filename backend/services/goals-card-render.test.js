'use strict';

/**
 * The Goals card — a REAL render via esbuild of the pieces fed by
 * goal-measures (progress, levers, the measure editor). GoalsCard itself fetches
 * in useEffect, which renderToString never runs, so the exported views are
 * mounted with payloads from the real evaluate()/leversFor()/catalogue().
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');
const gm = require('./goal-measures');

const CANON = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'canonical');

let mod = null;
async function load() {
  if (mod) return mod;
  const out = await esbuild.build({
    entryPoints: [path.join(CANON, 'GoalsCard.jsx')],
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
const html = (el) => renderToString(el).replace(/<!-- -->/g, '');

test('progress renders the state word, the line and where the number came from', async () => {
  const { GoalProgress } = await load();
  const prog = gm.evaluate({ measure: { kind: 'hikes', target: 4, period: 'month' } }, {
    today: '2026-10-13', hiking: { active: true, weekStart: '2026-10-12', reliability: { level: 'ok' }, weeks: [{ confirmed: [{ day: '2026-10-11' }] }] },
  });
  const out = html(React.createElement(GoalProgress, { prog, label: 'Hikes' }));
  assert.match(out, /On track|Behind/);
  assert.match(out, /1 of 4 this month/);
  assert.match(out, /Hiking loop/);
});

test('unknown is said as can’t tell, never as behind', async () => {
  const { GoalProgress } = await load();
  const prog = gm.evaluate({ measure: { kind: 'bp', target: { sys: 130, dia: 80 } }, startDate: '2026-09-01' }, { today: '2026-10-13', days: [] });
  const out = html(React.createElement(GoalProgress, { prog, label: 'Blood pressure' }));
  assert.match(out, /Can’t tell yet/);
  assert.doesNotMatch(out, /Behind/);
});

test('levers carry their action and source, and say they are not a diagnosis', async () => {
  const { Levers } = await load();
  const levers = gm.leversFor({ measure: { kind: 'bp', target: { sys: 130, dia: 80 } } }, { state: 'behind' }, {
    today: '2026-10-13', picture: { insights: [{ id: 'nutrition-salt', domain: 'nutrition', level: 'act', title: 'Salt is high', action: 'Halve the salt' }] },
  });
  const out = html(React.createElement(Levers, { levers, open: true }));
  assert.match(out, /Halve the salt/);
  assert.match(out, /from My Health/);
  assert.match(out, /not a diagnosis/);
});

test('the measure editor offers every catalogue kind, the goal’s type first', async () => {
  const { MeasureEditor } = await load();
  const measures = gm.catalogue();
  const out = html(React.createElement(MeasureEditor, { measures, domain: 'projects', busy: false, onSave() {}, onCancel() {} }));
  for (const m of measures) assert.ok(out.includes(m.label), m.label);
  assert.ok(out.indexOf('Finish a personal project') < out.indexOf('Hikes'), 'a projects-type goal lists the project measure first');
  assert.match(out, /not measured/);
});
