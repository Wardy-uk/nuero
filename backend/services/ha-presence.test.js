'use strict';

/**
 * Build 13G/H — Home Assistant presence on the event spine.
 *
 * The real event bus, the real world-model consumer and the real SourceHealth
 * projection, with HA's /api/states replaced by a scripted answer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-hapres-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
process.env.HA_PRESENCE_ENTITIES = 'person.nick,binary_sensor.household_others_home';
process.env.LIFE_WORK_ZONES = 'Office,Work';
process.env.HA_URL = 'http://ha.test:8123';
process.env.HA_TOKEN = 'test-token';

const db = require('../db/database');
const bus = require('./event-bus');
const hp = require('./ha-presence');

test.before(async () => {
  await db.init();
  require('./world-model');
  require('./source-health');
});

const T0 = Date.parse('2026-10-06T08:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function states({ nick = 'home', nickChanged = T0 - 3600e3, others = 'on', who = ['Helen', 'Isaac'], othersChanged = T0 - 7200e3 } = {}) {
  return [
    { entity_id: 'person.nick', state: nick, last_changed: iso(nickChanged),
      attributes: { latitude: 52.7369, longitude: -1.3498, gps_accuracy: 12, friendly_name: 'Nick', source: 'device_tracker.life360_nick' } },
    { entity_id: 'binary_sensor.household_others_home', state: others, last_changed: iso(othersChanged),
      attributes: { who_is_home: who, unreadable: [] } },
    { entity_id: 'light.study', state: 'on', last_changed: iso(T0), attributes: {} },
  ];
}
const deps = (answer) => ({ isConfigured: () => true, fetchStates: async () => { if (answer instanceof Error) throw answer; return answer; } });
const pump = () => bus.pumpAll();

test('11. an arrival is an event, and the projection says Nick is home with who else is in', async () => {
  const r = await hp.poll({ now: T0, deps: deps(states()) });
  assert.equal(r.ok, true);
  assert.equal(r.published, 2, 'one event per configured entity — the light is not presence');
  await pump();
  const p = hp.read({ now: T0 });
  assert.equal(p.nick, 'home');
  assert.equal(p.householdOthers, 'others-home');
  assert.deepEqual(p.householdWho, ['Helen', 'Isaac']);
  assert.equal(p.source.state, 'healthy');

  const again = await hp.poll({ now: T0 + 120e3, deps: deps(states()) });
  assert.equal(again.folded, 2, 'an unchanged house is not news: the same change folds');
  await hp.poll({ now: T0 + 240e3, deps: deps(states({ nick: 'not_home', nickChanged: T0 + 200e3 })) });
  await pump();
  assert.equal(hp.read({ now: T0 + 240e3 }).nick, 'away');
});

test('observed-at and received-at stay separate: home all day is current, not stale', async () => {
  await pump();
  const row = db.get("SELECT * FROM wm_presence WHERE entity_id = 'binary_sensor.household_others_home'");
  assert.equal(row.observed_at, iso(T0 - 7200e3), 'when HA saw the change');
  assert.ok(row.received_at > row.observed_at, 'when NEURO heard it is a different fact');
});

test('a work zone is recognised from the configured list; any other zone is a class, never its name', async () => {
  const o = hp.shape('person.nick', { state: 'Work', last_changed: iso(T0) });
  assert.equal(o.stateClass, 'work');
  const z = hp.shape('person.nick', { state: 'Mum and Dad', last_changed: iso(T0) });
  assert.equal(z.stateClass, 'zone');
  assert.ok(!JSON.stringify(z).includes('Mum'), 'the zone NAME never leaves this function');
});

test('6/13. no coordinates, no zone names and no attributes beyond who_is_home ever enter the log', async () => {
  await hp.poll({ now: T0 + 360e3, deps: deps(states({ nick: 'Grandmas House', nickChanged: T0 + 300e3 })) });
  const payloads = db.all("SELECT payload FROM event_log WHERE type = 'observation.presence.changed'").map((r) => r.payload);
  assert.ok(payloads.length >= 3, 'positive control: presence events exist to scan');
  for (const p of payloads) {
    assert.doesNotMatch(p, /52\.73|-1\.34|latitude|longitude|gps|Grandma|life360/i);
  }
});

test('13. co-presence infers no relationship: no People row, no household flag, HA names kept raw', async () => {
  await pump();
  assert.equal(db.get('SELECT COUNT(*) AS n FROM wm_people').n, 0, 'no person was created from a name HA reported');
  const src = fs.readFileSync(path.join(__dirname, 'ha-presence.js'), 'utf8');
  assert.doesNotMatch(src, /INSERT INTO wm_people|UPDATE wm_people|relationship\s*[:=]/, 'presence never writes people or relationships');
});

test('12. HA unreachable is a FAILED run, and presence reads UNKNOWN — never away', async () => {
  for (let i = 0; i < 3; i += 1) {
    const r = await hp.poll({ now: T0 + 600e3 + i * 120e3, deps: deps(new Error('connect ECONNREFUSED')) });
    assert.equal(r.ok, false);
  }
  await pump();
  const src = require('./source-health').getSource(hp.SOURCE_ID);
  assert.equal(src.state, 'failing');
  const p = hp.read({ now: T0 + 900e3 });
  assert.equal(p.nick, 'unknown');
  assert.equal(p.householdOthers, 'unknown');
  assert.match(p.subjects[0].why, /not "away"/);

  // 28. recovery: the next good poll is a success transition and answers again.
  await hp.poll({ now: T0 + 87000e3, deps: deps(states({ nick: 'home', nickChanged: T0 + 990e3 })) });
  await pump();
  assert.equal(require('./source-health').getSource(hp.SOURCE_ID).state, 'healthy');
  assert.equal(hp.read({ now: T0 + 87000e3 }).nick, 'home');
});

test('12. an entity HA cannot read is "unavailable", which reads as unknown', async () => {
  await hp.poll({ now: T0 + 87200e3, deps: deps(states({ others: 'unavailable', othersChanged: T0 + 1100e3 })) });
  await pump();
  const p = hp.read({ now: T0 + 87200e3 });
  assert.equal(p.householdOthers, 'unknown');
  assert.equal(p.nick, 'home', 'positive control: the readable entity still answers');
});

test('a late, OLDER observation never overwrites a newer one', async () => {
  const before = hp.read().nick;
  bus.publishEvent({
    type: 'observation.presence.changed', occurredAt: iso(T0 - 86400e3),
    source: { system: 'homeassistant', recordId: 'person.nick' }, subject: { entityType: 'presence', entityId: 'person.nick' },
    idempotencyKey: 'test-late-presence',
    payload: { entityId: 'person.nick', subjectKind: 'person', state: 'away', who: [], unreadable: [], observedAt: iso(T0 - 86400e3) },
  });
  await pump();
  assert.equal(hp.read().nick, before);
});

test('replay rebuilds wm_presence identically', async () => {
  await pump();
  const snap = db.all('SELECT entity_id, subject_kind, state, who_json, observed_at FROM wm_presence ORDER BY entity_id');
  await bus.replayConsumer('world-model');
  const after = db.all('SELECT entity_id, subject_kind, state, who_json, observed_at FROM wm_presence ORDER BY entity_id');
  assert.deepEqual(after, snap);
});

test('the REAL ha.fetchStates is wired (every other test injects a fake — that is how this shipped broken)', async () => {
  const realFetch = global.fetch;
  let asked = null;
  global.fetch = async (url, opts) => { asked = { url: String(url), auth: opts && opts.headers && opts.headers.Authorization };
    return { ok: true, status: 200, json: async () => states({ nickChanged: T0 + 5000e3 }) }; };
  try {
    const r = await hp.poll({ now: T0 + 5000e3 });
    assert.equal(r.ok, true, r.error);
    assert.equal(asked.url, 'http://ha.test:8123/api/states');
    assert.equal(asked.auth, 'Bearer test-token');
  } finally { global.fetch = realFetch; }
});

test('9 Oct 2026: the roster going A→B→A under one last_changed is three events, not one', async () => {
  const changed = T0 + 86400e3; // after every earlier fixture, so the older-never-overwrites guard does not apply
  const roster = (isaac) => [{ name: 'Helen', role: 'resident', state: 'home' }, { name: 'Isaac', role: 'resident', state: isaac }];
  const at = (isaac) => states({ othersChanged: changed }).map((s) => s.entity_id === 'binary_sensor.household_others_home'
    ? { ...s, attributes: { ...s.attributes, members: roster(isaac) } } : s);
  const isaac = (now) => hp.read({ now }).householdMembers.find((m) => m.name === 'Isaac').state;

  await hp.poll({ now: T0 + 87000e3, deps: deps(at('away')) }); await pump();
  assert.equal(isaac(T0 + 87000e3), 'away');
  await hp.poll({ now: T0 + 87200e3, deps: deps(at('home')) }); await pump();
  assert.equal(isaac(T0 + 87200e3), 'home');
  const r = await hp.poll({ now: T0 + 87400e3, deps: deps(at('away')) }); await pump();
  assert.ok(r.published >= 1, 'the return to "away" must publish, not fold into the first "away"');
  assert.equal(isaac(T0 + 87400e3), 'away', 'the card must not be left saying he is home');
});
