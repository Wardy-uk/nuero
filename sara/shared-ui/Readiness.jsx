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
 * ⚠ `score` IS RECOVERY, NOT STRESS. `stress-score.js` returns a scale where
 * higher is better — 98 is fully recovered — and the dial fills UP as stress
 * rises, so it shows `100 - score`. Reading it the other way paints a good
 * morning as a crisis, which is why both implementations state it and both are
 * pinned by tests.
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

/** Thresholds lifted from the Scriptable widget rather than re-picked. */
function band(stress) {
  if (stress == null) return null;
  if (stress >= 60) return 'critical';
  if (stress >= 45) return 'high';
  if (stress >= 30) return 'elevated';
  return 'calm';
}

/** What the state ALLOWS, never what to do about it. */
function verdictFor(score, label) {
  if (score == null) return label || null;
  if (score >= 70) return 'Enough for a hard one';
  if (score >= 40) return 'Enough for an easy one';
  return 'Take it gently';
}

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
  const stress = score == null ? null : Math.max(0, Math.min(100, 100 - score));

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

  const dialValue = offDuty ? score : stress;
  const unit = offDuty ? 'ready' : 'stress';
  // ⚠ Colour follows STRESS in BOTH modes, so a green "ready" and a green
  // "stress" never mean opposite things on two screens.
  const tone = band(stress);
  const filled = Math.round((stress / 100) * DOTS);
  const bars = weekBars(readiness.hrvWeek);

  const hrv = Number(readiness.hrv);
  const baseline = Number(readiness.baselineMs);
  // ⚠ BOTH NUMBERS OR NEITHER. A current reading with no baseline is not a fact
  // about recovery, and showing it alone invites the comparison there is no
  // evidence for.
  const comparison = Number.isFinite(hrv) && Number.isFinite(baseline)
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
        <div className="rdy__verdict">{verdictFor(score, readiness.label)}</div>
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
