import React from 'react';
import { useCanonical } from './canonicalUi';

/**
 * Personal dates with lead time (Build 17L–Q), on Life.
 *
 * Every line is the server's — what is coming, when, and what is already
 * planned. Only dates a calendar or Nick's notes EXPLICITLY call a birthday or
 * anniversary; importance and relationships are never guessed. Nothing here
 * creates a task or nags: a date outside its lead window is listed under
 * "Later" and nowhere else.
 */
export default function PersonalDatesCard() {
  const { data, error } = useCanonical('/api/loops/personal-dates');
  if (error && !data) return <div className="cn-error">Couldn’t read personal dates — {error}.</div>;
  if (!data) return null;
  const { active = [], later = [], passed = [], gaps = [] } = data;
  if (!active.length && !later.length && !passed.length && !gaps.length) return null;
  return (
    <div className="cn-hike" aria-label="Personal dates">
      <div className="cn-k">Dates coming up</div>
      {active.length === 0 && <div className="cn-muted">Nothing inside its lead time.</div>}
      {active.map((d) => (
        <div key={d.id} className="cn-hike-line">
          {d.line}
          {d.prep && d.prep.length > 0 && <span className="cn-muted"> (linked by name)</span>}
          {d.sources && d.sources.length > 1 && <span className="cn-muted"> · seen in {d.sources.length} calendars</span>}
        </div>
      ))}
      {passed.map((d) => <div key={d.id} className="cn-muted">{d.line}</div>)}
      {later.length > 0 && (
        <div className="cn-muted">Later: {later.map((d) => `${d.person || d.title} (${d.date.slice(5)})`).join(' · ')}</div>
      )}
      {gaps.map((g) => <div key={g.input} className="cn-muted">Couldn’t read {g.input}: {g.why}.</div>)}
      <div className="cn-muted">{data.rule}</div>
    </div>
  );
}
