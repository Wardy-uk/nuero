import { useCallback, useEffect, useState } from 'react';
import { KmwMove, KmwDelivery } from './presentation/KeepMyWord.jsx';
import { startTaskSession, switchQuestion } from './startTask.mjs';
import './presentation/KeepMyWord.css';
import './TaskWorkflow.css';

// The Task workflow screen (31 Oct 2026) — everything that used to crowd SAiM's
// Keep my word card, on one full-width screen per task, in this order:
//
//   1. Header   the title, due / owed to / state, the focus clock for THIS task
//               (Pause / Resume / That's done / Stop for now — the focus-session
//               routes), Back, and "Open in Tasks" where the shell can.
//   2. Next     for a promise only: the prepared move (KmwMove + the shell's
//               governed save step) and the delivery note (KmwDelivery) — the
//               SAME components and routes the card used; nothing new writes.
//   3. Tools    the shell's slot: TaskAgent (Do this, Claude on the desktop,
//               From Claude, Next steps) and TaskContext (linked notes).
//   4. Evidence the promise's evidence lines, folded.
//
// It reads ONE route, GET /api/promises/workflow (task-workflow-v1), and works for
// ANY task id — a task that is not a promise has a header and its tools only.

const STATE_SAY = { active: 'In focus', paused: 'Paused', interrupted: 'Stepped away', 'needs-smaller': 'Needs a smaller step' };

/** PURE. "12 min in" / "1 h 05 in". */
export function clockSay(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m < 60) return `${m} min in`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} in`;
}

/** PURE. Is the running session on this task? */
export function sessionFor(session, taskId) {
  if (!session || session.stale || taskId == null || session.taskId == null) return null;
  return Number(session.taskId) === Number(taskId) ? session : null;
}

function FocusClock({ session, busy, onAct }) {
  const paused = session.status !== 'active';
  return (
    <div className={`twf__clock${paused ? ' twf__clock--paused' : ''}`} role="group" aria-label="Focus session">
      <span className="twf__clock-dot" aria-hidden="true" />
      <span className="twf__clock-time">{clockSay(session.elapsedMinutes)}</span>
      <span className="twf__clock-state">{STATE_SAY[session.status] || session.status}{session.plannedMinutes ? ` · ${session.plannedAssumed ? 'assuming ' : ''}${session.plannedMinutes} min` : ''}</span>
      <span className="twf__clock-acts">
        {paused
          ? <button type="button" className="twf__btn" disabled={busy} onClick={() => onAct('resume')}>Resume</button>
          : <button type="button" className="twf__btn" disabled={busy} onClick={() => onAct('pause')}>Pause</button>}
        <button type="button" className="twf__btn twf__btn--primary" disabled={busy} onClick={() => onAct('done')}>That’s done</button>
        <button type="button" className="twf__btn twf__btn--quiet" disabled={busy} onClick={() => onAct('stop')}>Stop for now</button>
      </span>
    </div>
  );
}

/**
 * PURE render of the screen (the render tests draw this). Every handler is optional:
 * absent, its control is not drawn. `readOnly` draws no control at all.
 */
export function TaskWorkflowView({
  data = null, loading = false, error = null, taskId = null,
  session = null, sessionBusy = false, sessionNote = null, conflict = null,
  onBack = null, onOpenTask = null, onSessionAct = null, onStart = null, onSwitch = null, onCancelSwitch = null,
  onPrepareDelivery = null, onPromiseMove = null, onOpenActions = null,
  renderPromiseSave = null, renderTools = null, readOnly = false,
}) {
  const thread = (data && data.thread) || null;
  const task = (data && data.task) || null;
  const id = (task && task.id) || (thread && thread.taskId) || taskId || null;
  const title = (thread && thread.title) || (task && task.text) || (loading ? 'Loading the task…' : 'Task');
  const mine = sessionFor(session, id);
  const actions = !readOnly;
  return (
    <div className="twf">
      <header className="twf__head twf__card">
        <div className="twf__nav">
          {onBack && <button type="button" className="twf__back" onClick={onBack}><span aria-hidden="true">‹</span> Back</button>}
          {onOpenTask && id && <button type="button" className="twf__link" onClick={() => onOpenTask(id)}>Open in Tasks</button>}
        </div>
        <p className="twf__label">{thread ? 'Keeping your word' : 'Task'}{id ? ` · #${id}` : ''}</p>
        <h1 className="twf__title">{title}</h1>
        {thread ? (
          <p className="twf__meta">
            <span className="twf__due">{thread.due.label}</span>
            {thread.owedTo && <span> · owed to {thread.owedTo}</span>}
            <span> · {thread.due.say}</span>
            {thread.preparation && thread.preparation.label && <span className="twf__pill">{thread.preparation.label}</span>}
          </p>
        ) : task ? (
          <p className="twf__meta">
            {task.dueDate ? <span className="twf__due">Due {task.dueDate}</span> : <span>No due date</span>}
            {task.moscow && <span> · {String(task.moscow).toUpperCase()}</span>}
            {task.status && <span className="twf__pill">{task.status}</span>}
          </p>
        ) : null}
        {thread && thread.preparation && thread.preparation.why && <p className="twf__why">{thread.preparation.why}</p>}
        {thread && thread.held && <p className="twf__why twf__held">{thread.held.say}</p>}
        {mine && actions && <FocusClock session={mine} busy={sessionBusy} onAct={onSessionAct || (() => {})} />}
        {!mine && actions && id && conflict && (
          <div className="twf__switch" role="group" aria-label="Switch focus">
            <p>{switchQuestion(conflict.text)}</p>
            <div className="twf__row">
              <button type="button" className="twf__btn twf__btn--primary" disabled={sessionBusy} onClick={onSwitch || undefined}>Switch to this</button>
              <button type="button" className="twf__btn twf__btn--quiet" disabled={sessionBusy} onClick={onCancelSwitch || undefined}>Not now</button>
            </div>
          </div>
        )}
        {!mine && actions && id && !conflict && onStart && (
          <div className="twf__row"><button type="button" className="twf__btn twf__btn--primary" disabled={sessionBusy} onClick={onStart}>{sessionBusy ? 'Starting…' : 'Start a focus session'}</button></div>
        )}
        {sessionNote && <p className={`twf__note${sessionNote.error ? ' twf__note--error' : ''}`} role="status">{sessionNote.message}</p>}
        {error && <p className="twf__note twf__note--error" role="status">{error}</p>}
        {data && data.threadWhy && !thread && <p className="twf__note">{data.threadWhy}</p>}
      </header>

      {thread && (thread.move || thread.draft) && (
        <section className="twf__card twf__next kmw__main" aria-label="Next for this promise">
          <h2 className="twf__h">For this promise</h2>
          <div className="kmw__rows">
            {thread.draft && <KmwDelivery thread={thread} actions={actions} onPrepareDelivery={onPrepareDelivery} onOpenActions={onOpenActions} />}
            {thread.move && <KmwMove move={thread.move} onPromiseMove={actions ? onPromiseMove : null} readOnly={!actions} renderSave={actions ? renderPromiseSave : null} />}
          </div>
        </section>
      )}

      {id && renderTools && (
        <section className="twf__card twf__tools" aria-label="Work on it">
          <h2 className="twf__h">Work on it</h2>
          {renderTools({ taskId: id })}
        </section>
      )}

      {thread && (thread.evidence || []).length > 0 && (
        <details className="twf__card twf__evidence">
          <summary className="twf__h">Evidence</summary>
          <ul>{thread.evidence.map((e, i) => <li key={i}>{e.fact}</li>)}</ul>
          {(thread.because || []).length > 0 && <p className="twf__because">Why it is at risk: {thread.because.join('; ')}.</p>}
        </details>
      )}
    </div>
  );
}

/**
 * The screen, with its reads and the focus-session controls.
 *   taskId / promiseKey   what to show (either; both is fine)
 *   call                  ({status, body}) over NEURO's own fetch
 *   startError            the shell tried to start a session and NEURO refused — said here
 *   initial / initialSession  data already in hand (tests, or a shell that has it)
 */
export default function TaskWorkflow({ taskId = null, promiseKey = null, call, startError = null, initial = null, initialSession = null, onChanged = null, ...rest }) {
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState(null);
  const [session, setSession] = useState(initialSession);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionNote, setSessionNote] = useState(startError ? { message: startError, error: true } : null);
  const [conflict, setConflict] = useState(null);

  const load = useCallback(async () => {
    if (!call) return;
    const q = [taskId != null && taskId !== '' ? `taskId=${encodeURIComponent(taskId)}` : null, promiseKey ? `key=${encodeURIComponent(promiseKey)}` : null].filter(Boolean).join('&');
    if (!q) { setLoading(false); setError('No task was named.'); return; }
    try {
      const r = await call(`/api/promises/workflow?${q}`);
      if (r && r.status === 200 && r.body && r.body.ok) { setData(r.body); setError(null); }
      else setError((r && r.body && r.body.error) || `NEURO answered ${r ? r.status : 'nothing'}.`);
    } catch { setError('NEURO didn’t answer, so the task couldn’t be read.'); }
    finally { setLoading(false); }
  }, [call, taskId, promiseKey]);

  const loadSession = useCallback(async () => {
    if (!call) return;
    try { const r = await call('/api/session'); if (r && r.status === 200 && r.body) setSession(r.body.session || null); } catch { /* the clock stays as it was */ }
  }, [call]);

  useEffect(() => { load(); loadSession(); }, [load, loadSession]);
  useEffect(() => {
    const t = setInterval(loadSession, 30_000);
    return () => clearInterval(t);
  }, [loadSession]);

  const id = (data && data.task && data.task.id) || (data && data.thread && data.thread.taskId) || taskId;
  const title = (data && data.thread && data.thread.title) || (data && data.task && data.task.text) || '';

  const start = async (force = false) => {
    if (sessionBusy) return;
    setSessionBusy(true);
    try {
      const r = await startTaskSession(call, { taskId: id, text: title, force });
      if (r.conflict) setConflict(r.conflict);
      else if (r.ok) { setConflict(null); setSession(r.session || null); setSessionNote(null); if (onChanged) onChanged(); }
      else setSessionNote({ message: r.error, error: true });
    } finally { setSessionBusy(false); }
  };

  const sessionAct = async (what) => {
    if (sessionBusy) return;
    setSessionBusy(true);
    const path = what === 'pause' ? '/api/session/pause' : what === 'resume' ? '/api/session/resume' : '/api/session/finish';
    const body = what === 'done' ? { completeTask: true } : {};
    try {
      const r = await call(path, { method: 'POST', body });
      if (r && r.status >= 200 && r.status < 300) {
        if (what === 'done') setSessionNote({ message: 'Done — the session is finished and the task is ticked.', error: false });
        else if (what === 'stop') setSessionNote({ message: 'Stopped. The task is still open.', error: false });
        else setSessionNote(null);
        await loadSession();
        if (what === 'done' || what === 'stop') { await load(); if (onChanged) onChanged(); }
      } else setSessionNote({ message: (r && r.body && r.body.error) || 'NEURO refused that.', error: true });
    } catch { setSessionNote({ message: 'NEURO didn’t answer. Nothing changed.', error: true }); }
    finally { setSessionBusy(false); }
  };

  return (
    <TaskWorkflowView
      {...rest}
      data={data} loading={loading} error={error} taskId={taskId}
      session={session} sessionBusy={sessionBusy} sessionNote={sessionNote} conflict={conflict}
      onSessionAct={sessionAct}
      onStart={() => start(false)}
      onSwitch={() => start(true)}
      onCancelSwitch={() => setConflict(null)}
      onPromiseMove={rest.onPromiseMove ? async (op) => { const r = await rest.onPromiseMove(op); if (r && r.ok) load(); return r; } : null}
    />
  );
}
