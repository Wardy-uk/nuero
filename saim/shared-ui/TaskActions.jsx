import { useState } from 'react';
import { outcomeLine, outcomeTone, undoRepeat, jiraHint } from './completeTask.mjs';
import { startTaskSession } from './startTask.mjs';
import { ParkedNote } from './NotToday.jsx';
import './NotToday.css';

// The small shared pieces every task row uses (7 Nov 2026, audit F1/F6/F15):
//   TickOutcome — what a tick actually did (repeated / rolled / held / refused / warning), in words
//   StartFocus  — ONE "Start" button: switches straight away and offers "Resume it"
//   JiraHint    — "NT-x closes this one" before the tick is refused

/** The line under a row after its tick. Nothing for a plain done. */
export function TickOutcome({ outcome, call = null, onUndone = null, onDismiss = null, className = '' }) {
  const [undo, setUndo] = useState(null); // null | 'busy' | 'done' | error
  const line = outcomeLine(outcome);
  if (!line) return null;
  const tone = outcomeTone(outcome);
  const canUndo = call && outcome.kind === 'repeated' && outcome.taskId != null && undo !== 'done';
  const runUndo = async (e) => {
    e.stopPropagation();
    setUndo('busy');
    const r = await undoRepeat(call, outcome.taskId);
    if (r.ok) { setUndo('done'); onUndone?.(outcome); } else setUndo(r.error);
  };
  return (
    <p className={`tick-out tick-out--${tone} ${className}`.trim()} role="status" onClick={(e) => e.stopPropagation()}>
      {undo === 'done' ? 'Undone — it is back as it was.' : line}
      {canUndo && <button type="button" className="tick-out__btn" disabled={undo === 'busy'} onClick={runUndo}>{undo === 'busy' ? 'Undoing…' : 'Undo'}</button>}
      {onDismiss && <button type="button" className="tick-out__btn" onClick={(e) => { e.stopPropagation(); onDismiss(); }}>OK</button>}
      {undo && !['busy', 'done'].includes(undo) && <span> Not undone: {undo}</span>}
    </p>
  );
}

/** "NT-x closes this one…" — shown wherever a Jira-linked task is drawn. */
export function JiraHint({ item, className = 'tick-out tick-out--info' }) {
  const h = jiraHint(item);
  return h ? <p className={className}>{h}</p> : null;
}

/**
 * ONE Start button. Starts a focus session on the task; a session already
 * running is parked (no question) and "Resume it" is offered in place.
 */
export function StartFocus({ call, taskId = null, text = '', minutes = null, source = 'manual', label = 'Start', className = 'ntd__btn ntd__go', onStarted = null, noteClass = 'ntd__ok' }) {
  const [state, setState] = useState(null); // null | 'busy' | { ok, parked, already } | { error }
  if (!call) return null;
  const go = async (e) => {
    e?.stopPropagation?.();
    if (state === 'busy') return;
    setState('busy');
    const r = await startTaskSession(call, { taskId, text, minutes, source });
    setState(r.ok ? r : { error: r.error });
    if (r.ok) onStarted?.(r);
  };
  return (
    <span className="ntd__closed" onClick={(e) => e.stopPropagation()}>
      <button type="button" className={className} disabled={state === 'busy'} onClick={go}>{state === 'busy' ? 'Starting…' : label}</button>
      {state && state.ok && <span className={noteClass}>{state.already ? 'Already in focus.' : 'Focus session running.'}</span>}
      {state && state.ok && state.parked && <ParkedNote parked={state.parked} call={call} />}
      {state && state.error && <span className="ntd__err">Couldn’t start: {state.error}</span>}
    </span>
  );
}
