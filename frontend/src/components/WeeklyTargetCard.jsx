import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './WeeklyTargetCard.css';

/**
 * The week's task target on desktop Now (2 Nov 2026). Until now only SAiM's
 * Review screen and the standup could set it; Now showed nothing.
 *
 * The number is Nick's: NEURO's proposal is shown as a proposal with a
 * "Use N" button, never applied for him. `unset` is not a target of zero, and
 * an unreadable week is said, not drawn as an empty bar.
 */

export function WeeklyTargetView({ data, onSet, saving = false, refusal = null }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  if (!data) return null;
  if (data.known === false || data.state === 'unknown') {
    return <section className="adhd__card wt"><h3 className="adhd__h">This week</h3><p className="wt__note">{data.say || 'Couldn’t count this week’s tasks.'}</p></section>;
  }
  const isSet = data.target != null;
  const s = data.suggestion;
  const submit = async (e) => {
    e.preventDefault();
    const ok = await onSet(Number(value));
    if (ok) { setEditing(false); setValue(''); }
  };
  return (
    <section className="adhd__card wt" data-testid="weekly-target">
      <h3 className="adhd__h">This week</h3>
      {isSet && (
        <>
          <p className="wt__say">{data.say}</p>
          {Number.isFinite(data.fraction) && (
            <div className="wt__bar" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.round(data.fraction * 100))}%` }} /></div>
          )}
        </>
      )}
      {!isSet && <p className="wt__say">No target set for this week. <span className="wt__note">Unset isn’t a target of zero — it means the week hasn’t been given one yet.</span></p>}
      {isSet && !editing && (
        <button type="button" className="wt__btn wt__btn--quiet" onClick={() => { setEditing(true); setValue(String(data.target)); }}>Change this week’s target</button>
      )}
      {(!isSet || editing) && (
        <form className="wt__form" onSubmit={submit}>
          {s && s.value != null && (
            <span className="wt__note">
              NEURO suggests {s.value} — the {s.basis}{Array.isArray(s.weeks) && s.weeks.length ? ` (${s.weeks.join(', ')})` : ''}.{' '}
              <button type="button" className="wt__btn" disabled={saving} onClick={() => onSet(s.value).then((ok) => ok && setEditing(false))}>Use {s.value}</button>
            </span>
          )}
          {s && s.value == null && <span className="wt__note">No proposal yet — {s.basis}.</span>}
          <span className="wt__row">
            <input type="number" min="1" max={data.maxTarget || undefined} step="1" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Tasks to close this week" placeholder="tasks" />
            <button type="submit" className="wt__btn" disabled={saving || value === ''}>{saving ? 'Setting…' : 'Set'}</button>
            {isSet && <button type="button" className="wt__btn wt__btn--quiet" onClick={() => setEditing(false)}>Cancel</button>}
          </span>
        </form>
      )}
      {refusal && <p className="wt__err">Not set — {refusal}</p>}
    </section>
  );
}

export default function WeeklyTargetCard() {
  const [data, setData] = useState(null);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState(null);
  const load = () => apiFetch('/api/weekly-target').then((r) => (r.ok ? r.json() : null)).then((d) => d && setData(d)).catch(() => {});
  useEffect(() => { load(); }, []);
  const onSet = async (target) => {
    setSaving(true); setRefusal(null);
    try {
      const r = await apiFetch('/api/weekly-target', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, source: 'desktop-now' }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) { setRefusal(j.error || `${r.status}`); return false; }
      await load();
      return true;
    } catch (e) { setRefusal(e.message); return false; } finally { setSaving(false); }
  };
  return <WeeklyTargetView data={data} onSet={onSet} saving={saving} refusal={refusal} />;
}
