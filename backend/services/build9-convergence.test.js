'use strict';

/**
 * Build 9 — surface convergence. Pure rules, a REAL render of the shared SAiM
 * surface, and source scans (with positive controls) for the retirements.
 *
 * The routing half — that the block actually reaches `/api/attention` and that
 * the buckets are no longer page-bound — is `routes/build9-surfaces-routing`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const summary = require('./approval-summary');
const presenter = require('./action-presenter');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── approval-summary (pure) ─────────────────────────────────────────────────

test('nothing waiting is silence, not a sentence', () => {
  const s = summary.summarise([{ action_type: 'reply_email', status: 'verified' }], { sendingEnabled: true });
  assert.equal(s.known, true);
  assert.equal(s.needsApproval, 0);
  assert.equal(s.needsReview, 0);
  assert.equal(s.say, null);
});

test('a waiting draft names its kind and WHERE, and never offers to approve here', () => {
  const s = summary.summarise([
    { action_type: 'reply_email', status: 'prepared', created_at: '2026-10-03T08:00:00Z' },
    { action_type: 'send_weekly_risk_report', status: 'prepared', created_at: '2026-10-02T08:00:00Z' },
  ], { sendingEnabled: true });
  assert.equal(s.needsApproval, 2);
  assert.equal(s.oldestAt, '2026-10-02T08:00:00Z');
  assert.match(s.say, /^2 drafted emails wait for your approval \(a reply and a weekly risk report\) — Actions, in NEURO on the desktop\.$/);
  assert.doesNotMatch(s.say, /switched off/, 'sending is on — no false warning');
  assert.doesNotMatch(s.say, /\b(tap|press|approve here|approve now)\b/i);
});

test('sending switched off is said, because approval is refused while it is', () => {
  const s = summary.summarise([{ action_type: 'chase_commitment', status: 'prepared' }], { sendingEnabled: false });
  assert.match(s.say, /Sending approved emails is switched off\./);
  assert.equal(s.sendingEnabled, false);
});

test('an uncertain send and a proven-unsent failure need review; a may-have-sent failure is history', () => {
  const s = summary.summarise([
    { action_type: 'reply_email', status: 'execution_uncertain' },
    { action_type: 'reply_email', status: 'failed', retry_safe: 1 },
    { action_type: 'reply_email', status: 'failed', retry_safe: 0 },
  ]);
  assert.equal(s.needsReview, 2);
  assert.equal(s.needsApproval, 0);
  assert.match(s.say, /^2 sends need checking — NEURO couldn't confirm they went\.$/);
});

test('an unreadable queue is UNKNOWN with null counts — never zeros', () => {
  const u = summary.unknown('disk gone');
  assert.equal(u.known, false);
  assert.equal(u.needsApproval, null);
  assert.equal(u.needsReview, null);
  assert.match(u.say, /Couldn't check/);
});

// ── the shared SAiM surface, rendered for real ──────────────────────────────

const SURFACE = path.join(ROOT, 'saim', 'shared-ui', 'AttentionSurface.jsx');
const FIELD_STUB = 'export default function Field() { return null; }\nexport const isPressing = () => false;\n';
let Surface;

test.before(async () => {
  global.window = global.window || {
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  const out = await esbuild.build({
    entryPoints: [SURFACE], bundle: true, write: false, format: 'cjs', platform: 'node',
    jsx: 'automatic', external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        b.onResolve({ filter: /(^|\/)Field(\.jsx)?$/ }, () => ({ path: 'field', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: FIELD_STUB, loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  Surface = mod.exports.default;
});

const base = (extra = {}) => ({
  context: { activity: 'steady', label: 'Steady', known: true, confidence: { level: 'high' } },
  primary: null, secondary: [], dropped: [], quiet: false, rationale: [], poolAvailable: true, gaps: [],
  ...extra,
});
const render = (data) => renderToString(React.createElement(Surface, { data }));
const block = (html) => {
  const m = html.match(/<p class="surface__approvals[^"]*"[^>]*>[\s\S]*?<\/p>/);
  return m ? m[0] : null;
};

test('SAiM renders the waiting sentence with a "Needs you" tag and NO button', () => {
  const approvals = summary.summarise([{ action_type: 'reply_email', status: 'prepared' }], { sendingEnabled: true });
  const html = render(base({ approvals }));
  const b = block(html);
  assert.ok(b, 'the approvals line is mounted — not another payload field with no reader');
  assert.match(b, /data-approvals="waiting"/);
  assert.match(b, /Needs you/);
  assert.match(b, /1 drafted email waits for your approval/);
  assert.doesNotMatch(b, /<button/, 'approval is desktop-only: a statement, never a control');
});

test('SAiM renders nothing when nothing waits (silence is the normal case)', () => {
  const approvals = summary.summarise([], { sendingEnabled: true });
  assert.equal(block(render(base({ approvals }))), null);
  // Positive control on the same render path: the line DOES mount with a say.
  assert.ok(block(render(base({ approvals: { known: true, say: 'x' } }))));
});

test('an unreadable queue renders muted and is never tagged "Needs you"', () => {
  const b = block(render(base({ approvals: summary.unknown('x') })));
  assert.ok(b);
  assert.match(b, /data-approvals="unknown"/);
  assert.doesNotMatch(b, /Needs you/);
  assert.match(b, /Couldn&#x27;t check|Couldn't check/);
});

// ── escalate_ticket: the card shows what the executor sends ────────────────

test('the escalate card shows reasonCode, neededBy and notes — the fields NOVA receives', () => {
  // The exact payload shape chat-tools stores (and executeAction sends).
  const d = presenter.describe({ type: 'escalate_ticket', payload: { ticketKey: 'NT-1', reasonCode: 'customer-impact', neededBy: '2026-10-06', notes: 'Billing down for 3 agencies' } });
  const byLabel = Object.fromEntries((d.fields || []).map((f) => [f.label, f.value]));
  assert.equal(byLabel.Ticket, 'NT-1');
  assert.equal(byLabel.Reason, 'customer-impact');
  assert.equal(byLabel['Needed by'], '2026-10-06');
  assert.equal(d.body, 'Billing down for 3 agencies');
  assert.deepEqual(d.blockers, []);
});

test('an escalation with no reason is blocked on the card, as NOVA would refuse it', () => {
  const d = presenter.describe({ type: 'escalate_ticket', payload: { ticketKey: 'NT-1' } });
  assert.ok(d.blockers.some((b) => /No reason/.test(b)));
});

// ── create_meeting is retired from chat ─────────────────────────────────────

// Build 11K: create_meeting is back — as a governed PREPARE (see
// build11-personal-world.test.js 36). What this file pinned still holds: it
// never queues on the legacy path, and an unresolved attendee prepares nothing.
test('create_meeting never queues on the legacy path, and an unresolved attendee prepares nothing', async () => {
  const tools = require('./chat-tools');
  assert.ok(tools.TOOLS.some((t) => t.name === 'create_meeting' && t.tier === 'queued'), 'offered only as a prepare');
  // Positive control: the list is real and still carries the other queued tools.
  assert.ok(tools.toolDefinitions().some((t) => t.name === 'escalate_ticket'));
  const engine = require('./suggestion-engine');
  const original = engine.queueAction;
  let queued = 0;
  engine.queueAction = () => { queued++; return 'x'; };
  try {
    const r = await tools.execute('create_meeting', { title: 's', start: '2026-10-06T10:00', attendees: ['Nobody By This Name'] });
    assert.equal(r.ok, false);
    assert.equal(r.invited, false);
    assert.match(r.error, /Nobody was invited/);
    assert.equal(queued, 0, 'no card that could only ever 410');
  } finally { engine.queueAction = original; }
});

// ── retirements and convergence, by source scan ─────────────────────────────

test('the 90-Day Plan surfaces are gone, and ?view=plan falls through to Now', () => {
  const app = read('frontend/src/App.jsx');
  assert.doesNotMatch(app, /NinetyDayPlan/);
  assert.doesNotMatch(app, /case 'plan'/);
  // Positive control: the default branch is still Now (AdhdPanel).
  assert.match(app, /default:[^\n]*AdhdPanel/);
  assert.equal(fs.existsSync(path.join(ROOT, 'frontend/src/components/NinetyDayPlan.jsx')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'frontend/src/components/MetricsRow.jsx')), false);
  const dash = read('frontend/src/components/Dashboard.jsx');
  assert.doesNotMatch(dash, /ninety-day-plan/);
  assert.doesNotMatch(read('frontend/src/components/TodoPanel.jsx'), /90-Day Plan \(/);
});

test('the Actions badge counts governed drafts as well as the older queue', () => {
  const side = read('frontend/src/components/Sidebar.jsx');
  assert.match(side, /\/api\/prepared-actions\?limit=1/);
  assert.match(side, /needsYou/);
  assert.match(side, /\/api\/actions'/, 'positive control: the legacy count is still part of it');
});

test('SAiM says where approval lives — no "for your approval" on a surface with no approval', () => {
  const chat = read('saim/app/src/views/Chat.jsx');
  assert.doesNotMatch(chat, /for your approval/);
  assert.doesNotMatch(chat, /create_meeting:/);
  assert.match(chat, /approve in NEURO/);
});

test('no SAiM shell reaches the approval routes (statement-only, every shell)', () => {
  for (const rel of ['saim/shared-ui/AttentionSurface.jsx', 'saim/app/src/views/Surface.jsx', 'saim/frontend/src/App.jsx']) {
    const src = read(rel);
    assert.doesNotMatch(src, /prepared-actions\/[^'"`]*approve|\/api\/actions\/[^'"`]*approve/, rel);
  }
});

// ── iOS, cross-repo (skips without a nuero-ios checkout beside this repo) ──

const IOS = path.resolve(ROOT, '..', 'nuero-ios');
const iosRead = (rel) => fs.readFileSync(path.join(IOS, rel), 'utf8');

test('iOS reads `pending` from /api/actions and never approves an outbound kind on the phone', (t) => {
  if (!fs.existsSync(path.join(IOS, 'NeuroKit'))) { t.skip('no nuero-ios checkout beside this repo'); return; }
  const model = iosRead('NeuroKit/Sources/NeuroKit/ActionPresentation.swift');
  assert.match(model, /public let pending: \[PendingAction\]\?/);
  const screen = iosRead('Neuro/Features/ActionScreens.swift');
  assert.match(screen, /phoneMayApprove/);
  assert.match(screen, /\/api\/prepared-actions\?limit=50/, 'the governed queue is visible on the phone');
});

test('iOS has no route to approve a governed action (read-only by construction)', (t) => {
  if (!fs.existsSync(path.join(IOS, 'NeuroKit'))) { t.skip('no nuero-ios checkout beside this repo'); return; }
  const actions = iosRead('NeuroKit/Sources/NeuroKit/Actions.swift');
  const prepared = iosRead('NeuroKit/Sources/NeuroKit/PreparedActions.swift');
  assert.doesNotMatch(actions + prepared, /prepared-actions\/[^"]*\/(approve|approval-challenge|edit)/);
  // Positive control: the legacy approve path is still where it was.
  assert.ok(actions.includes('"/api/actions/\\(id)/approve"'), 'legacy approve path still present');
});

test('SAiM iOS renders the same approvals sentence the web shells do', (t) => {
  if (!fs.existsSync(path.join(IOS, 'NeuroKit'))) { t.skip('no nuero-ios checkout beside this repo'); return; }
  assert.match(iosRead('NeuroKit/Sources/NeuroKit/Attention.swift'), /public let approvals: Approvals\?/);
  const view = iosRead('Saim/AttentionSurfaceView.swift');
  assert.match(view, /approvalsLine/);
  assert.match(view, /feed\.approvals/);
});
