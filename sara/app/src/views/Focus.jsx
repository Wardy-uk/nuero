import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';
import actionSurfaces from '../../../../shared/action-surfaces.cjs';
import { speakIfEnabled, isAudioUnlocked } from '../voiceUtils';
import { Lit } from '../../../shared-ui/Lit.jsx';
import './Focus.css';

// Focus = the single "what matters now" glance. Default view.
// Renders the brain's /api/focus: an optional SARA briefing, the recommended next
// action, then the prioritised items (tiered, scored, with a reason each).
const URGENCY = ['critical', 'high', 'medium', 'low'];
const { resolveSaraLitePlan } = actionSurfaces;

export default function Focus({ onNavigate, onActionIntent }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [dismissing, setDismissing] = useState({});

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await apiFetch('/api/focus');
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState({ loading: false, error: error.message, data: null });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // #111 — speak the briefing. NEURO's desktop BriefingPanel has done this since
  // voice shipped; the phone rendered it silently, which is the half that matters,
  // because SARA's job is to come to Nick rather than wait to be opened.
  //
  // Gated on the same persisted `sara_voice_out` toggle as Chat (OFF by default —
  // a PWA that talks unprompted on a train gets deleted), and spoken once per
  // distinct briefing rather than once per render or per poll.
  //
  // The retry is the part that makes it work on iOS at all: speechSynthesis needs a
  // user gesture first, and a cold start landing straight on Focus can render before
  // any touch has happened. Without this the briefing is dropped silently and looks
  // like the toggle is broken. So if audio is still locked we leave it UNSPOKEN and
  // try again on the next interaction.
  const spokenRef = useRef(null);
  useEffect(() => {
    const briefing = state.data?.sara?.briefing;
    if (!briefing || briefing === spokenRef.current) return;

    const say = () => {
      spokenRef.current = briefing;
      speakIfEnabled(briefing);
    };

    if (isAudioUnlocked()) { say(); return; }

    const onGesture = () => say();
    document.addEventListener('pointerdown', onGesture, { once: true });
    return () => document.removeEventListener('pointerdown', onGesture);
  }, [state.data?.sara?.briefing]);

  /**
   * Dismiss a card, through its RECORD wherever one can be found.
   *
   * ⚠ This screen renders `/api/focus`, so an item carries the decision-engine's
   * item id and nothing else — and that id is not the identity of anything
   * (`todo-overdue-top` becomes `todo-overdue-summary` the moment a second task
   * goes overdue, so a dismissal recorded against one silently stops applying).
   * `present().engineId` exists for exactly this lookup: find the record, then
   * act on the record.
   *
   * The Surface already works this way. Doing it here too is what stops one
   * screen teaching suppression while the other records a lifecycle, on the
   * same phone, about the same card.
   *
   * ⚠ The old route stays as the fallback and ONLY as the fallback — a phone
   * running this bundle against a backend without the records route must not
   * lose the ability to clear a card.
   */
  async function dismiss(item) {
    setDismissing((d) => ({ ...d, [item.id]: true }));
    try {
      let record = null;
      try {
        const open = await apiFetch('/api/attention/records');
        record = (open?.records || []).find((r) => r.engineId === item.id) || null;
      } catch { /* no records route, or NEURO is mid-restart — fall through */ }

      if (record) {
        await apiFetch(`/api/attention/records/${record.recordId}/act`, {
          method: 'POST',
          body: JSON.stringify({ action: 'dismiss' }),
        });
      } else {
        await apiFetch('/api/focus/dismiss', {
          method: 'POST',
          body: JSON.stringify({ itemId: item.id, itemType: item.type }),
        });
      }
      setState((s) => ({ ...s, data: { ...s.data, items: s.data.items.filter((i) => i.id !== item.id) } }));
    } catch { /* leave it in place if dismiss fails — a card that vanishes on an
                 error is a card Nick believes he has dealt with */ }
    finally { setDismissing((d) => ({ ...d, [item.id]: false })); }
  }

  function openUrl(url) {
    if (!url) return false;
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
      return true;
    } catch {
      return false;
    }
  }

  function presentIntent(intent, fallbackTab = 'focus') {
    const plan = resolveSaraLitePlan(intent);
    if (plan.presentation === 'external' && openUrl(intent.url)) return;
    if (plan.presentation === 'tab' && plan.tab) {
      onNavigate?.(plan.tab);
      return;
    }
    onActionIntent?.({
      source: intent.source || 'focus',
      tab: plan.tab || fallbackTab,
      type: intent.type || intent.kind || plan.kind,
      title: intent.title || intent.label || intent.reason || intent.kind || 'SARA action',
      url: intent.url || null,
      payload: {
        ...intent.payload,
        ...intent,
        kind: plan.kind,
      },
    });
  }

  function handleNextAction(action) {
    if (!action) return;
    presentIntent({
      ...action,
      source: 'focus-next',
      type: action.kind || action.type,
      title: action.label,
    });
  }

  function handleItemClick(item) {
    if (!item) return;
    if (openUrl(item.url || item.meta?.url)) return;
    presentIntent({
      ...item,
      source: 'focus-item',
      title: item.title,
      url: item.url || item.meta?.url || null,
      payload: { ...item, url: item.url || item.meta?.url || null },
    });
  }

  function onItemKeyDown(event, item) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleItemClick(item);
    }
  }

  const { loading, error, data } = state;

  return (
    <section>
      <div className="focus__head">
        <div>
          <h1 className="view__title">Focus</h1>
          <p className="view__lede">What matters right now.</p>
        </div>
        <button className="focus__refresh" type="button" onClick={load} aria-label="Refresh" title="Refresh">↻</button>
      </div>

      {loading && <Lit tone="statement">Asking the brain…</Lit>}

      {error && (
        /* ⚠ The one FAULT on this screen. "Nothing pressing" and "asking the
           brain" are statements; only a dead backend gets the alarm. */
        <Lit className="focus__fault err">
          Couldn’t reach the brain: {error}
          <div className="focus__hint">Check you’re on Tailscale and the PIN is right, or that the NEURO backend is up.</div>
        </Lit>
      )}

      {data && (
        <>
          {/* ⚠ HER SENTENCE, composed server-side and rendered verbatim — so a
              statement, not a control. It is the one thing on this screen she
              actually said. */}
          {data.sara?.briefing && <Lit tone="statement" className="focus__briefing">{data.sara.briefing}</Lit>}

          {data.nextAction && (
            /* ⚠ THE ONE LEAD, and the exception MANIFESTATION.md names: the
               centrepiece does not export to a list, but it belongs on a screen
               that genuinely has ONE answer — and "next action" is that answer
               by definition. Spending it twice would mean spending it nowhere,
               so the rows below are `row` and this is the only `lead` here. */
            <Lit
              as="button"
              tone="lead"
              type="button"
              className={`focus__next focus__u--${data.nextAction.urgency || 'medium'} focus__tap`}
              onClick={() => handleNextAction(data.nextAction)}
            >
              <div className="focus__next-label">Next</div>
              <div className="focus__next-title">{data.nextAction.label}</div>
              {data.nextAction.reason && <div className="focus__next-reason">{data.nextAction.reason}</div>}
            </Lit>
          )}

          {(!data.items || data.items.length === 0) && (
            <Lit tone="statement" className="focus__clear">Nothing pressing. You’re clear.</Lit>
          )}

          {(data.items || [])
            .slice()
            .sort((a, b) => URGENCY.indexOf(a.urgency) - URGENCY.indexOf(b.urgency) || (b.score || 0) - (a.score || 0))
            .map((item) => (
              /* ⚠ `row`, not `normal`: this is a ranked list to be scanned, and
                 a glow per line is haze rather than hierarchy (the Tasks rule). */
              <Lit
                tone="row"
                className={`focus__item focus__u--${item.urgency || 'low'} focus__tap`}
                key={item.id}
                role="button"
                tabIndex={0}
                onClick={() => handleItemClick(item)}
                onKeyDown={(event) => onItemKeyDown(event, item)}
              >
                <div className="focus__item-main">
                  <div className="focus__item-title">{item.title}</div>
                  {item.reason && <div className="focus__item-reason">{item.reason}</div>}
                  <div className="focus__item-meta">
                    <span className={`focus__badge focus__badge--${item.urgency || 'low'}`}>{item.urgency || 'low'}</span>
                    <span className="focus__type">{item.type}</span>
                    {typeof item.score === 'number' && <span className="focus__score">{Math.round(item.score)}</span>}
                  </div>
                </div>
                <button
                  className="focus__dismiss"
                  type="button"
                  onClick={(event) => { event.stopPropagation(); dismiss(item); }}
                  disabled={dismissing[item.id]}
                  aria-label="Dismiss"
                  title="Dismiss"
                >✕</button>
              </Lit>
            ))}
        </>
      )}
    </section>
  );
}
