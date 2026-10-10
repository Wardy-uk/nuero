import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './JCRingPanel.css';

const METRICS = [
  ['heart_rate', 'Heart rate', 'bpm'],
  ['battery_level_percent', 'Battery', '%'],
  ['hrv', 'HRV', 'ms'],
  ['blood_oxygen_saturation', 'Blood oxygen', '%'],
  ['skin_temperature_celsius', 'Skin temperature', '°C'],
  ['vendor_bp_systolic_estimate', 'Ring BP estimate · systolic', 'mmHg'],
  ['vendor_bp_diastolic_estimate', 'Ring BP estimate · diastolic', 'mmHg'],
  ['vendor_vascular_age', 'Vendor vascular age', 'years'],
  ['vendor_stress_score', 'Vendor stress score', ''],
  ['vendor_heart_rate_during_hrv', 'Heart rate during HRV capture', 'bpm'],
];

function number(value) {
  if (!Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function when(value) {
  if (!value) return 'No reading yet';
  const parsed = new Date(value.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function JCRingPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiFetch('/api/health/ring-week');
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      setData(await response.json());
      setError(null);
    } catch (err) {
      setError(`Couldn't load direct-ring data: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return <main className="jr">
    <header className="jr-head">
      <div>
        <h1>JC Ring</h1>
        <p>Direct-ring readings, kept separate from Apple Watch and HiLo.</p>
      </div>
      <button className="jr-refresh" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
    </header>

    {error && <p className="jr-message jr-message--error">{error}</p>}
    {!data && !error && <p className="jr-message">Loading ring readings…</p>}
    {data && <>
      <section className="jr-section">
        <h2>Latest readings</h2>
        <div className="jr-grid">
          {METRICS.map(([key, label, unit]) => {
            const reading = data.latest?.[key];
            return <article className="jr-card" key={key}>
              <div className="jr-label">{label}</div>
              <div className="jr-value">{number(reading?.value)} <small>{reading ? unit : ''}</small></div>
              <div className="jr-at">{when(reading?.recorded_at_local)}</div>
              <details className="jr-history">
                <summary>History ({data.history?.[key]?.length || 0})</summary>
                <div className="jr-history-list">
                  {(data.history?.[key] || []).map((item, index) => <div key={`${item.recorded_at_local}-${item.sample_index}-${index}`}>
                    <span>{when(item.recorded_at_local)}</span><strong>{number(item.value)} {unit}</strong>
                  </div>)}
                  {!data.history?.[key]?.length && <span>No readings in the last week.</span>}
                </div>
              </details>
            </article>;
          })}
        </div>
      </section>

      <section className="jr-section jr-firmware">
        <h2>Firmware</h2>
        <div><span>Installed version</span><strong>{data.firmware?.installedVersion || 'Not read yet'}</strong></div>
        <p>{data.firmware?.latestStatus}</p>
        <p>NEURO can read the version. It will not attempt a firmware update without the manufacturer’s signed update file and exact update method.</p>
      </section>

      <section className="jr-section">
        <h2>This week</h2>
        <div className="jr-week">
          {(data.daily || []).map(row => <div className="jr-day" key={`${row.metric}-${row.day}`}>
            <span>{row.day} · {METRICS.find(metric => metric[0] === row.metric)?.[1] || row.metric}</span>
            <strong>{number(row.average)} {METRICS.find(metric => metric[0] === row.metric)?.[2]}</strong>
            <small>{row.samples} readings · range {number(row.minimum)}–{number(row.maximum)}</small>
          </div>)}
          {!data.daily?.length && <p className="jr-message">No direct-ring readings have been saved in the last week.</p>}
        </div>
      </section>

      <section className="jr-section">
        <h2>Known features awaiting direct capture</h2>
        <p className="jr-copy">These are advertised by the J2301 ring protocol, but are not presented as measurements until the replies from this ring have been decoded and checked.</p>
        <ul>{(data.notConnectedYet || []).map(item => <li key={item}>{item}</li>)}</ul>
      </section>
      <p className="jr-caution">Vendor fields — especially BP estimate, vascular age and stress — are for comparison only. They are not trusted health measurements. {data.caution}</p>
    </>}
  </main>;
}
