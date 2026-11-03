// Next steps (3 Nov 2026) — everything pending in one list, on the phone. The
// SAME server list (GET /api/next-steps) and the same three choices on every
// row as NEURO desktop's NextStepsPage: Start, Snooze, Not today. The server
// composes and orders it from the modules that own each thing; this screen
// renders it and ranks nothing — filters only cut.
//
// ⚠ Not on the kiosk: the kiosk is read-only and /api/next-steps is not a
// proxy door. The kiosk shell leaves the tab out of its menu, and if it is ever
// reached there it says where the list lives and makes no request.
import { useCallback, useEffect, useState } from 'react';
import { apiUrl, authHeaders } from '../api';
import { platformNow } from '../../../shared-ui/presentation/platform.mjs';
import { startPlan } from '../nextSteps.mjs';
import './NextSteps.css';

const GROUPS = [
  { key: 'now', label: 'NEEDS YOU NOW' },
  { key: 'today', label: 'TODAY' },
  { key: 'week', label: 'THIS WEEK' },
];

const KIND_LABEL = { email: 'EMAIL', report: 'REPORT', drafts: 'DRAFTS', task: 'TASK', people: 'PEOPLE' };

const SNOOZES = [
  { label: '1 hour', minutes: 60 },
  { label: '3 hours', minutes: 180 },
  { label: 'Tomorrow', notToday: true },
  { label: 'Next week', minutes: 7 * 24 * 60 },
];

const NOT_TODAY_REASONS = [
  { reason: 'not-now', label: 'Just not today' },
  { reason: 'too-big', label: 'Too big' },
  { reason: 'waiting-on-someone', label: 'Waiting on someone' },
  { reason: 'no-context', label: 'Missing something' },
];

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'work', label: 'Work' },
  { key: 'life', label: 'Life' },
  { key: 'quick', label: 'Under 15 min' },
  { key: 'snoozed', label: 'Snoozed' },
];

function untilLabel(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

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

export function NextStepRow({ item, highlighted = false, snoozed = false, onStart, onChanged }) {
  const [menu, setMenu] = useState(null); // null | 'snooze' | 'nottoday'
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [calOpen, setCalOpen] = useState(false);

  const call = async (path, body, fallback) => {
    setBusy(true); setErr('');
    const r = await post(path, { id: item.id, ...body });
    setBusy(false); setMenu(null);
    if (r.ok) onChanged(); else setErr(r.error || fallback);
  };

  const start = () => {
    const plan = startPlan(item);
    if (plan.kind === 'calendar') { setCalOpen((o) => !o); return; }
    if (plan.kind === 'act') { call('/api/next-steps/act', { action: plan.action }, 'NEURO did not take that.'); return; }
    onStart(item, plan);
  };

  const cal = item.calendar || null;
  return (
    <li className={`ns-row${highlighted ? ' is-highlighted' : ''}${item.group === 'now' && !snoozed ? ' is-now' : ''}`} id={`ns-${item.id}`} data-item-id={item.id}>
      <div className="ns-row-head">
        <span className={`ns-kind ns-kind-${item.kind}`}>{KIND_LABEL[item.kind] || String(item.kind || '').toUpperCase()}</span>
        {item.minutes != null && !snoozed && <span className="ns-mins">{item.minutes} min</span>}
      </div>
      <p className="ns-title">{item.title}</p>
      <p className="ns-why">
        {snoozed
          ? `Snoozed until ${untilLabel(item.snoozedUntil)}${item.snoozeReason && item.snoozeReason !== 'not-now' && item.snoozeReason !== 'unspecified' ? ` · ${item.snoozeReason.replace(/-/g, ' ')}` : ''}`
          : item.why}
      </p>
      <div className="ns-actions">
        {snoozed ? (
          <button type="button" className="ns-btn ns-btn-secondary" disabled={busy} onClick={() => call('/api/next-steps/undefer', {}, 'Could not bring it back.')}>{busy ? '…' : 'Bring it back'}</button>
        ) : (
          <>
            <button type="button" className="ns-btn ns-btn-primary" disabled={busy} onClick={start}>{(item.start && item.start.label) || 'Start'}</button>
            <button type="button" className="ns-btn ns-btn-secondary" aria-expanded={menu === 'snooze'} disabled={busy} onClick={() => setMenu(menu === 'snooze' ? null : 'snooze')}>Snooze ▾</button>
            <button type="button" className="ns-btn ns-btn-quiet" aria-expanded={menu === 'nottoday'} disabled={busy} onClick={() => setMenu(menu === 'nottoday' ? null : 'nottoday')}>Not today</button>
          </>
        )}
      </div>
      {menu === 'snooze' && (
        <div className="ns-menu" role="group" aria-label="Snooze for">
          {SNOOZES.map((s) => (
            <button type="button" key={s.label} className="ns-chip" disabled={busy}
              onClick={() => call('/api/next-steps/defer', s.notToday ? { notToday: true } : { minutes: s.minutes }, 'Not snoozed.')}>{s.label}</button>
          ))}
        </div>
      )}
      {menu === 'nottoday' && (
        <div className="ns-menu" role="group" aria-label="Why not today">
          <span className="ns-menu-label">Why? It comes back tomorrow morning.</span>
          {NOT_TODAY_REASONS.map((r) => (
            <button type="button" key={r.reason} className="ns-chip" disabled={busy}
              onClick={() => call('/api/next-steps/defer', { notToday: true, reason: r.reason }, 'Not snoozed.')}>{r.label}</button>
          ))}
        </div>
      )}
      {calOpen && cal && (
        <CalendarForm source={cal.source} emailId={cal.emailId} subject={item.title} onClose={() => setCalOpen(false)} onAdded={onChanged} />
      )}
      {calOpen && !cal && <div className="ns-err">This row carries no email to read a date from.</div>}
      {err && <div className="ns-err">{err}</div>}
    </li>
  );
}

/** PURE render of the list. */
export function NextStepsView({ data, filter = 'all', setFilter = () => {}, highlight = null, onStart = () => {}, onChanged = () => {} }) {
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
          {shown.map((it) => <NextStepRow key={it.id} item={it} snoozed onStart={onStart} onChanged={onChanged} />)}
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
                    <NextStepRow key={it.id} item={it} highlighted={highlight === it.id} onStart={onStart} onChanged={onChanged} />
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

  if (kiosk) return <div className="ns"><p className="ns-empty">Next steps lives on your phone and on NEURO desktop — not on this screen.</p></div>;
  if (error && !data) return <div className="ns"><p className="ns-gap">{error}</p></div>;
  if (!data) return <div className="ns"><p className="ns-empty">Reading what’s pending…</p></div>;
  return <NextStepsView data={data} filter={filter} setFilter={setFilter} highlight={highlight} onStart={onStart} onChanged={load} />;
}
