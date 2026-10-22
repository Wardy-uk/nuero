import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './TaskContextActivation.css';

// Automatic context linking — the ONE human control that turns the nightly task-context
// scan on or off (22 Oct 2026). It lives in SETTINGS and nowhere else: Brain Health
// only reports it (TaskContextStatus.jsx). Off by default: deploying must never perform
// the backfill. Two steps, and the second quotes exactly what will happen (the server's
// own sentence), because the first enabled run IS the backfill over the whole vault.
// Machines cannot reach this (authority matrix refuses + gateway marks it interactive).

async function call(path, method = 'GET', body) {
  const res = await apiFetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

const WALL = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** An ISO instant as London wall clock ("Thu 23 Oct, 03:40"); unreadable → null, never a guess. */
export function wallClock(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? WALL.format(new Date(t)) : null;
}

export function ActivationView({ status, step = 'idle', busy = false, ticked = false, result = null, error = null, onStart, onTick, onConfirm, onCancel, onDisable }) {
  if (!status) return error ? <p className="ctxset__note ctxset__note--err" role="alert">{error}</p> : null;
  const receipt = result && result.backfill;
  const last = status.lastRun;
  const lastAt = last ? wallClock(last.finishedAt || last.startedAt) : null;
  const next = status.enabled ? wallClock(status.nextRun) : null;
  return (
    <section className="ctxset" aria-label="Automatic context linking">
      <div className="ctxset__head">
        <span className={`ctxset__state ctxset__state--${status.enabled ? 'on' : 'off'}`}>{status.enabled ? 'On' : 'Off'}</span>
        <p className={`ctxset__note${status.enabled ? '' : ' ctxset__note--wait'}`}>{status.say}</p>
      </div>
      {status.whatItDoes && <p className="ctxset__what">{status.whatItDoes}</p>}
      <dl className="ctxset__facts">
        <dt>Schedule</dt><dd>{status.schedule}{status.enabled ? '' : ' — once enabled'}</dd>
        <dt>Next run</dt><dd>{status.enabled ? (next || 'Not known') : 'None — it is off'}</dd>
        <dt>Last result</dt><dd>{last ? `${status.lastResult || ''}${lastAt ? ` (${lastAt})` : ''}` : 'No scan has run yet'}</dd>
      </dl>
      {!status.enabled && step === 'idle' && (
        <button type="button" className="ctxset__btn" onClick={onStart} disabled={busy}>Enable automatic context linking…</button>
      )}
      {!status.enabled && step === 'confirm' && (
        <div className="ctxset__confirm" role="group" aria-label="Confirm the backfill">
          <p><strong>What happens when you enable it:</strong> {status.enableSay}</p>
          <label className="ctxset__tick">
            <input type="checkbox" checked={ticked} onChange={(e) => onTick(e.target.checked)} />
            The vault cleanup is approved and done — run the backfill now.
          </label>
          <div className="ctxset__row">
            <button type="button" className="ctxset__btn ctxset__btn--write" disabled={!ticked || busy} onClick={onConfirm}>{busy ? 'Running the backfill…' : 'Run the backfill and enable'}</button>
            <button type="button" className="ctxset__btn" disabled={busy} onClick={onCancel}>Cancel</button>
          </div>
        </div>
      )}
      {status.enabled && (
        <button type="button" className="ctxset__btn" disabled={busy} onClick={onDisable}>Turn automatic linking off</button>
      )}
      <p className="ctxset__aside">Linking a note to a task by hand works whether this is on or off.</p>
      {receipt && (
        <p className="ctxset__aside">Backfill: {receipt.tasks} open tasks against {receipt.notesEligible} usable notes — {receipt.pinned} pinned, {receipt.suggested} suggested{receipt.questions ? `, ${receipt.questions} question(s)` : ''}. Nothing was written to the vault.</p>
      )}
      {error && <p className="ctxset__note ctxset__note--err" role="alert">{error}</p>}
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
