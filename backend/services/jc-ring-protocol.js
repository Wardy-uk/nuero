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
  const hrvSamples = [];
  const oxygenSamples = [];
  const temperatureSamples = [];
  const vendorBloodPressureEstimates = [];
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

    // J2301 HRV history: 56, sequence, 00, timestamp, HRV, vascular-age,
    // HR, stress, vendor-high-BP, vendor-low-BP. This is explicitly kept as
    // a vendor estimate; it is not a cuff-equivalent blood-pressure reading.
    for (let i = 0; i + 14 < bytes.length; i++) {
      const timestamp = bytes[i] === 0x56 && bytes[i + 2] === 0
        ? ringTimestamp(bytes, i + 3) : null;
      if (!timestamp) continue;
      if (bytes[i + 9] > 0 && hrvSamples.length < 100) {
        hrvSamples.push({ timestamp, value: bytes[i + 9] });
      }
      if (bytes[i + 13] === 0 || bytes[i + 14] === 0 || vendorBloodPressureEstimates.length >= 100) continue;
      vendorBloodPressureEstimates.push({
        timestamp,
        systolic: bytes[i + 13],
        diastolic: bytes[i + 14],
        heartRate: bytes[i + 11],
        source: 'J2301 HRV vendor estimate',
      });
    }

    // Automatic SpO2 history: 66, sequence, 00, timestamp, saturation.
    for (let i = 0; i + 9 < bytes.length; i++) {
      const timestamp = bytes[i] === 0x66 && bytes[i + 2] === 0
        ? ringTimestamp(bytes, i + 3) : null;
      const saturation = bytes[i + 9];
      if (timestamp && saturation > 0 && saturation <= 100 && oxygenSamples.length < 100) {
        oxygenSamples.push({ timestamp, saturation });
      }
    }

    // Automatic temperature history: 62, sequence, 00, timestamp, little-
    // endian deci-degrees Celsius. It is a skin-facing ring value, not core
    // body temperature.
    for (let i = 0; i + 10 < bytes.length; i++) {
      const timestamp = bytes[i] === 0x62 && bytes[i + 2] === 0
        ? ringTimestamp(bytes, i + 3) : null;
      const tenthsC = bytes[i + 9] | (bytes[i + 10] << 8);
      if (timestamp && tenthsC >= 100 && tenthsC <= 500 && temperatureSamples.length < 100) {
        temperatureSamples.push({ timestamp, celsius: tenthsC / 10 });
      }
    }
  }

  return {
    packetCount: Array.isArray(packets) ? packets.length : 0,
    notifications,
    headers,
    embeddedTimes,
    heartRateSamples,
    hrvSamples,
    oxygenSamples,
    temperatureSamples,
    vendorBloodPressureEstimates,
    caution: '0x54 heart-rate history and 0x56 vendor BP estimates are decoded. Consumer wearable readings are not clinical measurements; BP estimates need comparison against a validated cuff or HiLo before they are used for a trend.',
  };
}

module.exports = { hexBytes, ringTimestamp, timestamps, inspect };
