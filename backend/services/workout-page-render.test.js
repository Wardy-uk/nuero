'use strict';

/**
 * The workout page renders the REAL contract (2 Nov 2026): a real read() over a
 * scratch DB, bundled with esbuild and rendered to a string — so a field the
 * page reads that the server never sends fails here, not on Nick's screen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-wkrender-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'a.db');
process.env.WORKOUT_PHOTO_DIR = path.join(tmp, 'photos');

const db = require('../db/database');
const view = require('./workout-view');

const START = Date.UTC(2026, 10, 2, 9, 42, 0);
const sql = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

let m;
test.before(async () => {
  await db.init();
  const pts = Array.from({ length: 121 }, (_, i) => [52.68 + (i / 120) * 0.027, -1.306, 170 + 120 * Math.sin(Math.PI * i / 120), START / 1000 + i * 30]);
  db.insertWorkouts([{
    sourceUuid: 'R-1', activityType: 'Hiking', startedAt: sql(START), endedAt: sql(START + 3600e3), durationSeconds: 3600,
    distanceM: 3010, elevationM: 125, activeEnergyKcal: 300, avgHeartRate: 118, maxHeartRate: 150,
    payload: { route: { points: pts, pointCount: 121, firstAt: sql(START), lastAt: sql(START + 3600e3) } },
  }]);
  for (let i = 0; i < 60; i++) db.insertHealthSample('heartRate', 100 + i, sql(START + i * 60e3), 'test');
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'workout', 'WorkoutPage.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom', 'leaflet'], logLevel: 'silent',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      b.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiFetch = async () => ({ ok: true, json: async () => ({}) }); export const apiUrl = (p) => p;', loader: 'js' }));
    } }],
  });
  m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
});

const html = (Comp, props) => {
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  return renderToString(React.createElement(Comp, props)).replace(/<!-- -->/g, '');
};
const wid = () => db.get("SELECT id FROM health_workouts WHERE source_uuid = 'R-1'").id;

test('the page renders every section from the real contract', () => {
  assert.equal(typeof m.exports.WorkoutView, 'function', 'positive control: the view is exported');
  const v = view.read(wid());
  const out = html(m.exports.WorkoutView, { data: v, onOpen: () => {}, onIndex: () => {} });
  for (const s of ['3.01 km in 1 h 00, 125 m up', 'Elevation', 'Heart rate', 'Splits', 'Heart-rate bands', 'Weather where you walked', 'On the day', 'The watch also measured', 'Same route before', 'Photos']) {
    assert.ok(out.includes(s), `missing: ${s}`);
  }
  assert.ok(out.includes('Monday 2 November 2026'));
  assert.ok(out.includes('09:42–10:42'));
  // Unread sources are said, never drawn as zero.
  assert.ok(out.includes('NEURO has not fetched the weather'), 'pending weather is named');
  assert.ok(out.includes('not carried'), 'the logger says it was not carried');
  assert.ok(out.includes('No photos yet'), 'no photos is said');
  assert.ok(out.includes('All walks'));
  assert.equal((out.match(/<tr class="|<tr>/g) || []).length >= 4, true);
});

test('the Outdoor lead card and the index render', () => {
  const card = html(m.exports.LastHikeView, { data: view.lastHike(), onOpen: () => {} });
  assert.ok(card.includes('Last hike · Monday 2 November 2026'));
  assert.ok(card.includes('Open the full page'));
  const idx = html(m.exports.WorkoutIndex, { data: view.list(), onOpen: () => {} });
  assert.ok(idx.includes('Mon 2 Nov 2026 · Hike'));
  assert.ok(idx.includes('<polyline'));
});
