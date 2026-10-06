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
let LegacyCard;

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
  LegacyCard = mod.exports.LegacyCard;
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
const render = (over = {}, props = {}) => renderToString(React.createElement(PreparedCard, {
  action: { ...BASE, ...over }, busy: false, onApprove: () => {}, onReject: () => {}, onEdit: async () => true, ...props,
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

test('the page approves with a fresh challenge, the DISPLAYED payload hash and the typed code, and is mounted on the Actions screen', () => {
  const src = fs.readFileSync(FILE, 'utf8');
  // Build 8: ONE exported helper (approveWithCode) does challenge + approve for
  // every screen that approves an email — Actions, the Inbox, Weekly Risk.
  assert.match(src, /postVerb\(a, 'approval-challenge', \{\}\)/);
  assert.match(src, /postVerb\(a, 'approve', \{ payloadHash: a\.payloadHash, challengeId: ch\.challengeId, approvalCode: code \}\)/);
  assert.match(src, /\/api\/prepared-actions\?limit=50/);
  for (const other of ['InboxPanel.jsx', 'WeeklyRiskPanel.jsx']) {
    const s = fs.readFileSync(path.resolve(FILE, '..', other), 'utf8');
    assert.match(s, /approveWithCode\(/, `${other} approves through the shared helper`);
    assert.doesNotMatch(s, /\/api\/actions\/\$\{[^}]+\}\/approve/, `${other} has no old-queue approve door`);
  }
  // The CODE is never stored. Since 5 Oct 2026 (fed2834, trusted browsers) the
  // page keeps ONE thing in localStorage: the server-issued, revocable device
  // TOKEN under DEVICE_KEY. So every storage call must name that key, the
  // only value ever written is the token the server returned, and nothing
  // else (session storage, IndexedDB) is touched.
  assert.doesNotMatch(src, /sessionStorage|indexedDB/);
  const storageCalls = src.match(/localStorage\.\w+\([^)]*\)/g) || [];
  assert.ok(storageCalls.length >= 2, 'positive control: the trusted-device token is stored');
  for (const call of storageCalls) assert.match(call, /^localStorage\.\w+\(DEVICE_KEY/, `storage touches only the device token: ${call}`);
  assert.match(src, /localStorage\.setItem\(DEVICE_KEY, t\)/);
  assert.match(src, /if \(d && d\.ok && d\.token\) setDeviceToken\(d\.token\)/, 'only the token the server issued is saved');
  assert.doesNotMatch(src, /setDeviceToken\(\s*code\s*\)|setItem\([^)]*code/i, 'the approval code itself is never written');
  const panel = fs.readFileSync(path.resolve(FILE, '..', 'ActionsPanel.jsx'), 'utf8');
  // Mounted, with whatever props (f94d946 added a `key` so it reloads after an approve).
  assert.match(panel, /<PreparedActions(\s[^>]*)?\/>/);
});

test('Build 7: approving opens a password field for the approval code, and a gate is said instead of a button', () => {
  // The confirm step only renders after a click, which renderToString cannot do —
  // so pin the field's attributes in source, with a positive control.
  const src = fs.readFileSync(FILE, 'utf8');
  const field = src.slice(src.indexOf('<label className="pa-code">'), src.indexOf('</label>', src.indexOf('<label className="pa-code">')));
  assert.ok(field.length > 20, 'positive control: the approval-code field exists');
  assert.match(field, /type="password"/);
  assert.match(field, /autoComplete="off"/);
  assert.match(src, /setCode\(''\);\s+\/\/ cleared before the request/);
  // A gate disables the approve button and says why.
  const gated = render({ }, { gate: 'Sending is switched off (Settings).' });
  assert.match(gated, /Sending is switched off/);
  assert.match(gated, /disabled=""[^>]*>Approve &amp; send…/);
  const ungated = render({});
  assert.doesNotMatch(ungated, /disabled=""[^>]*>Approve &amp; send…/);
});

test('Build 7: a chase from the old queue renders as legacy, unverified, pre-ledger — never as sent and confirmed', () => {
  const html = renderToString(React.createElement(LegacyCard, { item: {
    legacyRef: 'saim_actions:1', status: 'legacy_unverified', occurredAt: '2026-08-15 15:49:39',
    target: { name: 'Naomi', email: 'nickw@nurtur.tech', source: 'manual' }, note: 'Delivery is NOT verified.',
  } }));
  assert.match(html, /legacy · unverified · pre-ledger/);
  assert.match(html, /typed by hand/);
  assert.doesNotMatch(html, /confirmed in Sent Items/);
});

test('Build 7: the People board shows the SAME queue filtered to chases — no second queue, no old approve or address doors', () => {
  const wo = fs.readFileSync(path.resolve(FILE, '..', 'WaitingOn.jsx'), 'utf8');
  assert.match(wo, /<PreparedActions[\s\S]*?filter=\{a => a\.actionType === 'chase_commitment'/);
  assert.doesNotMatch(wo, /\/api\/actions|\/chase\/\$\{[^}]+\}\/(recipient|channel)|QueuedChase/);
  assert.match(wo, /\/api\/waiting-on\/\$\{encodeURIComponent\(item\.key\)\}\/\$\{path\}/, 'positive control: the Chase button still posts to the waiting-on route');
});
