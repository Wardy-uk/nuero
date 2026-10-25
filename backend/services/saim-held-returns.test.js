'use strict';

/**
 * D-023 (25 Oct 2026) — the held-row suffix. The desktop rendered every held row
 * as "<kind> — <why> · back after this": "after this" was the policy's bare
 * `returns` when nothing was being guarded, and the client prefixed "back".
 *
 * Now the policy composes `returnsSay` per held item, by reason, and the row
 * renders it verbatim:
 *   off, not a working day   → "shown on your next working day"
 *   off, a working day       → "shown when you’re working again"
 *   meeting                  → "shown when this meeting ends[ at HH:MM]"
 *   focus                    → "shown when your focus session ends[ at HH:MM]"
 *   waiting, block guarded   → "shown when this block ends[ at HH:MM]"
 *   waiting, nothing guarded → "waiting its turn"
 * Category-only: it says WHEN, never what the item is (D-022).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-d023-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const ROOT = path.resolve(__dirname, '..', '..');
const NC = require('./neuro-candidates');
const POL = require('../../saim/policy/attention-policy.cjs');
const { heldReturnsSay } = POL;

const OLD = /back after this|\bback (after|when|at)\b/i;
const at = (h, m, d = 14) => new Date(2026, 9, d, h, m).getTime();
const iso = (h, m, d = 14) => new Date(at(h, m, d)).toISOString();
const work = { value: 'work', basis: 'classified', why: 'x' };
const cal = (sh, sm, eh, em, subject) => ({
  eventId: subject, source: 'graph', subject,
  start: `2026-10-14T${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}:00.0000000`,
  end: `2026-10-14T${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}:00.0000000`,
  startAt: iso(sh, sm), endAt: iso(eh, em), allDay: false, showAs: 'busy', attendeesOther: true, sphere: work,
});
const WW_WORK = { hours: '08:00-18:00', todayIsWorking: true, todayStart: iso(8, 0), todayEnd: iso(18, 0), nextStart: iso(8, 0, 15) };
const WW_OFF = { hours: '08:00-18:00', todayIsWorking: false, todayStart: null, todayEnd: null, nextStart: iso(8, 0, 19) };

/** A real candidates → policy run. `dropped` are gate holds (with heldFor); `block`/`calendar` set the guard. */
function decideWith({ now = at(17, 11), dropped = [], block = false, calendar = [], ww = WW_WORK, activity = 'steady', onDuty = true, secondary = [], session = null } = {}) {
  const payload = {
    poolAvailable: true,
    context: { activity, duty: { onDuty } },
    work: { atDesk: true, deskKnown: true },
    primary: null, secondary, dropped,
    utterances: [], approvals: { known: true, needsApproval: 0, needsReview: 0 },
    situation: { sections: {} }, home: { needsYou: [], exceptions: [] },
  };
  const rows = block ? [{ blockId: 115, dateKey: '2026-10-14', startTime: '16:00', endTime: '17:30', status: 'scheduled', passed: false, tasks: [{ taskId: 345, text: 'A task' }] }] : [];
  const live = { rows, block: block ? { blockId: 115, startTime: '16:00', endTime: '17:30', running: true, tasks: [{ taskId: 345, text: 'A task', running: false }], allTicked: false } : null, session };
  const facts = { calendar, calendarKnown: true, approvals: [], taskDomains: new Map([[345, { domain: 'work', basis: 'default' }]]), workingWindow: ww };
  return POL.decide(NC.compose(payload, live, facts, { now }), { surface: 'work-desktop', now });
}
const drop = (type, id, why, heldFor, urgency = 'high') => ({ id, type, why, urgency, heldFor });

// ── the wording function, every branch ─────────────────────────────────────

test('1. every held reason has its own plain line', () => {
  const off = { facts: { heldFor: 'off' } };
  assert.equal(heldReturnsSay(off, { ww: WW_OFF }), 'shown on your next working day');
  assert.equal(heldReturnsSay(off, { ww: WW_WORK }), 'shown when you’re working again');
  assert.equal(heldReturnsSay(off, {}), 'shown when you’re working again', 'unknown working day: never claims "next working day"');
  assert.equal(heldReturnsSay({ facts: { heldFor: 'meeting' } }, { guard: 'meeting', until: '15:00' }), 'shown when this meeting ends at 15:00');
  assert.equal(heldReturnsSay({ facts: { heldFor: 'meeting' } }, {}), 'shown when this meeting ends');
  assert.equal(heldReturnsSay({ facts: { heldFor: 'focus' } }, { guard: 'focus', until: '11:30' }), 'shown when your focus session ends at 11:30');
  assert.equal(heldReturnsSay({ facts: { heldFor: 'focus' } }, { guard: 'meeting', until: '15:00' }), 'shown when your focus session ends', 'never borrows another guard’s time');
  assert.equal(heldReturnsSay({ facts: {} }, { guard: 'meeting', until: '15:00' }), 'shown when this meeting ends at 15:00');
  assert.equal(heldReturnsSay({ facts: {} }, { guard: 'focus' }), 'shown when your focus session ends');
  assert.equal(heldReturnsSay({ facts: {} }, { guard: 'block', until: '17:30' }), 'shown when this block ends at 17:30');
  assert.equal(heldReturnsSay({ facts: {} }, {}), 'waiting its turn');
});

test('2. no line uses internal terms or the old phrase', () => {
  const lines = [
    heldReturnsSay({ facts: { heldFor: 'off' } }, { ww: WW_OFF }), heldReturnsSay({ facts: { heldFor: 'off' } }, { ww: WW_WORK }),
    heldReturnsSay({ facts: { heldFor: 'meeting' } }, { guard: 'meeting', until: '15:00' }), heldReturnsSay({ facts: { heldFor: 'focus' } }, {}),
    heldReturnsSay({ facts: {} }, { guard: 'block', until: '17:30' }), heldReturnsSay({ facts: {} }, {}),
  ];
  for (const l of lines) {
    assert.doesNotMatch(l, OLD, l);
    assert.doesNotMatch(l, /\b(gate|guard|S\d+|heldFor|protected|lead|candidate|pool|tier)\b/i, `internal term in "${l}"`);
  }
});

// ── the real pipeline, every reason that can reach a row ────────────────────

test('3a. off, not a working day: each held row says "shown on your next working day"', () => {
  const d = decideWith({ activity: 'off', onDuty: false, ww: WW_OFF, dropped: [
    drop('capacity', 'capacity-over-2026-10-18', 'not a working day', 'off'),
    drop('ticket_commitment', 'tc-1', 'not a working day', 'off'),
  ] });
  assert.ok(d.held.length >= 2, JSON.stringify(d.held));
  const off = d.held.filter((x) => x.why === 'not a working day');
  assert.equal(off.length, 2, 'positive control: both off-day rows are present');
  for (const h of off) assert.equal(h.returnsSay, 'shown on your next working day');
});

test('3b. off on a working day (not working): "shown when you’re working again"', () => {
  const d = decideWith({ activity: 'off', onDuty: true, ww: WW_WORK, dropped: [drop('capacity', 'capacity-x', 'not working — relaxing', 'off')] });
  const h = d.held.find((x) => x.why === 'not working — relaxing');
  assert.ok(h, JSON.stringify(d.held));
  assert.equal(h.returnsSay, 'shown when you’re working again');
});

test('3c. meeting: held for a running meeting → "shown when this meeting ends at <its end>"', () => {
  const d = decideWith({ now: at(14, 30), calendar: [cal(14, 0, 15, 0, 'Team review')], dropped: [drop('email', 'email-urgent', 'in a meeting — SAiM stays out of the way', 'meeting')] });
  const h = d.held.find((x) => /in a meeting/.test(x.why || ''));
  assert.ok(h, JSON.stringify(d.held));
  assert.equal(h.returnsSay, 'shown when this meeting ends at 15:00');
});

test('3d. focus: held for a focus session → "shown when your focus session ends"', () => {
  const d = decideWith({ dropped: [drop('email', 'email-urgent', 'a focus session is running — held until it ends', 'focus')] });
  const h = d.held.find((x) => /focus session/.test(x.why || ''));
  assert.ok(h, JSON.stringify(d.held));
  assert.match(h.returnsSay, /^shown when your focus session ends/);
});

test('3e. waiting while a block runs → "shown when this block ends at 17:30"', () => {
  const d = decideWith({ block: true, dropped: [drop('capacity', 'capacity-y', 'held back by NEURO', null)] });
  const h = d.held.find((x) => x.why === 'held back by NEURO');
  assert.ok(h, JSON.stringify(d.held));
  assert.equal(h.returnsSay, 'shown when this block ends at 17:30');
});

test('3e2. waiting while a focus session runs on an item → "shown when your focus session ends"', () => {
  const focusCard = { kind: 'item', type: 'email', id: 'email-focus', title: 'Write the board summary', urgency: 'medium', recordId: 9 };
  const d = decideWith({ secondary: [focusCard], session: { status: 'active', text: 'Write the board summary', taskId: null, startedAt: iso(16, 50) },
    dropped: [drop('capacity', 'capacity-w', 'held back by NEURO', null)] });
  const h = d.held.find((x) => x.why === 'held back by NEURO');
  assert.ok(h, JSON.stringify(d.held));
  assert.match(h.returnsSay, /^shown when your focus session ends/);
});

test('3f. waiting with nothing guarded → "waiting its turn"', () => {
  const d = decideWith({ dropped: [drop('capacity', 'capacity-z', 'held back by NEURO', null)] });
  const h = d.held.find((x) => x.why === 'held back by NEURO');
  assert.ok(h, JSON.stringify(d.held));
  assert.equal(h.returnsSay, 'waiting its turn');
});

test('3g. category-only and complete: every held row has a line, none leaks content or the old phrase', () => {
  for (const d of [
    decideWith({ activity: 'off', onDuty: false, ww: WW_OFF, dropped: [drop('capacity', 'c1', 'not a working day', 'off')] }),
    decideWith({ now: at(14, 30), calendar: [cal(14, 0, 15, 0, 'Board pack with Acme Ltd')], dropped: [drop('email', 'e1', 'in a meeting — SAiM stays out of the way', 'meeting')] }),
    decideWith({ block: true, dropped: [drop('todo', 'todo-overdue-top', 'held back by NEURO', null)] }),
  ]) {
    for (const h of d.held) {
      assert.ok(h.returnsSay, `held row with no line: ${JSON.stringify(h)}`);
      assert.doesNotMatch(h.returnsSay, OLD);
      assert.doesNotMatch(h.returnsSay, /Acme|Board pack|A task/, 'never a title or item detail');
    }
  }
});

// ── 4. the render ───────────────────────────────────────────────────────────

const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');
let SaimWhy;
test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'frontend', 'src', 'components', 'SaimWorkspace.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom', 'idb'], logLevel: 'silent',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      b.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl=(p)=>p;export const authHeaders=()=>({});export const apiFetch=async()=>({ok:true,json:async()=>({})});export const setPin=()=>{};export const getPin=()=>null;export default {};', loader: 'js' }));
    } }],
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require); // eslint-disable-line no-new-func
  SaimWhy = mod.exports.SaimWhy;
  global.window = global.window || { location: { search: '' }, addEventListener() {}, removeEventListener() {} };
});

test('4a. the row renders the server line verbatim, with no "back" prefix and never the old phrase', () => {
  const d = decideWith({ activity: 'off', onDuty: false, ww: WW_OFF, dropped: [drop('capacity', 'c1', 'not a working day', 'off'), drop('ticket_commitment', 't1', 'not a working day', 'off')] });
  const html = renderToString(React.createElement(SaimWhy, { data: { saim: d, generatedAt: new Date().toISOString() } }));
  assert.match(html, /Capacity warning(<!-- -->)? — (<!-- -->)?not a working day(<!-- -->)?<span class="saim-why__meta" data-why="returns"> · (<!-- -->)?shown on your next working day/);
  assert.doesNotMatch(html, OLD);
});

test('4b. an older read with only `returns` renders no suffix at all — never "back after this"', () => {
  const html = renderToString(React.createElement(SaimWhy, { data: { saim: { held: [{ ref: 'x', title: 'Capacity warning', why: 'not a working day', returns: 'after this' }] }, generatedAt: new Date().toISOString() } }));
  assert.match(html, /Capacity warning/);
  assert.doesNotMatch(html, OLD);
  assert.doesNotMatch(html, /data-why="returns"/);
});

// ── 5. source scan ──────────────────────────────────────────────────────────

test('5. no renderer can build the old phrase; the display mapping carries returnsSay', () => {
  const src = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'components', 'SaimWorkspace.jsx'), 'utf8');
  assert.doesNotMatch(src, /back \{h\.returns\}|· back /, 'the desktop no longer prefixes "back"');
  assert.match(src, /h\.returnsSay/, 'positive control: the row reads returnsSay');
  const pol = fs.readFileSync(path.join(ROOT, 'saim', 'policy', 'attention-policy.cjs'), 'utf8');
  assert.match(pol, /returnsSay: h\.returnsSay \|\| null/, 'the display held list carries the line too');
});
