// The NEURO and SAiM marks (6 Nov 2026, from Nick's mockup). Inline SVG so they
// need no asset request and inherit nothing but size. Purely decorative: each
// lockup carries its name as real text beside the mark, so the SVGs are hidden
// from assistive tech.
import './BrandMarks.css';

/** NEURO: a small constellation — one node, eight around it, faint links. */
export function NeuroMark({ size = 26 }) {
  const outer = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    return [16 + Math.cos(a) * 11, 16 + Math.sin(a) * 11];
  });
  return (
    <svg className="brand-mark brand-mark--neuro" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <g stroke="currentColor" strokeWidth="0.6" opacity="0.35">
        {outer.map(([x, y], i) => <line key={`s${i}`} x1="16" y1="16" x2={x} y2={y} />)}
        {outer.map(([x, y], i) => {
          const [nx, ny] = outer[(i + 1) % outer.length];
          return <line key={`r${i}`} x1={x} y1={y} x2={nx} y2={ny} />;
        })}
      </g>
      <g fill="currentColor">
        <circle cx="16" cy="16" r="2.6" />
        {outer.map(([x, y], i) => <circle key={`n${i}`} cx={x} cy={y} r={i % 2 ? 1.3 : 1.8} />)}
      </g>
    </svg>
  );
}

/** SAiM: a tilted orbit with her light inside it and a point riding the ring. */
export function SaimMark({ width = 40 }) {
  const height = Math.round(width * 0.56);
  return (
    <svg className="brand-mark brand-mark--saim" width={width} height={height} viewBox="0 0 50 28" aria-hidden="true" focusable="false">
      {/* A long, tilted orbit; her light at its centre; a point riding the ring near its upper-right end. */}
      <ellipse cx="25" cy="14" rx="22" ry="7" transform="rotate(-20 25 14)" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="25" cy="14" r="4.6" className="brand-mark__core" />
      <circle cx="42.7" cy="4.4" r="2.3" fill="currentColor" />
    </svg>
  );
}

/** The top-bar lockup: mark, NEURO, and what it stands for. */
export function NeuroLockup() {
  return (
    <span className="brand-lockup brand-lockup--neuro">
      <NeuroMark />
      <span className="brand-lockup__text">
        <span className="brand-word">NEURO</span>
        <span className="brand-sub">Neural Engine for Unified Reasoning &amp; Orchestration</span>
      </span>
    </span>
  );
}

/** The SAiM workspace header lockup. */
export function SaimLockup() {
  return (
    <span className="brand-lockup brand-lockup--saim">
      <SaimMark />
      <span className="brand-lockup__text">
        <span className="brand-word">SA<span className="brand-word__i">i</span>M</span>
        <span className="brand-sub">Situational Awareness &amp; Intelligence Module</span>
      </span>
    </span>
  );
}
