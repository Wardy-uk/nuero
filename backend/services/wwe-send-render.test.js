'use strict';

/**
 * The "Send to Walking with Ember" button and its status line render from the
 * REAL contract: a real read() (with `site`) over a scratch DB, the real
 * wwe_sends record, the real WorkoutPage bundled with esbuild.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-wwerender-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'a.db');
process.env.WORKOUT_PHOTO_DIR = path.join(tmp, 'photos');

const db = require('../db/database');
const view = require('./workout-view');
const wwe = require('./wwe-send');

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

test('the send button shows for a hike, and the status line says what happened', () => {
  assert.equal(typeof m.exports.WorkoutView, 'function', 'positive control: the view is exported');
  const id = wid();
  let out = html(m.exports.WorkoutView, { data: view.read(id), onSendToSite: () => {} });
  assert.ok(out.includes('Send to Walking with Ember'), 'the button is there for a hike');
  assert.ok(!out.includes('Sent to Walking with Ember as a draft'), 'nothing sent yet, nothing claimed');
  // Without the shell's handler (e.g. the Outdoor card) there is no button.
  assert.ok(!html(m.exports.WorkoutView, { data: view.read(id) }).includes('Send to Walking with Ember'));

  wwe._recordForTests({ workoutId: id, status: 'sent', date: '2026-11-02', slug: '2026-11-02-coalville', pagePath: 'src/content/walks/2026-11-02-coalville.md', previewUrl: 'https://walkingwithember.co.uk/preview/walks/2026-11-02-coalville/', sha: 'abc' });
  out = html(m.exports.WorkoutView, { data: view.read(id), onSendToSite: () => {} });
  assert.ok(out.includes('Sent to Walking with Ember as a draft'), 'the success line');
  assert.ok(out.includes('href="https://walkingwithember.co.uk/preview/walks/2026-11-02-coalville/"'));
  assert.ok(out.includes('Open the preview'));
  assert.ok(out.includes('Send to Walking with Ember again'));

  wwe._recordForTests({ workoutId: id, status: 'failed', error: 'GitHub refused the push — nothing was published' });
  out = html(m.exports.WorkoutView, { data: view.read(id), onSendToSite: () => {} });
  assert.ok(out.includes('Not sent to Walking with Ember — GitHub refused the push'), 'the failure reason');
  assert.ok(out.includes('Sent to Walking with Ember as a draft'), 'the earlier success is still said');
  out = html(m.exports.WorkoutView, { data: view.read(id), onSendToSite: () => {}, sending: true });
  assert.ok(out.includes('Sending…'));
});
