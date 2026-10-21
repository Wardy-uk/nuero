'use strict';

/**
 * promise-workbench-v1 — the two-item cap, deterministic ordering from the four
 * permitted facts only, preparation states, and fail-closed withholding.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const w = require('./promise-workbench');

const NOW = Date.parse('2026-10-21T14:00:00Z'); // Wed 15:00 BST
const FRESH = { readAt: '2026-10-21T13:59:00Z', progressScannedAt: '2026-10-21T08:00:00Z' };
const NONE = () => ({ state: 'no_evidence', reasons: ['nothing NEURO checked says it moved'] });

let seq = 0;
function promise(over = {}) {
  seq += 1;
  const id = over.id || seq;
  return {
    key: `promise:${id}`, taskIds: [id], leadTaskId: id, text: `Build the onboarding checklist ${id}`, open: true,
    due: '2026-10-23', statedDate: null, records: [{ taskId: id, status: 'open' }],
    owedTo: { resolved: 'Hope Goodall', people: [{ name: 'Hope Goodall' }], ambiguous: [] },
    source: { title: '1-2-1 Hope', path: 'Meetings/2026/10/1-2-1 Hope.md', line: `Nick will build the onboarding checklist ${id}`, readable: true },
    slips: { dueMoves: 9, lapsedBlocks: 4, statedDatePassed: false, dueMovesAt: [], recommitsAt: [] },
    sensitivity: { sensitive: false }, booked: [], nextMeeting: null,
    ...over,
  };
}
const progressFor = (ps, fn = NONE) => new Map(ps.map((p) => [p.key, fn(p)]));
const sel = (promises, extra = {}) => w.select({ promises, progress: progressFor(promises), freshness: FRESH, now: NOW, ...extra });

test('at most TWO promises are selected', () => {
  const ps = [1, 2, 3, 4, 5].map((id) => promise({ id: 100 + id, due: '2026-10-22' }));
  const r = sel(ps);
  assert.equal(r.items.length, 2);
  assert.equal(r.considered, 5);
});

test('ordering is deterministic: the same promises in any order give the same two, in the same order', () => {
  const ps = [
    promise({ id: 201, due: '2026-10-24' }),
    promise({ id: 202, due: '2026-10-20' }), // overdue
    promise({ id: 203, due: '2026-10-21' }), // today
    promise({ id: 204, due: '2026-10-22' }),
  ];
  const a = sel(ps).items.map((i) => i.key);
  const b = sel([...ps].reverse()).items.map((i) => i.key);
  const c = sel([ps[2], ps[0], ps[3], ps[1]]).items.map((i) => i.key);
  assert.deepEqual(a, ['promise:202', 'promise:203']);
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
});

test('within a due tier, a meeting with the person comes first, then no evidence, then unbooked; ties fall to the lowest task id', () => {
  const meet = promise({ id: 301, due: '2026-10-23', nextMeeting: { title: '1-2-1 Hope', start: '2026-10-22T10:00', basis: 'attendee' } });
  const plain = promise({ id: 302, due: '2026-10-23' });
  const booked = promise({ id: 303, due: '2026-10-23', booked: [{ taskId: 303, date: '2026-10-22', start: '09:00', end: '10:00', status: 'scheduled' }] });
  const progressed = promise({ id: 300, due: '2026-10-23' });
  const progress = new Map([[meet.key, NONE()], [plain.key, NONE()], [booked.key, NONE()], [progressed.key, { state: 'progress_observed', reasons: ['an email to Hope shares its words'] }]]);
  const r = w.select({ promises: [booked, progressed, plain, meet], progress, freshness: FRESH, now: NOW });
  assert.deepEqual(r.items.map((i) => i.key), ['promise:301', 'promise:302']);
  const all = w.select({ promises: [booked, progressed, plain, meet], progress, freshness: FRESH, now: NOW });
  assert.ok(all.items[0].because.some((b) => /you meet Hope Goodall before it is due/.test(b)));
});

test('slips, wording and the person do NOT rank: two identical-but-for-slips promises order by task id', () => {
  const a = promise({ id: 402, due: '2026-10-23', slips: { dueMoves: 0, lapsedBlocks: 0, statedDatePassed: false, dueMovesAt: [], recommitsAt: [] } });
  const b = promise({ id: 401, due: '2026-10-23', slips: { dueMoves: 20, lapsedBlocks: 9, statedDatePassed: false, dueMovesAt: [], recommitsAt: [] } });
  assert.deepEqual(sel([a, b]).items.map((i) => i.key), ['promise:401', 'promise:402']);
  const c = promise({ id: 403, due: '2026-10-23', slips: { dueMoves: 20, lapsedBlocks: 9, statedDatePassed: false, dueMovesAt: [], recommitsAt: [] } });
  const d = promise({ id: 404, due: '2026-10-23' });
  assert.deepEqual(sel([d, c]).items.map((i) => i.key), ['promise:403', 'promise:404']);
});

test('a promise already proven delivered is never at risk; one beyond the horizon is not offered', () => {
  const done = promise({ id: 501, due: '2026-10-21' });
  const far = promise({ id: 502, due: '2026-11-20' });
  const r = sel([done, far], { proofs: new Map([[done.key, { actionId: 'pa', provenBy: 'x' }]]) });
  assert.equal(r.items.length, 0);
  assert.equal(r.why, 'No promise is at risk this week.');
});

test('preparation states', () => {
  const ready = promise({ id: 601, due: '2026-10-23', booked: [{ taskId: 601, date: '2026-10-22', start: '09:00', end: '10:00', status: 'scheduled' }] });
  const draft = promise({ id: 602, due: '2026-10-23', text: 'Send Hope the onboarding checklist' });
  const block = promise({ id: 603, due: '2026-10-23' });
  const nobody = promise({ id: 604, due: '2026-10-23', owedTo: { resolved: null, people: [], ambiguous: [] } });
  const maybe = promise({ id: 605, due: '2026-10-23' });
  const unknown = promise({ id: 606, due: '2026-10-23' });
  const state = (p, pr = NONE()) => w.preparationFor(p, { due: { date: p.due }, progress: pr, booked: p.booked }).state;
  assert.equal(state(ready), 'ready');
  assert.equal(state(draft), 'needs-a-draft');
  assert.equal(state(block), 'needs-a-block');
  assert.equal(state(nobody), 'waiting-for-Nick');
  assert.equal(state(maybe, { state: 'likely_fulfilled', reasons: [] }), 'waiting-for-Nick');
  assert.equal(state(unknown, { state: 'unknown', reasons: [] }), 'not-safe-to-prepare');
  assert.equal(state(unknown, null), 'not-safe-to-prepare');
  assert.equal(state(block, { state: 'no_evidence', reasons: [], stale: true }), 'not-safe-to-prepare');
});

test('booked time AFTER the due point does not make it ready', () => {
  const late = promise({ id: 701, due: '2026-10-22', booked: [{ taskId: 701, date: '2026-10-24', start: '09:00', end: '10:00', status: 'scheduled' }] });
  const r = sel([late]);
  assert.equal(r.items[0].preparation.state, 'needs-a-block');
  assert.deepEqual(r.items[0].booked, []);
});

test('sensitive, ambiguous, unreadable and undated promises are WITHHELD, counted by reason, and never named', () => {
  const sens = promise({ id: 801, due: '2026-10-21', text: 'Confirm Naomi’s phased return dates', sensitivity: { sensitive: true, where: 'wording', matched: 'phased return' } });
  const amb = promise({ id: 802, due: '2026-10-21', owedTo: { resolved: null, people: [], ambiguous: [{ said: 'chris', candidates: ['Chris Middleton', 'Chris Smith'] }] } });
  const two = promise({ id: 803, due: '2026-10-21', owedTo: { resolved: null, people: [{ name: 'A B' }, { name: 'C D' }], ambiguous: [] } });
  const unread = promise({ id: 804, due: '2026-10-21', source: { title: 'x', path: 'x.md', line: null, readable: false } });
  const undated = promise({ id: 805, due: null });
  const ok = promise({ id: 806, due: '2026-10-22' });
  const r = sel([sens, amb, two, unread, undated, ok]);
  assert.deepEqual(r.items.map((i) => i.key), ['promise:806']);
  assert.deepEqual(r.withheld, { sensitive: 1, ambiguous: 2, unreadable: 1, undated: 1 });
  const json = JSON.stringify(r);
  assert.ok(!json.includes('Naomi'), 'an employment matter is never named');
  assert.ok(!json.includes('phased'), 'nor its wording');
});

test('a stale or failed read prepares NOTHING and says why', () => {
  const ps = [promise({ id: 901, due: '2026-10-21' })];
  const stale = w.select({ promises: ps, progress: progressFor(ps), freshness: { readAt: '2026-10-21T13:00:00Z' }, now: NOW });
  assert.equal(stale.state, 'not-safe-to-prepare');
  assert.equal(stale.items.length, 0);
  assert.match(stale.why, /out of date/);
  const noRead = w.select({ promises: ps, progress: progressFor(ps), freshness: {}, now: NOW });
  assert.equal(noRead.items.length, 0);
  const noTasks = w.select({ promises: ps, progress: progressFor(ps), freshness: FRESH, gaps: [{ input: 'tasks', why: 'x' }], now: NOW });
  assert.equal(noTasks.state, 'not-safe-to-prepare');
  assert.equal(noTasks.items.length, 0);
});

test('a stale progress scan marks each selected item not-safe-to-prepare (it cannot say nothing happened)', () => {
  const ps = [promise({ id: 1001, due: '2026-10-22' })];
  const r = w.select({ promises: ps, progress: progressFor(ps), freshness: { readAt: FRESH.readAt, progressScannedAt: '2026-10-19T08:00:00Z' }, now: NOW });
  assert.equal(r.items[0].preparation.state, 'not-safe-to-prepare');
  assert.match(r.items[0].preparation.why, /out of date/);
});

test('every selected item carries its due point and the evidence behind it, truthfully', () => {
  const p = promise({ id: 1101, due: '2026-10-30', statedDate: { date: '2026-10-22', phrase: 'by Thursday' } });
  const it = sel([p]).items[0];
  assert.equal(it.due.date, '2026-10-22');
  assert.equal(it.due.basis, 'stated-in-wording');
  assert.equal(it.due.endsAt, '2026-10-22T23:00:00.000Z');
  assert.ok(it.evidence.some((e) => e.kind === 'due' && /“by Thursday”/.test(e.fact)));
  assert.ok(it.evidence.some((e) => e.kind === 'source' && e.path === p.source.path));
  assert.ok(it.because.includes('no time is booked for it'));
});

test('the workbench is READ-ONLY: it requires no writer, executor, sender or allowance', () => {
  for (const f of ['promise-workbench.js', 'promise-score.js', 'keep-my-word.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf-8');
    const required = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    for (const banned of ['./task-store', './prepared-actions', './action-executor', './prepared-move-exec', './email-sender', './action-mail', './intent-grants', './smtp-mail']) {
      assert.ok(!required.includes(banned), `${f} must not require ${banned}`);
    }
    for (const banned of [/\.grant\(/, /\.reserve\(/, /setState\(/, /\.run\(/, /\bINSERT\s+INTO\b/, /\bUPDATE\s+\w+\s+SET\b/, /\bDELETE\s+FROM\b/]) {
      assert.ok(!banned.test(src), `${f} must not ${banned}`);
    }
  }
  // positive control: the scan sees requires in these files at all
  assert.ok([...fs.readFileSync(path.join(__dirname, 'keep-my-word.js'), 'utf-8').matchAll(/require\(['"]([^'"]+)['"]\)/g)].length > 0);
  // positive control: the scan reads real files
  assert.ok(fs.readFileSync(path.join(__dirname, 'promise-score.js'), 'utf-8').includes('SELECT'));
});
