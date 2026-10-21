import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { executeDirect, directOutcome } from '../directAction';
import './LeaveClashes.css';

/**
 * Leave clashes (21 Oct 2026) — what already sits on Nick's booked leave, with
 * the fix NEURO worked out for each, applied in ONE tap (Nick's call). Items can
 * be unticked and dates/times edited first. Renders nothing when there are no
 * clashes, so Now carries no empty panel.
 *
 * Internal changes (task due dates, task blocks) and declines happen on the
 * server; moves and cancels of Nick's own meetings come back prepared and are
 * confirmed here with their own one-use grants — the same path as Book/Move.
 */

const VERB = { move: 'Move', cancel: 'Skip this one', decline: 'Decline', due: 'Re-date', block: 'Move block', info: '' };

function fmt(stamp) {
  if (!stamp) return '—';
  const d = new Date(`${stamp.slice(0, 10)}T12:00:00`);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return stamp.length > 10 ? `${day} ${stamp.slice(11, 16)}` : day;
}

function addMinutes(start, mins) {
  const [h, m] = start.slice(11, 16).split(':').map(Number);
  const t = h * 60 + m + mins;
  return `${start.slice(0, 11)}${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

export function LeaveClashesView({ data, onApplied, refresh }) {
  const items = (data.items || []).filter(i => i.action !== 'info');
  const info = (data.items || []).filter(i => i.action === 'info');
  const [ticked, setTicked] = useState(() => new Set(items.filter(i => i.action === 'decline' || i.proposed).map(i => i.id)));
  const [edits, setEdits] = useState({});
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');

  if (!items.length && !info.length && !(data.gaps || []).length) return null;

  const toggle = (id) => setTicked(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const apply = async () => {
    setBusy(true); setError('');
    try {
      const res = await apiFetch('/api/leave/clashes/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...ticked], edits }),
      });
      const d = await res.json();
      if (!d.results) { setError(d.error || 'Nothing was applied'); setBusy(false); return; }
      const out = [];
      const confirmed = [];
      for (const r of d.results) {
        if (!r.ok || !r.action) { out.push(r); continue; }
        const x = await executeDirect(r.action);
        out.push({ ...r, direct: x, detail: directOutcome(x).text });
        if (x.executed) confirmed.push(r.id);
      }
      if (confirmed.length) {
        await apiFetch('/api/leave/clashes/done', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: confirmed }),
        });
      }
      setResults(out);
      onApplied?.();
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const dismiss = async (id) => {
    await apiFetch('/api/leave/clashes/done', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id] }),
    });
    onApplied?.();
  };

  return (
    <section className="leave-clash">
      <header className="leave-clash__head">
        <div>
          <h3>Leave clashes</h3>
          <p>
            {(data.periods || []).map(p => `${fmt(p.from)}${p.to !== p.from ? `–${fmt(p.to)}` : ''} (back ${fmt(p.back)})`).join(' · ')}
          </p>
        </div>
        <button className="btn btn-small" onClick={refresh} disabled={busy}>Re-check</button>
      </header>

      {(data.gaps || []).map(g => <div key={g} className="leave-clash__gap">Couldn't check everything: {g}</div>)}

      {results ? (
        <ul className="leave-clash__results">
          {results.map(r => (
            <li key={r.id} className={(r.direct ? r.direct.executed : r.ok) ? 'ok' : 'bad'}>
              <strong>{r.title}</strong> — {r.error || r.detail || (r.ok ? 'done' : 'not done')}
            </li>
          ))}
        </ul>
      ) : (
        <>
          <table className="leave-clash__table">
            <thead><tr><th></th><th>What</th><th>Now</th><th>Fix</th><th>To</th><th>Why</th><th></th></tr></thead>
            <tbody>
              {items.map(i => {
                const e = edits[i.id] || {};
                return (
                  <tr key={i.id} className={ticked.has(i.id) ? '' : 'leave-clash__off'}>
                    <td><input type="checkbox" checked={ticked.has(i.id)} onChange={() => toggle(i.id)} /></td>
                    <td>{i.title}{i.person ? <div className="leave-clash__sub">1-2-1 with {i.person}</div> : null}</td>
                    <td>{fmt(i.when)}</td>
                    <td><span className={`leave-clash__verb leave-clash__verb--${i.action}`}>{VERB[i.action]}</span></td>
                    <td>
                      {(i.action === 'due' || i.action === 'block') && (
                        <input type="date" value={e.date ?? i.proposed?.date ?? ''}
                          onChange={ev => setEdits(p => ({ ...p, [i.id]: { date: ev.target.value } }))} />
                      )}
                      {i.action === 'move' && (i.proposed || e.start) && (() => {
                        const start = e.start ?? i.proposed.start;
                        const mins = i.proposed ? (Number(i.proposed.end.slice(11, 13)) * 60 + Number(i.proposed.end.slice(14, 16)))
                          - (Number(i.proposed.start.slice(11, 13)) * 60 + Number(i.proposed.start.slice(14, 16))) : 30;
                        return (
                          <input type="datetime-local" step="900" value={start}
                            onChange={ev => setEdits(p => ({ ...p, [i.id]: { start: ev.target.value, end: addMinutes(ev.target.value, mins) } }))} />
                        );
                      })()}
                      {i.action === 'move' && !i.proposed && !e.start && <span className="leave-clash__warn">no free slot found — pick one</span>}
                      {(i.action === 'decline' || i.action === 'cancel') && <span className="leave-clash__sub">organiser is told</span>}
                    </td>
                    <td className="leave-clash__why">
                      {i.why}
                      {i.fits === false && <div className="leave-clash__warn">not enough free time that day</div>}
                      {i.awayCheck === 'unknown' && <div className="leave-clash__warn" title={i.awayNote || ''}>their leave not checked</div>}
                    </td>
                    <td><button className="leave-clash__x" title="Leave this one as it is" onClick={() => dismiss(i.id)}>✕</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {info.length > 0 && (
            <p className="leave-clash__info">Also on your leave, left alone: {info.map(i => `${i.title} (${fmt(i.when)})`).join(', ')}</p>
          )}
          {data.note && <p className="leave-clash__info">{data.note}</p>}
          {error && <div className="leave-clash__gap">{error}</div>}
          <div className="leave-clash__actions">
            <button className="btn btn-primary" onClick={apply} disabled={busy || !ticked.size}>
              {busy ? 'Applying…' : `Apply ${ticked.size} fix${ticked.size === 1 ? '' : 'es'}`}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export default function LeaveClashes() {
  const [data, setData] = useState(null);
  const load = () => apiFetch('/api/leave/clashes').then(r => r.json()).then(d => setData(d.ok ? d : null)).catch(() => setData(null));
  const refresh = () => apiFetch('/api/leave/clashes/refresh', { method: 'POST' }).then(r => r.json()).then(d => setData(d.ok ? d : null)).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!data) return null;
  return <LeaveClashesView key={data.computedAt || 'x'} data={data} onApplied={load} refresh={refresh} />;
}
