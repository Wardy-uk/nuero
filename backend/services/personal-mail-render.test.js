'use strict';

// The Personal email card, really rendered (esbuild + renderToString), fed the
// payload the real route produces. Nick's rule (12 Oct 2026): wherever he is
// dealing with an email, the screen shows which address it sends from.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-pmrender-')), 'a.db');
const db = require('../db/database');
const pm = require('./personal-mail');

const CARD = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'PersonalMailCard.jsx');
let mod;

test.before(async () => {
  await db.init();
  const out = await esbuild.build({
    entryPoints: [CARD], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl = p => p;', loader: 'js' }));
      },
    }],
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  mod = m.exports;
});

const clean = (html) => html.replace(/<!-- -->/g, '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const render = (el) => clean(renderToString(el));

test('every sending mailbox shows who it sends as — from the payload, before anything is set', () => {
  const { mailboxes } = pm.status();
  const saim = mailboxes.find((m) => m.key === 'saim');
  const html = render(React.createElement(mod.Mailbox, { m: saim, onChange: () => {} }));
  assert.match(html, /Sends as <strong>"SAiM \(for Nick Ward\)" <saim@nickward\.co\.uk><\/strong>/);
  assert.match(html, /replies go to <strong>nick@nickward\.co\.uk<\/strong>/);
  assert.match(html, /mail\.livemail\.co\.uk:993/);
  assert.match(html, /type="password"/);
  const neuro = mailboxes.find((m) => m.key === 'neuro');
  assert.doesNotMatch(render(React.createElement(mod.Mailbox, { m: neuro, onChange: () => {} })), /Sends as/, 'neuro@ sends nothing, so it claims no From');
});

test('the test row names From, Reply-To and To before the button is pressed', () => {
  pm.setCredential('saim', { password: 'pw-one' });
  pm.setCredential('nick', { password: 'pw-two' });
  const saim = pm.status().mailboxes.find((m) => m.key === 'saim');
  const html = render(React.createElement(mod.Mailbox, { m: saim, onChange: () => {} }));
  assert.match(html, /Send test/);
  assert.match(html, /From <strong>"SAiM \(for Nick Ward\)" <saim@nickward\.co\.uk><\/strong> · Reply-To <strong>nick@nickward\.co\.uk<\/strong> → <strong>nick@nickward\.co\.uk<\/strong>/);
  assert.doesNotMatch(html, /pw-one|pw-two/);
});

test('a verdict that lands in Spam is not shown as good, and a missing read-back is not a pass', () => {
  const good = render(React.createElement(mod.TestResult, { t: { id: 'a', sentAt: '2026-10-12T10:00:00Z', from: 'x', to: 'y', readback: 'found', folder: 'Inbox', summary: 'SPF pass · DKIM pass · DMARC pass — all pass' } }));
  assert.match(good, /class="pm-good"/);
  const spam = render(React.createElement(mod.TestResult, { t: { id: 'b', sentAt: '2026-10-12T10:00:00Z', from: 'x', to: 'y', readback: 'found', folder: 'Spam', summary: 'SPF pass · DKIM pass · DMARC pass — all pass' } }));
  assert.match(spam, /class="pm-bad"/);
  const lost = render(React.createElement(mod.TestResult, { t: { id: 'c', sentAt: '2026-10-12T10:00:00Z', from: 'x', to: 'y', readback: 'not-found', readbackError: 'Not in nick’s inbox' } }));
  assert.match(lost, /class="pm-bad"/);
  assert.doesNotMatch(lost, /all pass/);
});
