import React, { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../api';
import { desktopCall } from '../desktopCall';
import { CalendarBar } from './EmailCard';
import { openInVault } from '../openVault';
import { useWorkOnly } from '../workOnly';
import NextStepRow from '../../../saim/shared-ui/NextStepRow.jsx';
import './NextStepsPage.css';

/**
 * Next steps (3 Nov 2026): everything pending in one list. The server composes
 * the list from the modules that own each thing (services/next-steps.js); this
 * page renders it and ranks nothing.
 *
 * The row is saim/shared-ui/NextStepRow.jsx (7 Nov 2026) — the SAME component
 * SAiM's Next steps tab renders, so the two cannot drift. Its buttons act in
 * place: a task's Start starts a focus session, Done ticks it, Book proposes and
 * sends a 1-2-1 invite, the drafts row sends each draft.
 */

const GROUPS = [
  { key: 'now', label: 'NEEDS YOU NOW' },
  { key: 'today', label: 'TODAY' },
  { key: 'week', label: 'THIS WEEK' },
];

// Work or Life (6 Nov 2026, Nick): the page opens on Work every time; Life is
// a toggle, never mixed in. The filters below cut WITHIN the side shown.
const SPHERES = [
  { key: 'work', label: 'Work' },
  { key: 'life', label: 'Life' },
];

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'quick', label: 'Under 15 min' },
  { key: 'snoozed', label: 'Snoozed' },
];

const sphereOf = (x) => (x.sphere === 'life' ? 'life' : 'work');

const renderCalendar = ({ item, onClose }) => (item.calendar
  ? <CalendarBar source={item.calendar.source} emailId={item.calendar.emailId} subject={item.title} onClose={onClose} />
  : <div className="ns-err">This row carries no email to read a date from.</div>);

export function NextStepsView({ data, sphere = 'work', setSphere = null, filter, setFilter, highlight, onStart, onChanged, onOpenTask = null, call = desktopCall }) {
  const rowProps = { call, surface: 'neuro-web', onOpen: onStart, onOpenTask, onChanged, renderCalendar };
  const allItems = data.items || [];
  const allSnoozed = data.snoozed || [];
  const items = allItems.filter((x) => sphereOf(x) === sphere);
  const snoozed = allSnoozed.filter((x) => sphereOf(x) === sphere);
  const shown = filter === 'snoozed' ? snoozed
    : items.filter((x) => (filter === 'quick' ? (x.minutes != null && x.minutes <= 15) : true));
  const count = (key) => (key === 'snoozed' ? snoozed.length
    : key === 'all' ? items.length
      : items.filter((x) => x.minutes != null && x.minutes <= 15).length);
  const sphereCount = (key) => allItems.filter((x) => sphereOf(x) === key).length;

  return (
    <div className="ns-page">
      <div className="ns-head">
        <div className="ns-head-text">
          <span className="ns-eyebrow">EVERYTHING PENDING, MOST USEFUL FIRST</span>
          <h1 className="ns-h1">Next steps</h1>
        </div>
        {setSphere && (
          <div className="ns-sphere" role="group" aria-label="Work or Life">
            {SPHERES.map((sp) => (
              <button key={sp.key} className={`ns-sphere-btn${sphere === sp.key ? ' is-on' : ''}`} aria-pressed={sphere === sp.key} onClick={() => setSphere(sp.key)}>
                {sp.label} {sphereCount(sp.key)}
              </button>
            ))}
          </div>
        )}
        <div className="ns-filters" role="group" aria-label="Filter">
          {FILTERS.map((f) => (
            <button key={f.key} className={`ns-filter${filter === f.key ? ' is-on' : ''}`} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label} {count(f.key)}
            </button>
          ))}
        </div>
      </div>

      {(data.gaps || []).length > 0 && (
        <div className="ns-gap">Couldn’t read: {data.gaps.join(' · ')}. This list may be missing things — it isn’t an all-clear.</div>
      )}

      {filter === 'snoozed' ? (
        <section className="ns-group">
          {shown.length === 0 && <p className="ns-empty">Nothing snoozed.</p>}
          <ul className="ns-list">
            {shown.map((it) => <NextStepRow key={it.id} item={it} snoozed {...rowProps} />)}
          </ul>
        </section>
      ) : (
        <>
          {shown.length === 0 && (
            <p className="ns-empty">{data.complete ? `Nothing ${sphere === 'life' ? 'in Life' : 'at work'} pending here.` : 'Nothing found in what NEURO could read.'}</p>
          )}
          {GROUPS.map((g) => {
            const rows = shown.filter((x) => x.group === g.key);
            if (!rows.length) return null;
            return (
              <section key={g.key} className="ns-group" aria-label={g.label}>
                <h2 className={`ns-h2${g.key === 'now' ? ' is-now' : ''}`}>{g.label} · {rows.length}</h2>
                <ul className="ns-list">
                  {rows.map((it) => (
                    <NextStepRow key={it.id} item={it} highlighted={highlight === it.id} {...rowProps} />
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

export default function NextStepsPage({ context, onNavigate }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [sphere, setSphere] = useState('work');
  const [workOnly] = useWorkOnly();
  const highlight = context && context.item ? String(context.item) : null;

  const load = useCallback(() => {
    fetch(apiUrl('/api/next-steps'))
      .then((r) => r.json())
      .then((d) => { if (d && d.ok) { setData(d); setError(''); } else setError((d && d.error) || 'Could not read the list.'); })
      .catch(() => setError('No answer from NEURO.'));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  // A link to one row (a push, ?step=) opens the side that row is on — a deep
  // link must never land on a hidden row.
  useEffect(() => {
    if (!highlight || !data) return;
    const hit = [...(data.items || []), ...(data.snoozed || [])].find((x) => x.id === highlight);
    if (hit && sphereOf(hit) !== sphere) setSphere(sphereOf(hit));
  }, [highlight, data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!highlight || !data) return;
    const el = document.getElementById(`ns-${highlight}`);
    if (el) el.scrollIntoView({ block: 'center' });
  }, [highlight, data, sphere]);

  const onStart = (item) => {
    if (item.start.view === 'vault' && item.start.context && item.start.context.path) { openInVault(item.start.context.path); return; }
    if (onNavigate) onNavigate(item.start.view, item.start.context || null);
  };

  const onOpenTask = onNavigate ? (taskId) => onNavigate('task', { taskId }) : null;

  if (error && !data) return <div className="ns-page"><div className="ns-gap">{error}</div></div>;
  if (!data) return <div className="ns-page"><p className="ns-empty">Reading what’s pending…</p></div>;
  // Work only on this device: Life is hidden, so is the toggle.
  const shownSphere = workOnly ? 'work' : sphere;
  return <NextStepsView data={data} sphere={shownSphere} setSphere={workOnly ? null : setSphere} filter={filter} setFilter={setFilter} highlight={highlight} onStart={onStart} onOpenTask={onOpenTask} onChanged={load} />;
}
