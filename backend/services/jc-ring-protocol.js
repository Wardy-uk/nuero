'use strict';

// Decoder for the verified J2301B FFF7 history stream. We only label the 0x54
// record after matching its format to the J2301 companion SDK and Nick's exact
// ring layout. Other bytes still remain raw observations.

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
  const heartRateSamples = [];
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

    // J2301 automatic HR history: 54, sequence, 00, timestamp, then fifteen
    // one-byte BPM values. The within-record cadence is not proven by the
    // wire format, so all samples retain the record timestamp. Records can be
    // coalesced in one CoreBluetooth notification, hence the byte-by-byte scan.
    for (let i = 0; i + 23 < bytes.length; i++) {
      const timestamp = bytes[i] === 0x54 && bytes[i + 2] === 0
        ? ringTimestamp(bytes, i + 3) : null;
      if (!timestamp) continue;
      for (let offset = 0; offset < 15 && heartRateSamples.length < 500; offset++) {
        // Fixed-width records are zero-padded when there is only one result;
        // zero is not a usable BPM value.
        if (bytes[i + 9 + offset] === 0) continue;
        heartRateSamples.push({
          timestamp,
          bpm: bytes[i + 9 + offset],
          sequence: bytes[i + 1],
          sampleIndex: offset,
        });
      }
    }
  }

  return {
    packetCount: Array.isArray(packets) ? packets.length : 0,
    notifications,
    headers,
    embeddedTimes,
    heartRateSamples,
    caution: 'Only 0x54 J2301 automatic heart-rate history is decoded. These are consumer-wearable readings, not clinical measurements. All other frames remain raw protocol observations.',
  };
}

module.exports = { hexBytes, ringTimestamp, timestamps, inspect };
