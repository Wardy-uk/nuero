'use strict';

/**
 * Hume Band V1 decoder + store.
 *
 * Two kinds of fixture, never mixed up:
 *  - SYNTHETIC frames built by `rec()`/`live()` below. They follow the
 *    documented layout and exist to pin edge cases the captures never showed
 *    (split records, bad BCD, DST, conflicts). They are not captured data.
 *  - REAL packets from the Windows/bleak captures, kept ONLY in the private
 *    nuero-ios repo (this repo is public and they are Nick's readings). Read
 *    from HUME_FIXTURES or the sibling checkout; the test SAYS it skipped when
 *    neither is present, rather than passing quietly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-hume-')), 'a.db');

const dec = require('./hume-band-decode');
const db = require('../db/database');
const hume = require('./hume-band');

const FIXTURE = process.env.HUME_FIXTURES
  || path.join(__dirname, '..', '..', '..', 'nuero-ios', 'NeuroKit', 'Tests', 'NeuroKitTests', 'Fixtures', 'hume-v1-captures.json');

// ── SYNTHETIC frame builders ────────────────────────────────────────────────
const toBcd = (n) => ((Math.floor(n / 10) << 4) | (n % 10));
const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
function rec({ index = 0, at = '2026-10-22T09:17:13', hrv = 58, va = 10, hr = 80, stress = 10, sys = 116, dia = 66 } = {}) {
  const [d, t] = at.split('T');
  const [y, mo, dd] = d.split('-').map(Number);
  const [h, mi, s] = t.split(':').map(Number);
  return [0x56, index & 0xff, index >> 8, toBcd(y - 2000), toBcd(mo), toBcd(dd), toBcd(h), toBcd(mi), toBcd(s), hrv, va, hr, stress, sys, dia];
}
function frame(bytes) {
  const b = [...bytes, ...new Array(15 - bytes.length).fill(0)];
  b.push(dec.checksum(b));
  return b;
}
const live = (hr, sys, dia, extra = {}) => frame([0x28, 1, hr, 0, extra.hrv || 0, extra.stress || 0, sys, dia, 0x69, 0x01, 0x3d, 0x01]);
const pk = (seq, bytes, dir = 'rx', context = 'history', at) => ({ seq, dir, hex: hex(bytes), context, ...(at ? { at } : {}) });

// ── pure: frames, BCD, framing ──────────────────────────────────────────────

test('command checksum is sum(bytes 0-14) & 0xff (documented 0x28 start frame)', () => {
  const start = frame([0x28, 1, 1, 0, 120, 0]);
  assert.equal(hex(start), '280101007800000000000000000000a2');
  assert.equal(dec.checksumOk(start), true);
  const bad = [...start]; bad[15] ^= 1;
  assert.equal(dec.checksumOk(bad), false);
});

test('BCD validation refuses non-BCD nibbles, impossible days and hours', () => {
  assert.equal(dec.bcdLocal([0x26, 0x10, 0x22, 0x09, 0x17, 0x13]).local, '2026-10-22T09:17:13');
  assert.equal(dec.bcdLocal([0x26, 0x1a, 0x22, 0x09, 0x17, 0x13]).why, 'not-bcd');
  assert.equal(dec.bcdLocal([0x26, 0x02, 0x31, 0x09, 0x17, 0x13]).why, 'no-such-day');
  assert.equal(dec.bcdLocal([0x26, 0x10, 0x22, 0x24, 0x00, 0x00]).why, 'out-of-range');
});

test('several records per notification, end marker appended to the last one', () => {
  const p1 = [...rec({ index: 0 }), ...rec({ index: 1, at: '2026-10-22T09:15:11' })];
  const p2 = [...rec({ index: 2, at: '2026-10-22T09:13:03' }), 0x56, 0xff];
  const d = dec.decodeHistory([pk(1, p1), pk(2, p2)]);
  assert.equal(d.records.length, 3);
  assert.equal(d.endMarkerSeen, true);
  assert.deepEqual(d.records.map((r) => r.index), [0, 1, 2]);
  assert.equal(d.records[2].packetSeq, 2);
  assert.equal(d.unframed.length, 0);
});

test('a standalone end-marker packet ends the transfer; no marker = not ended', () => {
  assert.equal(dec.decodeHistory([pk(1, rec()), pk(2, [0x56, 0xff])]).endMarkerSeen, true);
  assert.equal(dec.decodeHistory([pk(1, rec())]).endMarkerSeen, false);
});

test('a record split across two notifications is still one record', () => {
  const r = rec({ index: 7 });
  const d = dec.decodeHistory([pk(1, r.slice(0, 9)), pk(2, [...r.slice(9), 0x56, 0xff])]);
  assert.equal(d.records.length, 1);
  assert.equal(d.records[0].systolic, 116);
  assert.equal(d.endMarkerSeen, true);
});

test('an index whose low byte is 0xFF is a record, not an end marker', () => {
  const d = dec.decodeHistory([pk(1, [...rec({ index: 0xff }), ...rec({ index: 0x100, at: '2026-10-22T09:00:00' })])]);
  assert.equal(d.records.length, 2);
  assert.equal(d.records[0].index, 255);
  assert.equal(d.endMarkerSeen, false);
});

test('unsolicited non-history frames are ignored; misaligned bytes are reported, never silently dropped', () => {
  const junk = [0x56, 0x99, 0x99];
  const d = dec.decodeHistory([pk(1, frame([0x16, 1, 2])), pk(2, [...junk, ...rec({ index: 3 }), 0x56, 0xff])]);
  assert.equal(d.records.length, 1);
  assert.equal(d.records[0].index, 3);
  assert.equal(d.unframed.length, 1);
  assert.equal(d.unframed[0].hex, '569999');
});

test('zero BP is "no result", kept raw; out-of-range values are flagged, never clamped', () => {
  const zero = dec.decodeHistoryRecord(rec({ sys: 0, dia: 0 }));
  assert.equal(zero.bpAvailable, false);
  assert.equal(zero.systolic, null);
  assert.equal(zero.rawSystolic, 0);
  const half = dec.decodeHistoryRecord(rec({ sys: 120, dia: 0 }));
  assert.equal(half.bpAvailable, false);
  assert.ok(half.flags.includes('bp-half-zero'));
  const odd = dec.decodeHistoryRecord(rec({ sys: 255, dia: 200, hr: 0 }));
  assert.equal(odd.systolic, 255, 'the number stored is the number sent');
  assert.equal(odd.diastolic, 200);
  assert.ok(odd.flags.includes('bp-outside-plausible-range'));
  assert.ok(odd.flags.includes('hr-zero'));
  assert.equal(odd.suspect, true);
  const bad = dec.decodeHistoryRecord([...rec().slice(0, 4), 0x1a, ...rec().slice(5)]);
  assert.equal(bad.malformed, true);
  assert.equal(bad.deviceLocal, null);
});

test('live: repeated updates are one session; the final BP is the LAST populated pair', () => {
  const ups = [
    { ...dec.decodeLiveUpdate(hex(live(81, 0, 0))), seq: 1 },
    { ...dec.decodeLiveUpdate(hex(live(80, 118, 70))), seq: 2 },
    { ...dec.decodeLiveUpdate(hex(live(0, 0, 0))), seq: 3 },
    { ...dec.decodeLiveUpdate(hex(live(76, 125, 73))), seq: 4 },
    { ...dec.decodeLiveUpdate(hex(live(77, 0, 0))), seq: 5 },
  ];
  const f = dec.finalOfSession(ups);
  assert.equal(f.seq, 4);
  assert.deepEqual([f.systolic, f.diastolic], [125, 73]);
  assert.equal(ups[0].temperatureC, 36.1);
  assert.equal(ups[0].uninterpretedHex, '3d01000000');
  assert.ok(ups[2].flags.includes('hr-zero'));
  assert.equal(dec.finalOfSession(ups.filter((u) => !u.bpAvailable)), null, 'zero BP everywhere = no result');
  const corrupt = live(80, 120, 70); corrupt[15] ^= 0xff;
  assert.ok(dec.decodeLiveUpdate(hex(corrupt)).flags.includes('checksum-mismatch'));
});

// ── time ────────────────────────────────────────────────────────────────────

test('band clock offset: rounded to 15 minutes, the residue is drift', () => {
  assert.deepEqual(dec.bandClockOffset({ bandLocal: '2026-10-22T09:28:55', phoneUtc: '2026-10-22T08:28:50.121Z' }), { offsetMin: 60, driftSeconds: 5 });
});

test('timezone: band offset preferred and flagged as assumed; tz rules kept; DST hours named', () => {
  const summer = dec.interpretTime('2026-10-22T09:17:13', { tz: 'Europe/London', clockOffset: { offsetMin: 60, driftSeconds: 5 } });
  assert.equal(summer.utc, '2026-10-22T08:17:13.000Z');
  assert.equal(summer.method, 'band-clock-offset');
  assert.ok(summer.flags.includes('offset-assumed-constant-since-band-clock-set'));
  // After the clocks go back a band still on BST disagrees with the tz rules: both kept, flagged.
  const winter = dec.interpretTime('2026-11-02T09:00:00', { tz: 'Europe/London', clockOffset: { offsetMin: 60, driftSeconds: 0 } });
  assert.equal(winter.utc, '2026-11-02T08:00:00.000Z');
  assert.equal(winter.tzRulesUtc, '2026-11-02T09:00:00.000Z');
  assert.ok(winter.flags.includes('tz-rules-disagree'));
  const repeated = dec.interpretTime('2026-10-25T01:30:00', { tz: 'Europe/London' });
  assert.ok(repeated.flags.includes('dst-repeated-hour'));
  assert.equal(repeated.method, 'phone-tz-rules');
  const skipped = dec.interpretTime('2026-03-29T01:30:00', { tz: 'Europe/London' });
  assert.equal(skipped.utc, null);
  assert.ok(skipped.flags.includes('dst-nonexistent-local-time'));
  const drift = dec.interpretTime('2026-10-22T09:00:00', { tz: 'Europe/London', clockOffset: { offsetMin: 60, driftSeconds: 400 } });
  assert.ok(drift.flags.includes('band-clock-drift'));
});

// ── store (real SQLite) ─────────────────────────────────────────────────────

const PERIPHERAL = '6F1C2D3E-4A5B-4C6D-8E9F-0123456789AB';
const ADDR = [0x22, 0x09, 0x04, 0x02, 0x18, 0xbf, 0xcb];
function syncBundle(id, recs, { extra = [], status = 'end-marker', clientRecords } = {}) {
  let seq = 0;
  const packets = [
    pk(seq++, frame([0x22]), 'tx', 'address'), pk(seq++, frame(ADDR), 'rx', 'address', '2026-10-22T08:28:40Z'),
    pk(seq++, frame([0x41]), 'tx', 'clock'), pk(seq++, frame([0x41, 0x26, 0x10, 0x22, 0x09, 0x28, 0x55]), 'rx', 'clock', '2026-10-22T08:28:50Z'),
    pk(seq++, frame([0x88]), 'tx', 'calibration'), pk(seq++, frame([0x88, 60, 80, 110, 130]), 'rx', 'calibration', '2026-10-22T08:29:09Z'),
    pk(seq++, frame([0x56]), 'tx', 'history'),
    pk(seq++, [...recs.flat(), 0x56, 0xff], 'rx', 'history', '2026-10-22T08:29:26Z'),
    ...extra.map((e) => ({ ...e, seq: seq++ })),
  ];
  return { bundleId: id, kind: 'sync', status, device: { peripheralId: PERIPHERAL, name: 'Hume Band BFCB' },
    phone: { timeZone: 'Europe/London' }, startedAt: '2026-10-22T08:28:39Z', finishedAt: '2026-10-22T08:29:30Z',
    decoderVersion: 'ios-hume-v1@1', clientDecoded: { records: clientRecords ?? recs.length }, packets };
}

test.before(async () => { await db.init(); });

test('a sync stores records, calibration, device and run; re-uploading the same bundle writes nothing', () => {
  const b = syncBundle('sync-aaaa-0001', [rec({ index: 0 }), rec({ index: 1, at: '2026-10-22T09:15:11', sys: 0, dia: 0 })]);
  const r1 = hume.ingest(b);
  assert.equal(r1.duplicate, false);
  assert.equal(r1.deviceId, 'addr:09:04:02:18:BF:CB');
  assert.equal(r1.summary.new, 2);
  assert.equal(r1.summary.transferStatus, 'end-marker');
  assert.match(r1.summary.coverage, /may hold more/);
  assert.deepEqual(r1.summary.calibration[0], { minDiastolic: 60, maxDiastolic: 80, minSystolic: 110, maxSystolic: 130, observedAt: '2026-10-22T08:29:09.000Z' });
  const before = db.get('SELECT COUNT(*) AS n FROM hume_history_records').n;
  const packetsBefore = db.get('SELECT COUNT(*) AS n FROM hume_packets').n;
  const r2 = hume.ingest(b);
  assert.equal(r2.duplicate, true);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM hume_history_records').n, before);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM hume_packets').n, packetsBefore);
  assert.equal(db.get("SELECT upload_count FROM hume_capture_bundles WHERE bundle_id = 'sync-aaaa-0001'").upload_count, 2);
  const row = db.get("SELECT * FROM hume_history_records WHERE device_local = '2026-10-22T09:15:11'");
  assert.equal(row.systolic, null);
  assert.equal(row.bp_available, 0);
  assert.equal(row.utc_at, '2026-10-22T08:15:11.000Z');
  assert.equal(row.provenance, 'experimental-hume-estimate');
});

test('a later sync re-sending the same records under NEW indices folds them as retransmissions', () => {
  const b = syncBundle('sync-aaaa-0002', [rec({ index: 0, at: '2026-10-22T09:19:00' }), rec({ index: 1 }), rec({ index: 2, at: '2026-10-22T09:15:11', sys: 0, dia: 0 })]);
  const r = hume.ingest(b);
  assert.equal(r.summary.new, 1);
  assert.equal(r.summary.retransmitted, 2);
  const row = db.get("SELECT sightings, record_index FROM hume_history_records WHERE device_local = '2026-10-22T09:17:13'");
  assert.equal(row.sightings, 2);
  assert.equal(row.record_index, 0, 'the first index seen is kept; the index is not identity');
});

test('the same local time with DIFFERENT values is a conflict: both kept, both flagged', () => {
  const r = hume.ingest(syncBundle('sync-aaaa-0003', [rec({ index: 5, sys: 140, dia: 90 })]));
  assert.equal(r.summary.conflicting, 1);
  const rows = db.all("SELECT systolic, conflict FROM hume_history_records WHERE device_local = '2026-10-22T09:17:13' ORDER BY id");
  assert.deepEqual(rows.map((x) => [x.systolic, x.conflict]), [[116, 1], [140, 1]]);
});

test('a different payload under an already-used bundle id is kept beside the first, flagged', () => {
  const b = syncBundle('sync-aaaa-0001', [rec({ index: 0, at: '2026-10-22T10:00:00' })]);
  const r = hume.ingest(b);
  assert.equal(r.conflict, true);
  assert.equal(db.all("SELECT * FROM hume_capture_bundles WHERE bundle_id = 'sync-aaaa-0001'").length, 2);
  assert.ok(db.all("SELECT conflict FROM hume_capture_bundles WHERE bundle_id = 'sync-aaaa-0001'").every((x) => x.conflict === 1));
});

test('a phone-claimed end-marker that the bytes do not show is downgraded; a decode count disagreement is flagged', () => {
  const b = syncBundle('sync-aaaa-0004', [rec({ index: 0, at: '2026-10-22T11:00:00' })], { clientRecords: 9 });
  b.packets[b.packets.length - 1].hex = hex(rec({ index: 0, at: '2026-10-22T11:00:00' })); // no 56 FF
  const r = hume.ingest(b);
  assert.equal(r.summary.transferStatus, 'no-end-marker');
  assert.equal(r.summary.decodeMismatch, true);
});

test('validation refuses (every problem named), never repairs', () => {
  assert.throws(() => hume.ingest({ bundleId: 'x', kind: 'nope', packets: [] }), (e) => {
    assert.ok(e instanceof hume.Refused);
    assert.ok(e.problems.length >= 3);
    return true;
  });
  const b = syncBundle('sync-aaaa-0005', [rec()]);
  b.packets[1].seq = b.packets[0].seq;
  assert.throws(() => hume.ingest(b), /used twice/);
});

test('a live session stores every update and ONE final BP; status disagreeing with the bytes is flagged', () => {
  const packets = [
    pk(0, frame([0x88]), 'tx', 'calibration'), pk(1, frame([0x88, 60, 80, 110, 130]), 'rx', 'calibration', '2026-10-22T09:00:00Z'),
    pk(2, frame([0x28, 1, 1, 0, 120, 0]), 'tx', 'live'),
    pk(3, live(81, 0, 0), 'rx', 'live', '2026-10-22T09:00:05Z'),
    pk(4, live(80, 0, 0), 'rx', 'live', '2026-10-22T09:00:06Z'),
    pk(5, live(76, 125, 73, { hrv: 33, stress: 46 }), 'rx', 'live', '2026-10-22T09:01:30Z'),
    pk(6, frame([0x28, 1, 0]), 'tx', 'live-stop'),
  ];
  const base = { kind: 'live', device: { peripheralId: PERIPHERAL }, phone: { timeZone: 'Europe/London' }, liveDurationSeconds: 120, stopSent: true };
  const r = hume.ingest({ ...base, bundleId: 'live-bbbb-0001', status: 'result', packets });
  assert.equal(r.summary.updates, 3);
  assert.deepEqual([r.summary.final.systolic, r.summary.final.diastolic], [125, 73]);
  assert.equal(r.summary.final.label, 'Experimental Hume estimate');
  assert.equal(r.summary.statusMismatch, false);
  const none = hume.ingest({ ...base, bundleId: 'live-bbbb-0002', status: 'result', packets: packets.slice(0, 5) });
  assert.equal(none.summary.final, null);
  assert.equal(none.summary.statusMismatch, true);
  const s = hume.status();
  // The latest BP is the latest by TIME across both origins: a history record
  // at 11:00 band time (10:00Z) is newer than this 09:01:30Z live result.
  assert.equal(s.latestBp.origin, 'historical');
  assert.equal(s.latestBp.at, '2026-10-22T10:00:00.000Z');
  assert.equal(s.latestBp.label, 'Experimental Hume estimate');
  const sessions = hume.liveSessions({ withUpdates: true }).sessions;
  const one = sessions.find((x) => x.session_id === 'live-bbbb-0001');
  assert.deepEqual([one.final.systolic, one.final.diastolic, one.updates.length], [125, 73, 3]);
});

test('reads refuse junk rather than clamp', () => {
  assert.throws(() => hume.records({ limit: 5000 }), hume.Refused);
  assert.throws(() => hume.records({ from: 'yesterday' }), hume.Refused);
  assert.ok(hume.records({ limit: 10 }).records.every((r) => r.label === 'Experimental Hume estimate'));
});

// ── calibration experiment bundles (from the phone) ──────────────────────────

function calBundle(id, status, { activatedAt = null, target = { minDiastolic: 72, maxDiastolic: 92, minSystolic: 119, maxSystolic: 139 } } = {}) {
  return {
    bundleId: `calibration-${id}`, kind: 'calibration', status,
    device: { peripheralId: PERIPHERAL, name: 'Hume Band BFCB' }, phone: { timeZone: 'Europe/London' },
    packets: [
      pk(0, frame([0x22]), 'tx', 'address'), pk(1, frame(ADDR), 'rx', 'address', '2026-10-24T13:00:00Z'),
      pk(2, frame([0x88]), 'tx', 'calibration'), pk(3, frame([0x88, 60, 80, 110, 130]), 'rx', 'calibration', '2026-10-24T13:00:01Z'),
      pk(4, frame([0x87, 72, 92, 119, 139]), 'tx', 'set-calibration'),
      pk(5, frame([0x88]), 'tx', 'calibration'), pk(6, frame([0x88, 72, 92, 119, 139]), 'rx', 'calibration', '2026-10-24T13:00:03Z'),
    ],
    calibration: {
      id: `cal-${id}`, status, original: { minDiastolic: 60, maxDiastolic: 80, minSystolic: 110, maxSystolic: 130 }, target,
      references: [{ systolic: 127, diastolic: 81, takenAt: '2026-10-24T12:55:00Z', source: 'typed' },
        { systolic: 130, diastolic: 82, takenAt: '2026-10-24T12:41:00Z', source: 'neuro', importedAt: '2026-10-24T12:50:00Z' }],
      proposal: { meanSystolic: 128.5, meanDiastolic: 81.5, centreSystolic: 129, centreDiastolic: 82 },
      activatedAt, activatedLocal: activatedAt ? '2026-10-24T14:00:03+01:00' : null, phoneTimeZone: 'Europe/London',
      history: [{ utc: '2026-10-24T13:00:01Z', status: 'original-saved', note: 'original saved before any write' }],
    },
  };
}

test('calibration bundles: the experiment record is kept; latest per experiment says active; readbacks become observations', () => {
  const r = hume.ingest(calBundle('aaaaaaaa-0001', 'active', { activatedAt: '2026-10-24T13:00:03Z' }));
  assert.equal(r.summary.status, 'active');
  assert.equal(hume.ingest(calBundle('aaaaaaaa-0001', 'active', { activatedAt: '2026-10-24T13:00:03Z' })).duplicate, true);
  let x = hume.calibrationExperiments();
  assert.equal(x.active.experimentId, 'cal-aaaaaaaa-0001');
  assert.equal(x.active.references.length, 2);
  assert.equal(x.active.activatedAt, '2026-10-24T13:00:03.000Z');
  const obs = db.all("SELECT min_systolic FROM hume_calibrations WHERE bundle_id = 'calibration-aaaaaaaa-0001' ORDER BY observed_at");
  assert.deepEqual(obs.map((o) => o.min_systolic), [110, 119], 'the original and the readback are both observations');
  // Ending it later: a second bundle for the SAME experiment.
  const end = calBundle('aaaaaaaa-0002', 'restored-verified', { activatedAt: '2026-10-24T13:00:03Z' });
  end.calibration.id = 'cal-aaaaaaaa-0001';
  hume.ingest(end, { now: new Date(Date.now() + 60000) });
  x = hume.calibrationExperiments();
  assert.equal(x.active, null, 'the newer record of the same experiment ended it');
  assert.equal(x.experiments[0].status, 'restored-verified');
});

test('calibration bundles refuse a bad record, never repair it', () => {
  const bad = calBundle('aaaaaaaa-0003', 'active');
  bad.calibration.target = { minDiastolic: 92, maxDiastolic: 72, minSystolic: 119, maxSystolic: 139 };
  bad.calibration.references = [];
  bad.calibration.status = 'not-applied';
  assert.throws(() => hume.ingest(bad), (e) => {
    assert.ok(e.problems.some((p) => /target bounds are not in order/.test(p)));
    assert.ok(e.problems.some((p) => /references must hold/.test(p)));
    assert.ok(e.problems.some((p) => /must equal the bundle status/.test(p)));
    return true;
  });
  const recovery = hume.ingest(calBundle('aaaaaaaa-0004', 'restore-unconfirmed'));
  assert.equal(recovery.ok, true);
  assert.equal(hume.calibrationExperiments().needsRecovery[0].experimentId, 'cal-aaaaaaaa-0004');
});

// ── isolation: Hume data never reaches trusted BP ───────────────────────────

test('only hume-band.js touches the hume_* tables, and it never writes trusted BP stores', () => {
  const root = path.join(__dirname, '..');
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) {
        const src = fs.readFileSync(p, 'utf8');
        if (/hume_(history_records|live_sessions|live_updates|calibrations|calibration_events|sync_runs|packets|devices|capture_bundles)/.test(src)
            && path.basename(p) !== 'hume-band.js'
            // db/database.js holds the one schema migration (the calibration-kind rebuild), nothing else.
            && path.relative(root, p).replace(/\\/g, '/') !== 'db/database.js') offenders.push(path.relative(root, p));
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
  const own = fs.readFileSync(path.join(__dirname, 'hume-band.js'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  for (const banned of ['health_samples', 'health_daily', 'hilo_readings', 'insertHealthSample', 'webpush', 'sendToAll']) {
    assert.ok(!own.includes(banned), `hume-band.js must not reference ${banned}`);
  }
  // Positive control: the scan really reads the file.
  assert.ok(own.includes('hume_history_records'));
});

// ── REAL captures (private fixture) ─────────────────────────────────────────

test('real captures: 204 records, end marker, calibration 60/80/110/130, firmware, live final 125/73', (t) => {
  if (!fs.existsSync(FIXTURE)) { t.skip(`real capture fixture not present (${FIXTURE}) — set HUME_FIXTURES`); return; }
  const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const oct22 = fx.captures.find((c) => c.source.startsWith('hume-capture-20261022-092824'));
  const p22 = oct22.packets.map((p, i) => ({ ...p, seq: i }));
  const h = dec.decodeHistory(p22.filter((p) => p.dir === 'rx' && p.context === 'hrv_fields'));
  assert.equal(h.records.length, 204);
  assert.equal(h.endMarkerSeen, true);
  assert.equal(h.unframed.length, 0);
  assert.equal(h.records[0].deviceLocal, '2026-10-22T09:17:13');
  assert.deepEqual([h.records[0].hrvField, h.records[0].vascularAgingField, h.records[0].heartRate, h.records[0].stressField, h.records[0].systolic, h.records[0].diastolic], [58, 10, 80, 10, 116, 66]);
  assert.equal(h.records.at(-1).deviceLocal, '2026-10-22T00:28:44', '204 records span only part of one day');
  assert.ok(h.records.every((r, i) => r.index === i));
  const rx = (ctx) => p22.find((p) => p.dir === 'rx' && p.context === ctx);
  assert.deepEqual(dec.decodeCalibration(rx('bp_parameters').hex).checksumOk, true);
  assert.equal(dec.decodeCalibration(rx('bp_parameters').hex).maxSystolic, 130);
  assert.deepEqual(dec.decodeFirmware(rx('firmware').hex), { version: '0.0.5.2', build: '2025-05-27', rawHex: rx('firmware').hex });
  assert.equal(dec.decodeAddress(rx('address').hex), '09:04:02:18:BF:CB');
  const clock = { bandLocal: dec.decodeClock(rx('clock').hex).bandLocal, phoneUtc: rx('clock').utc };
  assert.deepEqual(dec.bandClockOffset(clock), { offsetMin: 60, driftSeconds: 5 });

  const oct21 = fx.captures.find((c) => c.source.startsWith('hume-capture-20261021-161541'));
  const ups = oct21.packets.map((p, i) => ({ ...p, seq: i })).filter((p) => p.dir === 'rx' && p.context === 'hrv_explicit_duration_120')
    .map((p) => ({ ...dec.decodeLiveUpdate(p.hex), seq: p.seq }));
  assert.equal(ups.length, 86);
  assert.ok(ups.every((u) => !u.flags.includes('checksum-mismatch')));
  const f = dec.finalOfSession(ups);
  assert.deepEqual([f.heartRate, f.hrvField, f.stressField, f.systolic, f.diastolic], [76, 33, 46, 125, 73]);
  assert.equal(ups.filter((u) => u.bpAvailable).length, 1);
  const start = oct21.packets.find((p) => p.dir === 'tx' && p.context === 'hrv_explicit_duration_120');
  assert.equal(start.hex, hex(frame([0x28, 1, 1, 0, 120, 0])), 'our start frame is byte-for-byte the one the band answered');
});
