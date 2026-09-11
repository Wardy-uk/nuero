// Arrival detection and delivery for SARA's room greetings.
//
//   run: npm test   (from sara/backend)

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseSpeakers, nextArrival, createGreeter } = require('../src/greeting/greeter');
const pending = require('../src/greeting/pending');

const clock = (room, since, now) => ({ room, since, sustained: room ? { room, ms: now - since } : null });

test('an arrival is a sure room that has held for the arrival window', () => {
  const boot = 0;
  const since = 100000;
  assert.equal(nextArrival({ announcedSince: null }, clock('study', since, since + 10000), since + 10000, { bootedAt: boot }).arrival, null, 'too soon — walking through');
  const r = nextArrival({ announcedSince: null }, clock('study', since, since + 26000), since + 26000, { bootedAt: boot });
  assert.equal(r.arrival, 'study');
  assert.equal(r.state.announcedSince, since);
});

test('the same stay is only announced once', () => {
  const since = 100000;
  const again = nextArrival({ announcedSince: since }, clock('study', since, since + 600000), since + 600000, { bootedAt: 0 });
  assert.equal(again.arrival, null);
});

test('a new room is a new arrival', () => {
  const r = nextArrival({ announcedSince: 100000 }, clock('kitchen', 900000, 930000), 930000, { bootedAt: 0 });
  assert.equal(r.arrival, 'kitchen');
});

test('no greeting for where he already was when the backend restarted', () => {
  const boot = 1000000;
  const r = nextArrival({ announcedSince: null }, clock('study', boot + 2000, boot + 30000), boot + 30000, { bootedAt: boot });
  assert.equal(r.arrival, null);
  assert.equal(r.suppressed, 'warm-up');
  assert.equal(r.state.announcedSince, boot + 2000, 'marked as seen, so it is not spoken after warm-up either');
  const later = nextArrival(r.state, clock('study', boot + 2000, boot + 200000), boot + 200000, { bootedAt: boot });
  assert.equal(later.arrival, null);
});

test('no sure room, no arrival', () => {
  assert.equal(nextArrival({ announcedSince: null }, { room: null, since: null, sustained: null }, 5, {}).arrival, null);
});

test('speakers parse, and anything malformed is dropped rather than guessed', () => {
  const s = parseSpeakers('living-room=ha:media_player.living_room, study=sensor, bad room=sensor, kitchen=ha:light.x, bedroom=');
  assert.deepEqual([...s.keys()], ['living-room', 'study']);
  assert.deepEqual(s.get('living-room'), { kind: 'ha', entity: 'media_player.living_room' });
  assert.equal(parseSpeakers(undefined).size, 0);
});

test('a pending greeting is collected once, and not after it has gone stale', () => {
  pending.reset();
  pending.put('study', 'Morning, Nick.', 1000);
  assert.deepEqual(pending.take('study', 2000).text, 'Morning, Nick.');
  assert.equal(pending.take('study', 2000), null, 'collected once');
  pending.put('study', 'Late.', 1000);
  assert.equal(pending.take('study', 1000 + pending.MAX_AGE_MS + 1), null, 'a greeting about a moment that has passed is not spoken');
});

const ENV = {
  SARA_GREET_SPEAKERS: 'living-room=ha:media_player.living_room,study=sensor',
  NEURO_BASE_URL: 'http://neuro.test:3001', NEURO_API_TOKEN: 'tok',
  SARA_HA_BASE_URL: 'http://ha.test:8123', SARA_HA_TOKEN: 'hatok',
};
const quietLog = { log() {}, warn() {} };
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('delivery: a sensor room queues the words NEURO chose for its sensor', async () => {
  pending.reset();
  const calls = [];
  const g = createGreeter({ env: ENV, log: quietLog, fetchImpl: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return reply(200, { ok: true, speak: true, text: 'Back at the desk.' });
  } });
  const r = await g.deliver('study');
  assert.equal(r.spoken, true);
  assert.equal(calls[0].url, 'http://neuro.test:3001/api/greeting');
  assert.deepEqual(calls[0].body, { room: 'study' });
  assert.equal(pending.take('study').text, 'Back at the desk.');
});

test('delivery: an HA room speaks through the media player with tts.speak', async () => {
  const calls = [];
  const g = createGreeter({ env: ENV, log: quietLog, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/api/greeting')) return reply(200, { ok: true, speak: true, text: 'Evening, Nick.' });
    return reply(200, []);
  } });
  const r = await g.deliver('living-room');
  assert.equal(r.spoken, true);
  const haCall = calls.find((c) => c.url === 'http://ha.test:8123/api/services/tts/speak');
  assert.ok(haCall, 'Home Assistant was asked to speak');
  assert.equal(haCall.init.headers.Authorization, 'Bearer hatok');
  assert.deepEqual(JSON.parse(haCall.init.body), {
    entity_id: 'tts.piper', media_player_entity_id: 'media_player.living_room', message: 'Evening, Nick.', cache: false,
  });
});

test('delivery: when NEURO chooses silence, nothing is spoken or queued', async () => {
  pending.reset();
  const calls = [];
  const g = createGreeter({ env: ENV, log: quietLog, fetchImpl: async (url) => {
    calls.push(url);
    return reply(200, { ok: true, speak: false, why: 'quiet hours', text: null });
  } });
  const r = await g.deliver('study');
  assert.equal(r.spoken, false);
  assert.equal(r.why, 'quiet hours');
  assert.equal(calls.length, 1);
  assert.equal(pending.take('study'), null);
});

test('delivery: a room with no speaker never asks NEURO', async () => {
  let asked = false;
  const g = createGreeter({ env: ENV, log: quietLog, fetchImpl: async () => { asked = true; return reply(200, {}); } });
  assert.equal((await g.deliver('bedroom')).spoken, false);
  assert.equal(asked, false);
});

test('greeter does not start without configured speakers', () => {
  assert.equal(createGreeter({ env: {}, log: quietLog }).start(), false);
});
