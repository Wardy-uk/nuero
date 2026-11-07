import { useCallback, useEffect, useState } from 'react';
import { KmwMove, KmwDelivery } from './presentation/KeepMyWord.jsx';
import { startTaskSession, takeParked } from './startTask.mjs';
import TaskDue from './TaskDue.jsx';
import NotToday, { ParkedNote } from './NotToday.jsx';
import DelegateTasks from './DelegateTasks.jsx';
import { TickOutcome, JiraHint } from './TaskActions.jsx';
import { completeTask } from './completeTask.mjs';
import './presentation/KeepMyWord.css';
import './TaskWorkflow.css';

// The Task workflow screen (31 Oct 2026) — everything that used to crowd SAiM's
// Keep my word card, on one full-width screen per task, in this order:
//
//   1. Header   the title, due / owed to / state, the focus clock for THIS task
//               (Pause / Resume / That's done / Stop for now — the focus-session
//               routes), Back, and "Open in Tasks" where the shell can. With no
//               session on it: Start · Done · Not today, and Delegate (7 Nov 2026).
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
  session = null, sessionBusy = false, sessionNote = null, parked = null,
  onBack = null, onOpenTask = null, onSessionAct = null, onStart = null,
  // No session running (7 Nov 2026, audit F5/F18): the header also offers Done,
  // Not today and Delegate — the same shared pieces as the task lists.
  onDone = null, tickOutcome = null, onNotToday = null, onDelegated = null, onResumed = null,
  onPrepareDelivery = null, onPromiseMove = null, onOpenActions = null,
  renderPromiseSave = null, renderTools = null, readOnly = false,
  // NEURO's fetch ({status, body}) — with it the due date can be changed here. Null → shown only.
  call = null, onDueChanged = null,
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
            {task.moscow && <span>{String(task.moscow).toUpperCase()}</span>}
            {task.status && <span className="twf__pill">{task.status}</span>}
          </p>
        ) : null}
        {/* The due date, changeable wherever a task opens (6 Nov 2026). */}
        {(task || thread) && id && (
          <TaskDue
            target={{ kind: 'neuro', taskId: Number(id) }}
            due={task ? task.dueDate : null}
            hideValue={Boolean(thread)}
            call={actions ? call : null}
            onChanged={onDueChanged}
          />
        )}
        {thread && thread.preparation && thread.preparation.why && <p className="twf__why">{thread.preparation.why}</p>}
        {thread && thread.held && <p className="twf__why twf__held">{thread.held.say}</p>}
        {mine && actions && <FocusClock session={mine} busy={sessionBusy} onAct={onSessionAct || (() => {})} />}
        {/* ONE Start (startTask.mjs): a session already running is parked without
            asking, and "Parked X — Resume it" is offered right here. */}
        {!mine && actions && id && (onStart || onDone || onNotToday) && (
          <div className="twf__row">
            {onStart && <button type="button" className="twf__btn twf__btn--primary" disabled={sessionBusy} onClick={onStart}>{sessionBusy ? 'Starting…' : 'Start'}</button>}
            {onDone && <button type="button" className="twf__btn" disabled={sessionBusy} onClick={onDone}>Done</button>}
            {onNotToday && (
              <NotToday
                onDefer={onNotToday}
                call={call}
                taskId={id}
                text={title}
                busy={sessionBusy}
                classes={{ btn: 'twf__btn twf__btn--quiet', reason: 'twf__btn', wrap: 'twf__row' }}
              />
            )}
          </div>
        )}
        {parked && actions && <ParkedNote parked={parked} call={call} onResumed={onResumed} className="twf__note" />}
        {tickOutcome && <TickOutcome outcome={tickOutcome} call={actions ? call : null} className="twf__note" />}
        {task && <JiraHint item={task} className="twf__note" />}
        {!mine && actions && id && call && onDelegated && task && task.status !== 'done' && (
          <DelegateTasks todo={{ task_id: id, text: title }} call={call} onDone={onDelegated} />
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
  // A start made just before this screen opened (the Keep my word card) that
  // parked another task — offered back here, once.
  const [parked, setParked] = useState(() => takeParked());
  const [tickOutcome, setTickOutcome] = useState(null);

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

  const start = async () => {
    if (sessionBusy) return;
    setSessionBusy(true);
    try {
      const r = await startTaskSession(call, { taskId: id, text: title });
      if (r.ok) { setParked(r.parked || null); setSession(r.session || null); setSessionNote(null); if (onChanged) onChanged(); }
      else setSessionNote({ message: r.error, error: true });
    } finally { setSessionBusy(false); }
  };

  // Done with no session running — the ONE completion helper, and what it did is said.
  const done = async () => {
    if (sessionBusy || !id) return;
    setSessionBusy(true);
    try {
      const o = await completeTask(call, { task_id: id, text: title, jiraKey: (data && data.task && data.task.jiraKey) || null });
      setTickOutcome(o.kind === 'done' ? { kind: 'done', warning: o.warning || null } : o);
      if (o.kind === 'done') setSessionNote({ message: 'Done — the task is ticked off.', error: false });
      if (o.kind === 'done' || o.kind === 'repeated') { await load(); if (onChanged) onChanged(); }
    } finally { setSessionBusy(false); }
  };

  // Not today — the same lane deferral the task lists use, with the reason recorded.
  const notToday = async (reason) => {
    try {
      const r = await call('/api/todos/lane/defer', { method: 'POST', body: { text: title, reason } });
      if (!r || !r.body || r.body.ok === false) return { ok: false, error: (r && r.body && r.body.error) || `NEURO answered ${r ? r.status : 'nothing'}` };
      setSessionNote({ message: 'Put off until tomorrow. The task stays open and keeps its due date.', error: false });
      if (onChanged) onChanged();
      return { ok: true };
    } catch { return { ok: false, error: 'NEURO didn’t answer, so nothing was put off.' }; }
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
      session={session} sessionBusy={sessionBusy} sessionNote={sessionNote} parked={parked}
      tickOutcome={tickOutcome}
      call={call}
      onDueChanged={async () => { await load(); if (onChanged) onChanged(); }}
      onSessionAct={sessionAct}
      onStart={() => start()}
      onDone={call ? done : null}
      onNotToday={call ? notToday : null}
      onDelegated={async () => { await load(); if (onChanged) onChanged(); }}
      onResumed={async () => { setParked(null); await loadSession(); if (onChanged) onChanged(); }}
      onPromiseMove={rest.onPromiseMove ? async (op) => { const r = await rest.onPromiseMove(op); if (r && r.ok) load(); return r; } : null}
    />
  );
}
