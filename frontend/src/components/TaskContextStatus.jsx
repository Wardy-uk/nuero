import React, { useEffect, useState } from 'react';
import { apiFetch } from '../api';

// Brain Health's READ-ONLY view of automatic context linking (22 Oct 2026). The control
// itself lives in Settings (TaskContextActivation.jsx) and nowhere else — this file only
// ever GETs, and offers a way to Settings rather than a second switch.

const WALL = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const wall = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? WALL.format(new Date(t)) : null; };

export function StatusView({ status, error = null, onManage = null }) {
  if (!status) return error ? <p className="brain__note brain__note--err" role="alert">{error}</p> : null;
  const last = status.lastRun;
  const lastAt = last ? wall(last.finishedAt || last.startedAt) : null;
  const next = status.enabled ? wall(status.nextRun) : null;
  return (
    <section className="brain__ctx" aria-label="Automatic context linking (status)">
      <div className="brain__h brain__h--section">Automatic context linking</div>
      <p className={`brain__note${status.enabled ? '' : ' brain__note--wait'}`}>
        {status.enabled ? 'On' : 'Off'}. {status.enabled && next ? `Next run ${next}. ` : ''}
        {last ? `${status.lastResult || 'Last scan finished.'}${lastAt ? ` (${lastAt})` : ''}` : 'No scan has run yet.'}
      </p>
      {onManage
        ? <button type="button" className="brain__run" onClick={onManage}>Manage in Settings</button>
        : <p className="brain__scanned">Manage it in NEURO → Settings.</p>}
    </section>
  );
}

export default function TaskContextStatus({ onNavigate = null }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    apiFetch('/api/task-context/status').then((r) => r.json()).then((b) => {
      if (!live) return;
      if (b && b.ok) setStatus(b); else setError('Couldn’t read whether automatic context linking is on.');
    }).catch(() => { if (live) setError('NEURO didn’t answer.'); });
    return () => { live = false; };
  }, []);
  return <StatusView status={status} error={error} onManage={onNavigate ? () => onNavigate('admin') : null} />;
}
