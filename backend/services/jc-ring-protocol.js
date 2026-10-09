'use strict';

// Conservative inspection of the JCRing 2301B's raw FFF7 stream. It names
// wire structure, not physiology: a byte that happens to be in a plausible
// heart-rate range is NOT a heart-rate measurement until we correlate it with
// a known measurement flow.

function hexBytes(hex) {
  if (typeof hex !== 'string') return [];
  return hex.trim().split(/\s+/).filter(Boolean).map(s => Number.parseInt(s, 16))
    .filter(n => Number.isInteger(n) && n >= 0 && n <= 255);
}

function ringTimestamp(bytes, index) {
  // Observed records carry YY MM DD HH mm ss, e.g. 26 10 09 17 16 33.
  if (bytes[index] !== 0x26 || index + 5 >= bytes.length) return null;
  const bcd = n => ((n >> 4) <= 9 && (n & 0x0f) <= 9) ? ((n >> 4) * 10) + (n & 0x0f) : null;
  const [year, month, day, hour, minute, second] = bytes.slice(index, index + 6).map(bcd);
  if ([year, month, day, hour, minute, second].some(n => n === null)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  return `20${String(year).padStart(2, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

function timestamps(bytes) {
  const result = [];
  for (let i = 0; i < bytes.length; i++) {
    const value = ringTimestamp(bytes, i);
    if (value) result.push({ offset: i, value });
  }
  return result;
}

function inspect(packets) {
  const headers = {};
  const embeddedTimes = [];
  const streamSamples = [];
  let notifications = 0;

  for (const packet of Array.isArray(packets) ? packets : []) {
    if (packet?.kind !== 'notification') continue;
    notifications++;
    const bytes = hexBytes(packet.hex);
    if (!bytes.length) continue;
    const header = bytes[0].toString(16).toUpperCase().padStart(2, '0');
    headers[header] = (headers[header] || 0) + 1;
    for (const time of timestamps(bytes)) {
      if (embeddedTimes.length < 200) embeddedTimes.push({ ...time, receivedAt: packet.receivedAt, header });
    }

    // `54 seq 00 YY MM DD HH mm ss value …` repeats in the evidence stream.
    // Retain the byte as a raw sample; do not call it a metric.
    for (let i = 0; i + 9 < bytes.length; i++) {
      if (bytes[i] !== 0x54 || bytes[i + 2] !== 0 || !ringTimestamp(bytes, i + 3)) continue;
      if (streamSamples.length < 200) {
        streamSamples.push({ timestamp: ringTimestamp(bytes, i + 3), rawValue: bytes[i + 9], sequence: bytes[i + 1] });
      }
    }
  }

  return {
    packetCount: Array.isArray(packets) ? packets.length : 0,
    notifications,
    headers,
    embeddedTimes,
    streamSamples,
    caution: 'Raw protocol observations only. No byte is labelled as a health metric without a verified command/response correlation.',
  };
}

module.exports = { hexBytes, ringTimestamp, timestamps, inspect };
