'use strict';

/**
 * Build 25 — Personal Admin activation.
 *
 * Two halves. The PURE half pins every rule on candidates shaped exactly as
 * the owning modules emit them (personal-obligations.shapeObligation,
 * vehicle.read().obligations[], finance.read().obligations[], companion-care
 * shapeItem, finance health accounts). The REAL half runs a scratch DB with the
 * real task store → world model → canonical read → personal-obligations →
 * personal-admin chain, the real vehicle/finance/care stores, the real routes
 * over HTTP behind api-auth + the authority guard, and a real render.
 * Anything that could notify is stubbed to THROW. Numbering follows the brief.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b25-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'b25.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-2525';
process.env.NEURO_API_TOKEN = 'machine-token-25';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
process.env.TALLY_SSH_TARGET = 'nobody@neuro-test.invalid';
process.env.HA_TOKEN = '';
fs.mkdirSync(path.join(tmp, 'vault', 'Companions'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'vault', 'Companions', 'Ember.md'), '---\ntype: pet\nspecies: Dog\nhousehold: true\n---\n\n# Ember\n');

function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
const boom = (what) => async () => { throw new Error(`${what} reached from a Build 25 flow`); };
stub('./webpush', { sendToAll: boom('webpush.sendToAll'), isConfigured: () => true });
stub('./email-sender', { sendMail: boom('email-sender.sendMail'), sendBriefEmail: boom('email-sender.sendBriefEmail'), OWN_ADDRESS: 'nickw@nurtur.tech' });

const db = require('../db/database');
const PA = require('./personal-admin');

const NOW = Date.now();
const pad = (n) => String(n).padStart(2, '0');
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const TODAY = localDay(NOW);
const plus = (n) => { const d = new Date(Date.UTC(+TODAY.slice(0, 4), +TODAY.slice(5, 7) - 1, +TODAY.slice(8, 10) + n)); return d.toISOString().slice(0, 10); };

// ── candidate shapes, field for field as the owning modules emit them ───────

const due = (days, kind = 'set') => ({ date: plus(days), time: null, kind, label: 'x', days });
function obligation(over = {}) {
  return {
    id: 'task:neuro:1', kind: 'task', what: 'Renew the passport', direction: null, due: null,
    domains: [{ domain: 'admin', label: 'Personal admin', basis: 'declared' }], admin: true, source: 'NEURO', container: null,
    linkedGoals: [], preparesFor: [], companions: [], vehicles: [], status: 'open', actionState: 'preparation_open', needsNow: false,
    needsWhy: 'open, with no date', importance: null, evidence: { source: 'NEURO', freshness: 'local' }, whyPersonal: ['Personal admin (declared)'], realisedBy: null,
    ...over,
  };
}
const CAPTUR = { id: 'vehicle:captur', make: 'Renault', model: 'Captur' };
function vob(over = {}) {
  return { id: 'vob:1', type: 'mot', label: 'MOT', dueDate: plus(40), dueMileage: null, interval: null, linkedTaskRef: null, linkedReminderRef: null,
    status: 'later', statusWhy: 'due in 40 days', recordStatus: 'open', completedOn: null, completionEvidence: null, confidence: 'stated', conflict: null, verifiedBy: null, lastCheckedAt: null, ...over };
}
function fob(over = {}) {
  return { id: 'fob:1', kind: 'renewal', title: 'Home insurance renewal', dueDate: plus(20), requiresDecision: true, linkedTaskRef: null, linkedReminderRef: null,
    status: 'open', state: 'preparation_open', stateWhy: 'needs a decision before it is due', payment: null, seriesKey: null, resolvedAt: null, resolvedEvidence: null, ...over };
}
function care(over = {}) {
  return { id: 'care:1', companionId: 'companion:ember', kind: 'insurance', kindLabel: 'Insurance', title: 'Pet insurance renewal', dueDate: plus(25), dueTime: null,
    recurrence: null, recurrenceWords: null, status: 'open', actionState: 'preparation_open', needsNow: false, why: 'due in 25 days', companionName: 'Ember', ...over };
}
const compose = (cands, anns = new Map(), lookup = new Map()) => PA.composeAdmin({ today: TODAY, candidates: cands, annotations: anns, lookup });
const only = (v) => v.items[0];

// ═══ PERSONAL / WORK ═════════════════════════════════════════════════════════

test('1. a work task never enters Personal Admin by keyword — the obligation reader is the only door, and admin reads no wording', () => {
  // personal-obligations already dropped it (no non-work evidence); an item
  // that somehow carried only work evidence is still not admin here.
  const workish = obligation({ id: 'task:neuro:9', what: 'Renew the insurance admin booking for the account', admin: false, domains: [] });
  assert.equal(PA.fromObligation(workish), null);
  const src = fs.readFileSync(path.join(__dirname, 'personal-admin.js'), 'utf8');
  assert.doesNotMatch(src, /\/(insurance|renew|MOT|booking|admin)\/i?\.test\(/i, 'no wording rule anywhere in the module');
});

test('2. an explicitly personal-admin task appears', () => {
  const v = compose([PA.fromObligation(obligation())]);
  assert.equal(v.items.length, 1);
  assert.equal(only(v).title, 'Renew the passport');
  assert.ok(only(v).whyVisible.some((w) => /^Personal admin — you set it on this item$/.test(w)), JSON.stringify(only(v).whyVisible));
  assert.ok(!only(v).whyVisible.some((w) => /^you set this$/i.test(w)), 'the vague reason is replaced');
});

test('3. a reminder from a list classified admin is admin; one from a family list is not', () => {
  const fromAdminList = obligation({ id: 'task:eventkit-reminders:A', source: 'Reminders', container: { kind: 'reminder-list', name: 'Personal Admin' }, domains: [{ domain: 'admin', basis: 'classified' }] });
  const fromFamily = obligation({ id: 'task:eventkit-reminders:B', source: 'Reminders', admin: false, container: { kind: 'reminder-list', name: 'Family' }, domains: [{ domain: 'family', basis: 'classified' }] });
  const v = compose([PA.fromObligation(fromAdminList), PA.fromObligation(fromFamily)]);
  assert.deepEqual(v.items.map((i) => i.obligationId), ['task:eventkit-reminders:A']);
  assert.match(only(v).completionAuthority, /Apple Reminders/);
  assert.equal(only(v).canTick, false, 'a reminder is ticked in Apple, never here');
});

test('5. explicit reclassification wins — the same item, re-declared admin, now appears', () => {
  const before = obligation({ admin: false, domains: [{ domain: 'family', basis: 'declared' }] });
  const after = obligation({ admin: true, domains: [{ domain: 'admin', basis: 'declared' }] });
  assert.equal(PA.fromObligation(before), null);
  assert.ok(PA.fromObligation(after));
});

// ═══ ACTIONABILITY ═══════════════════════════════════════════════════════════

test('6. a recurring item with nothing to do stays routine; Nick can also mark one routine', () => {
  const plainBill = PA.fromFinance(fob({ id: 'fob:bill', kind: 'bill', title: 'Council tax', requiresDecision: false, dueDate: plus(12), state: 'upcoming', stateWhy: 'due in 12 days' }), { today: TODAY });
  const recurringCare = PA.fromCare(care({ id: 'care:vac', kind: 'vaccination', recurrence: { every: 1, unit: 'year' }, dueDate: plus(200) }), { today: TODAY });
  const v = compose([plainBill, recurringCare]);
  assert.deepEqual(v.items.map((i) => i.state), ['routine', 'routine']);
  const marked = compose([PA.fromObligation(obligation({ due: due(30) }))], new Map([['task:neuro:1', { state: 'routine' }]]));
  assert.equal(only(marked).state, 'routine');
});

test('7. a due-imminent real admin item can become Needs You — by the existing rule, or a lead time Nick set', () => {
  const tomorrow = PA.fromObligation(obligation({ due: due(1), needsNow: true, actionState: 'needs_you', needsWhy: 'due tomorrow' }));
  assert.equal(only(compose([tomorrow])).state, 'needs_you');
  const inTen = PA.fromObligation(obligation({ due: due(10) }));
  assert.equal(only(compose([inTen])).state, 'upcoming', 'ten days out is coming up, not urgent');
  const withLead = compose([inTen], new Map([['task:neuro:1', { leadDays: 14 }]]));
  assert.equal(only(withLead).state, 'needs_you');
  assert.match(only(withLead).stateWhy, /14-day lead you set/);
});

test('8. an undated item never becomes urgent; NEURO\'s placeholder date is not a deadline', () => {
  const undated = only(compose([PA.fromObligation(obligation())]));
  assert.equal(undated.state, 'open');
  assert.equal(undated.urgency, 'none');
  const placeholder = only(compose([PA.fromObligation(obligation({ due: due(0, 'placeholder') }))]));
  assert.equal(placeholder.state, 'open');
  // a lead time cannot make an undated or placeholder item urgent either
  const leadOnPlaceholder = only(compose([PA.fromObligation(obligation({ due: due(2, 'placeholder') }))], new Map([['task:neuro:1', { leadDays: 30 }]])));
  assert.equal(leadOnPlaceholder.state, 'open');
});

test('9. waiting is preserved, and outranks a near date — Nick has acted', () => {
  const c = PA.fromObligation(obligation({ due: due(1), needsNow: true, actionState: 'needs_you' }));
  const v = only(compose([c], new Map([['task:neuro:1', { state: 'waiting', note: 'garage to call back' }]])));
  assert.equal(v.state, 'waiting');
  assert.match(v.stateWhy, /garage to call back/);
});

test('10. blocked requires evidence — a reason. Without one it is NOT treated as blocked', () => {
  const c = PA.fromObligation(obligation({ due: due(20) }));
  const noReason = only(compose([c], new Map([['task:neuro:1', { state: 'blocked', note: null }]])));
  assert.notEqual(noReason.state, 'blocked');
  assert.ok(noReason.whyVisible.some((w) => /needs one/.test(w)));
  const withReason = only(compose([c], new Map([['task:neuro:1', { state: 'blocked', note: 'need the V5C, which is at Mum\'s' }]])));
  assert.equal(withReason.state, 'blocked');
  assert.equal(PA.validateAnnotation({ state: 'blocked' }).value.state, 'blocked', 'validation passes the field; the store refuses the pair (tested over HTTP)');
});

// ═══ VEHICLE ═════════════════════════════════════════════════════════════════

test('11. a recorded MOT obligation is visible, kind vehicle, linked to the Captur', () => {
  const v = only(compose([PA.fromVehicle(vob(), CAPTUR, { today: TODAY })]));
  assert.equal(v.title, 'Captur — MOT');
  assert.equal(v.kind, 'vehicle');
  assert.deepEqual(v.entityLinks.map((l) => l.id), ['vehicle:captur']);
  assert.equal(v.state, 'upcoming');
});

test('12/13. the MOT booking task stays separate as the ACTION, and ticking it does not mark the MOT done', () => {
  const task = PA.fromObligation(obligation({ id: 'task:neuro:374', what: 'Book my car in for its MOT', vehicles: [{ id: 'vehicle:captur', name: 'Renault Captur' }] }));
  const fact = PA.fromVehicle(vob({ linkedTaskRef: 'task:neuro:374' }), CAPTUR, { today: TODAY });
  const open = compose([fact, task]);
  assert.equal(open.items.length, 1, 'shown once');
  assert.equal(open.items[0].obligationId, 'vob:1', 'the fact leads');
  assert.equal(open.items[0].action.id, 'task:neuro:374');
  assert.equal(open.items[0].action.state, 'open');
  // tick the task: the task is DONE, the MOT is still open
  const doneTask = { ...task, status: 'done', doneOn: TODAY };
  const after = compose([PA.fromVehicle(vob({ linkedTaskRef: 'task:neuro:374' }), CAPTUR, { today: TODAY }), doneTask]);
  assert.equal(after.items.length, 1);
  assert.equal(after.items[0].status, 'open', 'the MOT stays open');
  assert.equal(after.items[0].action.state, 'done');
  assert.ok(after.items[0].whyVisible.some((w) => /is ticked — that is the action, not the MOT itself/.test(w)));
});

test('13b. the MOT is done only when its record says so, with evidence', () => {
  const done = PA.fromVehicle(vob({ recordStatus: 'complete', completedOn: plus(-2), completionEvidence: 'MOT passed — certificate' }), CAPTUR, { today: TODAY });
  const v = only(compose([done]));
  assert.equal(v.state, 'done');
  assert.match(v.stateWhy, /certificate/);
  assert.equal(PA.fromVehicle(vob({ recordStatus: 'complete', completedOn: plus(-40), completionEvidence: 'x' }), CAPTUR, { today: TODAY }), null, 'older than two weeks drops off');
});

test('14/15. an explicit vehicle link makes a task vehicle admin; the word "car" alone links nothing', () => {
  const linked = PA.fromObligation(obligation({ vehicles: [{ id: 'vehicle:captur', name: 'Renault Captur' }], domains: [{ domain: 'travel', basis: 'linked' }] }));
  assert.equal(only(compose([linked])).kind, 'vehicle');
  const wordOnly = PA.fromObligation(obligation({ what: 'Book the car in for a service', domains: [{ domain: 'admin', basis: 'declared' }] }));
  const v = only(compose([wordOnly]));
  assert.equal(v.kind, 'other', 'never "vehicle" from wording');
  assert.equal(v.entityLinks.length, 0);
});

// ═══ FINANCE ═════════════════════════════════════════════════════════════════

test('16/20. a normal Direct Debit is never an admin item — recurring series are not read at all', () => {
  const src = fs.readFileSync(path.join(__dirname, 'personal-admin.js'), 'utf8');
  assert.doesNotMatch(src, /\.series\b|_series|recurringCounts|upcoming\.d\d/, 'no Tally recurring series feeds admin');
  assert.match(src, /f\.obligations/, 'positive control: recorded finance obligations do');
});

test('17. a renewal needing a decision is included and actionable', () => {
  const v = only(compose([PA.fromFinance(fob(), { today: TODAY })]));
  assert.equal(v.kind, 'renewal');
  assert.equal(v.state, 'upcoming');
  assert.match(v.stateWhy, /decision/);
});

test('18. a feed needing reconnecting is included; a healthy one is not', () => {
  assert.equal(PA.fromFeed({ accountRef: 'tally-account:4', name: 'Helen', owner: 'helen', state: 'healthy' }), null);
  const c = PA.fromFeed({ accountRef: 'tally-account:4', name: 'Helen', owner: 'helen', state: 'reconnect_required', why: 'no refresh for 5 days' });
  const v = only(compose([c]));
  assert.equal(v.state, 'needs_you');
  assert.equal(v.kind, 'account');
  assert.ok(v.whyVisible.some((w) => /Helen's own account/.test(w)));
  assert.match(v.completionAuthority, /not when a task is ticked/);
});

test('19. a transaction alone never creates an admin item — nothing here reads transactions', () => {
  const src = fs.readFileSync(path.join(__dirname, 'personal-admin.js'), 'utf8');
  assert.doesNotMatch(src, /tally_vehicle_txns|readTally|transactions/);
});

// ═══ HOME / PET / PROJECT ════════════════════════════════════════════════════

test('21/22. household admin appears; a household chore (home domain, not admin) stays out', () => {
  const adminHome = PA.fromObligation(obligation({ id: 'task:neuro:21', what: 'Book the boiler service', domains: [{ domain: 'home', basis: 'declared' }, { domain: 'admin', basis: 'declared' }] }));
  const chore = PA.fromObligation(obligation({ id: 'task:neuro:22', what: 'Clean the gutters', admin: false, domains: [{ domain: 'home', basis: 'declared' }] }));
  assert.equal(chore, null);
  assert.equal(only(compose([adminHome])).kind, 'household');
});

test('23/24. Ember\'s insurance renewal may appear; her walk never does', () => {
  assert.equal(only(compose([PA.fromCare(care(), { today: TODAY })])).kind, 'insurance');
  for (const kind of ['walk', 'flea', 'worm', 'grooming', 'medication']) assert.equal(PA.fromCare(care({ kind }), { today: TODAY }), null, kind);
  // a task linked to her care as WALK is not admin either
  const walkLinked = obligation({ admin: false, domains: [], companions: [{ id: 'companion:ember', name: 'Ember', careKind: 'walk' }] });
  assert.equal(PA.fromObligation(walkLinked), null);
  const vetLinked = obligation({ admin: false, domains: [], companions: [{ id: 'companion:ember', name: 'Ember', careKind: 'vet' }] });
  assert.equal(only(compose([PA.fromObligation(vetLinked)])).kind, 'pet');
});

test('25/26. a project\'s hosting renewal (admin, linked) appears as project admin; its coding task stays in the project', () => {
  const projects = new Map([['task:neuro:25', [{ projectId: 'project:walking-with-ember', name: 'Walking with Ember' }]], ['task:neuro:26', [{ projectId: 'project:walking-with-ember', name: 'Walking with Ember' }]]]);
  const hosting = PA.fromObligation(obligation({ id: 'task:neuro:25', what: 'Renew walkingwithember.co.uk hosting', domains: [{ domain: 'admin', basis: 'declared' }] }), { projectsByTask: projects });
  const coding = PA.fromObligation(obligation({ id: 'task:neuro:26', what: 'Cookie banner', admin: false, domains: [] }), { projectsByTask: projects });
  assert.equal(coding, null);
  const v = only(compose([hosting]));
  assert.equal(v.kind, 'project');
  assert.equal(v.entityLinks[0].name, 'Walking with Ember');
});

// ═══ COMPLETION ══════════════════════════════════════════════════════════════

test('29. a calendar date passing is not completion — a past firm date stays open', () => {
  const past = only(compose([PA.fromObligation(obligation({ due: due(-20) }))]));
  assert.equal(past.state, 'open');
  assert.equal(past.status, 'open');
});

test('30. a payment in Tally does not complete a finance obligation by itself', () => {
  const paid = PA.fromFinance(fob({ payment: 'payment seen in Tally on 2026-10-01 (£200.00)' }), { today: TODAY });
  const v = only(compose([paid]));
  assert.equal(v.status, 'open');
  assert.ok(v.whyVisible.some((w) => /payment seen/.test(w)), 'the payment is shown as evidence');
  const resolved = PA.fromFinance(fob({ status: 'resolved', resolvedAt: `${plus(-1)}T10:00:00Z`, resolvedEvidence: 'you-confirmed' }), { today: TODAY });
  assert.equal(only(compose([resolved])).state, 'done', 'positive control: the record resolving it is what completes it');
});

test('31. a reopened item reads open — an open sighting beats a stale done one', () => {
  const open = PA.fromObligation(obligation());
  const staleDone = { ...PA.fromObligation(obligation()), status: 'done', doneOn: plus(-1) };
  assert.equal(only(compose([staleDone, open])).state, 'open');
  assert.equal(only(compose([open, staleDone])).state, 'open');
});

// ═══ DEDUPE ══════════════════════════════════════════════════════════════════

test('32. a strongly linked duplicate collapses (commitment realised by the task)', () => {
  const task = PA.fromObligation(obligation({ id: 'task:neuro:5' }));
  const commitment = PA.fromObligation(obligation({ id: 'commitment:abc', kind: 'commitment', realisedBy: 'task:neuro:5' }));
  const v = compose([task, commitment]);
  assert.deepEqual(v.items.map((i) => i.obligationId), ['task:neuro:5']);
  assert.equal(v.dedupe.collapsed[0].rule, 'realised-by');
});

test('33. similar titles alone never collapse', () => {
  const a = PA.fromObligation(obligation({ id: 'task:neuro:7', what: 'Renew the car insurance' }));
  const b = PA.fromObligation(obligation({ id: 'task:eventkit-reminders:X', what: 'Renew the car insurance', source: 'Reminders' }));
  assert.equal(compose([a, b]).items.length, 2);
});

test('34. a typed obligation and its task are both preserved, as fact and action', () => {
  const task = PA.fromObligation(obligation({ id: 'task:neuro:8', what: 'Call the insurer about renewal' }));
  const fact = PA.fromFinance(fob({ linkedTaskRef: 'task:neuro:8' }), { today: TODAY });
  const v = compose([task, fact]);
  assert.equal(v.items.length, 1);
  assert.equal(v.items[0].obligationId, 'fob:1');
  assert.equal(v.items[0].action.title, 'Call the insurer about renewal');
});

// ═══ RADAR ═══════════════════════════════════════════════════════════════════

test('35-38. Radar takes real dated admin from the SAME producers; no new attention policy exists', () => {
  const radarSrc = fs.readFileSync(path.join(__dirname, 'future-radar.js'), 'utf8');
  assert.match(radarSrc, /require\('\.\/vehicle'\)\.radar/);
  assert.match(radarSrc, /require\('\.\/finance'\)\.radar/);
  assert.match(radarSrc, /kind: o\.admin \? 'admin' : 'obligation'/);
  // personal-admin decides no attention and sends nothing
  const src = fs.readFileSync(path.join(__dirname, 'personal-admin.js'), 'utf8');
  for (const door of ['webpush', 'sendToAll', 'attention', 'worthInterrupting', 'ambient-push']) assert.doesNotMatch(src, new RegExp(`require\\('\\./${door}`), door);
});

// ═══ SOURCE HEALTH ═══════════════════════════════════════════════════════════

test('25Z. the view is not complete while the core admin list is stale', () => {
  const fresh = PA.sourceHealth({ now: NOW, adminLists: [{ name: 'Personal Admin', openCount: 2, completedCount30d: 0, lastSeenAt: new Date(NOW - 3600e3).toISOString() }] });
  assert.equal(fresh.complete, true);
  const stale = PA.sourceHealth({ now: NOW, adminLists: [{ name: 'Personal Admin', openCount: 2, completedCount30d: 0, lastSeenAt: new Date(NOW - 5 * 86400e3).toISOString() }] });
  assert.equal(stale.complete, false);
  assert.match(stale.why, /open the NEURO or SAiM app/);
  const none = PA.sourceHealth({ now: NOW, adminLists: [] });
  assert.equal(none.complete, false);
});

// ═══ REAL HALF: scratch DB, real stores, real routes ═════════════════════════

let server;
let base;
const AS = { nick: { 'X-Neuro-Pin': 'pin-2525' }, machine: { 'X-Neuro-Api-Token': 'machine-token-25' } };
async function call(method, url, who = 'nick', body) {
  const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...AS[who] }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
let T = {};
let bus; let wm;
const pump = async () => { await bus.pumpConsumer(wm.CONSUMER, { now: NOW }); };
const publish = async () => { require('./obligation-sources').publishNeuroTasks({ now: NOW }); await pump(); };

test.before(async () => {
  await db.init();
  bus = require('./event-bus');
  wm = require('./world-model');
  const app = express();
  app.use(express.json());
  app.use('/api', require('./api-auth'));
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/canonical', require('../routes/canonical'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  require('./personal-world').publishCompanions({ now: NOW });
  const store = require('./task-store');
  const cr = require('./canonical-read');
  T.passport = store.createTask({ text: 'Renew the passport', source: 'manual', domain: 'personal', due_date: plus(10) }).id;
  T.mot = store.createTask({ text: 'Book my car in for its MOT tomorrow. Must do tomorrow.', source: 'mcp', domain: 'work' }).id; // the live #374 shape
  T.work = store.createTask({ text: 'Renew the support contract admin for the account', source: 'manual', domain: 'work' }).id;
  T.chore = store.createTask({ text: 'Clean the gutters', source: 'manual', domain: 'personal' }).id;
  cr.setAnnotation(`task:neuro:${T.passport}`, { domains: ['admin'] }, { now: NOW });
  cr.setAnnotation(`task:neuro:${T.chore}`, { domains: ['home'] }, { now: NOW });
  await publish();
});
test.after(() => { if (server) server.close(); });

const view = () => PA.read({ now: NOW });
const row = (v, id) => v.items.find((i) => i.obligationId === id);

test('R1. live shape: a declared admin task appears, the work-default MOT task and a work "admin" task do not, a chore does not', async () => {
  const v = view();
  assert.ok(row(v, `task:neuro:${T.passport}`), 'declared admin appears');
  assert.equal(row(v, `task:neuro:${T.mot}`), undefined, '4. an unknown/default-work task stays excluded until Nick links or classifies it');
  assert.equal(row(v, `task:neuro:${T.work}`), undefined);
  assert.equal(row(v, `task:neuro:${T.chore}`), undefined);
  assert.ok(v.workExcluded >= 2);
  assert.equal(row(v, `task:neuro:${T.passport}`).canTick, true);
});

test('R2. linking the MOT task to the Captur brings it in as vehicle admin (Nick\'s link, not its words)', async () => {
  const veh = require('./vehicle');
  const made = veh.createVehicle({ make: 'Renault', model: 'Captur', fuelType: 'diesel' }, { now: NOW });
  assert.equal(made.ok, true, made.error);
  T.vehicle = made.vehicle ? made.vehicle.vehicle_id || made.vehicle.id : 'vehicle:captur';
  const r = await call('POST', '/api/canonical/vehicle-links', 'nick', { vehicle: 'Captur', entityId: `task:neuro:${T.mot}` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const it = row(view(), `task:neuro:${T.mot}`);
  assert.ok(it, 'now in Personal admin');
  assert.equal(it.kind, 'vehicle');
});

test('R3. a recorded MOT with that task as its action: shown once; ticking the task leaves the MOT open', async () => {
  const veh = require('./vehicle');
  const ob = veh.addObligation(T.vehicle, { type: 'mot', dueDate: plus(30), linkedTaskRef: `task:neuro:${T.mot}` }, { now: NOW });
  assert.equal(ob.ok, true, ob.error);
  let v = view();
  const fact = row(v, ob.obligation.obligation_id);
  assert.ok(fact);
  assert.equal(fact.action.id, `task:neuro:${T.mot}`);
  assert.equal(row(v, `task:neuro:${T.mot}`), undefined, 'the task is the action, not a second row');
  require('./task-store').updateTask(T.mot, { status: 'done' });
  await publish();
  v = view();
  const after = row(v, ob.obligation.obligation_id);
  assert.equal(after.status, 'open', 'the MOT is not done because the booking task is');
  assert.equal(after.action.state, 'done');
});

test('R4. finance: a plain bill is routine, a renewal needing a decision is actionable', () => {
  const fin = require('./finance');
  assert.equal(fin.addObligation({ kind: 'bill', title: 'Council tax', dueDate: plus(12) }, { now: NOW }).ok, true);
  assert.equal(fin.addObligation({ kind: 'renewal', title: 'Home insurance renewal', dueDate: plus(20), requiresDecision: true }, { now: NOW }).ok, true);
  const v = view();
  const bill = v.items.find((i) => i.title === 'Council tax');
  const ren = v.items.find((i) => i.title === 'Home insurance renewal');
  assert.equal(bill.state, 'routine');
  assert.notEqual(ren.state, 'routine');
  assert.equal(ren.kind, 'renewal');
});

test('R5. Ember: insurance appears, a walk does not', () => {
  const cc = require('./companion-care');
  assert.equal(cc.createItem('companion:ember', { kind: 'insurance', title: 'Pet insurance renewal', dueDate: plus(25) }, { now: NOW }).ok, true);
  assert.equal(cc.createItem('companion:ember', { kind: 'walk', title: 'Evening walk', dueDate: plus(1) }, { now: NOW }).ok, true);
  const v = view();
  assert.ok(v.items.some((i) => /Pet insurance renewal/.test(i.title)));
  assert.ok(!v.items.some((i) => /Evening walk/.test(i.title)));
});

test('R6. annotations over HTTP: waiting saved; blocked without a reason refused; unknown item 404; a machine is refused', async () => {
  const id = `task:neuro:${T.passport}`;
  let r = await call('POST', '/api/canonical/personal-admin/annotations', 'nick', { entityId: id, state: 'waiting', note: 'passport office' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(row(view(), id).state, 'waiting');
  r = await call('POST', '/api/canonical/personal-admin/annotations', 'nick', { entityId: id, state: 'blocked', note: null });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/canonical/personal-admin/annotations', 'nick', { entityId: 'task:neuro:99999', state: 'routine' });
  assert.equal(r.status, 404);
  r = await call('POST', '/api/canonical/personal-admin/annotations', 'nick', { entityId: id, leadDays: 500 });
  assert.equal(r.status, 400, 'refused, not clamped');
  r = await call('POST', '/api/canonical/personal-admin/annotations', 'machine', { entityId: id, state: 'routine' });
  assert.equal(r.status, 403, JSON.stringify(r.json));
  // omitted ≠ null: setting a lead leaves the waiting state alone
  r = await call('POST', '/api/canonical/personal-admin/annotations', 'nick', { entityId: id, leadDays: 14 });
  assert.equal(r.status, 200);
  const ann = row(view(), id).annotation;
  assert.equal(ann.state, 'waiting');
  assert.equal(ann.leadDays, 14);
  await call('POST', '/api/canonical/personal-admin/annotations', 'nick', { entityId: id, state: null, note: null, leadDays: null });
  assert.equal(row(view(), id).annotation, null, 'clearing everything removes the row');
});

test('R7. GET carries the view beside the old fields; Activity renders the annotation line', async () => {
  const r = await call('GET', '/api/canonical/personal-admin');
  assert.equal(r.status, 200);
  assert.equal(r.json.view.contract, 'personal-admin-v1');
  assert.ok(Array.isArray(r.json.items), 'the Build 19 fields are still there');
  const rows = db.all("SELECT * FROM personal_ops_events WHERE kind = 'admin-annotated'");
  assert.ok(rows.length >= 2);
  const lines = require('./activity-timeline').fromPersonalOps(rows).filter(Boolean);
  assert.equal(lines.length, rows.length, 'every admin line renders — none falls to the default case');
  assert.ok(lines.some((l) => /as waiting/.test(l.headline)));
  assert.ok(lines.every((l) => !/passport office/.test(JSON.stringify(l))), 'the note itself is not copied into Activity');
});

test('R8. completion authority: a ticked admin task shows in Recently done; reopening brings it back', async () => {
  const store = require('./task-store');
  store.updateTask(T.passport, { status: 'done' });
  await publish();
  let it = row(view(), `task:neuro:${T.passport}`);
  assert.equal(it.state, 'done', '28. task completion is authoritative for the task');
  store.updateTask(T.passport, { status: 'open' });
  await publish();
  it = row(view(), `task:neuro:${T.passport}`);
  assert.equal(it.state === 'done', false, '31. reopened in its source → open here');
});

test('R9. refresh: first run is a baseline and logs nothing', () => {
  const r = PA.refresh({ now: NOW });
  assert.equal(r.baseline, true);
  assert.equal(r.logged, 0);
  assert.equal(PA.refresh({ now: NOW + 1000 }).baseline, false);
});

// ═══ USER-ACTION LEDGER ══════════════════════════════════════════════════════

test('39-42. a new Nick follow-up becomes ONE personal-admin task; an existing one is reused; nothing lands in work', async () => {
  const fu = require('./build-followups');
  const first = fu.reconcile(fu.BUILD_25, { apply: true, now: NOW });
  assert.equal(first.results[0].outcome, 'created');
  const id = first.results[0].taskId;
  const task = db.getTaskRow(id);
  assert.equal(task.domain, 'personal', '41. never defaulted to work');
  await publish();
  const it = row(view(), `task:neuro:${id}`);
  assert.ok(it, 'it lands in Personal admin');
  const again = fu.reconcile(fu.BUILD_25, { apply: true, now: NOW });
  assert.equal(again.results[0].outcome, 'exists', '40. reused, never duplicated');
  assert.equal(db.all('SELECT id FROM tasks WHERE text = ?', [fu.BUILD_25[0].title]).length, 1, '42. one task');
  assert.equal(fu.verify(fu.BUILD_25).ok, true);
});

// ═══ RENDER ══════════════════════════════════════════════════════════════════

test('P. the Life card renders sections from the server\'s states, and never ranks', async () => {
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  const esbuild = require('esbuild');
  const ROOT = path.join(__dirname, '..', '..');
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'frontend', 'src', 'components', 'canonical', 'FutureRadar.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      b.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiFetch = async () => ({ ok: true, json: async () => ({}) });', loader: 'js' }));
    } }],
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  assert.equal(typeof m.exports.AdminView, 'function', 'positive control');
  const v = view();
  const html = renderToString(React.createElement(m.exports.AdminView, { view: v, busy: false, act: async () => {}, onDone: () => {} })).replace(/<!-- -->/g, '');
  assert.match(html, /Coming up|Needs you/);
  assert.match(html, /Routine/);
  assert.match(html, /Why is this here\?/);
  assert.match(html, /Captur — MOT/);
  assert.doesNotMatch(html, /Evening walk|Clean the gutters|support contract/);
  // never ranks: the section order is the server's state order
  const fake = { ...v, items: [{ ...v.items[0], state: 'routine', obligationId: 'z' }, { ...v.items[0], state: 'needs_you', obligationId: 'a', title: 'FIRST-BY-STATE' }] };
  const h2 = renderToString(React.createElement(m.exports.AdminView, { view: fake, busy: false, act: async () => {}, onDone: () => {} }));
  assert.ok(h2.indexOf('FIRST-BY-STATE') < h2.indexOf('Routine'));
});
