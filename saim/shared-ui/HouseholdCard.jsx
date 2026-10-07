import { useEffect, useState } from 'react';
import './HouseholdCard.css';

/**
 * Who's in the house — faces, one component for every shell (7 Oct 2026).
 *
 * The phone PWA, the Pi kiosk's home board, the laptop window and NEURO's Life
 * page all render THIS, from `GET /api/household`. Each shell passes its own
 * transport (`fetchJson`, `fetchPhoto`), the Whereabouts rule: the phone talks
 * to NEURO with its PIN, the kiosk goes through saim/backend's door.
 *
 * ⚠ FOUR STATES, AND THEY READ WITHOUT COLOUR.
 *   home      — full photo, solid ring, "Home"
 *   away      — faded and greyed, "Out" (or "At work" for Nick)
 *   unknown   — dashed ring, "Can't tell" — the house could not be read, which
 *               is NOT "out"
 *   untracked — Ember: no ring and no claim; nothing tracks her
 * A presence source that is down makes every person `unknown` server-side, and
 * the card says so in words — it never renders a confident empty house.
 *
 * ⚠ A missing photo is an initial, not a broken image.
 */

const POLL_MS = 60000;

const LABEL = { home: 'Home', away: 'Out', unknown: "Can't tell", untracked: 'Not tracked' };

export function useHousehold(fetchJson) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const d = await fetchJson();
        if (!alive) return;
        if (d && Array.isArray(d.members)) { setData(d); setError(false); } else setError(true);
      } catch {
        if (alive) setError(true);
      }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [fetchJson]);
  return { data, error };
}

function Face({ member, fetchPhoto, size }) {
  const [src, setSrc] = useState(null);
  const version = member.photo ? member.photo.version : null;
  useEffect(() => {
    let alive = true;
    let url = null;
    setSrc(null);
    if (version != null && fetchPhoto) {
      fetchPhoto(member.id, version).then((u) => {
        if (alive) { url = u; setSrc(u || null); } else if (u && u.startsWith('blob:')) URL.revokeObjectURL(u);
      }).catch(() => {});
    }
    return () => { alive = false; if (url && url.startsWith('blob:')) URL.revokeObjectURL(url); };
  }, [member.id, version, fetchPhoto]);
  const initial = (member.name || '?').trim().charAt(0).toUpperCase();
  return (
    <div className={`hh-face hh-face--${member.state}`} style={{ width: size, height: size }} aria-hidden="true">
      {src ? <img src={src} alt="" /> : <span className="hh-face__initial">{initial}</span>}
    </div>
  );
}

/** PURE-ish view: renders a household payload. Exported for tests. */
export function HouseholdView({ data, error = false, fetchPhoto = null, compact = false, title = "Who's in" }) {
  if (!data) {
    return (
      <section className="hh-card" aria-label="Who's in the house">
        <header className="hh-card__head"><h3>{title}</h3></header>
        <p className="hh-card__note">{error ? "Couldn't reach NEURO — this isn't “everyone's out”." : 'Looking…'}</p>
      </section>
    );
  }
  const members = data.members || [];
  const people = members.filter((m) => m.role !== 'companion');
  const homeCount = people.filter((m) => m.state === 'home').length;
  const size = compact ? 48 : 72;
  return (
    <section className={`hh-card${compact ? ' hh-card--compact' : ''}`} aria-label="Who's in the house">
      <header className="hh-card__head">
        <h3>{title}</h3>
        {data.known && <span className="hh-card__count">{homeCount === 0 ? 'Nobody home' : `${homeCount} home`}</span>}
      </header>
      {!data.known && (
        <p className="hh-card__note hh-card__note--gap">Can't see the house right now — this isn't “everyone's out”.</p>
      )}
      <ul className="hh-card__grid">
        {members.map((m) => (
          <li key={m.id} className={`hh-member hh-member--${m.state}`}>
            <Face member={m} fetchPhoto={fetchPhoto} size={size} />
            <span className="hh-member__name">{m.name}</span>
            <span className="hh-member__state">{m.detail && m.state !== 'untracked' ? m.detail : LABEL[m.state] || m.state}</span>
            {m.role === 'visitor' && !compact && <span className="hh-member__role">visiting</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function HouseholdCard({ fetchJson, fetchPhoto = null, compact = false, title }) {
  const { data, error } = useHousehold(fetchJson);
  return <HouseholdView data={data} error={error} fetchPhoto={fetchPhoto} compact={compact} title={title} />;
}
