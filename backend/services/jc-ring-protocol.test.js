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
