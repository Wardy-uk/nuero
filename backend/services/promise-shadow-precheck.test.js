'use strict';

/**
 * The shadow settles from history what history alone decides — no canonical
 * Now, no room presence (19 Oct 2026).
 *
 *   run: node --test backend/services/promise-shadow-precheck.test.js
 *
 * Context can only take an offer away, so when no ordinary promise passes the
 * policy against the real London-day history and the 3-a-day cap, canonical
 * Now cannot change the outcome and is not called. The outcome is logged with
 * `canonicalNow: 'not_called'` and NO gate. If even one ordinary promise is
 * offerable, Now is read once and the shared gate applies normally. Employment
 * matters are routing-only and never cause a read. Discovery is unchanged.
 * REAL read-only Now; room presence answered by a stub that COUNTS. History is
 * seeded by appending rows to the shadow's own log — exactly what it reads back.
 * People are pseudonyms.
 */

// Pins the wall clock to each pass's simulated instant (see the helper).
const clock = require('./fixtures/promise-shadow/clock');
clock.install();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-pprecheck-'));
process.env.NEURO_DB_PATH = path.join(tmp, 's.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
for (const k of ['GOVERNED_EXECUTION_ENABLED', 'HA_TOKEN', 'HA_URL', 'PROMISE_SHADOW_ENABLED', 'SAIM_BASE_URL']) delete process.env[k];

const V = process.env.OBSIDIAN_VAULT_PATH;
const put = (rel, text) => { const f = path.join(V, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
put('People/Alex Reed.md', '---\nemail: alex.reed@nurtur.tech\n---\n');
put('People/Sam Patel.md', '---\nemail: sam.patel@nurtur.tech\n---\n');
put('People/Jordan Kay.md', '---\nemail: jordan.kay@nurtur.tech\n---\n');
put('People/Casey Moore.md', '---\nemail: casey.moore@nurtur.tech\n---\n'); // before the roster is first read (it is cached)
put('Meetings/2026/09/2026-09-14 - Ops sync.md', '- Nick to send Alex Reed the list of ticket types blocked by skill gaps\n- Nick to write the onboarding guide for Sam Patel\n');
put('Meetings/2026/09/2026-09-22 - Jordan Kay 1-2-1.md', '- Nick to agree the outcome of Jordan Kay\'s flexible working request\n');

const calls = { presence: 0, other: [] };
global.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('http://localhost:3005/api/presence/room')) { calls.presence += 1; return { ok: true, status: 200, json: async () => ({ confidence: 'unsure', room: null }) }; }
  calls.other.push(u); throw new Error(`unexpected network call: ${u}`);
};
const doors = [];
function stub(rel, ex) { const id = require.resolve(rel); require.cache[id] = { id, filename: id, loaded: true, exports: ex }; }
const boom = (w) => async () => { doors.push(w); throw new Error(`${w} reached from the shadow`); };
stub('./webpush', { sendToAll: boom('webpush.sendToAll'), isConfigured: () => true });
stub('./email-sender', { sendMail: boom('email-sender.sendMail'), sendBriefEmail: boom('email-sender'), OWN_ADDRESS: 'nickw@nurtur.tech' });
stub('./teams', { getSendStatus: async () => ({ available: false }) });
stub('./action-mail', { createDraft: boom('action-mail'), sendDraft: boom('action-mail'), DEFINITIVE_SEND_REFUSALS: new Set() });
stub('./microsoft', { getSignedInAddress: async () => 'nickw@nurtur.tech', getAccessToken: boom('graph'), graphWrite: boom('graphWrite'), sendMail: boom('ms.sendMail') });

const db = require('../db/database');
const taskStore = require('./task-store');
const shadow = require('./promise-shadow');

const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const lday = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
function london(d, hm) {
  for (const off of [0, 1]) {
    const ms = Date.parse(`${d}T${hm}:00Z`) - off * 3600000;
    if (new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(11, 16) === hm) return ms;
  }
  throw new Error('bad time');
}
let d0 = Date.now() + DAY;
while (new Date(`${lday(d0)}T12:00:00Z`).getUTCDay() !== 1) d0 += DAY;
const day = (n) => lday(d0 + n * DAY); // 1 Tue … 4 Fri

const P = {};
function task(text, daysAgo, note = 'Meetings/2026/09/2026-09-14 - Ops sync.md') {
  const r = taskStore.createTask({ text, source: 'meeting-promotion', origin_path: note, due_date: ymd(Date.now() + 3 * DAY) });
  const id = (r.task || r).id;
  db.run('UPDATE tasks SET created_at = ? WHERE id = ?', [new Date(Date.now() - daysAgo * DAY).toISOString().replace('T', ' ').slice(0, 19), id]);
  for (let i = 1; i <= 2; i += 1) taskStore.updateTask(id, { due_date: ymd(Date.now() + (3 + i) * DAY) });
  return `promise:${id}`;
}
const rows = (where = '1=1', params = []) => db.all(`SELECT * FROM promise_shadow_log WHERE ${where} ORDER BY id`, params);
const cal = (id, subject, d, hm) => db.run(`INSERT INTO calendar_cache (event_id, subject, start_time, end_time, is_all_day, show_as, attendees_other, source) VALUES (?, ?, ?, ?, 0, 'busy', 1, 'graph')`,
  [id, subject, `${d}T${hm}:00`, `${d}T${hm.slice(0, 2)}:59:00`]);
/** An earlier offer, appended to the shadow's own log exactly as a pass writes one. */
let seq = 0;
const offer = (key, d, hm) => db.run(`INSERT INTO promise_shadow_log (at, moment, kind, decision, promise_key, reason, payload_json, build_json) VALUES (?, ?, 'prompt', 'would-prompt', ?, 'seeded', '{}', '{}')`,
  [new Date(london(d, hm)).toISOString(), `seeded:${(seq += 1)}`, key]);

/** One tick through the REAL read-only Now; returns what it added and what it read. */
async function tick(d, hm) {
  const id0 = (db.get('SELECT COALESCE(MAX(id), 0) AS m FROM promise_shadow_log') || {}).m || 0;
  const s0 = shadow.stats(); const p0 = calls.presence;
  const t = london(d, hm);
  const res = await clock.at(t, () => shadow.tick({ now: t }));
  const s1 = shadow.stats();
  return { res, added: rows("id > ? AND kind NOT IN ('heartbeat')", [id0]), nowReads: s1.nowReads - s0.nowReads, avoided: s1.nowAvoided - s0.nowAvoided,
    snapshots: s1.snapshots - s0.snapshots, presence: calls.presence - p0 };
}
const payloadOf = (r) => JSON.parse(r.payload_json || '{}');

test.before(async () => {
  await db.init();
  clock.reportsSent([london(day(1), '12:30'), london(day(8), '12:30')]); // both simulated weeks' report to Chris, recorded as sent (see the clock helper)
  P.alex = task('Nick to send Alex Reed the list of ticket types blocked by skill gaps', 34);
  P.sam = task('Nick to write the onboarding guide for Sam Patel', 30);
  shadow.registerPromiseShadow({ PROMISE_SHADOW_ENABLED: 'true' }, { schedule: () => ({ stop() {} }) });
  shadow._resetRuntime();
});
test.after(() => {
  assert.deepEqual(doors, [], `an outbound door was reached: ${doors.join(', ')}`);
  assert.deepEqual(calls.other, [], `an unexpected network call: ${calls.other.join(', ')}`);
});

test('pure: a meeting moment carries every promise owed there; it needs Now while ANY remains offerable', () => {
  const at = london('2026-10-20', '13:35');
  const mk = (n) => ({ key: `promise:${n}`, firstSeen: `2026-09-0${n}`, sensitive: false, closed: false, owedTo: { resolved: 'Alex Reed' },
    judgement: { state: 'slipped', moves: 2 }, nextMeeting: { start: '2026-10-20T14:00', title: '1-2-1' } });
  const ps = [mk(1), mk(2)];
  const [m] = shadow.momentsAt(at, ps).filter((x) => x.type === 'meeting');
  assert.deepEqual(m.promiseKeys, ['promise:1', 'promise:2'], 'one moment, both promises');
  const one = [{ key: 'promise:1', at: '2026-10-20T07:30', meetingKey: null }];
  assert.equal(shadow.settledWithoutNow(m, { promises: ps, now: at, offered: one, date: '2026-10-20' }), null, 'promise:2 is still offerable → Now is needed');
  const both = [...one, { key: 'promise:2', at: '2026-10-20T12:30', meetingKey: null }];
  assert.equal(shadow.settledWithoutNow(m, { promises: ps, now: at, offered: both, date: '2026-10-20' }).reason, 'already offered earlier today');
  assert.equal(shadow.settledWithoutNow({ type: 'discovery', key: 'discovery:x' }, { promises: ps, now: at, offered: both, date: '2026-10-20' }), null, 'discovery always reads Now');
});

test('all candidates already offered today: the bundle is settled from history — no Now, no presence, no gate', async () => {
  const d = day(1);
  offer(P.alex, d, '07:30'); offer(P.sam, d, '07:35');
  const t = await tick(d, '12:30');
  assert.equal(t.nowReads, 0); assert.equal(t.presence, 0); assert.equal(t.avoided, 1);
  const w = t.added.find((r) => r.moment === `window:${d}:1`);
  assert.equal(w.kind, 'suppression'); assert.equal(w.reason, 'already offered earlier today');
  const p = payloadOf(w);
  assert.equal(p.canonicalNow, 'not_called'); assert.equal(p.decidedBy, 'history');
  assert.equal('gate' in p, false, 'no gate result is fabricated'); assert.equal('ctx' in p, false);
});

test('daily cap already reached: a pre-meeting moment is settled — no Now, no presence', async () => {
  const d = day(2);
  for (const k of ['promise:9001', 'promise:9002', 'promise:9003']) offer(k, d, '07:30'); // three offers today (since closed)
  cal('evt-sam2', '1-2-1 Nick / Sam Patel', d, '14:00');
  const t = await tick(d, '13:30');
  assert.equal(t.nowReads, 0); assert.equal(t.presence, 0);
  const m = t.added.find((r) => r.moment === `meeting:Sam Patel@${d}T14:00`);
  assert.equal(m.reason, '3 promise prompts already today');
  assert.equal(payloadOf(m).canonicalNow, 'not_called');
});

test('a bundle after the daily cap: settled — no Now, no presence', async () => {
  const d = day(2);
  const t = await tick(d, '17:30');
  assert.equal(t.nowReads, 0); assert.equal(t.presence, 0);
  const w = t.added.find((r) => r.moment === `window:${d}:2`);
  assert.equal(w.reason, '3 promise prompts already today'); assert.equal(payloadOf(w).canonicalNow, 'not_called');
});

test('a mixed meeting: Alex already offered, Sam still offerable → Now is read ONCE and the shared gate applies to both', async () => {
  const d = day(4);
  offer(P.alex, d, '07:30');
  cal('evt-mixed', 'Planning with Alex Reed and Sam Patel', d, '14:00');
  const t = await tick(d, '13:30');
  assert.equal(t.nowReads, 1); assert.equal(t.presence, 1);
  const a = t.added.find((r) => r.moment === `meeting:Alex Reed@${d}T14:00`);
  const s = t.added.find((r) => r.moment === `meeting:Sam Patel@${d}T14:00`);
  assert.equal(a.reason, 'already offered earlier today');
  assert.equal(payloadOf(a).canonicalNow, 'called');
  assert.ok(payloadOf(s).gate, 'Sam was judged by the real gate');
  assert.equal(payloadOf(s).canonicalNow, 'called');
  assert.notEqual(s.reason, 'already offered earlier today');
});

test('discovery is unchanged: Monday 07:30 reads Now even when every promise was offered today', async () => {
  const d = day(7);
  offer(P.alex, d, '07:05'); offer(P.sam, d, '07:06');
  const t = await tick(d, '07:30');
  assert.equal(t.nowReads, 1); assert.equal(t.presence, 1);
  const disc = t.added.find((r) => r.moment.startsWith('discovery:'));
  assert.ok(disc && payloadOf(disc).canonicalNow === 'called');
});

test('one person owed TWO promises, one offered earlier today: the meeting is NOT suppressed wholesale — Now is read and the other is judged', async () => {
  const d = day(8);
  fs.appendFileSync(path.join(V, 'Meetings/2026/09/2026-09-14 - Ops sync.md'), '- Nick to share the QA rubric with Alex Reed\n');
  P.alex2 = task('Nick to share the QA rubric with Alex Reed', 31);
  offer(P.alex, d, '07:30');
  cal('evt-alex2', '1-2-1 Nick / Alex Reed', d, '14:00');
  const t = await tick(d, '13:30');
  assert.equal(t.nowReads, 1); assert.equal(t.presence, 1);
  const m = t.added.find((r) => r.moment === `meeting:Alex Reed@${d}T14:00`);
  assert.notEqual(m.reason, 'already offered earlier today', 'the second promise is still offerable');
  assert.ok(payloadOf(m).gate, 'judged by the real gate');
  if (m.kind === 'prompt') assert.equal(m.promise_key, P.alex2, 'and if shown, it is the one not offered yet');
  db.run("UPDATE tasks SET status = 'done' WHERE id = ?", [Number(P.alex2.split(':')[1])]); // out of the way of the next test
});

test('two people’s meetings at once, where the selector prefers the SECOND person’s promise: the offer is logged under that person’s moment', async () => {
  const d = day(9);
  fs.appendFileSync(path.join(V, 'Meetings/2026/09/2026-09-14 - Ops sync.md'), '- Nick to share the budget plan with Casey Moore\n');
  P.casey = task('Nick to share the budget plan with Casey Moore', 40); // created last, but the oldest promise → picked first
  cal('evt-pair', 'Planning with Alex Reed and Casey Moore', d, '14:00');
  const t = await tick(d, '13:30');
  assert.equal(t.nowReads, 1);
  const prompts = t.added.filter((r) => r.kind === 'prompt');
  // Positive controls: both people have a moment, and Casey's (older) promise is the one the selector took.
  assert.ok(t.added.some((r) => r.moment === `meeting:Casey Moore@${d}T14:00`), 'Casey has a moment');
  assert.ok(t.added.some((r) => r.moment === `meeting:Alex Reed@${d}T14:00`), 'Alex has a moment');
  assert.ok(prompts.some((p) => p.promise_key === P.casey), 'the selector preferred Casey’s promise');
  for (const p of prompts) {
    const owed = p.promise_key === P.casey ? 'Casey Moore' : p.promise_key === P.alex ? 'Alex Reed' : null;
    assert.equal(p.moment, `meeting:${owed}@${d}T14:00`, `${p.promise_key} logged under its own person’s moment`);
  }
  assert.equal(new Set(prompts.map((p) => p.promise_key)).size, prompts.length, 'no promise twice');
});

test('counters: presence calls equal Now reads across the file; every avoided read is counted', () => {
  const s = shadow.stats();
  assert.equal(calls.presence, s.nowReads, 'localhost:3005 calls === Now reads');
  // Tue 12:30 (all offered) · Wed 13:30 (cap, meeting) · Wed 17:30 (cap, bundle).
  assert.equal(s.nowAvoided, 3);
  assert.equal(s.nowReads, 4, 'only the mixed meeting, discovery and the two multi-promise meetings read Now');
  const settled = rows("payload_json LIKE '%\"canonicalNow\":\"not_called\"%'");
  assert.equal(settled.length, 3);
  for (const r of settled) assert.equal('gate' in payloadOf(r), false, 'a settled row never carries a gate');
});
