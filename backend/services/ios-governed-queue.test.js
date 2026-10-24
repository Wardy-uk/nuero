'use strict';

/**
 * Brief 005 — iOS governed-queue conformance, enforced from NEURO.
 *
 * D-012: the phone does not approve, reject, edit, snooze or set approval
 * policy for a queued item — on either queue (`prepared_actions` or the older
 * `saim_actions`). It reads them and hands off to NEURO on the desktop → Actions.
 * D-013: a direct send (intent grant) is allowed only for a draft the phone has
 * just prepared in a user-started flow, and never repurposed for a queued draft.
 *
 * ⚠ IT SCANS EVERY NON-TEST SWIFT SOURCE in the checkout, both apps and the
 * package, because the last version of this rule looked at one file and an
 * approve path was added in another (Brief 002). The checker is a PURE function
 * over `{rel, src}` so the negative controls run against fixtures as well as
 * against the real tree; the real-tree negative control (a prohibited call
 * inserted into a real file) is recorded in the Brief 005 return.
 *
 * ONE named exemption (Nick, 24 Oct 2026): the Tasks screen's "Spotted, waiting
 * on you" capture_todo intake may answer `/api/actions/*` — in
 * `Neuro/Features/TasksFullScreen.swift` only, and only while that file carries
 * the `BRIEF 005 EXEMPTION` marker that says why.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { findIOSCheckout } = require('./ios-checkout');

const IOS = findIOSCheckout();

// Files that run a user-started flow which prepares, then sends, its own draft.
const DIRECT_FLOWS = new Set([
  'Neuro/Features/AskScreen.swift',            // chat-attended
  'Neuro/Features/EventComposerScreen.swift',  // event-composer
  'Neuro/Features/OneToOneDialogs.swift',      // 1to1-book / -move / -cancel
  'Neuro/Features/PersonalInboxScreen.swift',  // composer (reply + compose)
  'Neuro/Features/WorkEmailCard.swift',        // composer (work reply)
  'Neuro/Features/WaitingOnScreen.swift',      // chase-button
  'Neuro/Features/PeopleBoardParts.swift',     // chase-button (People board)
  'Neuro/Features/WeeklyRiskScreen.swift',     // weekly-risk
]);
// Where the grant API itself is defined.
const DEFINITIONS = new Set([
  'NeuroKit/Sources/NeuroKit/IntentGrant.swift',
  'NeuroKit/Sources/NeuroKit/PersonalInbox.swift',
]);
const INTAKE_EXEMPT = 'Neuro/Features/TasksFullScreen.swift';

/** Comment lines out: a comment naming a route is documentation, not a call. */
function stripComments(src) {
  return src.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

const PROHIBITED = [
  [/IntentGrant\.(reject|edit)\s*\(/, 'rejects or edits a governed draft through IntentGrant'],
  [/prepared-actions\/[^"\n]*\/(approve|reject|edit)\b/, 'calls a prepared-action approve/reject/edit route'],
  [/approval-challenge/, 'asks for an approval challenge'],
  [/prepared-actions\/approval-code/, 'sets the approval code'],
  [/phoneMayApprove/, 'gates a phone approval (the phone approves nothing)'],
  [/\bcase\s+(approveAction|rejectAction)\b/, 'declares a queue approve/reject action'],
];

/**
 * @param {{rel: string, src: string}[]} files  non-test Swift sources, raw
 * @returns {string[]} violations, empty when the policy holds
 */
function checkIOS(files) {
  const out = [];
  for (const { rel, src: raw } of files) {
    const src = stripComments(raw);
    for (const [re, why] of PROHIBITED) {
      if (re.test(src)) out.push(`${rel} ${why}`);
    }
    // The older queue's per-item routes (approve/reject/snooze/batch) and bulk
    // reject: only the capture_todo intake, only where it says why.
    const touchesOlderQueue = /"\/api\/actions\/|\/api\/actions\/batch|bulk-reject/.test(src);
    if (touchesOlderQueue) {
      const exempt = rel === INTAKE_EXEMPT && /BRIEF 005 EXEMPTION/.test(raw);
      if (!exempt) out.push(`${rel} answers an item on the older queue (/api/actions/…)`);
    }
    // D-013: only the allowlisted flows may build a sendable Ref or send.
    const sends = /\bsendDirect\s*\(/.test(src) && !DEFINITIONS.has(rel);
    const builds = /\.preparedHere\s*\(/.test(src) && !DEFINITIONS.has(rel);
    if ((sends || builds) && !DIRECT_FLOWS.has(rel)) {
      out.push(`${rel} sends directly or builds a sendable Ref outside a user-started flow`);
    }
  }
  return out;
}

/** The grant API itself: refuses a non-prepared-here Ref before the network. */
function checkGrantAPI(src) {
  const out = [];
  const code = stripComments(src);
  if (/\bfunc\s+(reject|edit)\s*\(/.test(code)) out.push('IntentGrant still defines reject/edit');
  const m = code.match(/public static func sendDirect\([^)]*\)[^{]*\{([\s\S]*?)\n    \}/);
  if (!m) out.push('sendDirect not found');
  else {
    const body = m[1];
    const refuse = body.indexOf('mayDirect(ref)');
    const net = body.search(/\bcall\(/);
    if (refuse < 0) out.push('sendDirect does not consult mayDirect');
    else if (net >= 0 && net < refuse) out.push('sendDirect reaches the network before mayDirect');
  }
  if (!/guard ref\.preparedHere else \{ return deskHandoff \}/.test(code)) out.push('mayDirect does not refuse a Ref that was not prepared here');
  if (!/guard isDirectOrigin\(ref\.origin\)/.test(code)) out.push('mayDirect does not check the origin');
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

test('negative controls: each prohibited mutation is caught', () => {
  const cases = [
    ['Neuro/Features/X.swift', 'let o = await IntentGrant.reject(state.client, id)'],
    ['Neuro/Features/X.swift', 'let o = await IntentGrant.edit(state.client, ref, draft: d)'],
    ['Neuro/Features/X.swift', 'client.workCall("/api/prepared-actions/\\(id)/approve", body: [:])'],
    ['Neuro/Features/X.swift', 'client.workCall("/api/prepared-actions/\\(id)/reject", body: [:])'],
    ['Neuro/Features/X.swift', 'client.workCall("/api/prepared-actions/approval-code", body: b)'],
    ['Neuro/Features/X.swift', 'client.workCall("/api/actions/\\(id)/approve", body: [:])'],
    ['Neuro/Features/X.swift', 'client.workCall("/api/actions/bulk-reject", body: b)'],
    ['Neuro/Features/X.swift', 'if action.phoneMayApprove { }'],
    ['Neuro/Features/ActionScreens.swift', 'let ref = IntentGrant.Ref.preparedHere(a.raw, origin: "composer")'],
    ['Saim/SaimX.swift', 'let o = await IntentGrant.sendDirect(state.client, ref)'],
    // The intake exemption is file AND marker: without the marker it fails.
    [INTAKE_EXEMPT, 'neuroCall("/api/actions/\\(id)/\\(v)")'],
  ];
  for (const [rel, src] of cases) {
    assert.ok(checkIOS([{ rel, src }]).length > 0, `not caught: ${rel}: ${src}`);
  }
});

test('positive controls: the allowed shapes pass', () => {
  assert.deepEqual(checkIOS([
    { rel: 'Neuro/Features/WaitingOnScreen.swift', src: 'hereRefs[k] = IntentGrant.Ref.preparedHere(a, origin: "chase-button")\nlet o = await IntentGrant.sendDirect(state.client, ref)' },
    { rel: INTAKE_EXEMPT, src: '// ⚠ BRIEF 005 EXEMPTION — capture_todo intake\nneuroCall("/api/actions/\\(id)/\\(v)")' },
    { rel: 'Neuro/Features/ActionScreens.swift', src: 'let path = "/api/actions" + q\n/// IntentGrant.reject used to live here' },
  ]), []);
});

test('the grant-API check fails a sendDirect that skips the guard', () => {
  const bad = 'public static func sendDirect(_ client: NeuroAPIClient, _ ref: Ref) async -> Outcome {\n        let grant = await call(client, "/x", [:])\n    }\n';
  assert.ok(checkGrantAPI(bad).some((v) => /mayDirect/.test(v)));
});

// ── the real checkout ───────────────────────────────────────────────────────

test('every non-test iOS Swift source conforms to D-012 / D-013', { skip: !IOS && 'no nuero-ios checkout beside this repo' }, () => {
  const files = iosFiles();
  assert.ok(files.length > 50, `positive control: the walk found the app sources (${files.length})`);
  assert.ok(files.some((f) => f.rel.startsWith('Saim/')), 'positive control: the SAiM app is scanned too');
  assert.deepEqual(checkIOS(files), []);
});

test('IntentGrant refuses a queued draft before the network, and has no reject/edit', { skip: !IOS && 'no nuero-ios checkout beside this repo' }, () => {
  const src = fs.readFileSync(path.join(IOS, 'NeuroKit', 'Sources', 'NeuroKit', 'IntentGrant.swift'), 'utf8');
  assert.deepEqual(checkGrantAPI(src), []);
});

test('read-only hand-offs are said where the controls used to be', { skip: !IOS && 'no nuero-ios checkout beside this repo' }, () => {
  const read = (rel) => fs.readFileSync(path.join(IOS, rel), 'utf8');
  assert.match(read('Neuro/Features/ActionScreens.swift'), /static let deskHandoff = "Approve, reject or snooze this in NEURO on the desktop — Actions\."/);
  assert.match(read('Neuro/Features/PreparedActionCard.swift'), /static let deskHandoff = "Approve, reject or edit this in NEURO on the desktop — Actions\."/);
  const settings = read('Neuro/Features/SettingsAdminScreens.swift');
  assert.match(settings, /deskOnlyFlags: Set<String> = \["governed_execution", "governed_calendar"\]/, 'the send switches are read-only on the phone');
  assert.match(settings, /guard !Self\.deskOnlyFlags\.contains\(key\)/, 'and the toggle refuses them too');
  // Positive control: the intake the exemption is for is still there.
  assert.match(read(INTAKE_EXEMPT), /BRIEF 005 EXEMPTION/);
});

module.exports = { checkIOS, checkGrantAPI };
