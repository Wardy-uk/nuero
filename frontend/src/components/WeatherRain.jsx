import { useEffect, useMemo, useRef, useState } from 'react';
import { tickLabel, exactTime, ageWords, niceTicks } from './WeatherPanel';

// ── Rain, from the Environment Agency gauge, and the external sources ──────
//
// Rain is not measured by the home station (a BME280 has no gauge); it comes
// from the EA's Mount St Bernards tipping bucket through `GET /api/weather/rainfall`,
// which has already chosen, per 15 minutes or per day, between the EA's live
// telemetry and its quality-checked record. This file only GROUPS those totals
// into the chart's bars — it decides nothing about which feed is right.
//
// ⚠ NO READING IS NOT ZERO. A dry spell is a run of real 0 mm readings and is
// drawn on the baseline; a slot with no reading at all is a hatched gap and the
// tooltip says so. The EA's own daily series skips whole days in summer 2026,
// and drawing those as dry would invent a drought.
//
// ⚠ A bar with even one EA-"Suspect" value in it is drawn HOLLOW, because a wet
// day the EA itself doubts must not read as settled fact.

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// What each screen range asks for, and how wide a bar is. Month and year read the
// EA's daily totals (09:00–09:00 GMT water days); a year is drawn in weeks.
export const RAIN_PLAN = Object.freeze({
  hour: { spanMs: HOUR, bucketMs: 15 * 60 * 1000, period: 900, unit: '15 min' },
  day: { spanMs: DAY, bucketMs: HOUR, period: 900, unit: 'hour' },
  week: { spanMs: 7 * DAY, bucketMs: 6 * HOUR, period: 900, unit: '6 hours' },
  month: { spanMs: 30 * DAY, bucketMs: DAY, period: 86400, unit: 'day' },
  year: { spanMs: 365 * DAY, bucketMs: 7 * DAY, period: 86400, unit: 'week' },
});

export function rainQuery(range, nowMs) {
  const p = RAIN_PLAN[range] || RAIN_PLAN.day;
  const toMs = Math.ceil(nowMs / p.bucketMs) * p.bucketMs;
  const fromMs = toMs - Math.ceil(p.spanMs / p.bucketMs) * p.bucketMs;
  return { ...p, fromMs, toMs };
}

const FEED_WORDS = { 'ea-hydrology': 'quality-checked record', 'ea-flood-monitoring': 'live telemetry' };
const QC_WORDS = { good: 'Good', unchecked: 'not yet checked', provisional: 'provisional', suspect: 'Suspect', estimated: 'Estimated', missing: 'Missing' };

/**
 * Group the server's points into bars. PURE.
 * Each bar: { t, mm (null when nothing was read), n, expected, suspect, feeds, qcs }.
 * `expected` is how many readings a full bar holds, so a part-read bar can say so.
 */
export function rainBars(points, q) {
  const per = q.period * 1000;
  const expected = Math.max(1, Math.round(q.bucketMs / per));
  const bars = [];
  for (let t = q.fromMs; t < q.toMs; t += q.bucketMs) bars.push({ t, mm: null, n: 0, expected, suspect: false, feeds: new Set(), qcs: new Set() });
  for (const p of points || []) {
    const i = Math.floor((p.t - q.fromMs) / q.bucketMs);
    if (i < 0 || i >= bars.length) continue;
    const b = bars[i];
    if (!Number.isFinite(p.rainMm)) continue; // a point with no value is not a reading
    b.mm = (b.mm || 0) + p.rainMm;
    b.n += 1;
    if (p.feed) b.feeds.add(p.feed);
    if (p.qc) b.qcs.add(p.qc);
    if (p.qc === 'suspect') b.suspect = true;
  }
  for (const b of bars) if (b.mm != null) b.mm = Math.round(b.mm * 100) / 100;
  return bars;
}

/** Window summary. PURE. Missing bars are counted, never folded into the total as 0. */
export function rainSummary(bars) {
  const read = bars.filter((b) => b.mm != null);
  const total = read.reduce((a, b) => a + b.mm, 0);
  return {
    totalMm: Math.round(total * 10) / 10,
    bars: bars.length,
    missing: bars.length - read.length,
    partial: read.filter((b) => b.n < b.expected).length,
    suspect: read.filter((b) => b.suspect).length,
    wettest: read.reduce((m, b) => (m == null || b.mm > m.mm ? b : m), null),
  };
}

const mmText = (v) => (v == null ? '—' : v < 10 ? v.toFixed(1) : String(Math.round(v)));

export function RainChart({ data, range, nowMs }) {
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

  const q = useMemo(() => (data?.query ? data.query : rainQuery(range, nowMs)), [data, range, nowMs]);
  const bars = useMemo(() => rainBars(data?.points, q), [data, q]);
  const sum = useMemo(() => rainSummary(bars), [bars]);
  const ticks = useMemo(() => niceTicks(q.fromMs, q.toMs, range, width < 420 ? 3 : 5), [q, range, width]);

  const W = width, H = 150, PAD_L = 44, PAD_R = 8, PAD_T = 10, PAD_B = 26;
  const AXIS_Y = H - PAD_B;
  const max = Math.max(1, ...bars.map((b) => b.mm || 0));
  const hi = max <= 2 ? Math.ceil(max * 2) / 2 : max <= 10 ? Math.ceil(max) : Math.ceil(max / 5) * 5;
  const x = (t) => PAD_L + ((t - q.fromMs) / Math.max(1, q.toMs - q.fromMs)) * (W - PAD_L - PAD_R);
  const y = (v) => PAD_T + (1 - v / hi) * (AXIS_Y - PAD_T);
  const bw = Math.max(1, x(q.fromMs + q.bucketMs) - x(q.fromMs) - (bars.length > 60 ? 0.5 : 1.5));

  function onMove(e) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || !bars.length) return;
    const rel = ((e.clientX - rect.left) / rect.width) * W;
    const t = q.fromMs + ((rel - PAD_L) / (W - PAD_L - PAD_R)) * (q.toMs - q.fromMs);
    setHover(Math.max(0, Math.min(bars.length - 1, Math.floor((t - q.fromMs) / q.bucketMs))));
  }
  const hv = hover == null ? null : bars[hover];
  const showNow = nowMs > q.fromMs && nowMs < q.toMs;

  return (
    <section className="wx-chart wx-rain" aria-label="Rain chart">
      <header className="wx-chart-head">
        <h3>Rain <span className="wx-rain-src">EA Mount St Bernards gauge</span></h3>
        <div className="wx-legend">
          {!data?.error && <span className="wx-rain-total">{mmText(sum.totalMm)} mm in this window</span>}
          <span className="wx-legend-item"><span className="wx-key wx-key--rain" />mm per {q.unit}</span>
        </div>
      </header>
      {data?.error ? (
        <div className="wx-rain-err" role="alert">Couldn’t read the rain gauge: {data.error}. This is not a dry spell.</div>
      ) : (
        <div className="wx-plot" ref={wrapRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
            aria-label={`Rain per ${q.unit}: ${mmText(sum.totalMm)} mm in the window${sum.missing ? `, ${sum.missing} with no reading` : ''}`}>
            <defs>
              <pattern id="wx-gap-hatch" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="5" className="wx-gap-line" />
              </pattern>
            </defs>
            {[0, hi / 2, hi].map((v) => (
              <g key={v}>
                <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} className="wx-grid" />
                <text x={PAD_L - 6} y={y(v) + 4} textAnchor="end" className="wx-ytick">{v}</text>
              </g>
            ))}
            {bars.map((b) => {
              const bx = x(b.t) + 0.5;
              if (b.mm == null) return <rect key={b.t} x={bx} y={PAD_T} width={bw} height={AXIS_Y - PAD_T} className="wx-gap" data-gap="1" />;
              const h = Math.max(b.mm > 0 ? 1.5 : 0, AXIS_Y - y(b.mm));
              return <rect key={b.t} x={bx} y={AXIS_Y - h} width={bw} height={h}
                className={`wx-bar${b.suspect ? ' wx-bar--suspect' : ''}${b.n < b.expected ? ' wx-bar--partial' : ''}`} />;
            })}
            {showNow && <line x1={x(nowMs)} x2={x(nowMs)} y1={PAD_T} y2={AXIS_Y} className="wx-now" />}
            <line x1={PAD_L} x2={W - PAD_R} y1={AXIS_Y} y2={AXIS_Y} className="wx-axis" />
            {ticks.map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={AXIS_Y} y2={AXIS_Y + 3} className="wx-axis" />
                <text x={x(t)} y={AXIS_Y + 16} className="wx-xtick" textAnchor="middle">{tickLabel(t, range)}</text>
              </g>
            ))}
          </svg>
          {hv && (
            <div className="wx-tip" style={{ left: `${(x(hv.t + q.bucketMs / 2) / W) * 100}%` }} role="status">
              <div className="wx-tip-time">{exactTime(hv.t, q.bucketMs)}</div>
              {hv.mm == null ? <div>No reading — not the same as dry</div> : (
                <>
                  <div><strong>{hv.mm.toFixed(1)} mm</strong>
                    {hv.n < hv.expected && <span className="wx-tip-n"> · {hv.n} of {hv.expected} readings</span>}</div>
                  <div className="wx-tip-n">{[...hv.feeds].map((f) => FEED_WORDS[f] || f).join(' + ')}
                    {hv.qcs.size > 0 && ` · ${[...hv.qcs].map((c) => QC_WORDS[c] || c).join(', ')}`}</div>
                  {hv.suspect && <div className="wx-tip-warn">The EA flags part of this as Suspect</div>}
                </>
              )}
            </div>
          )}
        </div>
      )}
      <p className="wx-chart-hint">
        Environment Agency tipping-bucket gauge at Mount St Bernards, not the home station.
        {/* ⚠ After a failed read there are no slots to count: "24 slots have no
            reading" over a window nobody looked at is a claim about the gauge. */}
        {!data?.error && sum.missing > 0 && ` ${sum.missing} ${sum.missing === 1 ? 'slot has' : 'slots have'} no reading (hatched).`}
        {!data?.error && sum.partial > 0 && ` ${sum.partial} ${sum.partial === 1 ? 'bar is' : 'bars are'} part-read.`}
        {!data?.error && sum.suspect > 0 && ` ${sum.suspect} hollow ${sum.suspect === 1 ? 'bar includes' : 'bars include'} values the EA flags as Suspect.`}
        {range === 'month' || range === 'year' ? ' Daily totals run 09:00–09:00 GMT.' : ''}
      </p>
    </section>
  );
}

// ── Sources ──────────────────────────────────────────────────────────────────

const STATE_WORDS = { ok: 'OK', stale: 'Stale', failing: 'Failing', 'backing-off': 'Backing off', never: 'Not run yet' };
const FEED_LABEL = (s) => {
  if (s.sourceId === 'ea:3641' && s.feed === 'ea-flood-monitoring') return 'EA gauge — live (provisional)';
  if (s.sourceId === 'ea:3641' && s.feed === 'ea-hydrology') return 'EA gauge — quality-checked record';
  if (s.feed === 'wu-pws-v2') return `Weather Underground ${s.sourceId.replace(/^wu:/, '')}`;
  if (s.feed === 'wu-upload') return 'Weather Underground upload (ICOALV59)';
  return `${s.sourceId} · ${s.feed}`;
};
const ymdLong = (s) => (s ? new Date(s + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '?');

export function backfillWords(backfill) {
  if (!backfill) return [];
  const out = [];
  for (const [p, label] of [['900', '15-minute history'], ['86400', 'Daily history']]) {
    const s = backfill[p];
    if (!s) continue;
    const done = s.cursor && s.floor && s.cursor <= s.floor;
    out.push(done ? `${label}: complete back to ${ymdLong(s.floor)}`
      : `${label}: back to ${ymdLong(s.cursor)}, still walking to ${ymdLong(s.floor)}${s.lastError ? ` (last chunk failed: ${s.lastError})` : ''}`);
  }
  return out;
}

export function SourcesStrip({ sources, nowMs }) {
  if (!sources) return null;
  if (sources.error) return <section className="wx-sources" aria-label="Weather sources"><p className="wx-rain-err">Couldn’t read source health: {sources.error}</p></section>;
  const all = sources.feeds || [];
  const wu = sources.wu || {};
  // Sixteen WU stations as sixteen lines would bury the EA gauge. One summary
  // line, naming only the stations that are not OK — a problem is never folded away.
  const wuFeeds = all.filter((s) => s.feed === 'wu-pws-v2');
  const feeds = all.filter((s) => s.feed !== 'wu-pws-v2');
  const wuBad = wuFeeds.filter((s) => s.state !== 'ok');
  return (
    <section className="wx-sources" aria-label="Weather sources">
      <h2>Sources</h2>
      <ul className="wx-src-list">
        {feeds.map((s) => (
          <li key={`${s.sourceId}|${s.feed}`} className={`wx-src wx-src--${s.state}`}>
            <span className="wx-src-name">{FEED_LABEL(s)}</span>
            <span className={`wx-src-state wx-src-state--${s.state}`}>{STATE_WORDS[s.state] || s.state}</span>
            <span className="wx-src-detail">
              {s.lastObservedAt ? `newest reading ${ageWords(nowMs - s.lastObservedAt)}` : 'no readings yet'}
              {s.lastSuccessAt ? ` · last fetched ${ageWords(nowMs - s.lastSuccessAt)}` : ''}
              {s.consecutiveFailures > 0 && s.lastError ? ` · ${s.lastError}` : ''}
              {s.state === 'backing-off' && s.retryAfter ? ` · retrying ${exactTime(s.retryAfter, 60000)}` : ''}
            </span>
          </li>
        ))}
        {wuFeeds.length > 0 && (
          <li className={`wx-src wx-src--${wuBad.length ? 'stale' : 'ok'}`}>
            <span className="wx-src-name">Weather Underground nearby stations</span>
            <span className={`wx-src-state wx-src-state--${wuBad.length ? 'stale' : 'ok'}`}>{wuBad.length ? `${wuBad.length} not OK` : 'OK'}</span>
            <span className="wx-src-detail">
              {wuFeeds.length - wuBad.length} of {wuFeeds.length} OK
              {wuBad.length > 0 && ` · ${wuBad.map((s) => `${s.sourceId.replace(/^wu:/, '')} ${(STATE_WORDS[s.state] || s.state).toLowerCase()}${s.lastError ? ` (${s.lastError})` : ''}`).join(', ')}`}
            </span>
          </li>
        )}
        {wuFeeds.length === 0 && (
          <li className="wx-src wx-src--off">
            <span className="wx-src-name">Weather Underground neighbours ({(wu.importStations || []).join(', ')})</span>
            <span className="wx-src-state wx-src-state--off">Not set up</span>
            <span className="wx-src-detail">{wu.importBlocked ? 'needs an API key — Settings → Integrations → Weather Underground' : 'waiting for the first import'}</span>
          </li>
        )}
        {wu.publish && !(feeds.some((s) => s.feed === 'wu-upload')) && (
          <li className="wx-src wx-src--off">
            <span className="wx-src-name">Weather Underground upload ({wu.publish.stationId})</span>
            <span className="wx-src-state wx-src-state--off">Off</span>
            <span className="wx-src-detail">
              {!wu.publish.keySet ? 'needs the station key, and the home station back online' : !wu.publish.enabled ? 'switched off (WU_PUBLISH_ENABLED)' : 'waiting for a live home-station reading'}
            </span>
          </li>
        )}
      </ul>
      {backfillWords(sources.backfill).map((w) => <p key={w} className="wx-src-backfill">{w}</p>)}
    </section>
  );
}

// ── Nearby stations (Weather Underground) ────────────────────────────────────
//
// Other people's stations, so their numbers are THEIRS: each tile names the
// station and says how old its reading is. "Rain today" is WU's since-midnight
// accumulation as the station reports it. Wind is shown in mph (what a UK
// reader thinks in) from the SI value NEURO stores. A stale or offline station
// says so instead of showing old numbers as current.

const one = (v, dp = 1) => (Number.isFinite(v) ? v.toFixed(dp) : '—');
const mph = (ms) => (Number.isFinite(ms) ? Math.round(ms * 2.2369363) : null);
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg) => (Number.isFinite(deg) ? COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16] : null);

/** Ground height first; the owner's figure only beside it when they disagree. PURE. */
export function elevationText(e) {
  if (!e) return '—';
  const r = Number.isFinite(e.reportedM) ? Math.round(e.reportedM) : null;
  const g = Number.isFinite(e.groundM) ? Math.round(e.groundM) : null;
  if (g == null) return r == null ? '—' : `${r} m (owner’s figure, unchecked)`;
  if (e.mismatch) return `${g} m ground · owner says ${r} m`;
  return `${g} m`;
}

const SECTOR_NAMES = { N: 'North', E: 'East', S: 'South', W: 'West' };
const RAIN_CLASS = (st) => (st.raining === true ? 'wet' : st.raining === false ? 'dry' : 'quiet');

/** Compass plot of the ring, to scale from home. */
export function RingCompass({ stations, wind, size = 220 }) {
  const placed = (stations || []).filter((s) => s.geo);
  const maxMi = Math.max(6, ...placed.map((s) => s.geo.mi));
  const c = size / 2, R = c - 18;
  const pt = (mi, b) => [c + (mi / maxMi) * R * Math.sin((b * Math.PI) / 180), c - (mi / maxMi) * R * Math.cos((b * Math.PI) / 180)];
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="wx-compass" role="img"
      aria-label={`Nearby stations around home${wind && wind.trusted ? `, wind from ${wind.from}` : ''}`}>
      <defs><marker id="wx-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0 0 L10 5 L0 10 z" className="wx-cmp-head" /></marker></defs>
      {[2, 5].filter((m) => m <= maxMi).map((m) => (
        <g key={m}><circle cx={c} cy={c} r={(m / maxMi) * R} className="wx-cmp-ring" />
          <text x={c + 3} y={c - (m / maxMi) * R + 10} className="wx-cmp-lbl">{m} mi</text></g>
      ))}
      {['N', 'E', 'S', 'W'].map((d, i) => {
        const [x, y] = pt(maxMi * 1.1, i * 90);
        return <text key={d} x={x} y={y + 4} textAnchor="middle" className="wx-cmp-dir">{d}</text>;
      })}
      {wind && wind.trusted && (() => {
        // From the side the wind comes FROM, pointing at home.
        const [x1, y1] = pt(maxMi * 0.95, wind.fromDeg);
        const [x2, y2] = pt(maxMi * 0.35, wind.fromDeg);
        return <line x1={x1} y1={y1} x2={x2} y2={y2} className="wx-cmp-wind" markerEnd="url(#wx-arrow)" />;
      })()}
      {placed.map((s) => {
        const [x, y] = pt(s.geo.mi, s.geo.bearing);
        return <circle key={s.id} cx={x} cy={y} r={4.5} className={`wx-cmp-st wx-cmp-st--${RAIN_CLASS(s)}`}><title>{`${s.id} · ${s.geo.mi.toFixed(1)} mi ${s.geo.dir}`}</title></circle>;
      })}
      <circle cx={c} cy={c} r={4} className="wx-cmp-home" />
    </svg>
  );
}

function StationRow({ s, nowMs }) {
  const l = s.latest;
  return (
    <li className={`wx-st wx-st--${RAIN_CLASS(s)}${!l ? ' wx-st--none' : ''}`}>
      <span className="wx-st-name"><span className={`wx-dot wx-dot--${RAIN_CLASS(s)}`} />{s.name && s.name !== s.id ? s.name : s.id}
        <span className="wx-nb-id">{s.id}</span></span>
      <span className="wx-st-where">{s.geo ? `${s.geo.mi.toFixed(1)} mi ${s.geo.dir}` : '—'}</span>
      {!l ? <span className="wx-st-vals">{s.lastSeenAt ? `last heard ${ageWords(nowMs - s.lastSeenAt)}` : 'no reading yet'}</span> : (
        <span className="wx-st-vals">
          {one(l.temperatureC)}°C · {one(l.humidityPct, 0)}% · {mph(l.windMs) ?? '—'} mph{compass(l.windDirectionDeg) ? ` ${compass(l.windDirectionDeg)}` : ''}
          {' · '}{one(l.rainAccumMm)} mm today{s.raining ? ' · raining' : ''}
        </span>
      )}
      <span className="wx-st-meta">{elevationText(s.elevation)}{l ? ` · ${ageWords(nowMs - l.t)}` : ''}</span>
    </li>
  );
}

export function NearbyStations({ nowcast, nowMs }) {
  if (!nowcast || nowcast.error || !Array.isArray(nowcast.stations) || !nowcast.stations.length) return null;
  const by = { N: [], E: [], S: [], W: [], '?': [] };
  for (const s of nowcast.stations) (by[s.geo ? s.geo.sector : '?'] || by['?']).push(s);
  for (const k of Object.keys(by)) by[k].sort((a, b) => (a.geo ? a.geo.mi : 99) - (b.geo ? b.geo.mi : 99));
  return (
    <section className="wx-nearby" aria-label="Nearby stations">
      <div className="wx-nearby-head">
        <h2>Nearby stations</h2>
        <span className="wx-nearby-src">Weather Underground · {nowcast.reporting} of {nowcast.stations.length} reporting · other people’s stations</span>
      </div>
      <div className="wx-ring">
        <div className="wx-ring-plot">
          <RingCompass stations={nowcast.stations} wind={nowcast.wind} />
          <div className="wx-ring-key">
            <span><span className="wx-dot wx-dot--wet" />raining</span>
            <span><span className="wx-dot wx-dot--dry" />dry</span>
            <span><span className="wx-dot wx-dot--quiet" />no recent reading</span>
          </div>
        </div>
        <div className="wx-ring-lists">
          {['N', 'E', 'S', 'W', '?'].filter((k) => by[k].length).map((k) => (
            <div key={k} className="wx-sector">
              <h3>{SECTOR_NAMES[k] || 'Position unknown'}</h3>
              <ul>{by[k].map((s) => <StationRow key={s.id} s={s} nowMs={nowMs} />)}</ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const ARRIVAL_WORDS = {
  'raining-here': () => 'Raining here now.',
  'no-wind': (a) => `Can’t call rain arriving: ${a.why}.`,
  'no-upwind': (a) => `Can’t call rain arriving: ${a.why}.`,
  'no-home': () => 'Can’t call rain arriving: home location unknown.',
  'dry-upwind': (a) => `No rain upwind — ${a.reporting} of ${a.upwind.length} upwind stations reporting, all dry.`,
};

/** The local nowcast: the next hour or so, from the stations, with its record. */
export function NowcastCard({ nowcast }) {
  if (!nowcast) return null;
  if (nowcast.error) return <section className="wx-nowcast" aria-label="Local nowcast"><p className="wx-rain-err">Couldn’t read the local nowcast: {nowcast.error}</p></section>;
  const a = nowcast.arrival || {};
  const w = nowcast.wind;
  const p = nowcast.pressure || {};
  const rec = nowcast.record || {};
  const scored = (rec.hits || 0) + (rec.misses || 0) + (rec.unknown || 0);
  return (
    <section className={`wx-nowcast wx-nowcast--${a.state}`} aria-label="Local nowcast">
      <div className="wx-nearby-head">
        <h2>Local nowcast</h2>
        <span className="wx-nearby-src">next hour or so · from {nowcast.reporting} nearby stations</span>
      </div>
      <p className="wx-nc-main">
        {a.state === 'rain-likely'
          ? <>Rain likely in about <strong>{a.etaMin[0]}–{a.etaMin[1]} min</strong> — {a.raining.length === 1 ? 'a station' : `${a.raining.length} stations`} upwind {a.raining.length === 1 ? 'is' : 'are'} reporting rain, nearest {a.nearest.id} ({a.nearest.mi} mi {a.nearest.dir}). {a.confidence === 'moderate' ? 'Moderate' : 'Low'} confidence.</>
          : (ARRIVAL_WORDS[a.state] ? ARRIVAL_WORDS[a.state](a) : '—')}
      </p>
      <ul className="wx-nc-lines">
        <li><span className="wx-line-label">Wind</span>
          {w ? (w.trusted ? `from ${w.from}, ${w.mph} mph (median of ${w.stations} stations)` : `no settled direction across ${w.stations} stations`) : 'too few stations reporting wind'}</li>
        <li><span className="wx-line-label">Pressure</span>
          {p.known ? `${p.word} across the ring (${p.delta3h > 0 ? '+' : ''}${p.delta3h} hPa in 3 h; ${p.agree} of ${p.stations} agree)` : `not enough history yet (${p.why || 'no data'})`}</li>
        <li><span className="wx-line-label">Track record</span>
          {scored || rec.onsets
            ? `rain calls ${rec.hits} right, ${rec.misses} wrong${rec.unknown ? `, ${rec.unknown} couldn’t tell` : ''}; rain started here ${rec.onsets} time${rec.onsets === 1 ? '' : 's'}, ${rec.onsetsPredicted} called in advance`
            : 'no rain calls yet — each one is recorded and checked against the EA gauge and the nearest stations'}</li>
      </ul>
      <p className="wx-scope">Covers the next hour or so; beyond that the forecast is the better guide. Rain moves faster than the wind at a garden station, so arrival is a window, not a minute.</p>
    </section>
  );
}
