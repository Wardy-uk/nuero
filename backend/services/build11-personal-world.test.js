'use strict';

/**
 * Build 11 — the personal world model, and governed calendar actions.
 *
 * Real scratch DB, real vault (temp dir), the REAL world-model projector
 * pumped from the real event log, real routes over HTTP, the real executor.
 * Only the Graph TRANSPORT is faked — `action-calendar` / `calendar-read` —
 * one layer below the module under test (the Build 6 lesson: a stub cannot
 * test the thing it replaces). Anything that could notify or send is stubbed
 * to THROW, so a flow that reaches one fails loudly.
 *
 * Numbering follows the Build 11S list in the build record.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b11-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'b11.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
for (const k of ['GOVERNED_EXECUTION_ENABLED', 'GOVERNED_CALENDAR_ENABLED', 'PERSONAL_DEADLINE_MODE', 'APPLE_REMINDER_LISTS', 'COMMITMENT_RISK_MODE']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'vault', 'People'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'vault', 'Companions'), { recursive: true });

const realDoors = [];
function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
const boom = (what) => async () => { realDoors.push(what); throw new Error(`${what} reached from a Build 11 flow`); };
stub('./webpush', { sendToAll: boom('webpush.sendToAll'), isConfigured: () => true });
stub('./email-sender', { sendMail: boom('email-sender.sendMail'), sendBriefEmail: boom('email-sender.sendBriefEmail'), OWN_ADDRESS: 'nickw@nurtur.tech' });

// ── one fake calendar for the whole file (the transport, never the executor) ──
const CAL = { events: new Map(), calls: { create: 0, move: 0, cancel: 0, find: 0 }, mode: 'accept' };
const minute = (s) => String(s || '').slice(0, 16);
const calApi = {
  createEvent: async (draft, { marker }) => {
    CAL.calls.create += 1;
    const make = () => {
      const id = `EV-${CAL.events.size + 1}`;
      const ev = { id, subject: draft.subject, start: minute(draft.start), end: minute(draft.end), attendees: draft.to.map((r) => r.email.toLowerCase()).sort(),
        location: draft.location || null, isOnline: !!draft.isOnline, isCancelled: false, isOrganizer: true, marker };
      CAL.events.set(id, ev);
      return ev;
    };
    if (CAL.mode === 'accept') return { outcome: 'accepted', status: 201, event: make() };
    if (CAL.mode === 'reject') return { outcome: 'rejected', status: 403, category: 'scope' };
    if (CAL.mode === 'timeout-after-create') { make(); return { outcome: 'uncertain', status: null, category: 'timeout' }; }
    return { outcome: 'uncertain', status: null, category: 'timeout' };
  },
  findByMarker: async (marker) => { CAL.calls.find += 1; return { ok: true, events: [...CAL.events.values()].filter((e) => e.marker === marker) }; },
  readEvent: async (id) => (CAL.events.has(id) ? { ok: true, exists: true, event: CAL.events.get(id) } : { ok: true, exists: false, event: null }),
  eventsAt: async (start) => ({ ok: true, events: [...CAL.events.values()].filter((e) => e.start === minute(start)) }),
  moveEvent: async (id, { start, end }) => {
    CAL.calls.move += 1;
    const e = CAL.events.get(id);
    if (!e) return { outcome: 'rejected', status: 404 };
    e.start = minute(start); e.end = minute(end);
    return { outcome: 'accepted', status: 200, event: e };
  },
  cancelEvent: async (id) => { CAL.calls.cancel += 1; const e = CAL.events.get(id); if (e) e.isCancelled = true; return { outcome: e ? 'accepted' : 'rejected', status: e ? 202 : 404 }; },
};
stub('./action-calendar', calApi);
stub('./calendar-read', { readEvent: calApi.readEvent, eventsAt: calApi.eventsAt, findByMarker: calApi.findByMarker, normaliseEvent: (e) => e, TIMEZONE: 'Europe/London', MARKER_PROP: 'x' });

const db = require('../db/database');
const bus = require('./event-bus');
const wm = require('./world-model');
const cr = require('./canonical-read');
const apple = require('./apple-ingest');
const sc = require('./source-classification');
const pw = require('./personal-world');
const pd = require('./personal-deadline');
const pa = require('./prepared-actions');
const ex = require('./action-executor');
const registry = require('./action-registry');
const proofs = require('./approval-proof');
const domains = require('../../shared/life-domains.cjs');

// Saturday 3 Oct 2026, 12:00 BST — mid-day, so no local/UTC date straddle on any host.
const NOW = Date.parse('2026-10-03T11:00:00Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TODAY = '2026-10-03';
const TOMORROW = '2026-10-04';
const CODE = 'build-11 approval code';
const pump = () => bus.pumpConsumer(wm.CONSUMER, { now: NOW });

let server;
let base;
test.before(async () => {
  await db.init();
  if (!proofs.codeStatus().set) assert.equal(proofs.setCode(CODE).ok, true);
  const app = express();
  app.use(express.json());
  // The machine-client marker the real auth middleware sets for the API token.
  app.use((req, res, next) => { if (req.headers['x-test-api-client']) req.apiClient = true; next(); });
  app.use('/api/canonical', require('../routes/canonical'));
  app.use('/api/calendar', require('../routes/calendar'));
  app.use('/api/prepared-actions', require('../routes/prepared-actions'));
  app.use('/api/apple', require('../routes/apple'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); });

const post = async (p, body, headers = {}) => {
  const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const get = async (p) => { const res = await fetch(`${base}${p}`); return { status: res.status, json: await res.json() }; };

// ── fixtures ─────────────────────────────────────────────────────────────────

const CAL_FAMILY = { id: 'CAL-FAMILY', title: 'Family' };
const CAL_WORK = { id: 'CAL-WORK', title: 'Work' };
function pushCalendar(events, { calendars = [CAL_FAMILY, CAL_WORK], from = '2026-10-03T00:00:00', to = '2026-10-20T00:00:00' } = {}) {
  const r = apple.ingestCalendar({ from, to, events, calendars, client: 'neuro' });
  assert.equal(r.ok, true, r.error);
  return r;
}
let rid = 0;
function reminder(over = {}) {
  rid += 1;
  return { id: `R-${rid}`, title: `Reminder ${rid}`, list: 'Reminders', listId: 'LIST-DEFAULT', isCompleted: false, ...over };
}
function pushReminders(reminders, { complete = true, lists = [{ id: 'LIST-DEFAULT', title: 'Reminders' }, { id: 'LIST-EMBER', title: 'Ember' }] } = {}) {
  const r = apple.ingestReminders({ reminders, lists, complete, client: 'neuro' }, { now: NOW });
  assert.equal(r.ok, true, r.error);
  return r;
}
const reminderTasks = () => cr.tasks({ now: NOW, system: 'eventkit-reminders', status: 'all' }).items;
const eventsByTitle = async (title) => {
  await pump();
  const life = await cr.life({ now: NOW });
  void life;
  const st = wm.nextMeetings({ now: NOW, limit: 50 });
  return st.find((m) => m.title === title);
};

// ═══ CALENDAR CLASSIFICATION ═════════════════════════════════════════════════

test('1/2. a phone calendar is UNKNOWN until classified; classified, it is evidence (basis classified)', async () => {
  pushCalendar([{ id: 'E1', title: 'Parents evening', start: '2026-10-05T18:00:00', end: '2026-10-05T19:00:00', calendar: 'Family', calendarId: 'CAL-FAMILY' }]);
  await pump();
  const before = await cr.now({ now: NOW, decision: {} });
  const ev = before.situation.sections.nextEvent || null;
  const all = await cr.life({ now: NOW });
  assert.ok(all.containers.some((c) => c.sourceKey === 'eventkit-cal:id:CAL-FAMILY'), 'the calendar is offered for classification, keyed by id');
  const m = wm.nextMeetings({ now: NOW, limit: 50 }).find((x) => x.title === 'Parents evening');
  assert.equal(m.calendar.key, 'eventkit-cal:id:CAL-FAMILY');
  assert.equal(m.entryKind, 'event', 'a phone entry with no attendee judgement is an EVENT, not a meeting');
  const shaped = (await cr.now({ now: NOW, decision: { life: { showWork: true } } })).situation.sections.nextEvent;
  assert.equal(shaped.title, 'Parents evening');
  assert.deepEqual(shaped.domains.domains, [], 'unclassified → unknown, never personal-because-phone');
  void ev;
  // Nick classifies it.
  const r = await post('/api/canonical/classifications', { kind: 'calendar', sourceKey: 'eventkit-cal:id:CAL-FAMILY', domains: ['family'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const after = (await cr.now({ now: NOW, decision: { life: { showWork: true } } })).situation.sections.nextEvent;
  assert.deepEqual(after.domains.domains.map((d) => [d.domain, d.basis]), [['family', 'classified']], 'classification is explicit evidence, even for a sensitive domain');
});

test('3. the Outlook calendar does NOT auto-classify as work', async () => {
  const sessionWm = require('./world-sources');
  sessionWm.publishCalendarWindow({ provider: 'graph', events: [{ id: 'G1', subject: 'Sync with nobody', start: '2026-10-05T08:00:00', end: '2026-10-05T08:30:00', attendees: [], attendeesOther: null }], now: NOW });
  await pump();
  const m = wm.nextMeetings({ now: NOW, limit: 50 }).find((x) => x.title === 'Sync with nobody');
  assert.equal(m.calendar.key, sc.GRAPH_PRIMARY);
  const doms = cr.meetingDomains(m, { people: new Map(), calendar: { claims: [], state: 'unclassified' } });
  assert.deepEqual(doms.domains, [], 'transport is not domain');
  // Positive control: classify the account calendar, and it does count.
  sc.classify({ kind: 'calendar', sourceKey: sc.GRAPH_PRIMARY, domains: ['work'] });
  const claims = sc.claimsFor(sc.classificationMap('calendar').get(sc.GRAPH_PRIMARY));
  assert.deepEqual(claims.claims.map((c) => c.domain), ['work']);
  sc.classify({ kind: 'calendar', sourceKey: sc.GRAPH_PRIMARY, domains: null });
});

test('4. a sensitive domain is never inferred from a title or a source; an AMBIGUOUS title refuses', async () => {
  const doms = domains.resolveDomains([{ domain: 'health', basis: 'inference', why: 'title says GP' }]);
  assert.deepEqual(doms.domains, [], 'health on inference is dropped');
  // Two calendars called "Home" from an old (title-only) client: a title
  // classification cannot say which one, so it is refused, never applied to both.
  apple.ingestCalendar({ from: '2026-10-03T00:00:00', to: '2026-10-20T00:00:00', events: [], calendars: ['Home', 'Home', 'Work'], client: 'neuro' });
  sc.classify({ kind: 'calendar', sourceKey: 'eventkit-cal:title:home', domains: ['home'] });
  const r = sc.resolveFor('calendar', { id: null, title: 'Home' }, { byKey: sc.classificationMap('calendar'), titleCount: sc.effectiveTitleCounts('calendar', { now: NOW }) });
  assert.equal(r.ambiguous, true);
  assert.equal(sc.claimsFor(r.classification, { ambiguous: r.ambiguous, label: 'Home' }).state, 'ambiguous');
  // Positive control: a unique title applies.
  const w = sc.resolveFor('calendar', { id: null, title: 'Family' }, { byKey: new Map([['eventkit-cal:title:family', { domains: ['family'] }]]), titleCount: new Map([['family', 1]]) });
  assert.equal(w.ambiguous, false);
});

// ═══ REMINDERS ═══════════════════════════════════════════════════════════════

test('5. a reminder becomes a canonical Task under its OWN identity', async () => {
  pushReminders([reminder({ id: 'R-TAX', title: 'Renew the car tax', dueDate: TOMORROW })]);
  await pump();
  const t = reminderTasks().find((x) => x.id === 'task:eventkit-reminders:R-TAX');
  assert.ok(t, 'projected as task:eventkit-reminders:<id>');
  assert.equal(t.state, 'open');
  assert.equal(t.due.date, TOMORROW);
  assert.equal(t.due.kind, 'set', 'a date Nick typed in Reminders is a plan he set');
  assert.equal(t.sourceLabel, 'Reminders');
  assert.deepEqual(t.domains.domains, [], 'unclassified list → unknown domain');
});

test('6/7. completion projects; a reopen projects; both are transitions', async () => {
  pushReminders([reminder({ id: 'R-CYCLE', title: 'Book the boiler service', dueDate: TOMORROW })]);
  await pump();
  pushReminders([reminder({ id: 'R-CYCLE', title: 'Book the boiler service', dueDate: TOMORROW, isCompleted: true, completedAt: '2026-10-03T10:00:00Z' })]);
  await pump();
  assert.equal(reminderTasks().find((x) => x.id === 'task:eventkit-reminders:R-CYCLE').state, 'completed');
  pushReminders([reminder({ id: 'R-CYCLE', title: 'Book the boiler service', dueDate: TOMORROW })]);
  await pump();
  assert.equal(reminderTasks().find((x) => x.id === 'task:eventkit-reminders:R-CYCLE').state, 'open', 'unticked on the phone → reopened');
  const hist = db.all(`SELECT change FROM wm_obligation_history WHERE entity_id = 'task:eventkit-reminders:R-CYCLE' ORDER BY id`).map((r) => r.change);
  assert.deepEqual(hist, ['created', 'completed', 'reopened']);
});

test('8. a duplicate delivery folds — no new event, no new task', async () => {
  const one = reminder({ id: 'R-DUP', title: 'Post the parcel' });
  const observed = () => db.get(`SELECT COUNT(*) n FROM event_log WHERE type = 'observation.task.observed' AND subject_id = 'eventkit-reminders:R-DUP'`).n;
  pushReminders([one]);
  await pump();
  assert.equal(observed(), 1, 'positive control: the first delivery is observed');
  pushReminders([one]);
  await pump();
  assert.equal(observed(), 1, 'the second, identical delivery adds no task observation');
  assert.equal(reminderTasks().filter((x) => x.description === 'Post the parcel').length, 1);
});

test('9. similar wording does NOT merge separate tasks', async () => {
  pushReminders([reminder({ id: 'R-SAME-1', title: 'Call the vet' }), reminder({ id: 'R-SAME-2', title: 'Call the vet' })]);
  require('./task-store').createTask({ text: 'Call the vet', domain: 'personal', source: 'manual' });
  require('./obligation-sources').publishNeuroTasks({ now: NOW });
  await pump();
  const same = cr.tasks({ now: NOW, status: 'all' }).items.filter((x) => x.description === 'Call the vet');
  assert.equal(same.length, 3, 'two reminders and one NEURO task stay three tasks');
  const links = db.all(`SELECT relation FROM wm_obligation_links WHERE relation = 'possible-same'`);
  assert.ok(links.length >= 1, 'the cross-store likeness is RECORDED as a possibility');
  assert.equal(db.get(`SELECT COUNT(*) n FROM wm_task_sources WHERE system = 'eventkit-reminders' AND task_id LIKE 'task:neuro:%'`).n, 0, 'never merged into a NEURO task');
});

test('a reminder’s NOTES never enter the immutable log, even from an old client that sends them', async () => {
  pushReminders([reminder({ id: 'R-NOTES', title: 'Collect prescription', notes: 'PRIVATE-NOTE-TEXT about a GP visit' })]);
  await pump();
  assert.ok(reminderTasks().some((x) => x.id === 'task:eventkit-reminders:R-NOTES'), 'positive control: it was projected');
  assert.equal(db.get(`SELECT COUNT(*) n FROM event_log WHERE payload LIKE '%PRIVATE-NOTE-TEXT%'`).n, 0);
});

test('a reminder is concluded REMOVED only from a complete read of its list', async () => {
  pushReminders([reminder({ id: 'R-GONE', title: 'Return the library book' })]);
  await pump();
  pushReminders([], { complete: false });
  await pump();
  assert.equal(reminderTasks().find((x) => x.id === 'task:eventkit-reminders:R-GONE').state, 'open', 'an incomplete read proves nothing');
  pushReminders([], { complete: true });
  await pump();
  assert.equal(reminderTasks().find((x) => x.id === 'task:eventkit-reminders:R-GONE').state, 'unknown', 'deleted or completed — the source cannot say which');
});

test('a COMPLETED reminder that ages out of the phone\'s window stays completed — not unknown', async () => {
  pushReminders([reminder({ id: 'R-AGED', title: 'Pay the window cleaner', isCompleted: true, completedAt: '2026-09-01T10:00:00Z' })]);
  await pump();
  assert.equal(reminderTasks().find((x) => x.id === 'task:eventkit-reminders:R-AGED').state, 'completed');
  pushReminders([], { complete: true });
  await pump();
  assert.equal(reminderTasks().find((x) => x.id === 'task:eventkit-reminders:R-AGED').state, 'completed', 'ageing out is not evidence of anything new');
});

test('a reminder on an UNTRACKED list never enters the world model; a tracked list does', async () => {
  pushReminders([reminder({ id: 'R-SHOP', title: 'peanut butter', list: 'Shopping', listId: 'LIST-SHOP' })], { lists: [{ id: 'LIST-SHOP', title: 'Shopping' }] });
  await pump();
  assert.equal(reminderTasks().some((x) => x.id === 'task:eventkit-reminders:R-SHOP'), false);
  sc.classify({ kind: 'reminder-list', sourceKey: 'reminders:id:LIST-SHOP', tracked: true });
  pushReminders([reminder({ id: 'R-SHOP', title: 'peanut butter', list: 'Shopping', listId: 'LIST-SHOP' })], { lists: [{ id: 'LIST-SHOP', title: 'Shopping' }] });
  await pump();
  assert.ok(reminderTasks().some((x) => x.id === 'task:eventkit-reminders:R-SHOP'), 'Nick tracked it → it counts');
});

// ═══ PERSONAL ENTITIES ═══════════════════════════════════════════════════════

test('10/11. a STATED family relationship is preserved and is evidence; frequent contact infers nothing', async () => {
  const vault = process.env.OBSIDIAN_VAULT_PATH;
  fs.writeFileSync(path.join(vault, 'People', 'Helen Ward.md'), '---\ntype: person\nrelationship: spouse\nhousehold: true\nemail: helen@example.com\n---\n# Helen\n');
  fs.writeFileSync(path.join(vault, 'People', 'Sam Often.md'), '---\ntype: person\nemail: sam@example.com\n---\n# Sam\n');
  require('./world-sources').publishPeople({ now: NOW });
  await pump();
  const helen = wm.getPerson('person:helen-ward');
  assert.equal(helen.relationship, 'spouse');
  assert.equal(helen.household, true);
  const sam = wm.getPerson('person:sam-often');
  assert.equal(sam.relationship, null, 'nothing stated, nothing inferred');
  // Sam is in ten meetings: still no relationship, and no family domain.
  const meetingWithSam = { people: [{ personId: 'person:sam-often' }] };
  const people = new Map([['person:sam-often', sam], ['person:helen-ward', helen]]);
  assert.deepEqual(cr.meetingDomains(meetingWithSam, { people }).domains, []);
  const withHelen = cr.meetingDomains({ people: [{ personId: 'person:helen-ward' }] }, { people });
  assert.deepEqual(withHelen.domains.map((d) => [d.domain, d.basis]), [['family', 'classified']]);
});

test('12. Ember is a first-class companion, NOT a person; a mention is an inference', async () => {
  fs.writeFileSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Companions', 'Ember.md'),
    '---\ntype: pet\nspecies: dog\nbreed: Border Collie\nhousehold: true\n---\n# Ember\n');
  const r = pw.publishCompanions({ now: NOW });
  assert.equal(r.changed, 1, JSON.stringify(r));
  await pump();
  const ember = pw.listCompanions().find((c) => c.id === 'companion:ember');
  assert.ok(ember);
  assert.equal(ember.entityType, 'pet');
  assert.equal(wm.getPerson('person:ember'), null, 'never forced into Person');
  pushReminders([reminder({ id: 'R-EMBER', title: 'Book Ember into the vet', list: 'Ember', listId: 'LIST-EMBER' })]);
  sc.classify({ kind: 'reminder-list', sourceKey: 'reminders:id:LIST-EMBER', domains: ['ember'], tracked: true });
  pushReminders([reminder({ id: 'R-EMBER', title: 'Book Ember into the vet', list: 'Ember', listId: 'LIST-EMBER' })]);
  await pump();
  const t = reminderTasks().find((x) => x.id === 'task:eventkit-reminders:R-EMBER');
  assert.deepEqual(t.mentions.map((m) => [m.id, m.basis]), [['companion:ember', 'inference']]);
  assert.deepEqual(t.domains.domains.map((d) => [d.domain, d.basis]), [['ember', 'classified']]);
  const life = await cr.life({ now: NOW });
  assert.ok(life.companions.find((c) => c.id === 'companion:ember').mentionedBy.some((i) => i.id === t.id));
  // "embers of the fire" is not Ember? A whole-word name still matches — so the
  // mention is labelled an inference, never a link.
  assert.deepEqual(pw.mentions('Remembered something', [ember]), [], 'whole word only');
});

// ═══ GOALS ═══════════════════════════════════════════════════════════════════

test('13/16. an explicit goal projects onto the spine, with its explicit links', async () => {
  const made = await post('/api/canonical/goals', { title: 'Look after Ember well', domains: ['ember'], importance: 'critical-to-me',
    links: [{ entityId: 'task:eventkit-reminders:R-EMBER' }] });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  await pump();
  const g = pw.listWorldGoals().find((x) => x.title === 'Look after Ember well');
  assert.ok(g, 'in wm_goals, from intent.goal.declared');
  assert.equal(g.importance, 'critical-to-me');
  assert.deepEqual(g.links.map((l) => l.entityId), ['task:eventkit-reminders:R-EMBER']);
  const t = reminderTasks().find((x) => x.id === 'task:eventkit-reminders:R-EMBER');
  assert.equal(t.importance, 'critical-to-me');
  assert.equal(t.importanceBasis, 'goal', 'inherited from the goal Nick linked it to — and said so');
  assert.equal((await post('/api/canonical/goals', { title: 'x', links: ['not-an-id'] })).status, 400, 'a link must name a world-model id');
});

test('14. NOTHING creates a goal by itself', async () => {
  const before = db.get('SELECT COUNT(*) n FROM goals').n;
  await cr.life({ now: NOW });
  await cr.now({ now: NOW, decision: {} });
  await pd.evaluate({ now: NOW, deps: { readMoment: async () => ({ moment: { known: false } }) } });
  pw.publishGoals({ now: NOW });
  assert.equal(db.get('SELECT COUNT(*) n FROM goals').n, before);
});

test('15. a PAUSED goal lends nothing to the active evaluator', async () => {
  pushReminders([reminder({ id: 'R-PAUSE', title: 'Plan the Edale walk', list: 'Ember', listId: 'LIST-EMBER', dueDate: TOMORROW })]);
  await pump();
  const made = await post('/api/canonical/goals', { title: 'Hike more', importance: 'critical-to-me', links: [{ entityId: 'task:eventkit-reminders:R-PAUSE' }] });
  const id = made.json.goal.id;
  const active = reminderTasks().find((x) => x.id === 'task:eventkit-reminders:R-PAUSE');
  assert.equal(active.importance, 'critical-to-me', 'positive control: an active goal lends it');
  assert.equal(pd.assess(active).level, 'high', 'critical-to-me lifts elevated → high');
  await post(`/api/canonical/goals/${encodeURIComponent(id)}`, { status: 'paused' });
  const paused = reminderTasks().find((x) => x.id === 'task:eventkit-reminders:R-PAUSE');
  assert.equal(paused.importance, null, 'paused → nothing inherited');
  assert.equal(pd.assess(paused).level, 'elevated');
});

// ═══ PERSONAL IMPORTANCE ═════════════════════════════════════════════════════

test('17. explicit importance orders Now within the same timing; the Build 10 name is an alias', () => {
  const due = { date: TOMORROW, kind: 'set', relative: 'soon', days: 1, label: 'tomorrow' };
  const a = { id: 'a', due, importance: null };
  const b = { id: 'b', due, importance: 'critical-to-me' };
  assert.deepEqual(cr.rankNowCommitments([a, b]).map((x) => x.id), ['b', 'a'], 'id order would put a first — importance decides');
  assert.equal(domains.normaliseImportance('personally-important'), 'important-to-me');
  assert.equal(domains.normaliseImportance('very'), null);
});

test('18/19. importance is never inferred from a work source or a health domain', () => {
  const work = cr.importanceFor('commitment:task:9', { annotation: null, goals: [] });
  assert.equal(work.value, null);
  const health = cr.worldTaskDomains({}, { list: { claims: [{ domain: 'health', basis: 'classified' }] } });
  assert.deepEqual(health.domains.map((d) => d.domain), ['health']);
  assert.equal(cr.importanceFor('task:eventkit-reminders:H', { annotation: null, goals: [] }).value, null, 'health is not automatically critical');
});

// ═══ THE PERSONAL EVALUATOR ══════════════════════════════════════════════════

const quietMoment = async () => ({ moment: { known: true, inMeeting: false, focusMode: false, driving: false, inFocusSession: false, quiet: false, onDuty: false, now: new Date(NOW) } });

test('20. an explicit personal deadline near due raises a SHADOW finding, verdict recorded, nothing sent', async () => {
  pushReminders([reminder({ id: 'R-VET', title: 'Ember booster appointment', list: 'Ember', listId: 'LIST-EMBER', dueDate: TODAY })]);
  await pump();
  const out = await pd.evaluate({ now: NOW, deps: { readMoment: quietMoment } });
  assert.equal(out.mode, 'shadow');
  const f = pd.findings({ status: 'active' }).find((x) => x.subjectId === 'task:eventkit-reminders:R-VET');
  assert.ok(f, JSON.stringify(out));
  assert.equal(f.level, 'high');
  assert.equal(f.trigger, 'due-today');
  assert.equal(f.evaluatorVersion, pd.VERSION, 'the version is STAMPED on the row');
  assert.equal(f.attention.shadow, true);
  assert.equal(f.attention.sent, false);
  assert.equal(f.attention.push, true, 'the policy WOULD interrupt off duty — recorded, never acted on');
  assert.deepEqual(realDoors, [], 'no send path was reached');
});

test('21. a work item never enters the personal evaluator', () => {
  const work = { id: 'w', kind: 'task', state: 'open', due: { date: TODAY, kind: 'set', days: 0 }, domains: domains.resolveDomains([{ domain: 'work', basis: 'source-process' }]) };
  assert.equal(pd.assess(work).finding, false);
  assert.equal(pd.assess(work).excluded, true);
  const mixed = { ...work, domains: domains.resolveDomains([{ domain: 'work', basis: 'declared' }, { domain: 'family', basis: 'declared' }]) };
  assert.equal(pd.assess(mixed).finding, false, 'carrying work at all is out');
  const unknown = { ...work, domains: domains.resolveDomains([]) };
  assert.equal(pd.assess(unknown).finding, false, 'unknown is not evidence it is personal');
  // Positive control: the same item, declared personal, does fire.
  const personal = { ...work, domains: domains.resolveDomains([{ domain: 'admin', basis: 'declared' }]) };
  assert.equal(pd.assess(personal).finding, true);
});

test('22. a NEURO placeholder date never triggers', () => {
  const item = { id: 'p', kind: 'task', state: 'open', due: { date: TODAY, kind: 'placeholder', days: 0, label: 'today · NEURO placeholder' },
    domains: domains.resolveDomains([{ domain: 'admin', basis: 'declared' }]) };
  assert.equal(pd.assess(item).finding, false);
  // Positive control: the same date, set by Nick, fires.
  assert.equal(pd.assess({ ...item, due: { ...item.due, kind: 'set' } }).finding, true);
});

test('23/24. a completed personal task resolves its finding; an unchanged risk is not duplicated', async () => {
  const count = () => db.get(`SELECT COUNT(*) n FROM personal_deadline_findings WHERE subject_id = 'task:eventkit-reminders:R-VET'`).n;
  await pd.evaluate({ now: NOW, deps: { readMoment: quietMoment } });
  await pd.evaluate({ now: NOW, deps: { readMoment: quietMoment } });
  assert.equal(count(), 1, 'one finding per episode');
  assert.equal(db.get(`SELECT decisions FROM personal_deadline_findings WHERE subject_id = 'task:eventkit-reminders:R-VET'`).decisions, 1, 'the verdict is not re-asked');
  pushReminders([reminder({ id: 'R-VET', title: 'Ember booster appointment', list: 'Ember', listId: 'LIST-EMBER', dueDate: TODAY, isCompleted: true })]);
  await pump();
  await pd.evaluate({ now: NOW, deps: { readMoment: quietMoment } });
  const f = pd.findings({ status: 'resolved' }).find((x) => x.subjectId === 'task:eventkit-reminders:R-VET');
  assert.ok(f && f.resolution, 'resolved by its own completion');
});

test('25/43. every evaluator stays shadow — "live" reads as shadow', () => {
  process.env.PERSONAL_DEADLINE_MODE = 'live';
  assert.equal(pd.mode(), 'shadow');
  delete process.env.PERSONAL_DEADLINE_MODE;
  const ap = require('./ambient-push');
  const src = fs.readFileSync(path.join(__dirname, 'ambient-push.js'), 'utf8');
  assert.ok(ap.RULES['personal-deadline'], 'the rule exists so a verdict can be recorded');
  assert.doesNotMatch(src.slice(src.indexOf('async function deliver')), /personal-deadline/, 'deliver() never offers this kind');
});

// ═══ OFF DUTY ════════════════════════════════════════════════════════════════

const ev = (id, start, doms) => ({ id, title: id, start, domains: domains.resolveDomains(doms) });
const offDuty = { life: { showWork: false } };
const NOW_LOCAL = '2026-10-03T12:00';

test('26. off duty, a DISTANT unknown-domain event does not lead — it is listed, not hidden', () => {
  const out = cr.composeNow({ decision: offDuty, nextEvents: [ev('UAT Testing', '2026-10-07T10:00', [])], nowLocal: NOW_LOCAL });
  assert.equal(out.sections.nextEvent, null);
  assert.equal(out.sections.laterUnknown.count, 1, 'de-emphasised, never dropped');
});

test('27. off duty, a NEAR unknown-domain event stays visible', () => {
  const out = cr.composeNow({ decision: offDuty, nextEvents: [ev('Something', '2026-10-03T12:30', [])], nowLocal: NOW_LOCAL });
  assert.equal(out.sections.nextEvent.title, 'Something');
  // Same event on duty: unchanged Build 10 behaviour.
  const on = cr.composeNow({ decision: {}, nextEvents: [ev('UAT Testing', '2026-10-07T10:00', [])], nowLocal: NOW_LOCAL });
  assert.equal(on.sections.nextEvent.title, 'UAT Testing');
});

test('28/29. off duty: known personal leads; known work is held and counted', () => {
  const out = cr.composeNow({ decision: offDuty, nowLocal: NOW_LOCAL, nextEvents: [
    ev('Work review', '2026-10-03T13:00', [{ domain: 'work', basis: 'source-process' }]),
    ev('Walk with Ember', '2026-10-06T09:00', [{ domain: 'ember', basis: 'classified' }]),
  ] });
  assert.equal(out.sections.nextEvent.title, 'Walk with Ember', 'a personal event days away still leads');
  assert.equal(out.workHeld.count, 1);
});

// ═══ CALENDAR GOVERNANCE ═════════════════════════════════════════════════════

const calDeps = (over = {}) => ({ calendar: calApi, calendarEnabled: () => true, recordCalendar: () => {}, ...over });
function approve(a, { at = NOW + MIN } = {}) {
  const ch = proofs.issue({ actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, now: at });
  assert.equal(ch.ok, true, ch.error);
  return pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, challengeId: ch.challengeId, approvalCode: CODE, now: at, sending: () => true });
}
let slot = 0;
function prepInvite(over = {}) {
  slot += 1;
  const r = pa.prepareCalendarCreate({ title: `1-2-1 — Nick / Hope ${slot}`, start: `2026-10-${10 + slot}T14:00`, end: `2026-10-${10 + slot}T14:30`,
    attendees: [{ email: 'hope.goodall@nurtur.tech', name: 'Hope Goodall' }], isOnline: true, body: 'Regular 1-2-1.', origin: '1to1-book', now: NOW, ...over });
  assert.equal(r.ok, true, r.error);
  return r.action;
}

test('30. an invite is A4 and does NOTHING until approved', async () => {
  const before = CAL.calls.create;
  const a = prepInvite();
  assert.equal(a.authorityClass, 'A4');
  assert.equal(a.status, 'prepared');
  assert.equal(registry.policyFor(a.actionType).switchFlag, 'governed_calendar');
  const r = await ex.execute(a.actionId, { now: NOW + 2 * MIN, deps: calDeps() });
  assert.equal(r.already, true, 'an unapproved action is not executed');
  assert.equal(CAL.calls.create, before);
});

test('31/35. execution creates exactly the approved event and VERIFIES it by read-back', async () => {
  const a = prepInvite();
  assert.equal(approve(a).ok, true);
  const r = await ex.execute(a.actionId, { now: NOW + 2 * MIN, deps: calDeps() });
  assert.equal(r.status, 'verified', JSON.stringify(r));
  const made = [...CAL.events.values()].find((e) => e.subject === a.draft.subject);
  assert.deepEqual(made.attendees, ['hope.goodall@nurtur.tech']);
  assert.equal(made.start, a.draft.start);
  // The judge refuses a read-back that is not exactly what was approved.
  const handle = ex.attemptsFor(a.actionId)[0].internetMessageId;
  const extra = { exists: true, event: { ...made, attendees: [...made.attendees, 'stranger@x.com'].sort() } };
  assert.equal(ex.judgeCalendarEvent(extra, { action: pa.get(a.actionId), handle }).ok, false, 'an extra attendee is not what was approved');
  const moved = { exists: true, event: { ...made, start: '2026-12-01T09:00' } };
  assert.equal(ex.judgeCalendarEvent(moved, { action: pa.get(a.actionId), handle }).ok, false);
  assert.equal(ex.judgeCalendarEvent({ exists: true, event: made }, { action: pa.get(a.actionId), handle }).ok, true, 'positive control');
});

test('31b. a reschedule binds the exact payload: a changed draft hash is refused, and a moved meeting cancels it', async () => {
  const ev1 = { id: 'EV-MOVE', subject: '1-2-1 — Nick / Zoe', start: '2026-10-20T10:00', end: '2026-10-20T10:30', attendees: [{ email: 'zoe.rees@nurtur.tech' }], isOrganizer: true };
  CAL.events.set('EV-MOVE', { id: 'EV-MOVE', subject: ev1.subject, start: ev1.start, end: ev1.end, attendees: ['zoe.rees@nurtur.tech'], isCancelled: false, isOrganizer: true });
  const r = pa.prepareCalendarReschedule({ event: ev1, start: '2026-10-21T14:00', end: '2026-10-21T14:30', origin: '1to1-move', context: { person: 'Zoe Rees' }, now: NOW });
  assert.equal(r.ok, true, r.error);
  const ch = proofs.issue({ actionId: r.action.actionId, version: 1, payloadHash: r.action.payloadHash, now: NOW + MIN });
  const wrong = pa.approve(r.action.actionId, { approver: 'nick', payloadHash: 'f'.repeat(64), challengeId: ch.challengeId, approvalCode: CODE, now: NOW + MIN, sending: () => true });
  assert.equal(wrong.ok, false, 'you approve what you saw, not what is there now');
  assert.equal(approve(r.action).ok, true);
  // Somebody moved it in Outlook in the meantime.
  CAL.events.get('EV-MOVE').start = '2026-10-20T11:00';
  const out = await ex.execute(r.action.actionId, { now: NOW + 2 * MIN, deps: calDeps() });
  assert.equal(out.code, 'event-moved');
  assert.equal(pa.get(r.action.actionId).status, 'cancelled');
  assert.equal(CAL.calls.move, 0, 'nothing was moved');
});

test('32. a machine client cannot approve (route) — and can only PREPARE an invite', async () => {
  const a = prepInvite();
  const r = await post(`/api/prepared-actions/${a.actionId}/approve`, { payloadHash: a.payloadHash }, { 'x-test-api-client': '1' });
  assert.equal(r.status, 403);
  const c = await post(`/api/prepared-actions/${a.actionId}/approval-challenge`, {}, { 'x-test-api-client': '1' });
  assert.equal(c.status, 403);
  const before = CAL.calls.create;
  const made = await post('/api/calendar/events', { subject: 'Machine meeting', date: '2026-10-28', startTime: '10:00', endTime: '10:30', attendees: ['zoe.rees@nurtur.tech'] }, { 'x-test-api-client': '1' });
  assert.equal(made.status, 200);
  assert.equal(made.json.prepared, true);
  assert.equal(made.json.sent, false);
  assert.equal(CAL.calls.create, before, 'preparing creates nothing');
});

test('33. a duplicate create is blocked — by the preparer, and by the database', () => {
  const a = prepInvite({ title: 'Dup check', start: '2026-11-02T10:00', end: '2026-11-02T10:30' });
  const again = pa.prepareCalendarCreate({ title: 'Dup check', start: '2026-11-02T10:00', end: '2026-11-02T10:30', attendees: [{ email: 'hope.goodall@nurtur.tech' }], origin: '1to1-book', now: NOW });
  assert.equal(again.already, true);
  assert.equal(again.action.actionId, a.actionId);
  assert.throws(() => db.run(`INSERT INTO prepared_actions (action_id, idempotency_key, finding_id, commitment_id, action_type, target_json, reason,
      evidence_json, draft_json, payload_hash, authority_class, approval_required, status, created_at, history_json, updated_at)
      VALUES ('pa_dup', 'dup-key', 'f', ?, 'create_calendar_event', '{}', 'r', '{}', '{}', 'h', 'A4', 1, 'prepared', ?, '[]', ?)`,
  [a.commitmentId, new Date(NOW + 1000).toISOString(), new Date(NOW + 1000).toISOString()]), /UNIQUE/, 'a second live row for one booking, at a different moment, is still refused');
});

test('34. an UNCERTAIN create is verified, never retried — the event it did make is found by its marker', async () => {
  const a = prepInvite({ title: 'Timeout check', start: '2026-11-03T10:00', end: '2026-11-03T10:30' });
  assert.equal(approve(a).ok, true);
  CAL.mode = 'timeout-after-create';
  const before = CAL.calls.create;
  const r = await ex.execute(a.actionId, { now: NOW + 2 * MIN, deps: calDeps() });
  CAL.mode = 'accept';
  assert.equal(CAL.calls.create, before + 1, 'one attempt');
  assert.equal(r.status, 'verified', 'found by the marker it carries');
  const again = await ex.execute(a.actionId, { now: NOW + 3 * MIN, deps: calDeps() });
  assert.equal(again.already, true);
  assert.equal(CAL.calls.create, before + 1, 'never a second invite');
  await ex.reconcile({ now: NOW + 30 * MIN, deps: calDeps() });
  assert.equal(CAL.calls.create, before + 1);
});

test('34b. an uncertain create that made NOTHING becomes failed-unsent only after the settle window', async () => {
  const a = prepInvite({ title: 'Lost check', start: '2026-11-04T10:00', end: '2026-11-04T10:30' });
  assert.equal(approve(a).ok, true);
  CAL.mode = 'timeout';
  await ex.execute(a.actionId, { now: NOW + 2 * MIN, deps: calDeps() });
  CAL.mode = 'accept';
  assert.equal(pa.get(a.actionId).status, 'execution_uncertain');
  await ex.verify(a.actionId, { now: NOW + 5 * MIN, deps: calDeps() });
  assert.equal(pa.get(a.actionId).status, 'execution_uncertain', 'too early to conclude');
  await ex.verify(a.actionId, { now: NOW + 40 * MIN, deps: calDeps() });
  assert.equal(pa.get(a.actionId).status, 'failed');
  assert.equal(pa.get(a.actionId).retrySafe, true, 'proven not made');
});

test('the calendar switch is its OWN switch: email sending ON does not let a calendar change be approved', async () => {
  const ff = require('./feature-flags');
  ff.setEnabled('governed_execution', true);
  const a = prepInvite({ title: 'Switch check', start: '2026-11-05T10:00', end: '2026-11-05T10:30' });
  const ch = proofs.issue({ actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, now: NOW + MIN });
  const r = pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, challengeId: ch.challengeId, approvalCode: CODE, now: NOW + MIN });
  ff.setEnabled('governed_execution', false);
  assert.equal(r.ok, false, 'the email switch being on must not approve an invite');
  assert.match(r.error, /Send approved calendar changes/);
  // 44. The email switch does not turn calendar changes on.
  assert.equal(registry.switchFor('reply_email'), 'governed_execution');
  assert.equal(registry.switchFor('create_calendar_event'), 'governed_calendar');
  assert.equal(ff.isEnabled('governed_calendar'), false, 'default OFF');
});

test('36. create_meeting in chat PREPARES and says nobody was invited', async () => {
  const tools = require('./chat-tools');
  assert.ok(tools.TOOLS.some((t) => t.name === 'create_meeting' && t.tier === 'queued'));
  const before = CAL.calls.create;
  const r = await tools.execute('create_meeting', { title: 'Plan the hike', start: '2026-11-06T10:00', minutes: 30, attendees: ['zoe.rees@nurtur.tech'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.prepared, true);
  assert.equal(r.invited, false);
  assert.match(r.note, /NOT SENT/);
  assert.equal(CAL.calls.create, before);
  const bad = await tools.execute('create_meeting', { title: 'x', start: '2026-11-06T10:00', attendees: [] });
  assert.equal(bad.ok, false);
});

test('no calendar write to other people exists outside the governed executor', () => {
  const root = path.join(__dirname, '..');
  const files = [...fs.readdirSync(path.join(root, 'services')).map((f) => `services/${f}`), ...fs.readdirSync(path.join(root, 'routes')).map((f) => `routes/${f}`)]
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
  assert.ok(files.length > 50, 'positive control: the scan sees the codebase');
  const writers = files.filter((f) => /createEvent\(|moveEvent\(|cancelEvent\(/.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepEqual(writers.sort(), ['services/action-calendar.js', 'services/action-executor.js']);
  for (const f of ['services/one-to-one-booking.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, f), 'utf8'), /microsoft\.(createCalendarEvent|updateCalendarEvent)\(/, `${f} must prepare, not write`);
  }
  // calendar-read.js READS only.
  const read = fs.readFileSync(path.join(root, 'services/calendar-read.js'), 'utf8');
  assert.doesNotMatch(read, /'(POST|PATCH|DELETE)'/);
  // The composer route writes directly ONLY with nobody else in it.
  const route = fs.readFileSync(path.join(root, 'routes/calendar.js'), 'utf8');
  assert.match(route, /attendees: \[\], location, body, isAllDay, isOnline/);
});

// ═══ SOURCEHEALTH ════════════════════════════════════════════════════════════

test('37/38. reminders and calendar are DISTINCT sources; reminders is expected now the apps are rebuilt (Build 13)', () => {
  const ne = require('./native-events');
  const r = ne.recordRemindersPush({ headers: { 'x-neuro-client': 'neuro-ios' }, body: { reminders: [], client: 'neuro' }, result: { ok: true, projected: 0 }, now: NOW });
  const c = ne.recordEventKitPush({ headers: { 'x-neuro-client': 'neuro-ios' }, body: { events: [], from: 'a', to: 'b', calendars: ['x'] }, result: { ok: true }, now: NOW });
  assert.equal(r.sourceId, 'reminders.neuro-ios');
  assert.equal(c.sourceId, 'eventkit.neuro-ios');
  const ns = require('./native-sources');
  assert.equal(ns.describe('reminders.neuro-ios').lifecycle, 'expected');
  assert.equal(ns.describe('reminders.unknown').lifecycle, 'retired', 'pre-identity buckets are retired, never judged');
  assert.equal(cr.sourceVerdict(null, 'optional'), 'unknown', 'never heard from is unknown, never a green light');
  assert.equal(cr.sourceVerdict({ known: true, state: 'healthy', freshness: 'quiet' }, 'expected'), 'quiet');
  assert.equal(cr.sourceVerdict({ known: true, state: 'healthy', freshness: 'stale' }, 'expected'), 'stale');
});

test('39. a delayed desktop delivery is judged on the OBSERVED time, not arrival', () => {
  const ne = require('./native-events');
  const old = new Date(NOW - 5 * HOUR).toISOString();
  const r = ne.recordDesktopSample({ samples: [{ at: old, host: 'DESK' }], now: NOW });
  assert.equal(r.sourceId, 'desktop.agent');
  const ev = db.get(`SELECT payload FROM event_log WHERE subject_id = 'desktop.agent' ORDER BY seq DESC LIMIT 1`);
  assert.equal(JSON.parse(ev.payload).newestObservedAt, old);
  assert.equal(JSON.stringify(JSON.parse(ev.payload)).includes('app'), false, 'no app names enter the log');
  assert.ok(!cr.OFF_SPINE.some((s) => s.id === 'laptop'), 'the laptop is on the spine now');
});

// ═══ iOS (cross-repo guards; skip without a checkout) ════════════════════════

const ios = (() => { try { return require('./ios-checkout').findIOSCheckout(); } catch { return null; } })();

test('40/41. iOS: the canonical Now model decodes the keys the backend composes, and is read-only', { skip: !ios && 'no nuero-ios checkout beside this repo' }, () => {
  const src = fs.readFileSync(path.join(ios, 'NeuroKit', 'Sources', 'NeuroKit', 'CanonicalNow.swift'), 'utf8');
  for (const key of ['nextEvent', 'needsYou', 'commitments', 'tasks', 'laterUnknown', 'blindness', 'crowdedOut', 'goals', 'calmSay', 'workHeld']) {
    assert.match(src, new RegExp(`\\b${key}\\b`), `CanonicalNow.swift does not decode ${key}`);
  }
  assert.match(src, /\/api\/canonical\/now/);
  // Call patterns, not words: the file's own comment says "no approve".
  assert.doesNotMatch(src, /\/approve\b|approval-challenge|\/api\/prepared-actions|postRaw\(/, 'the phone never approves, and this view posts nothing');
  assert.match(src, /getRaw\("\/api\/canonical\/now"\)/, 'positive control: the scan reads the real call');
  const neuro = fs.readFileSync(path.join(ios, 'Neuro', 'Features', 'Views.swift'), 'utf8');
  const saim = fs.readFileSync(path.join(ios, 'Saim', 'SaimNowView.swift'), 'utf8');
  assert.match(neuro, /canonicalNow\(\)/);
  assert.match(saim, /canonicalNow\(\)/);
  // The calendar push carries calendar ids; reminders carry their ids, no notes.
  const sync = fs.readFileSync(path.join(ios, 'NeuroKit', 'Sources', 'NeuroKit', 'CalendarSync.swift'), 'utf8');
  assert.match(sync, /"calendarId": event\.calendar\.calendarIdentifier/);
  assert.match(sync, /"id": r\.calendarItemIdentifier/);
  assert.doesNotMatch(sync, /out\["notes"\]/, 'reminder notes are not sent');
});

// ═══ the composed shape, end to end ═══════════════════════════════════════════

test('Now surfaces a personal reminder due tomorrow beside work, without work being privileged', async () => {
  pushReminders([reminder({ id: 'R-NOW', title: 'Renew Ember\'s insurance', list: 'Ember', listId: 'LIST-EMBER', dueDate: TOMORROW })]);
  await pump();
  const out = await cr.now({ now: NOW, decision: { life: { showWork: true } } });
  const t = (out.situation.sections.tasks || []).find((x) => x.id === 'task:eventkit-reminders:R-NOW');
  assert.ok(t, 'a reminder due tomorrow is on Now');
  assert.deepEqual(t.domains.domains.map((d) => d.domain), ['ember']);
  assert.equal(out.contract, 'canonical-v1');
});
