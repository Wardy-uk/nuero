import { useEffect, useRef } from 'react';
import ActionsPanel from './ActionsPanel';
import DraftsPage from './DraftsPage';

// "Waiting on your press" (Nick, 7 Nov 2026) — Drafts and Actions were two
// pages answering one question, and the same draft could sit in both with
// different buttons. One page now: drafted emails and invites first (the ones
// that leave the building), then what SAiM prepared (moves, saved drafts).
// Both halves are the existing components, unchanged, so nothing about how an
// item is sent or confirmed moved. `?view=drafts` deep links land on the second
// half, so an old link or a "make ready" still opens the exact draft.
export default function WaitingOnYourPress({ section = 'actions', context = null, onNavigate = null }) {
  const draftsRef = useRef(null);
  useEffect(() => {
    if (section === 'drafts' && draftsRef.current && draftsRef.current.scrollIntoView) {
      draftsRef.current.scrollIntoView({ block: 'start' });
    }
  }, [section]);
  return (
    <div className="main-view waiting-press" style={{ width: '100%' }}>
      <h1 style={{ margin: '12px 24px 4px' }}>Waiting on your press</h1>
      <p style={{ margin: '0 24px 12px', opacity: 0.75 }}>Everything NEURO and SAiM have prepared that needs a yes from you. One press sends or confirms each.</p>
      <section aria-label="Emails and invites">
        <ActionsPanel onNavigate={onNavigate} />
      </section>
      <section aria-label="Prepared drafts and moves" ref={draftsRef} id="waiting-drafts">
        <h2 style={{ margin: '24px 24px 4px' }}>Prepared by SAiM</h2>
        <DraftsPage context={context} onNavigate={onNavigate} />
      </section>
    </div>
  );
}
