'use strict';

/**
 * Small friction removals (7 Nov 2026, Nick: his failure mode is starting and
 * finishing things, so every step he has to remember is a step that does not
 * happen). Pinned here:
 *   - Sidebar badges for the queues that wait on him (Drafts, Tasks triage,
 *     People "1-2-1s to book", Overtime), honest like the others.
 *   - Closing a task block is ONE press (no typed reason); dropping goes straight
 *     through with the existing Undo instead of a second confirmation.
 *   - "Make this ready" lands on the Confirm step (confirmIfReady) — but never
 *     auto-asks for an interview's "save it unfinished" or a question.
 *   - SAiM's "It’s over" chip posts the existing meeting/finished route with Undo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

async function bundle(entry) {
  const esbuild = require('esbuild');
  const out = await esbuild.build({ entryPoints: [path.join(ROOT, entry)], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], loader: { '.css': 'empty' }, logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

// ── 1. Sidebar badges ────────────────────────────────────────────────────────

test('sidebar: Drafts, Tasks, People and Overtime carry badges read from existing routes', () => {
  const src = read('frontend/src/components/Sidebar.jsx');
  for (const route of ['/api/prepared-moves/drafts', '/api/todos', '/api/overtime-claims?status=submitted']) assert.ok(src.includes(`'${route}'`), route);
  // Drafts folded into "Waiting on your press" (7 Nov 2026): its count rides the Actions badge.
  assert.match(src, /item\.id === 'actions' && \(actionsCount \+ draftsCount\) > 0/);
  for (const id of ['todos', 'people', 'overtime']) assert.match(src, new RegExp(`\\b${id}: \\{ n: `), id);
  // People reads the SAME filter the People board's "1-2-1s to book" list uses, off the response already fetched.
  assert.match(src, /a\.actionType === 'create_calendar_event' && a\.origin === '1to1-book'/);
  assert.match(read('frontend/src/components/PeopleBoard.jsx'), /a\.actionType === 'create_calendar_event' && a\.origin === '1to1-book'/, 'the board still uses that filter');
  // Honesty: only a good read sets a number (a failed read keeps the last one, never 0).
  assert.match(src, /if \(confirm\) setDraftsCount/);
  assert.match(src, /typeof data\.triageCount === 'number'\) setTriageCount/);
  assert.match(src, /if \(!data \|\| !data\.ok \|\| !Array\.isArray\(data\.claims\)\) return;/);
  // Load stays light: the heavy reads only every fifth minute.
  assert.match(src, /const slow = tick % 5 === 0;/);
  // The items added on 7 Nov 2026 are still in the primary list.
  assert.match(src, /id: 'could-do'/); assert.match(src, /id: 'neuro-did'/);
});

// ── 2. Task blocks ───────────────────────────────────────────────────────────

test('task blocks: close is one press with a default reason; drop goes straight through with Undo', () => {
  const src = read('frontend/src/components/TaskBlocks.jsx');
  assert.doesNotMatch(src, /Why\? \(required\)/, 'no typed reason');
  assert.doesNotMatch(src, /Yes, drop it/, 'no second confirmation on drop');
  assert.doesNotMatch(src, /confirmingDrop|setReleasing/);
  assert.match(src, /onClick=\{\(\) => onRelease\(block, DEFAULT_RELEASE_REASON\)\}/);
  assert.match(src, /onClick=\{\(\) => onDrop\(block\)\}/);
  // The backend still requires a reason on the record — the default is a real one.
  assert.match(src, /export const DEFAULT_RELEASE_REASON = '.{10,}';/);
  // Undo for a drop is still the restore route.
  assert.match(src, /\/api\/task-blocks\/\$\{lastDropped\.blockId\}\/restore/);
  assert.match(src, /<button className="btn btn-sm btn-primary" onClick=\{undoDrop\}>Undo<\/button>/);
});

// ── 3. Make this ready → Confirm ─────────────────────────────────────────────

test('confirmIfReady: a ready move with an option is asked for in the same press; anything that still needs Nick is not', async () => {
  const { confirmIfReady } = await bundle('saim/app/src/components/PreparedMove.jsx');
  const asked = [];
  const ask = async (call, args) => { asked.push(args); return { kind: 'confirming', view: args.view, option: args.option, request: { grantId: 'g' } }; };
  const view = (move) => ({ move: { version: 2, recordId: 'r1', options: [{ id: 'approve' }], ...move } });
  const r = await confirmIfReady(null, { kind: 'ready', view: view({}), option: 'approve' }, 'saim_s', ask);
  assert.equal(r.kind, 'confirming'); assert.equal(asked.length, 1); assert.equal(asked[0].option, 'approve'); assert.equal(asked[0].sessionId, 'saim_s');
  // Not asked: an open interview (its first option would be "save it unfinished"), a question, a hold, nothing to choose, not ready.
  const cases = [
    { kind: 'ready', view: view({ interview: { total: 2, open: 2, next: { id: 'q1', question: '?' }, questions: [{ id: 'q1' }, { id: 'q2' }] } }), option: 'unfinished' },
    { kind: 'ready', view: view({ plan: 'ask' }), option: 'approve' },
    { kind: 'ready', view: view({ held: true }), option: 'approve' },
    { kind: 'ready', view: view({ options: [] }), option: null },
    { kind: 'note', message: 'x' },
  ];
  for (const s of cases) assert.equal(await confirmIfReady(null, s, 'saim_s', ask), s);
  assert.equal(asked.length, 1, 'none of those asked for a confirmation');
});

test('make this ready: the press goes on to the Confirm step for THAT record and draws it in place', () => {
  const mr = read('saim/app/src/components/MakeReady.jsx');
  assert.ok(mr.includes("lazy(() => import('./PromiseSave.jsx'))"), 'the confirm card loads only when reached');
  assert.match(mr, /confirmIfReady\(call, await load\(call, \{ recordId: r\.recordId \}\), sessionId\)/);
  assert.match(mr, /<PromiseSave recordId=\{confirmAt\.recordId\} call=\{call\} drafts initial=\{confirmAt\.initial\} \/>/);
  const pm = read('saim/app/src/components/PreparedMove.jsx');
  assert.match(pm, /const next = await confirmIfReady\(call, made, sessionId\);/);
  // Still only on a press: no effect requests a confirmation.
  const effects = [...pm.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\}, \[/g)].map((m) => m[1]);
  assert.ok(!effects.some((e) => /askToConfirm|confirmIfReady|confirm\(/.test(e)));
});

// ── 4. "It’s over" on SAiM ───────────────────────────────────────────────────

test('MeetingOverChip: posts meeting/finished with the payload key, offers Undo via resume, never on the kiosk', async () => {
  const React = require('react'); const { renderToString } = require('react-dom/server');
  const m = await bundle('saim/shared-ui/MeetingOverChip.jsx');
  const V = m.MeetingOverChipView;
  const h = (p) => renderToString(React.createElement(V, { onOver() {}, onUndo() {}, ...p }));
  assert.equal(h({ meeting: null }), '');
  assert.equal(h({ meeting: { key: 'k1', subject: 'Standup' }, readOnly: true }), '', 'kiosk: nothing');
  assert.match(h({ meeting: { key: 'k1', subject: 'Standup' } }), />It’s over</);
  const done = h({ done: { key: 'k1', line: m.overLine({ subject: 'Standup ' }) } });
  assert.match(done, /“Standup” marked over/); assert.match(done, />Undo</);
  assert.match(m.overLine({ subject: 'X' }), /Nothing was changed in anyone’s calendar\./);

  const calls = [];
  const call = async (p, o) => { calls.push({ p, ...o }); return { status: 200, body: { ok: true } }; };
  assert.equal((await m.postMeeting(call, 'finished', 'k1')).ok, true);
  assert.equal((await m.postMeeting(call, 'resume', 'k1')).ok, true);
  assert.deepEqual(calls, [
    { p: '/api/attention/meeting/finished', method: 'POST', body: { key: 'k1' } },
    { p: '/api/attention/meeting/resume', method: 'POST', body: { key: 'k1' } },
  ]);
  // A refusal is shown, never read as success.
  const stale = await m.postMeeting(async () => ({ status: 409, body: { ok: false, error: 'stale key' } }), 'finished', 'old');
  assert.deepEqual(stale, { ok: false, error: 'stale key' });
  const down = await m.postMeeting(async () => { throw new Error('net'); }, 'finished', 'k1');
  assert.equal(down.ok, false);
});
