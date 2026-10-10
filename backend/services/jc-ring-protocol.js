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

function ringDateAtMidnight(bytes, index) {
  if (index + 2 >= bytes.length) return null;
  const bcd = n => ((n >> 4) <= 9 && (n & 0x0f) <= 9) ? ((n >> 4) * 10) + (n & 0x0f) : null;
  const [year, month, day] = bytes.slice(index, index + 3).map(bcd);
  if ([year, month, day].some(n => n === null) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `20${String(year).padStart(2, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} 00:00:00`;
}

function timestamps(bytes) {
  const result = [];
  for (let i = 0; i < bytes.length; i++) {
    const value = ringTimestamp(bytes, i);
    if (value) result.push({ offset: i, value });
  }
  return result;
}

function unsignedLE(bytes, index, size) {
  if (index < 0 || index + size > bytes.length) return null;
  let value = 0;
  for (let offset = 0; offset < size; offset++) value += bytes[index + offset] * (256 ** offset);
  return value;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values, average) {
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / values.length);
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

// These are waveform features, not glucose or blood-pressure values. They
// let us judge whether a capture is stable enough to train a future personal
// model, and independently cross-check its pulse timing against the ring HR.
function ppgFeatures(values, sampleRateHz = 50) {
  const average = mean(values);
  const deviation = standardDeviation(values, average);
  const smoothed = values.map((_, index) => {
    const start = Math.max(0, index - 2);
    const end = Math.min(values.length, index + 3);
    return mean(values.slice(start, end));
  });
  const residual = smoothed.map((value, index) => {
    const start = Math.max(0, index - sampleRateHz);
    const end = Math.min(smoothed.length, index + sampleRateHz + 1);
    return value - mean(smoothed.slice(start, end));
  });
  const threshold = standardDeviation(residual, mean(residual)) * 0.25;
  const separation = Math.round(sampleRateHz * 0.35);
  const peaks = [];
  for (let index = 1; index + 1 < residual.length; index++) {
    if (residual[index] <= threshold || residual[index] < residual[index - 1] || residual[index] < residual[index + 1]) continue;
    const previous = peaks.at(-1);
    if (previous !== undefined && index - previous < separation) {
      if (residual[index] > residual[previous]) peaks[peaks.length - 1] = index;
    } else {
      peaks.push(index);
    }
  }
  const intervals = peaks.slice(1).map((peak, index) => peak - peaks[index]).filter(interval => interval > 0);
  const medianInterval = median(intervals);
  const candidatePulseBpm = intervals.length >= 5 && medianInterval ? Math.round((60 * sampleRateHz) / medianInterval) : null;
  const intervalDeviationMs = intervals.length >= 5
    ? Math.round((standardDeviation(intervals, mean(intervals)) * 1000) / sampleRateHz)
    : null;
  return {
    estimatedDurationSeconds: Math.round((values.length / sampleRateHz) * 10) / 10,
    perfusionIndexPercent: average > 0 ? Math.round((deviation / average) * 10000) / 100 : null,
    candidatePulseBpm: candidatePulseBpm && candidatePulseBpm >= 35 && candidatePulseBpm <= 220 ? candidatePulseBpm : null,
    pulseIntervalVariabilityMs: intervalDeviationMs,
    pulseCount: peaks.length,
  };
}

// The J2301 BLE dispatcher identifies a 0x3A packet by its two-byte sequence
// number, then reads the remaining bytes as 24-bit big-endian samples. A full
// 153-byte packet holds 50 samples. This is raw optical data;
// the ring does not return a glucose number with it.
function metabolicPpgRuns(packets) {
  const runs = [];
  let current = null;
  let previousSequence = null;
  for (const packet of Array.isArray(packets) ? packets : []) {
    if (packet?.kind !== 'notification') continue;
    const bytes = hexBytes(packet.hex);
    if (bytes[0] !== 0x3A || bytes.length < 5) continue;
    const sequence = (bytes[1] * 256) + bytes[2];
    if (!current || sequence <= previousSequence) {
      current = { receivedAt: packet.receivedAt || null, firstSequence: sequence, lastSequence: sequence, frames: 0, samples: [] };
      runs.push(current);
    }
    current.lastSequence = sequence;
    current.frames++;
    for (let index = 3; index + 2 < bytes.length; index += 3) {
      current.samples.push((bytes[index] * 65536) + (bytes[index + 1] * 256) + bytes[index + 2]);
    }
    previousSequence = sequence;
  }
  return runs.map(run => {
    const values = run.samples.filter(Number.isFinite);
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const average = mean(values);
    const features = ppgFeatures(values);
    const missingFrames = Math.max(0, (run.lastSequence - run.firstSequence + 1) - run.frames);
    const clippedSamples = values.filter(value => value <= 1 || value >= 0xFFFFFE).length;
    // Keep the API and chart bounded even for a long manually requested run.
    const points = Math.min(300, values.length);
    const waveform = Array.from({ length: points }, (_, index) => values[Math.floor(index * values.length / points)]);
    return {
      receivedAt: run.receivedAt,
      firstSequence: run.firstSequence,
      lastSequence: run.lastSequence,
      frameCount: run.frames,
      sampleCount: values.length,
      minimum,
      maximum,
      average: Math.round(average),
      range: maximum - minimum,
      missingFrames,
      clippedSamples,
      signalQuality: features.candidatePulseBpm && missingFrames === 0 && clippedSamples === 0
        ? 'usable pulse pattern' : 'raw signal captured; pulse pattern needs review',
      ...features,
      waveform,
    };
  }).filter(run => run.sampleCount > 0);
}

// The companion SDK accepts either the 26-byte older total-activity record or
// the 27-byte form with a two-byte goal.  Keep that distinction rather than
// guessing from a value that happens to be small.
function totalActivityRecordLength(bytes) {
  if (bytes.length >= 27 && bytes.length % 27 === 0) return 27;
  if (bytes.length >= 26 && bytes.length % 26 === 0) return 26;
  return null;
}

function totalActivitySamples(bytes) {
  if (bytes[0] !== 0x51) return [];
  const size = totalActivityRecordLength(bytes);
  if (!size) return [];
  const samples = [];
  for (let index = 0; index + size <= bytes.length; index += size) {
    const timestamp = ringDateAtMidnight(bytes, index + 2);
    if (!timestamp) continue;
    const goal = unsignedLE(bytes, index + 21, size === 27 ? 2 : 1);
    const activeMinutes = unsignedLE(bytes, index + size - 4, 4);
    const steps = unsignedLE(bytes, index + 5, 4);
    const activeTime = unsignedLE(bytes, index + 9, 4);
    const distance = unsignedLE(bytes, index + 13, 4);
    const calories = unsignedLE(bytes, index + 17, 4);
    if ([goal, activeMinutes, steps, activeTime, distance, calories].some(value => value === null)) continue;
    samples.push({
      timestamp, steps, activeTimeMinutes: activeTime, activeMinutes,
      distanceKilometres: distance / 100, caloriesKilocalories: calories / 100, goal,
    });
  }
  return samples;
}

function detailedActivitySamples(bytes) {
  if (bytes[0] !== 0x52 || bytes.length < 25 || bytes.length % 25 !== 0) return [];
  const samples = [];
  for (let index = 0; index + 25 <= bytes.length; index += 25) {
    const timestamp = ringTimestamp(bytes, index + 3);
    if (!timestamp) continue;
    const steps = unsignedLE(bytes, index + 9, 2);
    const calories = unsignedLE(bytes, index + 11, 2);
    const distance = unsignedLE(bytes, index + 13, 2);
    if ([steps, calories, distance].some(value => value === null)) continue;
    samples.push({
      timestamp, steps, caloriesKilocalories: calories / 100, distanceKilometres: distance / 100,
      bucketSteps: bytes.slice(index + 15, index + 25),
    });
  }
  return samples;
}

function sleepSamples(bytes) {
  if (bytes[0] !== 0x53) return [];
  // Some firmware returns a 130-byte one-minute stream; the older reply is a
  // 34-byte five-minute stream.  Its stage numbers are retained as raw vendor
  // codes until we have validated their labels against the ring/app.
  const oneMinute = bytes.length === 130 || bytes.length === 132;
  const size = oneMinute ? bytes.length : 34;
  if (!oneMinute && (bytes.length < size || bytes.length % size !== 0)) return [];
  const samples = [];
  const count = oneMinute ? 1 : Math.floor(bytes.length / size);
  for (let record = 0; record < count; record++) {
    const index = record * size;
    const timestamp = ringTimestamp(bytes, index + 3);
    const duration = bytes[index + 9];
    if (!timestamp || !Number.isInteger(duration) || duration === 0) continue;
    const available = Math.min(duration, Math.max(0, bytes.length - (index + 10)));
    samples.push({
      timestamp, durationMinutes: duration * (oneMinute ? 1 : 5), unitMinutes: oneMinute ? 1 : 5,
      stageCodes: bytes.slice(index + 10, index + 10 + available),
    });
  }
  return samples;
}

function inspect(packets) {
  const headers = {};
  const embeddedTimes = [];
  const heartRateSamples = [];
  const hrvSamples = [];
  const oxygenSamples = [];
  const temperatureSamples = [];
  const batterySamples = [];
  const firmwareVersions = [];
  const vascularAgeSamples = [];
  const stressSamples = [];
  const hrvHeartRateSamples = [];
  const vendorBloodPressureEstimates = [];
  const totalActivity = [];
  const detailedActivity = [];
  const sleepHistory = [];
  const metabolicPpg = metabolicPpgRuns(packets);
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

    // Documented J2301 battery reply: 13, percentage, ... . It has no ring
    // timestamp, so retain the phone's receipt time as the observation time.
    if (bytes[0] === 0x13 && bytes[1] >= 0 && bytes[1] <= 100) {
      batterySamples.push({ percent: bytes[1], receivedAt: packet.receivedAt });
    }

    // The J2301 SDK renders bytes 1...4 of a 0x27 reply as a dotted
    // hexadecimal firmware identifier. This is a read-only identifier, not
    // evidence that a newer version exists or that NEURO can safely install it.
    if (bytes[0] === 0x27 && bytes.length >= 5) {
      firmwareVersions.push({
        version: bytes.slice(1, 5).map(value => value.toString(16).toUpperCase()).join('.'),
        receivedAt: packet.receivedAt,
      });
    }

    totalActivity.push(...totalActivitySamples(bytes));
    detailedActivity.push(...detailedActivitySamples(bytes));
    sleepHistory.push(...sleepSamples(bytes));

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
      if (bytes[i + 10] > 0 && vascularAgeSamples.length < 100) {
        vascularAgeSamples.push({ timestamp, value: bytes[i + 10] });
      }
      if (bytes[i + 12] > 0 && stressSamples.length < 100) {
        stressSamples.push({ timestamp, value: bytes[i + 12] });
      }
      if (bytes[i + 11] > 0 && hrvHeartRateSamples.length < 100) {
        hrvHeartRateSamples.push({ timestamp, value: bytes[i + 11] });
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
    batterySamples,
    firmwareVersions,
    vascularAgeSamples,
    stressSamples,
    hrvHeartRateSamples,
    vendorBloodPressureEstimates,
    totalActivity,
    detailedActivity,
    sleepHistory,
    metabolicPpg,
    caution: '0x54 heart-rate history and 0x56 vendor BP estimates are decoded. Consumer wearable readings are not clinical measurements; BP estimates need comparison against a validated cuff or HiLo before they are used for a trend.',
  };
}

module.exports = { hexBytes, ringTimestamp, timestamps, metabolicPpgRuns, inspect };
