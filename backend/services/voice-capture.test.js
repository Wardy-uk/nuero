'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const voice = require('./voice-capture');

// A 16 kHz mono 16-bit WAV, with an extra chunk before `data` the way
// AVAudioRecorder writes one, so the parser cannot pass by assuming 44 bytes.
function wav(seconds, { rate = 16000, padChunk = true } = {}) {
  const pcm = Buffer.alloc(Math.round(seconds * rate) * 2, 1);
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(rate, 12); fmt.writeUInt32LE(rate * 2, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22);
  const fllr = Buffer.alloc(8 + 12); fllr.write('FLLR', 0); fllr.writeUInt32LE(12, 4);
  const data = Buffer.alloc(8); data.write('data', 0); data.writeUInt32LE(pcm.length, 4);
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, padChunk ? fllr : Buffer.alloc(0), data, pcm]);
  const riff = Buffer.alloc(8); riff.write('RIFF', 0); riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

function memoryStore() {
  const m = new Map();
  return { getState: (k) => m.get(k) ?? null, setState: (k, v) => m.set(k, v), m };
}

// A fake Wyoming STT server: reads events, answers `transcript` after `audio-stop`.
function fakeWyoming(text, seen) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (c) => {
        buf = Buffer.concat([buf, c]);
        for (;;) {
          const nl = buf.indexOf(0x0a);
          if (nl < 0) return;
          const h = JSON.parse(buf.subarray(0, nl).toString());
          const need = nl + 1 + (h.payload_length || 0);
          if (buf.length < need) return;
          seen.push({ type: h.type, data: h.data, payload: h.payload_length || 0 });
          buf = buf.subarray(need);
          if (h.type === 'audio-stop') {
            // Data sent the newer way: a data_length block after the header.
            const d = Buffer.from(JSON.stringify({ text }));
            sock.write(JSON.stringify({ type: 'transcript', data_length: d.length }) + '\n');
            sock.write(d);
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('parseWav walks chunks rather than assuming a 44-byte header', () => {
  const a = voice.parseWav(wav(1.5));
  assert.strictEqual(a.rate, 16000);
  assert.strictEqual(a.channels, 1);
  assert.strictEqual(a.pcm.length, 48000);
  assert.ok(Math.abs(a.seconds - 1.5) < 0.01);
});

test('parseWav refuses something that is not 16-bit PCM WAV', () => {
  assert.throws(() => voice.parseWav(Buffer.from('hello world, not audio')), { code: 'bad-audio' });
});

test('transcribe speaks Wyoming: transcribe, audio-start, chunks, audio-stop, and reads the transcript', async () => {
  const seen = [];
  const server = await fakeWyoming('Remember to call Hope', seen);
  const text = await voice.transcribe(voice.parseWav(wav(2.5)), { host: '127.0.0.1', port: server.address().port, timeoutMs: 5000 });
  server.close();
  assert.strictEqual(text, 'Remember to call Hope');
  assert.deepStrictEqual(seen.map((e) => e.type).filter((t, i, a) => a.indexOf(t) === i), ['transcribe', 'audio-start', 'audio-chunk', 'audio-stop']);
  assert.strictEqual(seen.filter((e) => e.type === 'audio-chunk').reduce((n, e) => n + e.payload, 0), 80000);
  assert.deepStrictEqual(seen.find((e) => e.type === 'audio-start').data, { rate: 16000, width: 2, channels: 1 });
});

test('an unreachable speech service is stt-unavailable, never "nothing heard"', async () => {
  const closed = net.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  closed.close();
  await assert.rejects(voice.transcribe(voice.parseWav(wav(1)), { host: '127.0.0.1', port, timeoutMs: 2000 }), { code: 'stt-unavailable' });
});

test('a clip is written once, however many times it is posted', async () => {
  const store = memoryStore();
  const writes = [];
  const deps = { store, transcribe: async () => 'Buy milk', writeNote: (n) => { writes.push(n); return { filePath: '/v/x.md', filename: 'x.md' }; } };
  const first = await voice.captureVoice({ wav: wav(1), operationId: 'op-1' }, deps);
  const again = await voice.captureVoice({ wav: wav(1), operationId: 'op-1' }, deps);
  assert.strictEqual(first.success, true);
  assert.strictEqual(first.text, 'Buy milk');
  assert.strictEqual(again.already, true);
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].content, 'Buy milk');
  assert.strictEqual(writes[0].source, 'watch-voice');
});

test('nothing heard writes nothing', async () => {
  const writes = [];
  const deps = { store: memoryStore(), transcribe: async () => '', writeNote: (n) => { writes.push(n); return {}; } };
  const r = await voice.captureVoice({ wav: wav(1), operationId: 'op-2' }, deps);
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.reason, 'nothing-heard');
  assert.strictEqual(writes.length, 0);
  const tiny = await voice.captureVoice({ wav: wav(0.1), operationId: 'op-3' }, deps);
  assert.strictEqual(tiny.reason, 'nothing-heard');
  assert.strictEqual(writes.length, 0);
});

test('a speech-service failure is not recorded, so the retry can still succeed', async () => {
  const store = memoryStore();
  let up = false;
  const writes = [];
  const deps = {
    store,
    transcribe: async () => { if (!up) throw new voice.VoiceCaptureError('stt-unavailable', 'down'); return 'Later'; },
    writeNote: (n) => { writes.push(n); return { filePath: '/v/y.md', filename: 'y.md' }; },
  };
  await assert.rejects(voice.captureVoice({ wav: wav(1), operationId: 'op-4' }, deps), { code: 'stt-unavailable' });
  up = true;
  const r = await voice.captureVoice({ wav: wav(1), operationId: 'op-4' }, deps);
  assert.strictEqual(r.success, true);
  assert.strictEqual(writes.length, 1);
});

test('an operation id is required', async () => {
  await assert.rejects(voice.captureVoice({ wav: wav(1), operationId: '' }, { store: memoryStore() }), { code: 'bad-request' });
});
