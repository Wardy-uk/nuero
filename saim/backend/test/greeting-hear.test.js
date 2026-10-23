// The bedroom Fire has no speech recogniser, so after asking it records a few
// seconds and pi5's whisper turns them into text (23 Oct 2026).
//
//   run: npm test   (from saim/backend)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const express = require('express');

const stt = require('../src/voice/wyoming-stt');
const pending = require('../src/greeting/pending');

// A Wyoming server that checks what it was sent and answers like faster-whisper
// (data after the header, as current servers send it).
function fakeWhisper(text, seen) {
  return net.createServer((sock) => {
    const read = stt.createReader((ev) => {
      seen.push(ev.type);
      if (ev.type === 'audio-stop') {
        const data = Buffer.from(JSON.stringify({ text }));
        sock.write(JSON.stringify({ type: 'transcript', data_length: data.length, version: '1.5.2' }) + '\n');
        sock.write(data);
      }
    });
    sock.on('data', read);
  });
}

test('the reader takes inline data and data after the header, split anywhere', () => {
  const evs = [];
  const read = stt.createReader((e) => evs.push(e));
  const data = Buffer.from('{"text":"yes please"}');
  const wire = Buffer.concat([
    Buffer.from('{"type":"info","data":{"a":1}}\n'),
    Buffer.from(JSON.stringify({ type: 'transcript', data_length: data.length }) + '\n'),
    data,
  ]);
  for (let i = 0; i < wire.length; i += 7) read(wire.subarray(i, i + 7));
  assert.deepEqual(evs.map((e) => e.type), ['info', 'transcript']);
  assert.equal(evs[1].data.text, 'yes please');
});

test('transcribe streams the audio and returns the text; an absent server is a named failure', async () => {
  const seen = [];
  const srv = fakeWhisper('No thanks.', seen).listen(0);
  try {
    const out = await stt.transcribe(Buffer.alloc(16000), { port: srv.address().port });
    assert.deepEqual(out, { ok: true, text: 'No thanks.' });
    assert.equal(seen[0], 'transcribe');
    assert.equal(seen[1], 'audio-start');
    assert.equal(seen.filter((t) => t === 'audio-chunk').length, 5);
    assert.equal(seen.at(-1), 'audio-stop');
  } finally { srv.close(); }
  const down = await stt.transcribe(Buffer.alloc(3200), { port: 1, timeoutMs: 2000 });
  assert.equal(down.ok, false);
});

test('the route transcribes only while a question is open, for that room', async () => {
  const seen = [];
  const srv = fakeWhisper('Yes please.', seen).listen(0);
  const saved = process.env.SAIM_WHISPER;
  process.env.SAIM_WHISPER = `127.0.0.1:${srv.address().port}`;
  const router = require('../src/routes/presence');
  pending.reset();
  pending.setRenderer(null);
  const app = express();
  app.use('/api/presence', router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/presence`;
  const hear = (id, room, bytes = 8000) => fetch(`${base}/greeting/hear?id=${encodeURIComponent(id)}&room=${room}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(bytes),
  });
  try {
    const q = pending.put('bedroom', 'Q?', Date.now(), { kind: 'room-offer', key: 'warm-room:bedroom' });
    const ok = await hear(q.id, 'bedroom');
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, text: 'Yes please.' });
    assert.equal((await hear(q.id, 'living-room')).status, 409, 'another room cannot use it');
    assert.equal((await hear('nope', 'bedroom')).status, 409, 'no question, no transcription');
    assert.equal((await hear(q.id, 'bedroom', 10)).status, 400, 'no audio');
    assert.ok(pending.hasAsk(q.id, 'bedroom'), 'hearing does not spend the question — the answer does');
  } finally {
    server.close();
    srv.close();
    pending.reset();
    if (saved === undefined) delete process.env.SAIM_WHISPER; else process.env.SAIM_WHISPER = saved;
  }
});
