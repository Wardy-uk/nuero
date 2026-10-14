import { pauseMinutesToEndOfDay } from './model.mjs';

// Controls: how and when SAiM may interrupt. Every value shown is what NEURO
// returned (GET/PATCH /api/attention/settings) — never a local guess at it.
//
// ⚠ This page does NOT subscribe to push. During the A/B run notifications are
//   delivered by the everyday SAiM; a second subscription from this origin
//   would double every notification. These settings are NEURO's, so they apply
//   to whatever delivers.

const LEVELS = [
  { id: 'all', label: 'Everything', hint: 'Anything NEURO ranks worth surfacing.' },
  { id: 'normal', label: 'Normal', hint: 'Skips low-urgency items.' },
  { id: 'critical-only', label: 'Critical only', hint: 'Escalations and imminent meetings.' },
];
const QUIET = [
  { id: null, label: 'NEURO default' },
  { id: 'off', label: 'None' },
  { id: '22:00-07:00', label: '22:00–07:00' },
  { id: '21:00-08:00', label: '21:00–08:00' },
  { id: '23:00-06:00', label: '23:00–06:00' },
];
const PAUSES = [
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 180, label: '3 hours' },
  { minutes: 'eod', label: 'Rest of today' },
];

const hhmm = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

function Choice({ on, children, onClick, disabled }) {
  return <button type="button" className={`v2-pill${on ? ' v2-pill--strong' : ''}`} aria-pressed={on} disabled={disabled} onClick={onClick}>{children}</button>;
}

export function ControlsPageView({ resp, now = Date.now(), busy = false, error = null, onPatch = null, notificationsHref = null }) {
  const s = resp && resp.settings;
  if (!s) {
    return <div className="v2-page"><section className="v2-card"><p className="v2-muted">{error ? `I can’t read SAiM’s settings — ${error}.` : 'Reading settings…'}</p></section></div>;
  }
  const patch = (p) => onPatch && onPatch(p);
  const off = !onPatch || busy;
  const pausedUntil = s.pausedUntil && new Date(s.pausedUntil).getTime() > now ? s.pausedUntil : null;
  const quietId = s.quietHoursSource === 'setting' ? s.quietHours : null;

  return (
    <div className="v2-page">
      {error && <p className="v2-stale" role="status">That didn’t save — {error}. Showing what NEURO last said.</p>}

      <section className="v2-card" aria-label="Notifications">
        <p className="v2-eyebrow">Notifications</p>
        <p className="v2-sub">During this comparison, notifications arrive through the everyday SAiM; this page never subscribes, so nothing is doubled. Tapping one that SAiM can handle opens it here.</p>
        <label className="v2-toggle">
          <input type="checkbox" checked={s.enabled !== false} disabled={off} onChange={(e) => patch({ enabled: e.target.checked })} />
          <span>Let SAiM interrupt me <span className="v2-muted v2-small">— off means she still collects; she just never pushes.</span></span>
        </label>
        {notificationsHref && <a className="v2-link" href={notificationsHref}>Notification permission lives in the everyday SAiM →</a>}
      </section>

      <section className="v2-card" aria-label="Interruption level">
        <p className="v2-eyebrow">How much gets through</p>
        <div className="v2-actions">
          {LEVELS.map((l) => <Choice key={l.id} on={s.interruptionLevel === l.id} disabled={off} onClick={() => patch({ interruptionLevel: l.id })}>{l.label}</Choice>)}
        </div>
        <p className="v2-muted v2-small">{(LEVELS.find((l) => l.id === s.interruptionLevel) || {}).hint || ''}</p>
      </section>

      <section className="v2-card" aria-label="Quiet hours">
        <p className="v2-eyebrow">Quiet hours</p>
        <div className="v2-actions">
          {QUIET.map((q) => <Choice key={q.label} on={quietId === q.id} disabled={off} onClick={() => patch({ quietHours: q.id })}>{q.label}</Choice>)}
        </div>
        <p className="v2-muted v2-small">Now: {s.quietHours === 'off' ? 'none' : s.quietHours}{s.quietHoursSource === 'setting' ? '' : ' (NEURO’s default)'}.</p>
      </section>

      <section className="v2-card" aria-label="Pause SAiM">
        <p className="v2-eyebrow">Pause SAiM</p>
        {pausedUntil
          ? <p className="v2-sub">Paused until {hhmm(pausedUntil)}. <button type="button" className="v2-link" disabled={off} onClick={() => patch({ pausedUntil: null })}>Resume now</button></p>
          : <p className="v2-muted v2-small">Not paused.</p>}
        <div className="v2-actions">
          {PAUSES.map((p) => (
            <Choice key={p.label} on={false} disabled={off} onClick={() => patch({ pauseMinutes: p.minutes === 'eod' ? pauseMinutesToEndOfDay(now) : p.minutes })}>{p.label}</Choice>
          ))}
        </div>
      </section>

      <section className="v2-card" aria-label="Work and personal">
        <p className="v2-eyebrow">What may interrupt</p>
        <label className="v2-toggle">
          <input type="checkbox" checked={s.domains?.work !== false} disabled={off} onChange={(e) => patch({ domains: { work: e.target.checked } })} />
          <span>Work</span>
        </label>
        <label className="v2-toggle">
          <input type="checkbox" checked={s.domains?.personal !== false} disabled={off} onChange={(e) => patch({ domains: { personal: e.target.checked } })} />
          <span>Personal</span>
        </label>
        <p className="v2-muted v2-small">Switching one off stops it interrupting; it is still collected and still shown when you look.</p>
      </section>
    </div>
  );
}
