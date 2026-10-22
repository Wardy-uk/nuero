// The governed save step for a private draft, drawn IN its promise card
// (26 Oct 2026) — on NEURO desktop and the SAiM phone/web alike. It is SAiM's own
// PreparedMove, pinned to the one record (read by id on every load, never
// "whatever is current"), so the record, version, /request authority check,
// /confirm route and executor are the same as everywhere else: no second save
// path. "What SAiM may do" opens HERE, never on another screen, and the record
// (with its boundary) is read again when Nick comes back from it.
import { useState } from 'react';
import PreparedMove from './PreparedMove.jsx';
import Authority from '../views/Authority.jsx';

// `drafts` (22 Oct 2026): the same wrapper opens an item IN Drafts — the full item (its
// question, the draft, the save step) rather than the card's folded save step.
// `hideContextFor` / `onOpenContext` (22 Oct 2026): the page already shows context for that
// task (NEURO's Now, for the task in focus), so the card does not repeat it; how a note opens.
export default function PromiseSave({ recordId, call = null, onChanged = null, drafts = false, initial = null, hideContextFor = null, onOpenContext = null }) {
  const [authority, setAuthority] = useState(false);
  const [n, setN] = useState(0);
  if (!recordId) return null;
  return (
    <div className="promise-save">
      <PreparedMove key={`${recordId}:${n}`} call={call} recordId={recordId} embedded={!drafts} drafts={drafts} initial={n === 0 ? initial : null} readOnly={false} onOpenAuthority={() => setAuthority(true)} onChanged={onChanged} hideContextFor={hideContextFor} onOpenContext={onOpenContext} />
      {authority && (
        <div className="promise-save__authority">
          <Authority call={call} />
          <button type="button" className="kmw__choice" onClick={() => { setAuthority(false); setN((x) => x + 1); }}>Done — back to the draft</button>
        </div>
      )}
    </div>
  );
}
