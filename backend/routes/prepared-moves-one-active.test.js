'use strict';

/**
 * A manual press always prepares (24 Oct 2026; replaces the 23 Oct one-active
 * rule) — over real HTTP through NEURO's real api-auth and authority guard,
 * and through the real client flow (saim/app makeReady.mjs). Two different
 * items are both prepared and neither touches the other; pressing the same
 * item again returns the existing proposal. Also: leave that cannot be
 * checked never yields a time.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-one-active-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
for (const k of ['HA_TOKEN', 'HA_URL', 'SAIM_PREPARED_MOVE_EXECUTION']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'vault', 'Projects', 'Support Hub'), { recursive: true });

const db = require('../db/database');
const planner = require('../services/prepared-move-planner');
const store = require('../services/prepared-move-store');
const exec = require('../services/prepared-move-exec');

const NOW = Date.now();
const A = { ref: 'held:email-a', role: 'held', title: 'Renewal question', item: { type: 'email', id: 'email-urgent', title: 'Renewal question', meta: { emailId: 'email-A' } } };
const B = { ref: 'held:email-b', role: 'held', title: 'Invoice query', item: { type: 'email', id: 'email-urgent', title: 'Invoice query', meta: { emailId: 'email-B' } } };
const BODY = 'Hi Nick, could you confirm whether the renewal for Acme can go ahead this month? We need your answer.';
let drafts = 0;
Object.assign(planner.DEFAULT_DEPS, {
  prepareV1: async () => ({ contract: 'prepared-move-v1', decision: { decidedAt: new Date(NOW).toISOString() }, duty: { onDuty: true, why: 'working' }, selected: null, withheld: [], candidates: [A, B] }),
  roster: () => ({ full: [] }),
  triageEntry: (id) => ({ id, subject: id === 'email-A' ? 'Renewal question' : 'Invoice query', from: 'Sam Jones', fromEmail: 'sam@acme.test', triagedAt: new Date(NOW).toISOString() }),
  emailBody: async () => BODY,
  liveReply: () => null,
  draft: async () => { drafts += 1; return { ok: true, text: 'Hi Sam,\n\nThanks — I will confirm the renewal for Acme this month.\n\nNick', gaps: [] }; },
});
exec._setDeps({ readDuty: async () => ({ onDuty: true, why: 'working' }) });
require('../services/prepared-move').readDuty = async () => ({ onDuty: true, why: 'working' });

let server; let base;
test.before(async () => {
  await db.init();
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require('../services/api-auth'));
  app.use('/api', require('../services/authority-guard').guard);
  app.use('/api/prepared-moves', require('./prepared-moves'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

/** The client's own transport (makeCall), against the real server. */
async function clientCall() {
  const pm = await import(pathToFileURL(path.resolve(__dirname, '..', '..', 'saim', 'app', 'src', 'preparedMove.mjs')).href);
  return pm.makeCall({ fetchImpl: (...a) => fetch(...a), apiUrl: (p) => `${base}${p}`, authHeaders: () => ({ 'Content-Type': 'application/json', 'X-NEURO-PIN': 'pin-1234' }) });
}
const snapshot = () => ({
  moves: db.all(`SELECT id, move_key, version FROM prepared_moves ORDER BY id`),
  responses: (() => { try { return db.all(`SELECT * FROM prepared_move_responses ORDER BY id`); } catch { return []; } })(),
  checks: (() => { try { return db.all(`SELECT * FROM prepared_move_checks ORDER BY record_id`); } catch { return []; } })(),
  grants: db.get(`SELECT COUNT(*) n FROM human_action_intents`).n,
});

test('a manual press ALWAYS prepares: two different items are both prepared, and the first is left exactly as it was', async () => {
  const flow = await import(pathToFileURL(path.resolve(__dirname, '..', '..', 'saim', 'app', 'src', 'makeReady.mjs')).href);
  const call = await clientCall();
  const first = await flow.makeItReady(call, { ref: A.ref });
  assert.equal(first.kind, 'prepared', JSON.stringify(first));
  assert.equal(first.headline, 'I drafted the reply to Sam.');
  const before = snapshot();
  assert.equal(before.moves.length, 1);
  const recA = store.latest(planner.moveKeyFor('email-reply', 'email:email-A'));

  // The second, different item — through the real client flow — is prepared too.
  const second = await flow.makeItReady(call, { ref: B.ref });
  assert.equal(second.kind, 'prepared', JSON.stringify(second));
  const after = snapshot();
  assert.equal(after.moves.length, 2);
  // A untouched: same row, same version, no response, no grant.
  assert.deepEqual(after.moves.find((m) => m.move_key === recA.moveKey), before.moves[0]);
  assert.equal(store.latest(recA.moveKey).id, recA.id);
  assert.deepEqual(after.responses, before.responses);
  assert.equal(after.grants, before.grants);
  const active = store.activeV2({ now: Date.now() }).map((r) => r.moveKey).sort();
  assert.deepEqual(active, [planner.moveKeyFor('email-reply', 'email:email-A'), planner.moveKeyFor('email-reply', 'email:email-B')].sort());
});

test('pressing the SAME item again returns the existing proposal — no second row, no second draft', async () => {
  const flow = await import(pathToFileURL(path.resolve(__dirname, '..', '..', 'saim', 'app', 'src', 'makeReady.mjs')).href);
  const call = await clientCall();
  const before = snapshot(); const draftsBefore = drafts;
  const raw = await call('/api/prepared-moves/prepare', { method: 'POST', body: { ref: A.ref } });
  assert.equal(raw.status, 200);
  assert.equal(raw.body.outcome, 'existing');
  assert.equal(raw.body.move.prepared.headline, 'I drafted the reply to Sam.');
  const again = await flow.makeItReady(call, { ref: A.ref });
  assert.equal(again.kind, 'prepared');
  const after = snapshot();
  assert.deepEqual(after.moves, before.moves, 'no new row or version');
  assert.deepEqual(after.responses, before.responses);
  assert.equal(drafts, draftsBefore, 'no second model call');
});

test('an existing proposal that has become invalid (resolved elsewhere) is not returned as if it still held', async () => {
  const flow = await import(pathToFileURL(path.resolve(__dirname, '..', '..', 'saim', 'app', 'src', 'makeReady.mjs')).href);
  const call = await clientCall();
  const was = planner.DEFAULT_DEPS.triageEntry;
  planner.DEFAULT_DEPS.triageEntry = (id) => (id === 'email-B' ? null : was(id));
  try {
    const r = await flow.makeItReady(call, { ref: B.ref });
    assert.notEqual(r.kind, 'prepared', JSON.stringify(r));
  } finally { planner.DEFAULT_DEPS.triageEntry = was; }
});

// ── Leave fails closed for scheduling ───────────────────────────────────────

const DAY = 86400000;
const ymdOf = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
function nextMonday(fromMs) { for (let i = 0; i < 8; i++) { const d = ymdOf(fromMs + i * DAY); if (new Date(`${d}T12:00:00Z`).getUTCDay() === 1) return d; } return null; }
const add = (d, n) => ymdOf(Date.parse(`${d}T12:00:00Z`) + n * DAY);
const at = (d, t) => exec.londonMs(d, t);

test('leave unreadable on the first otherwise-free day → that day gets no time; the next KNOWN-working day does', () => {
  const mon = nextMonday(NOW + 7 * DAY);
  const r = planner.nextSlot({ nowMs: at(mon, '08:00'), events: [], leave: (d) => (d === mon ? 'unknown' : 'working') });
  assert.equal(r.slot.date, add(mon, 1)); assert.equal(r.slot.startTime, '09:00');
  assert.deepEqual(r.leaveUnknown, [mon]);
  // A reader that throws is unknown too, never "not off".
  const t = planner.nextSlot({ nowMs: at(mon, '08:00'), events: [], leave: (d) => { if (d === mon) throw new Error('People HR unreachable'); return 'working'; } });
  assert.equal(t.slot.date, add(mon, 1));
  // So is any answer that is not exactly 'working' or 'off'.
  const odd = planner.nextSlot({ nowMs: at(mon, '08:00'), events: [], leave: (d) => (d === mon ? false : 'working') });
  assert.equal(odd.slot.date, add(mon, 1));
});

test('leave unreadable throughout the window → no slot at all, said plainly', () => {
  const mon = nextMonday(NOW + 7 * DAY);
  const r = planner.nextSlot({ nowMs: at(mon, '08:00'), events: [], leave: () => 'unknown' });
  assert.equal(r.slot, null); assert.equal(r.leaveBlocked, true);
  assert.equal(r.searched.length, 10); assert.equal(r.leaveUnknown.length, 10);
  assert.equal(r.why, 'I couldn’t safely check your leave for any of the next 10 working days, so I haven’t proposed a time');
  // The default reader with no leave data on record answers unknown — never "working".
  assert.equal(planner.DEFAULT_DEPS.leaveState(mon), 'unknown');
  assert.equal(planner.nextSlot({ nowMs: at(mon, '08:00'), events: [] }).slot, null, 'no reader → no time');
});

test('a known leave day is skipped in favour of the next known-working day', () => {
  const mon = nextMonday(NOW + 7 * DAY);
  const r = planner.nextSlot({ nowMs: at(mon, '08:00'), events: [], leave: (d) => (d === mon || d === add(mon, 1) ? 'off' : 'working') });
  assert.equal(r.slot.date, add(mon, 2)); assert.deepEqual(r.skipped, [mon, add(mon, 1)]); assert.deepEqual(r.leaveUnknown, []);
});

test('a project note that needs Nick, with leave unreadable: the DRAFT is offered, but no time is proposed — and it says why', async () => {
  const mon = nextMonday(NOW + 7 * DAY);
  const text = `Write the Support Hub rota notes ${NOW}`;
  require('../services/task-store').createTask({ text, source: 'manual', origin_path: 'Projects/Support Hub/Support Hub.md' });
  const id = db.get('SELECT id FROM tasks WHERE text = ?', [text]).id;
  const cand = { ref: `held:todo-${id}`, role: 'held', title: text, item: { type: 'todo', id: 'todo-x', title: text, meta: {} } };
  const r = await planner.planAndStore({ now: at(mon, '10:00'), ref: cand.ref, deps: {
    prepareV1: async () => ({ decision: { decidedAt: new Date(at(mon, '09:59')).toISOString() }, duty: { onDuty: true }, candidates: [cand] }),
    activeV2: () => [],
    evidenceLines: () => [{ text: 'Support Hub rota notes need a single owner each week', cite: 'Projects/Support Hub/Support Hub.md:2' }],
    draft: async () => ({ ok: true, text: '## Rota\n- Support Hub rota notes need a single owner each week', gaps: ['who owns it'] }),
    diary: () => ({ known: true, events: [], fetchedAt: new Date(at(mon, '09:59')).toISOString() }),
    holidays: () => new Set(),
    leaveState: () => 'unknown',
  } });
  assert.equal(r.outcome, 'stored', JSON.stringify(r.withheld));
  const s = r.record.packet.selected;
  assert.deepEqual(s.decision.proposedWrites.map((w) => w.kind), ['vault.note'], 'draft only — no calendar block');
  assert.equal(s.decision.slots[0].date, undefined);
  assert.match(s.noTimeBecause, /couldn’t safely check your leave/);
  const w = exec.writesFor(r.record.packet, 'approve');
  assert.ok(w.ok); assert.doesNotMatch(w.confirmation.writes.join(' '), /calendar/);
  // The fresh check before any write stays the second guard: leave unknown at write time refuses a block.
  const fc = await exec.freshChecks({ record: { packet: { selected: {} }, options: { approve: {} }, evidenceExpiresAt: new Date(at(mon, '08:00') + 3600000).toISOString() },
    w: { option: 'approve', slot: { date: add(mon, 1), start: '09:00', end: '09:30' }, steps: [{ step: 'calendar', title: 'x' }], moveKey: 'k' },
    checks: { diary: async () => ({ known: true, clashes: [] }), availability: async () => ({ known: false, why: 'People HR not readable' }), candidate: async () => ({ ok: true }), noteState: async () => ({ known: true, exists: false }) }, now: at(mon, '08:00') });
  assert.equal(fc.ok, false); assert.match(fc.reasons[0], /couldn’t check your leave/);
});

test('the real leave reader maps People HR’s answer to off / working / unknown — never “working” on a guess', () => {
  const ta = require('../services/team-availability');
  const keep = { selfAbsenceOn: ta.selfAbsenceOn, snapshot: ta.snapshot };
  ta.snapshot = () => ({ known: true });
  try {
    const cases = [
      [{ known: true, off: true }, 'off'],
      [{ known: true, off: false }, 'working'],
      [{ known: false, off: false }, 'unknown'],
      [{ known: true }, 'unknown'],
      [null, 'unknown'],
    ];
    for (const [answer, want] of cases) {
      ta.selfAbsenceOn = () => answer;
      assert.equal(planner.DEFAULT_DEPS.leaveState('2026-11-02'), want, JSON.stringify(answer));
    }
    ta.selfAbsenceOn = () => { throw new Error('feed down'); };
    assert.equal(planner.DEFAULT_DEPS.leaveState('2026-11-02'), 'unknown');
  } finally { Object.assign(ta, keep); }
});
