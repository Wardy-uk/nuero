import SharedAttentionCard, { taskDestination, cardDestination, NeedsYouActs } from '../../../saim/shared-ui/AttentionCard.jsx';
import { desktopCall } from '../desktopCall';

// The desktop's mount of the ONE attention card (6 Nov 2026). The card itself —
// buttons, wording, action semantics, "Move due date" — lives in
// `saim/shared-ui/AttentionCard.jsx` and every SAiM surface renders the same
// one. All this file adds is what only the desktop can do: navigate NEURO's
// views, and call NEURO with its own authenticated fetch.

export { taskDestination, cardDestination };

/** Navigation only: a destination's view + its pinning context. No request. */
export function desktopOpen(onNavigate) {
  return (card, destination) => {
    const d = destination || cardDestination(card);
    if (!d || !onNavigate) return false;
    onNavigate(d.view, { fromAttention: true, attentionCard: card, ...(d.context || {}) });
    return true;
  };
}

export function DesktopNeedsYouActs({ card, onNavigate, onAct }) {
  return <NeedsYouActs card={card} onOpen={onNavigate ? desktopOpen(onNavigate) : null} onAct={onAct} />;
}

export default function AttentionCard({ card, onNavigate, onAct, onStarted, onChanged = null, compact = false, showEvidence = true }) {
  return (
    <SharedAttentionCard
      card={card}
      onOpen={desktopOpen(onNavigate)}
      onAct={onAct}
      call={desktopCall}
      onStarted={onStarted}
      onChanged={onChanged}
      compact={compact}
      showEvidence={showEvidence}
    />
  );
}
