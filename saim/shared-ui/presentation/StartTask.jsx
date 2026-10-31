import { useState } from 'react';
import { switchQuestion } from '../startTask.mjs';

// "Start this task" (31 Oct 2026): ONE primary button. `onStart({ force })` is the
// shell's — it starts the focus session (startTaskSession) and opens the Task
// workflow screen, and answers { ok } | { conflict: { text } } | { ok:false, error }.
// When another session is running, the question is asked HERE, inline, and only a
// yes retries with `force`. Nothing is switched without Nick saying so.
export default function StartTaskControl({ onStart, label = 'Start this task', className = 'kmw__open kmw__start' }) {
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(null);
  const [error, setError] = useState(null);
  const run = async (force = false) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await onStart({ force });
      if (r && r.conflict) setConflict(r.conflict);
      else { setConflict(null); if (r && r.ok === false && r.error) setError(r.error); }
    } catch {
      setError('NEURO didn’t answer, so nothing was started.');
    } finally { setBusy(false); }
  };
  if (conflict) {
    return (
      <div className="kmw__switch" role="group" aria-label="Switch focus">
        <p className="kmw__rowline">{switchQuestion(conflict.text)}</p>
        <div className="kmw__actions">
          <button type="button" className={className} disabled={busy} onClick={() => run(true)}>{busy ? 'Switching…' : 'Switch to this'}</button>
          <button type="button" className="kmw__choice" disabled={busy} onClick={() => setConflict(null)}>Not now</button>
        </div>
      </div>
    );
  }
  return (
    <div className="kmw__actions kmw__actions--start">
      <button type="button" className={className} disabled={busy} onClick={() => run(false)}>{busy ? 'Starting…' : label}</button>
      {error && <p className="kmw__rowline kmw__draft-error" role="status">{error}</p>}
    </div>
  );
}
