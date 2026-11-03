import React, { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../api';
import './ChrisAgendaPage.css';

/**
 * To discuss with Chris (3 Nov 2026: its own page, Nick's call). The running
 * list from services/chris-agenda.js — add any time, tick when it has been
 * discussed (with Undo). Open items still go into the Monday report under
 * "To discuss with Chris", kept apart from "To escalate to Chris".
 */
export default function ChrisAgendaPage({ onNavigate } = {}) {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const [lastTicked, setLastTicked] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(apiUrl('/api/weekly-risk/chris-agenda?done=1')).then((res) => res.json());
      if (r.error) throw new Error(r.error);
      setData(r);
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function call(path, body) {
    setBusy(true); setError(null);
    try {
      const res = await fetch(apiUrl(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || 'Failed');
      await load();
      return r;
    } catch (e) { setError(e.message); return null; } finally { setBusy(false); }
  }

  const add = async (e) => {
    e.preventDefault();
    if (text.trim() && await call('/api/weekly-risk/chris-agenda', { text })) setText('');
  };
  const tick = async (item) => { if (await call(`/api/weekly-risk/chris-agenda/${encodeURIComponent(item.id)}/done`)) setLastTicked(item); };
  const restore = async (item) => { if (await call(`/api/weekly-risk/chris-agenda/${encodeURIComponent(item.id)}/restore`)) setLastTicked(null); };
  const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  return (
    <div className="ca-page">
      <div className="ca-head">
        <h1 className="ca-h1">To discuss with Chris</h1>
        <p className="ca-sub">
          A running list — it stays until you tick an item off. Everything open goes into the Monday report under its own heading, apart from the escalations.
          {onNavigate && <> <button type="button" className="ca-link" onClick={() => onNavigate('weekly-risk')}>Open the Monday report →</button></>}
        </p>
      </div>

      <form className="ca-add" onSubmit={add}>
        <input type="text" placeholder="Something to speak to Chris about…" maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" disabled={busy || !text.trim()}>Add</button>
      </form>

      {data && !data.known && <p className="ca-bad">The list could not be read — this is not an empty list.</p>}
      {data?.known && data.open.length === 0 && <p className="ca-empty">Nothing on the list.</p>}
      {data?.known && data.open.length > 0 && (
        <ul className="ca-list">
          {data.open.map((item) => (
            <li key={item.id}>
              <label className="ca-check">
                <input type="checkbox" checked={false} disabled={busy} onChange={() => tick(item)} title="Discussed — take it off the list" />
                <span>{item.text}</span>
              </label>
              <span className="ca-date">added {day(item.addedAt)}</span>
            </li>
          ))}
        </ul>
      )}
      {lastTicked && (
        <p className="ca-sub">Removed “{lastTicked.text}”. <button type="button" className="ca-link" onClick={() => restore(lastTicked)} disabled={busy}>Undo</button></p>
      )}

      {data?.done && data.done.length > 0 && (
        <details className="ca-done">
          <summary>Discussed recently ({data.done.length})</summary>
          <ul className="ca-list">
            {data.done.map((item) => (
              <li key={item.id}>
                <span className="ca-done-text">{item.text}</span>
                <span className="ca-date">ticked {day(item.doneAt)} <button type="button" className="ca-link" disabled={busy} onClick={() => restore(item)}>Put back</button></span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && <p className="ca-bad">{error}</p>}
    </div>
  );
}
