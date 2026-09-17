import React, { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../api';
import './KpiTrackerPanel.css';

/**
 * The Daily KPI Tracker — what Nick reports to the business, live.
 *
 * ⚠ VANTAGE has this screen too, reading the same NOVA route. Both exist on
 * purpose and temporarily (Nick, 17 Sep 2026): he wants to find out which one
 * he actually opens. When he knows, the other goes. Neither proxies the other,
 * so they cannot disagree about the numbers.
 *
 * This renders. It does not judge — VANTAGE's detectors decide what counts as
 * drift, and a second opinion here would eventually contradict the one that
 * produces the warnings.
 *
 * Rows NOVA cannot compute are SHOWN, greyed, with the reason. A view listing
 * only the measurable rows would quietly redefine the tracker as the subset
 * NOVA happens to know — the same failure as a zero standing in for an absent
 * measurement.
 */

const RAG_CLASS = { red: 'kt-red', amber: 'kt-amber', green: 'kt-green' };

export default function KpiTrackerPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      // ⚠ NO `credentials: 'include'`. NEURO answers with
      // `Access-Control-Allow-Origin: *`, and the browser REFUSES a wildcard
      // origin on a credentialed request — the fetch throws "Failed to fetch"
      // before the response is ever looked at, which reads as the API being
      // down when it answered in 140ms. Auth is injected globally by the fetch
      // patch in api.js; no panel passes credentials, and this one should not
      // have either.
      const res = await fetch(apiUrl('/api/kpi-tracker'));
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Request failed');
      setData(json.data);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!data && !error) return <div className="kt-empty">Reading the tracker…</div>;

  const rows = data?.rows || [];
  const measured = rows.filter(r => r.measured);

  return (
    <div className="kt-wrap">
      <div className="kt-head">
        <div>
          <h2>Daily KPI Tracker</h2>
          <p className="kt-sub">
            The rows you report to the business, read live from NOVA.
          </p>
        </div>
        <button type="button" onClick={load} disabled={busy}>
          {busy ? 'Reading…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="kt-banner kt-bad">{error}</div>}

      {data && !data.available && (
        <div className="kt-banner kt-warn">
          The tracker could not be read — {data.reason}. Nothing below is current.
        </div>
      )}

      {data?.available && (
        <div className="kt-meta">
          {measured.length} of {rows.length} rows watched
          {data.live?.available
            ? <> · live as at {data.live.day}, {Math.round((data.live.ageSeconds ?? 0) / 60)} min old</>
            : <> · <span className="kt-warn-text">no live values ({data.live?.error || 'not read'})</span></>}
          {data.hourly?.available && data.hourly.daysCovered < 10 && (
            <> · hourly readings {data.hourly.daysCovered} of 10 days</>
          )}
        </div>
      )}

      {data?.available && (
        <table className="kt-table">
          <thead>
            <tr>
              <th>KPI</th>
              <th className="kt-num">now</th>
              <th className="kt-num">target</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key || r.label} className={r.measured ? '' : 'kt-unmeasured'}>
                <td>
                  {r.label}
                  {r.extra && <span className="kt-pill">extra</span>}
                </td>
                {r.measured
                  ? (
                    <>
                      <td className="kt-num">
                        <span className={RAG_CLASS[r.rag] || ''}>{r.value ?? '—'}</span>
                      </td>
                      <td className="kt-num kt-dim">{r.target ?? '—'}</td>
                    </>
                  )
                  : <td className="kt-note" colSpan={2}>not watched — {r.reason}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
