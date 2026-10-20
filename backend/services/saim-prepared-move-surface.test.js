'use strict';

/**
 * SAiM's prepared-move approval surface (saim/app). The flow module is driven
 * with FAKE API answers; the view is the real component, bundled with esbuild
 * and rendered — a vite build proves it compiles, not that it says the right
 * thing. Lives in backend/services because only backend runs `node --test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const APP = path.resolve(__dirname, '..', '..', 'saim', 'app', 'src');
const NOW = Date.parse('2026-10-19T15:15:00Z');

// The draft, in the shape the live draft has (sections, a citation line per
// section, the decisions table with every cell still to agree).
const ART_MD = [
  '# T1 — Triage and escalation acceptance criteria (DRAFT prepared by SAiM)',
  '',
  '> Publish triage and escalation acceptance criteria for every team',
  '',
  '## Every escalation must carry',
  '- Current customer ask',
  '- Named owner',
  '  _from Projects/Support Improvement Plan/SIP - Support Teams Review (Original).md:1007_',
  '',
  '## What each team accepts',
  '| Team | Accepts when | Rejects with |',
  '|---|---|---|',
  ...['Customer Care', 'Production', 'Tier 2', 'Tier 3', 'Development', 'Data', 'Infra'].map((t) => `| ${t} | _to agree_ | _to agree_ |`),
].join('\n');

// ── A view as GET /api/prepared-moves/current returns it ─────────────────────
const VIEW = {
  ok: true, contract: 'prepared-move-view-v1', generatedAt: '2026-10-19T15:15:00Z',
  execution: { enabled: false, lockedByEnv: true, envVar: 'SAIM_PREPARED_MOVE_EXECUTION', flag: 'saim_prepared_move_execution' },
  withheldCount: 2,
  move: {
    title: 'Written criteria for what each team accepts',
    prepared: { headline: 'I’ve drafted triage and escalation acceptance criteria for Support Improvement Plan on Wednesday 21 Oct.', detail: 'It is arranged from 4 lines already in your notes, each one cited. Nothing in it has been agreed yet.' },
    whyItMatters: 'T1 has passed two dates with no draft in the vault.',
    confidence: 'moderate',
    unresolved: [{ what: 'What each team accepts is not agreed yet for 7 teams.', detail: ['Customer Care', 'Production', 'Tier 2', 'Tier 3', 'Development', 'Data', 'Infra'] }],
    options: [
      { id: 'approve', date: '2026-10-20', start: '10:25', end: '10:55', label: 'Tuesday 20 Oct 10:25–10:55', question: 'Reserve 30 minutes on Tuesday 20 Oct (10:25–10:55) and save the draft?', writes: ['Add “Triage and escalation criteria draft” to your calendar, Tuesday 20 Oct 10:25–10:55. Just you — nobody is invited.', 'Save the draft as a new note: Projects/Support Improvement Plan/SIP - T1 Acceptance Criteria (draft).md'] },
      { id: 'slot-1', date: '2026-10-20', start: '15:30', end: '16:00', label: 'Tuesday 20 Oct 15:30–16:00', question: 'Reserve 30 minutes on Tuesday 20 Oct (15:30–16:00) and save the draft?', writes: ['Add “Triage and escalation criteria draft” to your calendar, Tuesday 20 Oct 15:30–16:00. Just you — nobody is invited.', 'Save the draft as a new note: Projects/Support Improvement Plan/SIP - T1 Acceptance Criteria (draft).md'] },
    ],
    notOffered: [],
    contacts: 'Nobody else is contacted: no invite, email or message. The shared board and your reply to the meeting invite are left alone.',
    nothingElse: 'Nothing else changes: no email, invite, task, board card, goal or notification.',
    draft: { title: 'T1', path: 'Projects/Support Improvement Plan/SIP - T1 Acceptance Criteria (draft).md', markdown: ART_MD },
    // The page, exactly as the server parses it from the draft.
    artefact: require('./prepared-move-artefact').artefactFrom(ART_MD),
    evidence: [{ fact: '"every escalation must show the current customer ask"', kind: 'vault', observedAt: '2026-10-19T15:15:00Z', caveat: null }],
    why: { because: ['Its Planner date has passed (observed).'], goal: 'Arrive with T1 drafted.', doneWhen: 'Agreed in the meeting.', willNot: ['Email, message or invite anyone'] },
    forum: { title: 'Support Improvement Plan', start: '2026-10-21T16:00' },
    decidedAt: '2026-10-19T15:15:00Z', evidenceExpiresAt: '2026-10-19T17:15:00Z',
  },
};
const REQUEST = {
  ok: true, recordId: 'pm_0123456789abcdef0123', moveKey: 'saim-move:planner:X@2026-10-21', version: 1, option: 'approve', writeHash: 'h'.repeat(64),
  grantId: `ig_${'a'.repeat(32)}`, expiresAt: new Date(NOW + 60000).toISOString(), executionEnabled: false,
  confirmation: { question: VIEW.move.options[0].question, writes: VIEW.move.options[0].writes, contacts: VIEW.move.contacts, nothingElse: VIEW.move.nothingElse, off: 'Carrying out prepared moves is switched off, so confirming will not write anything.' },
};

/** A fake transport: records every call; answers from a table keyed "METHOD path". */
function fakeCall(answers) {
  const calls = [];
  const call = async (p, { method = 'GET', body } = {}) => {
    calls.push({ method, path: p, body });
    const a = answers[`${method} ${p}`];
    if (a instanceof Error) throw a;
    if (typeof a === 'function') return a(body);
    return a || { status: 404, body: { ok: false } };
  };
  call.calls = calls;
  return call;
}

let flow; let View;
test.before(async () => {
  flow = await import(pathToFileURL(path.join(APP, 'preparedMove.mjs')).href);
  const out = await esbuild.build({
    entryPoints: [path.join(APP, 'components', 'PreparedMove.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    plugins: [{
      name: 'stub',
      setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        b.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl = (p) => p; export const authHeaders = () => ({});', loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  View = mod.exports.PreparedMoveView;
});
const html = (state, extra = {}) => renderToString(React.createElement(View, { state, now: NOW, onChoose() {}, onAsk() {}, onConfirm() {}, onCancel() {}, onAgain() {}, ...extra }));
const text = (h) => h.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

// ── The read ─────────────────────────────────────────────────────────────────

test('the surface only READS on load — one GET, no request, no confirm', async () => {
  const call = fakeCall({ 'GET /api/prepared-moves/current': { status: 200, body: VIEW } });
  const s = await flow.load(call);
  assert.equal(s.kind, 'ready'); assert.equal(s.option, 'approve');
  assert.deepEqual(call.calls.map((c) => `${c.method} ${c.path}`), ['GET /api/prepared-moves/current']);
  // The container's effects only READ (with the bounded retry) — nothing else.
  const src = fs.readFileSync(path.join(APP, 'components', 'PreparedMove.jsx'), 'utf8');
  const effects = [...src.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\}, \[/g)].map((m) => m[1]);
  assert.ok(effects.some((e) => /loadWithRetry\(call/.test(e)));
  assert.ok(!effects.some((e) => /askToConfirm|confirm\(/.test(e)), 'nothing is requested or confirmed without a press');
});

test('no candidate, a withheld move, an unreachable or unreadable NEURO: the surface renders NOTHING', async () => {
  for (const ans of [
    { status: 200, body: { ...VIEW, move: null, withheldCount: 3 } },
    { status: 500, body: { ok: false, error: 'boom' } },
    { status: 403, body: { ok: false } },
    { status: 200, body: { ok: true, contract: 'something-else', move: VIEW.move } },
    new Error('network'),
  ]) {
    const s = await flow.load(fakeCall({ 'GET /api/prepared-moves/current': ans }));
    assert.equal(s.kind, 'hidden');
    assert.equal(html(s), '');
  }
  assert.equal(html({ kind: 'loading' }), '');
});

// ── Ready ────────────────────────────────────────────────────────────────────

/** The primary view: everything OUTSIDE a <details>, in order. */
const primary = (h) => text(h.replace(/<details[\s\S]*?<\/details>/g, ''));
/** Implementation words that must never reach Nick's surface. */
const VOCAB = /SAIM_|saim_prepared|PREPARED_MOVE|execution|lockedByEnv|env\b|environment|\bflag\b|switched off|locked off|\bdev\b|dev-|\bmobile\b|\bAPI\b|\/api\/|grantId|recordId|writeHash|budget/i;

test('ready: the prepared MOMENT — what SAiM made, what is still human, one choice, proof folded — in that order', async () => {
  const s = await flow.load(fakeCall({ 'GET /api/prepared-moves/current': { status: 200, body: VIEW } }));
  const h = html(s); const p = primary(h);
  const order = [
    'I’ve drafted triage and escalation acceptance criteria for Support Improvement Plan on Wednesday 21 Oct.',
    // Prepared: a FRAGMENT of the page — its title and first lines — not the whole draft.
    'Triage and escalation acceptance criteria',
    'Every escalation must carry from your notes Current customer ask Named owner',
    // Human judgement remaining, written on the page, counted from the draft's own table.
    'Still human 7 team decisions to agree',
    // The protected opportunity, then the real moment it serves.
    'Time to protect Tue 20 Oct · 10:25–10:55 30 minutes, just you',
    'The meeting Wed 21 Oct · 16:00 Support Improvement Plan',
    // One decision.
    'Protect the time and save the draft',
    'This is ready to review. Changes aren’t enabled here yet.',
  ];
  let at = -1;
  for (const piece of order) {
    const i = p.indexOf(piece, at + 1);
    assert.ok(i > at, `in order: "${piece}"\n— in: ${p}`);
    at = i;
  }
  assert.equal((h.match(/class="pmo__open"/g) || []).length, 15, 'the count on the page, and every one of the seven teams’ two decisions open inside the full draft');
  assert.match(h, /<summary>Read the full draft<\/summary>/);
  assert.doesNotMatch(p, /Customer Care|Accepts when/, 'the whole document does not land before the relationship does');
  assert.match(h, /<summary>Proof — how this was made<\/summary>/);
  assert.match(h, /<summary>Another time<\/summary>/);
  assert.ok(!/<details[^>]*open/.test(h), 'all folded');
  const t = text(h);
  assert.match(t, /T1 has passed two dates/); assert.match(t, /Nobody else is contacted/);
  assert.doesNotMatch(p, /Save the draft as a new note|to your calendar,/, 'the exact write list waits for the confirmation step');
  assert.doesNotMatch(h, /pmo__act--(done|partial)|>Done<|>Partly done<|read back|Saved in your notes|In your calendar/, 'no success state, and no object claims to be placed, before anything ran');
  assert.ok(!t.includes('Weekly risk'), 'no withheld item');
});

test('the objects only claim to be placed when the receipt says so', () => {
  const r = (calendar, note) => ({ kind: 'receipt', view: VIEW, option: 'approve', receipt: { complete: calendar === 'done' && note === 'done', plain: 'x', next: 'Nothing else will be done.', steps: [{ step: 'calendar', status: calendar }, { step: 'note', status: note }] } });
  let h = html(r('done', 'failed'));
  assert.match(h, /In your calendar · read back/); assert.doesNotMatch(h, /Saved in your notes/);
  h = html(r('failed', 'done'));
  assert.doesNotMatch(h, /In your calendar/); assert.match(h, /Saved in your notes · read back/);
  h = html(r('done', 'stopped'));
  assert.match(text(h), /Draft note ?: not attempted — SAiM’s actions were stopped/);
  assert.doesNotMatch(h, /Saved in your notes/);
  h = html({ ...r('done', 'done'), receipt: { ...r('done', 'done').receipt, target: 'sandbox', complete: true } });
  assert.match(text(h), /Done — practice run, nothing real was changed/);
  assert.match(h, /Practice run · placed and read back/); assert.match(h, /Practice run · saved and read back/);
  assert.doesNotMatch(h, /In your calendar|Saved in your notes/, 'a practice run never claims his real calendar or notes');
});

test('a budget refusal at confirm is the server’s own words, and nothing is claimed', () => {
  const say = 'Today’s allowance has no calendar blocks left (1 of 1 used). Nothing was written and your confirmation was not used.';
  const h = html({ kind: 'refused', view: VIEW, option: 'approve', message: say });
  assert.match(text(h), /Today’s allowance has no calendar blocks left \(1 of 1 used\)\. Nothing was written/);
  assert.doesNotMatch(h, /In your calendar|Saved in your notes|>Done</);
  // And before the click, a confirmation that would not fit says so.
  const req = { ...REQUEST, executionEnabled: true, authority: { canAct: true, stopped: false, deviceOpen: true, granted: true, fits: false, limit: 'minutes', say: 'This block is 45 minutes; today’s allowance has 30 minutes left.' } };
  assert.match(text(html({ kind: 'confirming', view: VIEW, option: 'approve', request: req })), /This block is 45 minutes; today’s allowance has 30 minutes left\./);
});

test('no implementation vocabulary anywhere on the surface — in any state — unless the debug view is asked for', async () => {
  const states = [
    await flow.load(fakeCall({ 'GET /api/prepared-moves/current': { status: 200, body: VIEW } })),
    { kind: 'confirming', view: VIEW, option: 'approve', request: REQUEST },
    { kind: 'locked', view: VIEW, option: 'approve', serverError: 'Carrying out prepared moves is switched off (saim_prepared_move_execution) — nothing was written and your confirmation was not used.' },
    { kind: 'hidden', why: 'nothing-prepared', reason: 'not-ready-in-time' },
  ];
  for (const s of states) {
    const t = text(html(s));
    assert.doesNotMatch(t, VOCAB, `${s.kind}: ${t.slice(0, 200)}`);
  }
  // The developer view carries the exact lock state.
  const dev = text(html(states[0], { debug: true }));
  assert.match(dev, /"lockedByEnv": true/); assert.match(dev, /SAIM_PREPARED_MOVE_EXECUTION/);
  assert.match(text(html(states[3], { debug: true })), /prepared move: none \(nothing-prepared — not-ready-in-time\)/);
  // And the app header no longer prints "mobile" or the build id outside it.
  const app = fs.readFileSync(path.join(APP, 'App.jsx'), 'utf8');
  assert.match(app, /\{DEBUG_VIEW && <span className="app__sub">mobile<\/span>\}/);
  assert.match(app, /\{DEBUG_VIEW && runtime\.buildLabel && <span className="app__build">/);
});

test('ready with no confirmable time: says it cannot offer one, offers no button', () => {
  const v = { ...VIEW, move: { ...VIEW.move, options: [], notOffered: [{ id: 'approve', label: 'Tuesday 20 Oct 10:25–10:55', why: 'I couldn’t confirm 10:25–10:55 is still free (the calendar has not synced in the last 15 minutes)' }] } };
  const t = text(html({ kind: 'ready', view: v, option: null }));
  assert.match(t, /I can’t offer a time for this right now\. Tuesday 20 Oct 10:25–10:55: I couldn’t confirm/);
  assert.doesNotMatch(t, /Ask to confirm|Saying yes does/);
});

// ── Asking, confirming (locked), refusals ────────────────────────────────────

test('asking to confirm sends ONLY the option and session; the server’s exact confirmation is shown, Confirm locked off', async () => {
  const call = fakeCall({ 'POST /api/prepared-moves/request': () => ({ status: 200, body: REQUEST }) });
  const s = await flow.askToConfirm(call, { view: VIEW, option: 'approve', sessionId: 'saim_abcdefghijklmnopqrst' });
  assert.deepEqual(call.calls, [{ method: 'POST', path: '/api/prepared-moves/request', body: { option: 'approve', sessionId: 'saim_abcdefghijklmnopqrst' } }]);
  assert.equal(s.kind, 'confirming');
  const h = html(s); const t = text(h);
  assert.match(t, /Reserve 30 minutes on Tuesday 20 Oct \(10:25–10:55\) and save the draft\?/);
  assert.match(t, /This is ready to review\. Changes aren’t enabled here yet\./);
  assert.match(h, /<button[^>]*disabled=""[^>]*>Confirm<\/button>/, 'the confirm button is disabled while changes are not enabled');
});

test('a refused or failed request says nothing changed and offers to look again', async () => {
  for (const [ans, re] of [
    [{ status: 409, body: { ok: false, error: '12:00–12:30 is no longer free' } }, /12:00–12:30 is no longer free Nothing was changed\./],
    [new Error('network'), /couldn’t reach NEURO .* Nothing was changed\./],
  ]) {
    const s = await flow.askToConfirm(fakeCall({ 'POST /api/prepared-moves/request': ans }), { view: VIEW, option: 'approve', sessionId: 'saim_x0000000000' });
    assert.equal(s.kind, 'refused');
    const t = text(html(s)); assert.match(t, re); assert.match(t, /Look again/);
  }
});

test('confirm while locked (switch flipped off after asking) shows the server’s refusal — never a success', async () => {
  const call = fakeCall({ 'POST /api/prepared-moves/confirm': { status: 409, body: { ok: false, disabled: true, error: 'Carrying out prepared moves is switched off (saim_prepared_move_execution) — nothing was written and your confirmation was not used.' } } });
  const s = await flow.confirm(call, { view: VIEW, option: 'approve', request: { ...REQUEST, executionEnabled: true }, now: NOW });
  assert.deepEqual(call.calls[0].body, { recordId: REQUEST.recordId, version: 1, option: 'approve', grantId: REQUEST.grantId }, 'only the stored identifiers are sent');
  assert.equal(s.kind, 'locked');
  const h = html(s); const t = text(h);
  assert.match(t, /Nothing was changed\. This is ready to review\. Changes aren’t enabled here yet\./);
  assert.equal(s.serverError.includes('saim_prepared_move_execution'), true, 'the exact refusal is kept for the debug view');
  assert.doesNotMatch(h, /pm__act--(done|partial)|>Done<|>Partly done</);
});

test('an expired confirmation is not sent at all; a server-side expiry or change asks again', async () => {
  const call = fakeCall({});
  const s = await flow.confirm(call, { view: VIEW, option: 'approve', request: { ...REQUEST, executionEnabled: true, expiresAt: new Date(NOW - 1).toISOString() }, now: NOW });
  assert.equal(call.calls.length, 0, 'never sent');
  assert.equal(s.kind, 'needs-again'); assert.match(text(html(s)), /expired before it was used\. Nothing was changed\. Look again/);
  // The open confirmation shows its own expiry and swaps Confirm for Ask again.
  const open = html({ kind: 'confirming', view: VIEW, option: 'approve', request: { ...REQUEST, executionEnabled: true, expiresAt: new Date(NOW - 1).toISOString() } });
  assert.match(text(open), /This confirmation has expired\. Nothing was changed\. Ask again/);
  assert.doesNotMatch(open, />Confirm</);
  for (const error of ['This action needs confirming again. (it expired)', 'That confirmation has already been used.', 'this move has changed since it was shown — it needs confirming again']) {
    const r = await flow.confirm(fakeCall({ 'POST /api/prepared-moves/confirm': { status: 409, body: { ok: false, error } } }), { view: VIEW, option: 'approve', request: { ...REQUEST, executionEnabled: true }, now: NOW });
    assert.equal(r.kind, 'needs-again', error);
  }
});

test('a lost connection while confirming is UNKNOWN — never success, never "nothing happened"', async () => {
  const s = await flow.confirm(fakeCall({ 'POST /api/prepared-moves/confirm': new Error('reset') }), { view: VIEW, option: 'approve', request: { ...REQUEST, executionEnabled: true }, now: NOW });
  assert.equal(s.kind, 'unknown');
  assert.match(text(html(s)), /can’t tell whether anything was written\. Asking again is safe/);
});

// ── Receipts from the existing contract ──────────────────────────────────────

test('a complete receipt is rendered from the receipt itself', async () => {
  const receipt = { recordId: REQUEST.recordId, complete: true, plain: 'Both are in place and checked.', next: 'Nothing else will be done.', contacted: [],
    steps: [
      { step: 'calendar', status: 'done', target: '2026-10-20 10:25–10:55 “Triage and escalation criteria draft”', verified: [] },
      { step: 'note', status: 'done', target: 'Projects/Support Improvement Plan/SIP - T1 Acceptance Criteria (draft).md', unconfirmed: 'Saved and read back on the Pi. Reaching your other devices depends on Obsidian Sync, which I haven’t checked.' },
    ] };
  const s = await flow.confirm(fakeCall({ 'POST /api/prepared-moves/confirm': { status: 200, body: { ok: true, receipt } } }), { view: VIEW, option: 'approve', request: { ...REQUEST, executionEnabled: true }, now: NOW });
  const t = text(html(s));
  assert.match(t, /Done Both are in place and checked\. Calendar block : done and read back/);
  assert.match(t, /Draft note : done and read back .* Obsidian Sync, which I haven’t checked\./);
  assert.match(t, /Nothing else will be done\./);
  assert.doesNotMatch(t, /Ask again to finish it/);
});

test('a partial receipt says exactly what did and did not happen, and offers only a retry of what is missing', () => {
  const receipt = { complete: false, plain: 'The calendar block may not have been saved: timed out. The note is saved and stays.', next: 'Confirm again to retry only what is missing — nothing that worked is repeated or undone.',
    steps: [{ step: 'calendar', status: 'failed', provablyNotApplied: false, target: 'x', error: 'timed out' }, { step: 'note', status: 'done', target: 'y' }] };
  const t = text(html({ kind: 'receipt', view: VIEW, option: 'approve', receipt }));
  assert.match(t, /Partly done The calendar block may not have been saved: timed out\. The note is saved and stays\./);
  assert.match(t, /Calendar block : may not have been saved/);
  assert.match(t, /Ask again to finish it/);
  assert.doesNotMatch(t, /^Done\b/);
  const removed = text(html({ kind: 'receipt', view: VIEW, option: 'approve', receipt: { complete: false, plain: 'The calendar block was made earlier and has since been removed — I haven’t recreated it. The note is saved and stays.', next: 'Nothing else will be done.', steps: [{ step: 'calendar', status: 'removed-since' }, { step: 'note', status: 'already-done' }] } }));
  assert.match(removed, /made earlier and since removed — not recreated/);
  assert.doesNotMatch(removed, /Ask again to finish it/);
});

test('the Surface passes the move into SAiM’s presence, and the copy about the move is never hard-coded', () => {
  const surface = fs.readFileSync(path.join(APP, 'views', 'Surface.jsx'), 'utf8');
  assert.match(surface, /prepared=\{<PreparedMove onMoment=\{setPreparedMoment\} \/>\}/);
  const comp = fs.readFileSync(path.join(APP, 'components', 'PreparedMove.jsx'), 'utf8') + fs.readFileSync(path.join(APP, 'preparedMove.mjs'), 'utf8');
  assert.doesNotMatch(comp, /T1|Triage|Support Improvement|Mel\b|acceptance criteria/i, 'no move-specific words in the client');
  assert.doesNotMatch(comp, /localStorage|sessionStorage|indexedDB/, 'nothing about the move is kept on the device');
});

// ── Off duty / on leave: held ────────────────────────────────────────────────

test('off duty: the prepared page, held, with one quiet sentence — no time, question, change list, button, confirmation or execution words', async () => {
  const SAY = 'I’ve prepared this for your next working morning.';
  const { contacts, nothingElse, notOffered, forum, evidenceExpiresAt, ...rest } = VIEW.move;
  const HELD = { ...VIEW, held: { reason: 'off-duty', say: SAY }, move: { ...rest, held: true, prepared: { headline: SAY, detail: null }, options: [] } };
  const s = await flow.load(fakeCall({ 'GET /api/prepared-moves/current': { status: 200, body: HELD } }));
  const h = html(s);
  const p = primary(h).trim();
  assert.ok(p.startsWith(SAY), 'the held sentence first');
  assert.match(p, /Triage and escalation acceptance criteria/, 'the artefact itself is shown, held');
  assert.match(p, /Still human 7 team decisions to agree/, 'what is still owed by people, on the page');
  assert.match(h, /<summary>Read the full draft<\/summary>/); assert.match(h, /<summary>What I based it on<\/summary>/);
  assert.ok(!/<details[^>]*open/.test(h), 'folded');
  assert.ok(!/<button/.test(h), 'no button at all');
  assert.doesNotMatch(h, /pmo__path|pmo__node|pmo__choice|pmo__aside/, 'no time, no meeting, no choice');
  const t = text(h);
  assert.doesNotMatch(t, /Reserve|Ask to confirm|Protect the time|Confirm|Changes aren|enabled|minutes on|calendar,|Save the draft as|One choice|Just you|Time to protect|The meeting|allowance|locked|unlock|won’t|invite/i);
  assert.match(t, /Customer Care to agree to agree/, 'the whole draft is there, folded inside the page');
  assert.match(t, /every escalation must show the current customer ask/, 'and the evidence');
  assert.doesNotMatch(t, VOCAB);
});
