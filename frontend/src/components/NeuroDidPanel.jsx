import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './NeuroDidPanel.css';

// ── What NEURO did — SYSTEM → "What NEURO did" (1 Nov 2026) ────────────────
//
// Everything NEURO did on its own in one week, and the misfires, so Nick can
// trust it or rein it in. The SERVER decides every line, its order and what it
// could not read (services/neuro-weekly-report.js); this renders it.
//
//   - "Misfires & things to check" comes FIRST, in the server's rank order.
//   - A source that could not be read is shown in amber — never as zero.
//   - "Not used yet" is a feature with no table yet, said plainly, not a fault.
//   - Every line names where to act (a view id) and opens it.

function initialWeek() {
  try { return new URLSearchParams(window.location.search).get('week') || ''; } catch { return ''; }
}

function Line({ item, onNavigate }) {
  if (item.view && onNavigate) {
    return (
      <button type="button" className="nd-line nd-line--link" onClick={() => onNavigate(item.view)} title={`Open ${item.view}`}>
        {item.text}<span className="nd-go" aria-hidden="true">→</span>
      </button>
    );
  }
  return <span className="nd-line">{item.text}</span>;
}

function Area({ a, onNavigate }) {
  return (
    <section className={`nd-area${a.informational ? ' nd-area--info' : ''}`} data-testid={`nd-area-${a.id}`}>
      <div className="nd-area-head">
        <h3>{a.label}</h3>
        {!a.informational ? <span className="nd-count">{a.acted}</span> : null}
        {onNavigate && a.view ? <button type="button" className="nd-open" onClick={() => onNavigate(a.view)}>Open</button> : null}
      </div>
      {a.stats && a.stats.length ? <p className="nd-stats">{a.stats.join(' · ')}</p> : null}
      {a.minutesSaved > 0 ? (
        <p className="nd-saved">{`Saved you about ${a.savedWords} — ${a.acted} × ${a.minutesEach} min ${a.savedWhat ? `(${a.savedWhat})` : ''}`}</p>
      ) : null}
      {a.items && a.items.length ? (
        <ul className="nd-items">
          {a.items.map((i, n) => <li key={n}><Line item={i} onNavigate={onNavigate} /></li>)}
          {a.more ? <li className="nd-more">{`and ${a.more} more`}</li> : null}
        </ul>
      ) : null}
    </section>
  );
}

/** The page body, rendered from the payload alone (exported for the render test). */
export function NeuroDidView({ data, week, setWeek, onNavigate = null, error = null }) {
  if (!data) return <p className="nd-meta">{error ? `Couldn’t load the report: ${error}` : 'Loading…'}</p>;
  const options = data.options || [];
  // Areas read fine and found nothing: one line, not a wall of zero cards.
  const quiet = (data.areas || []).filter((a) => !a.acted && !(a.items && a.items.length)).map((a) => a.label);
  return (
    <div className="nd-body">
      <div className="nd-head">
        <h2>{data.headline}</h2>
        <label className="nd-picker">
          Week{' '}
          <select value={week || data.week?.monday || ''} onChange={(e) => setWeek && setWeek(e.target.value)}>
            {options.map((o) => <option key={o.monday} value={o.monday}>{o.label}</option>)}
          </select>
        </label>
      </div>
      {data.timeSaved ? (
        <section className="nd-timesaved" data-testid="nd-timesaved">
          <p className="nd-timesaved-big">{data.timeSaved.minutes > 0 ? `Saved you about ${data.timeSaved.words}` : 'No time saved this week'}</p>
          {data.fiveWeekSaved && data.fiveWeekSaved.weeks > 1 ? (
            <p className="nd-meta">{`About ${data.fiveWeekSaved.words} over the last ${data.fiveWeekSaved.weeks} weeks`}
              {(data.recentWeeks || []).length ? ` (${(data.recentWeeks || []).map((w) => `${w.label}: ${w.minutes == null ? '?' : Math.round(w.minutes) + ' min'}`).join(' · ')})` : ''}</p>
          ) : null}
          <p className="nd-meta">Estimated — each kind of action counts a set number of minutes. <a href="#nd-estimates">Change the estimates</a></p>
        </section>
      ) : null}
      {data.week?.partial ? <p className="nd-meta">This week is still going — counts so far.</p> : null}
      {error ? <p className="nd-gap">Couldn’t refresh ({error}) — showing the last answer.</p> : null}

      <section className="nd-misfires" data-testid="nd-misfires">
        <h3>Misfires &amp; things to check</h3>
        {data.misfires && data.misfires.length ? (
          <ul className="nd-items">
            {data.misfires.map((m, n) => <li key={n} className={`nd-misfire nd-misfire--${m.kind}`}><Line item={m} onNavigate={onNavigate} /></li>)}
            {data.misfiresMore ? <li className="nd-more">{`and ${data.misfiresMore} more`}</li> : null}
          </ul>
        ) : <p className="nd-meta">{`Nothing to check${data.gaps && data.gaps.length ? ' in what NEURO could read' : ''}.`}</p>}
      </section>

      {data.gaps && data.gaps.length ? (
        <div className="nd-gap" role="note" data-testid="nd-gaps">
          <strong>Couldn’t read:</strong>
          <ul>{data.gaps.map((g) => <li key={g.area}>{g.label} — {g.why}</li>)}</ul>
          <p>Treat these as unknown, not as nothing.</p>
        </div>
      ) : null}

      {(data.areas || []).filter((a) => a.acted || (a.items && a.items.length)).map((a) => <Area key={a.id} a={a} onNavigate={onNavigate} />)}
      {quiet.length ? <p className="nd-meta" data-testid="nd-quiet">{`Nothing this week: ${quiet.join(', ')}.`}</p> : null}

      {data.notUsedYet && data.notUsedYet.length ? (
        <p className="nd-meta" data-testid="nd-not-used">{`Not used yet: ${data.notUsedYet.map((x) => x.label).join(', ')}.`}</p>
      ) : null}
    </div>
  );
}

/** The minutes per kind of action, editable (7 Nov 2026). */
export function EstimatesEditor({ estimates, onSave, busy = false, error = null }) {
  const [draft, setDraft] = useState({});
  if (!estimates) return null;
  return (
    <details className="nd-estimates" id="nd-estimates" data-testid="nd-estimates">
      <summary>Time-saved estimates ({estimates.filter((e) => e.changed).length} changed by you)</summary>
      {error ? <p className="nd-gap">{error}</p> : null}
      <table>
        <tbody>
          {estimates.map((e) => (
            <tr key={e.id}>
              <td>{e.what}</td>
              <td>
                <input type="number" min="0" max="240" step="0.05" aria-label={`Minutes for ${e.what}`}
                  value={draft[e.id] ?? e.minutes}
                  onChange={(ev) => setDraft((d) => ({ ...d, [e.id]: ev.target.value }))} /> min
              </td>
              <td>
                <button type="button" disabled={busy || draft[e.id] === undefined || Number(draft[e.id]) === e.minutes}
                  onClick={() => { onSave(e.id, Number(draft[e.id])); setDraft((d) => { const n = { ...d }; delete n[e.id]; return n; }); }}>Save</button>
                {e.changed ? <button type="button" className="nd-quiet" disabled={busy} onClick={() => onSave(e.id, null)}>{`Reset (${e.defaultMinutes})`}</button> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

export default function NeuroDidPanel({ onNavigate = null }) {
  const [week, setWeek] = useState(initialWeek);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/activity/weekly-report${week ? `?week=${encodeURIComponent(week)}` : ''}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) throw new Error(json.error || `${res.status}`);
      setData(json); setError(null);
    } catch (e) {
      setError(e.message); // keep the previous answer: blanking it would read as "nothing happened"
    }
  }, [week]);
  useEffect(() => { load(); }, [load]);
  const [estimates, setEstimates] = useState(null);
  const [estError, setEstError] = useState(null);
  const [estBusy, setEstBusy] = useState(false);
  useEffect(() => {
    apiFetch('/api/activity/weekly-report/estimates').then((r) => r.json()).then((j) => setEstimates(j.estimates || null)).catch(() => {});
  }, []);
  const saveEstimate = async (area, minutes) => {
    setEstBusy(true);
    try {
      const res = await apiFetch('/api/activity/weekly-report/estimates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ area, minutes }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(j.error || `${res.status}`);
      setEstimates(j.estimates); setEstError(null);
      await load();
    } catch (e) { setEstError(`Not saved — ${e.message}`); }
    setEstBusy(false);
  };
  return (
    <div className="nd-panel">
      <NeuroDidView data={data} week={week} setWeek={setWeek} onNavigate={onNavigate} error={error} />
      <EstimatesEditor estimates={estimates} onSave={saveEstimate} busy={estBusy} error={estError} />
    </div>
  );
}
