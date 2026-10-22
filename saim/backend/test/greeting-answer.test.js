// "Want it warmed to 20?" — and the living-room tablet hears "yes" (22 Oct 2026).
// The tablet sends only a yes or a no it matched itself; this decides what that
// answers, once, and acts through NEURO's own room route.
//
//   run: npm test   (from saim/backend)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const pending = require('../src/greeting/pending');

test('a greeting that asks is marked to listen; one that does not, is not', () => {
  pending.reset();
  pending.setRenderer(null);
  pending.put('living-room', "It's 17 in here. Want it warmed to 20?", Date.now(), { kind: 'room-offer', key: 'warm-room:living-room' });
  assert.equal(pending.take('living-room').listen, true);
  pending.put('living-room', 'Rain from three.');
  assert.equal(pending.take('living-room').listen, undefined);
});

test('a question is spent once, by its own room, inside the window', () => {
  pending.reset();
  const t0 = 1_000_000;
  const g = pending.put('living-room', 'Q?', t0, { kind: 'room-offer', key: 'k' });
  assert.equal(pending.answer(g.id, 'bedroom', t0), null, 'another room cannot answer it');
  assert.deepEqual(pending.answer(g.id, 'living-room', t0 + 1000), { room: 'living-room', ask: { kind: 'room-offer', key: 'k' } });
  assert.equal(pending.answer(g.id, 'living-room', t0 + 2000), null, 'never twice');
  const late = pending.put('living-room', 'Q?', t0, { kind: 'room-offer', key: 'k' });
  assert.equal(pending.answer(late.id, 'living-room', t0 + pending.ASK_TTL_MS + 1), null, 'never late');
});

test('yes accepts the offer through NEURO, no declines it, and each speaks back', async () => {
  const calls = [];
  const neuro = express();
  neuro.use(express.json());
  neuro.post('/api/rooms/:key/:verb', (req, res) => {
    calls.push(`${req.params.verb}:${req.params.key}`);
    if (req.params.verb === 'accept') return res.json({ ok: true, say: 'Warming the living room to 20°C until you leave — then back to auto.' });
    return res.json({ ok: true, key: req.params.key, decision: 'declined' });
  });
  const neuroServer = neuro.listen(0);
  const saved = { url: process.env.NEURO_BASE_URL, tok: process.env.NEURO_API_TOKEN, kiosk: process.env.NEURO_KIOSK_TOKEN };
  process.env.NEURO_BASE_URL = `http://127.0.0.1:${neuroServer.address().port}`;
  process.env.NEURO_API_TOKEN = 'test-token';
  delete process.env.NEURO_KIOSK_TOKEN;

  const router = require('../src/routes/presence');
  pending.reset();
  pending.setRenderer(null);
  const app = express();
  app.use('/api/presence', router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/presence`;
  const post = (body) => fetch(`${base}/greeting/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const q = pending.put('living-room', 'Q?', Date.now(), { kind: 'room-offer', key: 'warm-room:living-room' });
    const yes = await post({ id: q.id, room: 'living-room', answer: 'yes' });
    assert.equal(yes.status, 200);
    const y = await yes.json();
    assert.equal(y.done, true);
    assert.match(y.greeting.text, /Warming the living room to 20 degrees/);
    assert.equal(y.greeting.listen, undefined, 'the confirmation does not listen again');
    assert.deepEqual(calls, ['accept:warm-room:living-room']);

    const again = await post({ id: q.id, room: 'living-room', answer: 'yes' });
    assert.equal(again.status, 409, 'the same question cannot be answered twice');
    assert.equal(calls.length, 1, 'and nothing was sent to NEURO for it');

    const q2 = pending.put('living-room', 'Q?', Date.now(), { kind: 'room-offer', key: 'warm-room:living-room' });
    const no = await (await post({ id: q2.id, room: 'living-room', answer: 'no' })).json();
    assert.equal(no.done, true);
    assert.match(no.greeting.text, /leave it/);
    assert.deepEqual(calls, ['accept:warm-room:living-room', 'decline:warm-room:living-room']);

    assert.equal((await post({ id: 'x', room: 'living-room', answer: 'maybe' })).status, 400, 'only yes or no');
    assert.equal((await post({ id: 'unknown', room: 'living-room', answer: 'yes' })).status, 409);
    assert.equal(calls.length, 2);
  } finally {
    server.close();
    neuroServer.close();
    pending.reset();
    for (const [k, v] of [['NEURO_BASE_URL', saved.url], ['NEURO_API_TOKEN', saved.tok], ['NEURO_KIOSK_TOKEN', saved.kiosk]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
