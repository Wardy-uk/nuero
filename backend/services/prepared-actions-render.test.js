'use strict';

/**
 * Build 6H — the approval card SHOWS what will leave the building, and the
 * approve control sends the payload hash it displayed.
 *
 * A REAL render via esbuild (a vite build proves it compiles, not that the
 * recipient address is on screen). Pinned: exact recipient address, subject,
 * full body, A4 authority, the why and the evidence; executed-but-unverified is
 * never worded as confirmed; an uncertain send says it will not be resent; a
 * prepare-only type says nothing will be sent; and the page fetches the queue.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const FILE = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'PreparedActions.jsx');
let PreparedCard;

test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [FILE], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
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
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  PreparedCard = mod.exports.PreparedCard;
  assert.ok(PreparedCard, 'positive control: PreparedCard must be exported, or this passes by absence');
});

const BASE = {
  actionId: 'pa_1', actionType: 'chase_commitment', version: 1, status: 'prepared', executes: true,
  payloadHash: 'abc', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
  reason: 'Chris Middleton owes Nick this, it is at risk (due today), and nothing NEURO can see says it moved.',
  draft: { to: [{ name: 'Chris Middleton', email: 'chris.middleton@nurtur.tech' }], subject: 'Following up: send the rota',
    body: "Hi Chris,\n\nFollowing up: you were going to send the rota. Could you let me know where it's got to?\n\nThanks,\nNick" },
  evidence: { commitment: { description: 'Chris Middleton to send the rota' }, finding: { summary: 'Due today and still open' },
    progress: { state: 'no_evidence' } },
};
const render = (over = {}) => renderToString(React.createElement(PreparedCard, {
  action: { ...BASE, ...over }, busy: false, onApprove: () => {}, onReject: () => {}, onEdit: async () => true,
}));

test('the card shows the exact recipient, subject, body, authority, why and evidence before approval', () => {
  const html = render();
  assert.match(html, /chris\.middleton@nurtur\.tech/);
  assert.match(html, /Following up: send the rota/);
  assert.match(html, /Could you let me know where it(&#x27;|')s got to\?/);
  assert.match(html, />A4</);
  assert.match(html, /owes Nick this/);
  assert.match(html, /Due today and still open/);
  assert.match(html, /your sent mail was checked/);
  assert.match(html, /Approve &amp; send/);
  assert.match(html, />Edit</);
  assert.match(html, />Reject</);
});

test('executed is never worded as confirmed; uncertain says it will not be resent; finished cards offer no approve', () => {
  const executed = render({ status: 'executed' });
  assert.match(executed, /not yet confirmed/);
  assert.doesNotMatch(executed, /Approve/);
  const uncertain = render({ status: 'execution_uncertain', outcomeDetail: 'Checking Sent Items; it will NOT be resent.' });
  assert.match(uncertain, /will NOT be resent/);
  assert.match(render({ status: 'verified' }), /confirmed in Sent Items/);
});

test('a prepare-only type says nothing will be sent and does not offer "send"', () => {
  const html = render({ actionType: 'draft_update_email', executes: false, notExecutableWhy: 'prepare-only in Build 6' });
  assert.match(html, /nothing will be sent/);
  assert.doesNotMatch(html, /Approve &amp; send/);
});

test('the page approves with the DISPLAYED payload hash and is mounted on the Actions screen', () => {
  const src = fs.readFileSync(FILE, 'utf8');
  assert.match(src, /post\(a, 'approve', \{ payloadHash: a\.payloadHash \}\)/);
  assert.match(src, /\/api\/prepared-actions\?limit=50/);
  const panel = fs.readFileSync(path.resolve(FILE, '..', 'ActionsPanel.jsx'), 'utf8');
  assert.match(panel, /<PreparedActions \/>/);
});
