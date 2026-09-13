'use strict';

/**
 * `GET /api/1to1/cadence` answers with REAL DATES, not a polite empty shape.
 *
 * ⚠ THE BUG THIS EXISTS FOR. The first cut read `folded['last-1-2-1']` back out
 * of `foldDetected`, which answers in its OWN vocabulary — `{lastHeld, nextDue,
 * booked}`. All three came back undefined, so every report rendered "ok" with no
 * date: a team that looks perfectly up to date. Nothing threw, nothing logged,
 * and a test asserting only `Array.isArray(people)` would have passed on it —
 * which is this repo's oldest lesson (VESTA's tasks path, the `upsertCalendarEvent`
 * camelCase trap): PAIR EVERY NEGATIVE ASSERTION WITH A POSITIVE ONE.
 *
 * It also never passed `cadence`, which `foldDetected` needs to recompute the
 * due date, so every date would have come off the default rhythm rather than the
 * person's own.
 *
 * Stubs the two services, because the real ones read the vault: the point here
 * is the WIRING between them and the route, which is exactly where it broke.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const detect = require('../services/one-to-one-detect');
const roster = require('../services/team-roster');

let server;
let base;
const original = {};

test.before(async () => {
  original.directReports = roster.directReports;
  original.effectiveCadenceFields = detect.effectiveCadenceFields;

  roster.directReports = () => ([
    { name: 'Hope Goodall', role: 'Analyst', team: '1st Line', cadence: 'monthly',
      last121: '', next121Due: '', booked121: '', status: '' },
    { name: 'Adele Norman-Swift', role: 'Analyst', team: '1st Line', cadence: 'n/a',
      last121: '', next121Due: '', booked121: '', status: 'Maternity leave' },
  ]);

  // The detected note, folded in at read time — and the fold is asserted to
  // receive the CADENCE, without which it cannot date the next one.
  detect.effectiveCadenceFields = (name, fm) => {
    assert.ok(Object.prototype.hasOwnProperty.call(fm, 'cadence'),
      'the fold must be given the cadence or it dates everyone off the default');
    if (name !== 'Hope Goodall') return { lastHeld: null, nextDue: null, booked: null };
    return { lastHeld: '2026-08-20', nextDue: '2026-09-20', booked: null };
  };

  const app = express();
  app.use(express.json());
  app.use('/api/1to1', require('./one-to-one'));
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  roster.directReports = original.directReports;
  detect.effectiveCadenceFields = original.effectiveCadenceFields;
  if (server) server.close();
});

const get = (url) => fetch(`${base}${url}`).then(async r => ({ status: r.status, json: await r.json() }));

test('the folded date REACHES the payload — the positive half', async () => {
  const res = await get('/api/1to1/cadence');
  assert.equal(res.status, 200);
  const hope = res.json.people.find(p => p.name === 'Hope Goodall');

  // ⚠ The assertion the original bug would have failed. `Array.isArray` would
  // not have: an all-null answer is a perfectly well-formed list.
  assert.equal(hope.lastHeld, '2026-08-20', 'the fold answers {lastHeld}, not the frontmatter key');
  assert.equal(hope.nextDue, '2026-09-20');
  assert.ok(hope.label && hope.label !== '—', 'a person with a real date must carry real words');
});

test('NO CADENCE IS NOT "ok" — it is a different fact', async () => {
  const res = await get('/api/1to1/cadence');
  const adele = res.json.people.find(p => p.name === 'Adele Norman-Swift');

  // `cadenceState` short-circuits a non-bookable person to 'ok', which is right
  // for "is a booking owed" and wrong here: nobody has said how often she should
  // be seen, and reporting that as up-to-date is the quiet kind of wrong.
  assert.equal(adele.bookable, false);
  assert.equal(adele.state, 'no-cadence');
  assert.equal(adele.label, null, 'no cadence means no state wording to render');
  assert.match(adele.why, /Maternity/, 'the reason is carried rather than invented');
});

test('the wording comes from ONE definition, not a second phrasing', () => {
  // One definition, so the vault table, this route and the iOS screen cannot
  // describe one state three ways.
  assert.equal(detect.cadenceLabel({ state: 'overdue', daysOverdue: 12 }), '⚠️ Overdue by 12d');
  assert.equal(detect.cadenceRank({ state: 'overdue' }), 0);
  assert.ok(detect.cadenceRank({ state: 'ok' }) > detect.cadenceRank({ state: 'unwritten' }));
});
