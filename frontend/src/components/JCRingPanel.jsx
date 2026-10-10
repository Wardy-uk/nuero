import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { TrendChart } from './HealthPanel';
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
  ['daily_steps', 'Daily steps', 'steps'],
  ['daily_active_time_minutes', 'Daily active time', 'min'],
  ['daily_active_minutes', 'Daily active minutes', 'min'],
  ['daily_distance_kilometres', 'Daily distance', 'km'],
  ['daily_calories_kilocalories', 'Daily calories', 'kcal'],
  ['daily_step_goal', 'Daily step goal', 'steps'],
  ['activity_detail_steps', 'Activity-bucket total steps', 'steps'],
  ['activity_detail_calories_kilocalories', 'Activity-bucket calories', 'kcal'],
  ['activity_detail_distance_kilometres', 'Activity-bucket distance', 'km'],
  ['activity_bucket_steps', 'Activity sub-bucket steps', 'steps'],
  ['sleep_duration_minutes', 'Sleep duration', 'min'],
  ['sleep_stage_code', 'Sleep stage · raw ring code', ''],
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

function chartRows(readings) {
  // The API deliberately supplies newest-first, matching the health-history
  // endpoint. TrendChart reverses that order so time reads left to right.
  return (readings || []).map(reading => ({
    day: reading.recorded_at_local,
    value: reading.value,
  }));
}

function ringTimeLabel(row, full) {
  if (!row?.day) return '';
  const parsed = new Date(row.day.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return row.day;
  return parsed.toLocaleString([], full
    ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' });
}

function MetabolicPpg({ data }) {
  const runs = data?.runs || [];
  if (!runs.length) return null;
  return <section className="jr-section">
    <h2>Metabolic PPG</h2>
    <p className="jr-copy">{data.note}</p>
    {runs.map((run, index) => {
      const values = run.waveform || [];
      const min = run.minimum;
      const range = Math.max(1, run.range);
      const path = values.map((value, point) => {
        const x = values.length < 2 ? 0 : (point / (values.length - 1)) * 100;
        const y = 100 - ((value - min) / range) * 100;
        return `${point ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
      }).join(' ');
      return <article className="jr-ppg" key={`${run.receivedAt}-${run.firstSequence}-${index}`}>
        <div className="jr-ppg-head"><strong>Capture {index + 1}</strong><span>{run.frameCount} frames · {run.sampleCount.toLocaleString()} samples</span></div>
        <svg className="jr-ppg-wave" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label={`Raw optical waveform for capture ${index + 1}`}>
          <path d={path} vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="jr-ppg-stats"><span>Low {number(run.minimum)}</span><span>Mean {number(run.average)}</span><span>High {number(run.maximum)}</span><span>Range {number(run.range)}</span></div>
        <div className="jr-ppg-stats jr-ppg-derived"><span>{run.signalQuality}</span><span>Pulse candidate {number(run.candidatePulseBpm)} bpm</span><span>Pulse variation {number(run.pulseIntervalVariabilityMs)} ms</span><span>Perfusion proxy {number(run.perfusionIndexPercent)}%</span><span>{run.missingFrames} dropped frames · {run.clippedSamples} clipped samples</span></div>
      </article>;
    })}
  </section>;
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
            </article>;
          })}
        </div>
      </section>

      <section className="jr-section">
        <h2>History · last seven days</h2>
        <div className="hp-grid jr-chart-grid">
          {METRICS.map(([key, label, unit]) => <TrendChart
            key={key}
            title={label}
            unit={unit ? ` ${unit}` : ''}
            dp={key === 'skin_temperature_celsius' ? 1 : 0}
            days={chartRows(data.history?.[key])}
            valueKey="value"
            xLabel={ringTimeLabel}
            note="Direct-ring readings, using the ring's recorded time."
          />)}
        </div>
      </section>

      <MetabolicPpg data={data.metabolicPpg} />

      <section className="jr-section"><h2>Sync timeline</h2><div className="jr-week">{(data.syncTimeline || []).map((event, index) => <div className="jr-day" key={`${event.receivedAt}-${index}`}><strong>{event.source} sync</strong><span>{when(event.receivedAt)} · {event.packets} packets</span></div>)}{!data.syncTimeline?.length && <p className="jr-message">New phone uploads will appear here with their manual/background source.</p>}</div></section>

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
