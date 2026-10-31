import { useCallback, useEffect, useRef, useState } from 'react';
import './TaskAgent.css';

// TaskAgent — the "Do this" workspace on ONE task (23 Oct 2026).
//
// The press means: NEURO, take this as far as it safely can. Everything shown
// here comes from /api/task-agent; the component decides nothing.
//
// `call(path, {method, body}) → {status, body}` is the shell's authenticated
// fetch (desktopCall on NEURO, the raw-status transport on the SAiM phone).
// `onOpenActions` takes Nick to the existing approval screen for a prepared
// email; `onOpenNote` opens a source note; `renderSave(recordId, onDone)` mounts
// the EXISTING prepared-move confirmation for a draft he chose to save — this
// component holds no confirmation of its own. `copyText` puts the Claude handoff
// prompt on the clipboard (defaults to navigator.clipboard).
//
// `readOnly` (the kiosk) renders NOTHING — Do this is Nick's own control (it
// spends his key). The server refuses the kiosk anyway; this only stops a dead
// control being drawn.
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
  blocked: 'Could not take this further',
  failed: 'Stopped — could not continue',
  interrupted: 'Interrupted — press Do this to continue',
  stopped: 'Stopped by you',
};
const KIND_SAY = { ambiguity: 'Which did you mean?', missing: 'NEURO needs one fact', manual: 'Only you can do this step', authority: 'Your decision' };
const SAVE_SAY = { waiting: 'Prepared to save — waiting for your confirmation. Nothing is saved yet.', saved: 'Saved to the vault (you confirmed it).', superseded: 'A newer version was prepared — open it from Drafts.', gone: 'The save proposal is no longer there.' };

function money(u) {
  if (!u) return null;
  const tok = `${(u.promptTokens || 0).toLocaleString()} in · ${(u.completionTokens || 0).toLocaleString()} out`;
  const cost = u.costUnknown ? 'cost not known for this model' : `about $${Number(u.costUsd || 0).toFixed(4)}`;
  return `${u.model} · ${tok} · ${cost}`;
}

const defaultCopy = async (t) => {
  try { if (typeof navigator !== 'undefined' && navigator.clipboard) { await navigator.clipboard.writeText(t); return true; } } catch { /* fall through */ }
  return false;
};

/** The Claude-desktop handoff: preview first, editable, nothing sent until the press. */
// The policy envelope, destination and context are FIXED by NEURO and shown read-only;
// only the working brief is editable, and the server composes the final prompt.
export function ClaudeHandoff({ preview, busy, error, result, copied = null, onIncludeDrafts, onSend }) {
  const [brief, setBrief] = useState(preview ? preview.brief : '');
  const [openOnDesk, setOpenOnDesk] = useState(false);
  useEffect(() => { setBrief(preview ? preview.brief : ''); }, [preview && preview.brief]);
  if (!preview) return <p className="tagent__meta">Preparing the handoff…</p>;
  return (
    <div className="tagent__claude" data-tagent-claude="preview">
      <p className="tagent__h">Continue this with Claude on desktop</p>
      {preview.why && <p><strong>Why Claude:</strong> {preview.why}</p>}
      {preview.destination && <p className="tagent__meta">Project: {preview.destination.project} ({preview.destination.folder})</p>}
      <p className="tagent__meta"><strong>Included:</strong> {preview.included.join('; ')}.</p>
      <p className="tagent__meta"><strong>Never included:</strong> {preview.excluded.join('; ')}.</p>
      <p className="tagent__statement">{preview.statement}</p>
      <label className="tagent__check"><input type="checkbox" checked={preview.includeDrafts} disabled={busy} onChange={(e) => onIncludeDrafts(e.target.checked)} /> Include my drafts in full</label>
      <p className="tagent__h">Fixed by NEURO — not editable</p>
      <pre className="tagent__fixed" data-tagent-envelope>{preview.envelope}</pre>
      <details className="tagent__fold"><summary>Destination and context (fixed)</summary><pre className="tagent__fixed">{preview.fixed}</pre></details>
      <p className="tagent__h">Your working brief (editable)</p>
      <textarea className="tagent__prompt" rows={10} value={brief} onChange={(e) => setBrief(e.target.value)} aria-label="Working brief (you can edit it)" />
      <label className="tagent__check"><input type="checkbox" checked={openOnDesk} onChange={(e) => setOpenOnDesk(e.target.checked)} /> Open Claude on my laptop, paste this and send it</label>
      <div className="tagent__row">
        <button type="button" className="tagent__go" disabled={busy || !brief.trim()} onClick={() => onSend({ brief, includeDrafts: preview.includeDrafts, openOnDesk })}>Continue this with Claude on desktop</button>
      </div>
      {error && <p className="tagent__err" role="alert">{error}</p>}
      {result && <p className="tagent__ok" role="status">{result}</p>}
      {copied && <details className="tagent__fold"><summary>The prompt that was copied</summary><pre className="tagent__fixed">{copied}</pre></details>}
    </div>
  );
}

/**
 * Claude's finished work coming back (31 Oct 2026): what has returned — shown here
 * and already saved into the task's draft note — and, folded away, a box to paste
 * an answer from a Claude chat that could not call return_task_result itself.
 */
export function ClaudeReturn({ results = [], onReturn = null, onOpenNote = null, busy = false, error = null, done = null, leading = null, inline = false, after = null }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  if (!results.length && !onReturn && !leading && !after) return null;
  const when = (at) => new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <div className={inline ? 'tagent__return' : 'tagent__section'} data-tagent-claude-return>
      {(leading || (onReturn && !open)) && (
        <div className="tagent__row">
          {leading}
          {onReturn && !open && <button type="button" className="tagent__quiet" onClick={() => setOpen(true)}>Paste Claude’s answer…</button>}
        </div>
      )}
      {results.map((o) => (
        <div key={o.id} className="tagent__returned">
          <details className="tagent__out" open={o === results[0]} data-tagent-output="claude">
            <summary><span className="tagent__badge">From Claude</span> {when(o.at)}</summary>
            <pre className="tagent__md">{o.markdown}</pre>
            <p className="tagent__meta" data-tagent-claude-saved>Saved to {o.notePath}{' '}
              {onOpenNote && <button type="button" className="tagent__link" onClick={() => onOpenNote({ path: o.notePath, title: o.notePath })}>Open</button>}
            </p>
          </details>
          {o === results[0] && after}
        </div>
      ))}
      {onReturn && open && (
        <form className="tagent__q" data-tagent-claude-paste onSubmit={async (e) => { e.preventDefault(); if (!text.trim()) return; const ok = await onReturn(text); if (ok) { setText(''); setOpen(false); } }}>
          <p className="tagent__h">Paste Claude’s answer</p>
          <p className="tagent__meta">For a Claude chat that could not send it back itself. NEURO shows it here and saves it into this task’s draft note.</p>
          <textarea className="tagent__answer" rows={8} value={text} onChange={(e) => setText(e.target.value)} aria-label="Claude’s answer" />
          <div className="tagent__row">
            <button type="submit" disabled={busy || !text.trim()}>Send to NEURO</button>
            <button type="button" className="tagent__quiet" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
      {error && <p className="tagent__err" role="alert">{error}</p>}
      {done && <p className="tagent__ok" role="status">{done}</p>}
    </div>
  );
}

/**
 * Next steps on Claude's returned work (31 Oct 2026). NEURO works the plan out
 * from the result (services/task-next-steps.js); this only draws it. One button
 * per step; an email or invite is prepared first, shown, then sent on "Send now"
 * (intent grant → execute-direct, the same one-press path as everywhere else).
 * `readOnly` draws the steps with no buttons.
 */
const STEP_DONE = (s) => Boolean(s.state && s.state.status === 'done');
const ACTION_SAY = { prepared: 'Prepared — not sent yet.', approved: 'Approved — sending…', executing: 'Sending…', executed: 'Sent — checking Sent Items…', verified: 'Sent — verified in Sent Items.', execution_uncertain: 'Outcome uncertain — not resent; NEURO will check.', failed: 'Not sent.', rejected: 'Withdrawn.', superseded: 'Replaced by a newer draft.', expired: 'Expired.' };

function ActionPreview({ action, kind }) {
  if (!action) return null;
  return (
    <div className="tagent__preview" data-tagent-step-action={action.status}>
      {kind === 'send' ? (
        <>
          <p className="tagent__meta"><strong>To:</strong> {(action.to || []).map((r) => (r.name ? `${r.name} <${r.email}>` : r.email)).join(', ')}</p>
          <p className="tagent__meta"><strong>Subject:</strong> {action.subject}</p>
          <pre className="tagent__md">{action.body}</pre>
          {(action.attachments || []).map((f) => <p className="tagent__meta" key={f.name} data-tagent-attachment>📎 {f.name}</p>)}
        </>
      ) : (
        <>
          <p className="tagent__meta"><strong>Invite:</strong> {action.subject} — {String(action.start || '').replace('T', ' ').slice(0, 16)}–{String(action.end || '').slice(11, 16)}</p>
          <p className="tagent__meta"><strong>With:</strong> {(action.to || []).map((r) => r.name || r.email).join(', ') || '—'}</p>
        </>
      )}
      <p className="tagent__meta" data-tagent-action-status>{ACTION_SAY[action.status] || action.status}</p>
    </div>
  );
}

function StepBody({ step, readOnly, busy, onAct, onSendNow, onOpenActions }) {
  const [to, setTo] = useState('');
  const [start, setStart] = useState((step.meeting && step.meeting.suggestedStart) || '');
  const [extra, setExtra] = useState('');
  const done = STEP_DONE(step);
  const b = (label, body, primary = true) => (readOnly || done ? null : <div className="tagent__row"><button type="button" className={primary ? '' : 'tagent__quiet'} disabled={busy} onClick={() => onAct(step, body)}>{label}</button></div>);

  if (step.kind === 'send') {
    const s = step.send || {};
    const a = s.action;
    if (a) {
      return (
        <>
          <ActionPreview action={a} kind="send" />
          {!readOnly && a.status === 'prepared' && (
            <div className="tagent__row">
              {s.sendingEnabled === false
                ? <p className="tagent__meta" data-tagent-sending-off>“Send approved emails” is off in Settings → Switches, so it can’t be sent from here yet — the draft is waiting in Actions.</p>
                : <button type="button" className="tagent__go" disabled={busy} onClick={() => onSendNow(step, a)}>Send now</button>}
              {onOpenActions && <button type="button" className="tagent__quiet" onClick={() => onOpenActions({ actionId: a.actionId })}>Open in Actions</button>}
            </div>
          )}
        </>
      );
    }
    return (
      <>
        <p className="tagent__meta">Covering email from your work address: “{s.subject}”, with 📎 {s.attachmentName}.</p>
        {s.to ? b(`Send to ${s.to.name ? s.to.name.split(' ')[0] : s.to.email}`, {}) : (
          <>
            {s.why && <p className="tagent__meta" data-tagent-step-why-disabled>{s.why}</p>}
            {!readOnly && !done && (
              <form className="tagent__row" onSubmit={(e) => { e.preventDefault(); if (to.trim()) onAct(step, { to: to.trim() }); }}>
                <input type="email" className="tagent__input" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com" aria-label="Send it to (email address)" />
                <button type="submit" disabled={busy || !to.trim()}>Prepare the email</button>
              </form>
            )}
          </>
        )}
      </>
    );
  }
  if (step.kind === 'follow-up-task') {
    const f = step.followUp || {};
    return (
      <>
        <p className="tagent__meta">New task: “{f.text}”{f.due ? `, due ${f.due}` : ''}.</p>
        {f.already && !done && <p className="tagent__meta" data-tagent-already>Already on your list: #{f.already.id} — {f.already.text}</p>}
        {b(f.already ? `Use #${f.already.id}` : 'Add it to your tasks', {})}
      </>
    );
  }
  if (step.kind === 'meeting') {
    const m = step.meeting || {};
    if (m.action) {
      return (
        <>
          <ActionPreview action={m.action} kind="meeting" />
          {!readOnly && m.action.status === 'prepared' && (
            <div className="tagent__row">
              {m.calendarEnabled === false
                ? <p className="tagent__meta">“Send approved calendar changes” is off in Settings → Switches — the invite is waiting in Actions.</p>
                : <button type="button" className="tagent__go" disabled={busy} onClick={() => onSendNow(step, m.action)}>Send invite</button>}
              {onOpenActions && <button type="button" className="tagent__quiet" onClick={() => onOpenActions({ actionId: m.action.actionId })}>Open in Actions</button>}
            </div>
          )}
        </>
      );
    }
    return (
      <>
        <p className="tagent__meta">“{m.subject}”, {m.minutes} minutes{(m.attendees || []).length ? ` with ${m.attendees.map((x) => x.name).join(', ')}` : ''}.</p>
        {(m.unresolved || []).map((u) => <p className="tagent__meta" key={u.name}>{u.why}</p>)}
        {!readOnly && !done && (
          <form className="tagent__row" onSubmit={(e) => { e.preventDefault(); onAct(step, { start, ...(extra.trim() ? { attendees: extra.split(/[,;\s]+/).filter(Boolean) } : {}) }); }}>
            <input type="datetime-local" className="tagent__input" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start" />
            {(m.unresolved || []).length > 0 && <input type="text" className="tagent__input" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="their email address(es)" aria-label="Other attendees' email addresses" />}
            <button type="submit" disabled={busy || !start}>Prepare the invite</button>
          </form>
        )}
      </>
    );
  }
  if (step.kind === 'discuss-with-chris') return (<><p className="tagent__meta">“{(step.discuss || {}).text}”</p>{b('Add to the Chris list', {})}</>);
  if (step.kind === 'complete') return b('Mark the task done', {});
  if (step.kind === 'drop-time') return b('Drop it', {});
  return b('Done', {}, false);
}

export function NextSteps({ nextSteps, readOnly = false, busy = false, error = null, outcome = null, onAct, onSendNow, onRethink = null, onOpenActions = null }) {
  if (!nextSteps) return null;
  if (nextSteps.thinking) return <div className="tagent__steps" data-tagent-next-steps="thinking"><p className="tagent__h">Next steps</p><p className="tagent__meta">Working out the next steps from Claude’s result…</p></div>;
  const steps = nextSteps.steps || [];
  return (
    <div className="tagent__steps" data-tagent-next-steps={nextSteps.source || 'model'}>
      <div className="tagent__row tagent__steps-head">
        <p className="tagent__h">{nextSteps.label || 'Next steps'}</p>
        {!readOnly && onRethink && <button type="button" className="tagent__quiet" disabled={busy} onClick={onRethink}>Rethink</button>}
      </div>
      {nextSteps.error && <p className="tagent__err">{nextSteps.error}</p>}
      <ol className="tagent__steplist">
        {steps.map((s, i) => (
          <li key={s.id} className={`tagent__step${STEP_DONE(s) ? ' tagent__step--done' : ''}`} data-tagent-step={s.kind}>
            <p className="tagent__steptitle"><span className="tagent__stepnum">{STEP_DONE(s) ? '✓' : i + 1}</span> {s.title}</p>
            {s.why && <p className="tagent__meta tagent__stepwhy">{s.why}</p>}
            {s.state && s.state.say && <p className={STEP_DONE(s) ? 'tagent__ok' : 'tagent__meta'} data-tagent-step-state={s.state.status}>{s.state.say}</p>}
            <StepBody step={s} readOnly={readOnly} busy={busy} onAct={onAct} onSendNow={onSendNow} onOpenActions={onOpenActions} />
            {outcome && outcome.stepId === s.id && <p className={outcome.tone === 'ok' ? 'tagent__ok' : 'tagent__err'} role="status">{outcome.text}</p>}
          </li>
        ))}
      </ol>
      {error && <p className="tagent__err" role="alert">{error}</p>}
    </div>
  );
}

/** The one question NEURO needs: choices, plus an "Other — explain" field. */
function NeedBlock({ need, busy, onAnswer }) {
  const [text, setText] = useState('');
  const [other, setOther] = useState(false);
  useEffect(() => { setText(''); setOther(false); }, [need.id]);
  const manual = need.kind === 'manual';
  const hasOptions = need.options && need.options.length > 0;
  const showText = manual || !hasOptions || other;
  return (
    <form className="tagent__q" data-tagent-question={need.kind} onSubmit={(e) => { e.preventDefault(); if (text.trim()) onAnswer({ questionId: need.id, text }); }}>
      <p className="tagent__h">What I need from you</p>
      <p className="tagent__qtext">{need.question}</p>
      {need.changed && <p className="tagent__qwhy" data-tagent-changed>Asked again because: {need.changed}</p>}
      {need.why && <p className="tagent__qwhy">{need.why}</p>}
      {need.after && <p className="tagent__qafter">{need.after}</p>}
      {hasOptions && (
        <div className="tagent__opts">
          {need.options.map((o) => <button type="button" key={o} disabled={busy} onClick={() => onAnswer({ questionId: need.id, text: o })}>{o}</button>)}
          {!other && <button type="button" className="tagent__quiet" disabled={busy} onClick={() => setOther(true)}>Other — explain</button>}
        </div>
      )}
      {showText && (
        <textarea className="tagent__answer" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={manual ? 'Anything NEURO should know (optional)' : hasOptions ? 'Explain your answer' : 'Your answer'} aria-label="Your answer" />
      )}
      <div className="tagent__row">
        {manual
          ? <button type="button" disabled={busy} onClick={() => onAnswer({ questionId: need.id, text, manualDone: true })}>I’ve done it — carry on</button>
          : showText && <button type="submit" disabled={busy || !text.trim()}>Tell NEURO</button>}
      </div>
    </form>
  );
}

export function TaskAgentView({ run, workspace = null, budget = null, busy, error, onStart, onAnswer, onStop, onContinue = null, onOpenActions, onOpenNote, onSave = null, saving = null, renderSave = null, onCopy = null, claude = null, onClaudeOpen = null, onClaudeClose = null, claudeReturn = null }) {
  const [openOut, setOpenOut] = useState(null);
  const outRefs = useRef({});

  if (!run) {
    return (
      <div className="tagent tagent--idle" data-tagent="idle">
        <button type="button" className="tagent__go" onClick={() => onStart(false)} disabled={busy}>{busy ? 'Starting…' : 'Do this'}</button>
        {budget && (budget.enabled === false || budget.configured === false) && (
          <p className="tagent__meta" data-tagent-off>Do this is switched off. Nick turns it on in NEURO → Settings → AI &amp; SAiM → Anthropic.</p>
        )}
        <p className="tagent__hint">NEURO works on this as far as it safely can — drafts, plans, research — and asks you only when it must. It sends, books and changes nothing without your confirmation.</p>
        {error && <p className="tagent__err" role="alert">{error}</p>}
        {claudeReturn && <ClaudeReturn {...claudeReturn} onOpenNote={onOpenNote} />}
      </div>
    );
  }

  const ws = workspace || { status: { state: run.status, label: STATUS_SAY[run.status] || run.status, phase: null, wont: '', enough: null }, done: [], need: run.question ? { ...run.question, allowOther: true } : null, trace: { summary: `${(run.steps || []).length} internal steps` } };
  const used = (run.sources || []).filter((s) => s.used);
  const available = (run.sources || []).filter((s) => !s.used);
  const settled = ['ready', 'blocked', 'stopped', 'failed', 'interrupted'].includes(run.status);
  const canHandOff = run.status !== 'running';
  const handoffs = run.claudeHandoffs || [];
  const openDraft = (id) => {
    setOpenOut(id);
    setTimeout(() => { const el = outRefs.current[id]; if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 0);
  };

  return (
    <div className={`tagent tagent--${run.status}`} data-tagent={run.status}>
      {/* 1. Status — one line, and what NEURO will and won't do. Fixed height: no jump as the phase changes. */}
      <div className="tagent__statusblock" data-tagent-state={ws.status.state}>
        <p className="tagent__h">Status</p>
        <p className="tagent__statusline" data-tagent-status={run.status}>
          {ws.status.label}{ws.status.phase && <span className="tagent__phase" data-tagent-phase> · {ws.status.phase}…</span>}
        </p>
        {ws.status.enough && <p className="tagent__meta" data-tagent-enough>{ws.status.enough}</p>}
        <p className="tagent__wont">{ws.status.wont}</p>
        {run.error && <p className="tagent__err" role="alert">{run.error}</p>}
      </div>

      {/* 2. What NEURO has done — at most three lines. */}
      {ws.done.length > 0 && (
        <div className="tagent__section" data-tagent-done>
          <p className="tagent__h">What NEURO has done</p>
          <ul className="tagent__bul">
            {ws.done.map((d) => (
              <li key={d.say}>{d.say}{' '}
                {d.open && d.open.outputId && <button type="button" className="tagent__link" onClick={() => openDraft(d.open.outputId)}>{d.open.label}</button>}
                {d.open && d.open.actions && onOpenActions && <button type="button" className="tagent__link" onClick={() => onOpenActions((run.handoffs || [])[0])}>{d.open.label}</button>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 3. What I need from you — one question, or nothing. */}
      {ws.need && <NeedBlock need={ws.need} busy={busy} onAnswer={onAnswer} />}

      {/* Nothing to answer, but the work is with Nick now: exactly what is left. */}
      {!ws.need && !ws.continue && ws.next && (
        <div className="tagent__section tagent__next" data-tagent-next-for-you>
          <p className="tagent__h">What I need from you</p>
          <p className="tagent__nextq">Nothing to decide. Next for you:</p>
          <ul className="tagent__bul">{ws.next.items.map((x) => <li key={x}>{x}</li>)}</ul>
          {ws.next.more > 0 && <p className="tagent__meta">and {ws.next.more} more in Activity and evidence.</p>}
        </div>
      )}

      {/* Paused at a per-attempt limit: what was done, what remains, and ONE explicit control. */}
      {ws.continue && (
        <div className="tagent__q tagent__cont" data-tagent-continue>
          <p className="tagent__h">What I need from you</p>
          <p className="tagent__qtext">Continue working on this?</p>
          <p className="tagent__qwhy">{ws.continue.say}</p>
          {(ws.continue.completed || []).length > 0 && <p className="tagent__meta"><strong>Done:</strong> {ws.continue.completed.join(' ')}</p>}
          {(ws.continue.remaining || []).length > 0 && <p className="tagent__meta"><strong>Remaining:</strong> {ws.continue.remaining.join(' ')}</p>}
          <p className="tagent__qafter">{ws.continue.cost}</p>
          {onContinue && <div className="tagent__row"><button type="button" className="tagent__go" disabled={busy} onClick={onContinue}>{ws.continue.label}</button></div>}
        </div>
      )}

      {(run.outputs || []).length > 0 && (
        <div className="tagent__section">
          <p className="tagent__h">Drafts <span className="tagent__meta">(private — only you see these)</span></p>
          {run.outputs.map((o) => (
            // Closed unless Nick opens it (or is saving it — a confirmation must not sit inside a closed fold).
            <details className="tagent__out" key={o.id} ref={(el) => { outRefs.current[o.id] = el; }} open={openOut === o.id || saving === o.id}
              onToggle={(e) => { if (e.currentTarget.open) setOpenOut(o.id); else if (openOut === o.id) setOpenOut(null); }} data-tagent-output={o.kind}>
              <summary><span className="tagent__badge">{o.kind}</span> {o.title}</summary>
              <pre className="tagent__md">{o.markdown}</pre>
              <div className="tagent__row" data-tagent-next={o.id}>
                {o.next && o.next.canSave && onSave && !(o.save && o.save.status === 'saved') && (
                  <button type="button" disabled={busy || saving === o.id} onClick={() => onSave(o)}>{o.save && o.save.status === 'waiting' ? 'Open the save confirmation' : 'Save to vault…'}</button>
                )}
                {onCopy && <button type="button" className="tagent__quiet" onClick={() => onCopy(o.markdown)}>Copy</button>}
              </div>
              {o.next && !o.next.canSave && o.next.why && <p className="tagent__meta">{o.next.why}</p>}
              {o.save && <p className="tagent__meta" data-tagent-save={o.save.status}>{SAVE_SAY[o.save.status] || o.save.status}</p>}
              {saving === o.id && o.save && o.save.status === 'waiting' && renderSave && (
                <div className="tagent__save">{renderSave(o.save.recordId)}</div>
              )}
            </details>
          ))}
        </div>
      )}

      {(run.handoffs || []).length > 0 && (
        <div className="tagent__section">
          <p className="tagent__h">Waiting for your approval</p>
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

      {canHandOff && onClaudeOpen ? (
        <div className="tagent__section tagent__panel" data-tagent-claude-offer={run.claude && run.claude.recommended ? 'recommended' : 'available'}>
          <p className="tagent__h">Claude on desktop</p>
          {run.claude && run.claude.recommended && <p className="tagent__note"><strong>Better with Claude on desktop:</strong> {run.claude.why}</p>}
          {claude && (
            <>
              <ClaudeHandoff {...claude} />
              <div className="tagent__row"><button type="button" className="tagent__quiet" onClick={onClaudeClose}>Close the handoff</button></div>
            </>
          )}
          {handoffs.length > 0 && (
            <ul className="tagent__list tagent__handed">
              {handoffs.map((h) => <li key={h.id} data-tagent-claude-handoff={h.status} className="tagent__meta">Handed to Claude {new Date(h.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} — prompt copied{h.desk ? `; laptop: ${h.desk.status}` : ''}.</li>)}
            </ul>
          )}
          <ClaudeReturn {...(claudeReturn || {})} inline onOpenNote={onOpenNote}
            leading={!claude ? <button type="button" className={run.claude && run.claude.recommended ? '' : 'tagent__quiet'} onClick={onClaudeOpen}>Hand off to Claude on desktop…</button> : null} />
        </div>
      ) : (claudeReturn && <ClaudeReturn {...claudeReturn} onOpenNote={onOpenNote} />)}

      {/* The trace — closed by default; the full record stays for audit. */}
      <details className="tagent__fold tagent__trace" data-tagent-trace>
        <summary>Activity and evidence · {ws.trace.summary}</summary>
        {run.understanding && <p className="tagent__meta"><strong>Understood as:</strong> {run.understanding}</p>}
        {run.summary && (run.summary.completed || []).length > 0 && <><p className="tagent__h">Reported done</p><ul className="tagent__bul">{run.summary.completed.map((x) => <li key={x}>{x}</li>)}</ul></>}
        {run.summary && (run.summary.remaining || []).length > 0 && <><p className="tagent__h">Reported still to do</p><ul className="tagent__bul">{run.summary.remaining.map((x) => <li key={x}>{x}</li>)}</ul></>}
        {run.summary && run.summary.said && !(run.summary.completed || []).length && <p className="tagent__meta">{run.summary.said}</p>}
        <p className="tagent__h">Sources ({used.length} used, {available.length} available)</p>
        {(run.sources || []).length === 0 && <p className="tagent__meta">No linked context — NEURO worked from the task itself{run.contextGaps && run.contextGaps.length ? ` (${run.contextGaps.join('; ')})` : ''}.</p>}
        <ul className="tagent__list">
          {[...used, ...available].map((s) => (
            <li key={s.key} data-tagent-source={s.key}>
              {s.path && onOpenNote
                ? <button type="button" className="tagent__link" onClick={() => onOpenNote(s)}>{s.title}</button>
                : <span className="tagent__title">{s.title}</span>}
              <span className="tagent__badge">{s.used ? 'used' : 'available'}</span>
              <p className="tagent__meta">{s.provenance}</p>
            </li>
          ))}
        </ul>
        {(run.steps || []).length > 0 && (<><p className="tagent__h">Steps</p><ol className="tagent__bul tagent__steps">{run.steps.map((x, i) => <li key={`${x.at}-${i}`}>{x.say}</li>)}</ol></>)}
        {run.usage && <p className="tagent__meta tagent__usage">{money(run.usage)}</p>}
        {budget && <p className="tagent__meta tagent__budget">{budget.say}</p>}
      </details>

      {error && <p className="tagent__err" role="alert">{error}</p>}

      <div className="tagent__row tagent__footer">
        {(run.status === 'interrupted' || run.status === 'failed') && <button type="button" onClick={() => onStart(false)} disabled={busy}>Do this — continue</button>}
        {run.status !== 'running' && run.status !== 'stopped' && <button type="button" className="tagent__quiet" onClick={onStop} disabled={busy}>Stop</button>}
        {settled && <button type="button" className="tagent__quiet" onClick={() => onStart(true)} disabled={busy}>Start a fresh attempt</button>}
      </div>
      <p className="tagent__meta">The task stays open until you tick it — NEURO never closes it.</p>
    </div>
  );
}

export default function TaskAgent({ taskId, call, readOnly = false, onOpenActions = null, onOpenNote = null, renderSave = null, copyText = defaultCopy }) {
  const [run, setRun] = useState(undefined); // undefined = not loaded; null = no run yet
  const [workspace, setWorkspace] = useState(null);
  const [budget, setBudget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(null);
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [claude, setClaude] = useState({ preview: null, busy: false, error: null, result: null });
  const [claudeResults, setClaudeResults] = useState([]);
  const [ret, setRet] = useState({ busy: false, error: null, done: null });
  const [nextSteps, setNextSteps] = useState(null);
  const [steps, setSteps] = useState({ busy: false, error: null, outcome: null });
  const timer = useRef(null);
  const stepTimer = useRef(null);
  const session = useRef(null);

  const absorb = (body) => { if (body && 'run' in body) { setRun(body.run); setWorkspace(body.workspace || null); } if (body && body.budget) setBudget(body.budget); if (body && Array.isArray(body.claudeResults)) setClaudeResults(body.claudeResults); if (body && 'nextSteps' in body) setNextSteps(body.nextSteps || null); };

  const load = useCallback(async () => {
    const r = await call(`/api/task-agent/tasks/${enc(taskId)}`);
    if (r.status === 200 && r.body && r.body.ok) { absorb(r.body); setError(null); return r.body.run; }
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
  // NEURO is still working out the next steps from Claude's result: look again shortly.
  useEffect(() => {
    clearTimeout(stepTimer.current);
    if (nextSteps && nextSteps.thinking) stepTimer.current = setTimeout(load, POLL_MS);
    return () => clearTimeout(stepTimer.current);
  }, [nextSteps, load]);

  const loadPreview = useCallback(async (includeDrafts = true) => {
    setClaude((c) => ({ ...c, busy: true, error: null }));
    const r = await call(`/api/task-agent/tasks/${enc(taskId)}/handoff/preview?includeDrafts=${includeDrafts ? 1 : 0}`);
    if (r.status === 200 && r.body && r.body.ok) setClaude((c) => ({ ...c, preview: r.body, busy: false }));
    else setClaude((c) => ({ ...c, busy: false, error: (r.body && r.body.error) || `Could not prepare the handoff (${r.status}).` }));
  }, [call, taskId]);

  if (readOnly) return null;
  if (run === undefined) return <div className="tagent tagent--loading"><p className="tagent__meta">Loading…</p></div>;

  const post = async (path, body) => {
    if (busy) return null;
    setBusy(true); setError(null);
    try {
      const r = await call(path, { method: 'POST', body });
      if (r.status === 200 && r.body && r.body.ok) { absorb(r.body); return r.body; }
      setError((r.body && r.body.error) || `Refused (${r.status}).`);
      return null;
    } catch (e) { setError(e.message || 'Request failed.'); return null; } finally { setBusy(false); }
  };

  const sendHandoff = async ({ brief, includeDrafts, openOnDesk }) => {
    setClaude((c) => ({ ...c, busy: true, error: null, result: null, copied: null }));
    const r = await call(`/api/task-agent/tasks/${enc(taskId)}/handoff`, { method: 'POST', body: { brief, includeDrafts, openOnDesk } });
    if (r.status === 200 && r.body && r.body.ok) {
      absorb(r.body);
      const copied = await copyText(r.body.prompt);
      const desk = r.body.handoff && r.body.handoff.desk;
      const result = openOnDesk && desk && desk.status === 'requested'
        ? 'Sent to your laptop — it will open a new Claude chat, paste the prompt and send it. The prompt is also copied, in case it can’t.'
        : openOnDesk && desk
          ? `Your laptop wasn’t asked (${desk.why || desk.status}). ${copied ? 'The prompt is copied — paste it into Claude yourself.' : 'Copy the prompt below into Claude yourself.'}`
          : copied ? 'Copied — paste it into Claude on your desktop.' : 'Ready — copy the prompt below into Claude on your desktop (this device would not let NEURO copy it).';
      setClaude((c) => ({ ...c, busy: false, copied: r.body.prompt, result }));
    } else {
      setClaude((c) => ({ ...c, busy: false, error: (r.body && r.body.error) || `Not handed off (${r.status}).` }));
    }
  };

  const returnClaude = async (markdown) => {
    setRet({ busy: true, error: null, done: null });
    try {
      const r = await call(`/api/task-agent/tasks/${enc(taskId)}/claude-result`, { method: 'POST', body: { markdown } });
      if (r.status === 200 && r.body && r.body.ok) {
        setRet({ busy: false, error: null, done: r.body.already ? `NEURO already had this — nothing added. It is in ${r.body.notePath}.` : `Saved into ${r.body.notePath}.` });
        await load();
        return true;
      }
      setRet({ busy: false, error: (r.body && r.body.error) || `Not saved (${r.status}).`, done: null });
    } catch (e) { setRet({ busy: false, error: e.message || 'Request failed.', done: null }); }
    return false;
  };

  const sessionId = () => {
    if (session.current) return session.current;
    let v = '';
    try { const b = new Uint8Array(12); crypto.getRandomValues(b); v = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); } catch { v = `s${Date.now()}${Math.floor(Math.random() * 1e6)}`; }
    session.current = v;
    return v;
  };
  const actStep = async (step, body) => {
    if (steps.busy) return;
    setSteps({ busy: true, error: null, outcome: null });
    try {
      const r = await call(`/api/task-agent/tasks/${enc(taskId)}/next-steps/${enc(step.id)}`, { method: 'POST', body: body || {} });
      if (r.status === 200 && r.body && r.body.ok) {
        if (r.body.nextSteps) setNextSteps(r.body.nextSteps);
        const say = r.body.recurred && r.body.recurred.notice ? r.body.recurred.notice : null;
        setSteps({ busy: false, error: null, outcome: say ? { stepId: step.id, tone: 'ok', text: say } : null });
        if (step.kind === 'complete') await load();
        return;
      }
      setSteps({ busy: false, error: null, outcome: { stepId: step.id, tone: 'bad', text: (r.body && r.body.error) || `Refused (${r.status}).` } });
    } catch (e) { setSteps({ busy: false, error: e.message || 'Request failed.', outcome: null }); }
  };
  const sendNow = async (step, action) => {
    if (steps.busy) return;
    setSteps({ busy: true, error: null, outcome: null });
    const fail = (text) => setSteps({ busy: false, error: null, outcome: { stepId: step.id, tone: 'bad', text } });
    try {
      const id = enc(action.actionId);
      const g = await call(`/api/prepared-actions/${id}/intent-grant`, { method: 'POST', body: { version: action.version || 1, payloadHash: action.payloadHash, surface: 'neuro-web', sessionId: sessionId() } });
      if (!(g.status === 200 && g.body && g.body.ok)) { await load(); return fail((g.body && g.body.needsConfirm) ? 'It changed since it was shown — check it and press again.' : ((g.body && g.body.error) || `Not sent (${g.status}).`)); }
      const x = await call(`/api/prepared-actions/${id}/execute-direct`, { method: 'POST', body: { grantId: g.body.grantId, payloadHash: action.payloadHash } });
      if (!(x.status === 200 && x.body && x.body.ok)) { await load(); return fail((x.body && x.body.error) || `Not sent (${x.status}).`); }
      const st = x.body.status;
      const where = action.actionType === 'create_calendar_event' ? 'your calendar' : 'Sent Items';
      const text = st === 'verified' ? `Sent — verified in ${where}.` : st === 'executed' ? `Sent — confirming it in ${where} now.` : st === 'execution_uncertain' ? 'Outcome uncertain — not resent. NEURO will check and say what happened.' : `Not sent (${st || 'unknown'}). ${x.body.detail || ''}`.trim();
      setSteps({ busy: false, error: null, outcome: { stepId: step.id, tone: ['verified', 'executed'].includes(st) ? 'ok' : 'bad', text } });
      await load();
    } catch (e) { fail(e.message || 'Request failed.'); }
  };
  const rethink = async () => {
    if (steps.busy) return;
    setSteps({ busy: true, error: null, outcome: null });
    try {
      const r = await call(`/api/task-agent/tasks/${enc(taskId)}/next-steps/rethink`, { method: 'POST', body: {} });
      if (r.status === 200 && r.body && r.body.ok) { setNextSteps(r.body.nextSteps || null); setSteps({ busy: false, error: null, outcome: null }); return; }
      setSteps({ busy: false, error: (r.body && r.body.error) || `Refused (${r.status}).`, outcome: null });
    } catch (e) { setSteps({ busy: false, error: e.message || 'Request failed.', outcome: null }); }
  };
  const stepsNode = nextSteps ? (
    <NextSteps nextSteps={nextSteps} busy={steps.busy} error={steps.error} outcome={steps.outcome}
      onAct={actStep} onSendNow={sendNow} onRethink={rethink} onOpenActions={onOpenActions} />
  ) : null;

  return (
    <TaskAgentView
      run={run}
      claudeReturn={{ results: claudeResults, onReturn: returnClaude, after: stepsNode, ...ret }}
      workspace={workspace}
      budget={budget}
      busy={busy}
      error={error}
      onStart={(fresh) => post(`/api/task-agent/tasks/${enc(taskId)}/start`, fresh ? { fresh: true } : {})}
      onAnswer={(a) => post(`/api/task-agent/tasks/${enc(taskId)}/answer`, a)}
      onStop={() => post(`/api/task-agent/tasks/${enc(taskId)}/stop`, {})}
      onContinue={() => post(`/api/task-agent/tasks/${enc(taskId)}/continue`, {})}
      onOpenActions={onOpenActions}
      onOpenNote={onOpenNote}
      onSave={async (o) => { const b = await post(`/api/task-agent/tasks/${enc(taskId)}/outputs/${enc(o.id)}/save`, {}); if (b) setSaving(o.id); }}
      saving={saving}
      renderSave={renderSave ? (recordId) => renderSave(recordId, () => { setSaving(null); load(); }) : null}
      onCopy={(t) => copyText(t)}
      claude={claudeOpen ? { ...claude, onIncludeDrafts: (v) => loadPreview(v), onSend: sendHandoff } : null}
      onClaudeOpen={() => { setClaudeOpen(true); loadPreview(true); }}
      onClaudeClose={() => { setClaudeOpen(false); setClaude({ preview: null, busy: false, error: null, result: null }); }}
    />
  );
}
