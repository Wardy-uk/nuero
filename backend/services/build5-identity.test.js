'use strict';

/**
 * Identity quality (Build 5C).
 *
 *   run: node --test backend/services/build5-identity.test.js
 *
 * Addresses come from verified evidence and are written by a hand-written line
 * insert; names resolve only on what the source WROTE. "Chris to send X" in a
 * note that mentions Chris Middleton elsewhere is still an unresolved Chris:
 * context is not proof, and misattributing a commitment to the wrong Chris (one
 * of them is Nick's manager) is the expensive direction.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-id5-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'id.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
const VAULT = path.join(tmp, 'vault');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
fs.mkdirSync(path.join(VAULT, 'People'), { recursive: true });
fs.mkdirSync(path.join(VAULT, 'Meetings', '2026', '09'), { recursive: true });

const db = require('../db/database');
const bus = require('./event-bus');
const wm = require('./world-model');
const ws = require('./world-sources');
const src = require('./obligation-sources');
const wo = require('./world-obligations');
const enrich = require('../scripts/enrich-people-emails');

test.before(async () => { await db.init(); });

let clock = Date.parse('2026-10-03T09:00:00Z');
const tick = () => { clock += 60000; return clock; };
const pump = () => bus.pumpConsumer(wm.CONSUMER, { now: Date.now() });
const note = (name, fm) => fs.writeFileSync(path.join(VAULT, 'People', `${name}.md`), fm);

test.before(async () => {
  note('Nick Ward', '---\ntype: person\n---\n');
  note('Chris Middleton', '---\ntype: person\nemail: chris.middleton@nurtur.tech\n---\n');
  note('Chris Smith', '---\ntype: person\n---\n');
  // Alex Carr's real shape: LF frontmatter with an empty key before the end, a CRLF line in the body.
  note('Alex Carr', '---\ntype: person\naliases:\n  - Alex\nrole: Tech Services\nlast-contact:\n---\n## Notes\r\n\r\nSomething.\r\n');
  ws.publishPeople({ now: tick() });
  await pump();
});

test('11. a verified address enriches the Person, keeps the aliases list, and relinks meetings it attended', async () => {
  ws.publishCalendarWindow({ provider: 'graph', now: tick(), events: [{ id: 'E1', subject: 'Ops', start: '2026-10-06T10:00:00',
    end: '2026-10-06T11:00:00', attendeesOther: true, attendees: [{ name: 'Alex Carr', email: 'alexc@nurtur.tech' }] }] });
  await pump();
  assert.equal(db.get(`SELECT person_id FROM wm_meeting_participants WHERE email = 'alexc@nurtur.tech'`).person_id, null, 'positive control: unlinked before');
  const file = path.join(VAULT, 'People', 'Alex Carr.md');
  const r = enrich.insertEmail(fs.readFileSync(file, 'utf8'), 'alexc@nurtur.tech');
  assert.ok(r.text, r.refused);
  fs.writeFileSync(file, r.text);
  assert.match(r.text, /\nlast-contact:\nemail: alexc@nurtur\.tech\nemail-source: "Build 5C/, 'inserted with the FRONTMATTER\'s LF, not the body\'s CRLF');
  ws.publishPeople({ now: tick() });
  await pump();
  const p = wm.getPerson('person:alex-carr');
  assert.deepEqual(p.emails, ['alexc@nurtur.tech']);
  assert.deepEqual(p.aliases, ['Alex'], 'the aliases list survives the edit');
  assert.equal(db.get(`SELECT person_id FROM wm_meeting_participants WHERE email = 'alexc@nurtur.tech'`).person_id, 'person:alex-carr');
  assert.ok(db.get(`SELECT * FROM wm_identity_log WHERE value = 'alexc@nurtur.tech' AND action = 'bound'`));
  // Idempotent: a second run refuses, rather than adding a second line.
  assert.equal(enrich.insertEmail(fs.readFileSync(file, 'utf8'), 'alexc@nurtur.tech').refused, 'already declares an address');
});

test('12. ambiguous addresses are not applied: the verified list excludes them, and a contested address binds to nobody', async () => {
  const listed = enrich.VERIFIED.map(([n]) => n);
  for (const name of ['Lucy Read', 'Steve Ryan', 'Nick Ward', 'Chris Smith', 'Nathan Button']) assert.ok(!listed.includes(name), name);
  assert.equal(enrich.VERIFIED.length, 11);
  assert.ok(enrich.VERIFIED.every(([, e]) => /@nurtur\.tech$/.test(e)));
  // Two notes claiming one address (Build 3's rule, still holding): neither gets it.
  note('Lucy Read', '---\ntype: person\nemail: tpj.maintenance@nurtur.tech\n---\n');
  note('Kieran Eccles', '---\ntype: person\nemail: tpj.maintenance@nurtur.tech\n---\n');
  ws.publishPeople({ now: tick() });
  await pump();
  assert.equal(wm.personByEmail('tpj.maintenance@nurtur.tech'), null);
  assert.equal(wm.identityConflicts().find((c) => c.email === 'tpj.maintenance@nurtur.tech').claimants.length, 2);
});

const NOTE = 'Meetings/2026/09/2026-09-29 – Ops review.md';
async function extractFrom(lines) {
  fs.writeFileSync(path.join(VAULT, NOTE), `---\ntype: meeting\n---\n## Actions\n${lines.join('\n')}\n\nChris Middleton opened the meeting.\n`);
  require('./action-candidates').extractMeetingActions(fs.readFileSync(path.join(VAULT, NOTE), 'utf8'), NOTE);
  src.publishWaitingOn({ now: tick() });
  await pump();
}

test('13. a full name the note WROTE is kept by extraction and resolves exactly, despite two Chrises', async () => {
  await extractFrom(['- Chris Middleton to send the call routing figures']);
  const row = db.get(`SELECT * FROM waiting_on WHERE text = 'Chris Middleton to send the call routing figures'`);
  assert.equal(row.person, 'Chris');
  assert.equal(row.person_full, 'Chris Middleton', 'extraction keeps the fullest name the source wrote');
  const c = wo.listCommitments({ status: 'open', direction: 'to-nick' }).find((x) => x.description === row.text);
  assert.equal(c.promisor.personId, 'person:chris-middleton');
  assert.equal(c.promisor.method, 'exact-name');
});

test('14. "Chris to …" stays UNRESOLVED — even when the same note names Chris Middleton elsewhere', async () => {
  await extractFrom(['- Chris to book the retro']);
  const row = db.get(`SELECT * FROM waiting_on WHERE text = 'Chris to book the retro'`);
  assert.equal(row.person_full, null, 'nothing expanded from context');
  const c = wo.listCommitments({ status: 'open', direction: 'to-nick' }).find((x) => x.description === row.text);
  assert.equal(c.promisor.personId, null);
  assert.match(c.promisor.unresolvedWhy, /belongs to 2 declared people/);
});
