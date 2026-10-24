'use strict';

/**
 * Hume Band V1 (J-Style 2208) — PURE decoder for what the NEURO iOS app
 * captures over Bluetooth (24 Oct 2026). No DB, no clock, no network.
 *
 * The phone uploads RAW packets; NEURO decodes them here and stores what this
 * decoder says, so the raw bytes stay the authority and a decoder fix can be
 * re-run over evidence already held. The phone decodes too, for its own
 * screen, and sends its counts; a disagreement is flagged, never resolved by
 * trusting either side.
 *
 * ⚠⚠ EVERY BP VALUE HERE IS AN EXPERIMENTAL HUME ESTIMATE. It is never a
 * blood-pressure measurement, never joins HiLo/cuff readings, health_samples or
 * health_daily, and no offset (the old +12/+8) is ever applied. Values are kept
 * exactly as the band sent them; a ZERO BP field means "no BP result" and is
 * stored as null with the raw byte kept.
 *
 * Field names are the vendor SDK's labels (hrv, vascularAging, stress). Nothing
 * here claims they mean what the labels say, nor what unit or method HRV uses.
 *
 * Packet shapes (checked against the real captures in
 * nuero-ios NeuroKit/Tests/NeuroKitTests/Fixtures/hume-v1-captures.json):
 *   0x56 history: records of 15 bytes
 *     [0]=0x56 [1..2]=index LE [3..8]=BCD YY MM DD hh mm ss [9]=hrv
 *     [10]=vascularAging [11]=heartRate [12]=stress [13]=systolic [14]=diastolic
 *     A notification carries several whole records; the end marker 0x56 0xFF
 *     may follow the last record in the same notification. Newest record first.
 *   0x28 live (16-byte frame, byte 15 checksum):
 *     [1]=type [2]=HR [3]=SpO2 [4]=HRV [5]=stress [6]=sys [7]=dia
 *     [8..9]=temperature LE x0.1; [10..14] kept uninterpreted.
 *   0x88 calibration: [1..4] = minDia, maxDia, minSys, maxSys.
 *   0x27 firmware: [1..4] dotted, [5..7] BCD build date (20YY-MM-DD).
 *   0x41 clock: [1..6] BCD local wall clock (no timezone).
 *   0x22 address: [1..6] the band's Bluetooth address.
 */

const DECODER_VERSION = 'hume-v1-decoder@1';
const OP = Object.freeze({ HISTORY: 0x56, LIVE: 0x28, CALIBRATION: 0x88, FIRMWARE: 0x27, CLOCK: 0x41, ADDRESS: 0x22 });
const RECORD_LEN = 15;
const END = 0xff;

// Plausibility bounds. Outside them a value is FLAGGED suspect, never clamped,
// corrected or dropped — the number stored is the number the band sent.
const BOUNDS = Object.freeze({ hr: [25, 220], sys: [60, 260], dia: [30, 160] });

function hexToBytes(hex) {
  const s = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
  if (s.length % 2) return null;
  const out = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
}

function bytesToHex(bytes) { return bytes.map((b) => b.toString(16).padStart(2, '0')).join(''); }

function checksum(bytes) { let s = 0; for (let i = 0; i < 15 && i < bytes.length; i++) s += bytes[i]; return s & 0xff; }

/** A 16-byte frame whose byte 15 is the additive checksum of bytes 0..14. */
function checksumOk(bytes) { return bytes.length === 16 && checksum(bytes) === bytes[15]; }

function bcd(b) {
  const hi = b >> 4, lo = b & 0x0f;
  return hi <= 9 && lo <= 9 ? hi * 10 + lo : null;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * Six BCD bytes YY MM DD hh mm ss → "YYYY-MM-DDTHH:MM:SS" local wall clock,
 * or null with a reason. A day that does not exist (31 Feb) is refused.
 */
function bcdLocal(b6) {
  if (!b6 || b6.length < 6) return { local: null, why: 'short' };
  const v = b6.slice(0, 6).map(bcd);
  if (v.some((x) => x === null)) return { local: null, why: 'not-bcd' };
  const [yy, mo, d, h, mi, s] = v;
  const y = 2000 + yy;
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return { local: null, why: 'out-of-range' };
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > dim) return { local: null, why: 'no-such-day' };
  return { local: `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`, why: null };
}

/** BP pair: both zero = no result; one zero = no result AND flagged. */
function _bp(sys, dia, flags) {
  if (sys === 0 && dia === 0) return { systolic: null, diastolic: null, bpAvailable: false };
  if (sys === 0 || dia === 0) { flags.push('bp-half-zero'); return { systolic: null, diastolic: null, bpAvailable: false }; }
  if (sys < BOUNDS.sys[0] || sys > BOUNDS.sys[1] || dia < BOUNDS.dia[0] || dia > BOUNDS.dia[1]) flags.push('bp-outside-plausible-range');
  if (sys <= dia) flags.push('bp-systolic-not-above-diastolic');
  return { systolic: sys, diastolic: dia, bpAvailable: true };
}

function _hr(hr, flags) {
  if (hr === 0) { flags.push('hr-zero'); return; }
  if (hr < BOUNDS.hr[0] || hr > BOUNDS.hr[1]) flags.push('hr-outside-plausible-range');
}

/** One 15-byte history record (already known to start with 0x56). */
function decodeHistoryRecord(r) {
  const flags = [];
  const when = bcdLocal(r.slice(3, 9));
  if (!when.local) flags.push(`timestamp-${when.why}`);
  const hr = r[11];
  _hr(hr, flags);
  const bp = _bp(r[13], r[14], flags);
  return {
    index: r[1] | (r[2] << 8),
    deviceLocal: when.local,
    hrvField: r[9],
    vascularAgingField: r[10],
    heartRate: hr,
    stressField: r[12],
    ...bp,
    rawSystolic: r[13],
    rawDiastolic: r[14],
    rawHex: bytesToHex(r),
    // Identity WITHOUT the index: the index is a position in the band's list,
    // which shifts as new records arrive, so it cannot say two records differ.
    payloadHex: bytesToHex(r.slice(3)),
    malformed: !when.local,
    suspect: flags.some((f) => !f.startsWith('timestamp-')),
    flags,
  };
}

/**
 * The 0x56 history packets of one capture, in the order received
 * (`[{seq, hex}]`). Packets are concatenated into one stream — a record split
 * across two notifications is still one record — and walked 15 bytes at a time.
 *
 * Returns records (each with the packet seq + byte offset it STARTED in),
 * whether the end marker was seen, and anything that could not be framed. A
 * stream that loses alignment is resynchronised at the next 0x56 that begins a
 * valid BCD date; the bytes skipped are reported, never silently dropped.
 */
function decodeHistory(packets) {
  const stream = [];
  // A packet that does not START with 0x56 is only taken as the tail of a
  // record split across notifications: the previous history packet must have
  // ended part-way through a record. Anything else (the band's unsolicited
  // 0x16 frames, a stray reply) is not history and is left out.
  let open = false;
  let recordBytes = 0;
  for (const p of packets) {
    const bytes = hexToBytes(p.hex);
    if (!bytes || !bytes.length) continue;
    if (bytes[0] !== OP.HISTORY && !open) continue;
    bytes.forEach((b, i) => stream.push({ b, seq: p.seq, off: i }));
    const n = bytes.length;
    const endsWithMarker = n >= 2 && bytes[n - 2] === OP.HISTORY && bytes[n - 1] === END
      && (recordBytes + n - 2) % RECORD_LEN === 0;
    if (endsWithMarker) { recordBytes = 0; open = false; continue; }
    recordBytes += n;
    open = recordBytes % RECORD_LEN !== 0;
  }
  const records = [];
  const unframed = [];
  let endMarkerSeen = false;
  let endMarkers = 0;
  let i = 0;
  while (i < stream.length) {
    const b = stream[i].b;
    if (b === OP.HISTORY && i + 1 < stream.length && stream[i + 1].b === END
        && (i + 2 === stream.length || stream[i + 2].off === 0)) {
      // 56 FF closing a notification (or the stream). A record whose index low
      // byte is 0xFF is NOT a marker: it has more bytes in the same packet.
      endMarkerSeen = true; endMarkers++; i += 2; continue;
    }
    if (b === OP.HISTORY && i + RECORD_LEN <= stream.length
        && (_validStartAt(stream, i) || _nextValidStart(stream, i + 1, i + RECORD_LEN) === -1)) {
      // A record with an unreadable date is still taken as a (malformed) record
      // when no readable record starts inside its 15 bytes; otherwise those
      // bytes are junk and framing resumes at the readable one.
      const r = stream.slice(i, i + RECORD_LEN).map((x) => x.b);
      const rec = decodeHistoryRecord(r);
      records.push({ ...rec, packetSeq: stream[i].seq, packetOffset: stream[i].off });
      i += RECORD_LEN; continue;
    }
    // Lost alignment: skip to the next byte that could start a record.
    const start = i;
    i++;
    while (i < stream.length) {
      if (stream[i].b === OP.HISTORY && i + 9 <= stream.length
          && bcdLocal(stream.slice(i + 3, i + 9).map((x) => x.b)).local) break;
      if (stream[i].b === OP.HISTORY && i + 1 < stream.length && stream[i + 1].b === END) break;
      i++;
    }
    unframed.push({ packetSeq: stream[start].seq, packetOffset: stream[start].off,
      hex: bytesToHex(stream.slice(start, i).map((x) => x.b)) });
  }
  return { records, endMarkerSeen, endMarkers, unframed, bytes: stream.length };
}

function _validStartAt(stream, i) {
  return stream[i].b === OP.HISTORY && i + 9 <= stream.length
    && !!bcdLocal(stream.slice(i + 3, i + 9).map((x) => x.b)).local;
}

function _nextValidStart(stream, from, to) {
  for (let j = from; j < Math.min(to, stream.length); j++) if (_validStartAt(stream, j)) return j;
  return -1;
}

/** One 0x28 live notification. null when it is not one. */
function decodeLiveUpdate(hex) {
  const b = hexToBytes(hex);
  if (!b || b[0] !== OP.LIVE) return null;
  const flags = [];
  if (b.length !== 16) flags.push('not-16-bytes');
  else if (!checksumOk(b)) flags.push('checksum-mismatch');
  const g = (i) => (i < b.length ? b[i] : null);
  const hr = g(2);
  if (hr !== null) _hr(hr, flags);
  const bp = _bp(g(6) || 0, g(7) || 0, flags);
  const t = b.length > 9 ? (b[8] | (b[9] << 8)) : null;
  return {
    type: g(1), heartRate: hr, spo2: g(3), hrvField: g(4), stressField: g(5),
    ...bp, rawSystolic: g(6), rawDiastolic: g(7),
    temperatureC: t === null ? null : Math.round(t) / 10,
    uninterpretedHex: bytesToHex(b.slice(10, 15)),
    rawHex: bytesToHex(b), flags,
  };
}

/**
 * The updates of one live session → at most ONE final BP: the LAST update
 * (by seq) carrying a populated pair. Repeated notifications are updates within
 * one measurement, never independent measurements.
 */
function finalOfSession(updates) {
  let final = null;
  for (const u of [...updates].sort((a, b) => a.seq - b.seq)) {
    if (u.bpAvailable) final = u;
  }
  return final;
}

function decodeCalibration(hex) {
  const b = hexToBytes(hex);
  if (!b || b[0] !== OP.CALIBRATION || b.length < 5) return null;
  return { minDiastolic: b[1], maxDiastolic: b[2], minSystolic: b[3], maxSystolic: b[4],
    checksumOk: b.length === 16 ? checksumOk(b) : null, rawHex: bytesToHex(b) };
}

function decodeFirmware(hex) {
  const b = hexToBytes(hex);
  if (!b || b[0] !== OP.FIRMWARE || b.length < 8) return null;
  const version = b.slice(1, 5).map((x) => x.toString(16)).join('.');
  const yy = bcd(b[5]), mm = bcd(b[6]), dd = bcd(b[7]);
  const build = yy !== null && mm && dd ? `20${pad(yy)}-${pad(mm)}-${pad(dd)}` : null;
  return { version, build, rawHex: bytesToHex(b) };
}

function decodeClock(hex) {
  const b = hexToBytes(hex);
  if (!b || b[0] !== OP.CLOCK || b.length < 7) return null;
  return { bandLocal: bcdLocal(b.slice(1, 7)).local, rawHex: bytesToHex(b) };
}

function decodeAddress(hex) {
  const b = hexToBytes(hex);
  if (!b || b[0] !== OP.ADDRESS || b.length < 7) return null;
  const mac = b.slice(1, 7);
  if (mac.every((x) => x === 0)) return null;
  return mac.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

// ── time ────────────────────────────────────────────────────────────────────

const MIN = 60000;

/** "YYYY-MM-DDTHH:MM:SS" read as if it were UTC → ms (a NAIVE number). */
function naiveMs(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(local || '');
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

function _wall(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

function validTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}

/** Every UTC instant a local wall time names in `tz`: one, two (repeated hour) or none (skipped hour). */
function tzCandidates(local, tz) {
  const guess = naiveMs(local);
  if (guess === null || !validTimeZone(tz)) return [];
  const out = [];
  for (let off = -14 * 60; off <= 14 * 60; off += 15) {
    const ms = guess - off * MIN;
    if (_wall(ms, tz) === local && !out.includes(ms)) out.push(ms);
  }
  return out.sort((a, b) => a - b);
}

/**
 * What offset was the band's clock running at when it was read?
 * band wall clock − true UTC, rounded to 15 minutes; the residue is drift.
 * `phoneUtc` is the phone's clock at the moment the reply arrived.
 */
function bandClockOffset(clock) {
  if (!clock || !clock.bandLocal || !clock.phoneUtc) return null;
  const band = naiveMs(clock.bandLocal);
  const utc = Date.parse(clock.phoneUtc);
  if (band === null || !Number.isFinite(utc)) return null;
  const diff = band - utc;
  const offsetMin = Math.round(diff / (15 * MIN)) * 15;
  return { offsetMin, driftSeconds: Math.round((diff - offsetMin * MIN) / 1000) };
}

/**
 * A band record's local time → a UTC instant, SAYING HOW and what is uncertain.
 *
 * The band stores wall-clock time with no zone and no DST rule; its clock was
 * set (by the Hume app) at some unknown moment. Two readings exist:
 *  - band-clock-offset: the offset the band's clock was running at when this
 *    sync read it. Right for records made since its clock was last set; WRONG
 *    for older records if the clock was reset since. Assumed constant — flagged.
 *  - phone-tz-rules: the phone's timezone rules applied to the wall time. Right
 *    only if the band's clock follows the same DST rules (it does not change
 *    itself at a clock change), and ambiguous in the repeated autumn hour.
 * The first is preferred when the clock was read; both are kept, and a
 * disagreement is flagged rather than chosen away.
 */
function interpretTime(local, { tz, clockOffset } = {}) {
  const flags = [];
  const naive = naiveMs(local);
  if (naive === null) return { utc: null, method: null, offsetMin: null, tzRulesUtc: null, flags: ['no-local-time'] };
  const cands = tzCandidates(local, tz);
  if (!validTimeZone(tz)) flags.push('phone-timezone-unknown');
  else if (cands.length === 0) flags.push('dst-nonexistent-local-time');
  else if (cands.length > 1) flags.push('dst-repeated-hour');
  const tzRulesUtc = cands.length ? new Date(cands[0]).toISOString() : null;

  if (clockOffset && Number.isFinite(clockOffset.offsetMin)) {
    const utcMs = naive - clockOffset.offsetMin * MIN;
    flags.push('offset-assumed-constant-since-band-clock-set');
    if (Math.abs(clockOffset.driftSeconds || 0) > 120) flags.push('band-clock-drift');
    if (cands.length && !cands.includes(utcMs)) flags.push('tz-rules-disagree');
    return { utc: new Date(utcMs).toISOString(), method: 'band-clock-offset', offsetMin: clockOffset.offsetMin, tzRulesUtc, flags };
  }
  flags.push('band-clock-not-read');
  if (!cands.length) return { utc: null, method: null, offsetMin: null, tzRulesUtc: null, flags };
  const utcMs = cands[0];
  return { utc: new Date(utcMs).toISOString(), method: 'phone-tz-rules',
    offsetMin: Math.round((naive - utcMs) / MIN), tzRulesUtc, flags };
}

module.exports = {
  DECODER_VERSION, OP, RECORD_LEN, BOUNDS,
  hexToBytes, bytesToHex, checksum, checksumOk, bcdLocal,
  decodeHistory, decodeHistoryRecord, decodeLiveUpdate, finalOfSession,
  decodeCalibration, decodeFirmware, decodeClock, decodeAddress,
  naiveMs, tzCandidates, bandClockOffset, interpretTime, validTimeZone,
};
