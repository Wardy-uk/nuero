// Next steps (3 Nov 2026) — everything pending in one list, on the phone. The
// SAME server list (GET /api/next-steps) and, since 7 Nov 2026, the SAME row
// component as NEURO desktop's NextStepsPage (saim/shared-ui/NextStepRow.jsx):
// a task's Start starts a focus session, Done ticks it, Book sends a 1-2-1
// invite, the drafts row sends each draft, Done for now on a garden note. The
// server composes and orders the list; this screen ranks nothing — filters only cut.
//
// ⚠ Not on the kiosk: the kiosk is read-only and /api/next-steps is not a
// proxy door. The kiosk shell leaves the tab out of its menu, and if it is ever
// reached there it says where the list lives and makes no request.
import { useCallback, useEffect, useState } from 'react';
import { apiUrl, authHeaders } from '../api';
import { platformNow } from '../../../shared-ui/presentation/platform.mjs';
import { startPlan } from '../nextSteps.mjs';
import { makeCall } from '../preparedMove.mjs';
import NextStepRow from '../../../shared-ui/NextStepRow.jsx';
import './NextSteps.css';

const GROUPS = [
  { key: 'now', label: 'NEEDS YOU NOW' },
  { key: 'today', label: 'TODAY' },
  { key: 'week', label: 'THIS WEEK' },
];

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'work', label: 'Work' },
  { key: 'life', label: 'Life' },
  { key: 'quick', label: 'Under 15 min' },
  { key: 'snoozed', label: 'Snoozed' },
];

function post(path, body) {
  return fetch(apiUrl(path), { method: 'POST', headers: authHeaders(path), body: JSON.stringify(body) })
    .then((r) => r.json())
    .catch(() => ({ ok: false, error: 'No answer from NEURO.' }));
}

/** Add to calendar from an email — the behaviour of desktop EmailCard's CalendarBar. */
export function CalendarForm({ source, emailId, subject, onClose, onAdded }) {
  const [state, setState] = useState({ loading: true });
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let live = true;
    post('/api/email/calendar/draft', { source, emailId }).then((j) => {
      if (!live) return;
      setState({ loading: false, ...j });
      if (j.already) setDone(j.already);
      setD(j.draft || { title: subject || '', date: '', allDay: false, start: '', end: '', location: '', link: '' });
    });
    return () => { live = false; };
  }, [source, emailId, subject]);

  const add = () => {
    setBusy(true); setErr('');
    post('/api/email/calendar/add', { source, emailId, subject, draft: d }).then((j) => {
      setBusy(false);
      if (j.ok) { setDone(j.event); if (onAdded) onAdded(); }
      else setErr(j.error === 'No answer from NEURO.' ? 'No answer from NEURO — check the calendar before pressing again.' : (j.error || 'Not added.'));
    });
  };

  if (state.loading) return <div className="ns-cal">Reading the email for a date…</div>;
  if (state.ok === false) return <div className="ns-cal ns-cal--gap">{state.error}</div>;
  const where = state.targetLabel || (source === 'work' ? 'your Outlook work calendar' : 'the family calendar');
  if (done) {
    return (
      <div className="ns-cal ns-cal--done">
        Added to {where}: {done.title} — {done.date}{done.start ? ` ${done.start}–${done.end}` : ''}
        <button type="button" className="ns-chip" onClick={onClose}>Close</button>
      </div>
    );
  }
  const set = (k) => (e) => setD({ ...d, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <div className="ns-cal">
      {state.say && <div className="ns-err">{state.say}</div>}
      <input className="ns-cal__wide" value={d.title || ''} onChange={set('title')} placeholder="What it is" aria-label="What it is" />
      <div className="ns-cal__row">
        <input type="date" value={d.date || ''} onChange={set('date')} aria-label="Date" />
        <label className="ns-cal__allday"><input type="checkbox" checked={!!d.allDay} onChange={set('allDay')} /> All day</label>
        {!d.allDay && <input type="time" value={d.start || ''} onChange={set('start')} aria-label="Start" />}
        {!d.allDay && <input type="time" value={d.end || ''} onChange={set('end')} aria-label="End" />}
      </div>
      <input className="ns-cal__wide" value={d.location || ''} onChange={set('location')} placeholder="Where (optional)" aria-label="Where" />
      <input className="ns-cal__wide" value={d.link || ''} onChange={set('link')} placeholder="Joining link (optional)" aria-label="Joining link" />
      <div className="ns-cal__row">
        <span className="ns-why">Goes in {where}</span>
        <button type="button" className="ns-btn ns-btn-primary" disabled={busy} onClick={add}>{busy ? '…' : 'Add to calendar'}</button>
        <button type="button" className="ns-btn ns-btn-quiet" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
      {err && <div className="ns-err">{err}</div>}
    </div>
  );
}

const appCall = makeCall({ fetchImpl: (...a) => fetch(...a), apiUrl, authHeaders });

const renderCalendar = ({ item, onClose, onAdded }) => (item.calendar
  ? <CalendarForm source={item.calendar.source} emailId={item.calendar.emailId} subject={item.title} onClose={onClose} onAdded={onAdded} />
  : <div className="ns-err">This row carries no email to read a date from.</div>);

/** PURE render of the list. */
export function NextStepsView({ data, filter = 'all', setFilter = () => {}, highlight = null, onStart = () => {}, onChanged = () => {}, onOpenTask = null, call = appCall }) {
  // The phone is a web surface: its one-press sends mint `neuro-web` grants.
  const rowProps = { call, surface: 'neuro-web', onOpen: (it) => onStart(it, startPlan(it)), onOpenTask, onChanged, renderCalendar };
  const items = data.items || [];
  const snoozed = data.snoozed || [];
  const quick = (x) => x.minutes != null && x.minutes <= 15;
  const shown = filter === 'snoozed' ? snoozed
    : items.filter((x) => (filter === 'work' ? x.sphere === 'work'
      : filter === 'life' ? x.sphere === 'life'
        : filter === 'quick' ? quick(x) : true));
  const count = (key) => (key === 'snoozed' ? snoozed.length
    : key === 'all' ? items.length
      : key === 'quick' ? items.filter(quick).length
        : items.filter((x) => x.sphere === key).length);

  return (
    <div className="ns">
      <div className="ns-head">
        <span className="ns-eyebrow">EVERYTHING PENDING, MOST USEFUL FIRST</span>
        <h1 className="ns-h1">Next steps</h1>
      </div>
      <div className="ns-filters" role="group" aria-label="Filter">
        {FILTERS.map((f) => (
          <button type="button" key={f.key} className={`ns-filter${filter === f.key ? ' is-on' : ''}`} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label} {count(f.key)}
          </button>
        ))}
      </div>

      {(data.gaps || []).length > 0 && (
        <p className="ns-gap">Couldn’t read: {data.gaps.join(' · ')}. This list may be missing things — it isn’t an all-clear.</p>
      )}

      {filter === 'snoozed' ? (
        <ul className="ns-list">
          {shown.length === 0 && <li className="ns-empty">Nothing snoozed.</li>}
          {shown.map((it) => <NextStepRow key={it.id} item={it} snoozed {...rowProps} />)}
        </ul>
      ) : (
        <>
          {shown.length === 0 && (
            <p className="ns-empty">{data.complete ? 'Nothing pending here.' : 'Nothing found in what NEURO could read.'}</p>
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

export default function NextSteps({ context = null, onNavigate = null }) {
  const kiosk = platformNow() === 'kiosk';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const highlight = context && context.item ? String(context.item) : null;

  const load = useCallback(() => {
    fetch(apiUrl('/api/next-steps'), { headers: authHeaders('/api/next-steps') })
      .then((r) => r.json())
      .then((d) => { if (d && d.ok) { setData(d); setError(''); } else setError((d && d.error) || 'Could not read the list.'); })
      .catch(() => setError('No answer from NEURO.'));
  }, []);

  useEffect(() => {
    const onOpenTask = onNavigate ? (taskId) => onNavigate('task', { context: { taskId } }) : null;

  if (kiosk) return undefined;
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load, kiosk]);

  // A push or link named a row: show it, scrolled into view and highlighted.
  useEffect(() => {
    if (!highlight || !data) return;
    if (filter === 'snoozed') return;
    const el = typeof document !== 'undefined' && document.getElementById(`ns-${highlight}`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
  }, [highlight, data, filter]);

  const onStart = (item, plan) => {
    if (plan.kind === 'tab' && onNavigate) { onNavigate(plan.tab, { context: plan.context }); return; }
    const url = plan.kind === 'url' ? plan.url : null;
    if (url && typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
  };

  const onOpenTask = onNavigate ? (taskId) => onNavigate('task', { context: { taskId } }) : null;

  if (kiosk) return <div className="ns"><p className="ns-empty">Next steps lives on your phone and on NEURO desktop — not on this screen.</p></div>;
  if (error && !data) return <div className="ns"><p className="ns-gap">{error}</p></div>;
  if (!data) return <div className="ns"><p className="ns-empty">Reading what’s pending…</p></div>;
  return <NextStepsView data={data} filter={filter} setFilter={setFilter} highlight={highlight} onStart={onStart} onOpenTask={onOpenTask} onChanged={load} />;
}
