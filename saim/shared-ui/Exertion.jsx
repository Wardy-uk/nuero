import { useState } from 'react';
import { Lit, LitLabel } from './Lit.jsx';
import './Exertion.css';

/**
 * Exertion, in SAiM's voice — the web half of `SaimExertionViews.swift`.
 *
 * ⚠ ONE COMPONENT for the PWA, the kiosk and the Electron window (all three
 * mount `app/src/views/Now.jsx`). NEURO's desk screen lays out every number;
 * SAiM says the one sentence — `line`, composed by the BACKEND so iOS and the
 * web cannot word it differently — and the rest opens in place on a tap.
 *
 * ⚠ Renders nothing without a reading. A zero bar for a day nobody measured is
 * the calm-day lie this codebase keeps refusing.
 *
 * Takes `/api/performance/today` as `data`, passed in so the screen owns the
 * fetch and a failure there cannot take anything else with it.
 */

// The validated data ramp — the same five values as NEURO and iOS. One hue,
// dim → bright; it is not a status colour, and text never wears it.
const RAMP = ['#1f5f5c', '#2b7f78', '#3aa196', '#5cc2b3', '#8fe0d2'];

function mins(m) {
  const h = Math.floor((m || 0) / 60);
  return h ? `${h}h ${String(Math.round((m || 0) % 60)).padStart(2, '0')}m` : `${Math.round(m || 0)}m`;
}

function Bar({ day }) {
  const zones = (day.zoneMinutes || []).map((z) => z || 0);
  const inBands = zones.reduce((a, b) => a + b, 0);
  // ⚠ Scaled against the whole day the watch saw — not the time in the bands,
  // which made an hour and a half of effort look like a hard day.
  const total = Math.max(day.coveredMinutes || 0, inBands);
  const rest = day.restHr; const max = day.maxHr;
  const bpm = Number.isFinite(rest) && Number.isFinite(max) && max > rest
    ? [0.2, 0.3, 0.4, 0.5, 0.6].map((f) => Math.round(rest + f * (max - rest))) : null;
  if (!(total > 0)) return null;
  return (
    <div className="exertion__bar" role="img"
      aria-label={zones.map((m, i) => `${bpm ? `${bpm[i]} plus` : `band ${i + 1}`}: ${mins(m)}`).join('; ')}>
      {zones.map((m, i) => (m > 0 ? (
        <span key={i} style={{ background: RAMP[i], flexGrow: m }} title={`${bpm ? `${bpm[i]}+ bpm` : `band ${i + 1}`}: ${mins(m)}`} />
      ) : null))}
      {total > inBands && <span className="exertion__rest" style={{ flexGrow: total - inBands }} />}
    </div>
  );
}

export default function Exertion({ data }) {
  const [open, setOpen] = useState(false);
  if (!data || (!data.line && !data.today)) return null;
  const tl = data.trainingLoad || {};
  const tg = data.target || {};
  return (
    <Lit className="exertion">
      <button type="button" className="exertion__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <LitLabel as="span">Exertion</LitLabel>
        {data.line && <span className="exertion__say">{data.line}</span>}
      </button>
      {data.today && <Bar day={data.today} />}
      {open && (
        <div className="exertion__more">
          {tg.known && (
            <p>A day around {tg.low}–{tg.high} suits {tg.recovery || 'normal'} recovery.
              <span className="exertion__faint"> A suggestion, from your own usual load.</span></p>
          )}
          {tl.known
            ? <p>This week is {tl.ratio}× your four-week usual.<span className="exertion__faint"> A coach’s rule of thumb, not tested on you.</span></p>
            : tl.why && <p className="exertion__faint">{tl.why}</p>}
        </div>
      )}
      <div className="exertion__faint">Heart-rate load — not Athlytic’s scale{open ? '' : ' · tap for more'}</div>
    </Lit>
  );
}
