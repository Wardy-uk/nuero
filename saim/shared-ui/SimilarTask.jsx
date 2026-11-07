import { useState } from 'react';
import './SimilarTask.css';

/**
 * "Same as #N?" — answered where the task was just captured (7 Nov 2026).
 *
 * A capture always lands (the route never refuses a thought), and when it reads
 * like a task already open the server says which (`similar`). Before this the
 * desktop dropped that answer and SAiM said "merge them from Tasks on the
 * desktop" — a deferred chore. Now: Merge folds the NEW task into the one Nick
 * already had (POST /api/task-dedupe/merge — kept: the older; reversible with
 * unmerge), Keep both records that they differ so the matcher stops offering
 * the pair (internal-dismiss). The question stays until one is pressed.
 *
 * `call(path, {method, body}) → {status, body}`; null shows the note without
 * buttons.
 */
export default function SimilarTask({ newId, similar, call = null, onAnswered = null }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { tone, text }
  if (!similar || !similar.id || !newId || Number(similar.id) === Number(newId)) return null;
  const answer = async (merge) => {
    setBusy(true);
    try {
      const r = merge
        ? await call('/api/task-dedupe/merge', { method: 'POST', body: { keepId: Number(similar.id), dropId: Number(newId) } })
        : await call('/api/task-dedupe/internal-dismiss', { method: 'POST', body: { aId: Number(similar.id), bId: Number(newId), reason: 'kept both at capture' } });
      const ok = r && r.status === 200 && r.body && r.body.ok !== false && !r.body.error;
      const text = ok
        ? (merge ? `Merged — the new one is folded into #${similar.id}.` : `Kept both — NEURO won’t offer this pair again.`)
        : `${merge ? 'Not merged' : 'Not recorded'} — ${(r && r.body && (r.body.error || r.body.reason)) || `NEURO answered ${r && r.status}`}. Both are still on your list.`;
      setDone({ tone: ok ? 'ok' : 'bad', text });
      if (ok && onAnswered) onAnswered(merge ? 'merged' : 'kept');
    } catch (e) { setDone({ tone: 'bad', text: `Nothing changed — ${e.message}` }); }
    setBusy(false);
  };
  return (
    <div className="similar-task" role="group" aria-label="Possible duplicate" data-similar-id={similar.id}>
      {done && done.tone === 'ok'
        ? <p className="similar-task__say">{done.text}</p>
        : (
          <>
            <p className="similar-task__say">Same as #{similar.id} “{similar.text}”?{similar.why === 'meaning' ? ' (it means much the same)' : ''}</p>
            {call && (
              <div className="similar-task__acts">
                <button type="button" className="similar-task__go" disabled={busy} onClick={() => answer(true)}>Merge</button>
                <button type="button" className="similar-task__quiet" disabled={busy} onClick={() => answer(false)}>Keep both</button>
              </div>
            )}
            {done && <p className="similar-task__err">{done.text}</p>}
          </>
        )}
    </div>
  );
}
