'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const stressScore = require('../services/stress-score');
const appleHealth = require('../services/apple-health');
const healthDaily = require('../services/health-daily');
const healthSamples = require('../services/health-samples');
const jcRingProtocol = require('../services/jc-ring-protocol');

// Past a week the daily rollup is the honest source and this read is both
// slower and a different statistic. Refused, never clamped.
const MAX_SAMPLE_HOURS = 24 * 7;
const RING_DIAGNOSTIC_STATE_KEY = 'jc_ring_diagnostic';
const MAX_RING_DIAGNOSTIC_PACKETS = 500;
const MAX_RING_DIAGNOSTIC_CHARACTERISTICS = 100;
const MAX_RING_DIAGNOSTIC_PROBES = 300;
const JC_RING_METRICS = [
  'heart_rate', 'battery_level_percent', 'hrv', 'blood_oxygen_saturation', 'skin_temperature_celsius',
  'vendor_bp_systolic_estimate', 'vendor_bp_diastolic_estimate',
];

function shortText(value, limit) {
  return typeof value === 'string' && value.length <= limit ? value : null;
}

// The raw capture remains available for protocol work, but confirmed readings
// are also made durable here. They use their own table so nothing from a
// consumer ring is blended into Apple Health or a HiLo measurement.
function persistJCRingReadings(packets, receivedAt) {
  const decoded = jcRingProtocol.inspect(packets);
  let stored = 0;
  const put = (metric, value, at, sampleIndex = 0) => {
    if (Number.isFinite(value) && db.insertJCRingSample(metric, value, at, sampleIndex, receivedAt)) stored++;
  };
  for (const sample of decoded.heartRateSamples) {
    put('heart_rate', sample.bpm, sample.timestamp, sample.sampleIndex);
  }
  for (const sample of decoded.hrvSamples) put('hrv', sample.value, sample.timestamp);
  for (const sample of decoded.oxygenSamples) put('blood_oxygen_saturation', sample.saturation, sample.timestamp);
  for (const sample of decoded.temperatureSamples) put('skin_temperature_celsius', sample.celsius, sample.timestamp);
  for (const sample of decoded.batterySamples) put('battery_level_percent', sample.percent, sample.receivedAt);
  for (const sample of decoded.vendorBloodPressureEstimates) {
    put('vendor_bp_systolic_estimate', sample.systolic, sample.timestamp);
    put('vendor_bp_diastolic_estimate', sample.diastolic, sample.timestamp);
  }
  return { decoded, stored };
}

/**
 * Preserve a deliberately requested raw Bluetooth capture while the direct
 * JC Ring protocol is being identified. This is NOT health ingest: no bytes
 * are interpreted as a measurement here, and no background upload calls it.
 */
function ringDiagnostic(body, client) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'JSON body required' };
  if (!Array.isArray(body.packets) || !Array.isArray(body.characteristics) ||
      (body.probes !== undefined && !Array.isArray(body.probes))) {
    return { ok: false, error: 'packets and characteristics arrays are required' };
  }
  if (body.packets.length > MAX_RING_DIAGNOSTIC_PACKETS ||
      body.characteristics.length > MAX_RING_DIAGNOSTIC_CHARACTERISTICS ||
      (body.probes?.length || 0) > MAX_RING_DIAGNOSTIC_PROBES) {
    return { ok: false, error: 'diagnostic capture exceeds its safe size limit' };
  }

  const packets = [];
  for (const p of body.packets) {
    const service = shortText(p?.service, 80);
    const characteristic = shortText(p?.characteristic, 80);
    const hex = shortText(p?.hex, 768);
    const kind = shortText(p?.kind, 32);
    const receivedAt = shortText(p?.receivedAt, 64);
    if (!service || !characteristic || !hex || !kind || !receivedAt) {
      return { ok: false, error: 'a packet has an invalid field' };
    }
    packets.push({ service, characteristic, hex, kind, receivedAt });
  }

  const characteristics = [];
  for (const c of body.characteristics) {
    const service = shortText(c?.service, 80);
    const uuid = shortText(c?.uuid, 80);
    if (!service || !uuid || !Array.isArray(c.properties) || c.properties.length > 12 ||
        !c.properties.every(p => typeof p === 'string' && p.length <= 40)) {
      return { ok: false, error: 'a Bluetooth characteristic has an invalid field' };
    }
    characteristics.push({ service, uuid, properties: c.properties });
  }

  const probes = [];
  for (const p of body.probes || []) {
    const occurredAt = shortText(p?.occurredAt, 64);
    const kind = shortText(p?.kind, 32);
    const label = shortText(p?.label, 160);
    const service = p?.service === undefined ? undefined : shortText(p.service, 80);
    const characteristic = p?.characteristic === undefined ? undefined : shortText(p.characteristic, 80);
    const hex = p?.hex === undefined ? undefined : shortText(p.hex, 768);
    if (!occurredAt || !kind || !label ||
        (p?.service !== undefined && !service) ||
        (p?.characteristic !== undefined && !characteristic) ||
        (p?.hex !== undefined && !hex)) {
      return { ok: false, error: 'a protocol probe has an invalid field' };
    }
    probes.push({ occurredAt, kind, label, service, characteristic, hex });
  }

  const capture = {
    receivedAt: new Date().toISOString(),
    client: shortText(client, 80) || 'unknown',
    pairedName: shortText(body.pairedName, 120),
    capturedAt: shortText(body.capturedAt, 64),
    characteristics,
    packets,
    probes,
  };
  db.setState(RING_DIAGNOSTIC_STATE_KEY, JSON.stringify(capture));
  const persisted = persistJCRingReadings(packets, capture.receivedAt);
  return { ok: true, packetsStored: packets.length, characteristicsStored: characteristics.length,
    probesStored: probes.length, readingsStored: persisted.stored, receivedAt: capture.receivedAt };
}

// POST /api/health/ring-diagnostic — an explicit, one-off protocol capture.
// This is deliberately separate from health ingest: raw BLE bytes are not a
// measurement until their meaning has been verified against the physical ring.
router.post('/ring-diagnostic', (req, res) => {
  try {
    const result = ringDiagnostic(req.body, req.headers['x-neuro-client']);
    return res.status(result.ok ? 200 : 400).json(result);
  } catch {
    // Do not log the capture: packet bytes can contain sensitive readings.
    return res.status(500).json({ ok: false, error: 'could not store ring diagnostic' });
  }
});

// GET /api/health/ring-diagnostic — the decoder's authenticated inspection
// point. The normal /api PIN middleware protects this route in server.js.
router.get('/ring-diagnostic', (req, res) => {
  try {
    const raw = db.getState(RING_DIAGNOSTIC_STATE_KEY);
    if (!raw) return res.json({ available: false });
    return res.json({ available: true, capture: JSON.parse(raw) });
  } catch {
    return res.status(500).json({ error: 'could not read ring diagnostic' });
  }
});

// GET /api/health/ring-diagnostic/decoded — J2301 structural inspection. The
// verified 0x54 automatic heart-rate records are decoded; all other frames
// remain raw rather than being turned into speculative health metrics.
router.get('/ring-diagnostic/decoded', (req, res) => {
  try {
    const raw = db.getState(RING_DIAGNOSTIC_STATE_KEY);
    if (!raw) return res.json({ available: false });
    const capture = JSON.parse(raw);
    return res.json({ available: true, receivedAt: capture.receivedAt,
      decoded: jcRingProtocol.inspect(capture.packets) });
  } catch {
    return res.status(500).json({ error: 'could not decode ring diagnostic' });
  }
});

// Latest values from the direct ring, deliberately source-labelled. The
// vendor BP fields are estimates and never presented as measured pressure.
router.get('/ring-readings', (req, res) => {
  try {
    const latest = Object.fromEntries(JC_RING_METRICS.map(metric => [metric, db.getLatestJCRingSample(metric) || null]));
    return res.json({ available: Object.values(latest).some(Boolean), latest,
      caution: 'JC Ring blood-pressure fields are vendor estimates, not cuff or HiLo measurements. Ring timestamps are device-local.' });
  } catch {
    return res.status(500).json({ error: 'could not read JC Ring samples' });
  }
});

// A compact one-week monitoring view. Values remain in their source units and
// are never calibrated, merged into Apple Health, or presented as medical BP.
router.get('/ring-week', (req, res) => {
  try {
    const now = new Date();
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');
    const latest = Object.fromEntries(JC_RING_METRICS.map(metric => [metric, db.getLatestJCRingSample(metric) || null]));
    return res.json({
      generatedAt: now.toISOString(),
      sinceLocal: since,
      latest,
      daily: db.getJCRingDailySummary(since),
      notConnectedYet: [
        'steps and activity history', 'sleep history',
        'exercise sessions', 'blood-sugar feature',
      ],
      caution: 'JC Ring blood-pressure fields are vendor estimates, not cuff or HiLo measurements. Ring timestamps are device-local.',
    });
  } catch {
    return res.status(500).json({ error: 'could not read JC Ring week monitor' });
  }
});

// POST /api/health/ring-readings/backfill — explicitly decode the last raw
// capture after a server upgrade. This is intentionally a write route rather
// than a side effect of reading /ring-readings: a diagnostic capture remains
// the user's private data until this deliberate conversion is requested.
router.post('/ring-readings/backfill', (req, res) => {
  try {
    const raw = db.getState(RING_DIAGNOSTIC_STATE_KEY);
    if (!raw) return res.status(404).json({ ok: false, error: 'no JC Ring diagnostic capture is available' });
    const capture = JSON.parse(raw);
    if (!Array.isArray(capture.packets) || !shortText(capture.receivedAt, 64)) {
      return res.status(400).json({ ok: false, error: 'saved JC Ring diagnostic capture is invalid' });
    }
    const persisted = persistJCRingReadings(capture.packets, capture.receivedAt);
    return res.json({ ok: true, packetsRead: capture.packets.length, readingsStored: persisted.stored,
      receivedAt: capture.receivedAt });
  } catch {
    return res.status(500).json({ ok: false, error: 'could not backfill JC Ring samples' });
  }
});

// A transparent source-to-source view. This deliberately shows timestamps
// beside values: a difference is useful only when the readings are close
// enough in time to compare, and the ring clock remains device-local.
router.get('/ring-comparison', (req, res) => {
  try {
    const ring = Object.fromEntries(JC_RING_METRICS.map(metric => [metric, db.getLatestJCRingSample(metric) || null]));
    const apple = {
      heart_rate: db.getLatestHealthSample('heartRate') || null,
      hrv: db.getLatestHealthSample('hrv') || null,
      blood_oxygen_saturation: db.getLatestHealthSample('blood_oxygen_saturation') || null,
      bloodPressure: healthSamples.latestBloodPressure(),
    };
    const compare = (ringMetric, appleMetric, normaliseReference = value => value) => {
      const a = ring[ringMetric];
      const b = apple[appleMetric];
      const reference = b && Number.isFinite(b.value)
        ? { ...b, value: normaliseReference(b.value) }
        : b;
      return { ring: a, reference,
        difference: a && reference && Number.isFinite(a.value) && Number.isFinite(reference.value)
          ? a.value - reference.value : null };
    };
    return res.json({
      heartRate: compare('heart_rate', 'heart_rate'),
      hrv: compare('hrv', 'hrv'),
      // HealthKit stores saturation as 0–1; the J2301 ring stores whole
      // percentage points. Put both on the visible percentage scale first.
      oxygen: compare('blood_oxygen_saturation', 'blood_oxygen_saturation', value => value <= 1 ? value * 100 : value),
      bloodPressure: {
        ringEstimate: {
          systolic: ring.vendor_bp_systolic_estimate,
          diastolic: ring.vendor_bp_diastolic_estimate,
        },
        HiLo: apple.bloodPressure,
        difference: ring.vendor_bp_systolic_estimate && ring.vendor_bp_diastolic_estimate && apple.bloodPressure?.known
          ? {
              systolic: ring.vendor_bp_systolic_estimate.value - apple.bloodPressure.systolic,
              diastolic: ring.vendor_bp_diastolic_estimate.value - apple.bloodPressure.diastolic,
            } : null,
      },
      caveats: [
        'JC Ring timestamps are the ring local clock; Apple Health/HiLo timestamps are UTC.',
        'Ring BP is a vendor estimate, never a measured HiLo or cuff value.',
        'A difference is not a calibration point unless the readings were taken close together in comparable conditions.',
      ],
    });
  } catch {
    return res.status(500).json({ error: 'could not compare JC Ring readings' });
  }
});

// What the legacy flat-key ingest can store, and under which canonical metric
// name. This route predates the FreeReps app and survives as the iOS Shortcut
// fallback; the app itself posts to /api/v1/ingest/ (routes/apple-health.js).
//
// ⚠ It used to write a daily KV blob in agent_state ALONGSIDE these samples, and
// that blob was what /today, /history, /status, chat context and the journal
// prompt all read. When the phone moved to the app, the blob stopped being
// written and all five went quiet — for months, silently, because a missing blob
// reads as "no data yet". The blob is gone: everything derives from
// health_samples now, so a second writer cannot fall behind the first.
const FLAT_KEY_METRICS = {
  hrv: 'hrv',
  rhr: 'rhr',
  heartRate: 'heartRate',
  steps: 'steps',
  activeEnergy: 'activeEnergy',
  respiratoryRate: 'respiratoryRate',
  vo2max: 'vo2_max',
  bodyWeight: 'weight_body_mass',
};

// Accepted by the old payload but NOT storable as a scalar sample: sleep lives
// in health_samples as per-SEGMENT rows and is rolled into nights at read time,
// so a single "sleepDuration: 7.4" cannot be written without inventing segments
// that were never recorded. Reported back rather than silently dropped.
const FLAT_KEYS_UNSTORABLE = [
  'sleepDuration', 'sleepDeep', 'sleepRem', 'sleepAwake', 'sleepEfficiency',
];

// Store UTC as 'YYYY-MM-DD HH:MM:SS' so string comparison in the baseline
// queries is also chronological comparison.
function toSqlUtc(input) {
  const d = input ? new Date(input) : new Date();
  if (isNaN(d.getTime())) return new Date().toISOString().replace('T', ' ').slice(0, 19);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// Two shapes are accepted, because the phone side is not settled yet:
//   1. a `samples` array of {metric, value, recordedAt} — real per-reading
//      timestamps, which is what a proper baseline wants
//   2. the existing flat keys, stamped with one timestamp for the whole post
// Both funnel into the same INSERT OR IGNORE, so overlapping posts fold.
//
// Returns what it stored AND what it could not, because a payload that shrinks
// with no explanation is the thing this codebase keeps having to debug.
function recordSamples(payload) {
  const result = { written: 0, unstored: {} };

  if (Array.isArray(payload.samples)) {
    for (const s of payload.samples) {
      if (!s || !s.metric) continue;
      const metric = FLAT_KEY_METRICS[s.metric] || appleHealth.metricName(s.metric);
      const v = Number(s.value);
      if (!metric || !isFinite(v)) {
        result.unstored[s.metric || 'unnamed'] = (result.unstored[s.metric || 'unnamed'] || 0) + 1;
        continue;
      }
      if (db.insertHealthSample(metric, v, toSqlUtc(s.recordedAt), 'ingest')) result.written++;
    }
    return result;
  }

  const stamp = toSqlUtc(payload.timestamp);
  for (const [key, metric] of Object.entries(FLAT_KEY_METRICS)) {
    const v = Number(payload[key]);
    if (!isFinite(v) || payload[key] === null || payload[key] === undefined) continue;
    if (db.insertHealthSample(metric, v, stamp, 'ingest')) result.written++;
  }
  for (const key of FLAT_KEYS_UNSTORABLE) {
    if (payload[key] !== null && payload[key] !== undefined) result.unstored[key] = 1;
  }
  return result;
}

// POST /api/health/ingest — receive Apple Health data from iOS Shortcut
// Secured with a simple token (INGEST_SECRET env var, same as used elsewhere)
router.post('/ingest', (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  const expected = process.env.INGEST_SECRET || '';

  if (expected && token !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'JSON body required' });
    }

    const todayKey = new Date().toISOString().split('T')[0];
    const date = payload.date || todayKey;

    // ONE store. Samples go into health_samples and every reader derives from
    // there — see the note on FLAT_KEY_METRICS for what the second store cost.
    const stored = recordSamples(payload);

    const unstored = Object.keys(stored.unstored);
    console.log(`[Health] Ingest for ${date}: ${stored.written} sample(s) stored` +
      (unstored.length ? `, ${unstored.length} field(s) not storable: ${unstored.join(', ')}` : ''));

    res.json({
      success: true,
      date,
      samplesStored: stored.written,
      // Named, never silently dropped. Sleep is the one that matters here: it is
      // stored per segment and cannot be reconstructed from a nightly total.
      unstored: stored.unstored,
    });
  } catch (e) {
    console.error('[Health] Ingest error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/today — today's rolled-up day, plus the readiness read.
//
// Never serves yesterday as today: a stale figure presented as current is the
// failure this whole area has just been dug out of.
router.get('/today', (req, res) => {
  try {
    const snapshot = healthDaily.today();
    res.json({
      date: snapshot.day,
      data: snapshot.data,
      readiness: snapshot.readiness,
      sentence: snapshot.sentence,
      // "Nothing has arrived yet today" and "the rollup has not run" are
      // different problems and must not share an empty response.
      note: snapshot.data ? null : 'No health data recorded yet today',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/history?days=7 — the last N days, newest first.
router.get('/history', (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '7', 10), 1), 365);
    const history = healthDaily.recentDays(days);
    res.json({ history, days, hasData: history.length > 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/readiness — how much this body has to give today, and why.
router.get('/readiness', (req, res) => {
  try {
    const snapshot = healthDaily.today();
    res.json({ date: snapshot.day, ...snapshot.readiness, sentence: snapshot.sentence });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/signals — what has CHANGED, ranked. Trends, not today's
// numbers: a resting heart rate held 4bpm high for three days is not visible in
// any single reading. Pull-only — nothing here notifies.
router.get('/signals', (req, res) => {
  try {
    res.json(require('../services/health-signals').snapshot());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/health/signals/:id/ack — "I've read it".
// DELETE the same path is the way back.
//
// ⚠ The id is a finding id (`quiet:dietary_water`, `rhr-elevated`), so it can
// contain a colon but never a slash — Express would read one as another path
// segment. Both verbs are registered ABOVE nothing else on `/signals`, but the
// literal `/signals` GET is declared first regardless: this router has shipped
// a literal path swallowed by a sibling parameter before.
router.post('/signals/:id/ack', (req, res) => {
  try {
    const out = require('../services/health-signals').acknowledge(req.params.id);
    // A refusal is a refusal, not a 200 the panel would render as a change.
    res.status(out.ok ? 200 : 400).json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/signals/:id/ack', (req, res) => {
  try {
    const out = require('../services/health-signals').unacknowledge(req.params.id);
    res.status(out.ok ? 200 : 400).json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/health/rollup — recompute the daily rollup now. Idempotent (every
// row is an UPSERT keyed on the day), so this is safe to hit repeatedly; the
// scheduler runs it hourly anyway.
router.post('/rollup', (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.body?.days, 10) || healthDaily.SYNC_WINDOW_DAYS, 1), 3650);
    res.json(healthDaily.sync({ days }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/stress — current stress score against a rolling personal baseline.
// Returns status 'calibrating' until there is enough history to mean anything.
router.get('/stress', (req, res) => {
  try {
    res.json(stressScore.computeStressScore());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/status — is health data available and fresh?
//
// Freshness comes from the newest SAMPLE, not from whether a rollup row exists:
// the rollup writes a row for every day in its window whether the phone synced
// or not, so "a row exists" is not "data arrived".
router.get('/status', (req, res) => {
  try {
    const all = db.getHealthMetricSummary(null);
    const newest = all.reduce((m, r) => (!m || r.last_at > m ? r.last_at : m), null);
    const ageHours = newest
      ? Math.round(((Date.now() - Date.parse(`${String(newest).replace(' ', 'T')}Z`)) / 3600000) * 10) / 10
      : null;
    res.json({
      hasToday: require('../services/health').getTodayData() !== null,
      latestSampleAt: newest,
      ageHours,
      metricCount: all.length,
      totalSamples: all.reduce((n, r) => n + r.samples, 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/metrics — what is actually in the series, per metric (#40).
//
// The point of this is freshness, not volume. iOS decides when the phone syncs
// (BGProcessingTask is a request, not a schedule, and stops entirely after a
// force-quit), so a feed going quiet is the EXPECTED failure. `lastAt` and
// `ageHours` are what make that visible; a row count alone cannot.
router.get('/metrics', (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 3650);
    const since = new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    const now = Date.now();

    const metrics = db.getHealthMetricSummary(since).map((row) => ({
      metric: row.metric,
      samples: row.samples,
      firstAt: row.first_at,
      lastAt: row.last_at,
      ageHours: row.last_at
        ? Math.round(((now - Date.parse(`${row.last_at.replace(' ', 'T')}Z`)) / 3600000) * 10) / 10
        : null,
    }));

    // All-time context alongside the window, because during a backfill they
    // disagree wildly and the window alone is misleading. Measured live: 161,637
    // rows spanning Aug 2024 → Nov 2025 while the 30-day window was EMPTY,
    // because the app backfills forward chronologically and had not yet reached
    // the present. Reporting only the window would have said "no data" over a
    // table with 161k rows in it — indistinguishable from a broken feed.
    const all = db.getHealthMetricSummary(null);
    const newestAt = all.reduce((m, r) => (!m || r.last_at > m ? r.last_at : m), null);
    const oldestAt = all.reduce((m, r) => (!m || r.first_at < m ? r.first_at : m), null);

    res.json({
      windowDays: days,
      metricCount: metrics.length,
      totalSamples: metrics.reduce((n, m) => n + m.samples, 0),
      metrics,
      allTime: {
        metricCount: all.length,
        samples: all.reduce((n, r) => n + r.samples, 0),
        oldestAt,
        newestAt,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/samples?hours=168 — the INTRADAY read.
//
// `/history` answers "what was each DAY", which over 24 hours is a single point.
// This reads `health_samples` direct and buckets it, so the short windows on My
// Health are a real curve rather than one dot.
//
// ⚠ `hours=0` means "just the latest reading of each", which is what the Now
// view wants — deliberately a value of the SAME parameter rather than a second
// route, so a client cannot ask for a window and a snapshot that disagree about
// which metrics they cover.
//
// ⚠ The window is CAPPED at 7 days, and the cap REFUSES rather than silently
// clamping. Past a week the daily rollup is the honest source (it has 762 days
// of it) and a bucketed sample read would be both slower and a different
// statistic wearing the same axis. A clamp would answer a question nobody asked
// and look like it had answered the one they did.
router.get('/samples', (req, res) => {
  try {
    const raw = req.query.hours;
    const hours = raw === undefined ? 168 : Number(raw);

    if (!Number.isFinite(hours) || hours < 0) {
      return res.status(400).json({ error: 'hours must be a number of hours, 0 or more' });
    }
    if (hours > MAX_SAMPLE_HOURS) {
      return res.status(400).json({
        error: `hours must be ${MAX_SAMPLE_HOURS} or fewer — past a week use /history, which is a daily median rather than a bucket average`,
        maxHours: MAX_SAMPLE_HOURS,
      });
    }

    // A comma list, filtered to what actually has an intraday form. An unknown
    // key is REPORTED rather than ignored: a chart asking for a series that does
    // not exist would otherwise render empty and raise nothing, which is the
    // reader-with-no-writer shape this area keeps paying for.
    const asked = String(req.query.keys || '').split(',').map(s => s.trim()).filter(Boolean);
    const unknown = asked.filter(k => !healthSamples.hasSeries(k));
    const keys = asked.filter(k => healthSamples.hasSeries(k));

    const snapshot = healthSamples.latest({ keys: keys.length ? keys : null });

    if (hours === 0) {
      return res.json({
        windowHours: 0,
        mode: 'now',
        // ⚠ `latest` carries VALUES with their age. It deliberately does NOT
        // contain bpSystolic/bpDiastolic — a blood pressure is one measurement
        // and is returned whole under `bloodPressure`, or not at all.
        latest: snapshot.latest,
        bloodPressure: snapshot.bloodPressure,
        unknownKeys: unknown,
        gaps: snapshot.gaps,
        ok: snapshot.ok,
      });
    }

    const out = healthSamples.read({ hours, keys: keys.length ? keys : null });
    res.json({ ...out, mode: 'window', latest: snapshot.latest,
      bloodPressure: snapshot.bloodPressure, unknownKeys: unknown,
      gaps: [...(out.gaps || []), ...snapshot.gaps] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health/sleep — per-night totals from the per-segment rows (#40).
//
// The ingest deliberately stores segments raw because grouping them needs a
// day-boundary rule; that rule lives in apple-health.rollupSleepNights and is
// applied here at read time, so changing it never means re-ingesting.
router.get('/sleep', (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    // Reach back an extra day: a night is keyed by its WAKE date, so the
    // earliest night in the window has segments that started before it.
    const since = new Date(Date.now() - (days + 1) * 86400000).toISOString().replace('T', ' ').slice(0, 19);

    // Fetched by PREFIX, never by a list of stage names (#122). The list here
    // asked for `sleep_core_hours`; Apple's label is `sleep_asleep_core_hours`,
    // so the staged breakdown returned zero rows on every night and the card's
    // stage bar was empty by construction — silently, because a wrong metric
    // name is an empty result, not an error.
    const rows = db.getSleepSamples(since, 20000);

    const nights = appleHealth.rollupSleepNights(rows).slice(0, days);
    res.json({
      windowDays: days,
      nights,
      // Distinguishes "no sleep data at all" from "nothing recent" — with iOS
      // deciding when the phone syncs, those are different problems.
      hasData: nights.length > 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
