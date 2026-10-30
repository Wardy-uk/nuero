'use strict';

/**
 * NOVA's 1-2-1 Overview on the People board — a REAL render (esbuild), not a source scan.
 *
 * Fixtures are the live rows from NOVA's overview screen on 30 Oct 2026 (Maria Pappa
 * overdue / booked late, Heidi Power logged, Naomi Wentworth to log), in the exact shape
 * `getOne21Overview()` returns.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const SRC = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'NovaOneToOne.jsx');
let M;

test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [SRC], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, a => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl = p => p;', loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  M = mod.exports;
});

const clean = (h) => h.replace(/<!-- -->/g, '');
const base = {
  nextDate: null, nextStatus: null, overdue: false, dueThisWeek: false, stalled: false, awaitingPrep: false,
  prepSubmitted: false, lastDate: null, lastSessionId: null, lastLoggedInPeopleHr: false, measured: false,
  cadenceDays: null, cadenceRag: 'grey', bookedLate: false, writeUpDue: null, imported: false, importedOn: null,
  importRag: 'grey', hrLoggedOn: null, hrRag: 'grey', hrTargetSessionId: null, hrTargetDate: null, hrToLog: 0,
  outstandingActions: 0, awaitingConfirmation: 0, delivered: 0, missed: 0, deliveryRate: null,
};
const maria = { ...base, agent_name: 'Maria Pappa', nextDate: '2026-10-27', overdue: true, bookedLate: true,
  lastDate: '2026-08-20', lastSessionId: 11, cadenceDays: 71, cadenceRag: 'red', outstandingActions: 18 };
const naomi = { ...base, agent_name: 'Naomi Wentworth', lastDate: '2026-10-29', lastSessionId: 40, measured: true,
  cadenceDays: 1, cadenceRag: 'green', imported: true, importRag: 'green', hrRag: 'grey',
  hrTargetSessionId: 40, hrTargetDate: '2026-10-29', hrToLog: 1, outstandingActions: 13 };
const hope = { ...base, agent_name: 'Hope Goodall', nextDate: '2026-11-04', awaitingPrep: true, lastDate: '2026-09-17',
  lastSessionId: 22, cadenceDays: 43, cadenceRag: 'green', outstandingActions: 3, delivered: 5, deliveryRate: 100 };

test('status pill follows NOVA order — stalled outranks overdue', () => {
  assert.equal(M.novaStatus({ ...maria, stalled: true }).label, 'Stalled');
  assert.equal(M.novaStatus(maria).label, 'Overdue');
  assert.equal(M.novaStatus(hope).label, 'Awaiting prep');
  assert.equal(M.novaStatus(naomi).label, 'Not scheduled');
});

test('card block: overdue + late next date, weeks since last, open actions', () => {
  const h = clean(renderToString(React.createElement(M.NovaCardBlock, { agent: maria })));
  assert.match(h, /Overdue/);
  assert.match(h, /27 Oct/);
  assert.match(h, / late/);
  assert.match(h, /20 Aug/);
  assert.match(h, /10w/);
  assert.match(h, /18 open/);
});

test('card block: PeopleHR box offers the held 1-2-1 still to log', () => {
  const h = clean(renderToString(React.createElement(M.NovaCardBlock, { agent: naomi })));
  assert.match(h, /To log · 29 Oct/);
  assert.match(h, /type="checkbox"/);
  assert.match(h, /● Notes/);
});

test('card block: delivery rate with its sample', () => {
  const h = clean(renderToString(React.createElement(M.NovaCardBlock, { agent: hope })));
  assert.match(h, /100%/);
  assert.match(h, /\(5\/5\)/);
});

test('no NOVA row renders nothing — not tracked is not "all fine"', () => {
  assert.equal(renderToString(React.createElement(M.NovaCardBlock, { agent: undefined })), '');
});

test('tiles: the twelve NOVA counters, and an unreachable NOVA is SAID', () => {
  const summary = { total: 12, scheduled: 8, overdue: 1, dueThisWeek: 6, stalled: 0, awaitingPrep: 3,
    awaitingConfirmation: 0, neverScheduled: 0, deliveryRate: 100, peoplehrPending: 2, cadenceAmber: 0, cadenceRed: 3, writeUpOverdue: 0 };
  const h = clean(renderToString(React.createElement(M.NovaOverviewTiles, { state: { ok: true, data: { agents: [], summary } } })));
  for (const l of ['Overdue', 'Stalled', 'Awaiting prep', 'To confirm', 'Over 8 weeks', '6–8 weeks', 'Write-up overdue',
    'To log in PeopleHR', 'Due this week', 'Scheduled', 'Never scheduled', 'Action delivery']) assert.ok(h.includes(l), l);
  assert.match(h, /12 agents/);
  const down = clean(renderToString(React.createElement(M.NovaOverviewTiles, { state: { ok: false, error: 'bridge down' } })));
  assert.match(down, /not available: bridge down/);
});

test('PeopleBoard mounts both, and hides the old actions line when NOVA has the person', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'PeopleBoard.jsx'), 'utf8');
  assert.match(src, /<NovaOverviewTiles /);
  assert.match(src, /<NovaCardBlock agent=\{novaByName\[person\.name\]\}/);
  assert.match(src, /!novaByName\[person\.name\] && openActions/);
  assert.match(src, /\/api\/1to1\/overview/);
});
