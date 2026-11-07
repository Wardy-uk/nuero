// VESTA's lockup and the "Powered by NEURO" attribution (7 Nov 2026, Nick's
// approved wall mockup). All inline SVG: sharp at any size, no asset request,
// no font to load. The marks are decorative — each lockup carries its name as
// real text for assistive tech — so the SVGs are hidden from it.
import './Brand.css';

/** The hearth: a warm amber flame with a lighter heart. */
export function VestaFlame({ size = 48 }) {
  return (
    <svg className="vbrand__flame" width={Math.round(size * 0.78)} height={size} viewBox="0 0 39 50" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="vbrandOuter" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffc457" />
          <stop offset="1" stopColor="#e2701c" />
        </linearGradient>
        <linearGradient id="vbrandInner" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe3a3" />
          <stop offset="1" stopColor="#f7a33a" />
        </linearGradient>
      </defs>
      {/* Outer flame: a tall lick rising from a rounded base. */}
      <path fill="url(#vbrandOuter)" d="M19.4 1.5c1.6 7.3-1.7 11.4-5.3 15.9C10.2 22.3 6 27.5 6 34.4 6 42.4 12 48.5 19.6 48.5c7.8 0 13.4-6 13.4-13.9 0-5.7-2.6-10.4-5.8-14.4.4 3.6-.7 6.6-3 8.3.6-9.7-1.3-17.6-4.8-22.9z" />
      {/* Inner flame: the bright heart, set low. */}
      <path fill="url(#vbrandInner)" d="M20.6 23.4c.6 4.4-2.4 6.6-4.4 9.2-1.4 1.8-2.3 3.7-2.3 6 0 4 2.8 7 6.2 7 3.6 0 6.3-2.9 6.3-6.8 0-2.6-1.1-4.8-2.6-6.7-.2 1.6-.9 2.8-2 3.5.2-4.6-.5-8.7-1.2-12.2z" />
    </svg>
  );
}

/**
 * VESTA in rounded, smooth letters. Drawn as round-capped strokes rather than
 * set in a font, so the lettering is the approved shape everywhere (no
 * angular or stencil fallback). Ivory; height sets the size.
 */
export function VestaWordmark({ height = 40 }) {
  return (
    <svg className="vbrand__word" height={height} width={Math.round(height * 4)} viewBox="0 0 240 60" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 8 L25 52 L45 8" />
        <path d="M89 8 H62 V52 H89 M62 30 H84" />
        <path d="M134 15 C130 9.5 124 8 118.5 8 C110.5 8 105 12.5 105 19 C105 26 111 28.5 119.5 30.5 C128.5 32.5 135.5 35.5 135.5 42.5 C135.5 49 129.5 52.5 120.5 52.5 C113.5 52.5 107.5 50 104 45" />
        <path d="M149 8 H185 M167 8 V52" />
        <path d="M196 52 L216 8 L236 52 M203.5 37.5 H228.5" />
      </g>
    </svg>
  );
}

export const VESTA_EXPANSION = 'Versatile Everyday Space for Tasks & Answers';

/** The wall's top-left lockup: flame, VESTA, and what it stands for. */
export function VestaLockup() {
  return (
    <div className="vbrand" role="img" aria-label={`VESTA — ${VESTA_EXPANSION}`}>
      <div className="vbrand__row">
        <VestaFlame />
        <VestaWordmark />
      </div>
      <p className="vbrand__sub" aria-hidden="true">{VESTA_EXPANSION}</p>
    </div>
  );
}

// NEURO's connected-node shape — a COPY of frontend/src/components/BrandMarks.jsx
// (VESTA builds on its own, so it cannot import NEURO's frontend). Node for node
// the same network; vesta-brand.test.js pins the two arrays equal.
export const NEURO_NODES = [
  [256, 140, 22], [170, 220, 18], [342, 220, 18], [140, 320, 15],
  [256, 300, 20], [372, 320, 15], [210, 390, 16], [310, 390, 16],
];
export const NEURO_LINKS = [
  [0, 1], [0, 2], [1, 3], [1, 4], [2, 5], [2, 4], [3, 6], [4, 6], [4, 7], [5, 7],
];

/** NEURO's mark, sized in em so it follows the text beside it. */
export function NeuroMark() {
  return (
    <svg className="vbrand__neuro" viewBox="118 112 276 302" aria-hidden="true" focusable="false">
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

/** "Powered by ⟡ NEURO", one size and weight throughout, the build beneath. */
export function PoweredByNeuro({ build }) {
  return (
    <span className="vbrand__powered">
      <span className="vbrand__poweredline">Powered by <NeuroMark /> NEURO</span>
      {build ? <span className="vbrand__build">{`v ${build}`}</span> : null}
    </span>
  );
}
