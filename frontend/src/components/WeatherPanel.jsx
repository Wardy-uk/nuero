import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { apiFetch } from '../api';
import './WeatherPanel.css';
import { RainChart, SourcesStrip, NearbyStations, rainQuery } from './WeatherRain';

// ── The Weather screen ──────────────────────────────────────────────────────
//
// The outdoor station's minute readings, the forecast overlaid on them, and the
// 6/12/24 hour outlook — all from ONE payload (`GET /api/weather/overview`), so
// the summary and the charts describe the same moment.
//
// ⚠ LOCAL vs FORECAST MUST READ APART AT A GLANCE, and colour alone is not
// allowed to carry it: the local sensor is a SOLID line, the forecast DASHED and
// a different hue (palette validated on the dark card surface: CVD ΔE 25), and
// every chart names both in a legend. The tooltip spells out which is which.
//
// ⚠ TIMES ARE EUROPE/LONDON, EXPLICITLY. Instants come from the server in epoch
// ms; they are formatted with an explicit time zone rather than the browser's,
// because a laptop set to UTC would otherwise show every summer reading an hour
// out on a screen whose whole job is "when".
//
// ⚠ THE SERVER DECIDES. Staleness, the summary wording and the forecast
// alignment are composed in the backend and rendered here; this file does not
// re-judge any of them.

const TZ = 'Europe/London';
const LOCAL_LABEL = 'Local sensor';

export const METRICS = [
  { key: 'temperatureC', title: 'Temperature', unit: '°C', dp: 1 },
  { key: 'humidityPct', title: 'Relative humidity', unit: '%', dp: 0 },
  { key: 'pressureHpa', title: 'Pressure', unit: ' hPa', dp: 1, alignForecast: true,
    hint: 'Station pressure, not sea-level. The model’s surface pressure sits at a different height, so where the two overlap the forecast line is drawn shifted by their median difference — the shape is what is comparable. The tooltip gives the forecast as issued.' },
];

const fmtCache = new Map();
function fmt(opts) {
  const k = JSON.stringify(opts);
  if (!fmtCache.has(k)) fmtCache.set(k, new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...opts }));
  return fmtCache.get(k);
}

/** Axis label for an instant, by range. Europe/London. */
export function tickLabel(ms, range) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  if (range === 'hour' || range === 'day') return fmt({ hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  if (range === 'week') return fmt({ weekday: 'short', day: 'numeric' }).format(d);
  if (range === 'month') return fmt({ day: 'numeric', month: 'short' }).format(d);
  return fmt({ month: 'short', year: '2-digit' }).format(d);
}

/** The exact timestamp a tooltip shows. Europe/London, with the zone named. */
export function exactTime(ms, bucketMs) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const day = fmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  if (bucketMs >= 24 * 3600000) return day;
  const time = fmt({ hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).format(d);
  if (bucketMs <= 60000) return `${day}, ${time}`;
  const end = fmt({ hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms + bucketMs));
  return `${day}, ${time.replace(/\s\S+$/, '')}–${end} ${time.split(' ').pop()}`;
}

export function ageWords(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** Minutes Europe/London is ahead of UTC at an instant (0 in winter, 60 in summer). */
export function londonOffsetMin(ms) {
  const parts = fmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const g = (t) => Number(parts.find((p) => p.type === t)?.value);
  return Math.round((Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - Math.floor(ms / 60000) * 60000) / 60000);
}

const MIN = 60000;
const TICK_STEPS = { hour: [10 * MIN, 15 * MIN, 30 * MIN], day: [3 * 60 * MIN, 6 * 60 * MIN, 12 * 60 * MIN], week: [24 * 60 * MIN, 48 * 60 * MIN], month: [5 * 1440 * MIN, 7 * 1440 * MIN, 10 * 1440 * MIN] };

/**
 * Tick instants on round Europe/London boundaries — 15 past, 06:00, midnight,
 * the 1st of the month — rather than evenly spaced instants that land on 14:17.
 */
export function niceTicks(from, to, range, max = 5) {
  if (!(to > from)) return [];
  const out = [];
  if (range === 'year') {
    const d = new Date(from);
    let y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    for (let i = 0; i < 15; i++, m++) {
      if (m > 11) { m -= 12; y++; }
      const utcMidnight = Date.UTC(y, m, 1);
      const t = utcMidnight - londonOffsetMin(utcMidnight) * MIN;
      if (t > from && t < to) out.push(t);
    }
    const k = Math.ceil(out.length / max);
    return out.filter((_, i) => i % k === 0);
  }
  const steps = TICK_STEPS[range] || [Math.ceil((to - from) / max)];
  const step = steps.find((st) => (to - from) / st <= max) || steps[steps.length - 1];
  const off = londonOffsetMin(from) * MIN;
  for (let t = Math.ceil((from + off) / step) * step - off; t < to; t += step) {
    // A whole-day step re-reads the offset so midnight stays midnight across a clock change.
    out.push(step >= 1440 * MIN ? t - (londonOffsetMin(t) * MIN - off) : t);
  }
  return out;
}

/**
 * The median gap between two series where both have a value. PURE. Used only
 * to draw the forecast pressure on the station's level; null when they never
 * overlap, so nothing is shifted on a guess.
 */
export function medianOffset(a, b) {
  const d = [];
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) d.push(a[i] - b[i]);
  if (d.length < 3) return null;
  d.sort((x, y) => x - y);
  const m = Math.floor(d.length / 2);
  return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
}

const num = (v, dp) => (Number.isFinite(v) ? v.toFixed(dp) : '—');

/** Break a series into unbroken runs — a gap is drawn as a gap. */
function runs(points) {
  const out = [];
  let cur = [];
  for (const p of points) {
    if (Number.isFinite(p.v)) cur.push(p);
    else if (cur.length) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}

export function WeatherChart({ metric, series, plan, range, forecastLabel }) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(560);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => { const w = e?.contentRect?.width; if (w) setWidth(Math.round(w)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const W = width, H = 150, PAD_L = 44, PAD_R = 8, PAD_T = 10, PAD_B = 26;
  const AXIS_Y = H - PAD_B;
  const from = plan.fromMs;
  const to = plan.toMs;
  const mid = (t) => t + plan.bucketMs / 2;

  const local = series.map((s) => ({ t: mid(s.t), v: s.local?.[metric.key] ?? null }));
  const rawFc = series.map((s) => s.forecast?.[metric.key] ?? null);
  const offRaw = metric.alignForecast ? medianOffset(local.map((p) => p.v), rawFc) : null;
  // Below 1 hPa the two already sit together; shifting would be fussing.
  const shift = offRaw != null && Math.abs(offRaw) >= 1 ? offRaw : 0;
  const fc = rawFc.map((v, i) => ({ t: local[i].t, v: Number.isFinite(v) ? v + shift : null }));
  const values = [...local, ...fc].map((p) => p.v).filter(Number.isFinite);
  const hasLocal = local.some((p) => Number.isFinite(p.v));
  const hasForecast = fc.some((p) => Number.isFinite(p.v));

  let lo = values.length ? Math.min(...values) : 0;
  let hi = values.length ? Math.max(...values) : 1;
  if (hi - lo < 1) { const c = (hi + lo) / 2; lo = c - 0.5; hi = c + 0.5; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;

  const x = (t) => PAD_L + ((t - from) / Math.max(1, to - from)) * (W - PAD_L - PAD_R);
  const y = (v) => PAD_T + (1 - (v - lo) / (hi - lo)) * (AXIS_Y - PAD_T);
  const path = (run) => {
    const d = run.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
    // A lone reading is a zero-length segment — with a round cap, a dot.
    return run.length === 1 ? `${d} L${x(run[0].t).toFixed(1)} ${y(run[0].v).toFixed(1)}` : d;
  };

  const ticks = useMemo(() => niceTicks(from, to, range, width < 420 ? 3 : 5), [from, to, range, width]);
  const yTicks = [lo + pad, (lo + hi) / 2, hi - pad];

  const now = plan.nowMs;
  const showNow = now > from && now < to - plan.bucketMs;

  function onMove(e) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || !series.length) return;
    const rel = ((e.clientX - rect.left) / rect.width) * W;
    const t = from + ((rel - PAD_L) / (W - PAD_L - PAD_R)) * (to - from);
    const i = Math.round((t - from) / plan.bucketMs - 0.5);
    setHover(Math.max(0, Math.min(series.length - 1, i)));
  }

  const hv = hover == null ? null : series[hover];
  const lv = hv?.local?.[metric.key];
  // The tooltip gives the forecast AS ISSUED, never the shifted drawing value.
  const fv = hv?.forecast?.[metric.key];
  const fvDrawn = Number.isFinite(fv) ? fv + shift : null;

  return (
    <section className="wx-chart" aria-label={`${metric.title} chart`}>
      <header className="wx-chart-head">
        <h3>{metric.title}</h3>
        <div className="wx-legend">
          <span className="wx-legend-item"><span className="wx-key wx-key--local" />{LOCAL_LABEL}</span>
          <span className={`wx-legend-item${hasForecast ? '' : ' wx-legend-item--absent'}`}>
            <span className="wx-key wx-key--forecast" />Forecast{forecastLabel ? ` (${forecastLabel})` : ''}
            {shift !== 0 && `, shifted ${shift > 0 ? '+' : '−'}${Math.abs(shift).toFixed(1)}${metric.unit} to the station’s level`}
            {!hasForecast && ' — none for this window'}
          </span>
        </div>
      </header>
      <div className="wx-plot" ref={wrapRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
          aria-label={`${metric.title}: local sensor solid line, forecast dashed line`}>
          {yTicks.map((v, i) => (
            <g key={i}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} className="wx-grid" />
              <text x={PAD_L - 6} y={y(v) + 4} textAnchor="end" className="wx-ytick">{num(v, metric.dp)}</text>
            </g>
          ))}
          {showNow && (
            <g>
              <line x1={x(now)} x2={x(now)} y1={PAD_T} y2={AXIS_Y} className="wx-now" />
              <text x={x(now) + 4} y={PAD_T + 9} className="wx-now-label">now</text>
            </g>
          )}
          {runs(fc).map((r, i) => <path key={`f${i}`} d={path(r)} className="wx-line wx-line--forecast" />)}
          {runs(local).map((r, i) => <path key={`l${i}`} d={path(r)} className="wx-line wx-line--local" />)}
          <line x1={PAD_L} x2={W - PAD_R} y1={AXIS_Y} y2={AXIS_Y} className="wx-axis" />
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={x(t)} x2={x(t)} y1={AXIS_Y} y2={AXIS_Y + 3} className="wx-axis" />
              <text x={x(t)} y={AXIS_Y + 16} className="wx-xtick" textAnchor="middle">{tickLabel(t, range)}</text>
            </g>
          ))}
          {hv && (
            <g>
              <line x1={x(mid(hv.t))} x2={x(mid(hv.t))} y1={PAD_T} y2={AXIS_Y} className="wx-crosshair" />
              {Number.isFinite(fvDrawn) && <circle cx={x(mid(hv.t))} cy={y(fvDrawn)} r="4" className="wx-dot wx-dot--forecast" />}
              {Number.isFinite(lv) && <circle cx={x(mid(hv.t))} cy={y(lv)} r="4" className="wx-dot wx-dot--local" />}
            </g>
          )}
        </svg>
        {!hasLocal && <div className="wx-plot-empty">No station readings in this window</div>}
        {hv && (
          <div className="wx-tip" style={{ left: `${(x(mid(hv.t)) / W) * 100}%` }} role="status">
            <div className="wx-tip-time">{exactTime(hv.t, plan.bucketMs)}</div>
            <div><span className="wx-key wx-key--local" />{LOCAL_LABEL}: <strong>{Number.isFinite(lv) ? `${num(lv, metric.dp)}${metric.unit}` : 'no reading'}</strong>
              {plan.bucketMs > 60000 && hv.n > 0 && <span className="wx-tip-n"> · mean of {hv.n}</span>}</div>
            <div><span className="wx-key wx-key--forecast" />Forecast: <strong>{Number.isFinite(fv) ? `${num(fv, metric.dp)}${metric.unit}` : 'none'}</strong>
              {Number.isFinite(fv) && shift !== 0 && <span className="wx-tip-n"> as issued</span>}</div>
          </div>
        )}
      </div>
      {metric.hint && <p className="wx-chart-hint">{metric.hint}</p>}
    </section>
  );
}

// ── The outlook, split ──────────────────────────────────────────────────────
//
// What the SENSOR says and what the FORECAST says are two cards, never one
// blended paragraph — so every claim on screen has an obvious source. A third
// strip says whether they agree. All wording is the server's.

const VERDICT_LABEL = {
  agree: 'Agree', partial: 'Partly agree', disagree: 'Disagree',
  'forecast-only': 'Forecast only', 'sensor-only': 'Sensor only', none: 'Nothing to compare',
};
const CONFIDENCE_LABEL = { good: 'Good confidence', moderate: 'Moderate confidence', low: 'Low confidence' };
const HORIZON_LABEL = { 6: 'Next 6 h', 12: 'Next 12 h', 24: 'Next 24 h' };

function SensorCard({ sensor }) {
  return (
    <section className="wx-card wx-card--sensor" aria-label="What the sensor says">
      <h2><span className="wx-key wx-key--local" />What the sensor says</h2>
      <p className="wx-verdict">{sensor.verdict}</p>
      {sensor.available && <p className="wx-scope">A barometer speaks for the next few hours (about {sensor.horizonHours}).</p>}
      {sensor.lines?.length > 0 && (
        <ul className="wx-lines">
          {sensor.lines.map((l) => (
            <li key={l.label} className={l.used ? '' : 'wx-line-item--unused'}>
              <div className="wx-line-row">
                <span className="wx-line-label">{l.label}</span>
                <span className="wx-line-value">{l.value}</span>
                {!l.used && <span className="wx-tag">not used</span>}
              </div>
              <div className="wx-line-note">{l.note}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ForecastCard({ forecast, nowMs }) {
  return (
    <section className="wx-card wx-card--forecast" aria-label="What the forecast says">
      <h2><span className="wx-key wx-key--forecast" />What the forecast says</h2>
      {!forecast.available ? <p className="wx-verdict">No forecast available.</p> : (
        <>
          <ul className="wx-horizons">
            {forecast.horizons.map((h) => (
              <li key={h.hours}>
                <span className="wx-line-label">{HORIZON_LABEL[h.hours] || `Next ${h.hours} h`}</span>
                <span className={`wx-horizon-words wx-rain--${h.rain}`}>{h.words || 'no data'}</span>
                {h.temperature && <span className="wx-horizon-temp">{h.temperature}</span>}
              </li>
            ))}
          </ul>
          <p className="wx-scope">
            {forecast.provider}{Number.isFinite(forecast.issuedAt) ? `, fetched ${ageWords(nowMs - forecast.issuedAt)}` : ''}.
          </p>
        </>
      )}
    </section>
  );
}

export function Outlook({ summary, nowMs }) {
  if (!summary) return null;
  // A backend older than the split sends only the paragraph — render that rather than nothing.
  if (!summary.sensor || !summary.forecast) {
    return <section className="wx-summary" aria-label="Outlook"><p className="wx-summary-text">{summary.paragraph}</p></section>;
  }
  const c = summary.comparison || {};
  return (
    <div className="wx-outlook" aria-label="Outlook">
      <div className="wx-outlook-cards">
        <SensorCard sensor={summary.sensor} />
        <ForecastCard forecast={summary.forecast} nowMs={nowMs} />
      </div>
      <section className={`wx-together wx-together--${c.verdict || 'none'}`} aria-label="Together">
        <div className="wx-together-head">
          <h2>Together</h2>
          <span className="wx-conf">{VERDICT_LABEL[c.verdict] || '—'} · {CONFIDENCE_LABEL[summary.confidence] || 'Low confidence'}</span>
        </div>
        <p className="wx-summary-text">{c.text}</p>
        {c.watch && <p className="wx-watch"><strong>Watch for:</strong> {c.watch}</p>}
      </section>
    </div>
  );
}

function Latest({ latest, staleAfterMs }) {
  if (!latest) return null;
  return (
    <section className={`wx-latest${latest.stale ? ' wx-latest--stale' : ''}`} aria-label="Latest reading">
      <div className="wx-tile"><span className="wx-tile-label">Temperature</span><span className="wx-tile-value">{num(latest.temperatureC, 1)}°C</span></div>
      <div className="wx-tile"><span className="wx-tile-label">Humidity</span><span className="wx-tile-value">{num(latest.humidityPct, 0)}%</span></div>
      <div className="wx-tile"><span className="wx-tile-label">Pressure</span><span className="wx-tile-value">{num(latest.pressureHpa, 1)} hPa</span></div>
      <div className="wx-tile wx-tile--meta">
        <span className="wx-tile-label">Last reading</span>
        <span className="wx-tile-value wx-tile-value--small">{ageWords(latest.ageMs)}</span>
        <span className="wx-tile-sub">{exactTime(latest.observedAt, 60000)}{Number.isFinite(latest.rssi) ? ` · ${latest.rssi} dBm` : ''}</span>
      </div>
      {latest.stale && (
        <p className="wx-stale" role="alert">
          ⚠ The station has not reported for {ageWords(latest.ageMs).replace(' ago', '')} (it normally reports every minute; stale after {Math.round(staleAfterMs / 60000)} min).
          These are the last values it sent, not current conditions — check the transmitter battery, the receiver on pi5 and the saim-weather-ingest service.
        </p>
      )}
    </section>
  );
}

function DataTable({ data }) {
  const rows = data.series.filter((s) => s.n > 0 || s.forecast?.temperatureC != null).slice(-200).reverse();
  return (
    <div className="wx-table-wrap">
      <table className="wx-table">
        <thead><tr><th>Time (Europe/London)</th><th>Temp local</th><th>Temp fcst</th><th>RH local</th><th>RH fcst</th><th>hPa local</th><th>hPa fcst</th></tr></thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.t}>
              <td>{exactTime(s.t, data.plan.bucketMs)}</td>
              <td>{num(s.local.temperatureC, 1)}</td><td>{num(s.forecast?.temperatureC, 1)}</td>
              <td>{num(s.local.humidityPct, 0)}</td><td>{num(s.forecast?.humidityPct, 0)}</td>
              <td>{num(s.local.pressureHpa, 1)}</td><td>{num(s.forecast?.pressureHpa, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The screen, given a payload. Exported so a render test reaches every state. */
export function WeatherView({ data, range, onRange, error, loading, onRetry, rain = null, sources = null, nowMs = Date.now() }) {
  const [table, setTable] = useState(false);
  const ranges = data?.ranges || [
    { id: 'hour', label: 'Hourly' }, { id: 'day', label: 'Daily' }, { id: 'week', label: 'Weekly' },
    { id: 'month', label: 'Monthly' }, { id: 'year', label: 'Yearly' },
  ];

  return (
    <div className="wx-panel">
      <div className="wx-top">
        <h1>Weather</h1>
        <div className="wx-ranges" role="tablist" aria-label="Time range">
          {ranges.map((r) => (
            <button key={r.id} role="tab" aria-selected={range === r.id}
              className={`wx-range${range === r.id ? ' wx-range--on' : ''}`} onClick={() => onRange?.(r.id)}>{r.label}</button>
          ))}
        </div>
      </div>

      {/* ⚠ An error is never rendered as an empty station: "I could not ask"
          and "nothing has been recorded" send him to different places. */}
      {error && (
        <div className="wx-error" role="alert">
          Couldn’t load the weather: {error}. {onRetry && <button className="wx-link" onClick={onRetry}>Try again</button>}
          {data && ' Showing the last data that loaded.'}
        </div>
      )}
      {loading && !data && <div className="wx-loading">Loading weather…</div>}

      {data && !data.node && (
        <div className="wx-empty">
          <h2>No station readings yet</h2>
          <p>NEURO has not received anything from an outdoor weather node. Readings arrive from pi5’s
            <code>saim-weather-ingest</code> service once it is set to forward to NEURO — see
            <code>saim/weather/README.md</code>.</p>
        </div>
      )}

      {data && data.node && (
        <>
          <Outlook summary={data.summary} nowMs={data.plan?.nowMs} />
          <Latest latest={data.latest} staleAfterMs={data.staleAfterMs} />
          <div className="wx-meta">
            <span>Node <strong>{data.node}</strong> · {data.history?.n?.toLocaleString('en-GB') ?? 0} readings kept
              {data.history?.firstObservedAt ? ` since ${exactTime(data.history.firstObservedAt, 24 * 3600000)}` : ''}</span>
            <span>{data.forecast?.lastIssuedAt
              ? `Forecast: ${data.forecast.label}, last fetched ${ageWords(data.plan.nowMs - data.forecast.lastIssuedAt)}`
              : 'No forecast fetched yet'}</span>
            {loading && <span className="wx-refreshing">refreshing…</span>}
            <button className="wx-link" onClick={() => setTable((t) => !t)}>{table ? 'Show charts' : 'Show numbers'}</button>
          </div>
          {table ? <DataTable data={data} /> : METRICS.map((m) => (
            <WeatherChart key={m.key} metric={m} series={data.series} plan={data.plan} range={data.range} forecastLabel={data.forecast?.label} />
          ))}
        </>
      )}

      {/* Rain comes from the EA gauge, not the home station, so it shows
          whether or not the station has ever reported. */}
      {sources && !sources.error && <NearbyStations nearby={sources.nearby} nowMs={nowMs} />}
      {rain && <RainChart data={rain} range={range} nowMs={nowMs} />}
      <SourcesStrip sources={sources} nowMs={nowMs} />
    </div>
  );
}

const REFRESH_MS = 60 * 1000;

export default function WeatherPanel() {
  const [range, setRange] = useState(() => {
    try { return localStorage.getItem('neuro_weather_range') || 'day'; } catch { return 'day'; }
  });
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [rain, setRain] = useState(null);
  const [sources, setSources] = useState(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Rain and source health load on their own: a failure in either is shown
  // where it belongs and never takes the station charts down with it.
  const loadRain = useCallback(async () => {
    const now = Date.now();
    setNowMs(now);
    const q = rainQuery(range, now);
    const get = async (url) => {
      const res = await apiFetch(url);
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || body.ok === false) throw new Error((body && body.error) || `HTTP ${res.status}`);
      return body;
    };
    const [r, s] = await Promise.allSettled([
      get(`/api/weather/rainfall?period=${q.period}&from=${q.fromMs}&to=${q.toMs}`),
      get('/api/weather/sources'),
    ]);
    setRain(r.status === 'fulfilled' ? { ...r.value, query: q } : { error: r.reason?.message || 'request failed', query: q });
    setSources(s.status === 'fulfilled' ? s.value : { error: s.reason?.message || 'request failed' });
  }, [range]);

  const load = useCallback(async () => {
    loadRain();
    setLoading(true);
    try {
      const res = await apiFetch(`/api/weather/overview?range=${encodeURIComponent(range)}`);
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || body.ok === false) throw new Error((body && body.error) || `HTTP ${res.status}`);
      setData(body);
      setError(null);
    } catch (e) {
      setError(e.message || 'request failed');
    } finally {
      setLoading(false);
    }
  }, [range, loadRain]);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const pick = (r) => {
    setRange(r);
    try { localStorage.setItem('neuro_weather_range', r); } catch { /* per-viewer convenience only */ }
  };

  return <WeatherView data={data} range={range} onRange={pick} error={error} loading={loading} onRetry={load} rain={rain} sources={sources} nowMs={nowMs} />;
}
