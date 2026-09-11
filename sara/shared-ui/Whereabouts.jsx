import { useEffect, useState } from 'react';

// Where Nick is, next to the SARA wordmark — one component for every web shell
// (phone PWA, Pi kiosk, laptop, study tablet), so the top bar cannot say it three ways.
//
// Nick, 11 Sep 2026: "if I'm in the house, which room — if I'm out, my location
// from the phone." The PHRASE is composed by NEURO (`GET /api/signals/room`,
// `services/whereabouts.js`): the room when the fingerprint is sure, else a named
// zone ("At Work"), else the phone's town while it is fresh. Nothing is rebuilt
// here — three surfaces inventing their own wording is how they drift.
//
// ⚠ SILENCE IS THE EMPTY STATE. Unknown, stale, unreachable or an error all render
// NOTHING rather than "unknown": a top bar that permanently says it does not know
// is one nobody reads by week two (the NEURO Topbar's rule).
//
// ⚠ `fetchJson` must be STABLE (module scope in the shell), or the effect re-arms
// its interval on every render. Each shell passes its own transport: the phone
// talks to NEURO with its PIN, the kiosk goes through sara/backend's door.

const POLL_MS = 30000;

const TITLES = {
  room: 'Where your watch was last picked up',
  zone: "From your phone's location",
  town: "From your phone's location",
};

export function useWhereabouts(fetchJson) {
  const [where, setWhere] = useState(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const d = await fetchJson();
        if (!alive) return;
        setWhere(d && d.known && d.label ? { label: d.label, kind: d.kind || null } : null);
      } catch {
        if (alive) setWhere(null);
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [fetchJson]);

  return where;
}

export default function Whereabouts({ fetchJson }) {
  const where = useWhereabouts(fetchJson);
  if (!where) return null;
  return (
    <span className="app__where" title={TITLES[where.kind] || undefined}>
      {where.label}
    </span>
  );
}
