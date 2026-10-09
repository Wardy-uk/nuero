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
