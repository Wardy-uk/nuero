'use strict';

// Speech to text over the Wyoming protocol — the faster-whisper container on pi5
// (`wyoming-whisper`, :10300) that Home Assistant's voice pipeline already uses
// (23 Oct 2026). For the room tablets that have no speech recogniser of their own
// (the bedroom Fire: Fire OS ships none), so a "yes" after SAiM asks something
// can still be heard.
//
// Wyoming: each event is one JSON header line, optionally followed by `data_length`
// bytes of JSON data and `payload_length` bytes of payload. Older servers put
// `data` inline in the header; both are read.
//
// ⚠ NOTHING IS KEPT. The audio lives in memory for one request and the text is
//   returned to the caller only — never logged, never stored. It is a room in the
//   house.

const net = require('net');

const RATE = 16000;
const WIDTH = 2;
const CHANNELS = 1;
const CHUNK = 3200; // 100 ms

function header(type, data, payloadLength = 0) {
  const h = { type, data };
  if (payloadLength) h.payload_length = payloadLength;
  return Buffer.from(JSON.stringify(h) + '\n');
}

/** Read Wyoming events from a byte stream. PURE over buffers, for tests. */
function createReader(onEvent) {
  let buf = Buffer.alloc(0);
  let pending = null; // { head, dataLen, payloadLen }
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (!pending) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        let head;
        try { head = JSON.parse(buf.subarray(0, nl).toString('utf8')); } catch { head = null; }
        buf = buf.subarray(nl + 1);
        if (!head) continue;
        pending = { head, dataLen: Number(head.data_length) || 0, payloadLen: Number(head.payload_length) || 0 };
      }
      const need = pending.dataLen + pending.payloadLen;
      if (buf.length < need) return;
      let data = pending.head.data || {};
      if (pending.dataLen) {
        try { data = { ...data, ...JSON.parse(buf.subarray(0, pending.dataLen).toString('utf8')) }; } catch { /* keep inline */ }
      }
      buf = buf.subarray(need);
      const ev = { type: pending.head.type, data };
      pending = null;
      onEvent(ev);
    }
  };
}

/**
 * Transcribe 16 kHz mono 16-bit PCM. Resolves { ok:true, text } or
 * { ok:false, why }. Never throws.
 */
function transcribe(pcm, { host = '127.0.0.1', port = 10300, timeoutMs = 20000, language = 'en' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); try { sock.destroy(); } catch { /* gone */ } resolve(v); };
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => done({ ok: false, why: 'speech-to-text timed out' }), timeoutMs);
    const read = createReader((ev) => {
      if (ev.type === 'transcript') done({ ok: true, text: String((ev.data && ev.data.text) || '').trim() });
      if (ev.type === 'error') done({ ok: false, why: 'speech-to-text refused it' });
    });
    sock.on('data', read);
    sock.on('error', (e) => done({ ok: false, why: `speech-to-text unreachable (${e.code || e.message})` }));
    sock.on('close', () => done({ ok: false, why: 'speech-to-text closed without an answer' }));
    sock.on('connect', () => {
      const fmt = { rate: RATE, width: WIDTH, channels: CHANNELS };
      sock.write(header('transcribe', { language }));
      sock.write(header('audio-start', fmt));
      for (let i = 0; i < pcm.length; i += CHUNK) {
        const part = pcm.subarray(i, Math.min(i + CHUNK, pcm.length));
        sock.write(header('audio-chunk', fmt, part.length));
        sock.write(part);
      }
      sock.write(header('audio-stop', {}));
    });
  });
}

module.exports = { transcribe, createReader, RATE };
