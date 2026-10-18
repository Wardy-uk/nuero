import React, { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './DrinksSection.css';

/**
 * Drinks and alcohol units (13 Oct 2026), from /api/health/drinks. Every number
 * is the server's; this renders it. Each drink shows HOW it was worked out —
 * strength from its name, volume from its own figures — and the calorie check
 * beside it, so a disagreement is visible rather than averaged away.
 */
// A stored UTC instant, shown in the reader's own time.
const when = (at) => {
  const ms = Date.parse(`${String(at).replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
};

// "Correct" writes Nick's own strength / kcal per 100 ml / not-a-drink into the
// drink database (18 Oct 2026); later lookups never overwrite it.
function Correct({ d, onSaved }) {
  const [open, setOpen] = useState(false);
  const [abv, setAbv] = useState(d.abv ?? '');
  const [kcal, setKcal] = useState(d.kcalPer100ml ?? '');
  const [msg, setMsg] = useState(null);
  const save = async (isDrink) => {
    setMsg(null);
    const body = isDrink
      ? { name: d.name, isDrink: true, kind: d.kind, abv: abv === '' ? null : Number(abv), kcalPer100ml: kcal === '' ? null : Number(kcal) }
      : { name: d.name, isDrink: false };
    const r = await apiFetch('/api/health/drinks/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const b = await r.json().catch(() => null);
    if (!r.ok || !b || !b.ok) { setMsg((b && b.error) || `HTTP ${r.status}`); return; }
    setOpen(false);
    if (onSaved) onSaved();
  };
  if (!open) return <button className="dr-fix" onClick={() => setOpen(true)}>Correct</button>;
  return (
    <span className="dr-form">
      <label>ABV <input type="number" step="0.1" min="0" max="80" value={abv} onChange={(e) => setAbv(e.target.value)} />%</label>
      <label>kcal <input type="number" step="1" min="0" max="600" value={kcal} onChange={(e) => setKcal(e.target.value)} />/100 ml</label>
      <button onClick={() => save(true)}>Save</button>
      <button onClick={() => save(false)}>Not a drink</button>
      <button onClick={() => setOpen(false)}>Cancel</button>
      {msg && <span className="dr-warn"> Not saved: {msg}</span>}
    </span>
  );
}

export function DrinksView({ data, onChanged }) {
  const drinks = data.drinks || [];
  return (
    <section className="hp-section dr" data-testid="drinks-section">
      <h3 className="hp-h3">Drinks <span className="hp-h3-note">last 7 days: {data.last7.units} units from {data.last7.drinks} drink{data.last7.drinks === 1 ? '' : 's'}{data.last7.unknown ? ` · ${data.last7.unknown} unknown` : ''}</span></h3>
      {drinks.length === 0
        ? <div className="hp-quiet">No drinks logged in the last 30 days in an app that names them. Log drinks in Foodnoms — MyFitnessPal sends no names, so NEURO can’t tell a drink there.</div>
        : (
          <ul className="dr-list">
            {drinks.slice(0, 20).map((d) => (
              <li key={d.item} className="dr-row">
                <div className="dr-main">
                  <span className="dr-name">{d.name}</span>
                  <span className="dr-when">{when(d.at)}</span>
                </div>
                <div className="dr-units">{d.units == null ? '?' : d.units}<span> units</span></div>
                <div className="dr-why">
                  {d.why}
                  {d.check && d.check.agree === true && <span className="dr-ok"> · its calories agree (about {d.check.volumeMl} ml)</span>}
                  {d.check && d.check.agree === false && <span className="dr-warn"> · {d.check.line}</span>}
                  {' '}<Correct d={d} onSaved={onChanged} />
                </div>
              </li>
            ))}
          </ul>
        )}
      {data.pendingNames ? <p className="hp-quiet dr-note">{data.pendingNames} logged name{data.pendingNames === 1 ? '' : 's'} not looked up yet.</p> : null}
      <p className="hp-quiet dr-note">{data.note}</p>
    </section>
  );
}

export default function DrinksSection() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [rev, setRev] = useState(0);
  useEffect(() => {
    let live = true;
    apiFetch('/api/health/drinks')
      .then(async (r) => { const b = await r.json().catch(() => null); if (!r.ok || !b || !b.ok) throw new Error((b && b.error) || `HTTP ${r.status}`); return b; })
      .then((b) => { if (live) setData(b); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [rev]);
  if (error) return <section className="hp-section dr"><h3 className="hp-h3">Drinks</h3><div className="hp-quiet hp-quiet--err">Could not read drinks: {error}. This is not the same as no drinks.</div></section>;
  if (!data) return <section className="hp-section dr"><h3 className="hp-h3">Drinks</h3><div className="hp-quiet">Loading…</div></section>;
  return <DrinksView data={data} onChanged={() => setRev((n) => n + 1)} />;
}
