import React, { useState } from 'react';
import { useCanonical, postCanonical } from './canonicalUi';

/**
 * Personal dates with lead time (Build 17L–Q), on Life.
 *
 * Every line is the server's — what is coming, when, and what is already
 * planned. Only dates a calendar or Nick's notes EXPLICITLY call a birthday or
 * anniversary; importance and relationships are never guessed. Nothing here
 * creates a task or nags: a date outside its lead window is listed under
 * "Later" and nowhere else.
 *
 * Build 18P: the HEADING is the server's verdict on coverage — "Upcoming
 * birthdays and anniversaries" only when every source was seen in full,
 * otherwise "Known dates from currently available sources" with the reasons.
 * Build 18Q: Nick can add, change or remove a birthday/anniversary on a People
 * or Companions note here. Explicit only; nothing creates a calendar event.
 */
export default function PersonalDatesCard() {
  const { data, error, reload } = useCanonical('/api/loops/personal-dates');
  const ents = useCanonical('/api/loops/personal-dates/entities');
  const [entity, setEntity] = useState('');
  const [kind, setKind] = useState('birthday');
  const [date, setDate] = useState('');
  const [msg, setMsg] = useState(null);
  if (error && !data) return <div className="cn-error">Couldn’t read personal dates — {error}.</div>;
  if (!data) return null;
  const { active = [], later = [], passed = [], gaps = [], coverage = null } = data;
  const entities = (ents.data && ents.data.entities) || [];
  const declared = entities.filter((e) => e.birthday || e.anniversary);

  const save = async (body) => {
    setMsg(null);
    try {
      const r = await postCanonical('/api/loops/personal-dates/declared', body);
      const conflict = r.conflicts && r.conflicts.length
        ? ` Your phone’s calendar says ${r.conflicts.map((c) => c.date.slice(5)).join(', ')} — both are shown; NEURO has not picked one.` : '';
      setMsg(r.changed ? `Saved.${conflict}` : 'Already says that — nothing changed.');
      setDate('');
      reload(); ents.reload();
    } catch (e) { setMsg(e.message); }
  };

  return (
    <div className="cn-hike" aria-label="Personal dates">
      <div className="cn-k">{data.heading || 'Dates coming up'}</div>
      {coverage && coverage.state !== 'complete' && coverage.reasons.map((r) => <div key={r} className="cn-muted">{r}</div>)}
      {active.length === 0 && <div className="cn-muted">Nothing inside its lead time.</div>}
      {active.map((d) => (
        <div key={d.id} className="cn-hike-line">
          {d.line}
          {d.prep && d.prep.length > 0 && <span className="cn-muted"> (linked by name)</span>}
          {d.sources && d.sources.length > 1 && <span className="cn-muted"> · seen in {d.sources.length} places</span>}
        </div>
      ))}
      {passed.map((d) => <div key={d.id} className="cn-muted">{d.line}</div>)}
      {later.length > 0 && (
        <div className="cn-muted">Later: {later.map((d) => `${d.person || d.title} (${d.date.slice(5)})${d.conflict ? ' — sources disagree' : ''}`).join(' · ')}</div>
      )}
      {gaps.map((g) => <div key={g.input} className="cn-muted">Couldn’t read {g.input}: {g.why}.</div>)}

      <div className="cn-k">Dates you have written down</div>
      {declared.length === 0 && <div className="cn-muted">None yet.</div>}
      {declared.map((e) => ['birthday', 'anniversary'].filter((k) => e[k]).map((k) => (
        <div key={`${e.entity}:${k}`} className="cn-hike-line">
          {e.entity.split('/')[1]} — {k} {e[k]}{' '}
          <button type="button" className="cn-btn cn-btn--tiny" onClick={() => save({ entity: e.entity, kind: k, date: null })}>Remove</button>
        </div>
      )))}
      <div className="cn-goalform">
        <select value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="Person or companion">
          <option value="">Person or companion…</option>
          {entities.map((e) => <option key={e.entity} value={e.entity}>{e.entity.split('/')[1]}{e.kind === 'companion' ? ' (companion)' : ''}</option>)}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
          <option value="birthday">Birthday</option>
          <option value="anniversary">Anniversary</option>
        </select>
        <input className="cn-input--short" value={date} onChange={(e) => setDate(e.target.value)} placeholder="YYYY-MM-DD or MM-DD" aria-label="Date" />
        <button type="button" className="cn-btn" disabled={!entity || !date} onClick={() => save({ entity, kind, date })}>Save date</button>
      </div>
      {msg && <div className="cn-muted">{msg}</div>}
      <LeadReminders />
      <div className="cn-muted">{data.rule} A date you remove is gone — NEURO never restores it.</div>
    </div>
  );
}

/**
 * Lead reminders, per kind of date — Nick's cadence, e.g. anniversary 10, 5, 1.
 * The first step shows on the Radar, middle steps prompt harder, the last is
 * Needs You and the ONLY push — and it stays quiet when the prep is done.
 */
function LeadReminders() {
  const { data, reload } = useCanonical('/api/canonical/lead-reminders');
  const [draft, setDraft] = useState({});
  const [note, setNote] = useState(null);
  if (!data) return null;
  const save = async (kind, offsets) => {
    setNote(null);
    try { await postCanonical('/api/canonical/lead-reminders', { kind, offsets }); setDraft({ ...draft, [kind]: undefined }); reload(); } catch (e) { setNote(e.message); }
  };
  const parse = (s) => String(s || '').split(/[ ,]+/).filter(Boolean).map(Number);
  return (
    <>
      <div className="cn-k">Lead reminders</div>
      {['anniversary', 'birthday'].map((k) => {
        const held = data.cadences[k];
        const val = draft[k] !== undefined ? draft[k] : held ? held.join(', ') : '';
        return (
          <div key={k} className="cn-hike-line">
            {k === 'anniversary' ? 'Anniversaries' : 'Birthdays'}: {held ? `${held.join(', ')} days before` : 'none'}{' '}
            <input className="cn-input--short" value={val} placeholder="e.g. 10, 5, 1" aria-label={`${k} lead reminders, days before`}
              onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
            <button type="button" className="cn-btn cn-btn--tiny" disabled={!val.trim()} onClick={() => save(k, parse(val))}>Set</button>
            {held && <button type="button" className="cn-btn cn-btn--tiny" onClick={() => save(k, null)}>Clear</button>}
          </div>
        );
      })}
      {note && <div className="cn-error">{note}</div>}
      <div className="cn-muted">First step: on the Radar only. Middle: a stronger prompt. Last: Needs You and one notification — skipped if the prep you linked is done.</div>
    </>
  );
}
