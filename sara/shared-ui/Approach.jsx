import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './Approach.css';

// Approach — the feed, arranged in space.
//
// Chosen 13 Sep 2026 after eleven directions; the contract is `sara/MANIFESTATION.md`
// and the four rules there are what this file exists to hold:
//
//   1. DEPTH IS TIME     — where a card sits is WHEN it is. Now at the viewer's
//                          face, the end of the day at the horizon.
//   2. PULL IS URGENCY   — what needs him is dragged forward off its hour. A
//                          breaching escalation has no hour at all; it arrives.
//   3. THE TETHER        — a pulled card keeps a line back to the hour it really
//                          belongs to. Nothing is near without saying why.
//   4. ORIENTATION       — portrait narrows the corridor rather than shortening
//                          it. Fewer lanes, same depth.
//
// ⚠ IT DECIDES NOTHING. Rank, wording, what is covered and what was held back are
// all composed server-side and settled by `AttentionSurface` before anything gets
// here; this only places what it is handed. Adding a judgement to this file makes
// it a second opinion about a feed that already has one — the exact failure
// `sara/backend/src/state/inference.js` was retired for.
//
// ⚠ NO TIME IS EVER INVENTED. A card with no hour on the payload is placed by
// pull alone and says nothing about when it is. Rendering a plausible time would
// be the one thing this surface must never do.

const DEPTH = 1500;          // px of z the corridor spans
const DAY_MINUTES = 12 * 60; // ...and how many minutes that is
const PERSPECTIVE = 900;

// Minutes past local midnight, or null. Times are SLICED out of the string and
// never parsed into a Date — the backend already asked Graph for Europe/London
// wall-clock, and re-parsing re-applies an offset (the BST bug, third repo).
export function minutesOf(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/T(\d{2}):(\d{2})/) || value.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]); const mm = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  return h * 60 + mm;
}

// How far forward a card is dragged off its hour.
//
// ⚠ This READS the ranking, it does not make one. The composer put the cards in
// order and stamped each with an urgency; position and urgency are all that is
// used, so a change of mind upstream moves the corridor with it.
export function pullOf(card, index) {
  const u = String(card?.urgency || '').toLowerCase();
  if (u === 'critical') return 1;
  if (u === 'high') return 0.82;
  const byRank = Math.max(0, 0.55 - index * 0.13);
  if (u === 'normal' || u === 'medium') return Math.max(0.3, byRank);
  return byRank;
}

// Lanes. Deterministic from position so a card does not hop about between polls.
// ⚠ Kept inside the hour labels, which are drawn at the corridor's edge: a lane
// wide enough to reach them puts a card on top of the clock, which the wall
// photo showed and the source could not.
const LANES = [0.0, -0.82, 0.8, -0.4, 0.62, -0.72, 0.34, -0.55];
const ROWS = [-0.68, 0.3, -0.1, 0.88, 0.55, -0.45, 1.1, 0.08];

export default function Approach({
  cards = [],
  // Minutes past local midnight. The DEVICE's clock, which is a fact about the
  // device and not a claim about the payload — the corridor is annotated with
  // it, and no card is ever given an hour it did not arrive with.
  nowMinutes = null,
  portrait = false,
  tone = 'calm',
  onOpen = null,
}) {
  const stageRef = useRef(null);
  const rigRef = useRef(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [tilt, setTilt] = useState({ x: 0, y: 0 });

  // Measured, never assumed: the projection has to agree with the CSS
  // perspective or the tethers land somewhere the cards are not.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const read = () => {
      const r = el.getBoundingClientRect();
      setBox({ w: Math.round(r.width), h: Math.round(r.height) });
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cx = portrait ? 0.5 : 0.6;
  const laneWidth = box.w * (portrait ? 0.1 : 0.17);

  // Placement. `at` is minutes past midnight; null means no hour, which is
  // placed by pull alone and carries no tether.
  const placed = cards.map((card, i) => {
    const at = minutesOf(card.at);
    const trueZ = (at != null && nowMinutes != null)
      ? -Math.max(-60, at - nowMinutes) / DAY_MINUTES * DEPTH
      : -(260 + i * 240);
    const pull = pullOf(card, i);
    const z = trueZ * (1 - pull);
    const depth = Math.min(1, Math.abs(z) / DEPTH);
    const lane = LANES[i % LANES.length];
    const row = ROWS[i % ROWS.length];
    return {
      card,
      key: card.id || `c${i}`,
      lead: i === 0,
      at,
      tethered: at != null && pull > 0.12,
      z,
      trueZ,
      depth,
      x: lane * laneWidth * (1 - depth * 0.45),
      y: -22 + depth * box.h * 0.34 + row * box.h * 0.17 * (1 - depth * 0.35),
      trueX: lane * laneWidth,
      lane,
      row,
    };
  });

  // Hour marks and tethers, drawn once per layout change. Deliberately a canvas
  // and not a hundred absolutely-positioned divs: this redraws on every resize
  // and every pointer move, and the wall panel has one core.
  useEffect(() => {
    const cv = rigRef.current;
    if (!cv || !box.w || !box.h) return;
    const ctx = cv.getContext('2d');
    const dpr = Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1));
    cv.width = Math.round(box.w * dpr);
    cv.height = Math.round(box.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.w, box.h);

    const project = (x, y, z) => {
      const s = PERSPECTIVE / (PERSPECTIVE - z);
      return { x: box.w * cx + x * s, y: box.h * 0.44 + y * s, s };
    };
    const style = getComputedStyle(cv);
    const col = (style.getPropertyValue('--approach-rgb') || '74,127,212').trim();

    const now = nowMinutes;
    const fs = Math.max(9, Math.min(13, box.w / 125));
    ctx.font = `500 ${fs.toFixed(1)}px "JetBrains Mono", ui-monospace, monospace`;

    // The corridor itself — an hour mark every hour, receding.
    for (let m = 0; m <= DAY_MINUTES; m += 60) {
      const z = -m / DAY_MINUTES * DEPTH;
      const depth = Math.abs(z) / DEPTH;
      const a = project(0, -22 + depth * box.h * 0.34, z);
      const half = (portrait ? box.w * 0.3 : box.w * 0.42) * a.s;
      ctx.strokeStyle = `rgba(${col},${(0.2 * (1 - depth * 0.8)).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(a.x - half, a.y); ctx.lineTo(a.x + half, a.y); ctx.stroke();
      // ⚠ Labelled only where the clock is KNOWN. With no `nowLabel` the
      // corridor still draws — the shape of the day is true either way — but it
      // is not annotated with hours nobody measured.
      // ⚠ Labelled on the LEFT end of the line. Drawn at the right they sit
      // exactly where the cards do — the wall photo had the clock written
      // through `hiking` — and the corridor's centre is off to the right, so
      // its left end is empty by construction.
      if (now != null && m % 120 === 0 && depth < 0.92) {
        const t = (now + m) % 1440;
        const hh = String(Math.floor(t / 60)).padStart(2, '0');
        const mm = String(t % 60).padStart(2, '0');
        ctx.fillStyle = `rgba(${col},${(0.42 * (1 - depth)).toFixed(3)})`;
        ctx.textAlign = 'right';
        ctx.fillText(`${hh}:${mm}`, a.x - half - 8, a.y + fs * 0.35);
        ctx.textAlign = 'left';
      }
    }

    // Rule 3: a pulled card keeps a line back to the hour it belongs to.
    placed.forEach((p) => {
      if (!p.tethered) return;
      const dT = Math.abs(p.trueZ) / DEPTH;
      const from = project(
        p.trueX * (1 - dT * 0.45),
        -22 + dT * box.h * 0.34 + p.row * box.h * 0.17 * (1 - dT * 0.35),
        p.trueZ,
      );
      const to = project(p.x, p.y, p.z);
      ctx.strokeStyle = `rgba(${col},0.34)`;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = `rgba(${col},0.5)`;
      ctx.beginPath(); ctx.arc(from.x, from.y, 2.2, 0, Math.PI * 2); ctx.fill();
    });
  }, [box.w, box.h, cx, portrait, nowMinutes, cards, tilt.x, tilt.y]);

  if (!cards.length) return null;

  return (
    <div
      className={`approach${portrait ? ' approach--portrait' : ''} approach--${tone}`}
      ref={stageRef}
      onPointerMove={(e) => {
        const r = stageRef.current.getBoundingClientRect();
        setTilt({
          x: ((e.clientX - r.left) / r.width - 0.5) * 2,
          y: ((e.clientY - r.top) / r.height - 0.5) * 1.2,
        });
      }}
      onPointerLeave={() => setTilt({ x: 0, y: 0 })}
    >
      <canvas className="approach__rig" ref={rigRef} aria-hidden="true" />
      <div className="approach__nowline" aria-hidden="true" />
      {nowMinutes != null && (
        <span className="approach__now">
          {String(Math.floor(nowMinutes / 60)).padStart(2, '0')}:{String(nowMinutes % 60).padStart(2, '0')} · now
        </span>
      )}
      <div className="approach__track" style={{ perspectiveOrigin: `${cx * 100}% 44%` }}>
        <div
          className="approach__world"
          style={{ transform: `rotateY(${(tilt.x * -3.2).toFixed(2)}deg) rotateX(${(tilt.y * 2.2).toFixed(2)}deg)` }}
        >
          {placed.map((p) => (
            <button
              type="button"
              key={p.key}
              className={`approach__card${p.lead ? ' approach__card--lead' : ''}${p.tethered ? ' approach__card--pulled' : ''}`}
              style={{
                transform: `translate(-50%,-50%) translate3d(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px,${p.z.toFixed(1)}px)`,
                opacity: Math.max(0.14, 1 - p.depth * 1.05).toFixed(3),
                filter: `blur(${Math.min(3.2, p.depth * 3.6).toFixed(2)}px)`,
                zIndex: String(200 - Math.round(p.depth * 180)),
              }}
              onClick={() => onOpen && onOpen(p.card)}
              tabIndex={p.depth > 0.8 ? -1 : 0}
            >
              <span className="approach__lab">
                <span>{p.card.tag || ''}</span>
                {/* Only ever the hour the payload carried. */}
                {p.card.atLabel && <u>{p.card.atLabel}</u>}
              </span>
              <span className="approach__val">{p.card.title}</span>
              {p.card.say && <span className="approach__sub">{p.card.say}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
