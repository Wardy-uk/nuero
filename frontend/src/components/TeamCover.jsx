import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './TeamCover.css';

/**
 * Team cover (1 Nov 2026) — queues where two or more people (or 40%+ of the
 * team) are off on the same days, from NOVA's People HR sync. Built in NEURO,
 * not VANTAGE (Nick, 1 Nov 2026 — see services/team-cover.js).
 *
 * Rendered twice:
 *   - Now (`mode="now"`): only when there is a clash. A permanent "cannot see
 *     Adele" line on Now is the always-on warning nobody reads.
 *   - People board (`mode="people"`): always, with the gaps — that is where he
 *     goes looking, and "no clashes among the people NEURO can see" is a
 *     different claim from "no clashes".
 *
 * Names are links: on the board they open the person; on Now they go to People.
 * Approved leave only — NOVA exposes no pending leave — and the card says so.
 */

export function TeamCoverView({ data, mode = 'now', onPerson }) {
  if (!data) return null;
  const clashes = data.clashes || [];
  const gaps = data.gaps || [];
  if (mode === 'now' && !clashes.length) return null;

  return (
    <section className="team-cover" aria-label="Team cover">
      <div className="team-cover__head">
        <h3>{clashes.length ? 'Cover is thin' : 'Team cover'}</h3>
        <p>
          {data.known === false
            ? 'Leave could not be read — this is not an all-clear.'
            : `Next 8 weeks, approved leave only (People HR via NOVA). Flagged at ${data.rule?.minOff ?? 2}+ off or ${Math.round((data.rule?.minShare ?? 0.4) * 100)}%+ of a team.`}
        </p>
      </div>

      {clashes.length > 0 && (
        <ul className="team-cover__list">
          {clashes.map(c => (
            <li key={c.key} className={`team-cover__item team-cover__item--${c.severity}`}>
              <div className="team-cover__title">
                <strong>{c.team}</strong> — {c.range}
                {c.startsInDays <= 0 ? ' · today' : c.startsInDays === 1 ? ' · tomorrow' : ` · in ${c.startsInDays} days`}
              </div>
              <div className="team-cover__people">
                {c.people.map((n, i) => (
                  <span key={n}>
                    {i > 0 && (i === c.people.length - 1 ? ' and ' : ', ')}
                    <button type="button" className="team-cover__person" onClick={() => onPerson && onPerson(n)}>{n}</button>
                  </span>
                ))}
                {' off'}{c.includesYou ? ' (including you)' : ''}
              </div>
              <div className="team-cover__say">{c.say}</div>
              <div className="team-cover__action">{c.action}.</div>
            </li>
          ))}
        </ul>
      )}

      {mode === 'people' && !clashes.length && data.known !== false && (
        <p className="team-cover__none">
          {gaps.length ? 'No clashes among the people NEURO can see.' : 'No clashes in the next 8 weeks.'}
        </p>
      )}

      {gaps.length > 0 && (mode === 'people' || clashes.length > 0) && (
        <ul className="team-cover__gaps">
          {gaps.map(g => <li key={g}>{g}</li>)}
        </ul>
      )}
    </section>
  );
}

export default function TeamCover({ mode = 'now', onPerson, onNavigate }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    apiFetch('/api/nudges/availability')
      .then(r => r.json())
      .then(d => setData(d.ok ? d.teamCover || null : null))
      .catch(() => setData(null));
  }, []);
  const open = onPerson || (onNavigate ? () => onNavigate('people') : null);
  return <TeamCoverView data={data} mode={mode} onPerson={open} />;
}
