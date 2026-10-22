import { useState } from 'react';
import { makeItReady } from '../makeReady.mjs';
import './MakeReady.css';

// The "Make this ready" control on a Now row — phone Now, and NEURO desktop's
// Now since 22 Oct 2026. Rendered ONLY for a row the server said SAiM can take
// forward (`item` from GET /api/prepared-moves/eligible); a row without one
// renders nothing. It sits AFTER the row's own action, so a meeting's own
// controls stay first. On the kiosk the shell passes `readOnly` and nothing is
// drawn. A press prepares THAT item (its exact ref, the same route as every
// other manual press) and then opens its exact entry in Drafts.

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
  const press = async () => {
    setBusy(true);
    try {
      const r = await makeItReady(call, item);
      setResult(r);
      if (r.kind === 'prepared' && r.recordId && onOpenDraft) onOpenDraft(r.recordId);
    } finally { setBusy(false); }
  };
  return <MakeReadyView item={item} result={result} busy={busy} readOnly={readOnly} onPress={press} onOpen={onOpenDraft} />;
}
