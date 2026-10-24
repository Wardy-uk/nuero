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
 * against the real tree; the real-tree negative controls (a prohibited call
 * inserted into a real file) are recorded in the Brief 005 returns.
 *
 * Rework (24 Oct 2026):
 *  - The Tasks "Spotted" capture_todo intake no longer touches `/api/actions/*`
 *    at all: it uses the SERVER-ENFORCED `/api/todos/suggestions/:id/{add,dismiss}`
 *    and `/suggestions/batch`, which refuse any non-capture_todo. So NO iOS file
 *    may call an `/api/actions/…` decide route — there is no exemption left.
 *  - Discard is the one reject the phone makes: `IntentGrant.discardHere`,
 *    behind the same `preparedHere` gate as Send, called only from the flows
 *    that prepared the draft.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { findIOSCheckout } = require('./ios-checkout');

const IOS = findIOSCheckout();

// Files that run a user-started flow which prepares, then sends or discards, its own draft.
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
const GRANT = 'NeuroKit/Sources/NeuroKit/IntentGrant.swift';
const DEFINITIONS = new Set([GRANT, 'NeuroKit/Sources/NeuroKit/PersonalInbox.swift']);
const INTAKE = 'Neuro/Features/TasksFullScreen.swift';

/** Comment lines out: a comment naming a route is documentation, not a call. */
function stripComments(src) {
  return src.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

const PROHIBITED = [
  [/IntentGrant\.(reject|edit)\s*\(/, 'rejects or edits a governed draft through IntentGrant'],
  [/prepared-actions\/[^"\n]*\/(approve|edit)\b/, 'calls a prepared-action approve/edit route'],
  [/approval-challenge/, 'asks for an approval challenge'],
  [/prepared-actions\/approval-code/, 'sets the approval code'],
  [/phoneMayApprove/, 'gates a phone approval (the phone approves nothing)'],
  [/\bcase\s+(approveAction|rejectAction)\b/, 'declares a queue approve/reject action'],
];
const REJECT_ROUTE = /prepared-actions\/[^"\n]*\/reject\b/g;

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
    // A prepared-action REJECT exists in exactly one place: discardHere, inside
    // IntentGrant (checkGrantAPI proves it is gated). Anywhere else it is a
    // reject of a queued draft.
    const rejects = (src.match(REJECT_ROUTE) || []).length;
    if (rejects && !(rel === GRANT && rejects === 1)) out.push(`${rel} calls the prepared-action reject route`);
    // The older queue's per-item routes (approve/reject/snooze/batch) and bulk
    // reject: NO iOS file. The Spotted intake has its own server-enforced path.
    if (/"\/api\/actions\/|\/api\/actions\/batch|bulk-reject/.test(src)) {
      out.push(`${rel} answers an item on the older queue (/api/actions/…)`);
    }
    // D-013: only the allowlisted flows may build a sendable Ref, send, or discard.
    const sends = /\b(sendDirect|discardHere)\s*\(/.test(src) && !DEFINITIONS.has(rel);
    const builds = /\.preparedHere\s*\(/.test(src) && !DEFINITIONS.has(rel);
    if ((sends || builds) && !DIRECT_FLOWS.has(rel)) {
      out.push(`${rel} sends, discards or builds a sendable Ref outside a user-started flow`);
    }
  }
  return out;
}

function fnBody(code, name) {
  const m = code.match(new RegExp(`public static func ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n    \\}`));
  return m ? m[1] : null;
}

/** The grant API itself: refuses a non-prepared-here Ref before the network. */
function checkGrantAPI(src) {
  const out = [];
  const code = stripComments(src);
  if (/\bfunc\s+(reject|edit)\s*\(/.test(code)) out.push('IntentGrant still defines reject/edit');
  for (const [fn, gate] of [['sendDirect', 'mayDirect'], ['discardHere', 'mayDiscard']]) {
    const body = fnBody(code, fn);
    if (body == null) { out.push(`${fn} not found`); continue; }
    const refuse = body.indexOf(`${gate}(ref)`);
    const net = body.search(/\bcall\(/);
    if (refuse < 0) out.push(`${fn} does not consult ${gate}`);
    else if (net >= 0 && net < refuse) out.push(`${fn} reaches the network before ${gate}`);
  }
  if (!/guard ref\.preparedHere else \{ return deskHandoff \}/.test(code)) out.push('mayDirect does not refuse a Ref that was not prepared here');
  if (!/guard isDirectOrigin\(ref\.origin\)/.test(code)) out.push('mayDirect does not check the origin');
  const md = fnBody(code, 'mayDiscard');
  if (md == null || !/guard ref\.preparedHere else/.test(md) || !/return mayDirect\(ref\)/.test(md)) {
    out.push('mayDiscard is not the preparedHere + mayDirect gate');
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
    ['Neuro/Features/ActionScreens.swift', 'let o = await IntentGrant.discardHere(state.client, ref)'],
    ['Saim/SaimX.swift', 'let o = await IntentGrant.sendDirect(state.client, ref)'],
    // A second reject route inside IntentGrant is not discardHere's one.
    [GRANT, 'call(c, "/api/prepared-actions/\\(a)/reject")\ncall(c, "/api/prepared-actions/\\(b)/reject")'],
    // The Tasks screen has NO exemption on /api/actions any more — even marked.
    [INTAKE, '// BRIEF 005 EXEMPTION\nneuroCall("/api/actions/\\(id)/\\(v)")'],
  ];
  for (const [rel, src] of cases) {
    assert.ok(checkIOS([{ rel, src }]).length > 0, `not caught: ${rel}: ${src}`);
  }
});

test('positive controls: the allowed shapes pass', () => {
  assert.deepEqual(checkIOS([
    { rel: 'Neuro/Features/WaitingOnScreen.swift', src: 'hereRefs[k] = IntentGrant.Ref.preparedHere(a, origin: "chase-button")\nlet o = await IntentGrant.sendDirect(state.client, ref)\nlet d = await IntentGrant.discardHere(state.client, ref)' },
    { rel: INTAKE, src: 'neuroCall("/api/todos/suggestions/\\(id)/\\(v)")\nneuroCall("/api/todos/suggestions/batch")' },
    { rel: GRANT, src: 'let r = await call(client, "/api/prepared-actions/\\(escape(ref.actionId))/reject", [:])' },
    { rel: 'Neuro/Features/ActionScreens.swift', src: 'let path = "/api/actions" + q\n/// IntentGrant.reject used to live here' },
  ]), []);
});

test('the grant-API check fails a sendDirect or discardHere that skips the guard', () => {
  const bad = 'public static func sendDirect(_ client: NeuroAPIClient, _ ref: Ref) async -> Outcome {\n        let grant = await call(client, "/x", [:])\n    }\n'
    + 'public static func discardHere(_ client: NeuroAPIClient, _ ref: Ref) async -> Outcome {\n        let r = await call(client, "/api/prepared-actions/x/reject", [:])\n    }\n';
  const v = checkGrantAPI(bad);
  assert.ok(v.some((x) => /sendDirect does not consult mayDirect/.test(x)));
  assert.ok(v.some((x) => /discardHere does not consult mayDiscard/.test(x)));
  assert.ok(v.some((x) => /mayDiscard is not/.test(x)));
});

// ── the real checkout ───────────────────────────────────────────────────────

test('every non-test iOS Swift source conforms to D-012 / D-013', { skip: !IOS && 'no nuero-ios checkout beside this repo' }, () => {
  const files = iosFiles();
  assert.ok(files.length > 50, `positive control: the walk found the app sources (${files.length})`);
  assert.ok(files.some((f) => f.rel.startsWith('Saim/')), 'positive control: the SAiM app is scanned too');
  assert.deepEqual(checkIOS(files), []);
});

test('IntentGrant refuses a queued draft before the network (send AND discard), and has no reject/edit', { skip: !IOS && 'no nuero-ios checkout beside this repo' }, () => {
  const src = fs.readFileSync(path.join(IOS, 'NeuroKit', 'Sources', 'NeuroKit', 'IntentGrant.swift'), 'utf8');
  assert.deepEqual(checkGrantAPI(src), []);
});

test('read-only hand-offs are said where the controls used to be', { skip: !IOS && 'no nuero-ios checkout beside this repo' }, () => {
  const read = (rel) => fs.readFileSync(path.join(IOS, rel), 'utf8');
  assert.match(read('Neuro/Features/ActionScreens.swift'), /static let deskHandoff = "Approve, reject or snooze this in NEURO on the desktop — Actions\."/);
  const card = read('Neuro/Features/PreparedActionCard.swift');
  assert.match(card, /static let deskHandoff = "Approve, reject or edit this in NEURO on the desktop — Actions\."/);
  // Discard on the card appears only through the flow's own closure.
  assert.match(card, /var onDiscardHere: \(\(\) async -> Void\)\? = nil/);
  const settings = read('Neuro/Features/SettingsAdminScreens.swift');
  assert.match(settings, /deskOnlyFlags: Set<String> = \["governed_execution", "governed_calendar"\]/, 'the send switches are read-only on the phone');
  assert.match(settings, /guard !Self\.deskOnlyFlags\.contains\(key\)/, 'and the toggle refuses them too');
  // The Spotted intake goes through the server-enforced capture_todo path.
  const tasks = read(INTAKE);
  assert.ok(tasks.includes('"/api/todos/suggestions/\\(TaskMirror.esc(id))/\\(v)"'), 'per-item intake path');
  assert.ok(tasks.includes('"/api/todos/suggestions/batch"'), 'batch intake path');
});

module.exports = { checkIOS, checkGrantAPI };
