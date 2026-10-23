import { useCallback, useEffect, useRef, useState } from 'react';
import './TaskAgent.css';

// TaskAgent — the "Do this" workspace on ONE task (23 Oct 2026).
//
// The press means: NEURO, take this as far as it safely can. Everything shown
// here comes from /api/task-agent; the component decides nothing.
//
// `call(path, {method, body}) → {status, body}` is the shell's authenticated
// fetch (desktopCall on NEURO, a wrapped apiFetch on the phone). `onOpenActions`
// takes Nick to the existing approval screen for a prepared email; `onOpenNote`
// opens a source note. `readOnly` (the kiosk) renders NOTHING — no control and no
// working output, because the output can quote a restricted excerpt.
//
// ⚠ Nothing here completes the task. The tick stays Nick's statement.

const enc = encodeURIComponent;
const POLL_MS = 2500;

const STATUS_SAY = {
  running: 'Working on it…',
  'needs-answer': 'Needs your answer',
  'needs-manual': 'Needs you to do one thing',
  'needs-decision': 'Needs your decision',
  ready: 'Done as far as NEURO safely can',
  failed: 'Stopped — could not continue',
  interrupted: 'Interrupted — press Do this to continue',
  stopped: 'Stopped by you',
};
const KIND_SAY = { ambiguity: 'Which did you mean?', missing: 'NEURO needs one fact', manual: 'Only you can do this step', authority: 'Your decision' };

function money(u) {
  if (!u) return null;
  const tok = `${(u.promptTokens || 0).toLocaleString()} in · ${(u.completionTokens || 0).toLocaleString()} out`;
  const cost = u.costUnknown ? 'cost not known for this model' : `about $${Number(u.costUsd || 0).toFixed(4)}`;
  return `${u.model} · ${tok} · ${cost}`;
}

export function TaskAgentView({ run, busy, error, onStart, onAnswer, onStop, onOpenActions, onOpenNote }) {
  const [text, setText] = useState('');
  const q = run && run.question;
  useEffect(() => { setText(''); }, [q && q.id]);

  if (!run) {
    return (
      <div className="tagent tagent--idle" data-tagent="idle">
        <button type="button" className="tagent__go" onClick={() => onStart(false)} disabled={busy}>{busy ? 'Starting…' : 'Do this'}</button>
        <p className="tagent__hint">NEURO works on this as far as it safely can — drafts, plans, research — and asks you only when it must. It sends, books and changes nothing without your confirmation.</p>
        {error && <p className="tagent__err" role="alert">{error}</p>}
      </div>
    );
  }

  const used = (run.sources || []).filter((s) => s.used);
  const available = (run.sources || []).filter((s) => !s.used);
  const settled = ['ready', 'stopped', 'failed', 'interrupted'].includes(run.status);

  return (
    <div className={`tagent tagent--${run.status}`} data-tagent={run.status}>
      <div className="tagent__top">
        <span className="tagent__label">Do this</span>
        <span className="tagent__status" data-tagent-status={run.status}>{STATUS_SAY[run.status] || run.status}</span>
      </div>

      {run.understanding && <p className="tagent__understanding"><strong>Understood as:</strong> {run.understanding}</p>}
      {run.sensitive && run.sensitive.sensitive && (
        <p className="tagent__note">People / employment matter — NEURO prepares the material and stops at your decision. It will not contact anyone, promise anything or change anything.</p>
      )}
      {run.error && <p className="tagent__err" role="alert">{run.error}</p>}

      {q && (
        <form className="tagent__q" data-tagent-question={q.kind} onSubmit={(e) => { e.preventDefault(); onAnswer({ questionId: q.id, text }); }}>
          <p className="tagent__qkind">{KIND_SAY[q.kind] || 'Question'}</p>
          <p className="tagent__qtext">{q.question}</p>
          {q.why && <p className="tagent__qwhy">Why it matters: {q.why}</p>}
          {q.options && q.options.length > 0 && (
            <div className="tagent__opts">
              {q.options.map((o) => <button type="button" key={o} disabled={busy} onClick={() => onAnswer({ questionId: q.id, text: o })}>{o}</button>)}
            </div>
          )}
          <textarea className="tagent__answer" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={q.kind === 'manual' ? 'Anything NEURO should know (optional)' : 'Your answer'} aria-label="Your answer" />
          <div className="tagent__row">
            {q.kind === 'manual'
              ? <button type="button" disabled={busy} onClick={() => onAnswer({ questionId: q.id, text, manualDone: true })}>I’ve done it — carry on</button>
              : <button type="submit" disabled={busy || !text.trim()}>Tell NEURO</button>}
          </div>
        </form>
      )}

      {(run.handoffs || []).length > 0 && (
        <div className="tagent__section">
          <p className="tagent__h">Ready for your confirmation</p>
          <ul className="tagent__list">
            {run.handoffs.map((h) => (
              <li key={h.actionId || h.say} data-tagent-handoff={h.actionType}>
                <p>{h.say}</p>
                <p className="tagent__meta">Status: {h.status}</p>
                {onOpenActions && <button type="button" onClick={() => onOpenActions(h)}>Review on Actions</button>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(run.outputs || []).length > 0 && (
        <div className="tagent__section">
          <p className="tagent__h">What NEURO produced <span className="tagent__meta">(private drafts — only you see these)</span></p>
          {run.outputs.map((o) => (
            <details className="tagent__out" key={o.id} open={run.outputs.length === 1} data-tagent-output={o.kind}>
              <summary><span className="tagent__badge">{o.kind}</span> {o.title}</summary>
              <pre className="tagent__md">{o.markdown}</pre>
            </details>
          ))}
        </div>
      )}

      {run.summary && ((run.summary.completed || []).length > 0 || (run.summary.remaining || []).length > 0 || run.summary.said) && (
        <div className="tagent__section">
          {(run.summary.completed || []).length > 0 && (<><p className="tagent__h">Done</p><ul className="tagent__bul">{run.summary.completed.map((s) => <li key={s}>{s}</li>)}</ul></>)}
          {(run.summary.remaining || []).length > 0 && (<><p className="tagent__h">Still to do</p><ul className="tagent__bul">{run.summary.remaining.map((s) => <li key={s}>{s}</li>)}</ul></>)}
          {run.summary.said && !(run.summary.completed || []).length && <p>{run.summary.said}</p>}
        </div>
      )}

      <details className="tagent__fold">
        <summary>Context used ({used.length}) and available ({available.length})</summary>
        {(run.sources || []).length === 0 && <p className="tagent__meta">No linked context — NEURO worked from the task itself{run.contextGaps && run.contextGaps.length ? ` (${run.contextGaps.join('; ')})` : ''}.</p>}
        <ul className="tagent__list">
          {[...used, ...available].map((s) => (
            <li key={s.key} data-tagent-source={s.key}>
              {s.path && onOpenNote
                ? <button type="button" className="tagent__link" onClick={() => onOpenNote(s)}>{s.title}</button>
                : <span className="tagent__title">{s.title}</span>}
              <span className="tagent__badge">{s.used ? 'used' : 'available'}</span>
              {s.restricted && <span className="tagent__badge">excerpt only</span>}
              <p className="tagent__meta">{s.provenance}</p>
            </li>
          ))}
        </ul>
      </details>

      {(run.steps || []).length > 0 && (
        <details className="tagent__fold">
          <summary>Steps ({run.steps.length})</summary>
          <ol className="tagent__bul">{run.steps.map((s, i) => <li key={`${s.at}-${i}`}>{s.say}</li>)}</ol>
        </details>
      )}

      {run.usage && <p className="tagent__meta tagent__usage">{money(run.usage)}</p>}
      {error && <p className="tagent__err" role="alert">{error}</p>}

      <div className="tagent__row">
        {(run.status === 'interrupted' || run.status === 'failed') && <button type="button" onClick={() => onStart(false)} disabled={busy}>Do this — continue</button>}
        {run.status !== 'running' && run.status !== 'stopped' && <button type="button" className="tagent__quiet" onClick={onStop} disabled={busy}>Stop</button>}
        {settled && <button type="button" className="tagent__quiet" onClick={() => onStart(true)} disabled={busy}>Start a fresh attempt</button>}
      </div>
    </div>
  );
}

export default function TaskAgent({ taskId, call, readOnly = false, onOpenActions = null, onOpenNote = null }) {
  const [run, setRun] = useState(undefined); // undefined = not loaded; null = no run yet
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const timer = useRef(null);

  const load = useCallback(async () => {
    const r = await call(`/api/task-agent/tasks/${enc(taskId)}`);
    if (r.status === 200 && r.body && r.body.ok) { setRun(r.body.run); setError(null); return r.body.run; }
    setError((r.body && r.body.error) || `Could not read the Do this workspace (${r.status}).`);
    setRun((cur) => (cur === undefined ? null : cur));
    return null;
  }, [call, taskId]);

  useEffect(() => { if (!readOnly) load(); }, [load, readOnly]);
  useEffect(() => {
    clearTimeout(timer.current);
    if (run && run.status === 'running') timer.current = setTimeout(load, POLL_MS);
    return () => clearTimeout(timer.current);
  }, [run, load]);

  if (readOnly) return null;
  if (run === undefined) return <div className="tagent tagent--loading"><p className="tagent__meta">Loading…</p></div>;

  const post = async (path, body) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const r = await call(path, { method: 'POST', body });
      if (r.status === 200 && r.body && r.body.ok) setRun(r.body.run);
      else setError((r.body && r.body.error) || `Refused (${r.status}).`);
    } catch (e) { setError(e.message || 'Request failed.'); } finally { setBusy(false); }
  };

  return (
    <TaskAgentView
      run={run}
      busy={busy}
      error={error}
      onStart={(fresh) => post(`/api/task-agent/tasks/${enc(taskId)}/start`, fresh ? { fresh: true } : {})}
      onAnswer={(a) => post(`/api/task-agent/tasks/${enc(taskId)}/answer`, a)}
      onStop={() => post(`/api/task-agent/tasks/${enc(taskId)}/stop`, {})}
      onOpenActions={onOpenActions}
      onOpenNote={onOpenNote}
    />
  );
}
