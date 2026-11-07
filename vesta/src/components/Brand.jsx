// VESTA's lockup and the "Powered by NEURO" attribution (7 Nov 2026, Nick's
// approved wall mockup). All inline SVG: sharp at any size, no asset request,
// no font to load. The marks are decorative — each lockup carries its name as
// real text for assistive tech — so the SVGs are hidden from it.
import './Brand.css';

// The hearth mark (Nick's logo, 7 Nov 2026): two bronze flame tongues rising
// from a hearth ring. One set of paths, shared by the lockup and the app icons
// (vesta/public/icon.svg is generated from these by vesta-brand.test.js's
// check — keep them in step). The ring takes `currentColor`, so it is charcoal
// on a light ground and ivory on the wall's dark one; the flame stays bronze.
export const MARK_VIEWBOX = '30 4 194 174';
export const MARK_FLAME = '#b07836';
export const MARK_PATHS = {
  // Open at the top: the ring tapers to nothing either side of the flame.
  ring: 'M92.1 121A92.5 27.5 0 1 0 174.3 123A71 21 0 1 1 92.1 121Z',
  tall: 'M133 9C142 20 147 34 145 50C143 64 128 82 115 92C108 98 105 108 106 118C107 126 108 132 108 139C99 132 92 124 90 112C88 98 90 84 97 72C104 60 116 52 124 42C129 34 132 22 133 9Z',
  short: 'M158 59C162 68 166 78 165 88C164 104 157 116 148 122C138 130 130 136 128 144C127 148 125 151 124 153C121 148 119 140 119 132C119 120 124 108 132 101C142 92 153 78 158 59Z',
};

/** VESTA's mark: the hearth. Height sets the size. */
export function VestaMark({ size = 48 }) {
  return (
    <svg className="vbrand__mark" height={size} width={Math.round(size * 1.115)} viewBox={MARK_VIEWBOX} aria-hidden="true" focusable="false">
      <path d={MARK_PATHS.ring} fill="currentColor" fillRule="evenodd" />
      <path d={MARK_PATHS.tall} fill={MARK_FLAME} />
      <path d={MARK_PATHS.short} fill={MARK_FLAME} />
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
        <VestaMark />
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
