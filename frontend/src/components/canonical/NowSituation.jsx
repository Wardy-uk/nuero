import React from 'react';
import { DomainChips, when } from './canonicalUi';
import './Canonical.css';

/**
 * The world-model half of Now (Build 10E/10F) — rendered under the attention
 * decision, from `situation` on /api/canonical/now.
 *
 * Sparse by construction: a section exists in the payload only when there is
 * evidence for it, and this renders nothing for an absent one. When nothing is
 * meaningful it says so calmly — and, if something could not be read, says
 * that this is not an all-clear. It decides nothing: order, dedupe and what is
 * held off duty are all the server's.
 */
export default function NowSituation({ situation, onNavigate }) {
  if (!situation) return null;
  const s = situation.sections || {};
  const go = (view) => (onNavigate ? () => onNavigate(view) : undefined);
  return (
    <section className="cn-now" aria-label="What else matters now">
      {s.needsYou && (
        <div className="cn-now-card">
          <div className="cn-now-k">Needs you</div>
          <div className="cn-now-item">{s.needsYou.say}</div>
          {onNavigate && <button type="button" className="cn-link" onClick={go('actions')}>Open Actions</button>}
        </div>
      )}
      {s.nextEvent && (
        <div className="cn-now-card">
          <div className="cn-now-k">Next</div>
          <div className="cn-now-item">
            {when(s.nextEvent.start)} · {s.nextEvent.title}
            {s.nextEvent.withPeople && s.nextEvent.withPeople.length > 0 && <span className="cn-muted"> with {s.nextEvent.withPeople.join(', ')}</span>}
            {s.nextEvent.unresolvedPeople > 0 && <span className="cn-muted"> (+{s.nextEvent.unresolvedPeople} not matched to a person)</span>}
          </div>
          <DomainChips domains={s.nextEvent.domains} />
          {s.nextEvent.projectionCurrent === false && <div className="cn-muted">The diary in the world model is a little behind.</div>}
        </div>
      )}
      {s.commitments && (
        <div className="cn-now-card">
          <div className="cn-now-k">Commitments coming due</div>
          {s.commitments.map((c) => (
            <div key={c.id} className="cn-now-item">
              {c.direction === 'owed-to-me' ? `${c.counterpart.name || 'Someone'} owes you: ` : ''}{c.description}
              <span className="cn-muted"> — {c.due.label}</span> <DomainChips domains={c.domains} />
            </div>
          ))}
          {onNavigate && <button type="button" className="cn-link" onClick={go('commitments')}>All commitments</button>}
        </div>
      )}
      {s.crowdedOut && (
        <div className="cn-now-card">
          <div className="cn-now-k">Your own things</div>
          <div className="cn-now-item">{s.crowdedOut.say}</div>
          {s.crowdedOut.items.map((i) => <div key={i.id} className="cn-muted">{i.description} — {i.due}</div>)}
        </div>
      )}
      {s.blindness && (
        <div className="cn-now-card">
          <div className="cn-now-k">What NEURO can’t see</div>
          {s.blindness.map((b) => <div key={b.sourceId} className="cn-now-item">{b.label} — {b.verdictLabel.toLowerCase()}{b.what ? `, so it is missing ${b.what}` : ''}.</div>)}
          {onNavigate && <button type="button" className="cn-link" onClick={go('sources')}>Sources</button>}
        </div>
      )}
      {s.goals && (
        <div className="cn-now-card">
          <div className="cn-now-k">What you said you want</div>
          {s.goals.map((g) => <div key={g.id} className="cn-muted">{g.title}</div>)}
        </div>
      )}
      {situation.calm && <div className="cn-now-calm">{situation.calmSay}</div>}
      {!situation.calm && situation.calmSay && <div className="cn-muted">{situation.calmSay}</div>}
      {situation.workHeld && situation.workHeld.say && <div className="cn-muted">{situation.workHeld.say}</div>}
    </section>
  );
}
