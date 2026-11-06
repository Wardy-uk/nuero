// The NEURO and SAiM marks (6 Nov 2026, from Nick's approved mockup). Inline SVG
// so they need no asset request. Purely decorative: each lockup carries its name
// as real text beside the mark, so the SVGs are hidden from assistive tech.
import './BrandMarks.css';

// NEURO's connected-node shape — the same pear-shaped network as the app's
// shortcut icon (frontend/public/favicon.svg), node for node.
const NEURO_NODES = [
  [256, 140, 22], [170, 220, 18], [342, 220, 18], [140, 320, 15],
  [256, 300, 20], [372, 320, 15], [210, 390, 16], [310, 390, 16],
];
const NEURO_LINKS = [
  [0, 1], [0, 2], [1, 3], [1, 4], [2, 5], [2, 4], [3, 6], [4, 6], [4, 7], [5, 7],
];

/** NEURO: the connected-node network from the shortcut icon. */
export function NeuroMark({ size = 32 }) {
  return (
    <svg className="brand-mark brand-mark--neuro" width={Math.round(size * 0.92)} height={size} viewBox="118 112 276 302" aria-hidden="true" focusable="false">
      <g stroke="currentColor" strokeWidth="9" strokeLinecap="round" opacity="0.75">
        {NEURO_LINKS.map(([a, b]) => (
          <line key={`${a}-${b}`} x1={NEURO_NODES[a][0]} y1={NEURO_NODES[a][1]} x2={NEURO_NODES[b][0]} y2={NEURO_NODES[b][1]} />
        ))}
      </g>
      <g fill="currentColor">
        {NEURO_NODES.map(([x, y, r], i) => <circle key={i} cx={x} cy={y} r={r + 4} />)}
      </g>
    </svg>
  );
}

/** SAiM: a long tilted orbit, her blue light at the centre, a white satellite on the ring. */
export function SaimMark({ width = 44 }) {
  const height = Math.round(width * 0.56);
  return (
    <svg className="brand-mark brand-mark--saim" width={width} height={height} viewBox="0 0 50 28" aria-hidden="true" focusable="false">
      <ellipse cx="25" cy="14" rx="21.5" ry="6.8" transform="rotate(-20 25 14)" fill="none" className="brand-mark__ring" strokeWidth="1.7" />
      <circle cx="25" cy="14" r="5.4" className="brand-mark__core" />
      <circle cx="42.4" cy="4.6" r="3" className="brand-mark__satellite" />
    </svg>
  );
}

/** SAiM's name: white letters, an electric-blue lowercase i. */
export function SaimWord() {
  return <span className="brand-word" aria-label="SAiM">SA<span className="brand-word__i">i</span>M</span>;
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
        <SaimWord />
        <span className="brand-sub">Situational Awareness &amp; Intelligence Module</span>
      </span>
    </span>
  );
}

/** The sidebar entry: same mark, lettering and colours, at menu size. */
export function SaimMenuLabel() {
  return (
    <span className="brand-side">
      <SaimMark width={22} />
      <SaimWord />
    </span>
  );
}
