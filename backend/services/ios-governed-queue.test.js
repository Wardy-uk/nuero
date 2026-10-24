'use strict';

/**
 * iOS governed-queue conformance, enforced from NEURO.
 *
 * ⚠ POLICY REVERSED BY NICK, 24 Oct 2026: "if I click send or any other action,
 * I want it to do it there and then — not hand it off to the desktop". This file
 * used to pin Brief 005 (D-012/D-013: the phone decides nothing). It now pins
 * the rule that replaced it: THE PHONE DECIDES, CARRYING THE SAME PROOFS AS THE
 * DESKTOP. What it guards:
 *
 *  1. Every governed approve goes through ONE function (`IntentGrant.approveWithCode`),
 *     which asks the server for a fresh challenge and sends `challengeId` +
 *     `approvalCode` with it. No other Swift file calls the approve route.
 *  2. A direct send (`execute-direct`) is reached only through `IntentGrant.sendDirect`,
 *     which takes a server-issued intent grant FIRST. No other file calls
 *     `execute-direct` or `intent-grant`.
 *  3. No desktop hand-off wording is left in app code ("… in NEURO on the
 *     desktop — Actions"), so a press never answers with "go elsewhere".
 *
 * ⚠ IT SCANS EVERY NON-TEST SWIFT SOURCE in the checkout, both apps, the
 * package and the watch. The checker is a PURE function over `{rel, src}` so the
 * negative controls run against fixtures as well as the real tree.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { findIOSCheckout } = require('./ios-checkout');

const IOS = findIOSCheckout();
const GRANT = 'NeuroKit/Sources/NeuroKit/IntentGrant.swift';

/** Comment lines out: a comment naming a route is documentation, not a call. */
function stripComments(src) {
  return src.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

const APPROVE = /prepared-actions\/[^"\n]*\/approve\b/;
const DIRECT = /prepared-actions\/[^"\n]*\/(execute-direct|intent-grant)\b/;
const HANDOFF = /(in|on) NEURO on the desktop|on the desktop [—-] Actions|deskHandoff|never from the watch/;

function checkIOS(files) {
  const out = [];
  for (const { rel, src: raw } of files) {
    const src = stripComments(raw);
    if (rel !== GRANT && APPROVE.test(src)) out.push(`${rel} calls the governed approve route outside IntentGrant.approveWithCode`);
    if (rel !== GRANT && DIRECT.test(src)) out.push(`${rel} calls intent-grant/execute-direct outside IntentGrant.sendDirect`);
    if (HANDOFF.test(src)) out.push(`${rel} still hands a press off to the desktop`);
  }
  return out;
}

function fnBody(code, name) {
  const m = code.match(new RegExp(`public static func ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n    \\}`));
  return m ? m[1] : null;
}

/** The grant API itself carries the proofs, in order, before anything executes. */
function checkGrantAPI(src) {
  const out = [];
  const code = stripComments(src);
  const ap = fnBody(code, 'approveWithCode');
  if (ap == null) out.push('approveWithCode not found');
  else {
    const ch = ap.indexOf('/approval-challenge');
    const go = ap.search(/\/approve"/);
    if (ch < 0) out.push('approveWithCode does not ask for a challenge');
    else if (go >= 0 && go < ch) out.push('approveWithCode approves before the challenge');
    if (!/"challengeId"/.test(ap) || !/"approvalCode"/.test(ap)) out.push('approveWithCode does not send challengeId + approvalCode');
  }
  const sd = fnBody(code, 'sendDirect');
  if (sd == null) out.push('sendDirect not found');
  else {
    const g = sd.indexOf('/intent-grant');
    const x = sd.indexOf('/execute-direct');
    if (g < 0 || x < 0 || x < g) out.push('sendDirect does not take an intent grant before execute-direct');
    if (!/"grantId"/.test(sd)) out.push('sendDirect does not send the grant id');
  }
  return out;
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return ['.git', 'Tests', 'build', 'DerivedData', '.build'].includes(e.name) ? [] : walk(p);
    return e.name.endsWith('.swift') ? [p] : [];
  });
}

function iosFiles() {
  return walk(IOS).map((f) => ({ rel: path.relative(IOS, f).split(path.sep).join('/'), src: fs.readFileSync(f, 'utf8') }));
}

// ── the checker, against fixtures (always runs) ─────────────────────────────

test('negative controls: each prohibited shape is caught', () => {
  const cases = [
    ['Neuro/Features/X.swift', 'client.workCall("/api/prepared-actions/\\(id)/approve", body: [:])'],
    ['Saim/X.swift', 'call(c, "/api/prepared-actions/\\(id)/execute-direct", b)'],
    ['Neuro/Features/X.swift', 'call(c, "/api/prepared-actions/\\(id)/intent-grant", b)'],
    ['Neuro/Features/X.swift', 'Text("Approve, reject or snooze this in NEURO on the desktop — Actions.")'],
    ['SaimWatch/X.swift', 'Text("Approve on your phone or desktop — never from the watch.")'],
  ];
  for (const [rel, src] of cases) assert.ok(checkIOS([{ rel, src }]).length > 0, `not caught: ${rel}: ${src}`);
});

test('positive controls: the allowed shapes pass', () => {
  assert.deepEqual(checkIOS([
    { rel: GRANT, src: 'call(c, "/api/prepared-actions/\\(id)/approve", b)\ncall(c, "/api/prepared-actions/\\(id)/execute-direct", b)' },
    { rel: 'Neuro/Features/ActionScreens.swift', src: 'let o = await IntentGrant.approveWithCode(client, ref, code: code)\nclient.workCall("/api/actions/\\(id)/approve", body: [:])' },
    { rel: 'Neuro/Features/X.swift', src: '// used to say: in NEURO on the desktop — Actions' },
  ]), []);
});

test('the grant-API check fails an approve without a challenge, or a send without a grant', () => {
  const bad = 'public static func approveWithCode(_ client: NeuroAPIClient, _ ref: Ref, code: String) async -> Outcome {\n        let r = await call(client, "/api/prepared-actions/x/approve", [:])\n    }\n'
    + 'public static func sendDirect(_ client: NeuroAPIClient, _ ref: Ref) async -> Outcome {\n        let r = await call(client, "/api/prepared-actions/x/execute-direct", [:])\n    }\n';
  const v = checkGrantAPI(bad);
  assert.ok(v.some((x) => /does not ask for a challenge/.test(x)));
  assert.ok(v.some((x) => /challengeId \+ approvalCode/.test(x)));
  assert.ok(v.some((x) => /intent grant before execute-direct/.test(x)));
});

// ── the real checkout ───────────────────────────────────────────────────────

test('every non-test iOS Swift source carries the desktop proofs and no hand-off', { skip: !IOS && 'no nuero-ios checkout beside this repo' }, () => {
  const files = iosFiles();
  assert.ok(files.length > 50, `positive control: the walk found the app sources (${files.length})`);
  assert.ok(files.some((f) => f.rel.startsWith('Saim/')), 'positive control: the SAiM app is scanned too');
  assert.deepEqual(checkIOS(files), []);
});

test('IntentGrant takes the challenge + code to approve, and a grant to send', { skip: !IOS && 'no nuero-ios checkout beside this repo' }, () => {
  const src = fs.readFileSync(path.join(IOS, GRANT), 'utf8');
  assert.deepEqual(checkGrantAPI(src), []);
});

module.exports = { checkIOS, checkGrantAPI };
