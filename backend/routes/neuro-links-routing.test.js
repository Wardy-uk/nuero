'use strict';

// Exact-item deep links over real HTTP, behind NEURO's real auth (15 Oct 2026).
// GET /api/links/resolve?item=<kind>:<id> must open THAT record or fail
// explicitly — invalid (400) / missing (404) / stale (410) / unreadable (503) —
// and never land on a broad page. Unauthenticated callers get 401.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-links-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'links.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
fs.mkdirSync(path.join(tmp, 'vault'), { recursive: true });

// Home Assistant's cached reading — the only non-DB input, stubbed at the module.
const HA = { states: null };
const haId = require.resolve('../services/ha');
require.cache[haId] = { id: haId, filename: haId, loaded: true, exports: { cachedStates: () => HA.states, cachedStatesAt: () => null } };

const db = require('../db/database');
const LINKS = require('../../shared/neuro-links.cjs');
const C = require('../../shared/attention-contracts.cjs');

let server; let base;
const ids = {};
const iso = (ms) => new Date(ms).toISOString();
const wall = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`;

function insertAction(actionId, { parent = null, version = 1, expiresAt = iso(Date.now() + 72 * 3600e3) } = {}) {
  db.run(`INSERT INTO prepared_actions (action_id, idempotency_key, finding_id, commitment_id, action_type, version, parent_action_id,
          target_json, reason, evidence_json, draft_json, payload_hash, authority_class, approval_required, status, created_at, expires_at, history_json, updated_at)
          VALUES (?, ?, 'f', 'c', 'chase_commitment', ?, ?, '{}', 'r', '{}', '{}', ?, 'A4', 1, 'prepared', ?, ?, '[]', ?)`,
  [actionId, `idem:${actionId}`, version, parent, `h:${actionId}`, iso(Date.now()), expiresAt, iso(Date.now())]);
}

test.before(async () => {
  await db.init();
  const ts = require('../services/task-store');
  ids.openTask = ts.createTask({ text: 'Send the Parsons breakdown', source: 'manual' }).id;
  ids.doneTask = ts.createTask({ text: 'Book the room for Thursday', source: 'manual' }).id;
  ts.updateTask(ids.doneTask, { status: 'done' });
  ids.keptTask = ts.createTask({ text: 'Consult Annabelle for insights', source: 'manual' }).id;
  ids.mergedTask = ts.createTask({ text: 'Nick will consult Annabelle', source: 'manual' }).id;
  ts.updateTask(ids.mergedTask, { status: 'dropped' });
  db.setState('task_internal_merges', JSON.stringify({ [ids.mergedTask]: { keptId: ids.keptTask } }));

  insertAction('pa_0000000000000001');
  insertAction('pa_0000000000000002');
  insertAction('pa_0000000000000003', { parent: 'pa_0000000000000002', version: 2 });
  db.run("UPDATE prepared_actions SET status = 'superseded' WHERE action_id = 'pa_0000000000000002'");
  insertAction('pa_0000000000000004');
  db.run("UPDATE prepared_actions SET status = 'rejected' WHERE action_id = 'pa_0000000000000004'");
  insertAction('pa_0000000000000005', { expiresAt: iso(Date.now() - 3600e3) });

  db.setState('email_triage', JSON.stringify([
    { id: 'AAMkWorkEmailOpen0000000001=', subject: 'Portal outage', from: 'Sandford', received: '2026-10-15T09:00:00Z', aiCategory: 'ACTION' },
    { id: 'AAMkWorkEmailGone0000000002=', subject: 'Old', from: 'X', dismissed: true, dismissReason: 'left-inbox' },
  ]));
  db.run(`INSERT INTO personal_inbox (id, mailbox, uid, uid_validity, subject, from_name, received, seen, fetched_at, triage_json)
          VALUES ('pmail:nick:7:41', 'nick', 41, '7', 'Car insurance renewal', 'Admiral', '2026-10-14T10:00:00Z', 0, ?, NULL)`, [iso(Date.now())]);

  const soon = new Date(Date.now() + 2 * 3600e3); const soonEnd = new Date(Date.now() + 3 * 3600e3);
  const past = new Date(Date.now() - 3 * 3600e3); const pastEnd = new Date(Date.now() - 2 * 3600e3);
  const cal = (id, s, e, others) => db.run('INSERT INTO calendar_cache (event_id, subject, start_time, end_time, attendees_other, source) VALUES (?, ?, ?, ?, ?, ?)', [id, `Meeting ${id.slice(-4)}`, wall(s), wall(e), others, 'graph']);
  cal('AAMkEventUpcoming0001=', soon, soonEnd, 1);
  cal('AAMkEventEnded000002=', past, pastEnd, 1);
  cal('AAMkEventSoloBlock03=', soon, soonEnd, 0);
  cal('apple:7F2A9C1E-0000-4D1B-9E7F-ABCDEF012345@google.com:2026-10-15T14:00', soon, soonEnd, 1);
  const far = new Date(Date.now() + 10 * 86400e3); const farEnd = new Date(far.getTime() + 3600e3);
  cal('AAMkEventFarAway0004=', far, farEnd, 1);

  HA.states = [
    { entity_id: 'binary_sensor.kitchen_leak', state: 'on', attributes: { device_class: 'moisture', friendly_name: 'Kitchen leak' }, last_changed: iso(Date.now()) },
    { entity_id: 'binary_sensor.bathroom_leak', state: 'off', attributes: { device_class: 'moisture', friendly_name: 'Bathroom leak' } },
    { entity_id: 'binary_sensor.loft_smoke', state: 'unavailable', attributes: { device_class: 'smoke', friendly_name: 'Loft smoke' } },
    { entity_id: 'binary_sensor.front_door', state: 'on', attributes: { device_class: 'door', friendly_name: 'Front door' } },
  ];

  const express = require('express');
  const app = express();
  app.use('/api', require('../services/api-auth'));
  app.use('/api/links', require('./links'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

function get(item, headers = { 'X-NEURO-PIN': 'pin-1234' }) {
  return new Promise((resolve, reject) => {
    const url = `${base}/api/links/resolve${item === undefined ? '' : `?item=${encodeURIComponent(item)}`}`;
    http.get(url, { headers }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch { /* */ } resolve({ status: res.statusCode, json }); }); }).on('error', reject);
  });
}
const expectStatus = (r, code, status) => {
  assert.equal(r.status, code, JSON.stringify(r.json));
  assert.equal(r.json.status, status);
  assert.equal(r.json.ok, status === 'open');
  assert.ok(!('view' in r.json), 'never a page to land on');
};

// ── Valid ─────────────────────────────────────────────────────────────────────

test('open: each kind returns exactly the record it names', async () => {
  let r = await get(`task:${ids.openTask}`); expectStatus(r, 200, 'open');
  assert.equal(r.json.record.taskId, ids.openTask); assert.equal(r.json.record.text, 'Send the Parsons breakdown');
  r = await get('action:pa_0000000000000001'); expectStatus(r, 200, 'open');
  assert.equal(r.json.record.actionId, 'pa_0000000000000001');
  r = await get('email:AAMkWorkEmailOpen0000000001='); expectStatus(r, 200, 'open');
  assert.equal(r.json.record.subject, 'Portal outage');
  assert.ok(!('body' in r.json.record) && !('preview' in r.json.record), 'a summary, never the body');
  r = await get('email:pmail:nick:7:41'); expectStatus(r, 200, 'open');
  assert.equal(r.json.record.mailbox, 'nick');
  r = await get('hazard:binary_sensor.kitchen_leak'); expectStatus(r, 200, 'open');
  assert.equal(r.json.record.state, 'on');
  r = await get('hazard:binary_sensor.loft_smoke'); expectStatus(r, 200, 'open');
  assert.equal(r.json.record.state, 'unavailable', 'an unreachable hazard sensor is itself the record');
  r = await get('meeting-prep:AAMkEventUpcoming0001='); expectStatus(r, 200, 'open');
  assert.equal(r.json.record.eventId, 'AAMkEventUpcoming0001=');
  r = await get('meeting-prep:apple:7F2A9C1E-0000-4D1B-9E7F-ABCDEF012345@google.com:2026-10-15T14:00'); expectStatus(r, 200, 'open');
  assert.match(r.json.record.eventId, /@google.com/, 'an Apple diary id (with @) is a valid, exact id');
});

// ── Missing ──────────────────────────────────────────────────────────────────

test('missing: a well-formed id with no record is 404, never a fallback', async () => {
  for (const item of ['task:999999', 'action:pa_ffffffffffffffff', 'email:AAMkNoSuchEmail000000000=', 'email:pmail:nick:7:999',
    'hazard:binary_sensor.no_such_sensor', 'hazard:binary_sensor.front_door', 'meeting-prep:AAMkNoSuchEvent00000=', 'meeting-prep:AAMkEventSoloBlock03=']) {
    expectStatus(await get(item), 404, 'missing');
  }
  assert.match((await get('hazard:binary_sensor.front_door')).json.why, /not a household hazard sensor/);
  assert.match((await get('meeting-prep:AAMkEventSoloBlock03=')).json.why, /no other people/);
  const far = await get('meeting-prep:AAMkEventFarAway0004=');
  expectStatus(far, 404, 'missing');
  assert.match(far.json.why, /coming week/, 'prep that cannot open is said, not shown as open');
});

// ── Stale ────────────────────────────────────────────────────────────────────

test('stale: the record exists but is no longer live — 410 with why, and the current record when known', async () => {
  let r = await get(`task:${ids.doneTask}`); expectStatus(r, 410, 'stale'); assert.match(r.json.why, /done/);
  r = await get(`task:${ids.mergedTask}`); expectStatus(r, 410, 'stale');
  assert.equal(r.json.current, LINKS.linkFor('task', ids.keptTask), 'a merged duplicate names the task it was merged into');
  r = await get('action:pa_0000000000000002'); expectStatus(r, 410, 'stale');
  assert.equal(r.json.current, 'neuro:?item=action%3Apa_0000000000000003', 'a superseded version names the newest');
  r = await get('action:pa_0000000000000004'); expectStatus(r, 410, 'stale'); assert.match(r.json.why, /rejected/);
  r = await get('action:pa_0000000000000005'); expectStatus(r, 410, 'stale'); assert.match(r.json.why, /expired/);
  r = await get('email:AAMkWorkEmailGone0000000002='); expectStatus(r, 410, 'stale'); assert.match(r.json.why, /left the inbox/);
  r = await get('hazard:binary_sensor.bathroom_leak'); expectStatus(r, 410, 'stale'); assert.match(r.json.why, /cleared/);
  r = await get('meeting-prep:AAMkEventEnded000002='); expectStatus(r, 410, 'stale'); assert.match(r.json.why, /ended/);
});

// ── Invalid ──────────────────────────────────────────────────────────────────

test('invalid: malformed links are 400 and name the problem', async () => {
  for (const item of [undefined, '', 'task', 'task:', 'task:abc', 'task:0', 'task:-1', 'action:pa_1', 'action:../../etc', 'hazard:sensor.kitchen',
    'hazard:binary_sensor.Kitchen', 'teleport:1', 'view:sources', `email:${'A'.repeat(600)}`, 'meeting-prep:has space in it', 'task:1 OR 1=1']) {
    const r = await get(item);
    expectStatus(r, 400, 'invalid');
    assert.ok(r.json.why, String(item));
  }
});

// ── Unauthorised ─────────────────────────────────────────────────────────────

test('unauthorised: no PIN or a wrong PIN is 401 before any record is read', async () => {
  for (const headers of [{}, { 'X-NEURO-PIN': 'wrong' }, { 'X-NEURO-API-TOKEN': 'not-the-token' }]) {
    const r = await get(`task:${ids.openTask}`, headers);
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.ok(!r.json || !r.json.record, 'nothing about the record leaks');
  }
  const machine = await get(`task:${ids.openTask}`, { 'X-NEURO-API-TOKEN': 'tok-5678' });
  assert.equal(machine.status, 200, 'a read with a valid machine token is allowed, like any GET');
});

// ── Unreadable ───────────────────────────────────────────────────────────────

test('unreadable: no Home Assistant reading or no triage store is 503, never "missing"', async () => {
  const saved = HA.states; HA.states = null;
  try { expectStatus(await get('hazard:binary_sensor.kitchen_leak'), 503, 'unreadable'); } finally { HA.states = saved; }
  const raw = db.getState('email_triage');
  db.run("DELETE FROM agent_state WHERE key = 'email_triage'");
  try { expectStatus(await get('email:AAMkWorkEmailOpen0000000001='), 503, 'unreadable'); } finally { db.setState('email_triage', raw); }
});

test('resolving is read-only', async () => {
  const before = JSON.stringify([db.all('SELECT id, status FROM tasks ORDER BY id'), db.all('SELECT action_id, status FROM prepared_actions ORDER BY action_id'), db.getState('email_triage'), db.all('SELECT id, seen FROM personal_inbox')]);
  for (const item of [`task:${ids.openTask}`, 'action:pa_0000000000000001', 'email:AAMkWorkEmailOpen0000000001=', 'email:pmail:nick:7:41', 'meeting-prep:AAMkEventUpcoming0001=']) await get(item);
  const after = JSON.stringify([db.all('SELECT id, status FROM tasks ORDER BY id'), db.all('SELECT action_id, status FROM prepared_actions ORDER BY action_id'), db.getState('email_triage'), db.all('SELECT id, seen FROM personal_inbox')]);
  assert.equal(after, before);
});

// ── Contract ─────────────────────────────────────────────────────────────────

test('contract: link form, parsing, and target validation', () => {
  assert.equal(LINKS.linkFor('task', 600), 'neuro:?item=task%3A600');
  assert.equal(LINKS.linkFor('task', 'abc'), null);
  assert.deepEqual(LINKS.parseNeuroHref('neuro:?item=task%3A600'), { item: { ok: true, kind: 'task', id: '600' } });
  assert.deepEqual(LINKS.parseNeuroHref('neuro:?view=sources'), { view: 'sources' });
  for (const bad of ['neuro:?item=task%3Aabc', 'neuro:?view=sources&item=task%3A1', 'neuro:?view=../x', 'neuro:?foo=bar', 'neuro:']) assert.equal(LINKS.parseNeuroHref(bad), null, bad);
  assert.equal(C.targetsProblem([{ role: 'canonical', href: 'neuro:?item=task%3A600' }], 't'), null);
  assert.match(C.targetsProblem([{ role: 'canonical', href: 'neuro:?item=task%3Aabc' }], 't'), /not a valid neuro: link/);
  assert.match(C.targetsProblem([{ role: 'prep', href: 'neuro:?item=task%3A600' }], 't'), /not a meeting-prep link/);
  assert.equal(C.targetsProblem([{ role: 'prep', href: 'neuro:?item=meeting-prep%3AAAMkEventUpcoming0001%3D' }], 't'), null);
  for (const k of LINKS.KINDS) assert.ok(LINKS.STATUS_HTTP.open && LINKS.ID[k], k);
});
