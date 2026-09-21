'use strict';

/**
 * An app arriving is an arrival, and it cools down on its own clock.
 *
 * ⚠⚠ WHY THIS EXISTS. `briefLine` has ranked what earns an interruption at the
 * door since 13 Sep 2026 — meeting about to start > something breaching > this
 * room is cold > rain coming > how he slept > the top task — and the ONLY way
 * to reach it was to physically walk into a room with a speaker in it.
 * `CLAUDE.md` records the other half: "briefings and nudges are not spoken on
 * the phone yet". So the best line NEURO composes was unreachable from the
 * surface Nick actually opens.
 *
 * ⚠ THE RULE THIS PINS: a room and a client are two arrivals with two
 * cooldowns, and one must never silence the other. A man who checks his phone
 * in the kitchen would otherwise never be greeted by the kitchen again. What
 * they DO share is `recentKinds` and `lastAnyAt`, so she does not tell him
 * about the rain twice on two surfaces.
 *
 * ⚠ Real HTTP, because a green service suite says nothing about routing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-greetclient-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const db = require('../db/database');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/greeting', require('./greeting'));
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise(r => server.close(r)));

const post = async (body) => {
  const res = await fetch(base + '/api/greeting', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const ledger = () => {
  try {
    return JSON.parse(db.getState('saim_greetings') || '{}');
  } catch {
    return {};
  }
};

const clearLedger = () => db.setState('saim_greetings', JSON.stringify({}));

test('neither a room nor a client is a 400 that names both options', async () => {
  const { status, json } = await post({});
  assert.equal(status, 400);
  assert.equal(json.ok, false);
  assert.match(json.error, /room/);
  assert.match(json.error, /client/);
});

/**
 * ⚠ A caller sending both has not decided which kind of arrival it is, and
 * picking for it would silently spend the wrong cooldown.
 */
test('a room AND a client together is refused rather than resolved', async () => {
  const { status, json } = await post({ room: 'study', client: 'saim-ios' });
  assert.equal(status, 400);
  assert.match(json.error, /not both/);
});

test('a client id is shape-checked like a room id', async () => {
  const { status, json } = await post({ client: 'SAiM iOS' });
  assert.equal(status, 400);
  assert.match(json.error, /client/);
});

test('a client arrival speaks, and is echoed as a client rather than a room', async () => {
  clearLedger();
  const { status, json } = await post({ client: 'saim-ios' });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.speak, true);
  assert.equal(json.client, 'saim-ios');
  assert.equal(json.room, undefined, 'a client arrival must not claim to be a room');
  assert.ok(typeof json.text === 'string' && json.text.length > 0);
});

test('the same client again inside the cooldown is silent, and says why', async () => {
  clearLedger();
  await post({ client: 'saim-ios' });
  const { json } = await post({ client: 'saim-ios' });
  assert.equal(json.speak, false);
  assert.match(json.why, /saim-ios/, 'the reason must name the client, not a room');
});

/**
 * ⚠⚠ THE LOAD-BEARING TEST. Opening the app must not silence the kitchen, and
 * walking into the study must not silence the phone. Mutation-checked: pointing
 * `decide` at one shared map fails this.
 */
test('a room and a client do not share a cooldown', async () => {
  clearLedger();

  const phone = await post({ client: 'saim-ios' });
  assert.equal(phone.speak ?? phone.json.speak, true);

  const room = await post({ room: 'study' });
  assert.equal(room.json.speak, true, 'the study must still greet him after the phone did');

  const phoneAgain = await post({ client: 'saim-ios' });
  assert.equal(phoneAgain.json.speak, false, 'the phone keeps its own cooldown');

  const roomAgain = await post({ room: 'study' });
  assert.equal(roomAgain.json.speak, false, 'the study keeps its own');
});

/**
 * ⚠ `rooms` is read by the arrival detector and keyed on sensor room ids.
 * Putting a client in there would make the phone look like somewhere in the
 * house to every future reader of this ledger.
 */
test('the ledger keeps rooms and clients in separate maps', async () => {
  clearLedger();
  await post({ client: 'saim-ios' });
  await post({ room: 'study' });

  const led = ledger();
  assert.ok(led.clients && led.clients['saim-ios'], 'the client is recorded under clients');
  assert.ok(led.rooms && led.rooms.study, 'the room is recorded under rooms');
  assert.equal(led.rooms['saim-ios'], undefined, 'a client must never appear as a room');
  assert.equal(led.clients.study, undefined, 'a room must never appear as a client');
});

/**
 * ⚠ The variety memory is SHARED on purpose — that is the whole reason the two
 * arrivals live in one ledger rather than two. `lastAnyAt` is what makes the
 * once-a-day sleep line once a day across every surface.
 */
test('the shared variety memory survives a client arrival', async () => {
  clearLedger();
  await post({ room: 'study' });
  const afterRoom = ledger();
  assert.ok(afterRoom.lastAnyAt, 'a room arrival stamps the shared clock');
  assert.ok(Array.isArray(afterRoom.recentOpeners) && afterRoom.recentOpeners.length > 0);

  await post({ client: 'saim-ios' });
  const afterClient = ledger();
  assert.ok(afterClient.lastAnyAt, 'a client arrival keeps the shared clock');
  assert.ok(
    afterClient.recentOpeners.length >= afterRoom.recentOpeners.length,
    'the opener memory is carried, not reset, when the other kind of arrival lands'
  );
  assert.ok(afterClient.rooms.study, 'and the room it already knew about survives');
});
