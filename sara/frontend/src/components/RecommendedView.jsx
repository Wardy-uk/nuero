import { useState } from 'react';
import { useSaraState } from '../state/saraState';
import { getView, normalizeViewId } from '../state/views';
import './RecommendedView.css';

// RecommendedView — the advisory context-inference strip (WS5-WP1).
//
// This is the frontend surface for the bounded inference the State Engine now folds
// into the one shared model (`model.inference`). It materially exposes, read-only:
//   * what SARA infers you're doing (activity/context summary)
//   * the one view SARA would recommend
//   * the confidence behind the inference
//   * the reasons/evidence (and any contradictions / missing-input notes)
//
// Critically it is ADVISORY ONLY. The recommendation is shown with a *manual* "Switch"
// button; there is no effect, timer, or auto-call to setCurrentView anywhere. SARA never
// changes the view on its own — the user decides. When inference can't recommend a view
// (incomplete/contradictory inputs), this says so honestly rather than inventing one.
export default function RecommendedView() {
  const { model, currentView, setCurrentView } = useSaraState();
  const [showWhy, setShowWhy] = useState(false);

  // No inference yet (older backend, or still connecting) -> render nothing rather than
  // fake a recommendation. Existing screens are unaffected.
  const inference = model?.inference;
  if (!inference) return null;

  const recId = normalizeViewId(inference.recommendedView);
  const recView = recId ? getView(recId) : null;
  const onRecommended = Boolean(recId && recId === currentView);
  const level = inference.confidence?.level;
  const score = inference.confidence?.score;
  const reasons = Array.isArray(inference.reasons) ? inference.reasons : [];
  const contradictions = Array.isArray(inference.contradictions) ? inference.contradictions : [];

  return (
    <aside className="advice" aria-label="SARA context inference">
      <div className="advice__top">
        <div className="advice__read">
          <span className="advice__eyebrow">SARA thinks</span>
          <span className="advice__summary">{inference.summary}</span>
        </div>
        {level && (
          <span className={`advice__confidence advice__confidence--${level}`}>
            {level}
            {typeof score === 'number' && ` · ${score}`}
          </span>
        )}
      </div>

      <div className="advice__rec">
        {recView ? (
          onRecommended ? (
            <span className="advice__suggest advice__suggest--here">
              Suggested view: <strong>{recView.label}</strong> — you're already here.
            </span>
          ) : (
            <>
              <span className="advice__suggest">
                Suggested view: <strong>{recView.label}</strong>
              </span>
              {/* Manual only — the single place a recommendation can become a switch,
                  and only on an explicit click. SARA never does this automatically. */}
              <button type="button" className="advice__switch" onClick={() => setCurrentView(recId)}>
                Switch to {recView.label}
              </button>
            </>
          )
        ) : (
          <span className="advice__none">No confident view to suggest right now.</span>
        )}

        <span className="advice__flag" title="SARA never changes the view on its own — this is advice only.">
          advisory · won't auto-switch
        </span>

        {(reasons.length > 0 || contradictions.length > 0) && (
          <button
            type="button"
            className="advice__why"
            aria-expanded={showWhy}
            onClick={() => setShowWhy((v) => !v)}
          >
            {showWhy ? 'Hide why' : 'Why?'}
          </button>
        )}
      </div>

      {showWhy && (
        <div className="advice__detail">
          {reasons.length > 0 && (
            <ul className="advice__reasons">
              {reasons.map((r, i) => (
                <li key={`r-${i}`}>{r}</li>
              ))}
            </ul>
          )}
          {contradictions.length > 0 && (
            <ul className="advice__contradictions">
              {contradictions.map((c, i) => (
                <li key={`c-${i}`}>⚠ {c}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}
