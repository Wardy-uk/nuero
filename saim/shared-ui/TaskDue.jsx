import { useState } from 'react';
import dueDates from '../../shared/due-dates.cjs';
import './AttentionCard.css';

const { duePresets, toDateStr } = dueDates;

// ONE due-date control, wherever a task opens (Nick, 6 Nov 2026: "add the due
// field to everywhere a task opens — so I can change it anywhere"). The attention
// card, its Needs-you row, the Task workflow screen and SAiM's Tasks list all use
// these, so the presets, the wording and the write cannot drift between them.
//
// The write is the task's OWN edit route — the same one Tasks uses — so a re-date
// from here is counted wherever re-dates are counted. Nothing else is written.

/** "Mon 9 Nov" from a YYYY-MM-DD key — sliced, never shifted a day by a zone. PURE. */
export function dueLabel(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) return String(dateStr || '');
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * Write a new due date (or `null` to clear it) through the task's own edit route.
 * target: {kind:'neuro', taskId} | {kind:'microsoft', msId}. Returns {ok, why}.
 */
export async function moveDue(call, target, dateStr) {
  if (!call || !target) return { ok: false, why: 'This screen can’t move a due date.' };
  const clear = dateStr === null;
  if (!clear && !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return { ok: false, why: 'Pick a date first.' };
  const r = target.kind === 'neuro'
    ? await call(`/api/tasks/${target.taskId}`, { method: 'PATCH', body: { due_date: clear ? null : dateStr } })
    : await call(`/api/todos/ms/${encodeURIComponent(target.msId)}`, { method: 'PATCH', body: { dueDate: clear ? null : dateStr } });
  if (r && r.status >= 200 && r.status < 300 && !(r.body && r.body.ok === false)) return { ok: true };
  return { ok: false, why: (r && r.body && (r.body.error || r.body.why)) || `NEURO refused it (${r ? r.status : 'no answer'}).` };
}

/** The choices: presets, a day picker and (optionally) "No date". */
export function DuePicker({ disabled, onPick, allowClear = false }) {
  const presets = duePresets(new Date());
  return (
    <div className="att-card__due" role="group" aria-label="Move the due date">
      <span className="att-card__due-label">Due</span>
      {presets.map((p) => (
        <button key={p.id} type="button" className="att-card__btn" disabled={disabled} onClick={() => onPick(p.date)}>
          {p.label} <span className="att-card__btn--quiet">· {dueLabel(p.date)}</span>
        </button>
      ))}
      <input
        type="date"
        className="att-card__due-pick"
        min={toDateStr(new Date())}
        aria-label="Pick a day"
        disabled={disabled}
        onChange={(e) => { if (e.target.value) onPick(e.target.value); }}
      />
      {allowClear && (
        <button type="button" className="att-card__btn att-card__btn--quiet" disabled={disabled} onClick={() => onPick(null)}>No date</button>
      )}
    </div>
  );
}

/**
 * The due field for an opened task: the current date and a way to change it.
 *   target   {kind:'neuro', taskId} | {kind:'microsoft', msId}, or null (shown read-only)
 *   due      YYYY-MM-DD or null
 *   call     ({status, body}) over NEURO's fetch; null (the kiosk) → read-only
 *   onChanged  called after a successful write (re-read the screen)
 */
export default function TaskDue({ target = null, due = null, call = null, onChanged = null, readOnly = false, hideValue = false, className = '' }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const editable = Boolean(call && target && !readOnly);
  const pick = async (dateStr) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await moveDue(call, target, dateStr);
      if (!r.ok) setNote({ error: true, text: r.why });
      else {
        setOpen(false);
        setNote({ error: false, text: dateStr ? `Due date moved to ${dueLabel(dateStr)}.` : 'Due date cleared.' });
        onChanged?.(dateStr);
      }
    } catch (e) { setNote({ error: true, text: e.message }); }
    setBusy(false);
  };
  return (
    <div className={`task-due ${className}`.trim()}>
      {!hideValue && <span className="task-due__value">{due ? `Due ${dueLabel(due)}` : 'No due date'}</span>}
      {editable && (
        <button type="button" className="att-card__btn" aria-expanded={open} onClick={() => setOpen(!open)}>
          {due ? 'Change due date' : 'Set a due date'}
        </button>
      )}
      {editable && open && <DuePicker disabled={busy} onPick={pick} allowClear={Boolean(due)} />}
      {note && <p className={`att-needs__note${note.error ? ' att-needs__note--error' : ''}`} role="status">{note.text}</p>}
    </div>
  );
}
