import React, { useState } from 'react';
import { useCanonical, postCanonical, DOMAIN_LABELS } from './canonicalUi';

/**
 * Build 19 — personal operations on the Life page.
 *
 *  • FutureRadarCard: what is coming up over 7 / 14 / 30 days, needs-you
 *    first, each item with "why is this here?". Goals are linked here
 *    EXPLICITLY (a link gives context, never urgency), and a task can be marked
 *    as PREPARATION for a date or calendar entry. Nothing is created or sent.
 *  • PersonalAdminCard: obligations whose explicit domain is admin, finance or
 *    transport, plus which sources hold any at all.
 *  • ReminderListsCard: every Apple Reminders list by stable id — name, app,
 *    what it is for, whether it is read and why, counts from the last push.
 *
 * Every word is the server's; this renders and never ranks.
 */

const ACTION_WORDS = {
  needs_you: 'Needs you', preparation_open: 'Preparation open', planned: 'Planned', none: 'Nothing needed', unknown: 'Can’t tell',
};
const KIND_WORDS = {
  birthday: 'Birthday', anniversary: 'Anniversary', 'personal-date': 'Date', event: 'Calendar', hike: 'Hike',
  obligation: 'To do', admin: 'Admin', 'goal-review': 'Goal review',
};

export function FutureRadarCard() {
  const [days, setDays] = useState(14);
  const { data, error, loading, reload } = useCanonical(`/api/canonical/radar?days=${days}`);
  const goals = useCanonical('/api/canonical/goals');
  const tasks = useCanonical('/api/canonical/tasks?status=open');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const act = async (fn) => {
    setBusy(true); setNote(null);
    try { await fn(); await reload(); } catch (e) { setNote(`Not saved — ${e.message}`); }
    setBusy(false);
  };
  const active = goals.data ? (goals.data.goals || []).filter((g) => g.status === 'active') : [];
  const openTasks = tasks.data ? tasks.data.items || [] : [];

  return (
    <section className="cn-section">
      <div className="cn-head">
        <h3 className="cn-h3">{data ? data.heading : 'Future Radar'}</h3>
        <span className="cn-tabs" role="tablist" aria-label="How far ahead">
          {[7, 14, 30].map((d) => (
            <button key={d} type="button" role="tab" aria-selected={days === d} className={`cn-tab${days === d ? ' cn-tab--on' : ''}`} onClick={() => setDays(d)}>{d} days</button>
          ))}
        </span>
      </div>
      {loading && !data && <div className="cn-muted">Reading…</div>}
      {error && <div className="cn-error">Couldn’t read the Radar — {error}</div>}
      {note && <div className="cn-error">{note}</div>}
      {data && (
        <>
          <div className="cn-radar-summary">
            <strong>{data.summary.title}:</strong>
            <ul>{data.summary.lines.map((l) => <li key={l}>{l}</li>)}</ul>
            {data.coverage && !data.coverage.complete && (
              <div className="cn-muted">Not the whole picture: {data.coverage.reasons.join('; ')}.</div>
            )}
          </div>
          {!data.items.length && <div className="cn-empty">Nothing known coming up in the next {days} days. That is what NEURO has been told — not a promise that nothing is happening.</div>}
          <ul className="cn-list">
            {data.items.map((i) => <RadarItem key={i.id} item={i} goals={active} tasks={openTasks} busy={busy} act={act} />)}
          </ul>
          {data.goals && data.goals.length > 0 && (
            <div className="cn-radar-goals">
              {data.goals.map((g) => (
                <div key={g.goalId} className="cn-muted"><strong>{g.title}</strong> — {g.progress.why}{g.progress.period ? ` (${g.progress.period})` : ''}</div>
              ))}
            </div>
          )}
          <div className="cn-small cn-muted">{data.rule}</div>
        </>
      )}
    </section>
  );
}

function RadarItem({ item, goals, tasks, busy, act }) {
  const [open, setOpen] = useState(false);
  const [goalId, setGoalId] = useState('');
  const [prepId, setPrepId] = useState('');
  const linkable = /^(task:|commitment:|pd:|radar:event:|radar:hike:)/.test(item.id);
  const entityId = item.id.startsWith('radar:event:') ? `meeting:${item.id.slice('radar:event:'.length)}`
    : item.id.startsWith('radar:hike:') ? `meeting:${item.sourceRefs[0]}` : item.id;
  const prepSubject = item.id.startsWith('pd:') ? item.id : item.id.startsWith('radar:event:') ? entityId : null;
  const explicitGoals = (item.linkedGoals || []).filter((g) => g.basis === 'explicit');

  return (
    <li className={`cn-row cn-radar cn-radar--${item.actionState}`}>
      <button type="button" className="cn-rowbtn" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="cn-radar-when">{item.when}{item.time ? ` · ${item.time}` : ''}</span>
        <span className="cn-rowtitle">{item.title}</span>
        <span className="cn-chip cn-chip--soft">{KIND_WORDS[item.kind] || item.kind}</span>
        {item.actionState !== 'none' && <span className={`cn-chip ${item.actionState === 'needs_you' ? 'cn-chip--firm' : 'cn-chip--soft'}`}>{ACTION_WORDS[item.actionState]}</span>}
        {item.domains.length === 0 && item.kind === 'event' && <span className="cn-chip cn-chip--unknown">domain unknown</span>}
        {item.domains.map((d) => <span key={d} className="cn-chip">{DOMAIN_LABELS[d] || d}</span>)}
        {item.linkedGoals.map((g) => <span key={g.goalId} className="cn-chip cn-chip--soft" title={g.basis === 'explicit' ? 'You linked this' : 'The hiking loop counts it (its rule)'}>↳ {g.title}</span>)}
      </button>
      {open && (
        <div className="cn-detail">
          <div className="cn-k">Why is this here?</div>
          <ul className="cn-act-lines">{item.whyVisible.map((w) => <li key={w}>{w}</li>)}</ul>
          <div className="cn-muted">Confidence: {item.confidence}. {item.attention.eligible ? 'May be raised by the attention policy.' : 'Shown here only — it will not interrupt.'}</div>
          {linkable && goals.length > 0 && (
            <div className="cn-hike-form">
              <select value={goalId} onChange={(e) => setGoalId(e.target.value)} aria-label="Link to a goal" disabled={busy}>
                <option value="">link to a goal…</option>
                {goals.filter((g) => !explicitGoals.some((x) => x.goalId === g.id)).map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
              </select>
              <button type="button" className="cn-btn" disabled={busy || !goalId}
                onClick={() => act(async () => { await postCanonical(`/api/canonical/goals/${encodeURIComponent(goalId)}/links`, { entityId, label: item.title }); setGoalId(''); })}>Link</button>
              {explicitGoals.map((g) => (
                <button key={g.goalId} type="button" className="cn-btn cn-btn--tiny" disabled={busy}
                  onClick={() => act(() => postCanonical(`/api/canonical/goals/${encodeURIComponent(g.goalId)}/links/remove`, { entityId, label: item.title }))}>Unlink {g.title}</button>
              ))}
            </div>
          )}
          {prepSubject && (
            <div className="cn-hike-form">
              <select value={prepId} onChange={(e) => setPrepId(e.target.value)} aria-label="Mark a task as preparation" disabled={busy}>
                <option value="">mark a task as preparation…</option>
                {tasks.filter((t) => !item.linkedTaskRefs.includes(t.id)).map((t) => <option key={t.id} value={t.id}>{t.description}</option>)}
              </select>
              <button type="button" className="cn-btn" disabled={busy || !prepId}
                onClick={() => act(async () => { await postCanonical('/api/canonical/prep-links', { subjectId: prepSubject, entityId: prepId, label: (tasks.find((t) => t.id === prepId) || {}).description }); setPrepId(''); })}>Mark</button>
              {item.linkedTaskRefs.map((id) => (
                <button key={id} type="button" className="cn-btn cn-btn--tiny" disabled={busy}
                  onClick={() => act(() => postCanonical('/api/canonical/prep-links/remove', { subjectId: prepSubject, entityId: id }))}>Remove prep link</button>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function PersonalAdminCard() {
  const { data, error } = useCanonical('/api/canonical/personal-admin');
  if (error) return <section className="cn-section"><h3 className="cn-h3">Personal admin</h3><div className="cn-error">Couldn’t read it — {error}</div></section>;
  if (!data) return null;
  return (
    <section className="cn-section">
      <h3 className="cn-h3">Personal admin</h3>
      {!data.items.length && <div className="cn-empty">Nothing NEURO knows about. Admin appears here only from a reminder list or task you have classified as personal admin, finance or transport — nothing is guessed from wording.</div>}
      <ul className="cn-list">
        {data.items.map((o) => (
          <li key={o.id} className="cn-row">
            <span className="cn-rowtitle">{o.what}</span>
            <span className="cn-muted">{o.due ? o.due.label : 'no date'} · {o.source}</span>
            {o.needsNow && <span className="cn-chip cn-chip--firm">Needs you — {o.needsWhy}</span>}
          </li>
        ))}
      </ul>
      <details className="cn-details">
        <summary>Where admin could come from</summary>
        <ul className="cn-act-lines">
          {data.audit.sources.map((s) => (
            <li key={s.source}>{s.source}: {s.items === null ? s.why : `${s.items ?? s.upcomingEvents ?? 0}${s.containers && s.containers.length ? ` (${s.containers.join(', ')})` : ''}`}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

const TRACK_WORDS = { set: 'you set it', 'default-name': 'by the built-in-name rule', 'default-not-tracked': 'not set' };

export function ReminderListsCard() {
  const { data, error } = useCanonical('/api/canonical/reminder-lists');
  if (error) return <section className="cn-section"><h3 className="cn-h3">Reminder lists</h3><div className="cn-error">Couldn’t read them — {error}</div></section>;
  if (!data) return null;
  const s = data.summary;
  return (
    <section className="cn-section">
      <h3 className="cn-h3">Reminder lists</h3>
      <p className="cn-muted">{s.lists} lists · {s.classified} classified · {s.tracked} read by NEURO · {s.open === null ? 'counts not measured yet' : `${s.open} open, ${s.completed30d} done in 30 days`}{s.duplicateNames.length ? ` · names used twice: ${s.duplicateNames.join(', ')}` : ''}</p>
      <table className="cn-table">
        <thead><tr><th>List</th><th>For</th><th>Read?</th><th>Open</th><th>Done 30d</th><th>App</th></tr></thead>
        <tbody>
          {data.lists.map((l) => (
            <tr key={l.sourceKey} className={l.classification.state === 'unknown' ? 'cn-tr--unknown' : ''}>
              <td title={`id ${l.listId}`}>{l.name}{l.duplicateName ? <span className="cn-muted"> (…{String(l.listId).slice(-4)})</span> : null}</td>
              <td>{l.classification.state === 'unknown' ? 'unknown' : l.classification.domains.map((d) => d.label).join(', ')}</td>
              <td title={l.trackedWhy}>{l.tracked ? 'yes' : 'no'} <span className="cn-muted">({TRACK_WORDS[l.trackedBasis] || l.trackedBasis})</span></td>
              <td>{l.openCount === null ? '—' : l.openCount}</td>
              <td>{l.completedCount30d === null ? '—' : l.completedCount30d}</td>
              <td>{l.sourceApps.join(', ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.legacy.length > 0 && <div className="cn-small cn-muted">{data.legacy.length} older by-name record{data.legacy.length === 1 ? '' : 's'} from app builds before list ids — superseded, not separate lists.</div>}
      <div className="cn-small cn-muted">{data.rule} Classify a list in “What each calendar and list is for” below.</div>
    </section>
  );
}
