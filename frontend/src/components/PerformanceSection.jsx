import React, { useCallback, useEffect, useState } from 'react';
import { apiUrl, apiFetch } from '../api';
import './PerformanceSection.css';

/**
 * Recovery, exertion and what the weather logger adds — NEURO's Athlytic-style
 * half of My Health. The desk view: every number, with its basis. SAiM only
 * ever says one fact from this (a training-load spike, a warm room that has
 * mattered); the rest lives here, where he goes looking.
 *
 * ⚠ HONESTY RULES CARRIED FROM THE BACKEND, NOT RE-DECIDED:
 *   • the exertion scale is Banister TRIMP and is NOT Athlytic's — said once;
 *   • the target is a SUGGESTION, and training-load bands are a heuristic;
 *   • a relationship is shown as a finding only when the service called it one
 *     (corrected p) — otherwise "no clear link", with the numbers;
 *   • unknown is a sentence with its reason, never a blank or a zero.
 *
 * `Chart` is HealthPanel's TrendChart, passed in so there is one chart component
 * and one definition of what a gap means.
 */

// Validated ordinal ramp (one hue, monotone lightness, clears --bg-card):
// dim → bright as the heart works harder. Deliberately NOT --warning's orange,
// which is reserved for status.
const ZONE_RAMP = ['#1f5f5c', '#2b7f78', '#3aa196', '#5cc2b3', '#8fe0d2'];
const ZONE_FRACTIONS = [0.2, 0.3, 0.4, 0.5, 0.6];

const LOAD_WORDS = {
  spike: 'well above your usual',
  building: 'building',
  steady: 'steady',
  easing: 'easing off',
};

function fmtMins(m) {
  if (!Number.isFinite(m)) return '—';
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(Math.round(m % 60)).padStart(2, '0')}m` : `${Math.round(m)}m`;
}

/** Zone band floors in bpm, from the scale the day was judged on. */
function bandBpm(rest, max) {
  if (!Number.isFinite(rest) || !Number.isFinite(max)) return null;
  return ZONE_FRACTIONS.map((f) => Math.round(rest + f * (max - rest)));
}

function ZoneBar({ day }) {
  if (!day) return null;
  const total = day.zoneMinutes.reduce((a, b) => a + (b || 0), 0);
  const bpm = bandBpm(day.restHr, day.maxHr);
  return (
    <div className="ps-zones">
      <div className="ps-zone-bar" role="img"
        aria-label={`Time in heart-rate bands: ${day.zoneMinutes.map((m, i) => `band ${i + 1} ${Math.round(m)} minutes`).join(', ')}`}>
        {total > 0 ? day.zoneMinutes.map((m, i) => (m > 0 ? (
          <span key={i} className="ps-zone-seg"
            style={{ background: ZONE_RAMP[i], flexGrow: m }}
            title={`${bpm ? `${bpm[i]}+ bpm` : `band ${i + 1}`}: ${fmtMins(m)}`} />
        ) : null)) : <span className="ps-zone-empty">No time above {bpm ? `${bpm[0]} bpm` : 'the first band'} yet.</span>}
      </div>
      <div className="ps-legend">
        {ZONE_RAMP.map((c, i) => (
          <span className="ps-legend-item" key={i}>
            <i style={{ background: c }} />{bpm ? `${bpm[i]}+` : `band ${i + 1}`} · {fmtMins(day.zoneMinutes[i])}
          </span>
        ))}
      </div>
    </div>
  );
}

function Hero({ label, value, unit, sub, tone }) {
  return (
    <div className={`ps-hero${tone ? ` ps-hero--${tone}` : ''}`}>
      <div className="ps-hero-label">{label}</div>
      <div className="ps-hero-value">{value}{unit && <span className="ps-hero-unit">{unit}</span>}</div>
      {sub && <div className="ps-hero-sub">{sub}</div>}
    </div>
  );
}

function LocationForm({ onSaved }) {
  const [label, setLabel] = useState('bedroom');
  const [since, setSince] = useState(new Date().toISOString().slice(0, 10));
  const [err, setErr] = useState(null);
  const save = async (e) => {
    e.preventDefault();
    setErr(null);
    try {
      const res = await apiFetch('/api/performance/logger-location', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, since }),
      });
      const out = await res.json();
      if (!out.ok) { setErr(out.reason || 'not saved'); return; }
      onSaved();
    } catch {
      setErr('could not reach NEURO');
    }
  };
  return (
    <form className="ps-form" onSubmit={save}>
      <label>The logger lives in the <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} /></label>
      <label>since <input type="date" value={since} onChange={(e) => setSince(e.target.value)} /></label>
      <button type="submit">Save</button>
      {err && <span className="ps-err">{err}</span>}
    </form>
  );
}

export default function PerformanceSection({ Chart, initial = null }) {
  // `initial` lets a render test (or a preview) hand the section its data, so
  // what is pinned is what renders — the loaders below are the live path.
  const [d, setD] = useState(initial);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const get = (p) => fetch(apiUrl(p)).then((r) => r.json());
      const [today, exertion, fitness, sleepEnv, heat] = await Promise.all([
        get('/api/performance/today'),
        get('/api/performance/exertion?days=90'),
        get('/api/performance/fitness'),
        get('/api/performance/sleep-environment'),
        get('/api/performance/heat-cost'),
      ]);
      setD({ today, exertion, fitness, sleepEnv, heat });
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => { if (!initial) load(); }, [load, initial]);

  if (failed) return <section className="hp-section"><div className="hp-quiet hp-quiet--err">Couldn’t read recovery and exertion. This is not an all-clear.</div></section>;
  if (!d) return <section className="hp-section"><div className="hp-quiet">Reading exertion…</div></section>;

  const { today, exertion, fitness, sleepEnv, heat } = d;
  const tl = today.trainingLoad || {};
  const tg = today.target || {};
  const now = today.today;
  const rows = (exertion.days || []).filter((r) => r.complete);

  return (
    <>
      <section className="hp-section">
        <h3 className="hp-h3">
          Exertion
          <span className="hp-h3-note">{today.scale}</span>
        </h3>
        <div className="ps-heroes">
          <Hero label="So far today" value={now && Number.isFinite(now.score) ? now.score : '—'} unit="/10"
            sub={now ? `load ${Math.round(now.load)} · ${fmtMins(now.elevatedMinutes)} above resting + 10${now.partial ? ' · partial day' : ''}` : 'no heart rate yet today'} />
          <Hero label="Yesterday" value={today.yesterday && Number.isFinite(today.yesterday.score) ? today.yesterday.score : '—'} unit="/10"
            sub={today.yesterday ? `load ${Math.round(today.yesterday.load)}` : 'not rolled up yet'} />
          <Hero label="Suggested today" value={tg.known ? `${tg.low}–${tg.high}` : '—'}
            sub={tg.known ? `load, for ${tg.recovery === 'low' ? 'low' : tg.recovery === 'high' ? 'high' : 'normal'} recovery — a suggestion` : tg.why} />
          <Hero label="Training load" value={tl.known ? `${tl.ratio}×` : '—'} tone={tl.state === 'spike' ? 'notice' : null}
            sub={tl.known ? `${LOAD_WORDS[tl.state] || tl.state} · 7-day ${tl.acute} vs 28-day ${tl.chronic}` : tl.why} />
        </div>
        <ZoneBar day={now} />
        {tl.known && <div className="hp-caveat">{tl.basis}</div>}
        {rows.length > 0 && (
          <div className="hp-grid ps-grid-one">
            <Chart title="Exertion per day" valueKey="load" unit="" dp={0} days={rows}
              note="Banister load, above resting + 10 bpm" />
          </div>
        )}
      </section>

      <section className="hp-section">
        <h3 className="hp-h3">Cardio fitness<span className="hp-h3-note">{fitness.note}</span></h3>
        <div className="hp-grid">
          {[['VO2 max', fitness.vo2max, 'higher is fitter'], ['Walking heart rate', fitness.walkingHr, 'lower is fitter']].map(([title, s, dir]) => (
            s && s.series && s.series.length ? (
              <Chart key={title} title={title} valueKey="value" unit={s.unit === 'bpm' ? 'bpm' : ''} dp={1}
                days={[...s.series].reverse().map((p) => ({ day: p.week, value: p.value }))}
                spanYear
                note={`Weekly median · ${dir}${Number.isFinite(s.change90d) ? ` · ${s.change90d > 0 ? '+' : ''}${s.change90d} over 90 days` : ''}`} />
            ) : (
              <div className="hp-chart hp-chart--na" key={title}>
                <div className="hp-chart-head"><span className="hp-chart-title">{title}</span></div>
                <div className="hp-quiet">No readings in the last two years.</div>
              </div>
            )
          ))}
        </div>
      </section>

      <section className="hp-section">
        <h3 className="hp-h3">Sleep and the room<span className="hp-h3-note">from the weather logger</span></h3>
        {sleepEnv.needsLocation ? (
          <>
            <div className="hp-quiet">{sleepEnv.why}. Say where it lives now and only nights from then are compared with your sleep.</div>
            <LocationForm onSaved={load} />
          </>
        ) : !sleepEnv.known ? (
          <div className="hp-quiet">{sleepEnv.why}</div>
        ) : (
          <>
            <p className="hp-sentence">{sleepEnv.sentence}</p>
            <table className="hp-table">
              <thead><tr><th>Sleep measure</th><th>Nights</th><th>Cooler room</th><th>Warmer room</th><th>p</th></tr></thead>
              <tbody>
                {sleepEnv.results.map((r) => (
                  <tr key={r.outcome}>
                    <td>{r.label}</td>
                    <td className="hp-num">{r.nights}</td>
                    <td className="hp-num">{r.known ? `${r.coolValue}${r.unit} at ${r.coolRoomC}°C` : '—'}</td>
                    <td className="hp-num">{r.known ? `${r.warmValue}${r.unit} at ${r.warmRoomC}°C` : '—'}</td>
                    <td className="hp-num">{r.known ? `${r.p}${r.significant ? ' ✓' : ''}` : r.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="hp-caveat">{sleepEnv.caveat} ✓ = below the corrected threshold of {sleepEnv.threshold}.</div>
          </>
        )}
      </section>

      <section className="hp-section">
        <h3 className="hp-h3">Heat cost on hikes<span className="hp-h3-note">heart beats above resting per km/h, against the day’s temperature</span></h3>
        {!heat.known ? (
          <div className="hp-quiet">{heat.why}.</div>
        ) : (
          <p className="hp-sentence">
            {heat.significant
              ? `Across ${heat.hikes.length} hikes, effort rises with the heat (temperature r = ${heat.temperature.r}, p = ${heat.temperature.p}).`
              : `No clear link between the heat and your effort across ${heat.hikes.length} hikes (temperature p = ${heat.temperature.p}).`}
          </p>
        )}
        {heat.hikes && heat.hikes.length > 0 && (
          <table className="hp-table">
            <thead><tr><th>Hike</th><th>Effort</th><th>Temperature</th><th>Dew point</th></tr></thead>
            <tbody>
              {heat.hikes.map((h) => (
                <tr key={h.startedAt}>
                  <td>{String(h.startedAt).slice(0, 16)}</td>
                  <td className="hp-num">{h.effort}</td>
                  <td className="hp-num">{h.tempC}°C</td>
                  <td className="hp-num">{h.dewPointC == null ? '—' : `${h.dewPointC}°C`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
