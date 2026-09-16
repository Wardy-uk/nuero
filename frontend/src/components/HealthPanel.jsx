import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { apiUrl, apiFetch } from '../api';
import './HealthPanel.css';

/**
 * My Health — the deep view over two years of Apple Health.
 *
 * WHY A PAGE AND NOT A BIGGER CARD. `HealthCard` answers "how am I today" in a
 * sidebar glance and that is all it should do. Everything worth knowing here is
 * a TREND — 744 rolled-up days sit in `health_daily` and none of it is visible
 * in one day's numbers. A resting heart rate held 4bpm high for three days, a
 * sleep median drifting across a quarter, daylight collapsing from 38 minutes to
 * 12: those need an axis, and an axis needs a page.
 *
 * ── The rules this page follows ─────────────────────────────────────────────
 *
 * ONE MEASURE PER CHART, ONE AXIS. Never two y-scales on one plot: HRV in
 * milliseconds and resting heart rate in bpm share no scale, and drawing them
 * together invents a relationship out of whichever units were chosen. Small
 * multiples instead.
 *
 * A GAP IN THE DATA IS DRAWN AS A GAP. The phone syncs when iOS feels like it,
 * so missing days are normal and frequent. A line interpolated straight through
 * a fortnight the watch was off charge is the chart telling a story nobody
 * measured — the same lie as a zero standing in for "we could not look", which
 * this whole area was just dug out of. `segments()` breaks the path at nulls.
 *
 * SLEEP STAGES ARE A SEQUENTIAL RAMP, NOT CATEGORICAL HUES. The stages are
 * ORDERED (deep → core → REM) and they are one measure — hours asleep — split by
 * depth, so a single hue getting lighter is the honest encoding. It is also the
 * only one that survives colour-blindness here: the palette this replaced used
 * blue/purple/blue-grey, which measured ΔE 0.1 between deep and REM under
 * deuteranopia (indistinguishable) and 8.0 for normal vision. Validated against
 * the dark surface, with a 2px gap between segments so the boundaries read even
 * where the tones are close.
 *
 * NOTHING HERE IS ADVICE. Every number is Nick's own body compared with his own
 * recent baseline. The service attaches a caveat to anything that could be
 * over-read into a diagnosis, and this renders it rather than tidying it away.
 */

const RANGES = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
];

// Sequential ramp, deepest → lightest, matching the order of sleep depth.
// Validated on the dark chart surface (#1a1e2e): monotonic lightness, every step
// above 3:1 contrast.
const SLEEP_RAMP = { deep: '#3a6fc4', core: '#5a95e0', rem: '#8fbdf2' };

// Each trend is its own chart with its own axis. `fmt` exists so the tooltip and
// the hero figure agree on units without either re-deriving them.
//
// ⚠ ORDER IS EDITORIAL, not alphabetical: the cardiovascular group leads because
// blood pressure is the one number on this page currently worth a conversation
// with a GP, and burying it under step counts is a design decision about what
// Nick reads first.
const TRENDS = [
  {
    key: 'bp',
    title: 'Blood pressure',
    unit: '',
    dp: 0,
    // ONE chart, TWO lanes, one mmHg axis. Splitting them into small multiples
    // would be the stricter reading of the one-measure rule and the wrong one:
    // a blood pressure is read as a pair, and the distance between the two is
    // most of the information.
    series: [
      { key: 'bpSystolic', label: 'Systolic' },
      { key: 'bpDiastolic', label: 'Diastolic' },
    ],
    hint: 'Daily median of every reading that day, systolic over diastolic. NEURO does not diagnose — this is your own data plotted, and a sustained high run is a GP conversation, not a number to argue with here.',
  },
  {
    key: 'heartRateMedian',
    title: 'Heart rate',
    unit: 'bpm',
    dp: 0,
    hint: 'The rate you spent the middle of your day at, weighted by the clock. The watch samples ~35x faster during exercise, so a plain average of readings mostly measures your workouts — each reading is weighted by how long it stood for instead.',
  },
  { key: 'hrvMedian', title: 'HRV', unit: 'ms', dp: 1, hint: 'Daily median. Higher is generally better recovery — but only against your own range.' },
  { key: 'rhrMedian', title: 'Resting heart rate', unit: 'bpm', dp: 0, hint: 'Daily median. A sustained rise is the signal, not any single day.' },
  {
    key: 'spo2',
    title: 'Blood oxygen',
    unit: '%',
    dp: 1,
    hint: 'Daily average, as the watch measures it. Wrist SpO2 is noisy — a single low reading is far more likely to be a loose strap than a lung.',
  },
  { key: 'asleepHours', title: 'Sleep', unit: 'h', dp: 2, hint: 'Time actually asleep, keyed to the night you woke on.' },
  { key: 'steps', title: 'Steps', unit: '', dp: 0, hint: null },
  { key: 'exerciseMinutes', title: 'Exercise', unit: 'min', dp: 0, hint: null },
  { key: 'daylightMinutes', title: 'Daylight', unit: 'min', dp: 0, hint: 'Time outside, as the watch measures it.' },
];

function fmtNum(v, dp = 0) {
  if (!Number.isFinite(v)) return '—';
  return Number(v.toFixed(dp)).toLocaleString();
}

function median(xs) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Split a series into unbroken runs, so the path breaks where data is missing
 * rather than drawing a straight line across a gap that was never measured.
 */
function segments(points) {
  const runs = [];
  let run = [];
  for (const p of points) {
    if (p.v === null) {
      if (run.length) runs.push(run);
      run = [];
    } else {
      run.push(p);
    }
  }
  if (run.length) runs.push(run);
  return runs;
}

// ── One trend chart ─────────────────────────────────────────────────────────
//
// Takes a LIST of series, not a single key, because blood pressure is two
// measurements that belong on one plot. That is not a breach of the one-axis
// rule above it: systolic and diastolic are both mmHg, so they share a scale
// honestly — the rule forbids pairing HRV in ms with heart rate in bpm, where
// the relationship on screen is an artefact of the units chosen.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Format a 'YYYY-MM-DD' day key for the axis.
 *
 * ⚠ SLICED, never parsed into a Date. `new Date('2026-09-16')` is midnight UTC,
 * which renders as the 15th anywhere west of here, and that exact mistake has
 * already cost this codebase a whole day on the calendar. There is nothing to
 * compute — the string already holds the answer.
 */
function axisLabel(day, withYear = false) {
  if (typeof day !== 'string' || day.length < 10) return '';
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  if (!m || !d || m > 12) return '';
  const base = `${d} ${MONTHS[m - 1]}`;
  return withYear ? `${base} ${day.slice(0, 4)}` : base;
}

/**
 * Evenly spaced tick positions across the window, both ends always included.
 *
 * A tick is a POSITION, not a reading — it goes on the axis whether or not that
 * day carries data, because the distance between two readings is exactly what
 * the axis exists to make measurable.
 */
function tickIndices(n, want = 5) {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const count = Math.max(2, Math.min(want, n));
  const out = [];
  for (let i = 0; i < count; i++) out.push(Math.round((i / (count - 1)) * (n - 1)));
  return [...new Set(out)];
}

function TrendChart({ title, unit, dp, hint, days, valueKey, series, spanYear }) {
  const [hover, setHover] = useState(null);
  const [width, setWidth] = useState(560);
  const wrapRef = useRef(null);

  // One series or several — the rest of the component only knows about a list.
  const defs = useMemo(
    () => (series && series.length ? series : [{ key: valueKey, label: title }]),
    [series, valueKey, title]
  );
  const multi = defs.length > 1;

  // ⚠ The SVG is drawn in MEASURED pixels rather than a fixed viewBox stretched
  // to fit. `preserveAspectRatio="none"` is the obvious way to make a chart
  // responsive and it scales x and y by different factors — which leaves the
  // lines fine (non-scaling-stroke) and turns the hover marker into an ellipse
  // that changes shape with the window. Measuring costs a ResizeObserver and
  // makes every mark honest.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect?.width;
      if (w) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // PAD_B carries the date axis. It was 14 when the x axis was unlabelled, which
  // is the whole complaint this answers: a trend with no time on it can be read
  // for shape and never for when.
  const W = width, H = 132, PAD_L = 6, PAD_R = 6, PAD_T = 10, PAD_B = 30;
  const AXIS_Y = H - PAD_B;

  // Oldest first, so time runs left to right. `rows` is shared by every series,
  // so two lanes cannot end up on different x positions.
  const rows = useMemo(() => [...days].reverse(), [days]);

  const lanes = useMemo(() => defs.map(def => ({
    ...def,
    points: rows.map((d, i) => ({
      i,
      day: d.day,
      v: Number.isFinite(d[def.key]) ? d[def.key] : null,
    })),
  })), [rows, defs]);

  const allValues = lanes.flatMap(l => l.points.map(p => p.v)).filter(Number.isFinite);
  const has = allValues.length > 0;

  // ONE scale across every series on the plot. Normalising each lane to its own
  // range would invent the gap between systolic and diastolic, which is the one
  // thing a reader looks at a blood pressure chart to see.
  const min = has ? Math.min(...allValues) : 0;
  const max = has ? Math.max(...allValues) : 1;
  const span = max - min || 1;

  const x = (i) => PAD_L + (i / Math.max(1, rows.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v) => PAD_T + (1 - (v - min) / span) * (AXIS_Y - PAD_T);

  const drawn = lanes.map(lane => ({
    ...lane,
    mid: median(lane.points.map(p => p.v)),
    paths: segments(lane.points).map(run =>
      run.map((p, n) => `${n ? 'L' : 'M'}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ')
    ),
  }));

  // Coverage is measured on the BEST-covered lane. For a pair, "97% covered"
  // must not read as 48% merely because the reading has two halves.
  const bestCovered = lanes.length
    ? Math.max(...lanes.map(l => l.points.filter(p => Number.isFinite(p.v)).length))
    : 0;
  const coverage = rows.length ? Math.round((bestCovered / rows.length) * 100) : 0;

  const ticks = tickIndices(rows.length);

  function onMove(e) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || !rows.length) return;
    const rel = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.round(((rel - PAD_L) / (W - PAD_L - PAD_R)) * (rows.length - 1));
    setHover(Math.max(0, Math.min(rows.length - 1, idx)));
  }

  const hoverRow = hover === null ? null : rows[hover];
  const hoverHasAny = hoverRow && drawn.some(l => Number.isFinite(l.points[hover]?.v));

  return (
    <div className="hp-chart">
      <div className="hp-chart-head">
        <span className="hp-chart-title">{title}</span>
        <span className="hp-chart-meta">
          {/* The median is the reference readiness judges against, so it is the
              number worth putting on the chart rather than a mean. For a pair it
              is written the way a blood pressure is spoken. */}
          {!has ? 'no readings' : (
            <>median {drawn.map(l => fmtNum(l.mid, dp)).join('/')}{unit}</>
          )}
          {has && coverage < 100 && (
            <span className="hp-cov" title={`${bestCovered} of ${rows.length} days carry a reading`}>
              {' '}· {coverage}% covered
            </span>
          )}
        </span>
      </div>

      {/* A pair needs naming. A single line does not — the chart title already
          says what it is, and a legend for one series is furniture. */}
      {multi && (
        <div className="hp-legend">
          {drawn.map((l, i) => (
            <span className="hp-legend-item" key={l.key}>
              <span className={`hp-legend-dot hp-legend-dot--${i}`} />{l.label}
            </span>
          ))}
        </div>
      )}

      <div className="hp-chart-plot" ref={wrapRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${title} over ${rows.length} days`}
        >
          {/* Recessive reference line at the median. Single series only: one per
              lane on a pair is a pile of dashes saying very little. */}
          {has && !multi && Number.isFinite(drawn[0].mid) && (
            <line x1={PAD_L} x2={W - PAD_R} y1={y(drawn[0].mid)} y2={y(drawn[0].mid)} className="hp-median" />
          )}

          {drawn.map((lane, li) => lane.paths.map((d, i) => (
            <path key={`${lane.key}-${i}`} d={d} className={`hp-line hp-line--${li}`} />
          )))}

          {/* ── The time axis ────────────────────────────────────────────────
              Every chart on this page used to have an x axis made entirely of
              position: the shape was readable and "when" was not, so a dip could
              be seen and never dated. */}
          <line x1={PAD_L} x2={W - PAD_R} y1={AXIS_Y} y2={AXIS_Y} className="hp-axis" />
          {ticks.map(i => (
            <g key={i}>
              <line x1={x(i)} x2={x(i)} y1={AXIS_Y} y2={AXIS_Y + 3} className="hp-axis" />
              <text
                x={x(i)}
                y={AXIS_Y + 16}
                className="hp-xtick"
                textAnchor={i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle'}
              >{axisLabel(rows[i]?.day, spanYear)}</text>
            </g>
          ))}

          {hoverRow && (
            <>
              <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={AXIS_Y} className="hp-crosshair" />
              {drawn.map((lane, li) => {
                const p = lane.points[hover];
                return Number.isFinite(p?.v)
                  ? <circle key={lane.key} cx={x(hover)} cy={y(p.v)} r="4" className={`hp-dot hp-dot--${li}`} />
                  : null;
              })}
            </>
          )}
        </svg>

        {hoverRow && (
          <div className="hp-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
            <strong>
              {/* "no reading" and a value are different facts, and they must stay
                  distinguishable on a chart whose gaps are deliberate. */}
              {!hoverHasAny ? 'no reading' : (
                `${drawn.map(l => {
                  const v = l.points[hover]?.v;
                  return Number.isFinite(v) ? fmtNum(v, dp) : '—';
                }).join('/')}${unit}`
              )}
            </strong>
            <span>{axisLabel(hoverRow.day, true)}</span>
          </div>
        )}
      </div>

      {hint && <div className="hp-chart-hint">{hint}</div>}
    </div>
  );
}

// ── The page ────────────────────────────────────────────────────────────────

export default function HealthPanel() {
  const [range, setRange] = useState(90);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [showAllMetrics, setShowAllMetrics] = useState(false);
  const [showAcked, setShowAcked] = useState(false);
  const [ackError, setAckError] = useState(null);

  const fetchAll = useCallback(async (days) => {
    setLoading(true);
    try {
      const [history, readiness, signals, stress, sleep, metrics] = await Promise.all([
        fetch(apiUrl(`/api/health/history?days=${days}`)).then(r => r.json()),
        fetch(apiUrl('/api/health/readiness')).then(r => r.json()),
        fetch(apiUrl('/api/health/signals')).then(r => r.json()),
        fetch(apiUrl('/api/health/stress')).then(r => r.json()),
        fetch(apiUrl('/api/health/sleep?days=14')).then(r => r.json()),
        fetch(apiUrl('/api/health/metrics?days=30')).then(r => r.json()),
      ]);
      setData({ history, readiness, signals, stress, sleep, metrics });
      setFailed(false);
    } catch {
      // "Couldn't ask" must stay distinguishable from "there's nothing there".
      setFailed(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchAll(range); }, [fetchAll, range]);

  // Acknowledging re-reads the signals block only — the charts have not moved,
  // and a full refetch would blank the panel to say one row has gone.
  const setAck = useCallback(async (id, on) => {
    setAckError(null);
    try {
      const res = await apiFetch(`/api/health/signals/${encodeURIComponent(id)}/ack`,
        { method: on ? 'POST' : 'DELETE' });
      const out = await res.json();
      // A refusal must SAY so. A row that silently stays put reads as a broken
      // button, which is how a control stops being trusted.
      if (!out.ok) { setAckError(out.reason || 'that did not go through'); return; }
      const signals = await fetch(apiUrl('/api/health/signals')).then(r => r.json());
      setData(d => (d ? { ...d, signals } : d));
    } catch {
      setAckError('could not reach the health API');
    }
  }, []);

  if (loading && !data) return <div className="hp"><div className="hp-quiet">Reading health data…</div></div>;
  if (failed) return <div className="hp"><div className="hp-quiet hp-quiet--err">Couldn’t reach the health API. This is not an all-clear — it means nothing could be read.</div></div>;

  const { history, readiness, signals, stress, sleep, metrics } = data;
  // Complete days only for the trends: today is a partial day and plotting it
  // draws a cliff every morning that is nothing but the clock.
  const days = (history?.history || []).filter(d => d.complete);
  const nights = sleep?.nights || [];
  const findings = signals?.findings || [];
  const acknowledged = signals?.acknowledged || [];
  const allMetrics = metrics?.metrics || [];
  const shownMetrics = showAllMetrics ? allMetrics : allMetrics.slice(0, 10);

  // The newest day that actually carries a blood pressure, from the UNFILTERED
  // history — today's row is incomplete by construction and excluding it would
  // hide the reading taken an hour ago behind yesterday's.
  //
  // ⚠ Walks back rather than reading `[0]`: a day with no reading must fall
  // through to the last one that had one, LABELLED with its date, instead of the
  // tile disappearing. A missing tile reads as "BP is not tracked".
  const todayBp = (() => {
    const all = history?.history || [];
    const newest = all[0]?.day || null;
    for (const d of all) {
      if (Number.isFinite(d.bpSystolic) && Number.isFinite(d.bpDiastolic)) {
        return { sys: d.bpSystolic, dia: d.bpDiastolic, day: d.day, isToday: d.day === newest };
      }
    }
    return null;
  })();

  return (
    <div className="hp">
      <div className="hp-head">
        <h2 className="hp-h2">My Health</h2>
        <div className="hp-controls">
          {RANGES.map(r => (
            <button
              key={r.days}
              className={`hp-range${range === r.days ? ' hp-range--on' : ''}`}
              onClick={() => setRange(r.days)}
            >{r.label}</button>
          ))}
          <button className="hp-refresh" onClick={() => fetchAll(range)}>Refresh</button>
        </div>
      </div>

      {/* ── Today ──────────────────────────────────────────────────
          A hero figure, not a chart: one number about right now has no axis to
          sit on. The two scores are LABELLED by window, because they measure
          different things and legitimately disagree — readiness is the whole day
          against a fortnight, stress is the last few readings inside six hours,
          and unlabelled they read as one of them being broken. */}
      <section className="hp-today">
        <div className="hp-hero">
          <div className="hp-hero-label">Today</div>
          {readiness?.known ? (
            <>
              <div className={`hp-hero-num hp-state--${readiness.state}`}>{readiness.score}</div>
              <div className="hp-hero-state">
                {readiness.state === 'low' ? 'Running low' : readiness.state === 'high' ? 'Well recovered' : 'About normal'}
                {readiness.partial && <span className="hp-muted"> · partial</span>}
              </div>
            </>
          ) : (
            // The service's own reason. "Not enough history yet" and "the watch
            // told us nothing" are different facts and must not share a blank.
            <div className="hp-quiet">{readiness?.reason || 'not available'}</div>
          )}
        </div>

        <div className="hp-today-body">
          {readiness?.sentence && <p className="hp-sentence">{readiness.sentence}</p>}
          <div className="hp-tiles">
            {(readiness?.contributors || []).map(c => (
              <div className={`hp-tile hp-tile--${c.flag}`} key={c.input}>
                <div className="hp-tile-label">
                  {c.input === 'hrv' ? 'HRV' : c.input === 'rhr' ? 'Resting HR' : 'Sleep'}
                </div>
                <div className="hp-tile-value">
                  {c.input === 'sleep' ? `${c.value}h` : c.input === 'rhr' ? `${c.value}bpm` : `${c.value}ms`}
                </div>
                <div className="hp-tile-base">usual {c.baseline}</div>
              </div>
            ))}
            {/* ── Blood pressure ───────────────────────────────────────────
                ⚠ AN ASIDE, NOT A CONTRIBUTOR. It is deliberately styled like
                "Right now" rather than like the three tiles to its left: those
                are the inputs readiness is actually computed from, and dropping
                BP in among them would imply it moved a score it has no part in.
                Changing the readiness model is a measurement change, and nobody
                asked for one. */}
            {todayBp && (
              <div className="hp-tile hp-tile--aside">
                <div className="hp-tile-label">Blood pressure</div>
                <div className="hp-tile-value">{fmtNum(todayBp.sys, 0)}/{fmtNum(todayBp.dia, 0)}</div>
                {/* Says WHICH DAY when it is not today. "No reading today" and
                    "no readings at all" license different conclusions, and a
                    stale figure printed under the word "Today" is the second one
                    wearing the first one's clothes. */}
                <div className="hp-tile-base">
                  {todayBp.isToday ? 'median so far today' : `median on ${axisLabel(todayBp.day)}`}
                </div>
              </div>
            )}
            {stress && (typeof stress.score === 'number') && (
              <div className="hp-tile hp-tile--aside">
                <div className="hp-tile-label">Right now</div>
                <div className="hp-tile-value">{stress.score}</div>
                {/* ⚠ THE NOUN IS LOAD-BEARING. This is a STRESS score — high is
                    strained, low is calm — and the bare label read "Low" one tile
                    away from readiness's "Running low", which means the opposite.
                    Two scores that legitimately disagree can survive being read
                    side by side; two that appear to agree while meaning opposite
                    things cannot. */}
                <div className="hp-tile-base">{stress.label ? `${stress.label} stress` : 'stress'} · last 6h</div>
              </div>
            )}
          </div>
          {(stress?.caveats || []).map((c, i) => <div className="hp-caveat" key={i}>⚠ {c}</div>)}
        </div>
      </section>

      {/* ── What has changed ─────────────────────────────────────── */}
      <section className="hp-section">
        <h3 className="hp-h3">What’s changed</h3>
        {findings.length === 0 && acknowledged.length === 0 && (signals?.unknowns || []).length === 0 && (
          <div className="hp-quiet">Nothing stood out across everything that could be read.</div>
        )}
        {findings.map(f => (
          <div className={`hp-finding hp-finding--${f.level}`} key={f.id}>
            <div className="hp-finding-title">{f.title}</div>
            <div className="hp-finding-detail">{f.detail}</div>
            {/* Never folded away. This is the one place a reading is most likely
                to be over-read into a diagnosis nobody made. */}
            {f.caveat && <div className="hp-finding-caveat">{f.caveat}</div>}
            {/* Says what it will do. "Dismiss" reads as "never again", and this
                is the opposite: it comes back if it happens again. */}
            <button
              type="button"
              className="hp-finding-ack"
              onClick={() => setAck(f.id, true)}
              title="Hides this until the metric comes back and stops again, or the trend clears and returns"
            >
              I’ve read it
            </button>
          </div>
        ))}
        {ackError && <div className="hp-quiet hp-quiet--err">Couldn’t record that — {ackError}.</div>}
        {acknowledged.length > 0 && (
          <div className="hp-acked">
            {/* Read is not gone. Hiding these with no way back would make the
                button a deletion, and the finding is still true. */}
            <button type="button" className="hp-acked-toggle" onClick={() => setShowAcked(v => !v)}>
              {showAcked ? '▾' : '▸'} {acknowledged.length} read — still true, back if {acknowledged.length === 1 ? 'it happens' : 'they happen'} again
            </button>
            {showAcked && acknowledged.map(f => (
              <div className="hp-finding hp-finding--read" key={f.id}>
                <div className="hp-finding-title">{f.title}</div>
                <div className="hp-finding-detail">{f.detail}</div>
                <button type="button" className="hp-finding-ack" onClick={() => setAck(f.id, false)}>
                  Show it again
                </button>
              </div>
            ))}
          </div>
        )}
        {(signals?.unknowns || []).length > 0 && (
          <div className="hp-quiet">
            Couldn’t check: {signals.unknowns.map(u => u.input).join(', ')} — so this isn’t an all-clear.
          </div>
        )}
      </section>

      {/* ── Trends ─────────────────────────────────────────────────
          Small multiples: one measure per chart, one axis each. Never two
          y-scales on one plot — HRV and resting heart rate share no scale and
          drawing them together would invent a relationship out of the units. */}
      <section className="hp-section">
        <h3 className="hp-h3">
          Trends
          <span className="hp-h3-note">{days.length} complete days</span>
        </h3>
        <div className="hp-grid">
          {/* spanYear only past 90 days: below that every tick carries the same
              year and printing it five times is noise. */}
          {TRENDS.map(t => (
            <TrendChart key={t.key} valueKey={t.key} days={days} spanYear={range > 90} {...t} />
          ))}
        </div>
      </section>

      {/* ── Sleep ──────────────────────────────────────────────────
          Stacked, one bar per night, using a SEQUENTIAL ramp because the stages
          are ordered and this is one measure split by depth. An unstaged night
          draws one flat neutral bar rather than inventing a shape from a single
          whole-night figure. */}
      <section className="hp-section">
        <h3 className="hp-h3">
          Sleep
          <span className="hp-legend">
            {['deep', 'core', 'rem'].map(st => (
              <span className="hp-legend-item" key={st}>
                <i style={{ background: SLEEP_RAMP[st] }} />{st.toUpperCase() === 'REM' ? 'REM' : st}
              </span>
            ))}
            <span className="hp-legend-item"><i className="hp-swatch-unstaged" />unstaged</span>
          </span>
        </h3>
        {nights.length === 0 ? (
          <div className="hp-quiet">No sleep recorded in the last fortnight.</div>
        ) : nights.map(n => {
          const total = n.asleepHours || 0;
          return (
            <div className="hp-night" key={n.night}>
              <span className="hp-night-date">{n.night.slice(5)}</span>
              <span className="hp-night-bar" title={`${total}h asleep`}>
                {n.asleepSource === 'staged'
                  ? ['deep', 'core', 'rem'].map(st => (
                    n.stages?.[st] ? (
                      <span
                        key={st}
                        className="hp-seg"
                        style={{ background: SLEEP_RAMP[st], flexGrow: n.stages[st] }}
                        title={`${st} ${n.stages[st]}h`}
                      />
                    ) : null
                  ))
                  : <span className="hp-seg hp-seg--unstaged" style={{ flexGrow: 1 }} title="whole-night total only — no stage breakdown recorded" />}
              </span>
              <span className="hp-night-total">{total}h</span>
              <span className="hp-night-eff">{n.efficiency === null ? '—' : `${n.efficiency}%`}</span>
            </div>
          );
        })}
      </section>

      {/* ── What is arriving ───────────────────────────────────────
          The diagnostic half. Freshness, not volume, is what says a feed has
          stopped: iOS decides when the phone syncs, so a gap is the EXPECTED
          failure and a row count cannot show it. */}
      <section className="hp-section">
        <h3 className="hp-h3">
          Data arriving
          <span className="hp-h3-note">
            {metrics?.metricCount || 0} metrics · {(metrics?.allTime?.samples || 0).toLocaleString()} samples all-time
          </span>
        </h3>
        <table className="hp-table">
          <thead><tr><th>Metric</th><th>Samples (30d)</th><th>Last seen</th></tr></thead>
          <tbody>
            {shownMetrics.map(m => (
              <tr key={m.metric}>
                <td>{m.metric}</td>
                <td className="hp-num">{m.samples.toLocaleString()}</td>
                <td className={`hp-num${m.ageHours > 48 ? ' hp-stale' : ''}`}>
                  {m.ageHours === null ? '?' : m.ageHours < 1 ? 'just now' : m.ageHours < 48 ? `${Math.round(m.ageHours)}h ago` : `${Math.round(m.ageHours / 24)}d ago`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {allMetrics.length > 10 && (
          <button className="hp-more" onClick={() => setShowAllMetrics(v => !v)}>
            {showAllMetrics ? 'Show fewer' : `Show all ${allMetrics.length}`}
          </button>
        )}
      </section>
    </div>
  );
}
