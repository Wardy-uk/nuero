import { useEffect, useState } from 'react';
import './RoomReading.css';

// The room this screen is in: its temperature and its lights.
//
// Nick, 2 Oct 2026: "the @home screens should display room info as well — so
// never nothing." The clock and lock states showed only the time, which every
// microwave in the house already does.
//
// ⚠ HOME SCREENS ONLY, and the caller decides that from the verdict's `place`.
// The work Fire is in a building that is not this house, so it has no area.
//
// ⚠ "COULD NOT READ" IS SAID, NOT LEFT BLANK. A gap here is the one thing that
// would put "nothing" back on the screen this exists to fill — and it must not
// look like a room with the lights off.
//
// ⚠ THREE LIGHT STATES: off at the wall is counted apart, because she cannot
// reach those and an "all off" that includes them is a claim about bulbs she
// cannot see.

const POLL_MS = 60_000;

function lightsLine(l) {
  if (!l || !Number.isFinite(l.total) || l.total === 0) return null;
  const parts = [];
  if (l.on > 0) parts.push(`${l.on} light${l.on === 1 ? '' : 's'} on`);
  else if (l.off > 0) parts.push('lights off');
  if (l.unreachable > 0) parts.push(`${l.unreachable} off at the wall`);
  return parts.join(' · ') || null;
}

export default function RoomReading({ area }) {
  const [reading, setReading] = useState(null);

  useEffect(() => {
    if (!area) return undefined;
    let alive = true;
    const tick = () =>
      fetch(`/api/rooms/area?name=${encodeURIComponent(area)}`)
        .then((r) => (r.ok ? r.json() : { known: false }))
        .then((d) => { if (alive) setReading(d || { known: false }); })
        .catch(() => { if (alive) setReading({ known: false }); });
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [area]);

  if (!area) return null;
  if (!reading) return <div className="roomreading roomreading--wait">{area}</div>;
  if (!reading.known) {
    return <div className="roomreading roomreading--gap">{area} · can't read the room right now</div>;
  }
  const temp = typeof reading.tempC === 'number' ? `${reading.tempC.toFixed(1)}°` : null;
  const facts = [temp, lightsLine(reading.lights)].filter(Boolean);
  return (
    <div className="roomreading">
      <span className="roomreading__area">{reading.area || area}</span>
      {facts.length > 0 && <span className="roomreading__facts"> · {facts.join(' · ')}</span>}
    </div>
  );
}
