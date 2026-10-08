'use strict';

/**
 * Build 19 — Personal Operations and the Future Radar.
 *
 * Real scratch DB, real reminder/calendar ingest, the REAL world-model and
 * source-health projectors pumped from the real event log, real routes over
 * HTTP behind the real api-auth + authority guard. Anything that could notify
 * or send is stubbed to THROW, so a flow that reaches one fails loudly.
 *
 * Dates are derived from the real clock (the calendar push stamps real time),
 * always as offsets from TODAY, so no fixture can age into the past.
 * Numbering follows the Build 19 test list in the build record.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b19-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'b19.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-1919';
process.env.NEURO_API_TOKEN = 'machine-token-19';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
for (const k of ['APPLE_REMINDER_LISTS', 'PERSONAL_DEADLINE_MODE']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'vault', 'People'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'vault', 'Companions'), { recursive: true });

const realDoors = [];
function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
const boom = (what) => async () => { realDoors.push(what); throw new Error(`${what} reached from a Build 19 flow`); };
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
const taskStore = require('./task-store');

const pad = (n) => String(n).padStart(2, '0');
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const NOW = Date.now();
const TODAY = localDay(NOW);
const plus = (n) => { const d = new Date(Date.UTC(+TODAY.slice(0, 4), +TODAY.slice(5, 7) - 1, +TODAY.slice(8, 10) + n)); return d.toISOString().slice(0, 10); };
const pump = async () => { await bus.pumpConsumer(wm.CONSUMER, { now: NOW }); await bus.pumpConsumer(sh.CONSUMER, { now: NOW }); };

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
});
test.after(() => { if (server) server.close(); });

const AS = { nick: { 'X-Neuro-Pin': 'pin-1919' }, machine: { 'X-Neuro-Api-Token': 'machine-token-19' } };
async function call(method, url, who = 'nick', body, extra = {}) {
  const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...AS[who], ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const LISTS = [
  { id: 'L-REM-A', title: 'Reminders' }, { id: 'L-REM-B', title: 'Reminders' },
  { id: 'L-HOME', title: 'Home' }, { id: 'L-ADMIN', title: 'Car and bills' }, { id: 'L-SHOP', title: 'Shopping' },
];
function pushReminders(reminders, { complete = true, lists = LISTS, client = 'neuro' } = {}) {
  const r = apple.ingestReminders({ reminders, lists, complete, client }, { now: NOW });
  assert.equal(r.ok, true, r.error);
  return r;
}
const CALS = [{ id: 'C-HOME', title: 'Home' }, { id: 'C-WORK', title: 'Work' }, { id: 'C-NICK', title: 'nick@example' }, { id: 'C-OTHER', title: 'Subscribed' }];
const at = (day, hm = null) => (hm ? `${day}T${hm}:00` : `${day}T00:00:00`);
function pushCalendar(events) {
  const r = apple.ingestCalendar({ from: `${plus(-1)}T00:00:00`, to: `${plus(60)}T00:00:00`, events, calendars: CALS, client: 'saim' });
  assert.equal(r.ok, true, r.error);
  return r;
}
const allDay = (id, title, day, cal) => ({ id, title, start: at(day), end: at(plus(1 + Math.round((Date.parse(day) - Date.parse(TODAY)) / 864e5))), isAllDay: true, calendar: cal.title, calendarId: cal.id });
const timed = (id, title, day, hm, cal) => ({ id, title, start: at(day, hm), end: at(day, '23:00'), isAllDay: false, calendar: cal.title, calendarId: cal.id });
const taskOf = (rid) => cr.tasks({ status: 'all', system: 'eventkit-reminders', now: NOW }).items.find((t) => t.id === `task:eventkit-reminders:${rid}`);
const classifyList = (id, domains, tracked) => sc.classify({ kind: 'reminder-list', sourceKey: `reminders:id:${id}`, domains, tracked });
const radarItems = (h = 30) => radar.read({ now: NOW, horizonDays: h }).items;

// ═══ REMINDERS ═══════════════════════════════════════════════════════════════

test('1. duplicate list names are told apart by stable id — classification never crosses between them', async () => {
  classifyList('L-REM-A', ['home'], true);
  classifyList('L-REM-B', null, true);
  pushReminders([
    { id: 'R-A1', title: 'Bleed the radiators', list: 'Reminders', listId: 'L-REM-A', isCompleted: false },
    { id: 'R-B1', title: 'Bleed the radiators', list: 'Reminders', listId: 'L-REM-B', isCompleted: false },
  ]);
  await pump();
  assert.deepEqual(taskOf('R-A1').domains.domains.map((d) => d.domain), ['home']);
  assert.deepEqual(taskOf('R-B1').domains.domains, [], 'the OTHER "Reminders" list does not inherit the classification by name');
  const a = audit.read({ now: NOW });
  const rows = a.lists.filter((l) => l.name === 'Reminders');
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.keyedBy, 'id');
    assert.equal(r.duplicateName.count, 2);
    assert.deepEqual(r.duplicateName.otherListIds, [r.listId === 'L-REM-A' ? 'L-REM-B' : 'L-REM-A']);
  }
  assert.ok(a.summary.duplicateNames.includes('Reminders'));
});

test('2. an unclassified list stays UNKNOWN — the name "Home" means nothing', async () => {
  classifyList('L-HOME', null, true);
  pushReminders([{ id: 'R-H1', title: 'Fix the gate', list: 'Home', listId: 'L-HOME', isCompleted: false }]);
  await pump();
  assert.deepEqual(taskOf('R-H1').domains.domains, []);
  const row = audit.read({ now: NOW }).lists.find((l) => l.listId === 'L-HOME');
  assert.equal(row.classification.state, 'unknown');
  assert.equal(row.trackedBasis, 'set');
  // Positive control: the Shopping list, not classified and not set, is untracked by the name default.
  const shop = audit.read({ now: NOW }).lists.find((l) => l.listId === 'L-SHOP');
  assert.equal(shop.tracked, false);
  assert.equal(shop.trackedBasis, 'default-not-tracked');
});

test('3. an explicit classification persists across pushes, and Activity says so once', async () => {
  const r = await call('POST', '/api/canonical/classifications', 'nick', { kind: 'reminder-list', sourceKey: 'reminders:id:L-ADMIN', domains: ['admin'], tracked: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  pushReminders([]);
  pushReminders([]);
  const row = audit.read({ now: NOW }).lists.find((l) => l.listId === 'L-ADMIN');
  assert.equal(row.classification.state, 'classified');
  assert.deepEqual(row.classification.domains.map((d) => d.domain), ['admin']);
  assert.equal(row.tracked, true);
  const lines = db.all("SELECT * FROM personal_ops_events WHERE kind = 'list-classified' AND subject_id = 'reminders:id:L-ADMIN'");
  assert.equal(lines.length, 1, 'one Activity line per classification, not per push');
  const act = require('./activity-timeline').fromPersonalOps(lines);
  assert.match(act[0].headline, /classified the "Car and bills" reminder list/);
});

test('4/5/6. a reminder CREATE, COMPLETE and REOPEN each project from the authoritative source', async () => {
  pushReminders([{ id: 'R-C1', title: 'Renew passport', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false, dueDate: plus(20) }]);
  await pump();
  assert.equal(taskOf('R-C1').state, 'open');
  pushReminders([{ id: 'R-C1', title: 'Renew passport', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: true, completedAt: new Date(NOW).toISOString(), dueDate: plus(20) }]);
  await pump();
  assert.equal(taskOf('R-C1').state, 'completed');
  pushReminders([{ id: 'R-C1', title: 'Renew passport', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false, dueDate: plus(20) }]);
  await pump();
  assert.equal(taskOf('R-C1').state, 'open', 'reopened in Apple → open here');
});

test('7. a reminder that DISAPPEARS is not completed — open becomes unknown, completed stays completed', async () => {
  pushReminders([
    { id: 'R-D1', title: 'Open one that vanishes', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false },
    { id: 'R-D2', title: 'Done one that vanishes', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: true, completedAt: new Date(NOW).toISOString() },
    { id: 'R-C1', title: 'Renew passport', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false, dueDate: plus(20) },
  ]);
  await pump();
  pushReminders([{ id: 'R-C1', title: 'Renew passport', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false, dueDate: plus(20) }]);
  await pump();
  assert.equal(taskOf('R-D1').state, 'unknown', 'a deleted open reminder is NOT done');
  assert.equal(taskOf('R-D2').state, 'completed', 'a completed one that drops out of the window stays completed');
  // An INCOMPLETE read concludes nothing.
  pushReminders([{ id: 'R-E1', title: 'Survives a partial read', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false }]);
  await pump();
  pushReminders([], { complete: false });
  await pump();
  assert.equal(taskOf('R-E1').state, 'open');
});

test('8. no fuzzy merge — two reminders with the same words stay two; a NEURO task with the same words stays separate', async () => {
  pushReminders([
    { id: 'R-F1', title: 'Book dentist', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false },
    { id: 'R-F2', title: 'Book dentist', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false },
    { id: 'R-C1', title: 'Renew passport', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false, dueDate: plus(20) },
    { id: 'R-E1', title: 'Survives a partial read', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false },
  ]);
  taskStore.createTask({ text: 'Book dentist', source: 'manual' });
  require('./obligation-sources').publishNeuroTasks({ now: NOW });
  await pump();
  const matches = cr.tasks({ status: 'open', now: NOW }).items.filter((t) => t.description === 'Book dentist');
  assert.equal(matches.length, 3, 'two reminders + one NEURO task, never folded on wording');
  assert.equal(new Set(matches.map((m) => m.id)).size, 3);
});

test('9. source health is honest — a list never pushed since this build is null (not 0), a pushed one is measured', async () => {
  // A list the phone has shown before but that is absent from every recorded push.
  db.run(`INSERT OR IGNORE INTO source_containers (kind, source_key, label, container_id, provider, first_seen_at, last_seen_at, last_client)
          VALUES ('reminder-list', 'reminders:id:L-OLD', 'Old list', 'L-OLD', 'eventkit', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'neuro')`);
  const res = await call('POST', '/api/apple/reminders', 'nick', { reminders: [{ id: 'R-C1', title: 'Renew passport', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false, dueDate: plus(20) }], lists: LISTS, complete: true }, { 'X-Neuro-Client': 'neuro-ios' });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  await pump();
  const a = audit.read({ now: NOW });
  const old = a.lists.find((l) => l.listId === 'L-OLD');
  assert.equal(old.openCount, null, 'never measured is null, never 0');
  assert.ok(old.flags.includes('counts-not-measured-yet'));
  assert.ok(old.flags.includes('not-seen-recently'));
  const adm = a.lists.find((l) => l.listId === 'L-ADMIN');
  assert.equal(adm.openCount, 1);
  assert.equal(adm.completedCount30d, 0);
  const src = a.sources.find((s) => s.sourceId === 'reminders.neuro-ios');
  assert.ok(src, 'the pushing app is a source with its own health row');
  assert.equal(src.state, 'healthy');
  // Counts only: no reminder title is stored in the per-list record.
  assert.ok(!JSON.stringify(audit.pushes()).includes('Renew passport'));
});

test('10. coming from the iPhone does not make a reminder personal — only the list classification does', async () => {
  pushReminders([{ id: 'R-I1', title: 'Phone-only thing', list: 'Reminders', listId: 'L-REM-B', isCompleted: false, dueDate: plus(3) }]);
  await pump();
  const ids = po.read({ now: NOW }).items.map((o) => o.id);
  assert.ok(!ids.includes('task:eventkit-reminders:R-I1'), 'unclassified list → not a personal obligation');
  // Positive control: classify that list as family and it qualifies, on a classified basis.
  classifyList('L-REM-B', ['family'], true);
  const o = po.read({ now: NOW }).items.find((x) => x.id === 'task:eventkit-reminders:R-I1');
  assert.ok(o);
  assert.deepEqual(o.domains.map((d) => [d.domain, d.basis]), [['family', 'classified']]);
  classifyList('L-REM-B', null, true);
});

// ═══ FUTURE RADAR ════════════════════════════════════════════════════════════

test('11. 7 / 14 / 30 day horizons cut by date, and anything else is REFUSED, not clamped', async () => {
  sc.classify({ kind: 'calendar', sourceKey: 'eventkit-cal:id:C-HOME', domains: ['home'] });
  pushCalendar([timed('E-DENT', 'Dentist', plus(10), '09:30', CALS[0]), timed('E-SOON', 'Boiler service', plus(3), '08:00', CALS[0])]);
  await pump();
  const has = (h, title) => radarItems(h).some((i) => i.title === title);
  assert.equal(has(7, 'Dentist'), false);
  assert.equal(has(14, 'Dentist'), true);
  assert.equal(has(30, 'Dentist'), true);
  assert.equal(has(7, 'Boiler service'), true);
  assert.equal(radar.parseHorizon('10').ok, false);
  assert.equal(radar.parseHorizon('30').days, 30);
  const bad = await call('GET', '/api/canonical/radar?days=10');
  assert.equal(bad.status, 400);
  const ok = await call('GET', '/api/canonical/radar?days=7');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.horizonDays, 7);
});

test('12. work volume does not dominate — classified-work calendars and the work backlog are not inputs', async () => {
  sc.classify({ kind: 'calendar', sourceKey: 'eventkit-cal:id:C-WORK', domains: ['work'] });
  const evs = [];
  for (let i = 0; i < 25; i += 1) evs.push(timed(`E-W${i}`, `Work sync ${i}`, plus(1 + (i % 6)), '10:00', CALS[1]));
  pushCalendar([...evs, timed('E-DENT', 'Dentist', plus(10), '09:30', CALS[0]), timed('E-SOON', 'Boiler service', plus(3), '08:00', CALS[0])]);
  for (let i = 0; i < 20; i += 1) taskStore.createTask({ text: `Work backlog item ${i}`, source: 'manual', dueDate: plus(2) });
  require('./obligation-sources').publishNeuroTasks({ now: NOW });
  await pump();
  const r = radar.read({ now: NOW, horizonDays: 14 });
  assert.equal(r.items.filter((i) => /Work (sync|backlog)/.test(i.title)).length, 0);
  assert.ok(r.items.some((i) => i.title === 'Boiler service'));
  assert.ok(r.summary.workExcluded >= 20, 'what was left out is REPORTED, not hidden');
});

test('13/14. needs-action ranks first; then timing; explicit importance only breaks ties within a day', () => {
  const ob = (id, date, actionState, importance = null) => ({ id, what: id, kind: 'task', due: { date, label: date }, domains: [{ domain: 'home', basis: 'classified' }],
    admin: false, source: 'Reminders', linkedGoals: [], preparesFor: [], status: 'open', actionState, needsNow: actionState === 'needs_you', needsWhy: 'x', importance, whyPersonal: ['y'] });
  const r = radar.composeRadar({
    today: TODAY, horizonDays: 14,
    obligations: [ob('task:passive-today', TODAY, 'preparation_open'), ob('task:needs-tomorrow', plus(1), 'needs_you'),
      ob('task:critical-later', plus(5), 'preparation_open', 'critical-to-me'), ob('task:plain-earlier', plus(4), 'preparation_open'),
      ob('task:same-day-plain', plus(6), 'preparation_open'), ob('task:same-day-critical', plus(6), 'preparation_open', 'critical-to-me')],
  });
  const order = r.items.map((i) => i.id);
  assert.equal(order[0], 'task:needs-tomorrow', 'needs-action outranks an EARLIER passive item');
  assert.ok(order.indexOf('task:plain-earlier') < order.indexOf('task:critical-later'), 'importance never beats timing');
  assert.ok(order.indexOf('task:same-day-critical') < order.indexOf('task:same-day-plain'), 'positive control: within a day, stated importance decides');
});

test('15. duplicates are avoided conservatively — exact calendar copies fold; a reminder never merges with an event', async () => {
  sc.classify({ kind: 'calendar', sourceKey: 'eventkit-cal:id:C-NICK', domains: ['home'] });
  // The live case (8 Oct 2026): "julies birthday" in both the Home and the
  // personal Google calendar. A single first name with DIFFERENT spellings
  // stays two dates — personal-dates' 17Q rule, deliberately not overridden here.
  pushCalendar([allDay('E-J1', 'julies birthday', plus(9), CALS[0]), allDay('E-J2', 'julies birthday', plus(9), CALS[2]),
    timed('E-GP1', 'GP appointment', plus(5), '11:00', CALS[0]), timed('E-GP2', 'GP appointment', plus(5), '11:00', CALS[2]),
    timed('E-GP3', 'GP appointment', plus(5), '15:00', CALS[2]), timed('E-DENT', 'Dentist', plus(10), '09:30', CALS[0])]);
  pushReminders([{ id: 'R-GP', title: 'GP appointment', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false, dueDate: plus(5) },
    { id: 'R-C1', title: 'Renew passport', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false, dueDate: plus(20) }]);
  await pump();
  const items = radarItems(14);
  const julie = items.filter((i) => /julie/i.test(i.title));
  assert.equal(julie.length, 1, 'the birthday is one item');
  assert.equal(julie[0].kind, 'birthday');
  assert.equal(julie[0].sourceRefs.length, 2, 'both calendar copies are listed as sources');
  const gp = items.filter((i) => i.title === 'GP appointment');
  assert.equal(gp.filter((i) => i.kind === 'event' && i.time === '11:00').length, 1, 'same title, day and minute → one event, two sources');
  assert.equal(gp.find((i) => i.time === '11:00').sourceRefs.length, 2);
  assert.ok(gp.some((i) => i.kind === 'event' && i.time === '15:00'), 'a different minute is a different entry');
  assert.ok(gp.some((i) => i.kind === 'admin'), 'the reminder stays its own item');
});

test('16. an event from an unclassified calendar stays UNKNOWN — listed, never called personal', async () => {
  pushCalendar([timed('E-X', 'Something on a subscribed calendar', plus(4), '19:00', CALS[3]), timed('E-DENT', 'Dentist', plus(10), '09:30', CALS[0])]);
  await pump();
  const r = radar.read({ now: NOW, horizonDays: 14 });
  const x = r.items.find((i) => i.title === 'Something on a subscribed calendar');
  assert.ok(x);
  assert.deepEqual(x.domains, []);
  assert.equal(x.sphere, null);
  assert.ok(r.summary.unknownDomain >= 1);
  assert.ok(x.whyVisible.some((w) => /not classified/.test(w)));
});

test('17. every Radar item says why it is there', () => {
  const r = radar.read({ now: NOW, horizonDays: 30 });
  assert.ok(r.items.length > 0, 'positive control: there is something to explain');
  for (const i of r.items) {
    assert.ok(Array.isArray(i.whyVisible) && i.whyVisible.length && i.whyVisible.every((w) => typeof w === 'string' && w.length > 3), `${i.id} has no reason`);
    assert.ok(radar.ACTION_STATES.includes(i.actionState));
  }
});

test('18. incomplete calendar coverage keeps the wording honest', () => {
  const thin = radar.composeRadar({ today: TODAY, horizonDays: 30, coverage: { calendarAheadDays: 14, calendarFresh: true, reasons: [] } });
  assert.match(thin.heading, /^Known upcoming items/);
  assert.ok(thin.coverage.reasons.some((r) => /14 days ahead/.test(r)));
  const unknown = radar.composeRadar({ today: TODAY, horizonDays: 7, coverage: { calendarAheadDays: null, reasons: [] } });
  assert.equal(unknown.coverage.complete, false, 'not knowing the window is not "complete"');
  const full = radar.composeRadar({ today: TODAY, horizonDays: 30, coverage: { calendarAheadDays: 60, calendarFresh: true, datesComplete: true, reasons: [] } });
  assert.match(full.heading, /^Coming up/);
});

test('19. no raw telemetry reaches the Radar', () => {
  db.run("INSERT OR IGNORE INTO health_samples (metric, value, recorded_at) VALUES ('heart_rate', 140, ?)", [`${plus(1)} 10:00:00`]);
  const kinds = new Set(radarItems(30).map((i) => i.kind));
  for (const k of kinds) assert.ok(['birthday', 'anniversary', 'personal-date', 'event', 'hike', 'obligation', 'admin', 'goal-review'].includes(k), `unexpected kind ${k}`);
  assert.ok(!JSON.stringify(radarItems(30)).includes('heart_rate'));
});

test('20. reading or refreshing the Radar creates no task anywhere', () => {
  const before = { tasks: db.get('SELECT COUNT(*) n FROM tasks').n, wm: db.get('SELECT COUNT(*) n FROM wm_tasks').n, links: db.get('SELECT COUNT(*) n FROM personal_links').n };
  radar.read({ now: NOW, horizonDays: 30 });
  radar.refresh({ now: NOW });
  radar.refresh({ now: NOW });
  assert.deepEqual({ tasks: db.get('SELECT COUNT(*) n FROM tasks').n, wm: db.get('SELECT COUNT(*) n FROM wm_tasks').n, links: db.get('SELECT COUNT(*) n FROM personal_links').n }, before);
});

// ═══ GOALS ═══════════════════════════════════════════════════════════════════

let HIKE;
let OU;
test('21. an explicit goal link works — and is Activity', async () => {
  HIKE = cr.saveGoal({ title: 'Hike weekly', domains: ['fitness'], importance: 'important-to-me' }).goal;
  OU = cr.saveGoal({ title: 'Finish the OU module', domains: ['learning'], importance: 'critical-to-me' }).goal;
  const r = await call('POST', `/api/canonical/goals/${encodeURIComponent(OU.id)}/links`, 'nick', { entityId: 'task:eventkit-reminders:R-C1', label: 'Renew passport' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.goal.links.some((l) => l.entityId === 'task:eventkit-reminders:R-C1'));
  const item = radarItems(30).find((i) => i.id === 'task:eventkit-reminders:R-C1');
  assert.deepEqual(item.linkedGoals.map((g) => [g.title, g.basis]), [['Finish the OU module', 'explicit']]);
  assert.equal(db.all("SELECT * FROM personal_ops_events WHERE kind = 'goal-link-added'").length, 1);
  const again = await call('POST', `/api/canonical/goals/${encodeURIComponent(OU.id)}/links`, 'nick', { entityId: 'task:eventkit-reminders:R-C1' });
  assert.equal(again.json.already, true);
  assert.equal(db.all("SELECT * FROM personal_ops_events WHERE kind = 'goal-link-added'").length, 1, 'a repeat is not a second Activity line');
});

test('22. a machine cannot invent a goal link — by the links route OR by rewriting the goal', async () => {
  const n = db.get('SELECT COUNT(*) n FROM goal_links').n;
  const a = await call('POST', `/api/canonical/goals/${encodeURIComponent(OU.id)}/links`, 'machine', { entityId: 'task:eventkit-reminders:R-F1' });
  assert.equal(a.status, 403);
  const b = await call('POST', `/api/canonical/goals/${encodeURIComponent(OU.id)}`, 'machine', { links: ['task:eventkit-reminders:R-F1'] });
  assert.equal(b.status, 403);
  const c = await call('POST', '/api/canonical/prep-links', 'machine', { subjectId: 'meeting:x', entityId: 'task:eventkit-reminders:R-F1' });
  assert.equal(c.status, 403);
  assert.equal(db.get('SELECT COUNT(*) n FROM goal_links').n, n);
  // Positive control: the machine may still READ.
  assert.equal((await call('GET', '/api/canonical/radar?days=7', 'machine')).status, 200);
});

test('23. a linked goal gives CONTEXT, never urgency', async () => {
  // R-C1 (due +20) is linked to a critical-to-me goal. Dentist (+10) is not.
  const items = radarItems(30);
  const passport = items.find((i) => i.id === 'task:eventkit-reminders:R-C1');
  const dentist = items.find((i) => i.title === 'Dentist');
  assert.equal(passport.actionState, 'preparation_open', 'linking did not make it need Nick');
  assert.equal(passport.importance, null, 'a goal\'s importance is not inherited into ranking');
  assert.ok(items.indexOf(dentist) < items.indexOf(passport), 'the earlier unlinked item still comes first');
  assert.equal(passport.attention.eligible, false);
});

test('24. the hike goal uses CONFIRMED hike evidence — a planned hike is not progress', async () => {
  sc.classify({ kind: 'calendar', sourceKey: 'eventkit-cal:id:C-NICK', domains: ['home'] });
  pushCalendar([allDay('E-H1', 'hiking', plus(2), CALS[2]), allDay('E-DENT2', 'Dentist', plus(10), CALS[0])]);
  await pump();
  const r = radar.read({ now: NOW, horizonDays: 7 });
  const hike = r.items.find((i) => i.kind === 'hike');
  assert.ok(hike, 'the planned hike is on the Radar');
  assert.equal(hike.actionState, 'planned');
  assert.deepEqual(hike.linkedGoals.map((g) => g.basis), ['hiking-loop-rule'], 'said to be the loop\'s rule, not a link Nick made');
  const prog = r.goals.find((g) => g.goalId === HIKE.id).progress;
  assert.notEqual(prog.state, 'evidence-this-period', 'a calendar entry is a plan, not a hike');
  // Pure: confirmed evidence is what counts.
  const yes = radar.goalProgress({ id: 'g', status: 'active' }, { hikeGoalId: 'g', hiking: { active: true, current: { confirmed: [{ day: TODAY }], line: 'Hike confirmed.' } } });
  assert.equal(yes.state, 'evidence-this-period');
  const no = radar.goalProgress({ id: 'g', status: 'active' }, { hikeGoalId: 'g', hiking: { active: true, current: { confirmed: [], planned: [{ day: TODAY }], line: 'Saturday hike planned.' } } });
  assert.equal(no.state, 'no-evidence-yet');
});

test('25. a generic goal never gets a fake percentage', () => {
  const r = radar.read({ now: NOW, horizonDays: 30 });
  const ou = r.goals.find((g) => g.goalId === OU.id);
  assert.ok(ou);
  assert.ok(['no-evidence-yet', 'evidence-this-period'].includes(ou.progress.state));
  const text = JSON.stringify(r.goals);
  assert.ok(!/percent|%/i.test(text), 'no percentage anywhere in goal progress');
  assert.equal(radar.goalProgress({ id: 'x', status: 'paused' }).state, 'paused');
  assert.equal(radar.goalProgress({ id: 'x', status: 'active' }, { linked: [{ id: 't', completedAt: new Date(NOW).toISOString() }], today: TODAY }).state, 'evidence-this-period');
});

// ═══ PERSONAL ADMIN ══════════════════════════════════════════════════════════

test('26. a known admin obligation enters the Radar, as admin, with its reason', async () => {
  pushReminders([{ id: 'R-MOT', title: 'Book the MOT', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false, dueDate: plus(8) },
    { id: 'R-C1', title: 'Renew passport', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false, dueDate: plus(20) }]);
  await pump();
  const mot = radarItems(14).find((i) => i.title === 'Book the MOT');
  assert.ok(mot);
  assert.equal(mot.kind, 'admin');
  assert.equal(mot.actionState, 'preparation_open');
  assert.ok(mot.whyVisible.some((w) => /personal-admin/.test(w)));
  const adm = await call('GET', '/api/canonical/personal-admin');
  assert.equal(adm.status, 200);
  assert.ok(adm.json.items.some((o) => o.what === 'Book the MOT'));
  assert.ok(adm.json.audit.sources.some((s) => s.items === null && /not modelled/.test(s.why)), 'unmodelled sources are SAID, not zero');
});

test('27. near due — or explicit open prep close to its date — may become Needs You', async () => {
  pushReminders([{ id: 'R-TAX', title: 'Pay car tax', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false, dueDate: plus(1) },
    { id: 'R-GIFT', title: 'Buy a card', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false },
    { id: 'R-MOT', title: 'Book the MOT', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false, dueDate: plus(8) },
    { id: 'R-C1', title: 'Renew passport', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false, dueDate: plus(20) }]);
  pushCalendar([timed('E-PARTY', 'Leaving do', plus(2), '19:00', CALS[0]), timed('E-DENT', 'Dentist', plus(10), '09:30', CALS[0])]);
  await pump();
  const tax = radarItems(14).find((i) => i.title === 'Pay car tax');
  assert.equal(tax.actionState, 'needs_you');
  assert.equal(tax.attention.eligible, true);
  const party = radarItems(14).find((i) => i.title === 'Leaving do');
  assert.equal(party.actionState, 'none', 'an appointment with no preparation needs nothing');
  const meeting = party.sourceRefs[0];
  const l = await call('POST', '/api/canonical/prep-links', 'nick', { subjectId: `meeting:${meeting}`, entityId: 'task:eventkit-reminders:R-GIFT', label: 'Buy a card' });
  assert.equal(l.status, 200, JSON.stringify(l.json));
  const after = radarItems(14).find((i) => i.title === 'Leaving do');
  assert.equal(after.actionState, 'needs_you', 'explicit open prep 2 days out');
  assert.deepEqual(after.linkedTaskRefs, ['task:eventkit-reminders:R-GIFT']);
});

test('28. a distant obligation is shown but never eligible to interrupt', () => {
  const mot = radarItems(14).find((i) => i.title === 'Book the MOT');
  assert.equal(mot.actionState, 'preparation_open');
  assert.equal(mot.attention.eligible, false);
  assert.deepEqual(realDoors, [], 'nothing reached a notifier');
});

test('29. completion removes the action state — and Activity records the resolution', async () => {
  radar.refresh({ now: NOW });
  pushReminders([{ id: 'R-TAX', title: 'Pay car tax', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: true, completedAt: new Date(NOW).toISOString(), dueDate: plus(1) },
    { id: 'R-GIFT', title: 'Buy a card', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false },
    { id: 'R-MOT', title: 'Book the MOT', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false, dueDate: plus(8) },
    { id: 'R-C1', title: 'Renew passport', list: 'Car and bills', listId: 'L-ADMIN', isCompleted: false, dueDate: plus(20) }]);
  await pump();
  assert.ok(!radarItems(14).some((i) => i.title === 'Pay car tax'), 'a completed obligation leaves the Radar');
  const out = radar.refresh({ now: NOW + 60000 });
  assert.equal(out.baseline, false);
  assert.equal(db.all("SELECT * FROM personal_ops_events WHERE kind = 'admin-resolved' AND subject_id = 'task:eventkit-reminders:R-TAX'").length, 1);
  // Unchanged → nothing more.
  const again = radar.refresh({ now: NOW + 120000 });
  assert.equal(again.logged, 0);
});

test('30. no external action anywhere — no send, no prepared action, no task created', async () => {
  const before = { pa: db.get('SELECT COUNT(*) n FROM prepared_actions').n, sa: db.get('SELECT COUNT(*) n FROM saim_actions').n };
  await call('GET', '/api/canonical/radar?days=30');
  await call('GET', '/api/canonical/obligations');
  await call('GET', '/api/canonical/reminder-lists');
  radar.refresh({ now: NOW + 180000 });
  assert.deepEqual({ pa: db.get('SELECT COUNT(*) n FROM prepared_actions').n, sa: db.get('SELECT COUNT(*) n FROM saim_actions').n }, before);
  assert.deepEqual(realDoors, []);
});

test('Now carries the 7-day Radar as context — summary lines, and what needs Nick', async () => {
  const n = await cr.now({ now: NOW, decision: {} });
  assert.ok(n.radar, 'the radar block is present');
  assert.equal(n.radar.summary.horizonDays, 7);
  assert.ok(Array.isArray(n.radar.summary.lines) && n.radar.summary.lines.length >= 4);
  assert.ok(n.radar.needsYou.some((i) => i.title === 'Leaving do'), 'explicit open prep two days out is surfaced on Now');
  assert.deepEqual(realDoors, []);
});

test('the Life page MOUNTS the three Build 19 cards (not just defines them)', () => {
  const life = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'canonical', 'LifePanel.jsx'), 'utf8');
  for (const c of ['FutureRadarCard', 'PersonalAdminCard', 'ReminderListsCard']) assert.ok(new RegExp(`<${c}\\s*/>`).test(life), `${c} is not mounted`);
  // Positive control: the scan can see a card that IS mounted.
  assert.ok(/<HouseholdCard /.test(life));
  const card = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'canonical', 'FutureRadar.jsx'), 'utf8');
  assert.ok(card.includes('/api/canonical/radar?days='), 'the card reads the server Radar');
  assert.ok(!/\.sort\(/.test(card), 'the card never re-ranks what the server ordered');
});

test('Activity: the first refresh is a baseline and records nothing', () => {
  db.setState('personal_ops_state', 'null');
  const n = db.get('SELECT COUNT(*) n FROM personal_ops_events').n;
  const r = radar.refresh({ now: NOW + 240000 });
  assert.equal(r.baseline, true);
  assert.equal(db.get('SELECT COUNT(*) n FROM personal_ops_events').n, n);
});
