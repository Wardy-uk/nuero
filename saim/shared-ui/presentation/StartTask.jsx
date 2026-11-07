import { useState } from 'react';

// "Start this task" (31 Oct 2026): ONE primary button. `onStart()` is the
// shell's — it starts the focus session (startTaskSession) and opens the Task
// workflow screen, and answers { ok } | { ok:false, error }.
//
// ⚠ No switch question (7 Nov 2026): a session already running is PARKED by
// startTaskSession, and the Task workflow screen offers "Parked X — Resume it".
// Asking at the moment of starting was friction at the hardest moment.
export default function StartTaskControl({ onStart, label = 'Start this task', className = 'kmw__open kmw__start' }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await onStart({ force: true });
      if (r && r.ok === false && r.error) setError(r.error);
    } catch {
      setError('NEURO didn’t answer, so nothing was started.');
    } finally { setBusy(false); }
  };
  return (
    <div className="kmw__actions kmw__actions--start">
      <button type="button" className={className} disabled={busy} onClick={run}>{busy ? 'Starting…' : label}</button>
      {error && <p className="kmw__rowline kmw__draft-error" role="status">{error}</p>}
    </div>
  );
}
