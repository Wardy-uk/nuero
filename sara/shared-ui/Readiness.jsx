import './Readiness.css';

/**
 * The HRV readiness dial — the web half of `ReadinessView.swift`.
 *
 * ⚠ ONE COMPONENT FOR THE PWA, THE ELECTRON WINDOW AND THE KIOSK, mirroring the
 * single Swift renderer on iOS. `fieldDrive.mjs` exists for exactly this reason
 * and the handoff records what the alternative cost: her colour ramp was written
 * for iOS and the web went on fading her for five days because the two halves
 * were separate.
 *
 * ⚠⚠ `score` IS STRESS, NOT RECOVERY, and this file believed the opposite —
 * word for word, as did `Readiness.swift`. `stress-score.js` computes
 * `50 - 18z` on the HRV z-score, so BETTER recovery (higher HRV) gives a LOWER
 * number, and its own labels say so: High >= 75 down to Very low. Two
 * implementations stating the same wrong premise is not two witnesses; it is
 * one mistake copied.
 *
 * What it cost, both directions: on 13 Sep 2026 a score of 62 — which the brain
 * calls ELEVATED STRESS — rendered as "62 ready"; and a genuinely recovered day
 * at 20 would have drawn `stress` 80, red, "Take it gently". The best morning of
 * the month painted as the worst.
 *
 * ⚠ IT REFUSES TO DRAW A NUMBER IT DOES NOT HAVE. Calibrating, stale and
 * could-not-look each render as a sentence. A dial resting at zero because
 * nothing was read is the calm-day lie with a needle on it — the failure this
 * whole codebase keeps finding.
 *
 * Takes `readiness` off `GET /api/attention` (`attention.js` attaches it to
 * every payload). Passed in rather than fetched here, so a surface that already
 * holds the feed — the kiosk does — does not ask for it twice.
 */

const DOTS = 28;

/**
 * ⚠ READ OFF THE BRAIN'S OWN LABEL, not a second threshold ladder. These numbers
 * were tuned against the inverted value, so they were wrong twice over — and two
 * ladders for one reading is how a screen comes to disagree with the service
 * about what kind of day it is. The fallback is the ladder `stress-score`
 * itself publishes, for a payload carrying a score and no label.
 */
function band(label, stress) {
  switch (String(label || '').toLowerCase()) {
    case 'high': return 'critical';
    case 'elevated': return 'high';
    case 'balanced': return 'elevated';
    case 'low':
    case 'very low': return 'calm';
    default: break;
  }
  if (stress == null) return null;
  if (stress >= 75) return 'critical';
  if (stress >= 60) return 'high';
  if (stress >= 40) return 'elevated';
  return 'calm';
}

/*
 * ⚠⚠ THE VERDICT LADDER IS DELETED, and not only because it was inverted.
 *
 * "Enough for a hard one" is ADVICE, and it is the exact advice this codebase
 * refuses: readiness is deliberately NOT fed to the model because "take it easy
 * today" is a recommendation drawn from three numbers by something that cannot
 * tell exercise from illness from alcohol from a hard week — `stress-score`'s
 * own caveat, which this then ignored. The comment above it claimed it never
 * said what to do about it while saying exactly that.
 *
 * What is shown instead is the brain's own `label`, which states the reading
 * and licenses nothing.
 */

/**
 * ⚠ SCALED TO THE WEEK, NOT TO ZERO. HRV sits in a narrow band well above zero,
 * so a zero-based chart is seven near-identical bars that say nothing. Fewer
 * than two readable days draws nothing rather than implying a trend.
 */
function weekBars(hrvWeek) {
  const values = (hrvWeek || []).map(Number).filter((v) => Number.isFinite(v) && v > 0);
  if (values.length < 2) return [];
  const low = Math.min(...values);
  const high = Math.max(...values);
  if (high === low) return values.map(() => 0.5);
  return values.map((v) => (v - low) / (high - low));
}

export default function Readiness({ readiness, offDuty = false }) {
  if (!readiness) return null;

  const known = readiness.known === true;
  const score = Number.isFinite(Number(readiness.score)) ? Number(readiness.score) : null;
  // The brain's number IS the stress number. Nothing to invert.
  const stress = score;
  // ⚠ The only subtraction in the file, next to the sentence explaining which
  // way round the backend's number runs.
  const recovered = score == null ? null : Math.max(0, Math.min(100, 100 - score));

  // ⚠ Calibrating, stale and blind are three different facts and none is zero.
  if (score == null) {
    const line = readiness.detail
      || (readiness.why ? `Couldn't read your readiness — ${readiness.why}` : null)
      || readiness.label
      || 'No readiness reading yet.';
    return (
      <div className={`rdy rdy--none${known ? '' : ' rdy--blind'}`}>
        <span className="rdy__none-text">{line}</span>
      </div>
    );
  }

  // ⚠ Off duty the question is how much he has in the tank, so the dial shows
  // `recovered`; at work it is how hard he is being pushed, so it shows stress.
  // Both come from ONE number and the inversion lives in one place — it used to
  // be up there, the wrong way round, which is how an elevated-stress reading
  // came to be labelled "ready".
  const dialValue = offDuty ? recovered : stress;
  const unit = offDuty ? 'recovered' : 'stress';
  // ⚠ Colour follows STRESS in BOTH modes, so a green "recovered" and a green
  // "stress" never mean opposite things on two screens.
  const tone = band(readiness.label, stress);
  const filled = Math.round((stress / 100) * DOTS);
  const bars = weekBars(readiness.hrvWeek);

  // ⚠ `Number(null)` is 0 AND `Number.isFinite(0)` is true, so coercing a
  // missing baseline yields a perfectly plausible "vs 0 baseline" — the rule
  // below stated, and the code walking straight past it. Caught by a render
  // test, not by reading; the same coercion trap bit `isNotable` an hour
  // earlier in the same change.
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const hrv = num(readiness.hrv);
  const baseline = num(readiness.baselineMs);
  // ⚠ BOTH NUMBERS OR NEITHER. A current reading with no baseline is not a fact
  // about recovery, and showing it alone invites the comparison there is no
  // evidence for.
  const comparison = hrv !== null && baseline !== null
    ? `HRV ${Math.round(hrv * 10) / 10}ms vs ${Math.round(baseline)} baseline`
    : null;

  return (
    <div className={`rdy rdy--${tone}`}>
      <div className="rdy__dial" role="img"
           aria-label={`${dialValue} ${unit}`}>
        {Array.from({ length: DOTS }, (_, i) => (
          <span
            key={i}
            className={`rdy__dot${i < filled ? ' rdy__dot--on' : ''}`}
            style={{ transform: `rotate(${(i / DOTS) * 360}deg) translateY(-26px)` }}
          />
        ))}
        <span className="rdy__value">{dialValue}</span>
        <span className="rdy__unit">{unit}</span>
      </div>

      <div className="rdy__body">
        {/* ⚠ The brain's label. There is no verdict any more — see above: it
            was advice, and it was inverted. */}
        <div className="rdy__verdict">{readiness.label || '—'}</div>
        {comparison && <div className="rdy__compare">{comparison}</div>}
        {bars.length > 0 && (
          <>
            <div className="rdy__bars">
              {bars.map((v, i) => (
                <span
                  key={i}
                  /* ⚠ A 15% floor, so a genuine low still draws. A bar of zero
                     height reads as a MISSING day, which is a different fact. */
                  className={`rdy__bar${i === bars.length - 1 ? ' rdy__bar--today' : ''}`}
                  style={{ height: `${Math.max(15, v * 100)}%` }}
                />
              ))}
            </div>
            <div className="rdy__bars-label">HRV, last 7 days</div>
          </>
        )}
      </div>
    </div>
  );
}
