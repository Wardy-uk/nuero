import React, { useEffect, useRef, useState } from 'react';
import { londonTime, pointAt } from './workoutFormat';

/**
 * The two charts on a workout page: elevation along the distance, and heart
 * rate along the time. One measure per chart, one axis each. A hover on either
 * moves a shared cursor (a unix second) that the map and the other chart follow.
 * Sized from the MEASURED container, never a stretched viewBox (a stretched one
 * turns the cursor dot into an ellipse).
 */

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((e) => { const cw = Math.round(e[0].contentRect.width); if (cw > 0) setW(cw); });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const PAD = { l: 44, r: 12, t: 10, b: 24 };

function niceStep(span, target) {
  const raw = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 5, 10].map((f) => f * mag).find((s) => s >= raw) || mag * 10;
}

export function ProfileChart({ profile = [], cursorT = null, onCursor = () => {}, height = 180 }) {
  const [ref, width] = useWidth();
  if (profile.length < 2) return <div className="wk-chart-empty">No elevation along the track.</div>;
  const kmMax = profile[profile.length - 1].km || 1;
  const eles = profile.map((p) => p.eleM);
  const lo = Math.floor(Math.min(...eles) / 10) * 10 - 10;
  const hi = Math.ceil(Math.max(...eles) / 10) * 10 + 10;
  const W = width - PAD.l - PAD.r; const H = height - PAD.t - PAD.b;
  const x = (k) => PAD.l + (k / kmMax) * W;
  const y = (e) => PAD.t + (1 - (e - lo) / (hi - lo)) * H;
  const line = profile.map((p, i) => `${i ? 'L' : 'M'}${x(p.km).toFixed(1)},${y(p.eleM).toFixed(1)}`).join('');
  const area = `${line}L${x(kmMax).toFixed(1)},${PAD.t + H}L${PAD.l},${PAD.t + H}Z`;
  const ks = niceStep(kmMax, 8); const es = niceStep(hi - lo, 4);
  const cur = pointAt(profile, cursorT);
  const move = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const k = ((e.clientX - rect.left - PAD.l) / W) * kmMax;
    let best = profile[0];
    for (const p of profile) if (Math.abs(p.km - k) < Math.abs(best.km - k)) best = p;
    onCursor(best.t);
  };
  return (
    <div ref={ref} className="wk-chart">
      <svg width={width} height={height} onMouseMove={move} onMouseLeave={() => onCursor(null)} role="img" aria-label="Elevation along the route">
        {Array.from({ length: Math.floor((hi - lo) / es) + 1 }, (_, i) => lo + i * es).map((e) => (
          <g key={`e${e}`}><line x1={PAD.l} x2={PAD.l + W} y1={y(e)} y2={y(e)} className="wk-grid" /><text x={PAD.l - 6} y={y(e) + 4} className="wk-axis" textAnchor="end">{e} m</text></g>
        ))}
        {Array.from({ length: Math.floor(kmMax / ks) + 1 }, (_, i) => i * ks).map((k) => (
          <text key={`k${k}`} x={x(k)} y={height - 6} className="wk-axis" textAnchor="middle">{k} km</text>
        ))}
        <path d={area} className="wk-area" />
        <path d={line} className="wk-line" />
        {cur && <g><line x1={x(cur.km)} x2={x(cur.km)} y1={PAD.t} y2={PAD.t + H} className="wk-cursor" /><circle cx={x(cur.km)} cy={y(cur.eleM)} r={4} className="wk-cursor-dot" />
          <text x={Math.min(x(cur.km) + 6, PAD.l + W - 90)} y={PAD.t + 12} className="wk-cursor-label">{cur.km.toFixed(2)} km · {Math.round(cur.eleM)} m · {londonTime(cur.t)}</text></g>}
      </svg>
    </div>
  );
}

export function HeartRateChart({ series = [], bands = null, cursorT = null, onCursor = () => {}, height = 180 }) {
  const [ref, width] = useWidth();
  if (series.length < 2) return <div className="wk-chart-empty">No heart-rate samples during this workout.</div>;
  const t0 = series[0].t; const t1 = series[series.length - 1].t;
  const bpms = series.map((s) => s.bpm);
  const lo = Math.floor(Math.min(...bpms) / 10) * 10 - 5;
  const hi = Math.ceil(Math.max(...bpms) / 10) * 10 + 5;
  const W = width - PAD.l - PAD.r; const H = height - PAD.t - PAD.b;
  const x = (t) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (b) => PAD.t + (1 - (b - lo) / (hi - lo)) * H;
  // A gap of more than two minutes is drawn as a gap, not a line across it.
  let d = ''; let prev = null;
  for (const s of series) { d += `${prev && s.t - prev.t <= 120 ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(s.bpm).toFixed(1)}`; prev = s; }
  const bs = niceStep(hi - lo, 4);
  const stepS = niceStep((t1 - t0) / 60, 6) * 60;
  const firstTick = Math.ceil(t0 / stepS) * stepS;
  const ticks = []; for (let t = firstTick; t <= t1; t += stepS) ticks.push(t);
  let cur = null;
  if (cursorT != null) { cur = series[0]; for (const s of series) if (Math.abs(s.t - cursorT) < Math.abs(cur.t - cursorT)) cur = s; }
  const shade = bands && bands.rows ? bands.rows.map((r, i) => ({ from: r.fromBpm ?? lo, to: r.toBpm ?? hi, i })) : [];
  const move = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = t0 + ((e.clientX - rect.left - PAD.l) / W) * (t1 - t0);
    onCursor(Math.max(t0, Math.min(t1, Math.round(t))));
  };
  return (
    <div ref={ref} className="wk-chart">
      <svg width={width} height={height} onMouseMove={move} onMouseLeave={() => onCursor(null)} role="img" aria-label="Heart rate during the workout">
        {shade.map((b) => {
          const top = y(Math.min(hi, b.to)); const bot = y(Math.max(lo, b.from));
          return bot > top ? <rect key={b.i} x={PAD.l} width={W} y={top} height={bot - top} className={`wk-band wk-band--${b.i}`} /> : null;
        })}
        {Array.from({ length: Math.floor((hi - lo) / bs) + 1 }, (_, i) => Math.ceil(lo / bs) * bs + i * bs).filter((b) => b <= hi).map((b) => (
          <g key={`b${b}`}><line x1={PAD.l} x2={PAD.l + W} y1={y(b)} y2={y(b)} className="wk-grid" /><text x={PAD.l - 6} y={y(b) + 4} className="wk-axis" textAnchor="end">{b}</text></g>
        ))}
        {ticks.map((t) => <text key={t} x={x(t)} y={height - 6} className="wk-axis" textAnchor="middle">{londonTime(t)}</text>)}
        <path d={d} className="wk-line wk-line--hr" />
        {cur && <g><line x1={x(cur.t)} x2={x(cur.t)} y1={PAD.t} y2={PAD.t + H} className="wk-cursor" /><circle cx={x(cur.t)} cy={y(cur.bpm)} r={4} className="wk-cursor-dot" />
          <text x={Math.min(x(cur.t) + 6, PAD.l + W - 80)} y={PAD.t + 12} className="wk-cursor-label">{cur.bpm} bpm · {londonTime(cur.t)}</text></g>}
      </svg>
    </div>
  );
}
