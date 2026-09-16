// Rendering the vitals for `get_health`.
//
// Extracted so the WORDING can be pinned. Nick's requirement was explicit —
// sample counts and measured values must stay separable "in both schema and
// rendered output", and a consumer must not reasonably read 155 samples as
// 155mmHg. That is a property of the text, so the text needs a test, and a tool
// registered on a running server is not reachable from one.

// How long ago, in words. The AGE is not decoration: a heart rate of 74 means
// something quite different taken four minutes ago and taken last Tuesday, and
// the phone syncs at iOS's discretion, so "latest" is a claim to be earned.
function ageWords(minutes) {
  if (!Number.isFinite(minutes)) return 'age unknown';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

// ⚠ A STALE READING IS NEVER PRESENTED AS CURRENT. It is still shown — hiding it
// would make a feed that quietly stopped invisible — but it is labelled with how
// old it is and what the expected cadence was, so a reader cannot take it for a
// measurement of now.
function freshnessNote(r) {
  if (r.stale === null) return ` — ${r.note || 'age unknown'} ⚠ CANNOT CONFIRM THIS IS CURRENT`;
  const when = ageWords(r.ageMinutes);
  if (!r.stale) return ` — ${when}`;
  const expected = Number.isFinite(r.staleAfterMin)
    ? `, expected within ${r.staleAfterMin < 60 ? `${r.staleAfterMin} min` : `${Math.round(r.staleAfterMin / 60)}h`}`
    : '';
  return ` — ${when} ⚠ STALE${expected}; do NOT read this as a current measurement`;
}

const VITAL_LABELS = {
  heartRateMedian: 'Heart rate',
  spo2: 'Blood oxygen',
  hrvMedian: 'HRV',
  rhrMedian: 'Resting heart rate',
};

function renderVitals(snapshot) {
  const lines = ['', '## Latest readings (MEASURED VALUES)', ''];
  const latest = snapshot?.latest || {};
  const bp = snapshot?.bloodPressure;

  // ⚠ ONE MEASUREMENT. `latest` carries no systolic or diastolic of its own, so
  // there is nothing here to pair by mistake — the server returns a blood
  // pressure whole or says it has none.
  if (bp?.known) {
    lines.push(`- **Blood pressure** ${bp.systolic}/${bp.diastolic} ${bp.unit}${freshnessNote(bp)}`
      + (bp.laterUnpairedReading ? ' _(a later reading exists with only one half, so this is the latest COMPLETE measurement, not the latest datum)_' : ''));
  } else {
    lines.push(`- **Blood pressure** — not available: ${bp?.reason || 'unknown'}`);
  }

  for (const [key, label] of Object.entries(VITAL_LABELS)) {
    const r = latest[key];
    if (!r || !Number.isFinite(r.value)) {
      // Absent, never a dash or a zero that could read as a measurement.
      lines.push(`- **${label}** — not recorded`);
      continue;
    }
    lines.push(`- **${label}** ${r.value}${r.unit ? ` ${r.unit}` : ''}${freshnessNote(r)}`);
  }

  for (const g of snapshot?.gaps || []) {
    lines.push(`- ⚠ Could not read ${g.input} — ${g.why}. This is not an all-clear.`);
  }
  return lines;
}


export { ageWords, freshnessNote, renderVitals, VITAL_LABELS };
