'use strict';

/**
 * Build 17L–Q — personal dates with lead time. Fixtures are the LIVE rows of
 * 7 Oct 2026: "Tracey Allen's birthday" (Google, ward.nickj) AND "Tracey
 * Allen’s 16th Birthday" (the iOS Birthdays calendar) on 9 Oct, and a timed
 * "Wedding anniversary" on 19 Oct.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-pdates-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'p.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
const vault = path.join(tmp, 'vault');
fs.mkdirSync(path.join(vault, 'People'), { recursive: true });
fs.mkdirSync(path.join(vault, 'Companions'), { recursive: true });
process.env.OBSIDIAN_VAULT_PATH = vault;

const db = require('../db/database');
const pd = require('./personal-dates');
const tl = require('./activity-timeline');

test.before(async () => { await db.init(); });

const NOW = Date.parse('2026-10-07T09:00:00Z'); // Wednesday
function meeting(id, title, startLocal, { allDay = 1, calendar = 'ward.nickj@gmail.com', status = 'scheduled' } = {}) {
  db.run(`INSERT INTO wm_meetings (meeting_id, provider, provider_event_id, title, start_local, end_local, is_all_day, status, kind, provenance_kind, confidence,
            observed_at, received_at, evidence_json, fingerprint, updated_at, calendar_name, calendar_key)
          VALUES (?, 'apple', ?, ?, ?, ?, ?, ?, 'unknown', 'observation', 1, 'x', 'x', '[]', ?, 'x', ?, ?)`,
  [id, id, title, startLocal, startLocal.slice(0, 10) + 'T23:59', allDay, status, id, calendar, `eventkit-cal:id:${calendar}`]);
}
function task(id, title, { status = 'open', due = null } = {}) {
  return { taskId: id, title, status, due: due ? { date: due, basis: 'set' } : null };
}

test.before(() => {
  meeting('m-tracey-g', "Tracey Allen's birthday", '2026-10-09T00:00');
  meeting('m-tracey-b', 'Tracey Allen’s 16th Birthday', '2026-10-09T00:00', { calendar: 'Birthdays' });
  meeting('m-anniv', 'Wedding anniversary', '2026-10-19T13:00', { allDay: 0 });
  meeting('m-work', 'Team Standup', '2026-10-09T10:00', { allDay: 0, calendar: 'Work' });
  meeting('m-do', "Tracey's do", '2026-10-10T19:00', { allDay: 0 });
  meeting('m-far', "Isaac Ward's birthday", '2026-10-30T00:00');
});

test('23. an explicitly labelled birthday enters the lead-time loop', () => {
  const r = pd.read({ now: NOW, tasks: [] });
  const t = r.active.find((d) => d.person === 'Tracey Allen');
  assert.ok(t, JSON.stringify(r.active));
  assert.equal(t.kind, 'birthday');
  assert.equal(t.away, 2);
  assert.equal(t.lead, 7); assert.equal(t.leadBasis, 'default');
  assert.equal(t.state, 'nothing-needed');
  assert.equal(t.line, "Tracey Allen's birthday is on Friday.");
  // The Birthdays calendar alone is explicit too, whatever the title says.
  assert.equal(pd.kindFromTitle('Sam Jones'), null, 'the title says nothing');
  meeting('m-contact', 'Sam Jones', '2026-10-11T00:00', { calendar: 'Birthdays' });
  meeting('m-plain', 'Sam Jones', '2026-10-11T18:00', { allDay: 0, calendar: 'ward.nickj@gmail.com' });
  const sam = pd.read({ now: NOW, tasks: [] }).active.filter((d) => d.person === 'Sam Jones');
  assert.equal(sam.length, 1, 'the Birthdays-calendar entry is a birthday; the same name elsewhere is not');
  assert.equal(sam[0].kind, 'birthday'); assert.equal(sam[0].sources[0].basis, 'birthdays-calendar');
  db.run(`DELETE FROM wm_meetings WHERE meeting_id IN ('m-contact','m-plain')`);
});

test('24. an anniversary is handled — 12 days away is inside its 14-day lead, nothing to do', () => {
  const a = pd.read({ now: NOW, tasks: [] }).active.find((d) => d.kind === 'anniversary');
  assert.equal(a.title, 'Wedding anniversary');
  assert.equal(a.person, null, 'no person is invented for "Wedding anniversary"');
  assert.equal(a.away, 12); assert.equal(a.lead, 14);
  assert.equal(a.state, 'nothing-needed');
  assert.match(a.line, /^Wedding anniversary is on Monday 19 Oct\.$/);
});

test('25. an unrelated event is not inferred to be a personal date — or important', () => {
  const r = pd.read({ now: NOW, tasks: [] });
  const all = [...r.active, ...r.later, ...r.passed];
  assert.ok(!all.some((d) => /standup|Tracey's do/i.test(d.title)), 'only an explicit label counts');
  assert.ok(all.every((d) => d.importance === null && d.relationship === null), 'importance and relationship are never guessed');
});

test('26. the same birthday from two calendars is ONE date (same day, kind and full name)', () => {
  const t = pd.read({ now: NOW, tasks: [] }).active.filter((d) => d.person === 'Tracey Allen');
  assert.equal(t.length, 1);
  assert.equal(t[0].sources.length, 2);
  assert.deepEqual(t[0].sources.map((s) => s.basis).sort(), ['birthdays-calendar', 'title-label']);
});

test('27. a weak match stays separate — same day and first name only, or no name at all', () => {
  const d = pd.dedupe([
    { title: "Tracey's birthday", date: '2026-10-09', kind: 'birthday', person: 'Tracey', source: { s: 1 } },
    { title: "Tracey Allen's birthday", date: '2026-10-09', kind: 'birthday', person: 'Tracey Allen', source: { s: 2 } },
    { title: "Tracey Smith's birthday", date: '2026-10-09', kind: 'birthday', person: 'Tracey Smith', source: { s: 3 } },
    { title: "Tracey Allen's birthday", date: '2026-10-10', kind: 'birthday', person: 'Tracey Allen', source: { s: 4 } },
  ]);
  assert.equal(d.length, 4, 'nothing fuzzy-merged');
  assert.equal(pd.dedupe([
    { title: "Tracey Allen's birthday", date: '2026-10-09', kind: 'birthday', person: 'Tracey Allen', source: { s: 1 } },
    { title: 'TRACEY ALLEN’S 16th Birthday', date: '2026-10-09', kind: 'birthday', person: 'TRACEY ALLEN', source: { s: 2 } },
  ]).length, 1, 'positive control: case and apostrophe fold');
});

test('28. no task is ever created — a linked task is only READ', async () => {
  const before = db.get('SELECT COUNT(*) n FROM tasks').n;
  const r = await pd.refresh({ now: NOW, deps: { tasks: [], readMoment: async () => ({ moment: { known: true, now: new Date(NOW) } }) } });
  assert.equal(db.get('SELECT COUNT(*) n FROM tasks').n, before);
  assert.equal(r.asked, 0);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, 'personal-dates.js'), 'utf8'), /createTask|task-store|INSERT INTO tasks|sendToAll/);
});

test('29/31. a near date with OPEN linked prep may surface — and the attention policy, not this loop, decides', async () => {
  const tasks = [task('t1', 'Buy Tracey Allen a present', { due: '2026-10-08' })];
  const tomorrow = Date.parse('2026-10-08T09:00:00Z');
  const t = pd.read({ now: tomorrow, tasks }).active.find((d) => d.person === 'Tracey Allen');
  assert.equal(t.state, 'action-may-be-needed');
  assert.equal(t.line, 'Tracey Allen\'s birthday is tomorrow — "Buy Tracey Allen a present" is still open.');
  // The policy is asked once, in SHADOW, and its veto is recorded as given.
  const ask = (moment) => ({ tasks, readMoment: async () => ({ moment }) });
  const r1 = await pd.refresh({ now: tomorrow, deps: ask({ known: true, inMeeting: true, now: new Date(tomorrow) }) });
  assert.equal(r1.asked, 1);
  const verdict = pd.events().find((e) => e.kind === 'attention');
  assert.equal(verdict.detail.push, false); assert.equal(verdict.detail.why, 'in a meeting');
  assert.equal(verdict.detail.shadow, true); assert.equal(verdict.detail.sent, false);
  const r2 = await pd.refresh({ now: tomorrow + 60000, deps: ask({ known: true, now: new Date(tomorrow) }) });
  assert.equal(r2.asked, 0, 'asked once per date, not every pass');
  // The same open task a week out is just prep on the list.
  const early = pd.read({ now: Date.parse('2026-10-03T09:00:00Z'), tasks }).active.find((d) => d.person === 'Tracey Allen');
  assert.equal(early.state, 'prep-exists');
  const rule = require('./ambient-push').worthInterrupting({ kind: 'personal-date', text: 'x' }, { known: true, now: new Date() });
  assert.equal(rule.push, true, 'positive control: the rule exists and is not duty-gated');
});

test('30. a distant date does not notify — it is "later", off Now, never asked about', async () => {
  const r = pd.read({ now: NOW, tasks: [task('t2', "Isaac Ward's party", { due: '2026-10-29' })] });
  const isaac = r.later.find((d) => d.person === 'Isaac Ward');
  assert.ok(isaac); assert.equal(isaac.state, 'later'); assert.equal(isaac.away, 23);
  assert.ok(!r.active.some((d) => d.person === 'Isaac Ward'));
  // A lead Nick sets moves it into the window — and back.
  assert.equal(pd.setLead(isaac.id, 30, { now: NOW }).ok, true);
  assert.ok(pd.read({ now: NOW, tasks: [] }).active.some((d) => d.person === 'Isaac Ward'));
  assert.equal(pd.setLead(isaac.id, 0).ok, false, 'refused, not clamped');
  assert.equal(pd.setLead(isaac.id, null).ok, true);
  assert.ok(!pd.read({ now: NOW, tasks: [] }).active.some((d) => d.person === 'Isaac Ward'));
});

test('32. a passed date leaves the active loop — listed the day after, then gone', () => {
  const sat = pd.read({ now: Date.parse('2026-10-10T09:00:00Z'), tasks: [] });
  assert.ok(!sat.active.some((d) => d.person === 'Tracey Allen'));
  const p = sat.passed.find((d) => d.person === 'Tracey Allen');
  assert.equal(p.state, 'passed'); assert.equal(p.line, "Tracey Allen's birthday was yesterday.");
  assert.ok(!pd.read({ now: Date.parse('2026-10-12T09:00:00Z'), tasks: [] }).passed.some((d) => d.person === 'Tracey Allen'));
});

test('declared dates: a People note\'s birthday recurs yearly; its relationship is the note\'s own; junk is a named gap', () => {
  fs.writeFileSync(path.join(vault, 'People', 'Helen Ward.md'), '---\nrelationship: wife\nbirthday: 1980-10-12\n---\nHelen\n');
  fs.writeFileSync(path.join(vault, 'Companions', 'Ember.md'), '---\ntype: pet\nbirthday: 13-45\n---\n');
  const r = pd.read({ now: NOW, tasks: [] });
  const h = r.active.find((d) => d.person === 'Helen Ward');
  assert.equal(h.date, '2026-10-12'); assert.equal(h.recurrence, 'yearly');
  assert.equal(h.relationship, 'wife'); assert.equal(h.relationshipBasis, 'declared');
  assert.ok(r.gaps.some((g) => /Ember/.test(g.input)));
  assert.equal(pd.nextOccurrence('02-29', '2026-03-01'), null, 'no 29 Feb in 2026 or 2027');
  assert.equal(pd.nextOccurrence('--01-05', '2026-10-07'), '2027-01-05');
});

test('17W. Activity shows prep linked and the action window — never "checked a date"', () => {
  const { entries } = tl.collect({ fromIso: '2026-10-06T00:00:00Z', toIso: '2026-10-09T00:00:00Z' });
  const mine = entries.filter((e) => e.type.startsWith('personal-date'));
  assert.ok(mine.some((e) => e.type === 'personal-date.prep'));
  assert.ok(mine.some((e) => e.type === 'personal-date.action'));
  assert.ok(!mine.some((e) => /checked|attention/i.test(e.headline)));
});
