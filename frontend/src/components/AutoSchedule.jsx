import React, { useMemo, useState } from 'react';
import { apiUrl } from '../api';
import { msPlanBadge } from '../../../shared/ms-task.cjs';
import './AutoSchedule.css';

/**
 * Auto-schedule (28 Oct 2026). Nick picks a start date, a cap on task hours a
 * day and the tasks; NEURO packs them, in list order, into working days and
 * sets each one's DUE DATE. Nothing goes in the diary (his call).
 *
 * Two steps, like every other write that changes many things at once: Preview
 * asks the server for the plan (it alone knows bank holidays and his leave) and
 * writes nothing; Apply writes each date through the SAME routes the task card
 * and the triage run use, so there is no second write path. Each row reports
 * its own outcome — one refusal must not hide the rest.
 */

const BAND_LABEL = { must: 'Must', should: 'Should', could: 'Could', wont: "Won't", none: 'No MoSCoW' };
const HOURS_KEY = 'neuro_autoschedule_hours';

export function keyOf(t) {
  if (t.task_id) return `task:${t.task_id}`;
  if (t.ms_id) return `ms:${t.ms_id}`;
  return null;
}

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Sliced, never parsed into a Date and re-rendered — that is the BST bug. */
function dayLabel(s) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d, 12);
  return dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function hm(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

function readHours() {
  try { const v = Number(localStorage.getItem(HOURS_KEY)); return v > 0 ? v : 4; } catch { return 4; }
}

async function send(path, method, body) {
  const res = await fetch(apiUrl(path), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.error || `NEURO answered ${res.status}`);
  return json;
}

export default function AutoSchedule({ todos, bandOf, onClose, onSaved }) {
  // Snapshot on open: the list refreshing under a half-made selection would move
  // rows out from under the cursor.
  const [rows] = useState(() => (todos || []).filter((t) => !t.done && keyOf(t)));
  const excluded = (todos || []).filter((t) => !t.done && !keyOf(t)).length;
  const [startDate, setStartDate] = useState(localToday);
  const [maxHours, setMaxHours] = useState(readHours);
  const [selected, setSelected] = useState(() => new Set());
  const [plan, setPlan] = useState(null);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState(null);
  const [applying, setApplying] = useState(false);
  const [outcomes, setOutcomes] = useState({});

  const byKey = useMemo(() => new Map(rows.map((t) => [keyOf(t), t])), [rows]);
  const grouped = useMemo(() => {
    const out = [];
    for (const t of rows) {
      const band = bandOf(t);
      let g = out.find((x) => x.band === band);
      if (!g) { g = { band, rows: [] }; out.push(g); }
      g.rows.push(t);
    }
    return out;
  }, [rows, bandOf]);

  const invalidate = () => { setPlan(null); setOutcomes({}); };
  const toggle = (k) => {
    invalidate();
    setSelected((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  };
  const setMany = (keys, on) => {
    invalidate();
    setSelected((prev) => { const n = new Set(prev); keys.forEach((k) => (on ? n.add(k) : n.delete(k))); return n; });
  };

  const preview = async () => {
    setError(null);
    setPlanning(true);
    try {
      try { localStorage.setItem(HOURS_KEY, String(maxHours)); } catch { /* per-device convenience only */ }
      // List order, not click order (Nick's call).
      const items = rows.filter((t) => selected.has(keyOf(t)))
        .map((t) => ({ key: keyOf(t), estimateMinutes: t.estimateMinutes ?? null }));
      const json = await send('/api/todos/auto-schedule/plan', 'POST', { startDate, maxHours: Number(maxHours), items });
      setPlan(json);
      setOutcomes({});
    } catch (e) {
      setError(e.message);
      setPlan(null);
    } finally {
      setPlanning(false);
    }
  };

  const apply = async () => {
    if (!plan || applying) return;
    setApplying(true);
    setError(null);
    const results = {};
    for (const a of plan.assignments) {
      const t = byKey.get(a.key);
      if (!t) { results[a.key] = { ok: false, error: 'no longer in the list' }; continue; }
      if (String(t.due_date || '').slice(0, 10) === a.date) { results[a.key] = { ok: true, unchanged: true }; continue; }
      try {
        if (t.task_id) {
          await send(`/api/tasks/${t.task_id}`, 'PATCH', { due_date: a.date });
        } else {
          await send(`/api/todos/ms/${encodeURIComponent(t.ms_id)}`, 'PATCH', {
            dueDate: a.date,
            source: t.source || null,
            filePath: t.filePath || null,
            lineNumber: t.lineNumber != null ? t.lineNumber : null,
          });
        }
        results[a.key] = { ok: true };
      } catch (e) {
        results[a.key] = { ok: false, error: e.message };
      }
      setOutcomes({ ...results });
    }
    setApplying(false);
    if (onSaved) onSaved();
  };

  const done = Object.values(outcomes);
  const failed = done.filter((o) => !o.ok).length;
  const applied = plan && done.length === plan.assignments.length;

  return (
    <div className="asched">
      <div className="asched-head">
        <h2 className="asched-title">Auto-schedule</h2>
        <span className="asched-sub">Sets due dates only — nothing goes in your calendar.</span>
        <button type="button" className="btn btn-secondary" onClick={onClose}>Back to tasks</button>
      </div>

      <div className="asched-controls">
        <label>
          <span>Start date</span>
          <input type="date" value={startDate} min={localToday()} onChange={(e) => { setStartDate(e.target.value); invalidate(); }} />
        </label>
        <label>
          <span>Max hours of tasks a day</span>
          <input type="number" min="0.5" max="12" step="0.5" value={maxHours}
            onChange={(e) => { setMaxHours(e.target.value); invalidate(); }} />
        </label>
        <button type="button" className="btn btn-primary" disabled={!selected.size || planning} onClick={preview}>
          {planning ? 'Planning…' : `Preview ${selected.size || ''} task${selected.size === 1 ? '' : 's'}`}
        </button>
        {error && <span className="asched-error">{error}</span>}
      </div>

      <div className="asched-body">
        <section className="asched-pick">
          <div className="asched-pick-head">
            <strong>Tasks</strong>
            <span>{selected.size} of {rows.length} picked</span>
            <button type="button" className="asched-link" onClick={() => setMany(rows.map(keyOf), true)}>All</button>
            <button type="button" className="asched-link" onClick={() => setMany(rows.map(keyOf), false)}>None</button>
          </div>
          {excluded > 0 && (
            <p className="asched-note">{excluded} daily-note line{excluded === 1 ? '' : 's'} left out — a line in a note cannot hold a due date.</p>
          )}
          {grouped.map((g) => (
            <div key={g.band} className="asched-band">
              <div className="asched-band-head">
                <span>{BAND_LABEL[g.band] || g.band}</span>
                <button type="button" className="asched-link" onClick={() => setMany(g.rows.map(keyOf), true)}>pick all</button>
              </div>
              {g.rows.map((t) => {
                const k = keyOf(t);
                const plan2 = msPlanBadge(t, { withSystem: !t.task_id });
                return (
                  <label key={k} className={`asched-row${selected.has(k) ? ' on' : ''}`}>
                    <input type="checkbox" checked={selected.has(k)} onChange={() => toggle(k)} />
                    <span className="asched-text">{t.text}</span>
                    <span className="asched-meta">
                      {t.task_id ? `#${t.task_id}` : plan2}
                      {' · '}{t.estimateMinutes != null ? hm(t.estimateMinutes) : '30m?'}
                      {t.due_date ? ` · due ${String(t.due_date).slice(0, 10)}` : ''}
                    </span>
                  </label>
                );
              })}
            </div>
          ))}
        </section>

        <section className="asched-plan">
          {!plan && <p className="asched-note">Pick tasks, then Preview. Nothing changes until you press Apply.</p>}
          {plan && (
            <>
              <div className="asched-plan-head">
                <strong>{plan.assignments.length} tasks over {plan.days.length} working day{plan.days.length === 1 ? '' : 's'}</strong>
                <span>up to {hm(plan.capMinutes)} a day{plan.lastDate ? `, finishing ${dayLabel(plan.lastDate)}` : ''}</span>
              </div>
              {plan.assumedCount > 0 && <p className="asched-note">{plan.assumedCount} task{plan.assumedCount === 1 ? ' has' : 's have'} no estimate and {plan.assumedCount === 1 ? 'is' : 'are'} counted as 30 min.</p>}
              {plan.skipped.length > 0 && (
                <p className="asched-note">Skipped: {plan.skipped.map((s) => `${dayLabel(s.date)} (${s.reason === 'leave' ? 'your leave' : 'bank holiday'})`).join(', ')}.</p>
              )}
              {!plan.leave?.checked && <p className="asched-warn">Your leave could not be checked ({plan.leave?.reason}) — dates may land on a day off.</p>}
              {plan.leave?.pastHorizon && <p className="asched-warn">Leave is only known to {dayLabel(plan.leave.coversTo)}; later days were not checked.</p>}
              {plan.unplaced.length > 0 && <p className="asched-warn">{plan.unplaced.length} task(s) could not be placed within a year.</p>}

              <div className="asched-days">
                {plan.days.map((d) => (
                  <div key={d.date} className={`asched-day${d.overCap ? ' over' : ''}`}>
                    <div className="asched-day-head">
                      <span>{dayLabel(d.date)}</span>
                      <span>{hm(d.minutes)}{d.overCap ? ' — over the cap (one task bigger than a day)' : ''}</span>
                    </div>
                    {d.keys.map((k) => {
                      const t = byKey.get(k);
                      const a = plan.assignments.find((x) => x.key === k);
                      const o = outcomes[k];
                      return (
                        <div key={k} className="asched-item">
                          <span className="asched-text">{t ? t.text : k}</span>
                          <span className="asched-meta">{hm(a.minutes)}{a.assumed ? '?' : ''}</span>
                          {o && <span className={o.ok ? 'asched-ok' : 'asched-fail'}>{o.ok ? (o.unchanged ? 'already' : 'set') : `not set — ${o.error}`}</span>}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>

              <div className="asched-apply">
                {!applied && (
                  <button type="button" className="btn btn-primary" disabled={applying} onClick={apply}>
                    {applying ? `Setting dates… ${done.length}/${plan.assignments.length}` : `Apply — set ${plan.assignments.length} due date${plan.assignments.length === 1 ? '' : 's'}`}
                  </button>
                )}
                {applied && (
                  <span className={failed ? 'asched-fail' : 'asched-ok'}>
                    {failed ? `${done.length - failed} set, ${failed} not set — see the rows above.` : 'All due dates set.'}
                  </span>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
