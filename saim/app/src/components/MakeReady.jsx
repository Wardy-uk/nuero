import { lazy, Suspense, useMemo, useState } from 'react';
import { makeItReady } from '../makeReady.mjs';
import { load, newSessionId } from '../preparedMove.mjs';
import { confirmIfReady } from './confirmIfReady.mjs';
import './MakeReady.css';

// Loaded only when a press reaches the Confirm step — Now's first paint stays small.
const PromiseSave = lazy(() => import('./PromiseSave.jsx'));

// The "Make this ready" control on a Now row — phone Now, and NEURO desktop's
// Now since 22 Oct 2026. Rendered ONLY for a row the server said SAiM can take
// forward (`item` from GET /api/prepared-moves/eligible); a row without one
// renders nothing. It sits AFTER the row's own action, so a meeting's own
// controls stay first. On the kiosk the shell passes `readOnly` and nothing is
// drawn. A press prepares THAT item (its exact ref, the same route as every
// other manual press) and — since 7 Nov 2026 — goes straight on, in the SAME
// press, to the Confirm step for that exact record, drawn right here (the same
// PromiseSave Drafts opens, so the same /request + /confirm routes). Only when
// there is nothing to confirm yet (a question, an interview, a hold) does it
// open the record's entry in Drafts as before.

/** PURE view. */
export function MakeReadyView({ item, result = null, busy = false, readOnly = false, onPress, onOpen }) {
  if (!item || readOnly) return null;
  if (result) {
    return (
      <div className="mr" role="status">
        <p className="mr__say">{result.kind === 'prepared' ? result.headline : result.message}</p>
        {(result.kind === 'prepared' || result.kind === 'already') && onOpen && <button type="button" className="mr__btn" onClick={() => onOpen(result.recordId || null)}>Open it in Drafts →</button>}
      </div>
    );
  }
  if (item.prepared) {
    return <div className="mr">{onOpen && <button type="button" className="mr__btn" onClick={() => onOpen(item.recordId || null)}>Open it in Drafts →</button>}</div>;
  }
  return (
    <div className="mr">
      <button type="button" className="mr__btn mr__btn--go" onClick={onPress} disabled={busy}>{busy ? 'Making it ready…' : item.label || 'Make this ready'}</button>
    </div>
  );
}

/**
 * `onOpenDraft(recordId | null)` — the shell opens Drafts at that record (or the
 * list when the server named none). Called straight after a press that prepared
 * the exact item, so Nick lands on what SAiM just made.
 */
export default function MakeReady({ item, call, readOnly = false, onOpenDraft = null }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [confirmAt, setConfirmAt] = useState(null);
  const sessionId = useMemo(() => newSessionId(), []);
  const press = async () => {
    setBusy(true);
    try {
      const r = await makeItReady(call, item);
      if (r.kind === 'prepared' && r.recordId) {
        // The press goes on to the Confirm step for THIS record (never "whatever is current").
        let next = null;
        try { next = await confirmIfReady(call, await load(call, { recordId: r.recordId }), sessionId); } catch { next = null; }
        if (next && (next.kind === 'confirming' || next.kind === 'boundary')) {
          setResult(r);
          setConfirmAt({ recordId: r.recordId, initial: next });
          return;
        }
      }
      setResult(r);
      if (r.kind === 'prepared' && r.recordId && onOpenDraft) onOpenDraft(r.recordId);
    } finally { setBusy(false); }
  };
  if (confirmAt && !readOnly) {
    return (
      <div className="mr mr--confirm" role="group" aria-label="Confirm what SAiM made ready">
        <p className="mr__say">{result && result.headline}</p>
        <Suspense fallback={<p className="mr__say">Opening the confirmation…</p>}>
          <PromiseSave recordId={confirmAt.recordId} call={call} drafts initial={confirmAt.initial} />
        </Suspense>
        {onOpenDraft && <button type="button" className="mr__btn" onClick={() => onOpenDraft(confirmAt.recordId)}>Open it in Drafts →</button>}
      </div>
    );
  }
  return <MakeReadyView item={item} result={result} busy={busy} readOnly={readOnly} onPress={press} onOpen={onOpenDraft} />;
}
