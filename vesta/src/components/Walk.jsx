import { useEffect, useState } from 'react';
import * as api from '../api';
import Section from './Section.jsx';
import WalkMap from './WalkMap.jsx';

/**
 * Nick's walk — the household half of hike safety (the `hike` scope).
 *
 * While he has a walk armed: the planned route, the trail NEURO has from his
 * trackers, and each tracker's last position with how old it is — every one its
 * own row, never merged into one confident dot. When he checks in it drops to
 * "back at HH:MM" with no positions at all; with no walk on, it says so.
 *
 * The map is OpenTopoMap (contours and footpaths). Without signal for tiles the
 * lines still draw; "Open in Maps" is there for directions.
 *
 * ⚠ AN OLD POSITION IS SAID TO BE OLD. Out of signal the trackers just stop, so
 * "last seen 2 h ago" is the fact, and it is the most important one on the card.
 *
 * Every rule is the server's (services/hike-safety.householdView); this renders.
 */

const POLL_MS = 60 * 1000;
const time = (local) => (local ? local.slice(11, 16) : '?');

export default function Walk({ hike: initial, gap, token }) {
  const [hike, setHike] = useState(initial);
  const [stale, setStale] = useState(null);
  useEffect(() => { setHike(initial); }, [initial]);
  useEffect(() => {
    if (!hike || !hike.active) return undefined;
    const id = setInterval(async () => {
      try { const r = await api.hike(token); setHike(r.hike); setStale(null); } catch (e) { setStale(e.message); }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [hike && hike.active, token]);

  if (gap || hike === null) return <Section title="Nick’s walk" gap={gap || 'No answer about Nick’s walk.'}>{null}</Section>;
  if (!hike) return <Section title="Nick’s walk" gap="I asked about Nick’s walk and got no answer. Try reloading.">{null}</Section>;

  if (!hike.active) {
    return (
      <Section title="Nick’s walk" empty={hike.back ? null : 'Nick isn’t out on a walk he’s told NEURO about.'}>
        {hike.back && <p className="walk__back">Back from <strong>{hike.back.name}</strong> — checked in at {time(hike.back.checkedInAt)}.</p>}
      </Section>
    );
  }

  const overdue = hike.state === 'overdue';
  return (
    <Section title="Nick’s walk">
      <div className={`walk${overdue ? ' walk--overdue' : ''}`}>
        <p className="walk__head">
          <strong>{hike.name}</strong>{hike.ember ? ` with ${hike.companion || 'Ember'}` : ''}
          <span className={`walk__chip${overdue ? ' walk__chip--overdue' : ''}`}>{overdue ? 'overdue' : hike.state === 'out' ? 'out walking' : 'not started yet'}</span>
        </p>
        {overdue ? (
          <p className="walk__alert" role="alert">
            Nick planned to be back by {time(hike.due)} and hasn’t checked in — {hike.minutesLate} min late.
            {hike.alerted && hike.alerted.sent ? ' NEURO has emailed you the route card.' : ''} Try calling Nick. If you can’t reach Nick and you’re worried, call 999 and ask for the Police.
          </p>
        ) : (
          <p className="walk__times">Started {time(hike.start)} · back by {time(hike.due)}{hike.extended ? ' (extended)' : ''} · you’re emailed at {time(hike.alertAt)} if Nick hasn’t checked in.</p>
        )}

        <WalkMap route={hike.route || []} trail={hike.trail || []} emberTrail={hike.emberTrail || []} positions={hike.positions || []} height={300} />
        {(hike.route || []).length > 0 && <p className="walk__legend">Dashed: the planned route · blue: where Nick’s phone has been{(hike.emberTrail || []).length ? ' · orange: Ember' : ''} · red dot: last seen (the circle is how accurate it is)</p>}

        {(hike.positions || []).length ? (
          <ul className="walk__positions">
            {hike.positions.map((p, i) => (
              <li key={i}>
                <strong>{p.label}</strong> — {time(p.at)} <span className={p.minutesAgo > 30 ? 'walk__old' : ''}>({p.ago})</span>
                <div className="walk__fine">
                  {p.gridRef ? `${p.gridRef} · ` : ''}{p.modeWords}{p.battery != null ? ` · battery ${p.battery}%` : ''}{p.accuracyM != null ? ` · ±${p.accuracyM} m` : ''}
                </div>
                <a className="walk__maps" href={p.maps} target="_blank" rel="noreferrer">Open in Maps</a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="section__empty">No position has reached NEURO yet — out of signal, the trackers just stop. That isn’t the same as something being wrong.</p>
        )}

        <details className="walk__card"><summary>Route card</summary><pre>{hike.card}</pre></details>
        {stale && <p className="home__stale" role="status">{stale} Showing what I last had.</p>}
      </div>
    </Section>
  );
}
