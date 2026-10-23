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
// `readOnly` (the kiosk) renders NOTHING — no control and no working output,
// because the output can quote a restricted excerpt. The server refuses the
// kiosk anyway; this only stops a dead control being drawn.
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
      {!preview.sensitive && (
        <label className="tagent__check"><input type="checkbox" checked={preview.includeDrafts} disabled={busy} onChange={(e) => onIncludeDrafts(e.target.checked)} /> Include my drafts in full</label>
      )}
      <p className="tagent__h">Fixed by NEURO — not editable</p>
      <pre className="tagent__fixed" data-tagent-envelope>{preview.envelope}</pre>
      <details className="tagent__fold"><summary>Destination and context (fixed)</summary><pre className="tagent__fixed">{preview.fixed}</pre></details>
      <p className="tagent__h">Your working brief (editable)</p>
      <textarea className="tagent__prompt" rows={10} value={brief} onChange={(e) => setBrief(e.target.value)} aria-label="Working brief (you can edit it)" />
      <label className="tagent__check"><input type="checkbox" checked={openOnDesk} onChange={(e) => setOpenOnDesk(e.target.checked)} /> Also open Claude on my laptop</label>
      <div className="tagent__row">
        <button type="button" className="tagent__go" disabled={busy || !brief.trim()} onClick={() => onSend({ brief, includeDrafts: preview.includeDrafts, openOnDesk })}>Continue this with Claude on desktop</button>
      </div>
      {error && <p className="tagent__err" role="alert">{error}</p>}
      {result && <p className="tagent__ok" role="status">{result}</p>}
      {copied && <details className="tagent__fold"><summary>The prompt that was copied</summary><pre className="tagent__fixed">{copied}</pre></details>}
    </div>
  );
}

export function TaskAgentView({ run, budget = null, busy, error, onStart, onAnswer, onStop, onOpenActions, onOpenNote, onSave = null, saving = null, renderSave = null, onCopy = null, claude = null, onClaudeOpen = null, onClaudeClose = null }) {
  const [text, setText] = useState('');
  const q = run && run.question;
  useEffect(() => { setText(''); }, [q && q.id]);

  if (!run) {
    return (
      <div className="tagent tagent--idle" data-tagent="idle">
        <button type="button" className="tagent__go" onClick={() => onStart(false)} disabled={busy}>{busy ? 'Starting…' : 'Do this'}</button>
        {budget && (budget.enabled === false || budget.configured === false) && (
          <p className="tagent__meta" data-tagent-off>Do this is switched off. Nick turns it on in NEURO → Settings → AI &amp; SAiM → Anthropic.</p>
        )}
        <p className="tagent__hint">NEURO works on this as far as it safely can — drafts, plans, research — and asks you only when it must. It sends, books and changes nothing without your confirmation.</p>
        {budget && <p className="tagent__meta tagent__budget">{budget.say}</p>}
        {error && <p className="tagent__err" role="alert">{error}</p>}
      </div>
    );
  }

  const used = (run.sources || []).filter((s) => s.used);
  const available = (run.sources || []).filter((s) => !s.used);
  const settled = ['ready', 'blocked', 'stopped', 'failed', 'interrupted'].includes(run.status);
  const canHandOff = run.status !== 'running';
  const handoffs = run.claudeHandoffs || [];

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
      {run.status === 'blocked' && <p className="tagent__note">NEURO finished without anything it could safely keep or prepare. What it found is below — the reason is the evidence.</p>}

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
            // An output being saved stays OPEN, or the confirmation would sit inside a collapsed fold.
            <details className="tagent__out" key={o.id} open={run.outputs.length === 1 || saving === o.id} data-tagent-output={o.kind}>
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
          <p className="tagent__meta">The task stays open until you tick it — NEURO never closes it.</p>
        </div>
      )}

      {run.summary && ((run.summary.completed || []).length > 0 || (run.summary.remaining || []).length > 0 || run.summary.said) && (
        <div className="tagent__section">
          {(run.summary.completed || []).length > 0 && (<><p className="tagent__h">Done</p><ul className="tagent__bul">{run.summary.completed.map((s) => <li key={s}>{s}</li>)}</ul></>)}
          {(run.summary.remaining || []).length > 0 && (<><p className="tagent__h">Still to do</p><ul className="tagent__bul">{run.summary.remaining.map((s) => <li key={s}>{s}</li>)}</ul></>)}
          {run.summary.said && !(run.summary.completed || []).length && <p>{run.summary.said}</p>}
        </div>
      )}

      {canHandOff && onClaudeOpen && (
        <div className="tagent__section" data-tagent-claude-offer={run.claude && run.claude.recommended ? 'recommended' : 'available'}>
          {run.claude && run.claude.recommended && <p className="tagent__note"><strong>Better with Claude on desktop:</strong> {run.claude.why}</p>}
          {!claude && <button type="button" className={run.claude && run.claude.recommended ? '' : 'tagent__quiet'} onClick={onClaudeOpen}>Hand off to Claude on desktop…</button>}
          {claude && (
            <>
              <ClaudeHandoff {...claude} />
              <button type="button" className="tagent__quiet" onClick={onClaudeClose}>Close the handoff</button>
            </>
          )}
          {handoffs.length > 0 && (
            <ul className="tagent__list">
              {handoffs.map((h) => <li key={h.id} data-tagent-claude-handoff={h.status} className="tagent__meta">Handed to Claude {new Date(h.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} — prompt copied{h.desk ? `; laptop: ${h.desk.status}` : ''}.</li>)}
            </ul>
          )}
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
      {budget && <p className="tagent__meta tagent__budget">{budget.say}</p>}
      {error && <p className="tagent__err" role="alert">{error}</p>}

      <div className="tagent__row">
        {(run.status === 'interrupted' || run.status === 'failed') && <button type="button" onClick={() => onStart(false)} disabled={busy}>Do this — continue</button>}
        {run.status !== 'running' && run.status !== 'stopped' && <button type="button" className="tagent__quiet" onClick={onStop} disabled={busy}>Stop</button>}
        {settled && <button type="button" className="tagent__quiet" onClick={() => onStart(true)} disabled={busy}>Start a fresh attempt</button>}
      </div>
    </div>
  );
}

export default function TaskAgent({ taskId, call, readOnly = false, onOpenActions = null, onOpenNote = null, renderSave = null, copyText = defaultCopy }) {
  const [run, setRun] = useState(undefined); // undefined = not loaded; null = no run yet
  const [budget, setBudget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(null);
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [claude, setClaude] = useState({ preview: null, busy: false, error: null, result: null });
  const timer = useRef(null);

  const absorb = (body) => { if (body && 'run' in body) setRun(body.run); if (body && body.budget) setBudget(body.budget); };

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

  const loadPreview = useCallback(async (includeDrafts = false) => {
    setClaude((c) => ({ ...c, busy: true, error: null }));
    const r = await call(`/api/task-agent/tasks/${enc(taskId)}/handoff/preview${includeDrafts ? '?includeDrafts=1' : ''}`);
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
      setClaude((c) => ({ ...c, busy: false, copied: r.body.prompt, result: copied ? 'Copied — paste it into Claude on your desktop.' : 'Ready — copy the prompt below into Claude on your desktop (this device would not let NEURO copy it).' }));
    } else {
      setClaude((c) => ({ ...c, busy: false, error: (r.body && r.body.error) || `Not handed off (${r.status}).` }));
    }
  };

  return (
    <TaskAgentView
      run={run}
      budget={budget}
      busy={busy}
      error={error}
      onStart={(fresh) => post(`/api/task-agent/tasks/${enc(taskId)}/start`, fresh ? { fresh: true } : {})}
      onAnswer={(a) => post(`/api/task-agent/tasks/${enc(taskId)}/answer`, a)}
      onStop={() => post(`/api/task-agent/tasks/${enc(taskId)}/stop`, {})}
      onOpenActions={onOpenActions}
      onOpenNote={onOpenNote}
      onSave={async (o) => { const b = await post(`/api/task-agent/tasks/${enc(taskId)}/outputs/${enc(o.id)}/save`, {}); if (b) setSaving(o.id); }}
      saving={saving}
      renderSave={renderSave ? (recordId) => renderSave(recordId, () => { setSaving(null); load(); }) : null}
      onCopy={(t) => copyText(t)}
      claude={claudeOpen ? { ...claude, onIncludeDrafts: (v) => loadPreview(v), onSend: sendHandoff } : null}
      onClaudeOpen={() => { setClaudeOpen(true); loadPreview(false); }}
      onClaudeClose={() => { setClaudeOpen(false); setClaude({ preview: null, busy: false, error: null, result: null }); }}
    />
  );
}
