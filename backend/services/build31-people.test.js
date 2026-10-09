'use strict';

/**
 * Build 31 — Personal relationships & people context (9 Oct 2026).
 *
 * Fixtures are LIVE shapes off the Pi on 9 Oct 2026: People notes as they are
 * (every one a work contact; `direct-report: true` on the reports; Nick's own
 * note naming Chris Middleton as his manager; single-name notes like Liam;
 * two Andreas and two Nathans), Home Assistant's household roster (Helen and
 * Isaac residents, Lizzy and Daniel visitors — first names only), the diary's
 * "Wedding anniversary" and "julies birthday", the anniversary lead-reminder
 * cadence Nick set on 8 Oct ([10,5,1]), and the real profile line "Wife is
 * Helen; she looks after the 60-litre aquarium."
 *
 * The rule every test leans on: NEURO knows who someone is because Nick said
 * so — never because it watched them enough to guess.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b31-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'p.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.HA_TOKEN = '';
process.env.HA_URL = 'http://127.0.0.1:9';
const VAULT = path.join(tmp, 'vault');
process.env.OBSIDIAN_VAULT_PATH = VAULT;

const db = require('../db/database');
const pm = require('./people-model');
const people = require('./people');
const household = require('./household');
const tl = require('./activity-timeline');
const matrix = require('./authority-matrix');

const NOW = Date.parse('2026-10-09T15:00:00Z'); // Friday 16:00 BST
const TODAY = '2026-10-09';


// ── fixtures ────────────────────────────────────────────────────────────────
function note(dir, name, fm, body = '') {
  fs.mkdirSync(path.join(VAULT, dir), { recursive: true });
  fs.writeFileSync(path.join(VAULT, dir, `${name}.md`), `---\n${fm}\n---\n\n# ${name}\n${body}`);
}
const readNote = (dir, name) => fs.readFileSync(path.join(VAULT, dir, `${name}.md`), 'utf8');

note('People', 'Nick Ward', 'type: person\nrole: "Head of Technical Support"\nteam: Service Delivery\nmanager: "[[Chris Middleton]]"\nlast-contact: 2026-10-08');
note('People', 'Chris Middleton', 'type: person\nteam: Infrastructure\nlast-contact: 2026-10-07');
note('People', 'Abdi Mohamed', 'type: person\nteam: Support\nstatus: Active\ndirect-report: true\nmanager: "[[Nick Ward]]"\nemail: abdi.mohamed@nurtur.tech\nlast-contact: 2026-10-09');
note('People', 'Luke Scaife', 'type: person\nteam: Support\nstatus: Active\ndirect-report: true\nemail: luke.scaife@nurtur.tech');
note('People', 'Liam', 'type: person\nteam: Unknown\ndirect-report: false\nstatus: active');
note('People', 'Andrea Glykofrydis', 'type: person\nteam: Unknown\nstatus: active');
note('People', 'Andrea Melisa', 'type: person\nteam: Comms Managed\naliases:\n  - Andrea M');
note('People', 'Nathan Button', 'type: person\nteam: TOM\naliases:\n  - Nath');
note('People', 'Nathan Rutland', 'type: person\nteam: Support\ndirect-report: true');
note('People', 'Warren Patmore', 'type: person\nteam: External');
note('People', 'Julie Ward', 'type: person\nbirthday: 10-25');
note('People', 'Jules', 'type: person');
fs.writeFileSync(path.join(VAULT, 'People', 'Julie Ward.md'), readNote('People', 'Julie Ward').replace('birthday: 10-25', 'birthday: 10-25\naliases:\n  - Jules'));
note('Companions', 'Ember', 'type: pet\nspecies: dog\nhousehold: true');
fs.mkdirSync(path.join(VAULT, 'Me'), { recursive: true });
fs.writeFileSync(path.join(VAULT, 'Me', 'About Nick.md'), `---\ntype: profile\n---\n\n# About Nick\n\n## What I care about\n\n- Wife is Helen; she looks after the 60-litre aquarium. <!--p:interview 2026-08-31-->\n- Marillion's Misplaced Childhood is a long-running deep obsession. <!--p:seed 2026-08-31-->\n`);

// HA's household roster as it really is (first names, role, state). The
// presence projection is replaced with this read so tests do not need HA.
let ROSTER = [
  { name: 'Helen', role: 'resident', state: 'home' }, { name: 'Isaac', role: 'resident', state: 'home' },
  { name: 'Lizzy', role: 'visitor', state: 'away' }, { name: 'Daniel', role: 'visitor', state: 'away' },
];
let ROSTER_KNOWN = true;
household.read = () => ({ known: ROSTER_KNOWN, source: { state: ROSTER_KNOWN ? 'healthy' : 'unknown' },
  members: [{ id: 'nick', name: 'Nick', role: 'self', state: 'home' }, ...ROSTER.map((m) => ({ id: m.name.toLowerCase(), ...m })), { id: 'ember', name: 'Ember', role: 'companion', state: 'untracked' }] });

function meeting(id, title, day) {
  db.run(`INSERT OR REPLACE INTO wm_meetings (meeting_id, provider, provider_event_id, title, start_local, end_local, is_all_day, status, kind,
            provenance_kind, observed_at, received_at, evidence_json, updated_at, calendar_name)
          VALUES (?, 'apple', ?, ?, ?, ?, 1, 'scheduled', 'unknown', 'fact', ?, ?, '[]', ?, 'ward.calander@gmail.com')`,
  [id, id, title, `${day}T00:00`, `${day}T23:59`, new Date(NOW).toISOString(), new Date(NOW).toISOString(), new Date(NOW).toISOString()]);
}

function commitment(id, { direction, promisor = null, beneficiary = null, desc, due = null, method = 'exact-name' }) {
  db.run(`INSERT OR REPLACE INTO wm_commitments (commitment_id, description, direction, promisor_person_id, promisor_raw, promisor_method,
            beneficiary_kind, beneficiary_person_id, beneficiary_method, status, due_date, due_basis, source_kind, source_ref,
            provenance_kind, observed_at, received_at, evidence_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 'meeting-task', ?, 'inference', ?, ?, '[]', ?, ?)`,
  [id, desc, direction, promisor, promisor ? promisor.slice(7) : null, promisor ? method : null,
    beneficiary ? 'person' : 'unknown', beneficiary, beneficiary ? method : null, due, due ? 'stated' : null, id,
    new Date(NOW).toISOString(), new Date(NOW).toISOString(), new Date(NOW).toISOString(), new Date(NOW).toISOString()]);
}

async function publish() {
  require('./world-sources').publishPeople({ now: NOW });
  await require('./event-bus').pumpConsumer('world-model');
}
const all = () => { const r = people.read({ now: NOW }); return { r, cards: [r.self, ...r.sections.flatMap((s) => s.people)].filter(Boolean) }; };
const cardOf = (name) => all().cards.find((c) => c.name === name);
const tableCounts = () => Object.fromEntries(db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
  .map((t) => [t.name, db.get(`SELECT COUNT(*) AS n FROM "${t.name}"`).n]));
const allKeys = (o, out = new Set()) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { out.add(k); allKeys(v, out); } return out; };
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

let server = null; let base = null;
test.after(() => { if (server) { server.closeAllConnections(); server.close(); } });

test.before(async () => {
  await db.init();
  assert.equal(path.resolve(db.get('PRAGMA database_list').file), path.resolve(process.env.NEURO_DB_PATH), 'the scratch DB, never the live one');
  meeting('apple:wa', 'Wedding anniversary', '2026-10-19');
  meeting('apple:jb', 'julies birthday', '2026-10-25');
  // Luke owes Nick thirty things — the most "contact" anyone has. It must buy no closeness.
  for (let i = 0; i < 30; i += 1) commitment(`commitment:waiting:luke${i}`, { direction: 'to-nick', promisor: 'person:luke-scaife', desc: `Luke to send update ${i}` });
  commitment('commitment:task:1', { direction: 'by-nick', promisor: 'person:nick-ward', beneficiary: 'person:abdi-mohamed', desc: 'Send Abdi the October rota', due: TODAY });
  commitment('commitment:waiting:julie', { direction: 'to-nick', desc: 'Julie to confirm the party date' });
});

test('setup: the People notes project into wm_people (the ONE canonical Person)', async () => {
  require('./date-nags').setCadence({ kind: 'anniversary', offsets: [10, 5, 1] }, { now: NOW });
  await publish();
  const n = db.get('SELECT COUNT(*) AS n FROM wm_people').n;
  assert.equal(n, 12);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE '%people%' AND name NOT IN ('wm_people')").n, 0, 'no second people store');
});

// ── relationship authority (1–6) ───────────────────────────────────────────

test('1. an explicit relationship in the note is accepted, with its basis', async () => {
  fs.writeFileSync(path.join(VAULT, 'People', 'Liam.md'), readNote('People', 'Liam').replace('status: active', 'status: active\nrelationship: friend'));
  await publish();
  const liam = cardOf('Liam');
  assert.deepEqual([liam.relationship.type, liam.relationship.basis], ['friend', 'declared']);
  assert.match(liam.relationship.why, /People note says so/);
  // put it back for the tests that need Liam unknown
  fs.writeFileSync(path.join(VAULT, 'People', 'Liam.md'), readNote('People', 'Liam').replace('\nrelationship: friend', ''));
  await publish();
  assert.equal(cardOf('Liam').relationship.type, 'unknown');
});

test('2. message/commitment frequency cannot assign "friend" — Luke owes Nick 30 things and is still only his direct report', () => {
  const luke = cardOf('Luke Scaife');
  assert.equal(luke.commitments.owesNick, 30);
  assert.deepEqual([luke.relationship.type, luke.relationship.basis], ['direct_report', 'note-field'], 'from direct-report: true, nothing else');
  assert.equal(luke.sphere.value, 'work');
  // A person whose only evidence is volume stays unknown.
  const fake = { personId: 'person:x', displayName: 'X Person', emailCount: 400, meetingsLast30: 22, lastContact: TODAY };
  assert.equal(pm.relationshipFor(fake).type, 'unknown');
});

test('3. visit frequency cannot assign family — a visitor who is round every day is still not family', () => {
  ROSTER = ROSTER.map((m) => (m.name === 'Daniel' ? { ...m, state: 'home' } : m));
  for (let i = 0; i < 5; i += 1) people.read({ now: NOW + i * 3600000 });
  const { r } = all();
  const dan = r.unlinkedHousehold.find((u) => u.name === 'Daniel');
  assert.ok(dan, 'visiting now, so listed — as a visitor');
  assert.equal(dan.role, 'visitor');
  assert.equal(dan.relationship, undefined, 'no relationship at all');
  assert.ok(!r.sections.find((s) => s.id === 'family').people.length);
  ROSTER = ROSTER.map((m) => (m.name === 'Daniel' ? { ...m, state: 'away' } : m));
});

test('4. a shared surname cannot assign family — Julie Ward is not Nick\'s relative because of "Ward"', () => {
  const julie = cardOf('Julie Ward');
  assert.equal(julie.relationship.type, 'unknown');
  assert.equal(julie.group, 'unknown');
});

test('5. household presence cannot assign spouse/child — Helen: resident, home, a "Wedding anniversary" in the diary and "Wife is Helen" in the profile, still not said', () => {
  const { r } = all();
  const helen = r.unlinkedHousehold.find((u) => u.name === 'Helen');
  assert.ok(helen && helen.role === 'resident');
  assert.equal(helen.relationship, undefined);
  assert.deepEqual(helen.youWrote, ['Wife is Helen; she looks after the 60-litre aquarium.'], 'shown verbatim, for Nick to confirm');
  assert.ok(r.unlinkedDates.some((d) => d.title === 'Wedding anniversary' && d.person === null), 'the anniversary names nobody, so it is attached to nobody');
  assert.equal(pm.relationshipFor({ personId: 'person:helen', displayName: 'Helen', household: true }).type, 'unknown', 'household alone is not a relationship');
});

test('6. an explicit correction wins over a note field — and is written into the note', async () => {
  const r = await people.classify('person:abdi-mohamed', { relationshipType: 'colleague' }, { now: NOW });
  assert.equal(r.ok, true);
  assert.deepEqual([r.person.relationship.type, r.person.relationship.basis], ['colleague', 'declared'], 'beats direct-report: true');
  assert.match(readNote('People', 'Abdi Mohamed'), /^relationship: "colleague"$/m);
  assert.match(readNote('People', 'Abdi Mohamed'), /^direct-report: true$/m, 'nothing else on the note touched');
  await people.classify('person:abdi-mohamed', { relationshipType: null }, { now: NOW + 1 });
  assert.deepEqual([cardOf('Abdi Mohamed').relationship.type, cardOf('Abdi Mohamed').relationship.basis], ['direct_report', 'note-field'], 'clearing returns to the field');
  assert.doesNotMatch(readNote('People', 'Abdi Mohamed'), /^relationship:/m);
});

// ── sphere (7–10) ──────────────────────────────────────────────────────────

test('7. a work colleague stays work — team field, no relationship stated', () => {
  const chris = cardOf('Chris Middleton');
  assert.deepEqual([chris.relationship.type, chris.relationship.basis], ['manager', 'note-field'], "Nick's own note names him as manager");
  assert.equal(chris.sphere.value, 'work');
  assert.equal(chris.group, 'work');
  const warren = cardOf('Warren Patmore');
  assert.deepEqual([warren.sphere.value, warren.group], ['work', 'work']);
});

test('8. family stays personal; 9. "both" requires Nick to say so', async () => {
  const created = await people.createPerson({ name: 'Helen Ward', rosterName: 'Helen', relationshipType: 'spouse_partner' }, { now: NOW + 10 });
  assert.equal(created.ok, true, created.error);
  const helen = cardOf('Helen Ward');
  assert.deepEqual([helen.relationship.type, helen.sphere.value, helen.sphere.basis], ['spouse_partner', 'personal', 'relationship']);
  // 9: a colleague he also sees socially is still work until he says both.
  const abdi = cardOf('Abdi Mohamed');
  assert.equal(abdi.sphere.value, 'work');
  await people.classify('person:abdi-mohamed', { sphere: 'both' }, { now: NOW + 11 });
  assert.deepEqual([cardOf('Abdi Mohamed').sphere.value, cardOf('Abdi Mohamed').sphere.basis], ['both', 'declared']);
  assert.equal(pm.sphereFor({ displayName: 'X', team: 'Support' }, { type: 'friend', label: 'Friend' }).value, 'personal', 'a friend relationship without sphere: personal, never both');
});

test('10. unknown stays unknown — no team, no relationship, no guess', () => {
  const liam = cardOf('Liam');
  assert.deepEqual([liam.relationship.type, liam.sphere.value, liam.group], ['unknown', 'unknown', 'unknown'], 'team: Unknown is not work evidence');
  assert.equal(cardOf('Andrea Glykofrydis').sphere.value, 'unknown');
});

// ── household (11–13) ──────────────────────────────────────────────────────

test('11. household membership is separate from relationship', async () => {
  const helen = cardOf('Helen Ward');
  assert.equal(helen.household.value, true);
  assert.equal(helen.household.basis, 'configured', 'from the HA roster Nick configured — matched by the alias he kept');
  assert.equal(helen.rosterMatch.method, 'exact-alias');
  assert.equal(helen.group, 'household');
  assert.equal(helen.relationship.type, 'spouse_partner', 'both facts held, neither collapsed into the other');
  const isaacNote = await people.createPerson({ name: 'Isaac Ward', rosterName: 'Isaac', relationshipType: 'child' }, { now: NOW + 12 });
  assert.equal(isaacNote.ok, true);
  const isaac = cardOf('Isaac Ward');
  assert.deepEqual([isaac.relationship.type, isaac.household.value, isaac.group], ['child', true, 'household']);
});

test('12. a resident is never inferred from a device on the Wi-Fi; 13. a visitor is never promoted to household', () => {
  // A person who is "home" by presence but not on the roster has no household value.
  assert.equal(pm.householdFor({ displayName: 'Phone Guest' }, null).value, null);
  ROSTER = ROSTER.map((m) => (m.name === 'Lizzy' ? { ...m, state: 'home' } : m));
  const { r } = all();
  const lizzy = r.unlinkedHousehold.find((u) => u.name === 'Lizzy');
  assert.equal(lizzy.role, 'visitor');
  assert.equal(pm.householdFor({ displayName: 'Lizzy W' }, { role: 'visitor' }).value, false);
  assert.equal(r.counts.household, 2, 'Helen and Isaac only — never the visiting Lizzy');
  ROSTER = ROSTER.map((m) => (m.name === 'Lizzy' ? { ...m, state: 'away' } : m));
});

// ── identity (14–17) ───────────────────────────────────────────────────────

test('14. a strong alias links; 15. the same first name never does', () => {
  const ppl = require('./world-model').listPeople();
  assert.equal(pm.matchPerson('Nath', ppl).person.displayName, 'Nathan Button');
  assert.equal(pm.matchPerson('Helen', ppl).method, 'exact-alias');
  assert.equal(pm.matchPerson('Nathan', ppl), null, 'two Nathans — and one is not enough either');
  assert.equal(pm.matchPerson('Andrea', ppl), null);
  assert.equal(pm.matchPerson('Chris', ppl), null, 'Chris Middleton is the only Chris here, and a first name still does not link');
  const dups = all().r.duplicates;
  assert.ok(!dups.some((d) => /Andrea/.test(d.a.name) && /Andrea/.test(d.b.name)), 'two Andreas are not a duplicate');
});

test('16. a likely duplicate is surfaced for review; 17. it is never auto-merged', () => {
  const before = readNote('People', 'Jules');
  const dups = all().r.duplicates;
  const d = dups.find((x) => [x.a.name, x.b.name].sort().join('|') === 'Jules|Julie Ward');
  assert.ok(d, 'Julie Ward lists "Jules" as an alias and a note called Jules exists');
  assert.match(d.why.join(' '), /alias/);
  assert.equal(readNote('People', 'Jules'), before, 'no note written by reading');
  assert.ok(cardOf('Jules') && cardOf('Julie Ward'), 'both still people');
});

// ── dates (18–22) ──────────────────────────────────────────────────────────

test('18. a birthday is a fact on the person; 19. it creates no task; 22. its source is kept', () => {
  const tasksBefore = db.get('SELECT COUNT(*) AS n FROM tasks').n;
  const julie = cardOf('Julie Ward');
  const b = julie.dates.find((x) => x.kind === 'birthday');
  assert.ok(b, 'declared birthday attached by the note it is declared in');
  assert.equal(b.date, '2026-10-25');
  assert.ok(b.source.includes('declared'));
  assert.equal(b.reminder.policy, 'none');
  assert.match(b.reminder.why, /nothing notifies/);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM tasks').n, tasksBefore);
  const un = all().r.unlinkedDates.find((x) => x.title === 'julies birthday');
  assert.ok(un, 'the diary\'s "julies birthday" names no person NEURO can match');
  assert.ok(un.source.includes('title-label'));
});

test('20. an anniversary uses the existing cadence; 21. an unconfigured birthday never pushes; 42. the configured last step reaches Needs You once', async () => {
  const fe = require('./frontmatter-edit');
  const file = path.join(VAULT, 'People', 'Helen Ward.md');
  fs.writeFileSync(file, fe.upsertFrontmatterValue(fs.readFileSync(file, 'utf8'), 'anniversary', '10-10'));
  const helen = cardOf('Helen Ward');
  const a = helen.dates.find((x) => x.kind === 'anniversary');
  assert.deepEqual(a.reminder.offsets, [10, 5, 1]);
  assert.equal(a.reminder.policy, 'lead-reminders');
  // Run the real lead-reminder job at 10:00 the day before (anniversary 1 away; Julie's birthday 16 away).
  const sent = [];
  const nags = require('./date-nags');
  await nags.run({ now: Date.parse('2026-10-09T09:00:00Z'), send: async (t, b) => { sent.push(t); } });
  assert.equal(sent.length, 1, 'one push — the anniversary\'s configured last step');
  assert.match(sent[0], /anniversary/i);
  assert.ok(!sent.some((t) => /birthday/i.test(t)));
  await nags.run({ now: Date.parse('2026-10-09T10:00:00Z'), send: async (t) => { sent.push(t); } });
  assert.equal(sent.length, 1, 'never twice');
  fs.writeFileSync(file, fe.removeFrontmatterKey(fs.readFileSync(file, 'utf8'), 'anniversary'));
});

// ── presence (23–26) ───────────────────────────────────────────────────────

test('23. presence shows current context; 24. it never changes the relationship; 25/26. no obligation, no timeline', () => {
  const before = tableCounts();
  const home = cardOf('Helen Ward');
  assert.deepEqual([home.presence.state, home.presence.now], ['home', true]);
  ROSTER = ROSTER.map((m) => (m.name === 'Helen' ? { ...m, state: 'away' } : m));
  const out = cardOf('Helen Ward');
  assert.equal(out.presence.state, 'away');
  assert.deepEqual([out.relationship, out.household.value, out.group], [home.relationship, true, 'household']);
  ROSTER_KNOWN = false;
  assert.equal(cardOf('Helen Ward').presence.state, 'unknown', 'an unreadable roster is unknown, never away');
  ROSTER_KNOWN = true;
  ROSTER = ROSTER.map((m) => (m.name === 'Helen' ? { ...m, state: 'home' } : m));
  assert.deepEqual(tableCounts(), before, 'reading wrote nothing — no visit row, no task, no commitment');
  const keys = allKeys(people.read({ now: NOW }));
  for (const k of ['visits', 'history', 'lastSeen', 'lastVisit', 'seenAt', 'timeline']) assert.ok(!keys.has(k), k);
});

// ── communication (27–29) ─────────────────────────────────────────────────

test('27. email/contact frequency cannot create closeness; 29. no "haven\'t spoken" logic anywhere', () => {
  const payload = people.read({ now: NOW });
  const keys = allKeys(payload);
  for (const k of ['lastContact', 'last-contact', 'contactCount', 'emailCount', 'messageCount', 'frequency', 'closeness', 'daysSinceContact']) assert.ok(!keys.has(k), k);
  assert.equal(payload.sources.find((s) => s.id === 'communication').state, 'not-used');
  const text = JSON.stringify(payload);
  assert.doesNotMatch(text, /haven.?t spoken|last spoke|keep in touch|catch up with|days since you/i);
  for (const f of ['people.js', 'people-model.js']) {
    const src = strip(fs.readFileSync(path.join(__dirname, f), 'utf8'));
    assert.doesNotMatch(src, /last-contact|lastContact|haven.?t spoken|sendToAll|webpush/, f);
  }
  // positive control: the live note field exists and the scan would see it
  assert.match(readNote('People', 'Abdi Mohamed'), /last-contact/);
});

test('28. an unanswered explicit commitment surfaces on the person; 32. who owes whom is preserved', () => {
  const abdi = cardOf('Abdi Mohamed');
  assert.equal(abdi.commitments.nickOwes, 1);
  assert.equal(abdi.commitments.items[0].description, 'Send Abdi the October rota');
  assert.equal(abdi.commitments.items[0].direction, 'nick-owes');
  assert.equal(cardOf('Luke Scaife').commitments.items[0].direction, 'owes-nick');
  assert.equal(cardOf('Luke Scaife').commitments.items.length, 3, 'a sample, never a wall');
});

// ── commitments (30–31) ────────────────────────────────────────────────────

test('30. an explicit person-linked task links; 31. a mention alone creates nothing', () => {
  require('./task-store').createTask({ text: 'Ask Julie about the party venue', source: 'manual' });
  const tid = db.get("SELECT id FROM tasks WHERE text LIKE 'Ask Julie%'").id;
  assert.deepEqual(cardOf('Julie Ward').linkedTasks, [], 'the name in the text links nothing');
  const commitmentsBefore = db.get('SELECT COUNT(*) AS n FROM wm_commitments').n;
  const r = require('./personal-obligations').linkPrep({ subjectId: 'person:julie-ward', entityId: `task:neuro:${tid}` }, { now: NOW });
  assert.equal(r.ok, true);
  assert.deepEqual(cardOf('Julie Ward').linkedTasks.map((t) => t.entityId), [`task:neuro:${tid}`]);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM wm_commitments').n, commitmentsBefore, 'no commitment invented');
  assert.equal(cardOf('Julie Ward').commitments.open, 0, '"Julie to confirm…" is unresolved (no full name) and stays so');
});

// ── privacy (33–37) ────────────────────────────────────────────────────────

test('33. no social score; 34. no inferred traits; 35. no communication dashboard', () => {
  const keys = allKeys(people.read({ now: NOW }));
  for (const k of ['score', 'socialScore', 'closenessScore', 'engagement', 'relationshipHealth', 'strength', 'rank', 'traits', 'personality', 'mood', 'sentiment']) {
    assert.ok(!keys.has(k), k);
  }
  const src = strip(fs.readFileSync(path.join(__dirname, 'people-model.js'), 'utf8'));
  assert.doesNotMatch(src, /closeness|engagement|sentiment|personality/i);
  // likes only from the note itself
  const julieFile = path.join(VAULT, 'People', 'Julie Ward.md');
  assert.equal(cardOf('Julie Ward').context.personal, null);
});

test('36. reading People creates no logs at all', () => {
  const before = tableCounts();
  for (let i = 0; i < 3; i += 1) { people.read({ now: NOW + i }); people.detail('person:helen-ward', { now: NOW }); }
  assert.deepEqual(tableCounts(), before);
});

test('37. a machine client cannot alter a relationship — matrix and real HTTP through the guard', async () => {
  const express = require('express');
  const app = express(); app.use(express.json());
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/people', require('../routes/people'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const before = readNote('People', 'Liam');
  const res = await fetch(`${base}/api/people/${encodeURIComponent('person:liam')}/classify`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Neuro-Machine-Client': 'sara' }, body: JSON.stringify({ relationshipType: 'friend' }) });
  assert.equal(res.status, 403);
  assert.equal(readNote('People', 'Liam'), before);
  for (const p of ['/api/people', '/api/people/duplicates/decide', '/api/people/links/reject', '/api/people/person:liam/classify']) {
    assert.equal(matrix.machineDecision('POST', p).allow, false, p);
  }
  assert.equal(matrix.machineDecision('GET', '/api/people').allow, true);
  assert.equal(matrix.machineDecision('GET', '/api/people/person:liam').allow, true);
  // Gateway: every write is interactive (machine-refused) there too.
  const policy = fs.readFileSync(path.join(__dirname, '..', '..', 'mcp-server', 'remote', 'api-policy.js'), 'utf8');
  const interactiveBlock = policy.slice(policy.indexOf('export const interactive'), policy.indexOf('export const notes'));
  for (const id of ['post_people:', 'post_people_duplicates_decide:', 'post_people_links_reject:', 'post_people_by_personId_classify:']) assert.ok(interactiveBlock.includes(id), id);
});

// ── Now / Radar / Needs You (38–43) ────────────────────────────────────────

test('38. a relevant commitment enters Now (by the existing rule); 39. generic presence does not', () => {
  const cr = require('./canonical-read');
  const c = cr.commitments({ now: NOW }).items.find((i) => i.id === 'commitment:task:1' || i.commitmentId === 'commitment:task:1');
  assert.ok(c, 'the commitment is in the canonical read');
  assert.equal(cr.commitmentIsNowRelevant(c), true, 'stated due today → Now');
  // 39: nothing in the Now/Radar/attention composers reads People presence.
  for (const f of ['canonical-read.js', 'future-radar.js', 'attention.js', 'presentation-intent.js', 'notification-policy.js']) {
    const src = strip(fs.readFileSync(path.join(__dirname, f), 'utf8'));
    assert.doesNotMatch(src, /require\(['"]\.\/people['"]\)/, f);
  }
  assert.match(strip(fs.readFileSync(path.join(__dirname, '..', 'routes', 'people.js'), 'utf8')), /require\(['"]\.\.\/services\/people['"]\)/, 'positive control');
});

test('40. a configured date can enter Radar; 41. low contact frequency never does', () => {
  const rd = require('./future-radar').read({ now: NOW, horizonDays: 30 });
  const items = rd.items || [];
  assert.ok(items.some((i) => /julie/i.test(i.title || '') && /birthday/i.test(i.title || '')), 'Julie Ward\'s declared birthday is on the 30-day Radar');
  assert.ok(!items.some((i) => /catch up|call|keep in touch|haven.?t/i.test(i.title || '')), 'no social-maintenance item');
  assert.ok(!items.some((i) => /Luke|Liam|Chris/i.test(i.title || '')));
});

test('43. Build 31 adds no notification policy — no new push type, no attention rule', () => {
  for (const f of ['people.js', 'people-model.js']) {
    const src = strip(fs.readFileSync(path.join(__dirname, f), 'utf8'));
    assert.doesNotMatch(src, /sendToAll|webpush|ambient-push|worthInterrupting|notify\(/, f);
  }
  const ap = strip(fs.readFileSync(path.join(__dirname, 'ambient-push.js'), 'utf8'));
  assert.doesNotMatch(ap, /people|relationship/i);
});

// ── corrections (44–48) ────────────────────────────────────────────────────

test('44–48. corrections over real HTTP are auditable: relationship, sphere, household, merge/keep-separate, date', async () => {
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  const evBefore = db.get("SELECT COUNT(*) AS n FROM personal_ops_events WHERE kind LIKE 'person-%'").n;
  // 44 relationship
  const r1 = await post(`/api/people/${encodeURIComponent('person:liam')}/classify`, { relationshipType: 'friend', relationshipDetail: 'old school friend' });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.deepEqual([r1.body.person.relationship.type, r1.body.person.relationship.detail], ['friend', 'old school friend']);
  // 45 sphere
  assert.equal((await post(`/api/people/${encodeURIComponent('person:liam')}/classify`, { sphere: 'personal' })).body.person.sphere.value, 'personal');
  // 46 household
  assert.equal((await post(`/api/people/${encodeURIComponent('person:liam')}/classify`, { household: false })).body.person.household.value, false);
  // refusals, never quiet normalising
  assert.equal((await post(`/api/people/${encodeURIComponent('person:liam')}/classify`, { relationshipType: 'bestie' })).status, 400);
  assert.equal((await post(`/api/people/${encodeURIComponent('person:liam')}/classify`, { sphere: 'mostly' })).status, 400);
  assert.equal((await post(`/api/people/${encodeURIComponent('person:liam')}/classify`, { household: 'yes' })).status, 400);
  assert.equal((await post(`/api/people/${encodeURIComponent('person:liam')}/classify`, {})).status, 400, 'nothing to change');
  assert.equal((await post(`/api/people/${encodeURIComponent('person:nobody')}/classify`, { relationshipType: 'friend' })).status, 404);
  assert.equal((await post(`/api/people/${encodeURIComponent('person:nick-ward')}/classify`, { relationshipType: 'friend' })).status, 409, 'not your own note');
  // 47 keep-separate, merge, unmerge
  const ks = await post('/api/people/duplicates/decide', { a: 'person:jules', b: 'person:julie-ward', decision: 'keep-separate' });
  assert.equal(ks.status, 200);
  assert.ok(!all().r.duplicates.some((d) => /Jules/.test(d.a.name + d.b.name)), 'decided — no longer surfaced');
  const mg = await post('/api/people/duplicates/decide', { a: 'person:jules', b: 'person:julie-ward', decision: 'merge', keep: 'person:julie-ward' });
  assert.equal(mg.status, 200, JSON.stringify(mg.body));
  assert.match(readNote('People', 'Jules'), /^merged-into: "\[\[Julie Ward\]\]"$/m, 'marked, never deleted');
  assert.ok(!cardOf('Jules'), 'a merged note leaves the sections');
  assert.ok(all().r.merged.some((m) => m.name === 'Jules'));
  const um = await post('/api/people/duplicates/decide', { a: 'person:jules', b: 'person:julie-ward', decision: 'unmerge', keep: 'person:julie-ward' });
  assert.equal(um.status, 200);
  assert.doesNotMatch(readNote('People', 'Jules'), /merged-into/);
  assert.ok(cardOf('Jules'));
  // not-this-person on a roster match, and undo
  const nt = await post('/api/people/links/reject', { subject: 'household:helen', personId: 'person:helen-ward' });
  assert.equal(nt.status, 200);
  assert.equal(cardOf('Helen Ward').rosterMatch, null, 'the alias match is refused');
  assert.ok(all().r.unlinkedHousehold.some((u) => u.name === 'Helen'));
  assert.equal((await post('/api/people/links/reject', { subject: 'household:helen', personId: 'person:helen-ward', restore: true })).status, 200);
  assert.ok(cardOf('Helen Ward').rosterMatch);
  // 48 date correction — the existing declared-date writer, now visible on the person
  assert.equal(require('./personal-dates').setDeclared({ entity: 'People/Liam', kind: 'birthday', date: '11-02' }).ok, true);
  assert.ok(cardOf('Liam').dates.some((d) => d.kind === 'birthday' && d.date === '2026-11-02'));
  assert.ok(db.get("SELECT COUNT(*) AS n FROM personal_date_events WHERE kind = 'declared-set'").n >= 1, 'the date writer audits it');

  // the audit: append-only rows by Nick, with from → to
  const rows = db.all("SELECT * FROM personal_ops_events WHERE kind LIKE 'person-%' ORDER BY id");
  assert.ok(rows.length - evBefore >= 8);
  assert.ok(rows.every((r) => r.actor === 'nick'));
  const rel = rows.map((r) => ({ kind: r.kind, d: JSON.parse(r.detail_json) })).find((x) => x.kind === 'person-classified' && x.d.name === 'Liam' && x.d.field === 'relationship');
  assert.deepEqual([rel.d.from, rel.d.to], [null, 'friend']);
  assert.throws(() => db.run("UPDATE personal_ops_events SET kind = 'x' WHERE id = ?", [rows[0].id]), /append-only/);
  const lines = tl.fromPersonalOps(rows).map((e) => e.headline);
  for (const want of ['You classified Liam: friend', 'You marked Liam as personal', 'You said Liam does not live with you',
    'You said Jules and Julie Ward are different people', 'You merged Jules into Julie Ward', 'You added a People note for Helen Ward']) {
    assert.ok(lines.includes(want), `${want} — got ${JSON.stringify(lines)}`);
  }
  const det = await (await fetch(`${base}/api/people/${encodeURIComponent('person:liam')}`)).json();
  assert.ok(det.history.length >= 3, 'the person view shows its own correction history');
});

test('create: refuses a name that exists, a bad name, and an unreadable vault', async () => {
  assert.equal((await people.createPerson({ name: 'Helen Ward' }, { now: NOW })).status, 409);
  assert.equal((await people.createPerson({ name: 'a/b' }, { now: NOW })).status, 400);
  assert.equal((await people.createPerson({ name: 'Ok Name', relationshipType: 'bestie' }, { now: NOW })).status, 400);
  const saved = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'nope');
  assert.equal((await people.createPerson({ name: 'New One' }, { now: NOW })).status, 503);
  process.env.OBSIDIAN_VAULT_PATH = saved;
});

test('alias editor is line-based: a block list keeps every other alias; inline lists work; no duplicate', () => {
  const block = '---\ntype: person\naliases:\n  - Nath\n  - "N B"\nteam: TOM\n---\n\n# x\n';
  const out = people.addAlias(block, 'Nathan B');
  assert.match(out, /aliases:\n  - Nath\n  - "N B"\n  - "Nathan B"\nteam: TOM/);
  assert.equal(people.addAlias(out, 'nathan b'), out, 'same name folded — not added twice');
  assert.equal(people.removeAlias(out, 'Nathan B'), block);
  assert.match(people.addAlias('---\naliases: [A, "B"]\n---\nx', 'C'), /aliases: \[A, "B", "C"\]/);
  assert.match(people.addAlias('---\ntype: person\n---\nx', 'Z'), /type: person\naliases:\n  - "Z"\n---/);
});

test('vocabulary: bounded, legacy words map, junk is refused', () => {
  assert.equal(pm.RELATIONSHIP_TYPES.length, 15);
  assert.deepEqual(pm.normaliseRelationship('wife'), { type: 'spouse_partner', detail: null });
  assert.deepEqual(pm.normaliseRelationship('family'), { type: 'other', detail: 'family' }, 'family states no closeness');
  assert.equal(pm.normaliseRelationship('bestie'), null);
  assert.equal(pm.groupOf({ relationship: { type: 'other', detail: 'family' }, sphere: { value: 'personal' }, household: { value: null } }), 'family');
  assert.equal(pm.validateClassification({ relationshipType: 'friend', sphere: null }).ok, true);
  assert.equal(pm.validateClassification({ relationshipDetail: 'x\ny' }).ok, false);
});

test('Life → People renders the real read: household, who-is-this, work folded, sources — no score, no frequency, no timeline', async () => {
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'canonical', 'PeopleCard.jsx')],
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
  assert.equal(typeof m.exports.PeopleView, 'function', 'positive control: the view is exported');
  ROSTER = ROSTER.map((m2) => (m2.name === 'Daniel' ? { ...m2, state: 'home' } : m2));
  const data = people.read({ now: NOW });
  ROSTER = ROSTER.map((m2) => (m2.name === 'Daniel' ? { ...m2, state: 'away' } : m2));
  const html = renderToString(React.createElement(m.exports.PeopleView, { data, act: async () => true }));
  assert.match(html, /data-testid="people-card"/);
  assert.match(html, /Household/);
  assert.match(html, /<strong>Helen Ward<\/strong>/);
  assert.match(html, /home now/);
  assert.match(html, /<strong>Daniel<\/strong>/, 'a visitor who is here now is listed');
  assert.match(html, /Create People note<\/button>/, 'the roster entry can become a person');
  assert.match(html, /Who is this\?/);
  assert.match(html, /Not now<\/button>/);
  assert.match(html, /data-testid="people-classify"/, 'correction controls are mounted');
  assert.match(html, /Work/);
  assert.match(html, /Email &amp; messages/);
  assert.match(html, /not-used/);
  assert.match(html, /julies birthday/, 'a date with no person is shown as exactly that');
  // The "How this works" block SAYS NEURO never scores or nags — scan the rest.
  assert.match(html, /never scores a relationship/, 'positive control: the promise is stated');
  const body = html.replace(/<details class="cn-details cn-how">[\s\S]*?<\/details>/, '');
  assert.ok(!/<svg|<canvas|score|streak|last spoke|days since|keep in touch|closeness/i.test(body), 'no charts, scores, contact frequency or nagging');
});

test('two-weeks-off: personal sections stay useful with work folded away, and Nick is never a section', () => {
  const { r } = all();
  assert.ok(r.self && r.self.name === 'Nick Ward' && r.self.group === 'self');
  assert.ok(!r.sections.some((s) => s.people.some((p) => p.personId === 'person:nick-ward')));
  assert.deepEqual(r.sections.map((s) => s.id), ['household', 'family', 'friends', 'work', 'other', 'unknown']);
  // work context never rides on a personal card
  assert.equal(cardOf('Helen Ward').context.work, null);
  // Liam's note still says team/direct-report, but Nick made him a personal friend:
  // the work fields stay off his card.
  assert.equal(cardOf('Liam').sphere.value, 'personal');
  assert.equal(cardOf('Liam').context.work, null, 'work-only context never leaks into a personal card');
  assert.ok(cardOf('Abdi Mohamed').context.work, 'both → work context shown');
});
