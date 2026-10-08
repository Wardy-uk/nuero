'use strict';

/**
 * Build 20 — Ember care + personal-operations activation.
 *
 * Real scratch DB, real reminder/calendar ingest, the REAL world-model and
 * source-health projectors pumped from the real event log, real routes over
 * HTTP behind the real api-auth + authority guard. Anything that could notify
 * or send is stubbed to THROW, so a flow that reaches one fails loudly.
 *
 * Dates are offsets from TODAY (real clock), so no fixture ages into the past.
 * Numbering follows the Build 20 test list in the brief.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b20-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'b20.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-2020';
process.env.NEURO_API_TOKEN = 'machine-token-20';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
for (const k of ['APPLE_REMINDER_LISTS', 'PERSONAL_DEADLINE_MODE']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'vault', 'People'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'vault', 'Companions'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'vault', 'Companions', 'Ember.md'), '---\ntype: pet\nspecies: Dog\nbreed: Border Collie\nhousehold: true\n---\n\n# Ember\n');

const realDoors = [];
function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
const boom = (what) => async () => { realDoors.push(what); throw new Error(`${what} reached from a Build 20 flow`); };
stub('./webpush', { sendToAll: boom('webpush.sendToAll'), isConfigured: () => true });
stub('./email-sender', { sendMail: boom('email-sender.sendMail'), sendBriefEmail: boom('email-sender.sendBriefEmail'), OWN_ADDRESS: 'nickw@nurtur.tech' });

const db = require('../db/database');
const bus = require('./event-bus');
const wm = require('./world-model');
const sh = require('./source-health');
const cr = require('./canonical-read');
const apple = require('./apple-ingest');
const sc = require('./source-classification');
const audit = require('./reminder-audit');
const po = require('./personal-obligations');
const radar = require('./future-radar');
const cc = require('./companion-care');
const pw = require('./personal-world');
const taskStore = require('./task-store');

const pad = (n) => String(n).padStart(2, '0');
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const NOW = Date.now();
const TODAY = cc.localDay(NOW);
const plus = (n) => { const d = new Date(Date.UTC(+TODAY.slice(0, 4), +TODAY.slice(5, 7) - 1, +TODAY.slice(8, 10) + n)); return d.toISOString().slice(0, 10); };
const pump = async () => { await bus.pumpConsumer(wm.CONSUMER, { now: NOW }); await bus.pumpConsumer(sh.CONSUMER, { now: NOW }); };
const EMBER = 'companion:ember';

let server;
let base;
test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api', require('./api-auth'));
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/canonical', require('../routes/canonical'));
  app.use('/api/apple', require('../routes/apple'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  pw.publishCompanions({ now: NOW });
  await pump();
});
test.after(() => { if (server) server.close(); });

const AS = { nick: { 'X-Neuro-Pin': 'pin-2020' }, machine: { 'X-Neuro-Api-Token': 'machine-token-20' } };
async function call(method, url, who = 'nick', body, extra = {}) {
  const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...AS[who], ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const enc = encodeURIComponent;

// ── fixtures ─────────────────────────────────────────────────────────────────

const LISTS = [
  { id: 'L-REM-1', title: 'Reminders' }, { id: 'L-REM-2', title: 'Reminders' },
  { id: 'L-BATH', title: 'Bathroom' }, { id: 'L-ADMIN', title: 'Personal Admin' }, { id: 'L-EMBER', title: 'Ember' },
];
// The phone sends EVERY reminder on every push (a complete read concludes
// removals), so the fixture keeps a running phone and always sends all of it.
const PHONE = new Map();
function pushReminders(reminders, { complete = true, lists = LISTS } = {}) {
  for (const x of reminders) PHONE.set(x.id, x);
  const r = apple.ingestReminders({ reminders: [...PHONE.values()], lists, complete, client: 'neuro' }, { now: NOW });
  assert.equal(r.ok, true, r.error);
  return r;
}
const CALS = [{ id: 'C-HOME', title: 'Home' }, { id: 'C-UNI', title: 'Open Uni' }];
const at = (day, hm = null) => (hm ? `${day}T${hm}:00` : `${day}T00:00:00`);
function pushCalendar(events) {
  const r = apple.ingestCalendar({ from: `${plus(-1)}T00:00:00`, to: `${plus(60)}T00:00:00`, events, calendars: CALS, client: 'saim' });
  assert.equal(r.ok, true, r.error);
  return r;
}
const allDay = (id, title, day, cal) => ({ id, title, start: at(day), end: at(plus(1 + Math.round((Date.parse(day) - Date.parse(TODAY)) / 864e5))), isAllDay: true, calendar: cal.title, calendarId: cal.id });
const timed = (id, title, day, hm, cal) => ({ id, title, start: at(day, hm), end: at(day, '23:00'), isAllDay: false, calendar: cal.title, calendarId: cal.id });
const reminderTasks = () => cr.tasks({ status: 'all', system: 'eventkit-reminders', now: NOW }).items;
const listRow = (id) => audit.read({ now: NOW }).lists.find((l) => l.listId === id);
const classifyList = (id, body) => call('POST', '/api/canonical/classifications', 'nick', { kind: 'reminder-list', sourceKey: `reminders:id:${id}`, ...body });
const meetingId = (title) => (db.get('SELECT meeting_id FROM wm_meetings WHERE title = ? ORDER BY meeting_id LIMIT 1', [title]) || {}).meeting_id;
const radarItems = (h = 30) => radar.read({ now: NOW, horizonDays: h }).items;
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ═══ REMINDERS ═══════════════════════════════════════════════════════════════

test('1. a list named "Reminders" is NOT tracked by its name', async () => {
  pushReminders([{ id: 'R-1', title: 'Fix the shed door', list: 'Reminders', listId: 'L-REM-1', isCompleted: false }]);
  await pump();
  assert.equal(reminderTasks().some((t) => t.id === 'task:eventkit-reminders:R-1'), false, 'the name alone reads nothing');
  const row = listRow('L-REM-1');
  assert.equal(row.tracked, false);
  assert.equal(row.trackingState, 'unknown');
  assert.equal(sc.isTracked({ id: 'L-REM-1', title: 'Reminders' }), false);
  // Positive control: the same list, explicitly tracked, is read.
  const r = await classifyList('L-REM-1', { tracked: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  pushReminders([{ id: 'R-1', title: 'Fix the shed door', list: 'Reminders', listId: 'L-REM-1', isCompleted: false }]);
  await pump();
  assert.ok(reminderTasks().some((t) => t.id === 'task:eventkit-reminders:R-1'));
});

test('2. two lists both called "Reminders" stay independent — tracking one never tracks the other', async () => {
  pushReminders([{ id: 'R-2', title: 'Order bird seed', list: 'Reminders', listId: 'L-REM-2', isCompleted: false }]);
  await pump();
  assert.equal(listRow('L-REM-1').trackingState, 'tracked');
  assert.equal(listRow('L-REM-2').trackingState, 'unknown');
  assert.equal(reminderTasks().some((t) => t.id === 'task:eventkit-reminders:R-2'), false);
  const a = listRow('L-REM-1'); const b = listRow('L-REM-2');
  assert.ok(a.disambiguator && b.disambiguator && a.disambiguator !== b.disambiguator, 'each says which "Reminders" it is');
  assert.match(a.disambiguator, /^List [12] of 2$/);
  const cls = sc.listContainers({ now: NOW }).filter((c) => c.kind === 'reminder-list' && c.label === 'Reminders' && c.keyedBy === 'id');
  assert.equal(cls.length, 2);
  assert.deepEqual(cls.map((c) => c.twin.index).sort(), [1, 2], 'a stable ordinal per list');
});

test('3. tracking is keyed on the stable id — a by-name key cannot carry it', async () => {
  const bad = await call('POST', '/api/canonical/classifications', 'nick', { kind: 'reminder-list', sourceKey: 'reminders:title:reminders', tracked: true });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /list id/);
  // A by-name row's stored tracking (made before Build 20) is not honoured either.
  db.run(`INSERT OR REPLACE INTO source_classifications (kind, source_key, label, domains_json, tracked, set_at) VALUES ('reminder-list', 'reminders:title:bathroom', 'Bathroom', NULL, 1, ?)`, [new Date(NOW).toISOString()]);
  assert.equal(sc.isTracked({ id: null, title: 'Bathroom' }), false);
  assert.equal(sc.isTracked({ id: 'L-BATH', title: 'Bathroom' }), false, 'the id-keyed list is still undecided');
  db.run("DELETE FROM source_classifications WHERE source_key = 'reminders:title:bathroom'");
});

test('4. classification does not imply tracking (Bathroom: Family, not tracked)', async () => {
  const r = await classifyList('L-BATH', { domains: ['family'] });
  assert.equal(r.status, 200);
  pushReminders([{ id: 'R-B1', title: 'Regrout the tiles', list: 'Bathroom', listId: 'L-BATH', isCompleted: false }]);
  await pump();
  const row = listRow('L-BATH');
  assert.equal(row.classification.state, 'classified');
  assert.equal(row.trackingState, 'unknown');
  assert.ok(row.flags.includes('classified-but-not-tracked'));
  assert.equal(reminderTasks().some((t) => t.id === 'task:eventkit-reminders:R-B1'), false);
});

test('5. tracking does not imply classification (a tracked list stays domain-unknown)', async () => {
  const row = listRow('L-REM-1');
  assert.equal(row.trackingState, 'tracked');
  assert.equal(row.classification.state, 'unknown');
  const t = reminderTasks().find((x) => x.id === 'task:eventkit-reminders:R-1');
  assert.deepEqual(t.domains.domains, [], 'no domain was invented for it');
});

test('6. an ignored list stays ignored — and its held reminders leave every read at once', async () => {
  assert.ok(reminderTasks().some((t) => t.id === 'task:eventkit-reminders:R-1'), 'positive control: read while tracked');
  const r = await classifyList('L-REM-1', { tracked: false });
  assert.equal(r.status, 200);
  for (let i = 0; i < 2; i += 1) pushReminders([{ id: 'R-1', title: 'Fix the shed door', list: 'Reminders', listId: 'L-REM-1', isCompleted: false }]);
  await pump();
  assert.equal(listRow('L-REM-1').trackingState, 'ignored');
  assert.equal(reminderTasks().some((t) => t.id === 'task:eventkit-reminders:R-1'), false, 'gone from the canonical read');
  assert.equal(po.read({ now: NOW }).items.some((o) => o.id === 'task:eventkit-reminders:R-1'), false);
  // Not published as removed: re-tracking brings it straight back.
  await classifyList('L-REM-1', { tracked: true });
  assert.ok(reminderTasks().some((t) => t.id === 'task:eventkit-reminders:R-1' && t.state === 'open'));
  const act = require('./activity-timeline').fromPersonalOps(db.all("SELECT * FROM personal_ops_events WHERE kind = 'list-tracking' AND subject_id = 'reminders:id:L-REM-1' ORDER BY id"));
  assert.deepEqual(act.map((a) => a.headline.replace(/.*reminder list /, '')), ['to be tracked', 'as ignored', 'to be tracked']);
});

test('7. a machine cannot change tracking or classification', async () => {
  const r = await call('POST', '/api/canonical/classifications', 'machine', { kind: 'reminder-list', sourceKey: 'reminders:id:L-REM-2', tracked: true });
  assert.equal(r.status, 403);
  assert.equal(listRow('L-REM-2').trackingState, 'unknown');
  // The gateway half (api-policy `interactive`) is pinned by authority-matrix.test.js.
  const m = require('./authority-matrix');
  const rule = m.ROUTE_RULES ? m.ROUTE_RULES.find((x) => x.path === '/api/canonical/classifications') : null;
  if (rule) assert.equal(rule.machine, 'refuse');
});

// ═══ EMBER ═══════════════════════════════════════════════════════════════════

test('8. Ember is a companion (pet), never a Person', async () => {
  const c = pw.listCompanions().find((x) => x.id === EMBER);
  assert.ok(c);
  assert.equal(c.entityType, 'pet');
  assert.equal(c.breed, 'Border Collie');
  assert.equal(db.get("SELECT COUNT(*) n FROM wm_people WHERE display_name = 'Ember'").n, 0);
  const res = await call('GET', `/api/canonical/companions/${enc(EMBER)}/care`, 'nick');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.companion.entityType, 'pet');
});

test('9. a title that mentions Ember is a mention, never a care link', async () => {
  await classifyList('L-EMBER', { tracked: true });
  pushReminders([{ id: 'R-E1', title: 'Buy Ember a new lead', list: 'Ember', listId: 'L-EMBER', isCompleted: false, dueDate: plus(3) }]);
  await pump();
  const care = cc.read(EMBER, { now: NOW });
  assert.equal(care.linked.length, 0);
  assert.ok(care.mentions.some((m) => m.entityId === 'task:eventkit-reminders:R-E1' && m.basis === 'inference'));
  assert.equal(db.get('SELECT COUNT(*) n FROM companion_links').n, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM companion_care_items').n, 0);
});

test('10. an explicit TASK link works (NEURO task)', async () => {
  const t = taskStore.createTask({ text: 'Book Ember\'s grooming', source: 'manual', dueDate: plus(6) });
  require('./obligation-sources').publishNeuroTasks({ now: NOW });
  await pump();
  const id = `task:neuro:${t.id}`;
  const r = await call('POST', `/api/canonical/companions/${enc(EMBER)}/links`, 'nick', { entityId: id, careKind: 'grooming', label: 'grooming' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const care = cc.read(EMBER, { now: NOW });
  const l = care.linked.find((x) => x.entityId === id);
  assert.equal(l.found, true);
  assert.equal(l.careKind, 'grooming');
  const ob = po.read({ now: NOW }).items.find((o) => o.id === id);
  assert.ok(ob, 'linking makes it a personal obligation');
  assert.ok(ob.whyPersonal.some((w) => /Ember's care/.test(w)));
  assert.equal(care.mentions.some((m) => m.entityId === id), false, 'a linked item is not also listed as a mention');
  const missing = await call('POST', `/api/canonical/companions/${enc(EMBER)}/links`, 'nick', { entityId: 'task:neuro:999999', careKind: 'vet' });
  assert.equal(missing.status, 404, 'a link to something NEURO does not hold is refused');
});

test('11. an explicit REMINDER link works', async () => {
  const r = await call('POST', `/api/canonical/companions/${enc(EMBER)}/links`, 'nick', { entityId: 'task:eventkit-reminders:R-E1', careKind: 'other' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const l = cc.read(EMBER, { now: NOW }).linked.find((x) => x.entityId === 'task:eventkit-reminders:R-E1');
  assert.equal(l.source, 'Reminders');
  assert.equal(l.status, 'open');
});

test('12. an explicit CALENDAR link works', async () => {
  await call('POST', '/api/canonical/classifications', 'nick', { kind: 'calendar', sourceKey: 'eventkit-cal:id:C-HOME', domains: ['home'] });
  pushCalendar([timed('E-VET', 'Vets — booster', plus(4), '10:30', CALS[0])]);
  await pump();
  const mid = meetingId('Vets — booster');
  assert.ok(mid);
  const r = await call('POST', `/api/canonical/companions/${enc(EMBER)}/links`, 'nick', { entityId: `meeting:${mid}`, careKind: 'vet' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const l = cc.read(EMBER, { now: NOW }).linked.find((x) => x.entityId === `meeting:${mid}`);
  assert.equal(l.kindOf, 'meeting');
  assert.equal(l.day, plus(4));
  const item = radarItems(14).find((i) => i.sourceRefs.includes(mid));
  assert.equal(item.companion.name, 'Ember');
  assert.ok(item.whyVisible.some((w) => /linked it to Ember's care \(vet\)/.test(w)));
});

test('13. a care item is never auto-created — every row is one Nick made', async () => {
  const before = db.get('SELECT COUNT(*) n FROM companion_care_items').n;
  cc.read(EMBER, { now: NOW });
  radar.read({ now: NOW, horizonDays: 30 });
  radar.refresh({ now: NOW });
  po.read({ now: NOW });
  assert.equal(db.get('SELECT COUNT(*) n FROM companion_care_items').n, before, 'reads and the Radar job create nothing');
  assert.equal(before, 0);
  const r = await call('POST', `/api/canonical/companions/${enc(EMBER)}/care`, 'nick', { kind: 'vet', title: 'Annual check', dueDate: plus(20) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(db.get('SELECT COUNT(*) n FROM companion_care_items').n, 1);
  const machine = await call('POST', `/api/canonical/companions/${enc(EMBER)}/care`, 'machine', { kind: 'flea', title: 'Flea', dueDate: plus(2) });
  assert.equal(machine.status, 403, 'a machine cannot add care');
});

test('14. no invented recurrence — a next date comes only from a repeat Nick set', async () => {
  const one = await call('POST', `/api/canonical/companions/${enc(EMBER)}/care`, 'nick', { kind: 'vaccination', title: 'Lepto booster', dueDate: plus(2) });
  const done = await call('POST', `/api/canonical/care/${enc(one.json.item.id)}/done`, 'nick', {});
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.nextDue, null, 'no repeat set → nothing scheduled');
  assert.equal(done.json.item.status, 'done');
  const flea = await call('POST', `/api/canonical/companions/${enc(EMBER)}/care`, 'nick', { kind: 'flea', title: 'Flea treatment', dueDate: plus(1), recurrence: { every: 4, unit: 'week' } });
  const d2 = await call('POST', `/api/canonical/care/${enc(flea.json.item.id)}/done`, 'nick', { doneOn: TODAY });
  assert.equal(d2.json.nextDue, plus(28), 'four weeks from the day it was done, as Nick set it');
  assert.equal(d2.json.item.status, 'open');
  assert.equal(d2.json.item.recurrenceWords, 'every 4 weeks');
  assert.equal(cc.nextDate('2026-01-31', { every: 1, unit: 'month' }), '2026-02-28', 'month-end clamps');
  assert.equal(cc.validateItem({ kind: 'worm', title: 'Worming', recurrence: { every: 3, unit: 'month' } }).ok, false, 'a repeat needs Nick\'s own next date');
  assert.equal(cc.parseRecurrence({ every: 1, unit: 'fortnight' }).ok, false);
});

test('15. a dog walk is never inferred from Nick walking', async () => {
  db.run(`INSERT INTO health_workouts (source_uuid, activity_type, started_at, ended_at, duration_seconds) VALUES ('W-WALK', 'Walking', ?, ?, 3600)`, [`${TODAY}T07:00:00Z`, `${TODAY}T08:00:00Z`]);
  const care = cc.read(EMBER, { now: NOW });
  assert.notEqual(care.walk.today.state, 'confirmed');
  const src = stripComments(fs.readFileSync(path.join(__dirname, 'companion-care.js'), 'utf8'));
  // Code reads, not English: the rule sentence shown to Nick names these things
  // precisely in order to say they are NOT read.
  for (const token of ['health_workouts', 'health_samples', 'health_daily', 'apple-health', "'./location", 'location-history', 'place-sensing', 'activity_type', 'device-status']) {
    assert.equal(src.includes(token), false, `companion-care reads ${token}`);
  }
  // Positive control: the scan does see a read when one is there.
  assert.equal(stripComments("db.all('SELECT * FROM health_workouts')").includes('health_workouts'), true);
});

test('16. an explicit walk confirmation works — and only for a day that has happened', async () => {
  const before = cc.read(EMBER, { now: NOW }).walk.today;
  assert.equal(before.state, 'not_applicable', 'walks not set up → not applicable, never "no evidence"');
  const r = await call('POST', `/api/canonical/companions/${enc(EMBER)}/walks`, 'nick', { mark: 'walked' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const care = cc.read(EMBER, { now: NOW });
  assert.equal(care.walk.today.state, 'confirmed');
  assert.equal(care.walk.history[0].state, 'no_evidence', 'yesterday: walks set up, nothing recorded');
  const future = await call('POST', `/api/canonical/companions/${enc(EMBER)}/walks`, 'nick', { mark: 'walked', day: plus(1) });
  assert.equal(future.status, 400);
  const machine = await call('POST', `/api/canonical/companions/${enc(EMBER)}/walks`, 'machine', { mark: 'walked', day: plus(-1) });
  assert.equal(machine.status, 403);
  // Pure: planned / recording gap / not applicable.
  const s = (o) => cc.walkDay({ day: TODAY, today: TODAY, setUp: true, ...o }).state;
  assert.equal(s({ items: [{ kind: 'walk', status: 'open', dueDate: TODAY, title: 'Evening walk' }] }), 'planned');
  assert.equal(s({ linked: [{ kindOf: 'task', status: 'open', dueDate: TODAY, title: 'Walk', source: 'Reminders' }], remindersFresh: false, items: [] }), 'planned');
  assert.equal(cc.walkDay({ day: plus(-1), today: TODAY, setUp: true, linked: [{ kindOf: 'task', status: 'open', dueDate: plus(-1), title: 'Walk', source: 'Reminders' }], remindersFresh: false }).state, 'recording_gap');
  assert.equal(s({ mark: 'not-applicable' }), 'not_applicable');
});

test('17. no missing-walk push is ever created', async () => {
  await pump();
  radar.refresh({ now: NOW });
  cc.read(EMBER, { now: NOW });
  assert.deepEqual(realDoors, []);
  const src = stripComments(fs.readFileSync(path.join(__dirname, 'companion-care.js'), 'utf8'));
  for (const door of ['webpush', 'sendToAll', 'ambient-push', 'attention', 'nudges', 'email-sender']) {
    assert.equal(src.includes(door), false, `companion-care reaches ${door}`);
  }
});

test('18. the Radar includes explicit Ember care — and only that', async () => {
  const items = radarItems(30).filter((i) => i.kind === 'care');
  const titles = items.map((i) => i.title).sort();
  assert.deepEqual(titles, ['Ember — flea treatment', 'Ember — vet appointment']);
  const vet = items.find((i) => i.careKind === 'vet');
  assert.equal(vet.actionState, 'planned');
  assert.equal(vet.attention.eligible, false, 'an appointment on its own never interrupts');
  const flea = items.find((i) => i.careKind === 'flea');
  assert.equal(flea.actionState, 'preparation_open');
  assert.ok(flea.whyVisible.some((w) => /every 4 weeks, as you set it/.test(w)));
  // A treatment due tomorrow may ask the policy; nothing pushes.
  const pure = cc.careStatus({ status: 'open', kind: 'flea', dueDate: plus(1) }, TODAY);
  assert.equal(pure.actionState, 'needs_you');
  assert.equal(cc.careStatus({ status: 'open', kind: 'vet', dueDate: plus(1) }, TODAY).actionState, 'planned');
  assert.deepEqual(realDoors, []);
});

// ═══ PERSONAL ADMIN ══════════════════════════════════════════════════════════

test('19. an admin item needs an explicit source — wording alone is not admin', async () => {
  const act0 = po.adminActivation(audit.read({ now: NOW }).lists);
  assert.ok(['not-set-up', 'list-waiting'].includes(act0.state), act0.state);
  assert.ok(act0.steps.length >= 2);
  pushReminders([{ id: 'R-MOT', title: 'Car MOT', list: 'Personal Admin', listId: 'L-ADMIN', isCompleted: false, dueDate: plus(10) }]);
  await pump();
  assert.equal(po.read({ now: NOW, adminOnly: true }).items.length, 0, 'a list NAMED "Personal Admin" is not admin until Nick says so');
  // 8 Oct 2026: once it has ARRIVED, the card offers it to decide — it never
  // says "go and create it" again, and it is offered, never read.
  const waiting = po.adminActivation(audit.read({ now: NOW }).lists);
  assert.equal(waiting.state, 'list-waiting');
  assert.ok(waiting.candidates.some((c) => c.name === 'Personal Admin' && /L-ADMIN/.test(c.sourceKey)), JSON.stringify(waiting.candidates));
  assert.ok(!waiting.steps.some((x) => /create a list/.test(x)), 'the create-it step is gone once the list exists');
  await classifyList('L-ADMIN', { domains: ['admin'] });
  assert.equal(po.adminActivation(audit.read({ now: NOW }).lists).state, 'classified-not-tracked');
  await classifyList('L-ADMIN', { tracked: true });
  assert.equal(po.adminActivation(audit.read({ now: NOW }).lists).state, 'active');
  pushReminders([{ id: 'R-MOT', title: 'Car MOT', list: 'Personal Admin', listId: 'L-ADMIN', isCompleted: false, dueDate: plus(10) },
    { id: 'R-INS', title: 'Home insurance renewal', list: 'Personal Admin', listId: 'L-ADMIN', isCompleted: false }]);
  await pump();
  const admin = po.read({ now: NOW, adminOnly: true }).items;
  assert.ok(admin.some((o) => o.id === 'task:eventkit-reminders:R-MOT' && o.admin));
});

test('20. an admin due date enters the Radar on that date', async () => {
  const items = radarItems(14);
  const mot = items.find((i) => i.id === 'task:eventkit-reminders:R-MOT');
  assert.ok(mot);
  assert.equal(mot.kind, 'admin');
  assert.equal(mot.date, plus(10));
  assert.equal(mot.actionState, 'preparation_open');
  assert.equal(radarItems(7).some((i) => i.id === 'task:eventkit-reminders:R-MOT'), false, 'outside a 7-day horizon');
});

test('21. completion removes actionability', async () => {
  pushReminders([{ id: 'R-MOT', title: 'Car MOT', list: 'Personal Admin', listId: 'L-ADMIN', isCompleted: true, completedAt: new Date(NOW).toISOString(), dueDate: plus(10) },
    { id: 'R-INS', title: 'Home insurance renewal', list: 'Personal Admin', listId: 'L-ADMIN', isCompleted: false }]);
  await pump();
  assert.equal(po.read({ now: NOW, adminOnly: true }).items.some((o) => o.id === 'task:eventkit-reminders:R-MOT'), false);
  assert.equal(radarItems(14).some((i) => i.id === 'task:eventkit-reminders:R-MOT'), false);
});

test('22. no renewal date is invented', async () => {
  const ins = po.read({ now: NOW, adminOnly: true }).items.find((o) => o.id === 'task:eventkit-reminders:R-INS');
  assert.ok(ins, 'the undated item is listed');
  assert.equal(ins.due, null, 'and stays undated');
  assert.equal(radarItems(30).some((i) => i.id === 'task:eventkit-reminders:R-INS'), false, 'an undated item never lands on a guessed day');
});

test('23. an optional vehicle link works — context, never a date', async () => {
  const t = taskStore.createTask({ text: 'Book the car in for a service', source: 'manual' });
  require('./obligation-sources').publishNeuroTasks({ now: NOW });
  await pump();
  const id = `task:neuro:${t.id}`;
  assert.equal(po.read({ now: NOW, adminOnly: true }).items.some((o) => o.id === id), false, '"car" in the words links nothing');
  const r = await call('POST', '/api/canonical/vehicle-links', 'nick', { vehicle: 'Car', entityId: id, label: 'service' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const ob = po.read({ now: NOW, adminOnly: true }).items.find((o) => o.id === id);
  assert.ok(ob);
  assert.deepEqual(ob.vehicles.map((v) => v.name), ['car']);
  assert.equal(ob.due, null);
  assert.ok(ob.whyPersonal.some((w) => /linked it to the car/.test(w)));
  assert.equal((await call('POST', '/api/canonical/vehicle-links', 'machine', { vehicle: 'van', entityId: id })).status, 403);
  const un = await call('POST', '/api/canonical/vehicle-links/remove', 'nick', { vehicle: 'car', entityId: id });
  assert.equal(un.json.removed, true);
});

test('24. nothing here acts outside NEURO', () => {
  assert.deepEqual(realDoors, []);
  for (const f of ['companion-care.js', 'personal-obligations.js', 'reminder-audit.js']) {
    const src = stripComments(fs.readFileSync(path.join(__dirname, f), 'utf8'));
    for (const door of ['graphWrite', 'sendMail', 'sendToAll', 'fetch(', 'action-executor']) assert.equal(src.includes(door), false, `${f} reaches ${door}`);
  }
});

// ═══ DATE PREPARATION ════════════════════════════════════════════════════════

const anniversary = () => radarItems(30).find((i) => i.kind === 'anniversary');

test('25. the anniversary stays passive without preparation', async () => {
  pushCalendar([timed('E-VET', 'Vets — booster', plus(4), '10:30', CALS[0]), allDay('E-ANN', 'Wedding anniversary', plus(11), CALS[0])]);
  await pump();
  const a = anniversary();
  assert.ok(a, 'positive control: the date is on the Radar');
  assert.equal(a.actionState, 'none');
  assert.equal(a.attention.eligible, false);
});

test('26. an explicit preparation link works', async () => {
  const t = taskStore.createTask({ text: 'Buy an anniversary card', source: 'manual', dueDate: plus(9) });
  require('./obligation-sources').publishNeuroTasks({ now: NOW });
  await pump();
  const id = `task:neuro:${t.id}`;
  const r = await call('POST', '/api/canonical/prep-links', 'nick', { subjectId: anniversary().id, entityId: id, label: 'card' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(anniversary().linkedTaskRefs.includes(id));
});

test('27. open preparation shows preparation_open', () => {
  const a = anniversary();
  assert.equal(a.actionState, 'preparation_open');
  assert.ok(a.whyVisible.some((w) => /preparation is open/.test(w)));
});

test('28. ≤2 days away with prep still open may become needs_you — never a push', () => {
  const near = radar.composeRadar({
    today: TODAY, horizonDays: 7,
    dates: [{ id: 'pd:anniv', title: 'Wedding anniversary', date: plus(2), kind: 'anniversary', sources: [{ basis: 'declared', note: 'People/Helen.md' }], prep: [] }],
    prepBySubject: new Map([['pd:anniv', [{ taskId: 'task:neuro:1', title: 'Buy card', status: 'open' }]]]),
  });
  assert.equal(near.items[0].actionState, 'needs_you');
  assert.equal(near.items[0].attention.eligible, true, 'the policy may be asked');
  const far = radar.composeRadar({
    today: TODAY, horizonDays: 7,
    dates: [{ id: 'pd:anniv', title: 'Wedding anniversary', date: plus(3), kind: 'anniversary', sources: [{ basis: 'declared', note: 'People/Helen.md' }], prep: [] }],
    prepBySubject: new Map([['pd:anniv', [{ taskId: 'task:neuro:1', title: 'Buy card', status: 'open' }]]]),
  });
  assert.equal(far.items[0].actionState, 'preparation_open', '3 days away is still preparation');
  assert.deepEqual(realDoors, []);
});

test('29. completed preparation clears the action state', async () => {
  const id = anniversary().linkedTaskRefs[0];
  taskStore.updateTask(Number(id.replace('task:neuro:', '')), { status: 'done' });
  require('./obligation-sources').publishNeuroTasks({ now: NOW });
  await pump();
  const a = anniversary();
  assert.equal(a.actionState, 'none');
  assert.ok(a.whyVisible.some((w) => /preparation done/.test(w)));
});

test('30. no preparation task is ever auto-created', async () => {
  const before = db.get('SELECT COUNT(*) n FROM tasks').n;
  const wmBefore = db.get('SELECT COUNT(*) n FROM wm_tasks').n;
  radar.read({ now: NOW, horizonDays: 30 });
  radar.refresh({ now: NOW });
  require('./personal-dates').read({ now: NOW });
  assert.equal(db.get('SELECT COUNT(*) n FROM tasks').n, before);
  assert.equal(db.get('SELECT COUNT(*) n FROM wm_tasks').n, wmBefore);
});

// ═══ OPEN UNI + ACTIVITY ═════════════════════════════════════════════════════

test('20D. reclassifying a calendar is explicit and per calendar — not "anything called Uni"', async () => {
  await call('POST', '/api/canonical/classifications', 'nick', { kind: 'calendar', sourceKey: 'eventkit-cal:id:C-UNI', domains: ['home'] });
  pushCalendar([timed('E-VET', 'Vets — booster', plus(4), '10:30', CALS[0]), allDay('E-ANN', 'Wedding anniversary', plus(11), CALS[0]), timed('E-TMA', 'TMA 02 due', plus(6), '12:00', CALS[1])]);
  await pump();
  const r = await call('POST', '/api/canonical/classifications', 'nick', { kind: 'calendar', sourceKey: 'eventkit-cal:id:C-UNI', domains: ['learning'] });
  assert.equal(r.status, 200);
  const tma = radarItems(14).find((i) => i.title === 'TMA 02 due');
  assert.deepEqual(tma.domains, ['learning']);
  assert.equal(sc.classificationMap('calendar').get('eventkit-cal:id:C-UNI').tracked, null, 'tracking untouched');
  const lines = db.all("SELECT * FROM personal_ops_events WHERE kind = 'calendar-classified' AND subject_id = 'eventkit-cal:id:C-UNI'");
  assert.equal(lines.length, 2, 'one Activity line per decision');
});

test('20U. Activity is semantic — care and links are lines; walks and reads are not', () => {
  const kinds = db.all('SELECT kind, COUNT(*) n FROM personal_ops_events GROUP BY kind').reduce((m, r) => ({ ...m, [r.kind]: r.n }), {});
  assert.ok(kinds['care-item-created'] >= 3);
  assert.ok(kinds['care-item-completed'] >= 2);
  assert.ok(kinds['care-link-added'] >= 3);
  assert.ok(kinds['vehicle-link-added'] >= 1);
  assert.equal(Object.keys(kinds).some((k) => /walk/.test(k)), false, 'no walk is logged');
  const rows = db.all('SELECT * FROM personal_ops_events ORDER BY id');
  const act = require('./activity-timeline').fromPersonalOps(rows);
  assert.equal(act.length, rows.length, 'every kind has a template');
  for (const a of act) assert.ok(a.headline && !/undefined|null/.test(a.headline), a.headline);
});

// ═══ LEAD REMINDERS (Nick, 8 Oct 2026: anniversary at 10 / 5 / 1 days) ══════

const dn = require('./date-nags');
const ANN = (away) => ({ id: `pd:anniversary:title:x:${plus(away)}`, title: 'Wedding anniversary', date: plus(away), kind: 'anniversary' });
const stageAt = (away, prep = []) => dn.reminderStage(ANN(away), { today: TODAY, offsets: [10, 5, 1], prep });

test('L1. graduated steps — 10 is context, 5 a stronger prompt, 1 Needs You and the only push', () => {
  assert.equal(stageAt(11), null, 'before the first step: nothing');
  assert.deepEqual([stageAt(10).stage, stageAt(10).push], ['context', false]);
  assert.match(stageAt(10).line, /in 10 days/);
  assert.equal(stageAt(7).stage, 'context');
  assert.deepEqual([stageAt(5).stage, stageAt(5).push], ['prompt', false]);
  assert.match(stageAt(5).line, /in 5 days .*Nothing prepared yet\.$/);
  assert.equal(stageAt(3).stage, 'prompt');
  assert.deepEqual([stageAt(1).stage, stageAt(1).push], ['needs_you', true]);
  assert.match(stageAt(1).line, /is tomorrow/);
  assert.equal(stageAt(0).stage, 'needs_you');
  assert.equal(stageAt(-1), null, 'a passed date says nothing');
  assert.equal(dn.reminderStage(ANN(1), { today: TODAY, offsets: null }), null, 'no cadence set → nothing at all');
});

test('L2. completed prep suppresses the prompt and the push; open prep is named instead of "nothing prepared"', () => {
  const done = [{ title: 'Book the meal', status: 'completed' }];
  const open = [{ title: 'Buy a card', status: 'open' }];
  assert.equal(stageAt(5, done).stage, 'context');
  assert.match(stageAt(5, done).line, /Prep done: "Book the meal"/);
  assert.equal(stageAt(1, done).push, false, 'prep done → no notification');
  assert.equal(stageAt(5, open).stage, 'prompt');
  assert.match(stageAt(5, open).line, /Still open: "Buy a card"\.$/);
  assert.equal(stageAt(1, open).push, true);
  assert.doesNotMatch(stageAt(1, open).line, /Nothing prepared/);
});

test('L3. the cadence is per kind, Nick-only, refused not clamped', async () => {
  assert.equal(dn.parseOffsets([10, 5, 1, 99]).ok, false);
  assert.deepEqual(dn.parseOffsets([1, 10, 5, 5]).value, [10, 5, 1]);
  const m = await call('POST', '/api/canonical/lead-reminders', 'machine', { kind: 'anniversary', offsets: [10, 5, 1] });
  assert.equal(m.status, 403);
  const bad = await call('POST', '/api/canonical/lead-reminders', 'nick', { kind: 'wedding', offsets: [1] });
  assert.equal(bad.status, 400);
  const r = await call('POST', '/api/canonical/lead-reminders', 'nick', { kind: 'anniversary', offsets: [10, 5, 1] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(dn.cadences(), { anniversary: [10, 5, 1] }, 'birthdays untouched');
  const act = require('./activity-timeline').fromPersonalOps(db.all("SELECT * FROM personal_ops_events WHERE kind = 'lead-reminders-set'"));
  assert.match(act[0].headline, /anniversary lead reminders: 10, 5, 1 days before/);
});

test('L4. the Radar and the push agree — Needs You at 1 day, pushed ONCE, and a failed push is retried', async () => {
  pushCalendar([timed('E-VET', 'Vets — booster', plus(4), '10:30', CALS[0]), allDay('E-ANN', 'Wedding anniversary', plus(11), CALS[0]),
    timed('E-TMA', 'TMA 02 due', plus(6), '12:00', CALS[1]), allDay('E-ANN2', 'Mum and Dad anniversary', plus(1), CALS[0])]);
  await pump();
  const item = radarItems(14).find((i) => i.title === 'Mum and Dad anniversary');
  assert.equal(item.actionState, 'needs_you');
  assert.equal(item.reminder.stage, 'needs_you');
  assert.equal(item.attention.eligible, true);
  const far = radarItems(14).find((i) => i.title === 'Wedding anniversary');
  assert.equal(far.reminder, null, '11 days out is before the first step');
  const noon = Date.parse(`${TODAY}T12:00:00Z`);
  const early = Date.parse(`${TODAY}T06:00:00Z`);
  const sent = [];
  assert.equal((await dn.run({ now: early, send: async (t, b) => sent.push(b) })).sent, 0, 'nothing before 09:00');
  const failed = await dn.run({ now: noon, send: async () => { throw new Error('push down'); } });
  assert.equal(failed.sent, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM personal_date_nag_sends').n, 0, 'a failed push releases its claim');
  const r1 = await dn.run({ now: noon, send: async (t, b, data) => sent.push({ t, b, data }) });
  const r2 = await dn.run({ now: noon + 1800000, send: async (t, b, data) => sent.push({ t, b, data }) });
  assert.equal(r1.sent, 1);
  assert.equal(r2.sent, 0, 'never twice');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].t, 'SAiM — Mum and Dad anniversary');
  assert.match(sent[0].b, /is tomorrow .*Nothing prepared yet\./);
  assert.equal(sent[0].data.type, 'personal_date');
  assert.deepEqual(realDoors, [], 'the real push door was never reached by tests');
});
