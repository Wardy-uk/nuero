// How the read becomes a picture — SARA's presence, as numbers. PURE: no DOM,
// no canvas, no clock, so the states pin from the node suite.
//
// Split out of Field.jsx on 11 Sep 2026, bringing the web Field level with the
// iOS app (Wardy-uk/nuero-ios, `NeuroKit/FieldDrive.swift`). The ramp itself was
// written for the web on 6 Sep (38491b3) but did not reach `main` — and so the
// laptop, the phone PWA and the kiosk — until 11 Sep; the drive and palette live
// here now so the rules pin from the node suite instead of existing only inline
// in a canvas loop. The Swift file is the reference; where these differ from it,
// that is a bug here.
//
// `.mjs` deliberately: Vite imports it as-is and node's test runner can
// dynamic-import it without a package.json deciding what `.js` means.

// ── Presence is CONSTANT. Colour carries the state. ─────────────────────────
//
// Nick, 6 Sep 2026: "she should always be visible — it should be the colour of
// her presence that changes, not the visibility. Where she currently fades,
// blue and lower intensity; where she is strong, red and stronger; orange in
// the middle."
//
// So `dim` is 1 in every state. Quiet was 0.78 and blind 0.9, which meant both
// were partly carried by her FADING; they are carried by hue now, and she is
// exactly as present in a meeting as in a fire. The pulse still multiplies
// upward — brightening for something pressing is additive to being always-there
// rather than a substitute for it.
//
// ⚠ `dim` is PRESENCE, `depth`/`period` are THE READ. Keeping that split is what
// lets her be more visible without the field claiming things it has not read.

export const PULSE_PERIOD = 6.5; // a breath, not a flicker
export const PULSE_AMP = 0.45;

export function drive({ degraded, confidenceLevel, quiet, activity, pressing } = {}) {
  // Blind: pure noise, never settles, never pulses — she cannot know whether
  // anything is pressing, and a field breathing over an unreadable pool asserts
  // exactly the thing it cannot see.
  //
  // ⚠ BLIND IS NOT ON THE RAMP. "I cannot see your work" is not low urgency, it
  // is NO information; painting it blue would give an outage the same colour as
  // a quiet afternoon, which is the blind-looks-like-clear failure this surface
  // exists to prevent. It is grey (`unresolved`) AND never settles, so two
  // channels carry it rather than one.
  if (degraded) {
    return { depth: 0, period: 0, dim: 1, pulse: 0, intensity: 0, unresolved: true };
  }

  // Quiet: settles rarely but stays PRESENT — blue and low, as visible as ever.
  // ⚠ A pressing item still drives her to the red end here: quiet means she
  // will not SPEAK, never that she may hide a breaching escalation.
  if (quiet) {
    return {
      depth: 0.35, period: 16, dim: 1,
      pulse: pressing ? PULSE_AMP : 0,
      intensity: pressing ? 1 : 0.08,
      unresolved: false,
    };
  }

  // ⚠ The low floor is 0.45: below ~0.4 a settle stops being legible as one,
  // so "she is unsure" and "she is not working" become the same picture.
  const depth = confidenceLevel === 'high' ? 1 : confidenceLevel === 'moderate' ? 0.7 : 0.45;

  // ⚠ `firefighting` does NOT shorten the settle — once the pulse existed that
  // told the same fact twice and read as agitation. `pre-meeting` keeps 7s:
  // imminent is about a clock, not a queue.
  const period = activity === 'pre-meeting' ? 7 : 9.5;

  // Pressing goes straight to the top and is never averaged down by a
  // low-confidence read happening at the same time — it is the one fact that
  // should be readable across a room. Firefighting sits high but not maximal:
  // "the queue is busy" is not the claim "this needs you now".
  const intensity = pressing ? 1
    : activity === 'firefighting' ? 0.75
    : 0.18 + depth * 0.42; // low 0.37 → high 0.60

  return { depth, period, dim: 1, pulse: pressing ? PULSE_AMP : 0, intensity, unresolved: false };
}

// ── Her colour ──────────────────────────────────────────────────────────────
// Chosen to stay distinguishable at the very low alphas the substrate draws at —
// a dark navy would vanish into the #0b0f14 ground once multiplied down.
export const COLD = [90, 150, 240];        // blue
export const MID = [240, 150, 60];         // orange
export const HOT = [240, 70, 60];          // red
export const UNRESOLVED = [150, 160, 170]; // grey — no-signal, never calm

// ⚠ THE ENDPOINTS ARE EXACT. `a + (b - a) * 1` is not bit-identical to `b`, and
// a stop you cannot assert is a stop that can drift.
function lerp(a, b, t) {
  if (t <= 0) return a.slice();
  if (t >= 1) return b.slice();
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// Two segments, so orange genuinely sits in the MIDDLE — a straight blue→red
// blend passes through a muddy purple and never through orange at all.
// `intensity` is clamped, so a bad value cannot leave the three stops.
export function colour(intensity, unresolved = false) {
  if (unresolved) return UNRESOLVED.slice();
  const n = Number(intensity);
  const t = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  return t <= 0.5 ? lerp(COLD, MID, t * 2) : lerp(MID, HOT, (t - 0.5) * 2);
}

// Nodes sit slightly lighter than their edges, as they always have
// (+0.12 of full scale, matching the Swift renderer).
export function nodeColour(rgb) {
  return rgb.map((c) => Math.min(255, c + 30.6));
}

export const rgbText = (rgb) => rgb.map((c) => Math.round(c)).join(',');
