'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('./jc-ring-protocol');

test('decodes a verified J2301 automatic heart-rate history record', () => {
  const decoded = protocol.inspect([{
    kind: 'notification', receivedAt: '2026-10-09T16:18:20Z',
    hex: '54 00 00 26 10 09 17 16 33 5D 5E 5F 60 61 62 63 64 65 66 67 68 69 6A 6B',
  }]);
  assert.equal(decoded.notifications, 1);
  assert.equal(decoded.headers['54'], 1);
  assert.deepEqual(decoded.embeddedTimes, [{
    offset: 3, value: '2026-10-09 17:16:33', receivedAt: '2026-10-09T16:18:20Z', header: '54',
  }]);
  assert.equal(decoded.heartRateSamples.length, 15);
  assert.deepEqual(decoded.heartRateSamples[0], { timestamp: '2026-10-09 17:16:33', bpm: 93, sequence: 0, sampleIndex: 0 });
  assert.deepEqual(decoded.heartRateSamples[14], { timestamp: '2026-10-09 17:16:33', bpm: 107, sequence: 0, sampleIndex: 14 });
});
test('refuses malformed timestamps instead of turning arbitrary bytes into time', () => {
  assert.equal(protocol.ringTimestamp([0x26, 13, 9, 17, 16, 51], 0), null);
  assert.deepEqual(protocol.timestamps([0x26, 10, 9, 24, 16, 51]), []);
});

test('ignores zero padding in a fixed-width heart-rate record', () => {
  const decoded = protocol.inspect([{
    kind: 'notification',
    hex: '54 00 00 26 10 09 17 16 33 5D 00 00 00 00 00 00 00 00 00 00 00 00 00 00',
  }]);
  assert.deepEqual(decoded.heartRateSamples, [
    { timestamp: '2026-10-09 17:16:33', bpm: 93, sequence: 0, sampleIndex: 0 },
  ]);
});

test('labels BP fields in an HRV record as a vendor estimate', () => {
  const decoded = protocol.inspect([{
    kind: 'notification',
    hex: '56 00 00 26 10 09 17 14 30 31 00 5C 39 70 3E',
  }]);
  assert.deepEqual(decoded.vendorBloodPressureEstimates, [{
    timestamp: '2026-10-09 17:14:30', systolic: 112, diastolic: 62,
    heartRate: 92, source: 'J2301 HRV vendor estimate',
  }]);
  assert.deepEqual(decoded.hrvSamples, [{ timestamp: '2026-10-09 17:14:30', value: 49 }]);
});

test('decodes the confirmed oxygen and skin-temperature history layouts', () => {
  const decoded = protocol.inspect([{
    kind: 'notification',
    hex: '66 00 00 26 10 09 17 15 20 60 62 00 00 26 10 09 16 59 59 5A 01',
  }]);
  assert.deepEqual(decoded.oxygenSamples, [{ timestamp: '2026-10-09 17:15:20', saturation: 96 }]);
  assert.deepEqual(decoded.temperatureSamples, [{ timestamp: '2026-10-09 16:59:59', celsius: 34.6 }]);
});

test('decodes the documented battery percentage reply', () => {
  const decoded = protocol.inspect([{
    kind: 'notification', receivedAt: '2026-10-10T07:50:00Z',
    hex: '13 54 00 00 00 00 00 00 00 00 00 00 00 00 00 67',
  }]);
  assert.deepEqual(decoded.batterySamples, [{ percent: 84, receivedAt: '2026-10-10T07:50:00Z' }]);
});

test('reads the firmware identifier and exposes ancillary vendor fields without treating them as clinical values', () => {
  const decoded = protocol.inspect([
    { kind: 'notification', receivedAt: '2026-10-10T08:00:00Z', hex: '27 01 0A FF 20 00 00 00 00 00 00 00 00 00 00 51' },
    { kind: 'notification', hex: '56 00 00 26 10 10 08 01 00 1F 2D 41 32 6E 3C' },
  ]);
  assert.deepEqual(decoded.firmwareVersions, [{ version: '1.A.FF.20', receivedAt: '2026-10-10T08:00:00Z' }]);
  assert.deepEqual(decoded.vascularAgeSamples, [{ timestamp: '2026-10-10 08:01:00', value: 45 }]);
  assert.deepEqual(decoded.hrvHeartRateSamples, [{ timestamp: '2026-10-10 08:01:00', value: 65 }]);
  assert.deepEqual(decoded.stressSamples, [{ timestamp: '2026-10-10 08:01:00', value: 50 }]);
});

test('decodes the documented daily, detailed-activity and sleep reply layouts without labelling raw sleep codes', () => {
  const decoded = protocol.inspect([
    { kind: 'notification', hex: '51 00 26 10 10 00 10 00 00 2D 00 00 00 10 27 00 00 39 30 00 00 88 13 2D 00 00 00' },
    { kind: 'notification', hex: '52 00 00 26 10 10 08 30 00 78 00 D2 04 2C 01 01 02 03 04 05 06 07 08 09 0A' },
    { kind: 'notification', hex: '53 00 00 26 10 10 23 00 00 04 01 02 03 04 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00' },
  ]);
  assert.deepEqual(decoded.totalActivity, [{
    timestamp: '2026-10-10 00:00:00', steps: 4096, activeTimeMinutes: 45, activeMinutes: 45,
    distanceKilometres: 100, caloriesKilocalories: 123.45, goal: 5000,
  }]);
  assert.deepEqual(decoded.detailedActivity, [{
    timestamp: '2026-10-10 08:30:00', steps: 120, caloriesKilocalories: 12.34,
    distanceKilometres: 3, bucketSteps: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  }]);
  assert.deepEqual(decoded.sleepHistory, [{
    timestamp: '2026-10-10 23:00:00', durationMinutes: 20, unitMinutes: 5, stageCodes: [1, 2, 3, 4],
  }]);
});

test('decodes documented metabolic PPG frames as 24-bit big-endian waveform samples', () => {
  const runs = protocol.metabolicPpgRuns([
    { kind: 'notification', receivedAt: '2026-10-10T14:00:00Z', hex: '3A 00 00 00 27 10 00 4E 20 00 75 30' },
    { kind: 'notification', receivedAt: '2026-10-10T14:00:01Z', hex: '3A 00 01 00 9C 40 00 C3 50 00 EA 60' },
    { kind: 'notification', receivedAt: '2026-10-10T14:02:00Z', hex: '3A 00 00 00 00 01 00 00 02' },
  ]);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0], {
    receivedAt: '2026-10-10T14:00:00Z', firstSequence: 0, lastSequence: 1,
    frameCount: 2, sampleCount: 6, minimum: 10000, maximum: 60000,
    average: 35000, range: 50000, missingFrames: 0, clippedSamples: 0,
    signalQuality: 'raw signal captured; pulse pattern needs review',
    estimatedDurationSeconds: 0.1, perfusionIndexPercent: 48.8,
    candidatePulseBpm: null, pulseIntervalVariabilityMs: null, pulseCount: 0,
    waveform: [10000, 20000, 30000, 40000, 50000, 60000],
  });
  assert.equal(runs[1].sampleCount, 2);
  assert.deepEqual(runs[1].waveform, [1, 2]);
});
