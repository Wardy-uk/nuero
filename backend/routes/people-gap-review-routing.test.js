'use strict';

/**
 * Clearing the people-gap list from the People page.
 *
 * Before this the nightly scan wrote a report, pushed "Review in Vault Audit"
 * and offered nothing to press: creating a note needed a curl against
 * `POST /apply`, and there was no way at all to say a name was not a person, so
 * "The Scrum Room" came back every night for ever.
 *
 * Real HTTP against a real temp vault and a real temp DB, because a green
 * service suite says nothing about routing — and `/ignored` is a literal path
 * on a router that also takes bodies, which is exactly the shape this codebase
 * has shipped wrong before.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-pgap-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'a.db');

const vault = path.join(tmp, 'vault');
fs.mkdirSync(path.join(vault, 'People'), { recursive: true });
process.env.OBSIDIAN_VAULT_PATH = vault;

// A real People note, in the shape the live vault holds: a block `aliases:`
// list with something already in it, so an append that dropped the rest would
// be visible.
fs.writeFileSync(path.join(vault, 'People', 'Naomi Wentworth.md'), [
  '---',
  'type: person',
  'aliases:',
  '  - Naomi',
  '  - Naomi Winkworth',
  'role: Customer Service Agent (CSA)',
  'email: naomi.wentworth@nurtur.tech',
  'direct-report: true',
  '---',
  '',
  '# Naomi Wentworth',
  '',
].join('\n'), 'utf-8');

// ⚠ REAL SIGHTINGS, seeded before anything reads the scan. Without them
// `findGaps` returns an empty list and EVERY assertion below about what it
// withholds passes by absence — which is how three of these tests first shipped
// green against a service that had had the filter removed.
const MEETING = (names) => ['---', 'type: meeting', '---', '', '# Standup', '',
  '## Mentioned', ...names.map(n => `- ${n}`), ''].join('\n');
fs.mkdirSync(path.join(vault, 'Meetings', '2026', '09'), { recursive: true });
for (const n of ['a', 'b']) {
  fs.writeFileSync(path.join(vault, 'Meetings', '2026', '09', `note-${n}.md`),
    MEETING(['Melanie Ellis', 'The Scrum Room', 'The Epic Room', 'Naomi Winkworth']), 'utf-8');
}

const db = require('../db/database');
const router = require('./people-gap');
const peopleGap = require('../services/people-gap');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/people-gap', router);
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

const get = (url) => fetch(`${base}${url}`).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const post = (url, body) => fetch(`${base}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

// ── Ignore ────────────────────────────────────────────────────────────────

test('an ignored name is stored, listed, and gone from the next scan', async () => {
  const res = await post('/api/people-gap/ignore', { name: 'The Scrum Room', reason: 'a meeting room' });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'ok');

  // ⚠ The POSITIVE half. A route that answered politely while writing nothing
  // passes every check made on its own output — VESTA's first feature shipped
  // dead behind exactly that.
  const listed = await get('/api/people-gap/ignored');
  assert.equal(listed.status, 200);
  assert.ok(listed.json.entries.some(e => e.name === 'The Scrum Room'),
    'the ignore must be readable back through its own route');

  // And through the service, which is what `findGaps` asks.
  assert.ok(peopleGap.listIgnored().entries.some(e => e.name === 'The Scrum Room'));
});

test('/ignored is a literal path, not swallowed as a parameter', async () => {
  // Express matches in registration order and this codebase has shipped a
  // literal path read as `:name` before.
  const res = await get('/api/people-gap/ignored');
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'ok');
  assert.ok(Array.isArray(res.json.entries), 'must return the vocabulary, not a person called "ignored"');
});

test('a different word order is the SAME decision', async () => {
  await post('/api/people-gap/ignore', { name: 'Ellis, Melanie' });
  const again = await post('/api/people-gap/ignore', { name: 'Melanie Ellis' });
  assert.equal(again.json.already, true, 'one decision, however the name arrives');
});

test('unignore is the way back, and removes exactly one', async () => {
  const before = peopleGap.listIgnored().entries.length;
  const res = await post('/api/people-gap/unignore', { name: 'Melanie Ellis' });
  assert.equal(res.status, 200);
  assert.equal(res.json.removed, true);
  assert.equal(peopleGap.listIgnored().entries.length, before - 1);
  assert.ok(!peopleGap.listIgnored().entries.some(e => e.name.includes('Melanie')));
});

test('unignoring something never ignored is a success, not an error', async () => {
  const res = await post('/api/people-gap/unignore', { name: 'Nobody At All' });
  assert.equal(res.status, 200);
  assert.equal(res.json.removed, false);
});

test('a missing name is a 400 on both doors', async () => {
  assert.equal((await post('/api/people-gap/ignore', {})).status, 400);
  assert.equal((await post('/api/people-gap/unignore', {})).status, 400);
});

// ── Alias ─────────────────────────────────────────────────────────────────

test('a dry run returns the exact line and writes NOTHING', async () => {
  const before = fs.readFileSync(path.join(vault, 'People', 'Naomi Wentworth.md'), 'utf-8');
  const res = await post('/api/people-gap/alias', {
    person: 'Naomi Wentworth', alias: 'Naomi Wenworth', dryRun: true,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'dry-run');
  assert.equal(res.json.line, '  - Naomi Wenworth', 'the confirm quotes this verbatim');

  // ⚠ The whole point of the confirm. A route that answered politely while
  // writing would pass any check made on its own output, so assert the FILE.
  const after = fs.readFileSync(path.join(vault, 'People', 'Naomi Wentworth.md'), 'utf-8');
  assert.equal(after, before, 'a dry run must leave the note byte-identical');
});

test('the write lands, and every other alias and key survives it', async () => {
  const res = await post('/api/people-gap/alias', { person: 'Naomi Wentworth', alias: 'Naomi Wenworth' });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'ok');

  const after = fs.readFileSync(path.join(vault, 'People', 'Naomi Wentworth.md'), 'utf-8');
  assert.match(after, /- Naomi\n/, 'the existing alias must survive — updateFrontmatter drops list values');
  assert.match(after, /- Naomi Winkworth/, 'the alias it already had must survive too');
  assert.match(after, /- Naomi Wenworth/);
  assert.match(after, /email: naomi\.wentworth@nurtur\.tech/);
  assert.match(after, /direct-report: true/);
});

test('an unknown person is refused rather than creating a note', async () => {
  const res = await post('/api/people-gap/alias', { person: 'Nobody Here', alias: 'Nob' });
  assert.equal(res.status, 400);
  assert.ok(!fs.existsSync(path.join(vault, 'People', 'Nobody Here.md')),
    'an alias route must never mint a person note');
});

test('an alias that is somebody else\'s name is REFUSED with 409, and nothing is written', async () => {
  fs.writeFileSync(path.join(vault, 'People', 'Chris Smith.md'),
    '---\ntype: person\naliases:\n  - Chris S\n---\n\n# Chris Smith\n', 'utf-8');
  const before = fs.readFileSync(path.join(vault, 'People', 'Naomi Wentworth.md'), 'utf-8');

  const res = await post('/api/people-gap/alias', { person: 'Naomi Wentworth', alias: 'Chris Smith' });
  assert.equal(res.status, 409, 'a refusal is an answer, not a fault');
  assert.equal(res.json.status, 'refused');
  assert.match(res.json.reason, /full name/);
  assert.equal(fs.readFileSync(path.join(vault, 'People', 'Naomi Wentworth.md'), 'utf-8'), before);
});

test('person and alias are both required', async () => {
  assert.equal((await post('/api/people-gap/alias', { person: 'Naomi Wentworth' })).status, 400);
  assert.equal((await post('/api/people-gap/alias', { alias: 'X' })).status, 400);
});

// ── The scan reads all of it ──────────────────────────────────────────────

test('the seeded sightings actually reach the scan (positive control)', () => {
  // ⚠ Without this, every assertion below is satisfied by an empty list.
  const scan = peopleGap.findGaps({ days: 90 });
  assert.equal(scan.status, 'ok');
  assert.ok(scan.candidates.some(c => c.name === 'Melanie Ellis'),
    'a real colleague seen twice must be offered, or the scan is reading nothing');
});

test('an alias already in the vault is not proposed as a gap', () => {
  // ⚠ THE BUG THIS EXISTS FOR. "Naomi Winkworth" has been an alias of Naomi
  // Wentworth since 16 Aug and `getRoster()` resolves it everywhere in NEURO —
  // but findGaps only ever compared against People FILENAMES, so the one place
  // that PROPOSES a person was the one place blind to the mapping saying she
  // already has a note. Seeded above as a real sighting, twice, so it would be
  // a candidate if the alias map were not consulted.
  const scan = peopleGap.findGaps({ days: 90 });
  const proposed = [...scan.candidates, ...scan.belowThreshold].map(c => c.name.toLowerCase());
  assert.ok(!proposed.includes('naomi winkworth'), 'a resolved alias is not a gap');
  assert.ok(scan.withheld.resolved.includes('Naomi Winkworth'),
    'and it is withheld as RESOLVED, said out loud, not silently absent');
});

test('a room never reaches the card, and the reason is reported', () => {
  const scan = peopleGap.findGaps({ days: 90 });
  const proposed = [...scan.candidates, ...scan.belowThreshold].map(c => c.name);
  // 'The Epic Room', not 'The Scrum Room' — another test ignores that one, and
  // an ignored name is withheld for a DIFFERENT reason, so asserting on it would
  // pass without this filter existing at all.
  assert.ok(!proposed.includes('The Epic Room'));
  assert.ok(scan.withheld.notPeople.some(n => n.name === 'The Epic Room' && n.reason),
    'withheld with a stated reason — a silent filter is one nobody can check');
});

test('an ignored name reaches the ignored bucket, not the candidates', () => {
  peopleGap.ignoreName('Melanie Ellis');
  const scan = peopleGap.findGaps({ days: 90 });
  assert.ok(!scan.candidates.some(c => c.name === 'Melanie Ellis'));
  assert.ok(scan.withheld.ignored.includes('Melanie Ellis'));
  peopleGap.unignoreName('Melanie Ellis');
  assert.ok(peopleGap.findGaps({ days: 90 }).candidates.some(c => c.name === 'Melanie Ellis'),
    'un-ignoring brings it straight back');
});

test('the scan reports what it withheld rather than silently shrinking', () => {
  const scan = peopleGap.findGaps({ days: 90 });
  assert.ok(scan.withheld, 'a card showing three of eleven with no account of the rest cannot be checked');
  assert.ok(Array.isArray(scan.withheld.ignored));
  assert.ok(Array.isArray(scan.withheld.notPeople));
  assert.equal(scan.rosterKnown, true);
  assert.equal(scan.ignoreKnown, true);
});

test('a note created seconds ago is not still suggested', () => {
  // ⚠ CAUGHT BY THIS SUITE, AND IT IS A PRODUCTION BUG, NOT TEST SETUP.
  // `getRoster` caches for five minutes, so reading the roster ALONE leaves a
  // person Nick has just created from the card sitting in the suggestions — a
  // Create button that appears to do nothing. `existingPeople()` is a live
  // readdir and is unioned in for exactly this.
  fs.writeFileSync(path.join(vault, 'People', 'Brand New Person.md'),
    ['---', 'type: person', '---', '', '# Brand New Person', ''].join('\n'), 'utf-8');
  const scan = peopleGap.findGaps({ days: 90 });
  const proposed = [...scan.candidates, ...scan.belowThreshold].map(c => c.name.toLowerCase());
  assert.ok(!proposed.includes('brand new person'));
});

test('an alias may not take the name of a person created seconds ago', () => {
  // The same window, in the direction that matters: the guard against an alias
  // naming a real colleague must not have a five-minute hole in it.
  const res = fetch(`${base}/api/people-gap/alias`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ person: 'Naomi Wentworth', alias: 'Brand New Person' }),
  });
  return res.then(async r => {
    assert.equal(r.status, 409);
    assert.match((await r.json()).reason, /full name/);
  });
});
