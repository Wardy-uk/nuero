'use strict';

/**
 * "Looks done", rendered for real (esbuild + renderToString) from the SAME
 * shared component the desktop Tasks list, desktop Now and the SAiM Tasks view
 * mount.
 *
 *  - the section renders NOTHING when nothing is offered (no noisy Now);
 *  - an offer shows the evidence in words, Close and Not yet;
 *  - read-only (the kiosk) shows the words and no buttons;
 *  - a source NEURO could not read is named under the section;
 *  - all three shells actually mount it (source scan with a positive control).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');

async function load(file) {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, file)],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    nodePaths: [path.join(ROOT, 'node_modules'), ...String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)],
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const offer = { taskId: 485, text: 'Send Lucy and Suraj screenshots of the queues', say: 'Sent “Queue screenshots” to Lucy Hart, Thu 29 Oct', more: 1, evidence: [] };
const call = async () => ({ status: 200, body: {} });

let DE;
test.before(async () => { DE = await load('saim/shared-ui/DoneEvidence.jsx'); });

test('the section renders nothing when nothing is offered', () => {
  assert.equal(renderToString(React.createElement(DE.LooksDoneView, { data: { ok: true, items: [], gaps: [] }, call })), '');
  assert.equal(renderToString(React.createElement(DE.LooksDoneView, { data: null, call })), '');
});

test('an offer shows the evidence in words, Close it and Not yet', () => {
  const html = renderToString(React.createElement(DE.LooksDoneView, { data: { ok: true, items: [offer], gaps: [] }, call })).replace(/<!-- -->/g, "");
  assert.match(html, /Looks done \(1\)/);
  assert.match(html, /Sent “Queue screenshots” to Lucy Hart, Thu 29 Oct/);
  assert.match(html, /\+1 more/);
  assert.match(html, /Close it/);
  assert.match(html, /Not yet/);
  assert.match(html, /Nothing is closed until you say so/);
});

test('read-only shows the words and no buttons; a gap is named', () => {
  const html = renderToString(React.createElement(DE.LooksDoneView, { data: { ok: true, items: [offer], gaps: [{ source: 'sent-mail', why: 'Sent Items could not be read' }] }, call, readOnly: true })).replace(/<!-- -->/g, "");
  assert.match(html, /Queue screenshots/);
  assert.doesNotMatch(html, /Close it/);
  assert.match(html, /Couldn(&#x27;|')t check: Sent Items could not be read/);
});

test('offerFor finds the task, and nothing for another', () => {
  assert.equal(DE.offerFor({ items: [offer] }, 485).taskId, 485);
  assert.equal(DE.offerFor({ items: [offer] }, 486), null);
});

test('all three shells mount it', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  assert.match(read('frontend/src/components/TodoPanel.jsx'), /<DoneEvidenceRow taskId=\{todo\.task_id\}/);
  assert.match(read('frontend/src/components/AdhdPanel.jsx'), /<LooksDoneSection call=\{desktopCall\}/);
  assert.match(read('saim/app/src/views/Tasks.jsx'), /<DoneEvidenceRow taskId=\{item\.task_id\}/);
  // positive control: the component still exports what the shells import
  assert.equal(typeof DE.DoneEvidenceRow, 'function');
  assert.equal(typeof DE.default, 'function');
});
