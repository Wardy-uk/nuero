'use strict';

/**
 * Prepared moves through the day (22 Oct 2026): a three-move daily allowance
 * (each move still confirmed on its own), a scan that moves on once Nick has
 * dealt with the open proposal, the next genuinely available slot (today, else
 * the next working day, within ten working days), "Make this ready" offered
 * only where SAiM can take an item forward, and the MCP boundary. Real scratch
 * DB, real store, grants and budget; the planner's readers are injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-day-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_TIMEZONE = 'Europe/London';
for (const k of ['HA_TOKEN', 'HA_URL', 'SAIM_PREPARED_MOVE_EXECUTION', 'SAIM_PREPARED_MOVE_SCAN']) delete process.env[k];
fs.mkdirSync(path.join(VAULT, 'Projects', 'Support Hub'), { recursive: true });

const db = require('../db/database');
const planner = require('./prepared-move-planner');
const store = require('./prepared-move-store');
const exec = require('./prepared-move-exec');
const scan = require('./prepared-move-scan');
const budget = require('./authority-budget');
const ig = require('./intent-grants');
const { createSandbox } = require('./prepared-move-sandbox');

const DAY = 86400000;
const NOW = Date.now();
const SESSION = 'session_day_00001';
let tick = 0;
const uniq = () => `${NOW}-${++tick}`;
const emailCand = (id, title = 'Renewal question') => ({ ref: `held:email-${id}`, role: 'held', title, item: { type: 'email', id: 'email-urgent', title, meta: { emailId: id } } });
const BODY = 'Hi Nick, could you confirm whether the renewal for Acme can go ahead this month? We need your answer.';
const triage = (id, over = {}) => ({ id, subject: 'Renewal question', from: 'Sam Jones', fromEmail: 'sam@acme.test', triagedAt: new Date(NOW - 3600000).toISOString(), ...over });
function deps(cands, over = {}) {
  return {
    prepareV1: async () => ({ contract: 'prepared-move-v1', decision: { decidedAt: new Date(NOW - 60000).toISOString() }, duty: { onDuty: true, why: 'working' }, selected: null, withheld: [], candidates: cands }),
    roster: () => ({ full: [] }),
    triageEntry: (id) => triage(id),
    emailBody: async () => BODY,
    liveReply: () => null,
    draft: async () => ({ ok: true, text: 'Hi Sam,\n\nThanks — I will confirm the renewal for Acme this month.\n\nNick', gaps: [] }),
    diary: () => ({ known: true, events: [], fetchedAt: new Date(NOW - 60000).toISOString() }),
    holidays: () => new Set(),
    leaveOn: () => false,
    ...over,
  };
}
let sb = 0;
const sandbox = () => createSandbox(path.join(tmp, `sbx-${++sb}`), { realVault: VAULT });
const okChecks = () => ({ diary: async () => ({ known: true, clashes: [] }), availability: async () => ({ known: true, off: false, working: true }), candidate: async () => ({ ok: true }), noteState: async () => ({ known: true, exists: false }) });
const open = () => { process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true'; budget._test.reset(); budget._test.grantToday({ now: NOW }); };

test.before(async () => { await db.init(); exec._setDeps({ readDuty: async () => ({ onDuty: true, why: 'working' }) }); });
test.after(() => { delete process.env.SAIM_PREPARED_MOVE_EXECUTION; try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

// ── 1. The three-move allowance ──────────────────────────────────────────────

test('an older one-move table is REBUILT for three moves — rows carried over, triggers back, ceiling raised', () => {
  // A separate database with the 20 Oct schema and a live grant row in it.
  const { spawnSync } = require('child_process');
  const file = path.join(tmp, 'old.db');
  const script = `
    const Database = require('better-sqlite3'); const d = new Database(${JSON.stringify(file)});
    d.exec(\`CREATE TABLE saim_authority_grants (id TEXT PRIMARY KEY, day TEXT NOT NULL, action TEXT NOT NULL CHECK (action = 'prepared-move.block-and-note'),
      blocks INTEGER NOT NULL CHECK (blocks BETWEEN 0 AND 1), block_minutes INTEGER NOT NULL CHECK (block_minutes BETWEEN 0 AND 30),
      notes INTEGER NOT NULL CHECK (notes BETWEEN 0 AND 1), moves INTEGER NOT NULL CHECK (moves BETWEEN 0 AND 1),
      spend_pence INTEGER NOT NULL DEFAULT 0 CHECK (spend_pence = 0), contacts INTEGER NOT NULL DEFAULT 0 CHECK (contacts = 0),
      statement TEXT NOT NULL, granted_at TEXT NOT NULL, granted_by TEXT NOT NULL, revoked_at TEXT, revoked_by TEXT);
      CREATE TABLE saim_authority_reservations (id TEXT PRIMARY KEY, idem_key TEXT NOT NULL UNIQUE, day TEXT NOT NULL, grant_id TEXT NOT NULL, move_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('calendar.solo', 'vault.note')), minutes INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'used', 'released', 'unknown')), title TEXT, created_at TEXT NOT NULL, settled_at TEXT);
      INSERT INTO saim_authority_grants VALUES ('ag_old', '2026-10-20', 'prepared-move.block-and-note', 1, 30, 1, 1, 0, 0, '["old"]', 'x', 'nick', NULL, NULL);
      INSERT INTO saim_authority_reservations VALUES ('ar_old', 'k:calendar', '2026-10-20', 'ag_old', 'k', 'calendar.solo', 30, 'used', 't', 'x', 'y');\`);
    d.close();
    process.env.NEURO_DB_PATH = ${JSON.stringify(file)};
    (async () => {
      const db = require(${JSON.stringify(path.join(__dirname, '..', 'db', 'database'))}); await db.init();
      const b = require(${JSON.stringify(path.join(__dirname, 'authority-budget'))});
      b.stop({ by: 'migration-test' });
      const rows = db.all('SELECT id, moves, statement FROM saim_authority_grants');
      const res = db.all('SELECT id, kind, state FROM saim_authority_reservations');
      let refusedUpdate = false; try { db.run("UPDATE saim_authority_grants SET moves = 3 WHERE id = 'ag_old'"); } catch { refusedUpdate = true; }
      let refusedDelete = false; try { db.run("DELETE FROM saim_authority_grants WHERE id = 'ag_old'"); } catch { refusedDelete = true; }
      db.run("INSERT INTO saim_authority_grants VALUES ('ag_new', '2026-10-21', 'prepared-move.block-and-note', 3, 30, 3, 3, 0, 0, '[]', 'x', 'nick', NULL, NULL)");
      db.run("INSERT INTO saim_authority_reservations (id, idem_key, day, grant_id, move_key, kind, minutes, state, created_at) VALUES ('ar_r', 'm:reply', '2026-10-21', 'ag_new', 'm', 'reply.draft', 0, 'used', 'x')");
      let over = false; try { db.run("INSERT INTO saim_authority_grants VALUES ('ag_x', '2026-10-22', 'prepared-move.block-and-note', 4, 30, 3, 3, 0, 0, '[]', 'x', 'nick', NULL, NULL)"); } catch { over = true; }
      const idx = db.all("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_saim_authority_%'").map((r) => r.name).sort();
      console.log(JSON.stringify({ rows, res, refusedUpdate, refusedDelete, over, idx }));
    })().catch((e) => console.log('ERR ' + e.message));`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, NODE_PATH: process.env.NODE_PATH || '' } });
  const line = (r.stdout || '').trim().split('\n').pop();
  assert.doesNotMatch(line, /^ERR/, line + r.stderr);
  const o = JSON.parse(line);
  assert.deepEqual(o.rows.find((x) => x.id === 'ag_old'), { id: 'ag_old', moves: 1, statement: '["old"]' }, 'the old grant carried over unchanged');
  assert.deepEqual(o.res.find((x) => x.id === 'ar_old'), { id: 'ar_old', kind: 'calendar.solo', state: 'used' });
  assert.equal(o.refusedUpdate, true, 'immutability trigger re-installed');
  assert.equal(o.refusedDelete, true, 'no-delete trigger re-installed');
  assert.equal(o.over, true, 'the new ceiling (3) is still a CHECK');
  assert.ok(o.res.length >= 1);
  assert.deepEqual(o.idx, ['idx_saim_authority_grants_day', 'idx_saim_authority_res_day'], 'indexes re-made');
});

test('every move — note, block or reply — needs ITS OWN confirmation; three a day, then the allowance is exhausted', async () => {
  open();
  const recs = [];
  for (let i = 0; i < 4; i++) {
    const id = `e-${uniq()}`;
    recs.push((await planner.planAndStore({ now: NOW, ref: emailCand(id).ref, deps: deps([emailCand(id)]) })).record);
  }
  const ad = sandbox();
  // A confirmation minted for move 1 cannot carry out move 2.
  const c1 = exec.requestConfirmation({ recordId: recs[0].id, sessionId: SESSION });
  const cross = await exec.execute({ recordId: recs[1].id, grantId: c1.grantId, adapters: ad, checks: okChecks(), now: NOW });
  assert.equal(cross.ok, false);
  assert.equal(ad.governed._all().length, 0, 'nothing written by the wrong confirmation');
  // (A confirmation is burned on its one try, so move 1 needs a fresh one.)
  assert.notEqual(ig.get(c1.grantId).consumed_at, null);
  for (let i = 0; i < 3; i++) {
    const c = exec.requestConfirmation({ recordId: recs[i].id, sessionId: SESSION });
    const r = await exec.execute({ recordId: recs[i].id, grantId: c.grantId, adapters: ad, checks: okChecks(), now: NOW });
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.receipt.sent, false);
  }
  assert.equal(ad.governed._all().length, 3, 'three reply drafts in Actions — none sent');
  const s = budget.status({ now: NOW });
  assert.equal(s.allowance.moves.left, 0); assert.equal(s.allowance.notes.used, 3, 'reply drafts count as written outputs');
  const c4 = exec.requestConfirmation({ recordId: recs[3].id, sessionId: SESSION });
  const r4 = await exec.execute({ recordId: recs[3].id, grantId: c4.grantId, adapters: ad, checks: okChecks(), now: NOW });
  assert.equal(r4.ok, false); assert.equal(r4.budget, 'moves');
  assert.equal(ig.get(c4.grantId).consumed_at, null, 'unspent');
  // A stored proposal cannot even be asked to confirm past the limit.
  const ask = await exec.requestForMove({ recordId: recs[3].id, sessionId: SESSION, now: NOW });
  assert.equal(ask.ok, false); assert.match(ask.reasons.join(' '), /used up/);
});

// ── 2. The loop moves on ─────────────────────────────────────────────────────

test('scan: keeps ONE open proposal; moves on once it is declined, deferred or done; stops when the moves are used up', async () => {
  budget._test.reset(); delete process.env.SAIM_PREPARED_MOVE_EXECUTION;
  const ids = [`a-${uniq()}`, `b-${uniq()}`, `c-${uniq()}`, `d-${uniq()}`];
  const cands = ids.map((id) => emailCand(id));
  // Proposals left by earlier tests are about emails no longer in triage, so
  // they stop blocking — exactly as a resolved item would.
  const mine = (id) => (ids.includes(id) ? triage(id) : null);
  const sc = (over = {}) => scan.scanOnce({ now: NOW, deps: { flagOn: true, workingDay: true, duty: { onDuty: true }, inMeeting: false, planner: deps(cands, { triageEntry: mine }), ...over } });
  const kOf = (id) => planner.moveKeyFor('email-reply', `email:${id}`);
  const r1 = await sc();
  assert.equal(r1.outcome, 'stored'); assert.equal(r1.moveKey, kOf(ids[0]));
  const again = await sc();
  assert.equal(again.outcome, 'active-kept', 'an open proposal is kept, nothing new prepared');
  assert.equal(again.moveKey, kOf(ids[0]));
  // Declined → next.
  const rec1 = store.latest(kOf(ids[0]));
  store.respond({ recordId: rec1.id, version: rec1.version, response: 'decline' });
  const r2 = await sc();
  assert.equal(r2.outcome, 'stored'); assert.equal(r2.moveKey, kOf(ids[1]));
  // Deferred → next.
  const rec2 = store.latest(kOf(ids[1]));
  store.respond({ recordId: rec2.id, version: rec2.version, response: 'defer', days: 1, reason: 'not-now' });
  const r3 = await sc();
  assert.equal(r3.moveKey, kOf(ids[2]));
  // Confirmed and carried out → next.
  db.setState(`saim_move_receipt:${kOf(ids[2])}`, JSON.stringify({ complete: true, target: 'live', version: 1 }));
  const r4 = await sc();
  assert.equal(r4.moveKey, kOf(ids[3]));
  // The day's moves used up → no more preparing today.
  const done = await sc({ authority: () => ({ grant: { day: 'x' }, allowance: { moves: { left: 0 } } }) });
  assert.equal(done.ran, false); assert.match(done.why, /used up/);
  // Resolved elsewhere (the email left triage) → the open one stops blocking.
  const r5 = await sc({ planner: deps(cands, { triageEntry: (id) => (id === ids[3] || !ids.includes(id) ? null : triage(id)) }) });
  assert.notEqual(r5.outcome, 'active-kept');
});

// ── 3. The next genuinely available slot ─────────────────────────────────────

const london = (ymd, hhmm) => exec.londonMs(ymd, hhmm);
const ymdOf = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
/** The next Monday on or after a date, so fixtures land on a real working week. */
function nextMonday(fromMs) { for (let i = 0; i < 8; i++) { const d = ymdOf(fromMs + i * DAY); if (new Date(`${d}T12:00:00Z`).getUTCDay() === 1) return d; } return null; }
const add = (d, n) => ymdOf(Date.parse(`${d}T12:00:00Z`) + n * DAY);
const busyDay = (d) => ({ start: `${d}T09:00:00`, end: `${d}T17:30:00`, showAs: 'busy', isAllDay: false });

test('slots: a free 30 minutes TODAY is preferred, and it starts after now', () => {
  const mon = nextMonday(NOW + 7 * DAY);
  const r = planner.nextSlot({ nowMs: london(mon, '13:02'), events: [{ start: `${mon}T13:30:00`, end: `${mon}T14:00:00`, showAs: 'busy' }] });
  assert.equal(r.slot.date, mon);
  assert.equal(r.slot.startTime, '14:05', 'after the meeting and its buffer — not overlapping now+lead either');
});

test('slots: today full → the earliest valid slot on the NEXT working day (weekend, bank holiday and leave skipped)', () => {
  const mon = nextMonday(NOW + 7 * DAY);
  const fri = add(mon, 4);
  // Friday full, the weekend skipped, Monday a bank holiday, Tuesday on leave → Wednesday 09:00.
  const r = planner.nextSlot({ nowMs: london(fri, '10:00'), events: [busyDay(fri)], nonWorking: new Set([add(mon, 7)]), isOff: (d) => d === add(mon, 8) });
  assert.equal(r.slot.date, add(mon, 9)); assert.equal(r.slot.startTime, '09:00');
  // After the working window today → tomorrow.
  const late = planner.nextSlot({ nowMs: london(mon, '17:15'), events: [] });
  assert.equal(late.slot.date, add(mon, 1));
  // Free-marked and cancelled events are not walls; all-day events are not walls.
  const freeish = planner.nextSlot({ nowMs: london(mon, '08:00'), events: [{ ...busyDay(mon), showAs: 'free' }, { ...busyDay(mon), showAs: 'cancelled' }, { ...busyDay(mon), isAllDay: true }] });
  assert.equal(freeish.slot.date, mon); assert.equal(freeish.slot.startTime, '09:00');
});

test('slots: nothing valid in the full ten-working-day window → no slot, said plainly', () => {
  const mon = nextMonday(NOW + 7 * DAY);
  const events = []; for (let i = 0; i < 20; i++) events.push(busyDay(add(mon, i)));
  const r = planner.nextSlot({ nowMs: london(mon, '08:00'), events });
  assert.equal(r.slot, null); assert.equal(r.searched.length, 10, 'ten WORKING days searched');
  assert.equal(r.why, 'no free 30 minutes in the next 10 working days');
  // The eleventh working day is free, but it is outside the window.
  const r11 = planner.nextSlot({ nowMs: london(mon, '08:00'), events: events.filter((e) => !e.start.startsWith(add(mon, 14))) });
  assert.equal(r11.slot, null);
});

test('a project note that needs Nick is OFFERED when today is full — the proposal names the real day and time', async () => {
  const mon = nextMonday(NOW + 7 * DAY);
  const t = require('./task-store').createTask({ text: `Write the Support Hub rota notes ${uniq()}`, source: 'manual', origin_path: 'Projects/Support Hub/Support Hub.md' });
  const row = db.get('SELECT id, text FROM tasks WHERE text LIKE ?', ['Write the Support Hub rota notes%']);
  const cand = { ref: `held:todo-${row.id}`, role: 'held', title: row.text, item: { type: 'todo', id: 'todo-x', title: row.text, meta: {} } };
  void t;
  const d = deps([cand], {
    evidenceLines: () => [{ text: 'Support Hub rota notes need a single owner each week', cite: 'Projects/Support Hub/Support Hub.md:2' }],
    draft: async () => ({ ok: true, text: '## Rota\n- Support Hub rota notes need a single owner each week', gaps: ['who owns it'] }),
    diary: () => ({ known: true, events: [busyDay(mon)], fetchedAt: new Date(london(mon, '09:59')).toISOString() }),
  });
  const r = await planner.planAndStore({ now: london(mon, '10:00'), ref: cand.ref, deps: d });
  assert.equal(r.outcome, 'stored', JSON.stringify(r.withheld));
  const slot = r.record.packet.selected.decision.slots[0];
  assert.equal(slot.date, add(mon, 1)); assert.equal(slot.start, '09:00'); assert.equal(slot.end, '09:30');
  const w = exec.writesFor(r.record.packet, 'approve');
  assert.match(w.confirmation.writes.join(' '), new RegExp(`calendar, \\w+day \\d+ \\w+ 09:00–09:30\\. Just you`));
  assert.match(w.confirmation.question, /reserve 30 minutes on \w+day/);
});

// ── 4. Make this ready, only where it can do something ──────────────────────

test('eligible Now items: email, future meeting and task carry their exact ref and row ids; ineligible ones are absent', async () => {
  const em = emailCand('e-ok'); const hr = emailCand('e-hr'); const bot = emailCand('e-bot'); const declined = emailCand('e-dec');
  const meet = { ref: 'held:cal-EVT1', role: 'held', title: 'Ops review', item: { type: 'meeting', id: 'cal-EVT1', title: 'Ops review', meta: { start: '2099-01-05T10:00:00', withOthers: true, minutesAway: 90 } } };
  const oneToOne = { ref: 'held:cal-EVT2', role: 'held', title: '1-2-1 Heidi', item: { type: 'meeting', id: 'cal-EVT2', title: '1-2-1 Heidi', meta: { start: '2099-01-05T11:00:00', withOthers: true, minutesAway: 120 } } };
  const soon = { ref: 'held:cal-EVT3', role: 'held', title: 'Standup', item: { type: 'meeting', id: 'cal-EVT3', title: 'Standup', meta: { start: '2099-01-05T09:00:00', withOthers: true, minutesAway: 5 } } };
  const taskText = `Write the Support Hub escalation guide ${uniq()}`;
  require('./task-store').createTask({ text: taskText, source: 'manual' });
  const tid = db.get('SELECT id FROM tasks WHERE text = ?', [taskText]).id;
  const todo = { ref: `held:todo-${tid}`, role: 'held', title: taskText, item: { type: 'todo', id: 'todo-overdue-top', title: taskText, meta: {} } };
  const pTask = `Book the dentist ${uniq()}`;
  require('./task-store').createTask({ text: pTask, source: 'manual', domain: 'personal' });
  const personal = { ref: 'held:todo-p', role: 'held', title: pTask, item: { type: 'todo', id: 'todo-p', title: pTask, meta: {} } };
  const pip = { ref: 'held:weekly-risk', role: 'held', title: 'Weekly risk', item: { type: 'weekly_risk', id: 'weekly-risk', title: 'Weekly risk', meta: {} } };
  // decline one email first
  const dRec = (await planner.planAndStore({ now: NOW, ref: declined.ref, deps: deps([declined]) })).record;
  store.respond({ recordId: dRec.id, version: dRec.version, response: 'decline' });
  const d = deps([em, hr, bot, declined, meet, oneToOne, soon, todo, personal, pip], {
    triageEntry: (id) => (id === 'e-hr' ? triage(id, { subject: 'Disciplinary hearing outcome' }) : id === 'e-bot' ? triage(id, { fromEmail: 'no-reply@acme.test' }) : triage(id)),
    meetingEvent: (eid) => ({ EVT1: { event_id: 'EVT1', subject: 'Ops review', start_time: '2099-01-05T10:00:00', end_time: '2099-01-05T11:00:00', attendees_other: 1 }, EVT2: { event_id: 'EVT2', subject: '1-2-1 Heidi', start_time: '2099-01-05T11:00:00', attendees_other: 1 }, EVT3: { event_id: 'EVT3', subject: 'Standup', start_time: new Date(NOW + 5 * 60000).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).replace(' ', 'T'), attendees_other: 1 } }[eid] || null),
  });
  const out = await planner.eligibleNow({ now: NOW, deps: d });
  const byRef = new Map(out.items.map((i) => [i.ref, i]));
  assert.deepEqual([...byRef.keys()].sort(), [em.ref, meet.ref, todo.ref].sort(), JSON.stringify(out.items.map((i) => i.ref)));
  assert.equal(byRef.get(em.ref).label, 'Draft the reply');
  assert.equal(byRef.get(meet.ref).label, 'Make the meeting prep ready');
  assert.equal(byRef.get(todo.ref).label, 'Make this ready');
  assert.ok(byRef.get(em.ref).rowIds.includes('attention:email-urgent'));
  assert.ok(byRef.get(meet.ref).rowIds.includes('event:derived:2099-01-05T10:00:00:Ops review'), 'the agenda row id is the snapshot’s own');
  assert.ok(byRef.get(todo.ref).rowIds.includes(`task:${tid}`));
  // Off duty: nothing is offered.
  const off = await planner.eligibleNow({ now: NOW, deps: { ...d, prepareV1: async () => ({ duty: { onDuty: false }, candidates: [em] }) } });
  assert.deepEqual(off.items, []);
});

test('Make this ready: the button only on a row the server named; nothing on the kiosk; Now places it AFTER the row’s own action', async () => {
  const esbuild = require('esbuild'); const React = require('react'); const { renderToString } = require('react-dom/server');
  const APP = path.resolve(__dirname, '..', '..', 'saim', 'app', 'src');
  const out = await esbuild.build({ entryPoints: [path.join(APP, 'components', 'MakeReady.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], logLevel: 'silent' });
  const mod = { exports: {} }; new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  const V = mod.exports.MakeReadyView;
  const h = (p) => renderToString(React.createElement(V, { onPress() {}, onOpen() {}, ...p }));
  assert.equal(h({ item: null }), '', 'no item → no button');
  assert.equal(h({ item: { ref: 'held:x', label: 'Draft the reply' }, readOnly: true }), '', 'kiosk → no button');
  assert.match(h({ item: { ref: 'held:x', label: 'Draft the reply' } }), />Draft the reply</);
  assert.match(h({ item: { ref: 'held:x', label: 'x' }, result: { kind: 'prepared', headline: 'I drafted the reply to Sam.' } }), /I drafted the reply to Sam\.[\s\S]*See it on the SAiM home/);
  const flow = await import(pathToFileURL(path.join(APP, 'makeReady.mjs')).href);
  const m = flow.eligibleIndex({ ok: true, items: [{ ref: 'held:a', rowIds: ['attention:email-urgent', 'task:7'] }] });
  assert.equal(m.get('task:7').ref, 'held:a'); assert.equal(m.get('task:8'), undefined);
  const calls = []; const call = async (p, o = {}) => { calls.push({ p, ...o }); return { status: 200, body: { ok: true, move: { prepared: { headline: 'I drafted the reply to Sam.' } } } }; };
  const r = await flow.makeItReady(call, { ref: 'held:a' });
  assert.deepEqual(calls[0], { p: '/api/prepared-moves/prepare', method: 'POST', body: { ref: 'held:a' } }, 'the exact ref, nothing else');
  assert.equal(r.kind, 'prepared');
  const now = fs.readFileSync(path.join(APP, 'views', 'Now.jsx'), 'utf8');
  assert.match(now, /Open →\s*<\/button>\s*\)\}\s*\{mr\(s\.focus\.item\.id\)\}/, 'focus: after its own Open');
  assert.match(now, /onNavigate\(f\.tab\)\}>Open →<\/button>\s*\)\}\s*\{mr\(f\.id\)\}/, 'follow-up: after its own Open');
  assert.match(now, /\{mr\(e\.id\)\}/); assert.match(now, /\{mr\(t\.id\)\}/);
  assert.match(now, /platformNow\(\) === 'kiosk'/, 'Now on the kiosk is read-only');
});

// ── 5. MCP: read, prepare, defer/decline, answer — never request or confirm ──

test('MCP tiers: eligible/current are reads, prepare/respond/answer are actions, request/confirm are Nick’s', async () => {
  const policy = await import(pathToFileURL(path.resolve(__dirname, '..', '..', 'mcp-server', 'remote', 'api-policy.js')).href);
  const inv = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'mcp-server', 'remote', 'api-inventory.json'), 'utf8'));
  const ops = new Map((inv.operations || inv).map((o) => [o.id, o]));
  const tier = (id) => { assert.ok(ops.has(id), `${id} is inventoried`); return policy.classify(ops.get(id)); };
  assert.equal(tier('get_prepared_moves_current'), 'read');
  assert.equal(tier('get_prepared_moves_eligible'), 'read');
  for (const id of ['post_prepared_moves_prepare', 'post_prepared_moves_respond', 'post_prepared_moves_answer']) assert.equal(tier(id), 'action', id);
  for (const id of ['post_prepared_moves_request', 'post_prepared_moves_confirm', 'post_saim_authority_grant', 'post_saim_authority_grant_preview']) assert.equal(tier(id), 'admin', id);
  const m = require('./authority-matrix');
  assert.equal(m.resolve('GET', '/api/prepared-moves/eligible').capability, 'read');
  assert.equal(m.resolve('POST', '/api/prepared-moves/confirm').capability, 'saim.prepared-move');
  assert.equal(m.resolve('POST', '/api/saim-authority/grant').capability, 'saim.authority');
});
