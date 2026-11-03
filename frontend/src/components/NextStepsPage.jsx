import React, { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../api';
import './NextStepsPage.css';

/**
 * Next steps (3 Nov 2026): everything pending in one list, the same three
 * choices on every row — Start, Snooze, Not today. The server composes the
 * list from the modules that own each thing (services/next-steps.js); this page
 * renders it and ranks nothing. Start goes to that module's own screen.
 */

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
  return fetch(apiUrl(path), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => ({ ok: false, error: 'No answer from NEURO.' }));
}

export function NextStepRow({ item, highlighted, onStart, onChanged, snoozed = false }) {
  const [menu, setMenu] = useState(null); // null | 'snooze' | 'nottoday'
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const defer = async (body) => {
    setBusy(true); setErr('');
    const r = await post('/api/next-steps/defer', { id: item.id, ...body });
    setBusy(false); setMenu(null);
    if (r.ok) onChanged(); else setErr(r.error || 'Not snoozed.');
  };
  const undefer = async () => {
    setBusy(true); setErr('');
    const r = await post('/api/next-steps/undefer', { id: item.id });
    setBusy(false);
    if (r.ok) onChanged(); else setErr(r.error || 'Could not bring it back.');
  };

  return (
    <div className={`ns-row${highlighted ? ' is-highlighted' : ''}${item.group === 'now' && !snoozed ? ' is-now' : ''}`} id={`ns-${item.id}`}>
      <div className="ns-row-main">
        <span className={`ns-kind ns-kind-${item.kind}`}>{KIND_LABEL[item.kind] || item.kind.toUpperCase()}</span>
        <div className="ns-text">
          <span className="ns-title">{item.title}</span>
          <span className="ns-why">
            {snoozed ? `Snoozed until ${untilLabel(item.snoozedUntil)}${item.snoozeReason && item.snoozeReason !== 'not-now' && item.snoozeReason !== 'unspecified' ? ` · ${item.snoozeReason.replace(/-/g, ' ')}` : ''}` : item.why}
          </span>
        </div>
        {snoozed ? (
          <button className="ns-btn ns-btn-secondary" disabled={busy} onClick={undefer}>{busy ? '…' : 'Bring it back'}</button>
        ) : (
          <>
            <button className="ns-btn ns-btn-primary" onClick={() => onStart(item)}>{item.start.label}</button>
            <button className="ns-btn ns-btn-secondary" aria-expanded={menu === 'snooze'} disabled={busy} onClick={() => setMenu(menu === 'snooze' ? null : 'snooze')}>Snooze ▾</button>
            <button className="ns-btn ns-btn-quiet" aria-expanded={menu === 'nottoday'} disabled={busy} onClick={() => setMenu(menu === 'nottoday' ? null : 'nottoday')}>Not today</button>
          </>
        )}
      </div>
      {menu === 'snooze' && (
        <div className="ns-menu" role="group" aria-label="Snooze for">
          {SNOOZES.map((s) => (
            <button key={s.label} className="ns-chip" disabled={busy} onClick={() => defer(s.notToday ? { notToday: true } : { minutes: s.minutes })}>{s.label}</button>
          ))}
        </div>
      )}
      {menu === 'nottoday' && (
        <div className="ns-menu" role="group" aria-label="Why not today">
          <span className="ns-menu-label">Why? It comes back tomorrow morning.</span>
          {NOT_TODAY_REASONS.map((r) => (
            <button key={r.reason} className="ns-chip" disabled={busy} onClick={() => defer({ notToday: true, reason: r.reason })}>{r.label}</button>
          ))}
        </div>
      )}
      {err && <div className="ns-err">{err}</div>}
    </div>
  );
}

export function NextStepsView({ data, filter, setFilter, highlight, onStart, onChanged }) {
  const items = data.items || [];
  const snoozed = data.snoozed || [];
  const shown = filter === 'snoozed' ? snoozed
    : items.filter((x) => (filter === 'work' ? x.sphere === 'work'
      : filter === 'life' ? x.sphere === 'life'
        : filter === 'quick' ? (x.minutes != null && x.minutes <= 15) : true));
  const count = (key) => (key === 'snoozed' ? snoozed.length
    : key === 'all' ? items.length
      : key === 'quick' ? items.filter((x) => x.minutes != null && x.minutes <= 15).length
        : items.filter((x) => x.sphere === key).length);

  return (
    <div className="ns-page">
      <div className="ns-head">
        <div className="ns-head-text">
          <span className="ns-eyebrow">EVERYTHING PENDING, MOST USEFUL FIRST</span>
          <h1 className="ns-h1">Next steps</h1>
        </div>
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
          {shown.map((it) => <NextStepRow key={it.id} item={it} snoozed onStart={onStart} onChanged={onChanged} />)}
        </section>
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
                {rows.map((it) => (
                  <NextStepRow key={it.id} item={it} highlighted={highlight === it.id} onStart={onStart} onChanged={onChanged} />
                ))}
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

  useEffect(() => {
    if (!highlight || !data) return;
    const el = document.getElementById(`ns-${highlight}`);
    if (el) el.scrollIntoView({ block: 'center' });
  }, [highlight, data]);

  const onStart = (item) => onNavigate && onNavigate(item.start.view, item.start.context || null);

  if (error && !data) return <div className="ns-page"><div className="ns-gap">{error}</div></div>;
  if (!data) return <div className="ns-page"><p className="ns-empty">Reading what’s pending…</p></div>;
  return <NextStepsView data={data} filter={filter} setFilter={setFilter} highlight={highlight} onStart={onStart} onChanged={load} />;
}
