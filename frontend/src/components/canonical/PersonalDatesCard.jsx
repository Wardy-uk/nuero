import React, { useState } from 'react';
import { useCanonical, postCanonical, Fold, HowItWorks, Headline, Stat, StatTiles, Tile, TileGrid, Group, dayLabel } from './canonicalUi';

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
 * 13 Oct 2026 (docs/design-rules.md): opens with a Headline, dates as tiles;
 * each date's full server line is on hover, its prep and any disagreement
 * between sources are chips.
 */
const KIND_WORD = { birthday: 'Birthday', anniversary: 'Anniversary' };
const kindWord = (k) => KIND_WORD[k] || 'Date';
// The server counts the days (`away`); this only words them.
const whenWord = (d) => (d.away === 0 ? 'today' : d.away === 1 ? 'tomorrow' : d.away === -1 ? 'yesterday' : dayLabel(d.date));

/** Chips under a date: the prep it is linked to, and any disagreement between sources. */
function DateFoot({ d }) {
  const open = (d.prep || []).find((p) => p.status === 'open');
  const prep = open || (d.prep || [])[0];
  const chips = [];
  if (prep) chips.push(<span key="prep" className="cn-chip" title={prep.link ? `Linked because it ${prep.link}` : undefined}>“{prep.title}” {open ? 'open' : 'done'}</span>);
  if (prep) chips.push(<span key="by" className="cn-chip">linked by name</span>);
  if (d.conflict) chips.push(<span key="cf" className="cn-chip" title={d.conflict.note}>sources disagree{(d.conflict.otherDates || []).length ? ` — also ${d.conflict.otherDates.map((o) => dayLabel(o.date)).join(', ')}` : ''}</span>);
  if (d.sources && d.sources.length > 1) chips.push(<span key="src" className="cn-chip">seen in {d.sources.length} places</span>);
  return chips.length ? <>{chips}</> : null;
}

function DateTile({ d, later = false }) {
  return (
    <Tile testid="personal-date" title={d.person || d.title} accent={d.state === 'action-may-be-needed'}
      sub={`${kindWord(d.kind)} · ${later ? dayLabel(d.date) : whenWord(d)}`}
      why={d.line || (d.conflict ? d.conflict.note : undefined)} foot={<DateFoot d={d} />} />
  );
}

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
  const needs = active.find((d) => d.state === 'action-may-be-needed');
  const partial = coverage && coverage.state !== 'complete' && (coverage.reasons || []).length ? coverage.reasons.join(' ') : null;

  const save = async (body) => {
    setMsg(null);
    try {
      const r = await postCanonical('/api/loops/personal-dates/declared', body);
      const conflict = r.conflicts && r.conflicts.length
        ? ` Your phone’s calendar says ${r.conflicts.map((c) => dayLabel(c.date)).join(', ')} — both are shown; NEURO has not picked one.` : '';
      setMsg(r.changed ? `Saved.${conflict}` : 'Already says that — nothing changed.');
      setDate('');
      reload(); ents.reload();
    } catch (e) { setMsg(e.message); }
  };

  return (
    <div aria-label="Personal dates" data-testid="personal-dates">
      <h3 className="cn-h3">{data.heading || 'Dates coming up'}</h3>
      {needs ? (
        <Headline tone="warn" pill="needs a look" detail={partial}>{needs.line}</Headline>
      ) : active.length ? (
        <Headline tone="plan" pill="coming up" detail={partial}>{active[0].line}</Headline>
      ) : (
        <Headline pill="all quiet" detail={partial}>Nothing inside its lead time.</Headline>
      )}
      <StatTiles>
        <Stat v={active.length} l="Inside lead time" />
        <Stat v={later.length} l="Later" />
        <Stat v={ents.data ? declared.length : null} l="Written in your notes" title={ents.data ? undefined : 'Not read yet'} />
      </StatTiles>

      {active.length > 0 && (
        <Group label="Coming up">
          <TileGrid testid="personal-dates-active">{active.map((d) => <DateTile key={d.id} d={d} />)}</TileGrid>
        </Group>
      )}
      {passed.length > 0 && (
        <Group label="Just passed">
          <TileGrid>{passed.map((d) => <DateTile key={d.id} d={d} />)}</TileGrid>
        </Group>
      )}
      {later.length > 0 && (
        <Group label="Later" meta="outside their lead time">
          <TileGrid testid="personal-dates-later">{later.map((d) => <DateTile key={d.id} d={d} later />)}</TileGrid>
        </Group>
      )}
      {gaps.map((g) => <div key={g.input} className="cn-error cn-small">Couldn’t read {g.input}: {g.why}.</div>)}

      <Fold title="Your dates and reminders" meta={`${declared.length ? `${declared.length} written down` : 'none written down'}`}>
        {declared.length > 0 && (
          <ul className="cn-list">
            {declared.map((e) => ['birthday', 'anniversary'].filter((k) => e[k]).map((k) => (
              <li key={`${e.entity}:${k}`}>
                <strong>{e.entity.split('/')[1]}</strong> <span className="cn-muted">{k} {e[k]}</span>{' '}
                <button type="button" className="cn-btn cn-btn--tiny" onClick={() => save({ entity: e.entity, kind: k, date: null })}>Remove</button>
              </li>
            )))}
          </ul>
        )}
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
      </Fold>
      <HowItWorks>{data.rule} A date outside its lead time is listed under Later and nowhere else; nothing here creates a task. Lead reminders: the first shows on the Radar only, the middle ones prompt harder, the last is Needs You and one notification — skipped if the prep you linked is done. A date you remove is gone — NEURO never restores it.</HowItWorks>
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
      <div className="cn-k">Lead reminders (days before)</div>
      {['anniversary', 'birthday'].map((k) => {
        const held = data.cadences[k];
        const val = draft[k] !== undefined ? draft[k] : held ? held.join(', ') : '';
        return (
          <div key={k} className="cn-hike-form">
            <span style={{ display: 'inline-block', minWidth: 100 }}>{k === 'anniversary' ? 'Anniversaries' : 'Birthdays'}</span>{' '}
            <input className="cn-input--short" value={val} placeholder="e.g. 10, 5, 1" aria-label={`${k} lead reminders, days before`}
              onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
            <button type="button" className="cn-btn cn-btn--tiny" disabled={!val.trim()} onClick={() => save(k, parse(val))}>Set</button>
            {held && <button type="button" className="cn-btn cn-btn--tiny" onClick={() => save(k, null)}>Clear</button>}
          </div>
        );
      })}
      {note && <div className="cn-error">{note}</div>}
    </>
  );
}
