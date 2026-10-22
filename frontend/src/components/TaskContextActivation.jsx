import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';

// Automatic context linking — the ONE human control that turns on the nightly
// task-context scan (22 Oct 2026). Off by default: deploying must never perform the
// backfill. Two steps, and the second quotes exactly what will happen (the server's
// own sentence), because the first enabled run IS the backfill over the whole vault.
// Machines cannot reach this (authority matrix + gateway interactive).

async function call(path, method = 'GET', body) {
  const res = await apiFetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

export function ActivationView({ status, step = 'idle', busy = false, ticked = false, result = null, error = null, onStart, onTick, onConfirm, onCancel, onDisable }) {
  if (!status) return null;
  const receipt = result && result.backfill;
  return (
    <section className="brain__ctx" aria-label="Automatic context linking">
      <div className="brain__h brain__h--section">Automatic context linking</div>
      <p className={`brain__note${status.enabled ? '' : ' brain__note--wait'}`}>{status.say}</p>
      {!status.enabled && step === 'idle' && (
        <button type="button" className="brain__run" onClick={onStart} disabled={busy}>Enable automatic context linking…</button>
      )}
      {!status.enabled && step === 'confirm' && (
        <div className="brain__confirm" role="group" aria-label="Confirm the backfill">
          <p><strong>What happens when you enable it:</strong> {status.enableSay}</p>
          <label className="brain__tick">
            <input type="checkbox" checked={ticked} onChange={(e) => onTick(e.target.checked)} />
            The vault cleanup is approved and done — run the backfill now.
          </label>
          <div className="brain__confirm-row">
            <button type="button" className="brain__run brain__run--write" disabled={!ticked || busy} onClick={onConfirm}>{busy ? 'Running the backfill…' : 'Run the backfill and enable'}</button>
            <button type="button" className="brain__run" disabled={busy} onClick={onCancel}>Cancel</button>
          </div>
        </div>
      )}
      {status.enabled && (
        <>
          <p className="brain__scanned">{status.schedule}.{status.lastRun ? ` Last run ${status.lastRun.finishedAt || status.lastRun.startedAt}${status.lastRun.ok ? '' : ' — failed'}.` : ''}</p>
          <button type="button" className="brain__run" disabled={busy} onClick={onDisable}>Turn automatic linking off</button>
        </>
      )}
      {receipt && (
        <p className="brain__scanned">Backfill: {receipt.tasks} open tasks against {receipt.notesEligible} usable notes — {receipt.pinned} pinned, {receipt.suggested} suggested{receipt.questions ? `, ${receipt.questions} question(s)` : ''}. Nothing was written to the vault.</p>
      )}
      {error && <p className="brain__note brain__note--err" role="alert">{error}</p>}
    </section>
  );
}

export default function TaskContextActivation() {
  const [status, setStatus] = useState(null);
  const [step, setStep] = useState('idle');
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    try {
      const r = await call('/api/task-context/status');
      if (r.body && r.body.ok) setStatus(r.body); else setError('Couldn’t read whether automatic context linking is on.');
    } catch { setError('NEURO didn’t answer.'); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const confirm = async () => {
    setBusy(true); setError(null);
    try {
      const r = await call('/api/task-context/activate', 'POST', { confirm: true });
      if (r.body && r.body.ok) { setResult(r.body); setStep('idle'); setTicked(false); } else setError((r.body && r.body.error) || `NEURO answered ${r.status}; nothing was enabled.`);
    } catch { setError('NEURO didn’t answer; nothing was enabled.'); }
    setBusy(false); load();
  };
  const disable = async () => {
    setBusy(true); setError(null);
    try { const r = await call('/api/task-context/deactivate', 'POST', {}); if (!r.body || !r.body.ok) setError((r.body && r.body.error) || 'Couldn’t turn it off.'); } catch { setError('NEURO didn’t answer.'); }
    setBusy(false); load();
  };
  return (
    <ActivationView status={status} step={step} busy={busy} ticked={ticked} result={result} error={error}
      onStart={() => setStep('confirm')} onTick={setTicked} onConfirm={confirm} onCancel={() => { setStep('idle'); setTicked(false); }} onDisable={disable} />
  );
}
