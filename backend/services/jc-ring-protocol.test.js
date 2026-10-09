'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('./jc-ring-protocol');

test('finds the ring-local timestamp and raw stream byte without naming a health metric', () => {
  const decoded = protocol.inspect([{
    kind: 'notification', receivedAt: '2026-10-09T16:18:20Z',
    hex: '54 00 00 26 10 09 17 16 33 5D 00 00 00 00',
  }]);
  assert.equal(decoded.notifications, 1);
  assert.equal(decoded.headers['54'], 1);
  assert.deepEqual(decoded.embeddedTimes, [{
    offset: 3, value: '2026-10-09 17:16:33', receivedAt: '2026-10-09T16:18:20Z', header: '54',
  }]);
  assert.deepEqual(decoded.streamSamples, [{ timestamp: '2026-10-09 17:16:33', rawValue: 93, sequence: 0 }]);
});

test('refuses malformed timestamps instead of turning arbitrary bytes into time', () => {
  assert.equal(protocol.ringTimestamp([0x26, 13, 9, 17, 16, 51], 0), null);
  assert.deepEqual(protocol.timestamps([0x26, 10, 9, 24, 16, 51]), []);
});
