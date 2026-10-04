'use strict';

// Voice capture from the watch (5 Oct 2026).
//
// The watch records a WAV clip and posts it here; this transcribes it with the
// faster-whisper service already running on pi5 for Home Assistant's SAiM voice
// pipeline (Wyoming protocol, tcp 10300) and writes the words through the SAME
// note writer every other capture uses.
//
// Why the Pi and not the watch: watchOS has no speech recogniser for apps
// (SFSpeechRecognizer is unavailable there), and a SwiftUI app cannot open the
// system dictation sheet by itself, so "tap and speak" needs the audio to be
// transcribed somewhere else.
//
// ⚠ EXACTLY ONCE. A watch is out of range most of the day, so a clip is queued
//   on the watch and may be posted more than once (a timeout after the note was
//   written is the usual case). The watch sends an operation id with every clip;
//   a repeat returns the first answer and writes nothing.
// ⚠ "NOTHING HEARD" WRITES NOTHING. An empty transcript is an answer, not a
//   failure: the watch drops the clip and says so. A note containing nothing is
//   worse than no note.
// ⚠ SPEECH SERVICE DOWN IS NOT "NOTHING HEARD". It throws `stt-unavailable`, the
//   route answers 503, and the watch KEEPS the clip to retry. The audio is the
//   only copy of the thought until it has been transcribed and written.

const net = require('net');

const STT_HOST = process.env.VOICE_STT_HOST || '127.0.0.1';
const STT_PORT = Number(process.env.VOICE_STT_PORT || 10300);
const STT_TIMEOUT_MS = Number(process.env.VOICE_STT_TIMEOUT_MS || 60000);
const MIN_SECONDS = 0.3;
const MAX_SECONDS = 300;
const LEDGER_KEY = 'voice_capture_ledger';
const LEDGER_MAX = 200;
const CHUNK_BYTES = 32000; // one second of 16 kHz mono 16-bit

class VoiceCaptureError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ── WAV ──────────────────────────────────────────────────────────────────────
// Walks the RIFF chunks rather than assuming a 44-byte header: AVAudioRecorder
// writes extra chunks (FLLR padding) before `data`.
function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) throw new VoiceCaptureError('bad-audio', 'not a WAV file');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new VoiceCaptureError('bad-audio', 'not a WAV file');
  }
  let fmt = null;
  let pcm = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    const end = Math.min(body + size, buf.length);
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      pcm = buf.subarray(body, end);
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !pcm) throw new VoiceCaptureError('bad-audio', 'WAV has no fmt or data chunk');
  // 1 = PCM; 0xFFFE = extensible (still PCM for our purposes).
  if ((fmt.format !== 1 && fmt.format !== 0xfffe) || fmt.bits !== 16) {
    throw new VoiceCaptureError('bad-audio', `unsupported WAV (format ${fmt.format}, ${fmt.bits}-bit); send 16-bit PCM`);
  }
  const bytesPerSecond = fmt.rate * fmt.channels * 2;
  const seconds = bytesPerSecond ? pcm.length / bytesPerSecond : 0;
  return { rate: fmt.rate, channels: fmt.channels, width: 2, pcm, seconds };
}

// ── Wyoming ──────────────────────────────────────────────────────────────────
// One event = a JSON header line, then optional data JSON bytes, then optional
// payload bytes. We send data inline in the header (accepted by every Wyoming
// server) and read whichever form comes back.
function wyomingEvent(type, data, payload) {
  const header = { type, data: data || {} };
  if (payload) header.payload_length = payload.length;
  const line = Buffer.from(JSON.stringify(header) + '\n', 'utf8');
  return payload ? Buffer.concat([line, payload]) : line;
}

function transcribe(audio, { host = STT_HOST, port = STT_PORT, timeoutMs = STT_TIMEOUT_MS, language = 'en' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buffered = Buffer.alloc(0);
    let done = false;
    const finish = (err, text) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err); else resolve(text);
    };
    const timer = setTimeout(() => finish(new VoiceCaptureError('stt-unavailable', 'speech service timed out')), timeoutMs);

    socket.on('error', (e) => finish(new VoiceCaptureError('stt-unavailable', `speech service unreachable: ${e.code || e.message}`)));
    socket.on('close', () => finish(new VoiceCaptureError('stt-unavailable', 'speech service closed without a transcript')));
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const nl = buffered.indexOf(0x0a);
        if (nl < 0) return;
        let header;
        try { header = JSON.parse(buffered.subarray(0, nl).toString('utf8')); } catch {
          return finish(new VoiceCaptureError('stt-unavailable', 'speech service sent something unreadable'));
        }
        const dataLen = header.data_length || 0;
        const payloadLen = header.payload_length || 0;
        if (buffered.length < nl + 1 + dataLen + payloadLen) return; // wait for the rest
        let data = header.data || {};
        if (dataLen) {
          try { data = { ...data, ...JSON.parse(buffered.subarray(nl + 1, nl + 1 + dataLen).toString('utf8')) }; } catch {}
        }
        buffered = buffered.subarray(nl + 1 + dataLen + payloadLen);
        if (header.type === 'transcript') return finish(null, String(data.text || '').trim());
        if (header.type === 'error') return finish(new VoiceCaptureError('stt-unavailable', `speech service error: ${data.text || 'unknown'}`));
      }
    });

    socket.on('connect', () => {
      const fmt = { rate: audio.rate, width: audio.width, channels: audio.channels };
      socket.write(wyomingEvent('transcribe', { language }));
      socket.write(wyomingEvent('audio-start', fmt));
      for (let i = 0; i < audio.pcm.length; i += CHUNK_BYTES) {
        socket.write(wyomingEvent('audio-chunk', fmt, audio.pcm.subarray(i, i + CHUNK_BYTES)));
      }
      socket.write(wyomingEvent('audio-stop', {}));
    });
  });
}

// ── Ledger (exactly once) ────────────────────────────────────────────────────
function readLedger(store) {
  try {
    const raw = store.getState(LEDGER_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function writeLedger(store, ledger) {
  const ids = Object.keys(ledger).sort((a, b) => String(ledger[a].at).localeCompare(String(ledger[b].at)));
  while (ids.length > LEDGER_MAX) delete ledger[ids.shift()];
  store.setState(LEDGER_KEY, JSON.stringify(ledger));
}

// ── The act ──────────────────────────────────────────────────────────────────
// Dependencies are injectable so the tests need no vault, DB or Pi.
async function captureVoice({ wav, operationId, source = 'watch-voice' }, deps = {}) {
  const store = deps.store || require('../db/database');
  const writeNote = deps.writeNote || require('./capture-store').writeNote;
  const stt = deps.transcribe || transcribe;

  const id = String(operationId || '').trim();
  if (!id || id.length > 100) throw new VoiceCaptureError('bad-request', 'an operation id is required');

  const ledger = readLedger(store);
  if (ledger[id]) return { ...ledger[id], already: true };

  const audio = parseWav(wav);
  if (audio.seconds < MIN_SECONDS) {
    const result = { success: false, reason: 'nothing-heard', text: '', at: new Date().toISOString() };
    ledger[id] = result; writeLedger(store, ledger);
    return result;
  }
  if (audio.seconds > MAX_SECONDS) throw new VoiceCaptureError('bad-audio', `clip is ${Math.round(audio.seconds)}s; the limit is ${MAX_SECONDS}s`);

  const text = await stt(audio);
  if (!text) {
    const result = { success: false, reason: 'nothing-heard', text: '', at: new Date().toISOString() };
    ledger[id] = result; writeLedger(store, ledger);
    return result;
  }

  const { filePath, filename } = writeNote({ content: text, source });
  const result = { success: true, text, filename, filePath, seconds: Math.round(audio.seconds * 10) / 10, at: new Date().toISOString() };
  // Recorded straight after the write: a retry from here on must not write twice.
  ledger[id] = result; writeLedger(store, ledger);
  return result;
}

module.exports = { captureVoice, parseWav, transcribe, wyomingEvent, VoiceCaptureError, MIN_SECONDS, MAX_SECONDS };
