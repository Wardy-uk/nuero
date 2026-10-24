'use strict';

/**
 * Hume Band V1 captures — storage and reads (24 Oct 2026).
 *
 * The NEURO iOS app connects to the band in the foreground, reads (never
 * writes) its calibration and HRV/BP history, optionally runs a user-started
 * live measurement, keeps every packet on the phone, and posts each capture as
 * ONE bundle to POST /api/health/hume/captures. This module is the only writer
 * and reader of the hume_* tables (schema.sql).
 *
 * ⚠⚠ EXPERIMENTAL. Every BP value here is the band's own estimate, labelled
 * `experimental-hume-estimate`, and is NEVER copied into health_samples,
 * health_daily, hilo_readings, Apple Health, a BP summary, an alert or a
 * recommendation. A source scan in hume-band.test.js pins that nothing else
 * reads these tables.
 *
 * Separation:
 *   hume_packets            raw evidence (every tx/rx byte, per bundle)
 *   hume_history_records    decoded 0x56 records (origin historical)
 *   hume_live_sessions/_updates  one user-started measurement and its updates
 *   hume_calibrations       0x88 as OBSERVED at capture time
 *   hume_sync_runs          what a sync transferred, and how it ended
 *   hume_capture_bundles    the upload ledger (idempotency + conflicts)
 *
 * Idempotency: a bundle id + the hash of its payload. The same payload again is
 * a no-op (`duplicate`); a different payload under the same id is kept and
 * flagged (`conflict`). History records are keyed on device + band local time +
 * the record bytes after the index — never the index alone, which is a list
 * position that shifts as the band adds records.
 */

const crypto = require('crypto');
const dec = require('./hume-band-decode');

const PROVENANCE = 'experimental-hume-estimate';
const LABEL = 'Experimental Hume estimate';
const SYNC_STATUSES = new Set(['end-marker', 'no-end-marker', 'interrupted', 'error']);
const LIVE_STATUSES = new Set(['result', 'no-result', 'cancelled', 'interrupted', 'error']);
const MAX_PACKETS = 6000;

function _db() { return require('../db/database'); }

class Refused extends Error {
  constructor(problems) { super(problems.join('; ')); this.problems = problems; this.status = 400; }
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const iso = (v) => (typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
const shortStr = (v, max) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);

/**
 * Validate an upload. REFUSES (every problem named), never repairs: a bundle
 * NEURO half-understood is worse than one the phone keeps and retries after a
 * fix. Returns the normalised bundle.
 */
function validate(body) {
  const p = [];
  const b = body && typeof body === 'object' ? body : {};
  const bundleId = typeof b.bundleId === 'string' && /^[A-Za-z0-9._:-]{8,80}$/.test(b.bundleId) ? b.bundleId : null;
  if (!bundleId) p.push('bundleId must be 8-80 characters of A-Z a-z 0-9 . _ : -');
  const kind = b.kind === 'sync' || b.kind === 'live' ? b.kind : null;
  if (!kind) p.push('kind must be "sync" or "live"');
  const device = b.device && typeof b.device === 'object' ? b.device : {};
  const peripheralId = typeof device.peripheralId === 'string' && /^[0-9A-Fa-f-]{32,36}$/.test(device.peripheralId) ? device.peripheralId.toUpperCase() : null;
  if (!peripheralId) p.push('device.peripheralId must be the iOS peripheral UUID');
  const status = typeof b.status === 'string' ? b.status : null;
  if (kind === 'sync' && !SYNC_STATUSES.has(status)) p.push(`status must be one of ${[...SYNC_STATUSES].join(', ')}`);
  if (kind === 'live' && !LIVE_STATUSES.has(status)) p.push(`status must be one of ${[...LIVE_STATUSES].join(', ')}`);
  if (!Array.isArray(b.packets) || !b.packets.length) p.push('packets must be a non-empty array');
  else if (b.packets.length > MAX_PACKETS) p.push(`at most ${MAX_PACKETS} packets`);
  const packets = [];
  const seen = new Set();
  (Array.isArray(b.packets) ? b.packets.slice(0, MAX_PACKETS) : []).forEach((x, i) => {
    const seq = Number.isInteger(x && x.seq) && x.seq >= 0 ? x.seq : null;
    const dir = x && (x.dir === 'tx' || x.dir === 'rx') ? x.dir : null;
    const hex = x && typeof x.hex === 'string' && /^[0-9a-fA-F]{2,1024}$/.test(x.hex) && x.hex.length % 2 === 0 ? x.hex.toLowerCase() : null;
    if (seq === null || !dir || !hex) { p.push(`packet ${i}: needs seq (integer), dir (tx|rx) and hex`); return; }
    if (seen.has(seq)) { p.push(`packet ${i}: seq ${seq} used twice`); return; }
    seen.add(seq);
    if (x.at !== undefined && x.at !== null && !iso(x.at)) { p.push(`packet ${i}: at must be an ISO instant`); return; }
    packets.push({ seq, dir, hex, at: iso(x.at), context: shortStr(x.context, 32) });
  });
  for (const k of ['startedAt', 'finishedAt']) {
    if (b[k] !== undefined && b[k] !== null && !iso(b[k])) p.push(`${k} must be an ISO instant`);
  }
  const phone = b.phone && typeof b.phone === 'object' ? b.phone : {};
  const tz = shortStr(phone.timeZone, 64);
  const dur = b.liveDurationSeconds;
  if (kind === 'live' && dur !== undefined && !(Number.isInteger(dur) && dur >= 1 && dur <= 600)) p.push('liveDurationSeconds must be 1-600');
  if (p.length) throw new Refused(p);
  packets.sort((a, c) => a.seq - c.seq);
  const client = b.clientDecoded && typeof b.clientDecoded === 'object' ? b.clientDecoded : {};
  return {
    bundleId, kind, status,
    device: { peripheralId, name: shortStr(device.name, 64) },
    phone: { timeZone: tz },
    startedAt: iso(b.startedAt), finishedAt: iso(b.finishedAt),
    error: shortStr(b.error, 500),
    pages: Number.isInteger(b.pages) && b.pages >= 0 && b.pages < 1000 ? b.pages : null,
    stopSent: typeof b.stopSent === 'boolean' ? b.stopSent : null,
    liveDurationSeconds: kind === 'live' && Number.isInteger(dur) ? dur : null,
    clientDecoderVersion: shortStr(b.decoderVersion, 64),
    clientDecoded: {
      records: Number.isInteger(client.records) ? client.records : null,
      finalSystolic: Number.isInteger(client.finalSystolic) ? client.finalSystolic : null,
      finalDiastolic: Number.isInteger(client.finalDiastolic) ? client.finalDiastolic : null,
    },
    packets,
  };
}

/** The hash a bundle is folded on: its normalised content, keys in a fixed order. */
function payloadHash(n) {
  return crypto.createHash('sha256').update(JSON.stringify([
    n.bundleId, n.kind, n.status, n.device, n.phone, n.startedAt, n.finishedAt, n.error, n.pages,
    n.stopSent, n.liveDurationSeconds, n.clientDecoderVersion, n.clientDecoded,
    n.packets.map((x) => [x.seq, x.dir, x.hex, x.at, x.context]),
  ])).digest('hex');
}

const rxOf = (packets, op) => packets.filter((x) => x.dir === 'rx' && x.hex.startsWith(op.toString(16).padStart(2, '0')));

/** Device identity: the band's own BLE address when it gave one, else this phone's peripheral id. */
function _device(db, n, now) {
  const addrPkt = rxOf(n.packets, dec.OP.ADDRESS)[0];
  const address = addrPkt ? dec.decodeAddress(addrPkt.hex) : null;
  const fwPkt = rxOf(n.packets, dec.OP.FIRMWARE)[0];
  const fw = fwPkt ? dec.decodeFirmware(fwPkt.hex) : null;
  let row = address ? db.get('SELECT * FROM hume_devices WHERE band_address = ?', [address]) : null;
  if (!row) row = db.get('SELECT * FROM hume_devices WHERE ios_peripheral_id = ? ORDER BY last_seen_at DESC', [n.device.peripheralId]);
  if (row && address && row.band_address && row.band_address !== address) row = null; // same phone id, different band
  const deviceId = row ? row.device_id : (address ? `addr:${address}` : `ios:${n.device.peripheralId}`);
  if (row) {
    db.run(`UPDATE hume_devices SET band_address = COALESCE(band_address, ?), ios_peripheral_id = ?, name = COALESCE(?, name),
            firmware = COALESCE(?, firmware), firmware_build = COALESCE(?, firmware_build), last_seen_at = ? WHERE device_id = ?`,
    [address, n.device.peripheralId, n.device.name, fw && fw.version, fw && fw.build, now, deviceId]);
  } else {
    db.run(`INSERT INTO hume_devices (device_id, band_address, ios_peripheral_id, name, firmware, firmware_build, first_seen_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [deviceId, address, n.device.peripheralId, n.device.name, fw && fw.version, fw && fw.build, now, now]);
  }
  return { deviceId, address, firmware: fw };
}

function _calibration(db, n, deviceId, now) {
  const out = [];
  for (const pkt of rxOf(n.packets, dec.OP.CALIBRATION)) {
    const c = dec.decodeCalibration(pkt.hex);
    if (!c) continue;
    const observedAt = pkt.at || n.finishedAt || now;
    db.run(`INSERT OR IGNORE INTO hume_calibrations (device_id, observed_at, bundle_id, min_diastolic, max_diastolic, min_systolic, max_systolic, raw_hex, checksum_ok)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [deviceId, observedAt, n.bundleId, c.minDiastolic, c.maxDiastolic, c.minSystolic, c.maxSystolic, c.rawHex, c.checksumOk === null ? null : (c.checksumOk ? 1 : 0)]);
    out.push({ ...c, observedAt });
  }
  return out;
}

function _clock(n) {
  const pkt = rxOf(n.packets, dec.OP.CLOCK).find((x) => x.at);
  if (!pkt) return null;
  const c = dec.decodeClock(pkt.hex);
  if (!c || !c.bandLocal) return null;
  const clock = { bandLocal: c.bandLocal, phoneUtc: pkt.at };
  return { ...clock, ...dec.bandClockOffset(clock) };
}

function _storeHistory(db, n, deviceId, now) {
  const histPackets = n.packets.filter((x) => x.dir === 'rx' && (x.context === 'history' || x.hex.startsWith('56')));
  const d = dec.decodeHistory(histPackets);
  const clock = _clock(n);
  const tz = n.phone.timeZone;
  const counts = { decoded: d.records.length, new: 0, retransmitted: 0, conflicting: 0, malformed: 0 };
  let first = null, last = null, firstUtc = null, lastUtc = null;
  for (const r of d.records) {
    const local = r.deviceLocal || '';
    if (r.malformed) counts.malformed++;
    const t = r.deviceLocal ? dec.interpretTime(r.deviceLocal, { tz, clockOffset: clock }) : { utc: null, method: null, offsetMin: null, tzRulesUtc: null, flags: ['no-local-time'] };
    if (r.deviceLocal) {
      if (!first || r.deviceLocal < first) first = r.deviceLocal;
      if (!last || r.deviceLocal > last) last = r.deviceLocal;
    }
    if (t.utc) {
      if (!firstUtc || t.utc < firstUtc) firstUtc = t.utc;
      if (!lastUtc || t.utc > lastUtc) lastUtc = t.utc;
    }
    const same = db.get('SELECT id FROM hume_history_records WHERE device_id = ? AND device_local = ? AND payload_hex = ?', [deviceId, local, r.payloadHex]);
    if (same) {
      db.run('UPDATE hume_history_records SET sightings = sightings + 1, last_bundle_id = ?, last_seen_at = ? WHERE id = ?', [n.bundleId, now, same.id]);
      counts.retransmitted++;
      continue;
    }
    // A malformed record has no time to collide on; it is its own identity.
    const rival = local ? db.get('SELECT COUNT(*) AS n FROM hume_history_records WHERE device_id = ? AND device_local = ?', [deviceId, local]) : { n: 0 };
    const conflict = rival.n > 0 ? 1 : 0;
    if (conflict) {
      counts.conflicting++;
      db.run('UPDATE hume_history_records SET conflict = 1 WHERE device_id = ? AND device_local = ?', [deviceId, local]);
    } else counts.new++;
    db.run(`INSERT INTO hume_history_records (device_id, device_local, payload_hex, record_index, utc_at, utc_method, utc_offset_min, tz_name, tz_rules_utc, time_flags,
              hrv_field, vascular_aging_field, heart_rate, stress_field, systolic, diastolic, bp_available, raw_hex, flags, malformed, suspect, conflict,
              first_bundle_id, first_packet_seq, first_packet_offset, last_bundle_id, received_at, last_seen_at, decoder_version, origin, provenance)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'historical', ?)`,
    [deviceId, local, r.payloadHex, r.index, t.utc, t.method, t.offsetMin, tz, t.tzRulesUtc, JSON.stringify(t.flags),
      r.hrvField, r.vascularAgingField, r.heartRate, r.stressField, r.systolic, r.diastolic, r.bpAvailable ? 1 : 0, r.rawHex,
      JSON.stringify(r.flags), r.malformed ? 1 : 0, r.suspect ? 1 : 0, conflict,
      n.bundleId, r.packetSeq, r.packetOffset, n.bundleId, now, now, dec.DECODER_VERSION, PROVENANCE]);
  }
  const mismatch = n.clientDecoded.records !== null && n.clientDecoded.records !== d.records.length ? 1 : 0;
  // What the PHONE said happened decides interrupted/error; the end marker is
  // the decoder's own finding and can only downgrade a claimed end-marker.
  const transfer = n.status === 'end-marker' && !d.endMarkerSeen ? 'no-end-marker' : n.status;
  db.run(`INSERT OR IGNORE INTO hume_sync_runs (bundle_id, device_id, started_at, finished_at, transfer_status, error, pages, end_marker_seen,
            records_decoded, records_new, records_retransmitted, records_conflicting, records_malformed, unframed_bytes,
            first_local, last_local, first_utc, last_utc, phone_time_zone, band_clock_local, band_clock_phone_utc, band_offset_min, band_drift_seconds,
            client_records, decode_mismatch, decoder_version, received_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [n.bundleId, deviceId, n.startedAt, n.finishedAt, transfer, n.error, n.pages, d.endMarkerSeen ? 1 : 0,
    counts.decoded, counts.new, counts.retransmitted, counts.conflicting, counts.malformed,
    d.unframed.reduce((s, u) => s + u.hex.length / 2, 0),
    first, last, firstUtc, lastUtc, n.phone.timeZone, clock && clock.bandLocal, clock && clock.phoneUtc,
    clock ? clock.offsetMin : null, clock ? clock.driftSeconds : null, n.clientDecoded.records, mismatch, dec.DECODER_VERSION, now]);
  return { transferStatus: transfer, endMarkerSeen: d.endMarkerSeen, ...counts, unframed: d.unframed.length,
    range: { firstLocal: first, lastLocal: last, firstUtc, lastUtc }, clock, decodeMismatch: !!mismatch,
    // Never "complete history": a band can hold more than one transfer returns.
    coverage: 'what this transfer returned; the band may hold more' };
}

function _storeLive(db, n, deviceId, now) {
  const updates = [];
  for (const pkt of n.packets) {
    if (pkt.dir !== 'rx') continue;
    const u = dec.decodeLiveUpdate(pkt.hex);
    if (!u) continue;
    updates.push({ ...u, seq: pkt.seq, at: pkt.at });
    db.run(`INSERT OR IGNORE INTO hume_live_updates (session_id, seq, at, type, heart_rate, spo2, hrv_field, stress_field, systolic, diastolic, temperature_c, uninterpreted_hex, raw_hex, flags)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [n.bundleId, pkt.seq, pkt.at, u.type, u.heartRate, u.spo2, u.hrvField, u.stressField, u.systolic, u.diastolic, u.temperatureC, u.uninterpretedHex, u.rawHex, JSON.stringify(u.flags)]);
  }
  const final = dec.finalOfSession(updates);
  const mismatch = (n.status === 'result' && !final) || (n.status === 'no-result' && !!final) ? 1 : 0;
  db.run(`INSERT OR IGNORE INTO hume_live_sessions (session_id, device_id, started_at, finished_at, status, error, duration_requested, update_count,
            final_packet_seq, final_at, final_systolic, final_diastolic, final_heart_rate, final_hrv_field, final_stress_field, final_flags, stop_sent,
            status_mismatch, decoder_version, origin, provenance, received_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?)`,
  [n.bundleId, deviceId, n.startedAt, n.finishedAt, n.status, n.error, n.liveDurationSeconds, updates.length,
    final && final.seq, final && final.at, final && final.systolic, final && final.diastolic, final && final.heartRate,
    final && final.hrvField, final && final.stressField, final ? JSON.stringify(final.flags) : null,
    n.stopSent === null ? null : (n.stopSent ? 1 : 0), mismatch, dec.DECODER_VERSION, PROVENANCE, now]);
  return { status: n.status, updates: updates.length, statusMismatch: !!mismatch,
    final: final ? { systolic: final.systolic, diastolic: final.diastolic, heartRate: final.heartRate, at: final.at, label: LABEL, flags: final.flags } : null };
}

/**
 * Store one capture bundle. Synchronous from the ledger read to the last
 * write (one transaction), so two deliveries of one bundle cannot interleave.
 */
function ingest(body, { client = null, now = new Date() } = {}) {
  const n = validate(body);
  const hash = payloadHash(n);
  const stamp = now.toISOString();
  const db = _db();
  return db.batchSaves(() => {
    const prior = db.all('SELECT payload_hash, device_id, meta_json FROM hume_capture_bundles WHERE bundle_id = ?', [n.bundleId]);
    const same = prior.find((r) => r.payload_hash === hash);
    if (same) {
      db.run('UPDATE hume_capture_bundles SET upload_count = upload_count + 1 WHERE bundle_id = ? AND payload_hash = ?', [n.bundleId, hash]);
      return { ok: true, duplicate: true, conflict: prior.length > 1, bundleId: n.bundleId, kind: n.kind, deviceId: same.device_id,
        summary: same.meta_json ? JSON.parse(same.meta_json) : null };
    }
    const conflict = prior.length > 0;
    if (conflict) db.run('UPDATE hume_capture_bundles SET conflict = 1 WHERE bundle_id = ?', [n.bundleId]);
    const dev = _device(db, n, stamp);
    for (const x of n.packets) {
      db.run('INSERT OR IGNORE INTO hume_packets (bundle_id, seq, direction, context, at, opcode, hex) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [n.bundleId, x.seq, x.dir, x.context, x.at, parseInt(x.hex.slice(0, 2), 16), x.hex]);
    }
    const calibration = _calibration(db, n, dev.deviceId, stamp);
    const summary = n.kind === 'sync' ? _storeHistory(db, n, dev.deviceId, stamp) : _storeLive(db, n, dev.deviceId, stamp);
    summary.calibration = calibration.map(({ minDiastolic, maxDiastolic, minSystolic, maxSystolic, observedAt }) =>
      ({ minDiastolic, maxDiastolic, minSystolic, maxSystolic, observedAt }));
    summary.firmware = dev.firmware ? { version: dev.firmware.version, build: dev.firmware.build } : null;
    db.run(`INSERT INTO hume_capture_bundles (bundle_id, payload_hash, kind, device_id, client, client_decoder_version, received_at, conflict, meta_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [n.bundleId, hash, n.kind, dev.deviceId, client, n.clientDecoderVersion, stamp, conflict ? 1 : 0, JSON.stringify(summary)]);
    return { ok: true, duplicate: false, conflict, bundleId: n.bundleId, kind: n.kind, deviceId: dev.deviceId,
      decoderVersion: dec.DECODER_VERSION, summary };
  });
}

// ── reads ───────────────────────────────────────────────────────────────────

const parseJson = (s) => { try { return s ? JSON.parse(s) : []; } catch { return []; } };

function _historyRow(r) {
  return {
    id: r.id, deviceId: r.device_id, origin: 'historical', provenance: r.provenance, label: LABEL,
    deviceLocal: r.device_local || null, utc: r.utc_at, utcMethod: r.utc_method, utcOffsetMin: r.utc_offset_min,
    tzName: r.tz_name, tzRulesUtc: r.tz_rules_utc, timeFlags: parseJson(r.time_flags),
    recordIndex: r.record_index,
    fields: { hrv: r.hrv_field, vascularAging: r.vascular_aging_field, heartRate: r.heart_rate, stress: r.stress_field },
    bp: r.bp_available ? { systolic: r.systolic, diastolic: r.diastolic } : null,
    flags: parseJson(r.flags), malformed: !!r.malformed, suspect: !!r.suspect, conflict: !!r.conflict,
    sightings: r.sightings, rawHex: r.raw_hex, source: { bundleId: r.first_bundle_id, packetSeq: r.first_packet_seq, offset: r.first_packet_offset },
    receivedAt: r.received_at, decoderVersion: r.decoder_version,
  };
}

function records({ deviceId, from, to, limit = 200 } = {}) {
  const lim = Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= 1000 ? Number(limit) : null;
  if (lim === null) throw new Refused(['limit must be 1-1000']);
  const where = [];
  const args = [];
  if (deviceId) { where.push('device_id = ?'); args.push(deviceId); }
  if (from) { if (!iso(from)) throw new Refused(['from must be an ISO instant']); where.push('utc_at >= ?'); args.push(iso(from)); }
  if (to) { if (!iso(to)) throw new Refused(['to must be an ISO instant']); where.push('utc_at <= ?'); args.push(iso(to)); }
  const sql = `SELECT * FROM hume_history_records ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY utc_at DESC, id DESC LIMIT ?`;
  return { label: LABEL, provenance: PROVENANCE, records: _db().all(sql, [...args, lim]).map(_historyRow) };
}

function runs({ limit = 20 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
  return { runs: _db().all('SELECT * FROM hume_sync_runs ORDER BY received_at DESC LIMIT ?', [lim]) };
}

function liveSessions({ limit = 20, withUpdates = false } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
  const db = _db();
  const sessions = db.all('SELECT * FROM hume_live_sessions ORDER BY COALESCE(started_at, received_at) DESC LIMIT ?', [lim]).map((s) => ({
    ...s, label: LABEL,
    final: s.final_systolic ? { systolic: s.final_systolic, diastolic: s.final_diastolic, heartRate: s.final_heart_rate, at: s.final_at } : null,
    updates: withUpdates ? db.all('SELECT * FROM hume_live_updates WHERE session_id = ? ORDER BY seq', [s.session_id]) : undefined,
  }));
  return { label: LABEL, sessions };
}

function calibrations({ limit = 20 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
  return {
    note: 'Calibration as READ from the band at capture time. It is not asserted to have applied to readings made before it was read.',
    calibrations: _db().all('SELECT * FROM hume_calibrations ORDER BY observed_at DESC LIMIT ?', [lim]),
  };
}

function bundlePackets(bundleId) {
  const rows = _db().all('SELECT seq, direction, context, at, hex FROM hume_packets WHERE bundle_id = ? ORDER BY seq, id', [bundleId]);
  return { bundleId, packets: rows };
}

/** The one-screen read: what NEURO holds, how fresh it is, and what is uncertain. */
function status() {
  const db = _db();
  const devices = db.all('SELECT * FROM hume_devices ORDER BY last_seen_at DESC');
  const lastRun = db.get('SELECT * FROM hume_sync_runs ORDER BY received_at DESC LIMIT 1');
  const totals = db.get(`SELECT COUNT(*) AS records, SUM(bp_available) AS withBp, SUM(conflict) AS conflicting,
                         SUM(malformed) AS malformed, SUM(suspect) AS suspect, MIN(utc_at) AS firstUtc, MAX(utc_at) AS lastUtc
                         FROM hume_history_records`);
  const latestHist = db.get('SELECT * FROM hume_history_records WHERE bp_available = 1 AND utc_at IS NOT NULL ORDER BY utc_at DESC LIMIT 1');
  const latestLive = db.get('SELECT * FROM hume_live_sessions WHERE final_systolic IS NOT NULL ORDER BY COALESCE(final_at, finished_at) DESC LIMIT 1');
  const cands = [];
  if (latestHist) cands.push({ origin: 'historical', at: latestHist.utc_at, systolic: latestHist.systolic, diastolic: latestHist.diastolic, heartRate: latestHist.heart_rate, timeMethod: latestHist.utc_method });
  if (latestLive) cands.push({ origin: 'live', at: latestLive.final_at || latestLive.finished_at, systolic: latestLive.final_systolic, diastolic: latestLive.final_diastolic, heartRate: latestLive.final_heart_rate, timeMethod: 'phone-clock' });
  cands.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const cal = db.get('SELECT * FROM hume_calibrations ORDER BY observed_at DESC LIMIT 1');
  const bundles = db.get('SELECT COUNT(DISTINCT bundle_id) AS n, SUM(conflict) AS conflicts FROM hume_capture_bundles');
  return {
    label: LABEL, provenance: PROVENANCE,
    note: 'Hume BP values are the band\'s own experimental estimates. They are kept apart from HiLo and cuff readings and are not used for any summary or alert.',
    devices, lastSync: lastRun || null,
    totals: { records: totals.records || 0, withBp: totals.withBp || 0, conflicting: totals.conflicting || 0, malformed: totals.malformed || 0, suspect: totals.suspect || 0 },
    range: { firstUtc: totals.firstUtc, lastUtc: totals.lastUtc },
    latestBp: cands[0] ? { ...cands[0], label: LABEL } : null,
    calibration: cal ? { minDiastolic: cal.min_diastolic, maxDiastolic: cal.max_diastolic, minSystolic: cal.min_systolic, maxSystolic: cal.max_systolic, observedAt: cal.observed_at } : null,
    bundles: { count: bundles.n || 0, conflicting: bundles.conflicts || 0 },
  };
}

module.exports = { PROVENANCE, LABEL, Refused, validate, payloadHash, ingest, records, runs, liveSessions, calibrations, bundlePackets, status };
