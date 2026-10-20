'use strict';

/**
 * Parity: production's WRITING canonical Now vs the shadow's READ-ONLY Now.
 *
 *   run: node --test backend/services/promise-shadow-parity.test.js
 *
 * They cannot be compared one after the other on one database — the writing
 * path changes lifecycle, deferral and room state first. So for every case:
 *   1. a base database is seeded with the case's state, checkpointed;
 *   2. it is copied to A.db and B.db and the two files' SHA-256 are asserted equal;
 *   3. A runs the normal writing Now and B the read-only Now, each in its OWN
 *      child process (no shared module caches) with the wall clock FROZEN at the
 *      same instant and the same recorded Home Assistant fixture;
 *   4. gate inputs, gate result, reason and words must be deep-equal; B must
 *      change nothing; and where the case exercises a lifecycle or room write,
 *      A must have changed something (the positive control).
 * Blind and context-unknown are induced identically in both children (the pool
 * read throws / every context input reads as unknown) — said, not hidden.
 *
 * Optional live-data run: PROMISE_PARITY_SNAPSHOT=<path to a Pi DB snapshot>
 * and PROMISE_PARITY_VAULT=<vault copy> repeat the comparison on real data.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-parity-'));
const BASE = path.join(tmp, 'base.db');
process.env.NEURO_DB_PATH = BASE;
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
for (const k of ['HA_TOKEN', 'HA_URL', 'PROMISE_SHADOW_ENABLED']) delete process.env[k];

const V = process.env.OBSIDIAN_VAULT_PATH;
const put = (rel, text) => { const f = path.join(V, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
put('People/Alex Reed.md', '---\nemail: alex.reed@nurtur.tech\n---\n');
put('People/Sam Patel.md', '---\nemail: sam.patel@nurtur.tech\n---\n');
put('People/Jordan Kay.md', '---\nemail: jordan.kay@nurtur.tech\n---\n');
put('Meetings/2026/09/2026-09-14 - Ops sync.md', ['- Nick to send Alex Reed the list of ticket types blocked by skill gaps',
  '- Nick to write the onboarding guide for Sam Patel', '- Nick to review the escalation rota with Sam Patel', ''].join('\n'));
put('Meetings/2026/09/2026-09-22 - Jordan Kay 1-2-1.md', '- Nick to agree the outcome of Jordan Kay\'s flexible working request\n');

const db = require('../db/database');
const Database = require('better-sqlite3');
const FIX = path.join(__dirname, 'fixtures', 'promise-parity');
const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const lday = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
const london = (day, hm) => { for (const off of [0, 1]) { const ms = Date.parse(`${day}T${hm}:00Z`) - off * 3600000; if (new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(11, 16) === hm) return ms; } throw new Error('bad time'); };
const localHM = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(11, 16);
const localWall = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).replace(' ', 'T');

// The instant: the next Tuesday, 12:30 London (a working day, a bundled moment).
// ⚠ EVERY seeded date below derives from this ONE instant `T`, never from the
// real clock. The children judge at a frozen `T`; dates seeded from `Date.now()`
// drifted against it by up to six days depending on what weekday the suite ran,
// so on a Tuesday the commitments were already overdue at `T` and the calm case
// led with S7 instead of S11 (20 Oct 2026). `PARITY_FROM` (YYYY-MM-DD) pins the
// day the search starts from, to reproduce any date.
const FROM = process.env.PARITY_FROM ? Date.parse(`${process.env.PARITY_FROM}T12:00:00Z`) : Date.now();
let d0 = FROM + DAY;
while (new Date(`${lday(d0)}T12:00:00Z`).getUTCDay() !== 2) d0 += DAY;
const DAYKEY = lday(d0);
const T = london(DAYKEY, '12:30');

const HA_BASIC = { areas: [], states: [{ entity_id: 'sun.sun', state: 'above_horizon', attributes: {} }, { entity_id: 'binary_sensor.household_others_home', state: 'off', attributes: {} }] };
const HA_ROOM = { areas: [], states: [...HA_BASIC.states, { entity_id: 'sensor.nick_room', state: 'study', attributes: { confidence: 'sure' }, last_changed: new Date(T - 20 * 60000).toISOString() }] };
const HA_HAZARD = { areas: [], states: [...HA_BASIC.states, { entity_id: 'binary_sensor.kitchen_leak', state: 'on', attributes: { device_class: 'moisture', friendly_name: 'Kitchen leak' }, last_changed: new Date(T - 5 * 60000).toISOString() }] };
const fixture = (obj) => { const f = path.join(tmp, `ha-${crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 8)}.json`); fs.writeFileSync(f, JSON.stringify(obj)); return f; };

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function settle(file) {
  const c = new Database(file); c.pragma('wal_checkpoint(TRUNCATE)'); c.close();
  for (const x of ['-wal', '-shm']) { try { fs.unlinkSync(`${file}${x}`); } catch { /* none */ } }
}
function copy(src, dest) { settle(src); fs.copyFileSync(src, dest); return dest; }
function edit(file, fn) { const c = new Database(file); fn(c); c.pragma('wal_checkpoint(TRUNCATE)'); c.close(); settle(file); }

function child(mode, dbFile, { at = T, ha = HA_BASIC, env = {}, vault = V } = {}) {
  const r = spawnSync(process.execPath, ['-r', path.join(FIX, 'clock.js'), path.join(FIX, 'child.js'), mode], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, ...env, PARITY_BACKEND: path.join(__dirname, '..'), NEURO_DB_PATH: dbFile, OBSIDIAN_VAULT_PATH: vault,
      NEURO_TIMEZONE: 'Europe/London', TZ: 'Europe/London', FROZEN_AT: String(at), HA_URL: 'http://ha.fixture', HA_TOKEN: 'fixture', HA_FIXTURE: fixture(ha) },
  });
  const line = String(r.stdout || '').split('\n').reverse().find((l) => l.startsWith('PARITY '));
  assert.ok(line, `child ${mode} printed nothing: ${String(r.stderr || '').slice(-800)}`);
  const out = JSON.parse(line.slice(7));
  assert.ok(!out.error, `child ${mode} failed: ${out.error}`);
  return out;
}

/** Copy `caseDb` to two identical files, run both paths at the same frozen instant, return both. */
function pair(name, caseDb, opts = {}) {
  const a = copy(caseDb, path.join(tmp, `${name}.A.db`));
  const b = copy(caseDb, path.join(tmp, `${name}.B.db`));
  assert.equal(sha(a), sha(b), 'the two copies are byte-identical before the run');
  return { A: child('write', a, opts), B: child('readonly', b, opts) };
}

function assertParity({ A, B }, { rule = null, writesExpected = false } = {}) {
  assert.deepEqual(B.gateInputs, A.gateInputs, 'gate inputs');
  assert.deepEqual(B.gate, A.gate, 'gate result and reason');
  assert.deepEqual(B.sponsorship, A.sponsorship, 'the words');
  assert.deepEqual(B.ctx, A.ctx, 'interruption context');
  assert.deepEqual(B.changed, [], 'the read-only path changed nothing');
  assert.deepEqual(B.writes, {}, 'the read-only path attempted no write');
  if (writesExpected) assert.ok(A.changed.length > 0, `positive control: the writing path changed state (${JSON.stringify(A.writes)})`);
  if (rule) assert.equal(A.gateInputs.rule, rule, `pre-registered lead rule (got ${A.gateInputs.rule})`);
}

const results = [];
const record = (name, p) => results.push({ name, rule: p.A.gateInputs.rule, lead: p.A.lead, shown: p.A.gate.shown, reason: p.A.gate.reason, writes: Object.keys(p.A.writes).length });

test.before(async () => {
  await db.init();
  const taskStore = require('./task-store');
  const mk = (text, note, daysAgo, slips) => {
    const id = (taskStore.createTask({ text, source: 'meeting-promotion', origin_path: note, due_date: ymd(T + 3 * DAY) }).task || {}).id
      || db.get('SELECT id FROM tasks WHERE text = ?', [text]).id;
    db.run('UPDATE tasks SET created_at = ? WHERE id = ?', [new Date(T - daysAgo * DAY).toISOString().replace('T', ' ').slice(0, 19), id]);
    for (let i = 1; i <= slips; i += 1) taskStore.updateTask(id, { due_date: ymd(T + (3 + i) * DAY) });
    return id;
  };
  mk('Nick to send Alex Reed the list of ticket types blocked by skill gaps', 'Meetings/2026/09/2026-09-14 - Ops sync.md', 34, 2);
  mk('Nick to write the onboarding guide for Sam Patel', 'Meetings/2026/09/2026-09-14 - Ops sync.md', 34, 2);
  mk('Nick to review the escalation rota with Sam Patel', 'Meetings/2026/09/2026-09-14 - Ops sync.md', 34, 3);
  mk('Nick to agree the outcome of Jordan Kay\'s flexible working request', 'Meetings/2026/09/2026-09-22 - Jordan Kay 1-2-1.md', 26, 2);
  // An ordinary overdue task: the everyday source of pool cards, so attention
  // records exist to be created, read, deferred and released.
  const ord = taskStore.createTask({ text: 'Renew the support rota spreadsheet', source: 'manual', due_date: ymd(T - 2 * DAY) });
  assert.ok((ord.task || ord).id, 'ordinary task seeded');
  // Production carries a sent weekly-risk record for the current week; a fresh
  // database would otherwise lead every case with "Weekly Risk report is late"
  // (S2) and hide the branches each case exists to exercise.
  db.setState(`weekly_risk_sent_${lday(d0 - DAY)}`, JSON.stringify({ sentAt: new Date(T - 2 * DAY).toISOString(), by: 'parity-fixture' }));
  db.getDb().pragma('wal_checkpoint(TRUNCATE)');
});

// A database that already holds attention records: one normal Now ten minutes earlier.
let WITH_RECORDS = null;
function withRecords() {
  if (WITH_RECORDS) return WITH_RECORDS;
  WITH_RECORDS = copy(BASE, path.join(tmp, 'with-records.db'));
  const prep = child('write', WITH_RECORDS, { at: T - 10 * 60000 });
  assert.ok(prep.changed.includes('attention_records'), 'the prep run created attention records');
  settle(WITH_RECORDS);
  return WITH_RECORDS;
}

test('existing attention records', () => {
  const p = pair('existing', withRecords());
  assertParity(p, { writesExpected: true });
  record('existing attention records', p);
});

test('new cards (no record yet)', () => {
  const p = pair('new', copy(BASE, path.join(tmp, 'new.db')));
  assertParity(p, { writesExpected: true });
  assert.ok(p.A.changed.includes('attention_records'), 'the writing path created records the read-only path did not');
  record('new cards', p);
});

test('expired, unreleased deferral (and one still deferred)', () => {
  const f = copy(withRecords(), path.join(tmp, 'deferral.db'));
  edit(f, (c) => {
    const ids = c.prepare("SELECT id FROM attention_records WHERE resolution IS NULL ORDER BY id LIMIT 2").all().map((r) => r.id);
    assert.ok(ids.length >= 1, 'records to defer');
    c.prepare("UPDATE attention_records SET state = 'deferred', defer_until = ?, defer_reason = 'not-now' WHERE id = ?").run(new Date(T - 5 * 60000).toISOString(), ids[0]);
    if (ids[1]) c.prepare("UPDATE attention_records SET state = 'deferred', defer_until = ?, defer_reason = 'not-now' WHERE id = ?").run(new Date(T + 3600000).toISOString(), ids[1]);
  });
  const p = pair('deferral', f);
  assertParity(p, { writesExpected: true });
  assert.ok(Object.keys(p.A.writes).some((k) => /UPDATE attention_records/.test(k)), 'the writing path released the expired deferral');
  record('expired unreleased deferral', p);
});

test('room-visit state', () => {
  const p = pair('room', copy(BASE, path.join(tmp, 'room.db')), { ha: HA_ROOM });
  assertParity(p, { writesExpected: true });
  assert.ok(p.A.changed.includes('agent_state'), 'the writing path saved the room visit; the read-only path did not');
  record('room-visit state', p);
});

test('ordinary work at a bundled moment (S7 — the promise may be shown)', () => {
  const p = pair('ordinary', copy(BASE, path.join(tmp, 'ordinary.db')));
  assertParity(p, { rule: 'S7 top item' });
  assert.equal(p.A.gate.shown, true);
  record('ordinary work', p);
});

test('calm: nothing pending at a bundled moment (S11)', () => {
  const f = copy(BASE, path.join(tmp, 'calm.db'));
  edit(f, (c) => c.prepare("UPDATE tasks SET status = 'done' WHERE text = 'Renew the support rota spreadsheet'").run());
  const p = pair('calm', f);
  assertParity(p, { rule: 'S11 nothing' });
  record('calm', p);
});

test('meeting', () => {
  const f = copy(BASE, path.join(tmp, 'meeting.db'));
  edit(f, (c) => c.prepare(`INSERT INTO calendar_cache (event_id, subject, start_time, end_time, is_all_day, show_as, attendees_other, is_organizer) VALUES (?, ?, ?, ?, 0, 'busy', 1, 0)`)
    .run('evt-ops', 'Ops review', localWall(T - 10 * 60000), localWall(T + 20 * 60000)));
  const p = pair('meeting', f);
  assertParity(p, { rule: 'S3 meeting' });
  record('meeting', p);
});

test('focus (a running protected block)', () => {
  const f = copy(BASE, path.join(tmp, 'focus.db'));
  edit(f, (c) => {
    const taskId = c.prepare("SELECT id FROM tasks WHERE text LIKE 'Nick to write the onboarding guide%'").get().id;
    const stamp = new Date(T - DAY).toISOString();
    const r = c.prepare(`INSERT INTO task_blocks (date_key, start_time, end_time, minutes, status, note_path, created_at, updated_at) VALUES (?, ?, ?, 90, 'scheduled', 'Tasks/Blocks/parity.md', ?, ?)`)
      .run(DAYKEY, localHM(T - 30 * 60000), localHM(T + 60 * 60000), stamp, stamp);
    c.prepare('INSERT INTO task_block_items (block_id, task_id, created_at) VALUES (?, ?, ?)').run(r.lastInsertRowid, taskId, stamp);
  });
  const p = pair('focus', f);
  assertParity(p, { rule: 'S5 protected block' });
  record('focus', p);
});

test('blind (the attention pool cannot be read — induced identically in both)', () => {
  const p = pair('blind', copy(BASE, path.join(tmp, 'blind.db')), { env: { STUB_POOL_THROW: '1' } });
  assertParity(p, { rule: 'S1 blind' });
  record('blind', p);
});

test('critical risk (a household hazard sensor reporting)', () => {
  const p = pair('hazard', copy(BASE, path.join(tmp, 'hazard.db')), { ha: HA_HAZARD });
  assertParity(p, { rule: 'S2 critical risk' });
  record('critical risk', p);
});

test('quiet hours (the configured window covers the moment)', () => {
  const f = copy(BASE, path.join(tmp, 'quiet.db'));
  edit(f, (c) => c.prepare('INSERT OR REPLACE INTO agent_state (key, value) VALUES (?, ?)').run('attention_settings', JSON.stringify({ quietHours: '12:00-13:00' })));
  const p = pair('quiet', f);
  assertParity(p);
  assert.equal(p.A.ctx.quietHours, true);
  assert.match(p.A.gate.reason, /quiet hours|nothing else is shared/);
  record('quiet hours', p);
});

test('context unknown (every context input unread — induced identically in both)', () => {
  const p = pair('unknown', copy(BASE, path.join(tmp, 'unknown.db')), { env: { CONTEXT_UNKNOWN: '1' } });
  assertParity(p);
  assert.equal(p.A.ctx, null);
  assert.equal(p.A.gate.shown, false);
  record('context unknown', p);
});

const SNAP = process.env.PROMISE_PARITY_SNAPSHOT;
test('live data: identical copies of a Pi snapshot at several frozen instants', { skip: SNAP ? false : 'set PROMISE_PARITY_SNAPSHOT (and PROMISE_PARITY_VAULT) to run on a Pi snapshot copy' }, () => {
  const vault = process.env.PROMISE_PARITY_VAULT || V;
  const instants = [['07:30', 0], ['12:30', 1], ['15:10', 2], ['07:30', 5], ['22:30', 1]];
  for (const [hm, plus] of instants) {
    const at = london(lday(d0 + plus * DAY), hm);
    const src = copy(SNAP, path.join(tmp, `snap-${plus}-${hm.replace(':', '')}.db`));
    const p = pair(`snap${plus}${hm.replace(':', '')}`, src, { at, vault, ha: { fail: true } });
    assertParity(p);
    record(`live snapshot ${lday(at)} ${hm}`, p);
  }
});

test('the parity record (printed)', () => {
  for (const r of results) console.log(`[parity] ${r.name.padEnd(36)} rule=${String(r.rule).padEnd(32)} shown=${r.shown} writes-in-A=${r.writes} | ${r.reason} | lead=${JSON.stringify(r.lead)}`);
  assert.ok(results.length >= 12);
});
