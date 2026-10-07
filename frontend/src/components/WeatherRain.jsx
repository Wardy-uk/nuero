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
  const feeds = sources.feeds || [];
  const wu = sources.wu || {};
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
        {!(feeds.some((s) => s.feed === 'wu-pws-v2')) && (
          <li className="wx-src wx-src--off">
            <span className="wx-src-name">Weather Underground neighbours ({(wu.importStations || []).join(', ')})</span>
            <span className="wx-src-state wx-src-state--off">Not set up</span>
            <span className="wx-src-detail">{wu.importBlocked ? 'needs your WU owner key (WU_API_KEY)' : 'waiting for the first import'}</span>
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
