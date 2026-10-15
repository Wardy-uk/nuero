'use strict';

/**
 * NEURO's exact-item link view, a REAL render via esbuild (15 Oct 2026).
 * The view shows THE record a link names, or an explicit failure — never a
 * broad page in its place. The fetch wrapper runs in useEffect, which
 * renderToString never runs, so the pure ItemLinkView is mounted with answers
 * produced by the REAL resolver route shapes. PreparedActions and MeetingPrep
 * are replaced by probes that prove the scoping (exactly one action; that
 * meeting's id), since they fetch for themselves.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const SRC = path.resolve(__dirname, '..', '..', 'frontend', 'src');

let mod = null;
async function load() {
  if (mod) return mod;
  const out = await esbuild.build({
    entryPoints: [path.join(SRC, 'components', 'ItemLink.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'],
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onResolve({ filter: /\/PreparedActions$/ }, () => ({ path: 'PreparedActions', namespace: 'stub' }));
        build.onResolve({ filter: /\/MeetingPrep$/ }, () => ({ path: 'MeetingPrep', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
          loader: 'jsx',
          contents: a.path === 'api' ? 'export const apiFetch = async () => ({ status: 200, json: async () => ({}) });'
            : a.path === 'PreparedActions'
              ? "export default function P({ filter, title }) { const all = ['pa_0000000000000001', 'pa_0000000000000002', 'pa_0000000000000003'].map((actionId) => ({ actionId })); return <div data-probe='prepared' data-title={title}>{all.filter(filter).map((a) => a.actionId).join(',')}</div>; }"
              : "export default function M({ eventId }) { return <div data-probe='meeting'>{String(eventId)}</div>; }",
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
const html = async (result) => { const { ItemLinkView } = await load(); return renderToString(React.createElement(ItemLinkView, { result, onNavigate: () => {} })); };

test('an action link shows exactly that one action, with its real controls', async () => {
  const h = await html({ ok: true, status: 'open', kind: 'action', id: 'pa_0000000000000002', record: { actionId: 'pa_0000000000000002', status: 'prepared' } });
  assert.match(h, /data-probe="prepared"[^>]*>pa_0000000000000002</, 'scoped to the one action — not the queue');
});

test('a meeting-prep link opens that meeting’s prep', async () => {
  const h = await html({ ok: true, status: 'open', kind: 'meeting-prep', id: 'AAMkEvent1=', record: { eventId: 'AAMkEvent1=' } });
  assert.match(h, /data-probe="meeting"[^>]*>AAMkEvent1=</);
});

test('a task, email or hazard link shows the record itself; the way on is labelled "Find it…" / "Show it…", never "Open"', async () => {
  const t = await html({ ok: true, status: 'open', kind: 'task', id: '600', record: { taskId: 600, text: 'Send the Parsons breakdown', status: 'open', dueDate: '2026-10-15' } });
  assert.match(t, /Send the Parsons breakdown/);
  assert.match(t, /#600/);
  assert.match(t, /Show it in Tasks/);
  const e = await html({ ok: true, status: 'open', kind: 'email', id: 'AAMk1', record: { emailId: 'AAMk1', subject: 'Portal outage', from: 'Sandford', receivedAt: '2026-10-15T09:00:00Z' } });
  assert.match(e, /Portal outage/);
  assert.match(e, /Find it in Inbox/);
  const p = await html({ ok: true, status: 'open', kind: 'email', id: 'pmail:nick:7:41', record: { emailId: 'pmail:nick:7:41', subject: 'Car insurance', mailbox: 'nick' } });
  assert.match(p, /Find it in Personal inbox/);
  const z = await html({ ok: true, status: 'open', kind: 'hazard', id: 'binary_sensor.kitchen_leak', record: { entityId: 'binary_sensor.kitchen_leak', name: 'Kitchen leak', state: 'on' } });
  assert.match(z, /Kitchen leak/);
  assert.match(z, /Find it on Home/);
});

test('every failure is explicit, says nothing else was opened, and shows no record controls', async () => {
  for (const [status, heading] of [['invalid', /isn’t valid/], ['missing', /can’t find this/], ['stale', /no longer live/], ['unreadable', /couldn’t check/], ['unauthorised', /needs your PIN/], ['error', /couldn’t open/]]) {
    const h = await html({ ok: false, status, kind: 'task', id: '999', why: 'because' });
    assert.match(h, heading, status);
    assert.match(h, /because/);
    assert.match(h, /Nothing else was opened in its place/);
    assert.ok(!/data-probe/.test(h), `${status}: no record screen behind a failure`);
    assert.ok(!/Show it in Tasks/.test(h), `${status}: no way on that implies success`);
  }
});

test('a stale record with a successor offers the current one — and says it is not the one you asked for', async () => {
  const h = await html({ ok: false, status: 'stale', kind: 'action', id: 'pa_0000000000000002', why: 'this action was replaced by a newer version', current: 'neuro:?item=action%3Apa_0000000000000003', record: { actionId: 'pa_0000000000000002', status: 'superseded' } });
  assert.match(h, /no longer live/);
  assert.match(h, /Open the current one/);
  const { itemFromNeuroHref } = await load();
  assert.equal(itemFromNeuroHref('neuro:?item=action%3Apa_0000000000000003'), 'action:pa_0000000000000003');
  assert.equal(itemFromNeuroHref('neuro:?view=actions'), null);
});

test('App routes ?item= to this view and keeps the item in the URL only while on it', () => {
  const app = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8');
  assert.match(app, /const item = params\.get\('item'\);\s*\n\s*if \(item\) return \{ view: 'item', context: \{ item \} \};/);
  assert.match(app, /case 'item': return <ItemLink item=\{navContext && navContext\.item\}/);
  assert.match(app, /if \(view === 'item' && context\?\.item\) next\.searchParams\.set\('item', context\.item\);\s*\n\s*else next\.searchParams\.delete\('item'\);/);
});
