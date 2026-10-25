'use strict';

/**
 * The family wall additions (25 Oct 2026), over real HTTP: the new wall blocks
 * (outlook, care, tea, notes, countdowns, walk, shopping), their writes, and the
 * Home sheet against a fake Home Assistant on a local port.
 *
 * What these hold: a block the account has no scope for is ABSENT (paired with
 * an account that has it, where it is present); every refusal answers 400/403/
 * 404 and writes nothing; reads write nothing (an expired note and yesterday's
 * bought item are still in the store after a wall read); the Home sheet can
 * only touch the room map, says exactly which Hive service it called, and says
 * `verified: false` when the device does not confirm.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-wall-board-'));
process.env.NEURO_DB_PATH = path.join(root, 'b.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });
process.env.NEURO_API_TOKEN = process.env.NEURO_API_TOKEN || 'test-token-for-signing';
process.env.HOME_CONTROL_READBACK_MS = '300';
process.env.HOME_CONTROL_POLL_MS = '40';
process.env.WEATHER_LAT = '52.7';
process.env.WEATHER_LON = '-1.3';
process.env.WU_IMPORT_STATIONS = 'IXTEST1';

// ── A fake Home Assistant ───────────────────────────────────────────────────
const ha = {
  reflect: true, calls: [],
  states: new Map(),
  set(id, state, attributes = {}) { this.states.set(id, { entity_id: id, state, attributes }); },
};
function resetHouse() {
  ha.states.clear(); ha.calls = []; ha.reflect = true;
  ha.set('light.hall', 'off', { friendly_name: 'Hall light' });
  ha.set('light.landing', 'on', { friendly_name: 'Landing' });
  ha.set('light.kitchen_1', 'unavailable', { friendly_name: 'Kitchen 1' });
  ha.set('light.anwio_smart_light_3', 'on', { friendly_name: 'Anwio smart light 3' });
  ha.set('switch.bedroom_socket_1', 'off', { friendly_name: 'Bedroom TV' });
  ha.set('switch.office_socket', 'on', { friendly_name: 'Office socket' });
  ha.set('switch.ipad_socket', 'on', { friendly_name: 'iPad' });
  ha.set('lock.front_door', 'locked', {});
  ha.set('climate.living_room_rad', 'heat', { current_temperature: 18.5, temperature: 19, preset_mode: 'none', friendly_name: 'Living room rad' });
  ha.set('sensor.living_room_rad_current_temperature', '65.3', { unit_of_measurement: '°F' });
  ha.set('climate.thermostat_1', 'heat', { current_temperature: 20, temperature: 20 });
}
resetHouse();
const haServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && req.url === '/api/states') return send(200, [...ha.states.values()]);
    const one = /^\/api\/states\/(.+)$/.exec(req.url);
    if (req.method === 'GET' && one) { const s = ha.states.get(decodeURIComponent(one[1])); return s ? send(200, s) : send(404, { message: 'not found' }); }
    const svc = /^\/api\/services\/([a-z_]+)\/([a-z_]+)/.exec(req.url);
    if (req.method === 'POST' && svc) {
      const data = body ? JSON.parse(body) : {};
      ha.calls.push({ domain: svc[1], service: svc[2], data });
      if (ha.reflect) {
        const ids = [].concat(data.entity_id || []);
        for (const id of ids) {
          const s = ha.states.get(id); if (!s) continue;
          if (svc[2] === 'turn_on') s.state = 'on';
          if (svc[2] === 'turn_off') s.state = 'off';
          if (svc[2] === 'boost_heating_on') s.attributes = { ...s.attributes, preset_mode: 'boost' };
          if (svc[2] === 'boost_heating_off') s.attributes = { ...s.attributes, preset_mode: 'none' };
        }
      }
      return send(200, []);
    }
    return send(404, { message: 'not found' });
  });
});

let base; let server;
test.before(async () => {
  await new Promise((r) => haServer.listen(0, '127.0.0.1', r));
  process.env.HA_URL = `http://127.0.0.1:${haServer.address().port}`;
  process.env.HA_TOKEN = 'fake-ha-token';
  await require('../db/database').init();
  const express = require('express');
  const app = express(); app.use(express.json()); app.use('/api/v', require('./vesta'));
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}/api/v`;
});
test.after(() => { try { server.close(); } catch { /* */ } try { haServer.close(); } catch { /* */ } });

const pad = (n) => String(n).padStart(2, '0');
const keyOffset = (n) => { const t = new Date(); t.setDate(t.getDate() + n); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; };

async function call(p, { token, body, method } = {}) {
  const r = await fetch(base + p, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

let ALL; let MIN; let HOUSE;
test('0. accounts', async () => {
  const capture = require('../services/capture-links');
  capture.create({ label: 'Family', username: 'fam', pin: '246813', scopes: ['tasks', 'calendar', 'kitchen', 'house', 'hike', 'home-control'] });
  capture.create({ label: 'Min', username: 'min', pin: '246813', scopes: ['tasks'] });
  capture.create({ label: 'Houseonly', username: 'hs', pin: '246813', scopes: ['tasks', 'house'] });
  ALL = (await call('/login', { body: { username: 'fam', pin: '246813' } })).json.token;
  MIN = (await call('/login', { body: { username: 'min', pin: '246813' } })).json.token;
  HOUSE = (await call('/login', { body: { username: 'hs', pin: '246813' } })).json.token;
  assert.ok(ALL && MIN && HOUSE);
  assert.ok(capture.SCOPES.includes('home-control'), 'the new scope exists');
  assert.ok(!capture.DEFAULT_SCOPES.includes('home-control'), 'and is not a default');
});

test('1. scope gate: each block is ABSENT without its scope and present with it', async () => {
  const min = (await call('/wall', { token: MIN })).json;
  for (const k of ['outlook', 'care', 'countdowns', 'walk', 'shopping']) assert.ok(!(k in min), `${k} absent without its scope`);
  assert.ok('tea' in min && 'notes' in min, 'tasks-scoped blocks are present (tasks is what an account is)');
  const all = (await call('/wall', { token: ALL })).json;
  for (const k of ['outlook', 'care', 'tea', 'notes', 'countdowns', 'walk', 'shopping']) assert.ok(k in all, `${k} present with its scope`);
  assert.deepEqual(all.shopping, { exists: false, toBuy: [], bought: [] }, 'no list yet is said, not an error');
  assert.deepEqual(all.tea, { today: null, days: [], recent: [] });
  assert.deepEqual(all.notes, []);
  // The write routes refuse without the scope, before anything is written.
  assert.equal((await call('/countdowns', { token: MIN, body: { key: 'x@2099-01-01', title: 'X', date: '2099-01-01', on: true } })).status, 403);
  assert.equal((await call('/shopping/add', { token: MIN, body: { name: 'Milk' } })).status, 403);
  assert.equal((await call('/home-control', { token: MIN })).status, 403);
  assert.equal((await call('/home-control', { token: HOUSE })).status, 403, '`house` never brings home-control');
  assert.equal((await call('/home-control', { token: HOUSE, body: { entity: 'light.hall', action: 'on' } })).status, 403);
  assert.equal(ha.calls.length, 0, 'nothing reached the house');
  assert.equal((await call('/tea', { body: { date: keyOffset(0), text: 'x' } })).status, 401, 'no session, no write');
});

test('2. tea: today..+6, ≤80 chars refused not cut, omitted text refused, null clears, recent newest first', async () => {
  const t0 = keyOffset(0);
  assert.equal((await call('/tea', { token: ALL, body: { date: keyOffset(7), text: 'Pie' } })).status, 400);
  assert.equal((await call('/tea', { token: ALL, body: { date: keyOffset(-1), text: 'Pie' } })).status, 400);
  assert.equal((await call('/tea', { token: ALL, body: { date: 'tonight', text: 'Pie' } })).status, 400);
  assert.equal((await call('/tea', { token: ALL, body: { date: t0, text: 'x'.repeat(81) } })).status, 400);
  assert.equal((await call('/tea', { token: ALL, body: { date: t0 } })).status, 400, 'omitted text is not a clear');
  const db = require('../db/database');
  assert.equal(db.getState('household_tea'), null, 'refusals wrote nothing');
  let r = await call('/tea', { token: ALL, body: { date: t0, text: '  Fish pie  ' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.tea.today, 'Fish pie');
  await call('/tea', { token: ALL, body: { date: keyOffset(2), text: 'Curry' } });
  r = await call('/tea', { token: ALL, body: { date: keyOffset(6), text: 'fish PIE' } });
  assert.deepEqual(r.json.tea.days.map((d) => d.date), [t0, keyOffset(2), keyOffset(6)]);
  assert.deepEqual(r.json.tea.recent, ['fish PIE', 'Curry'], 'distinct (case-insensitive), newest first');
  r = await call('/tea', { token: ALL, body: { date: keyOffset(2), text: null } });
  assert.deepEqual(r.json.tea.days.map((d) => d.date), [t0, keyOffset(6)], 'null clears');
  const wall = (await call('/wall', { token: ALL })).json;
  assert.equal(wall.tea.today, 'Fish pie');
  assert.deepEqual(wall.tea, r.json.tea, 'the route answers the wall’s own shape');
});

test('3. notes: ≤140, empty refused, newest first, clear by id (404 unknown), expiry filtered at READ', async () => {
  assert.equal((await call('/notes', { token: ALL, body: { text: '   ' } })).status, 400);
  assert.equal((await call('/notes', { token: ALL, body: { text: 'y'.repeat(141) } })).status, 400);
  assert.equal((await call('/notes', { token: ALL, body: {} })).status, 400);
  const a = await call('/notes', { token: ALL, body: { text: 'Bins tonight' } });
  assert.equal(a.status, 200);
  assert.equal(a.json.notes[0].by, 'Family', 'who left it = the account label');
  const b = await call('/notes', { token: MIN, body: { text: 'Back at 6' } });
  assert.deepEqual(b.json.notes.map((n) => n.text), ['Back at 6', 'Bins tonight']);
  // An expired note, put straight into the store.
  const db = require('../db/database');
  const stored = JSON.parse(db.getState('household_notes'));
  stored.push({ id: 'old123', text: 'Stale', by: 'Min', at: new Date(Date.now() - 3 * 86400000).toISOString() });
  db.setState('household_notes', JSON.stringify(stored));
  const wall = (await call('/wall', { token: ALL })).json;
  assert.deepEqual(wall.notes.map((n) => n.text), ['Back at 6', 'Bins tonight'], 'expired note not shown');
  assert.ok(JSON.parse(db.getState('household_notes')).some((n) => n.id === 'old123'), 'the read wrote nothing');
  assert.equal((await call('/notes/old123/clear', { token: ALL, body: {} })).status, 404, 'an expired note is gone');
  assert.equal((await call('/notes/nope/clear', { token: ALL, body: {} })).status, 404);
  const c = await call(`/notes/${a.json.note.id}/clear`, { token: ALL, body: {} });
  assert.equal(c.status, 200);
  assert.deepEqual(c.json.notes.map((n) => n.text), ['Back at 6']);
});

test('4. countdowns: week events carry a stable key; marking shows the nearest two; refusals', async () => {
  const db = require('../db/database');
  db.upsertCalendarEvent({ id: 'cd-1', subject: 'Isaac birthday party', start: `${keyOffset(3)}T14:00:00`, end: `${keyOffset(3)}T16:00:00`, showAs: 'busy', source: 'apple' });
  db.upsertCalendarEvent({ id: 'cd-2', subject: 'Half term', start: `${keyOffset(1)}T00:00:00`, end: `${keyOffset(4)}T00:00:00`, isAllDay: true, source: 'apple' });
  let wall = (await call('/wall', { token: ALL })).json;
  const all = wall.week.flatMap((d) => d.events);
  const party = all.find((e) => e.title === 'Isaac birthday party');
  assert.equal(party.countdownKey, `cd-1@${keyOffset(3)}`);
  assert.equal(party.countdown, false);
  const ht = all.filter((e) => e.title === 'Half term');
  assert.ok(ht.length >= 2 && ht.every((e) => e.countdownKey === `cd-2@${keyOffset(1)}`), 'one key on every day a multi-day event shows');

  assert.equal((await call('/countdowns', { token: ALL, body: { key: party.countdownKey, title: 'Party', date: keyOffset(3), on: 'yes' } })).status, 400);
  assert.equal((await call('/countdowns', { token: ALL, body: { key: party.countdownKey, title: '', date: keyOffset(3), on: true } })).status, 400);
  assert.equal((await call('/countdowns', { token: ALL, body: { key: party.countdownKey, title: 'Party', date: keyOffset(-1), on: true } })).status, 400);
  assert.equal((await call('/countdowns', { token: ALL, body: { title: 'Party', date: keyOffset(3), on: true } })).status, 400);

  await call('/countdowns', { token: ALL, body: { key: 'far@x', title: 'Holiday', date: keyOffset(40), on: true } });
  await call('/countdowns', { token: ALL, body: { key: `cd-2@${keyOffset(1)}`, title: 'Half term', date: keyOffset(1), on: true } });
  const r = await call('/countdowns', { token: ALL, body: { key: party.countdownKey, title: 'Isaac birthday party', date: keyOffset(3), on: true } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.countdowns.map((c) => [c.title, c.days, c.say]), [['Half term', 1, 'tomorrow'], ['Isaac birthday party', 3, 'in 3 days']], 'nearest two');
  wall = (await call('/wall', { token: ALL })).json;
  assert.deepEqual(wall.countdowns, r.json.countdowns);
  assert.equal(wall.week.flatMap((d) => d.events).find((e) => e.title === 'Isaac birthday party').countdown, true);
  const off = await call('/countdowns', { token: ALL, body: { key: party.countdownKey, on: false } });
  assert.deepEqual(off.json.countdowns.map((c) => c.title), ['Half term', 'Holiday']);
});

test('5. shopping: created shared, already, bought/undo moves, yesterday’s bought hidden at read and pruned on write', async () => {
  const catalogue = require('../services/catalogue');
  assert.equal((await call('/shopping/add', { token: ALL, body: { name: '' } })).status, 400);
  assert.equal((await call('/shopping/add', { token: ALL, body: { name: 'z'.repeat(121) } })).status, 400);
  assert.equal(catalogue.read('shopping').notFound, true, 'refusals created nothing');
  let r = await call('/shopping/add', { token: ALL, body: { name: 'Milk' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.already, false);
  assert.equal(catalogue.read('shopping').cat.shared, true, 'created SHARED');
  r = await call('/shopping/add', { token: ALL, body: { name: 'milk' } });
  assert.equal(r.json.already, true);
  await call('/shopping/add', { token: ALL, body: { name: 'Bread' } });
  r = await call('/shopping/bought', { token: ALL, body: { name: 'Milk', undo: false } });
  assert.deepEqual(r.json.shopping.toBuy.map((i) => i.name), ['Bread']);
  assert.deepEqual(r.json.shopping.bought, [{ name: 'Milk' }]);
  assert.equal((await call('/shopping/bought', { token: ALL, body: { name: 'Eggs' } })).status, 404);
  assert.equal((await call('/shopping/bought', { token: ALL, body: { name: 'Bread', undo: 'no' } })).status, 400);
  r = await call('/shopping/bought', { token: ALL, body: { name: 'Milk', undo: true } });
  assert.deepEqual(r.json.shopping.toBuy.map((i) => i.name).sort(), ['Bread', 'Milk']);
  assert.deepEqual(r.json.shopping.bought, []);

  // Something bought YESTERDAY, written into the file directly.
  const cat = catalogue.read('shopping').cat;
  cat.items.bought.push({ name: 'Old cheese', added: keyOffset(-1) });
  catalogue.write('shopping', cat);
  const wall = (await call('/wall', { token: ALL })).json;
  assert.ok(!wall.shopping.bought.some((i) => i.name === 'Old cheese'), 'yesterday’s bought is not shown');
  assert.ok(catalogue.read('shopping').cat.items.bought.some((i) => i.name === 'Old cheese'), 'the read wrote nothing');
  await call('/shopping/bought', { token: ALL, body: { name: 'Bread' } });
  const after = catalogue.read('shopping').cat.items.bought.map((i) => i.name);
  assert.deepEqual(after, ['Bread'], 'pruned on the next write');
});

test('6. a private "shopping" catalogue is not taken over', async () => {
  const catalogue = require('../services/catalogue');
  const cat = catalogue.read('shopping').cat;
  catalogue.write('shopping', { ...cat, shared: false });
  const wall = (await call('/wall', { token: ALL })).json;
  assert.equal(wall.shopping, null);
  assert.ok(wall.gaps.some((g) => g.block === 'shopping'), 'a named gap, not an empty list');
  assert.equal((await call('/shopping/add', { token: ALL, body: { name: 'Jam' } })).status, 409);
  catalogue.write('shopping', { ...cat, shared: true });
});

test('7. home-control read: the room map only, friendly names, climate °C, unavailable kept, lightsOn', async () => {
  resetHouse();
  const r = (await call('/home-control', { token: ALL })).json;
  assert.equal(r.ok, true); assert.equal(r.known, true); assert.equal(r.why, null);
  const json = JSON.stringify(r);
  for (const banned of ['switch.office_socket', 'switch.ipad_socket', 'lock.front_door', 'climate.thermostat_1', 'sensor.']) {
    assert.ok(!json.includes(banned), `${banned} is not in the answer`);
  }
  const living = r.rooms.find((x) => x.id === 'living-room');
  assert.equal(living.tempC, 18.5, 'climate current_temperature in °C, never the °F sensor');
  assert.equal(living.climate, 'climate.living_room_rad');
  assert.deepEqual(living.boost, { on: false, untilHHMM: null });
  assert.equal(living.lights[0].name, 'Living room 1', 'Nick’s name beats an unhelpful friendly_name');
  const hall = r.rooms.find((x) => x.id === 'hall-landing');
  assert.deepEqual(hall.lights.map((l) => [l.name, l.state]), [['Hall light', 'off'], ['Landing', 'on']]);
  assert.equal(r.rooms.find((x) => x.id === 'kitchen').lights[0].state, 'unavailable');
  assert.equal(r.lightsOn, 2);
  assert.ok(!r.rooms.some((x) => x.id === 'pantry'), 'a room HA has nothing for is left out');
  assert.equal(ha.calls.length, 0, 'a read calls no service');
});

test('8. home-control writes: allowlist 403 before HA, light on verified, boost payloads, mismatch unverified, refusals', async () => {
  resetHouse();
  for (const entity of ['switch.office_socket', 'switch.ipad_socket', 'lock.front_door', 'climate.thermostat_1', 'light.hall ', 'LIGHT.HALL']) {
    const r = await call('/home-control', { token: ALL, body: { entity, action: 'on' } });
    assert.equal(r.status, 403, entity);
  }
  assert.equal(ha.calls.length, 0, 'nothing outside the map reached the house');
  assert.equal((await call('/home-control', { token: ALL, body: { entity: 'light.hall', action: 'dim' } })).status, 400);
  assert.equal((await call('/home-control', { token: ALL, body: { entity: 'light.hall', action: 'boost' } })).status, 400);
  assert.equal((await call('/home-control', { token: ALL, body: { entity: 'climate.living_room_rad', action: 'on' } })).status, 400);
  assert.equal((await call('/home-control', { token: ALL, body: { entity: 'light.hall', action: 'all-lights-off' } })).status, 400);
  assert.equal(ha.calls.length, 0);

  let r = await call('/home-control', { token: ALL, body: { entity: 'light.hall', action: 'on' } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.ok, r.json.verified, r.json.state], [true, true, 'on']);
  assert.match(r.json.say, /Hall light is on/);
  assert.deepEqual(ha.calls.pop(), { domain: 'light', service: 'turn_on', data: { entity_id: 'light.hall' } });

  r = await call('/home-control', { token: ALL, body: { entity: 'switch.bedroom_socket_1', action: 'on' } });
  assert.deepEqual(ha.calls.pop(), { domain: 'switch', service: 'turn_on', data: { entity_id: 'switch.bedroom_socket_1' } });
  assert.equal(r.json.verified, true);

  r = await call('/home-control', { token: ALL, body: { entity: 'climate.living_room_rad', action: 'boost' } });
  assert.deepEqual(ha.calls.pop(), { domain: 'hive', service: 'boost_heating_on', data: { entity_id: 'climate.living_room_rad', time_period: '01:00:00', temperature: 21 } });
  assert.deepEqual([r.json.ok, r.json.verified, r.json.state], [true, true, 'boost']);
  const read = (await call('/home-control', { token: ALL })).json;
  const living = read.rooms.find((x) => x.id === 'living-room');
  assert.equal(living.boost.on, true);
  assert.match(living.boost.untilHHMM, /^\d{2}:\d{2}$/, 'the end time NEURO recorded');

  r = await call('/home-control', { token: ALL, body: { entity: 'climate.living_room_rad', action: 'boost-off' } });
  assert.deepEqual(ha.calls.pop(), { domain: 'hive', service: 'boost_heating_off', data: { entity_id: 'climate.living_room_rad' } });
  assert.equal(r.json.verified, true);

  // The device takes the call but never changes: not verified, said so.
  ha.reflect = false;
  r = await call('/home-control', { token: ALL, body: { entity: 'light.hall', action: 'off' } });
  assert.deepEqual([r.json.ok, r.json.verified, r.json.state], [true, false, 'on']);
  assert.match(r.json.say, /hasn't confirmed/);
  ha.reflect = true;

  // Off at the wall: refused with ok:false, no service call.
  const before = ha.calls.length;
  r = await call('/home-control', { token: ALL, body: { entity: 'light.kitchen_1', action: 'on' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.match(r.json.say, /off at the wall/);
  assert.equal(ha.calls.length, before);

  // All lights off: only mapped lights that are on, one call.
  resetHouse();
  r = await call('/home-control', { token: ALL, body: { action: 'all-lights-off' } });
  assert.deepEqual([r.json.ok, r.json.verified, r.json.count], [true, true, 2]);
  assert.deepEqual(ha.calls, [{ domain: 'light', service: 'turn_off', data: { entity_id: ['light.landing', 'light.anwio_smart_light_3'] } }]);

  // Each press is recorded, readable in Activity.
  const db = require('../db/database');
  const rows = db.all("SELECT * FROM personal_ops_events WHERE kind = 'wall-home-control'");
  assert.ok(rows.length >= 6);
  const tl = require('../services/activity-timeline');
  assert.ok(typeof tl === 'object');
});

test('9. care: open items due within 7 days or overdue, any companion, overdue first; nothing further out', async () => {
  const db = require('../db/database');
  const now = new Date().toISOString();
  db.run(`INSERT INTO wm_companions (companion_id, name, provenance_kind, observed_at, evidence_json, updated_at) VALUES (?, ?, 'declared', ?, '[]', ?)`, ['companion:ember', 'Ember', now, now]);
  const add = (id, kind, title, due, status = 'open') => db.run(
    `INSERT INTO companion_care_items (care_id, companion_id, kind, title, due_date, status, created_at, updated_at) VALUES (?, 'companion:ember', ?, ?, ?, ?, ?, ?)`,
    [id, kind, title, due, status, now, now]);
  add('c1', 'flea', 'Flea treatment', keyOffset(2));
  add('c2', 'worm', 'Worming', keyOffset(-3));
  add('c3', 'vet', 'Vet booster', keyOffset(20));
  add('c4', 'flea', 'Done flea', keyOffset(1), 'done');
  const wall = (await call('/wall', { token: ALL })).json;
  assert.deepEqual(wall.care.map((c) => c.id), ['c2', 'c1']);
  assert.equal(wall.care[0].say, 'Worming 3 days overdue');
  assert.equal(wall.care[0].overdue, true);
  assert.equal(wall.care[0].companion, 'Ember');
  assert.match(wall.care[1].say, /^Flea treatment due (Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
  assert.equal((await call('/wall', { token: MIN })).json.care, undefined, 'absent without `house`');
});

test('10. outlook from the standing forecast: highs/lows today and tomorrow, rain chance, never "will"', async () => {
  const wf = require('../services/weather-forecast');
  const ws = require('../services/weather-station');
  const nowMs = Date.now();
  const d0 = ws.londonDayStart(nowMs);
  const d1 = ws.londonDayStart(d0 + 36 * 3600e3);
  const pts = [];
  for (let h = 0; h < 48; h++) {
    const t = d0 + h * 3600e3;
    pts.push({ validAt: t, temperatureC: t < d1 ? 10 + (h % 7) : 5 + (h % 5), humidityPct: 80, pressureHpa: 1000, precipMm: 0, precipProb: t < d1 ? 10 : (h === 30 ? 70 : 20) });
  }
  wf.storeSnapshot(wf.providerName(), d0 - 3600e3, pts);
  const o = (await call('/wall', { token: ALL })).json.outlook;
  assert.equal(o.known, true);
  assert.equal(o.today.highC, 16); assert.equal(o.today.lowC, 10);
  assert.equal(o.tomorrow.highC, 9); assert.equal(o.tomorrow.lowC, 5);
  assert.equal(o.tomorrow.rainChance, 70);
  assert.equal(o.today.rainChance, 10);
  assert.ok(['dry', 'raining', 'arriving', 'unknown'].includes(o.rain.state));
  assert.ok(!/\bwill\b/i.test(o.rain.say));
});
