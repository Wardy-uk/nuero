import { useState } from 'react';
import { NOT_TODAY_REASONS } from './notTodayReasons.mjs';
import { startSmallestStep, resumeParked, parkedLine } from './startTask.mjs';
import './NotToday.css';

// "Not today" — the ONE picker every surface mounts (7 Nov 2026, audit F3/F4/H).
//
// The four reasons come from notTodayReasons.mjs (attention-lifecycle's keys,
// which friction.js reads back as evidence about the work). "It's too big"
// never just hides the task: it asks for the smallest first step and starts a
// 15-minute focus session on it. The defer reason `too-big` is recorded only if
// he chooses "Not today anyway".
//
// Props
//   onDefer(reasonKey) → Promise<{ok?, error?}|void>   the surface's own defer route
//   call               ({status, body}) — needed to start the 15 minutes; absent → too-big just defers
//   taskId, text       the task the step belongs to
//   onStarted(result)  after the 15 minutes started
//   label              the closed button's words
//   classes            { btn, reason, wrap } — the surface's own look; defaults ship in NotToday.css

/** How long a "not today" lasts for a surface that defers by minutes. PURE.
 *  Waiting on someone: a day. Anything else: until 07:00 tomorrow (at least an hour). */
export function notTodayMinutes(reason, now = new Date()) {
  if (reason === 'waiting-on-someone') return 24 * 60;
  const t = new Date(now);
  const morning = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, 7, 0, 0, 0);
  return Math.max(60, Math.round((morning.getTime() - t.getTime()) / 60000));
}

/** "Parked X — Resume it", in place. */
export function ParkedNote({ parked, call, onResumed = null, className = 'ntd__parked' }) {
  const [state, setState] = useState(null); // null | 'busy' | 'resumed' | error
  if (!parked) return null;
  const resume = async () => {
    setState('busy');
    const r = await resumeParked(call, parked);
    if (r.ok) { setState('resumed'); onResumed?.(r); } else setState(r.error || 'Could not resume it.');
  };
  if (state === 'resumed') return <p className={className} role="status">Back on “{parked.text}”.</p>;
  return (
    <p className={className} role="status">
      {parkedLine(parked)}{' '}
      {call && parked.text && (
        <button type="button" className="ntd__link" disabled={state === 'busy'} onClick={(e) => { e.stopPropagation(); resume(); }}>
          {state === 'busy' ? 'Resuming…' : 'Resume it'}
        </button>
      )}
      {state && state !== 'busy' && <span className="ntd__err"> {state}</span>}
    </p>
  );
}

/** "Smallest first step?" — one box, then 15 minutes on it. */
export function SmallestStep({ call, taskId = null, text = '', onStarted = null, onNotToday = null, onCancel = null, classes = {} }) {
  const [step, setStep] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const btn = classes.reason || 'ntd__reason';
  if (result) {
    return (
      <div className={classes.wrap || 'ntd'} onClick={(e) => e.stopPropagation()}>
        <p className="ntd__ok" role="status">
          {result.step ? <>15 minutes on “{result.step}” — it’s running.</> : <>15 minutes on the task — it’s running.</>}
          {result.error ? <span className="ntd__err"> {result.error}</span> : null}
        </p>
        <ParkedNote parked={result.parked} call={call} />
      </div>
    );
  }
  const start = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    const r = await startSmallestStep(call, { taskId, text, step });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setResult(r);
    onStarted?.(r);
  };
  return (
    <div className={classes.wrap || 'ntd'} onClick={(e) => e.stopPropagation()}>
      <label className="ntd__q" htmlFor={`ntd-step-${taskId || 'x'}`}>Smallest first step?</label>
      <input
        id={`ntd-step-${taskId || 'x'}`}
        className="ntd__input"
        value={step}
        placeholder="e.g. open the doc and write the first line"
        onChange={(e) => setStep(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && step.trim()) start(); }}
      />
      <button type="button" className={`${btn} ntd__go`} disabled={busy || !step.trim() || !call} onClick={start}>
        {busy ? 'Starting…' : 'Start 15 minutes'}
      </button>
      {onNotToday && <button type="button" className={btn} disabled={busy} onClick={onNotToday}>Not today anyway</button>}
      {onCancel && <button type="button" className={btn} disabled={busy} onClick={onCancel}>Cancel</button>}
      {error && <p className="ntd__err" role="status">{error}</p>}
    </div>
  );
}

export default function NotToday({ onDefer, call = null, taskId = null, text = '', onStarted = null, label = 'Not today', busy = false, classes = {}, title = 'Move it out of today. The task stays open and keeps its due date.' }) {
  const [open, setOpen] = useState(false);
  const [tooBig, setTooBig] = useState(false);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState(null);
  const btn = classes.btn || 'ntd__btn';
  const reasonBtn = classes.reason || 'ntd__reason';

  const defer = async (key) => {
    if (pending) return;
    setPending(true); setNote(null);
    try {
      const r = await onDefer(key);
      if (r && r.ok === false) setNote({ bad: true, text: r.error || r.why || 'NEURO didn’t confirm that.' });
      else { setOpen(false); setTooBig(false); }
    } catch (e) {
      setNote({ bad: true, text: (e && e.message) || 'NEURO didn’t answer.' });
    }
    setPending(false);
  };

  if (!open) {
    return (
      <span className="ntd__closed" onClick={(e) => e.stopPropagation()}>
        <button type="button" className={btn} disabled={busy} title={title} onClick={() => setOpen(true)}>{label}</button>
        {note && <span className={note.bad ? 'ntd__err' : 'ntd__ok'}> {note.text}</span>}
      </span>
    );
  }
  if (tooBig && call) {
    return (
      <SmallestStep
        call={call} taskId={taskId} text={text} classes={classes}
        onStarted={onStarted}
        onNotToday={() => defer('too-big')}
        onCancel={() => { setTooBig(false); setOpen(false); }}
      />
    );
  }
  return (
    <div className={classes.wrap || 'ntd'} onClick={(e) => e.stopPropagation()}>
      <span className="ntd__q">Why not today?</span>
      {NOT_TODAY_REASONS.map((r) => (
        <button
          key={r.key}
          type="button"
          className={reasonBtn}
          disabled={busy || pending}
          title={r.desc}
          onClick={() => (r.key === 'too-big' && call ? setTooBig(true) : defer(r.key))}
        >{r.label}</button>
      ))}
      <button type="button" className={reasonBtn} disabled={pending} onClick={() => setOpen(false)}>Cancel</button>
      {note && <p className="ntd__err" role="status">{note.text}</p>}
    </div>
  );
}
