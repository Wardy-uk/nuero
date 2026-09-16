import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderVitals, ageWords, freshnessNote } from '../health-render.js';

/**
 * What `get_health` SAYS about the vitals.
 *
 * The wording is the contract here, not just the data. Nick's requirement was
 * explicit: sample counts and measured values must stay separable "in both
 * schema and rendered output", and a consumer must not reasonably read 155
 * samples as 155mmHg. That is a property of the text, so the text is tested.
 *
 * This surface matters more than the UI it mirrors: a model reads it and
 * restates it as a fact about somebody's health.
 */

const SNAPSHOT = {
  bloodPressure: {
    known: true, systolic: 151, diastolic: 90, unit: 'mmHg',
    at: '2026-09-16T12:47:00.000Z', ageMinutes: 370, stale: false,
    staleAfterMin: 1440, laterUnpairedReading: false,
  },
  latest: {
    heartRateMedian: { value: 75, unit: 'bpm', ageMinutes: 62, stale: true, staleAfterMin: 30 },
    spo2: { value: 96, unit: '%', ageMinutes: 213, stale: false, staleAfterMin: 360 },
    hrvMedian: { value: 18.62, unit: 'ms', ageMinutes: 62, stale: false, staleAfterMin: 120 },
    rhrMedian: { value: 75, unit: 'bpm', ageMinutes: 765, stale: false, staleAfterMin: 2160 },
  },
  gaps: [],
};

const render = (s) => renderVitals(s).join('\n');

test('a blood pressure is rendered as ONE paired reading, with its unit', () => {
  const out = render(SNAPSHOT);
  assert.match(out, /Blood pressure\*\* 151\/90 mmHg/);
  // ⚠ And it must never be assembled from halves. The snapshot carries no
  // bpSystolic/bpDiastolic, so there is nothing to pair — but a renderer that
  // reached for them would be a regression worth catching.
  assert.ok(!/bpSystolic|bpDiastolic/.test(out));
});

test('no complete reading is STATED, never filled in or left blank', () => {
  const out = render({
    ...SNAPSHOT,
    bloodPressure: {
      known: false, hasReadings: true,
      reason: 'readings exist, but no systolic and diastolic from the same measurement — no complete blood pressure is available',
    },
  });
  assert.match(out, /Blood pressure\*\* — not available/);
  assert.match(out, /same measurement/, 'the reason must survive to the reader');
  assert.ok(!/\d+\/\d+ mmHg/.test(out), 'a blood pressure was invented');
});

test('a pair that is not the newest datum says so', () => {
  const out = render({
    ...SNAPSHOT,
    bloodPressure: { ...SNAPSHOT.bloodPressure, laterUnpairedReading: true },
  });
  assert.match(out, /latest COMPLETE measurement/,
    'a later half-reading exists and the pair was presented as the latest datum');
});

test('every value carries its unit and its age', () => {
  const out = render(SNAPSHOT);
  assert.match(out, /Heart rate\*\* 75 bpm/);
  assert.match(out, /Blood oxygen\*\* 96 %/);
  assert.match(out, /HRV\*\* 18\.62 ms/);
  assert.match(out, /Resting heart rate\*\* 75 bpm/);
  // The age is not decoration: 75bpm four minutes ago and last Tuesday differ.
  assert.match(out, /1h ago/);
});

test('a STALE reading is labelled and never presented as current', () => {
  const out = render(SNAPSHOT);
  const hr = out.split('\n').find(l => l.includes('Heart rate'));
  assert.match(hr, /STALE/, 'a 62-minute-old heart rate against a 30-minute window is not "now"');
  assert.match(hr, /do NOT read this as a current measurement/);
  assert.match(hr, /expected within 30 min/, 'it must say what the expected cadence was');
  assert.match(hr, /75/, 'and the value must still be shown — hiding it makes a dead feed invisible');

  // ⚠ The per-metric windows are the point: resting heart rate is measured once
  // or twice a DAY, so 765 minutes is it working, not a fault.
  const rhr = out.split('\n').find(l => l.includes('Resting heart rate'));
  assert.ok(!/STALE/.test(rhr), 'a once-daily metric was flagged for behaving normally');
});

test('an unknown age can never read as current', () => {
  // ⚠ `stale: null` is "we cannot tell how old this is". Rendering that quietly
  // is a stale value presenting as current with the evidence removed.
  const out = render({
    ...SNAPSHOT,
    latest: { heartRateMedian: { value: 75, unit: 'bpm', ageMinutes: null, stale: null, note: 'no usable timestamp — age unknown' } },
  });
  assert.match(out, /CANNOT CONFIRM THIS IS CURRENT/);
});

test('a metric with no reading is absent, not zero and not a dash', () => {
  const out = render({ ...SNAPSHOT, latest: {} });
  assert.match(out, /Heart rate\*\* — not recorded/);
  assert.ok(!/Heart rate\*\* 0/.test(out));
});

test('a failed read is a NAMED gap, never silence', () => {
  const out = render({ ...SNAPSHOT, gaps: [{ input: 'latest', why: 'database locked' }] });
  assert.match(out, /Could not read latest — database locked/);
  assert.match(out, /not an all-clear/);
});

test('ageWords never dresses an unknown age as a real one', () => {
  assert.equal(ageWords(NaN), 'age unknown');
  assert.equal(ageWords(null), 'age unknown');
  assert.equal(ageWords(0), 'just now');
  assert.equal(ageWords(45), '45 min ago');
  assert.equal(ageWords(370), '6h ago');
  assert.equal(ageWords(4000), '3d ago');
});

test('a fresh reading gets no warning noise', () => {
  // An always-on warning is one nobody reads, which costs the real one.
  assert.ok(!/STALE/.test(freshnessNote({ stale: false, ageMinutes: 4, staleAfterMin: 30 })));
});

// ── Values and counts must not be confusable ────────────────────────────────

test('the tool separates MEASURED VALUES from ARRIVAL COUNTS in its wording', () => {
  // ⚠⚠ The bug that started this: "blood_pressure_systolic 155" was read as
  // 155mmHg and was 155 SAMPLES. On this surface a model would restate that as
  // a fact about somebody's health, so the two sections must be unmistakable.
  //
  // assert.ok with a message rather than assert.match, because match dumps the
  // whole 54KB source into the failure and buries what actually went wrong.
  const render = fs.readFileSync(new URL('../health-render.js', import.meta.url), 'utf8');
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');

  assert.ok(render.includes('## Latest readings (MEASURED VALUES)'),
    'the values section must say it holds measurements');
  assert.ok(index.includes('## Data ARRIVING — sample counts, not measurements'),
    'the counts section must say it does not');
  assert.ok(index.includes('readings received'),
    'every count must be worded as an arrival, never as a bare number');
  assert.ok(!index.includes('${m.samples} samples,'),
    'a count is still rendered as a bare "N samples", which is the original confusion');
});

test('the tool description warns that counts are not measurements', () => {
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const at = index.indexOf("server.tool('get_health',");
  const desc = index.slice(at, at + 900);
  assert.ok(/never measurements/i.test(desc),
    'a caller choosing this tool should be told before they read the output');
});
