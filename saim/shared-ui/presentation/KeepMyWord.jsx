import { useState } from 'react';
import { promiseMoveResult } from './promiseMove.mjs';
import './KeepMyWord.css';

// Keep my word — the locked SAiM home scene (timefield.html, 21 Oct 2026).
//
// Draws `presentation.keepMyWord` (keep-my-word-v1). Mounted by Situation (the
// phone, the desktop and the kiosk) and by Alt's ManifestView, so all four draw
// ONE decision in one vocabulary:
//   - the READOUT: a compact left-hand column — the week's promises kept on
//     time, the Monday report, the next protected time, what needs judgement;
//   - the MAIN surface: a verified RECEIPT (what changed, how it was checked,
//     where it lives) or the promise SAiM is holding as a THREAD.
//
// ⚠ IT DECIDES NOTHING. State, order, wording and the lead rule are the
//   server's. Its controls are hand-offs the SHELL supplies: `onOpen` (the
//   task) and, for a promise that is a message, `onPrepareDelivery` — which
//   only PREPARES the governed draft (POST /api/promises/:key/prepare) and
//   shows what came back; and `onPromiseMove`, which takes a held promise
//   forward as a prepared move — asking, in place, the one thing SAiM needs
//   (who it is owed to) and storing a PROPOSAL. Never a confirm, an approval
//   or a send: a held thread NAMES what is missing and offers no way round it. No URL lives here, so a
//   shell without a credential path (the kiosk) simply passes no handler.

export function KmwReadout({ readout, compact = false }) {
  if (!readout) return null;
  return (
    <aside className={`kmw__week${compact ? ' kmw__week--compact' : ''}`} aria-label="Holding the week">
      <p className="kmw__label">{readout.label}</p>
      {readout.figure
        ? <p className="kmw__figure">{readout.figure}</p>
        : readout.figureNote ? <p className="kmw__figure kmw__figure--note">{readout.figureNote}</p> : null}
      {readout.line && <p className="kmw__line">{readout.line}{readout.trend && <><br /><span className="kmw__trend">{readout.trend}</span></>}</p>}
      {readout.reDated && <p className="kmw__line kmw__line--quiet">{readout.reDated}</p>}
      {readout.monday && readout.monday.line && (
        <>
          <hr className="kmw__rule" />
          <p className="kmw__label">{readout.monday.label}</p>
          <p className={`kmw__line kmw__monday kmw__monday--${readout.monday.state}`}>{readout.monday.line}</p>
        </>
      )}
      {readout.next && (
        <>
          <hr className="kmw__rule" />
          <p className="kmw__label">{readout.next.label}</p>
          <p className="kmw__strong">{readout.next.strong}</p>
          <p className="kmw__line">{readout.next.line}</p>
        </>
      )}
      {readout.judgement && (
        <>
          <hr className="kmw__rule" />
          <p className="kmw__label">{readout.judgement.label}</p>
          <p className="kmw__strong">{readout.judgement.strong}</p>
          <p className="kmw__line">{readout.judgement.line}</p>
        </>
      )}
    </aside>
  );
}

export function KmwReceipt({ receipt }) {
  if (!receipt) return null;
  return (
    <section className="kmw__receipt" aria-label="Receipt">
      <p className="kmw__label kmw__label--live"><i aria-hidden="true" />{receipt.label}</p>
      <h2 className="kmw__headline">{receipt.headline}</h2>
      <p className="kmw__lead">{receipt.lead}</p>
      <div className="kmw__rows">
        {receipt.rows.map((r) => (
          <div key={r.label} className="kmw__row">
            <span className="kmw__rowlabel">{r.label}</span>
            <div>
              {r.title && <b className="kmw__rowtitle">{r.title}</b>}
              {(r.lines || []).map((l) => <p key={l} className="kmw__rowline">{l}</p>)}
              {r.path && <p className="kmw__rowline kmw__path">{r.path}</p>}
            </div>
          </div>
        ))}
      </div>
      <p className="kmw__checked">{receipt.checkedLabel}</p>
    </section>
  );
}

/** The draft the route handed back — read-only. Approval happens in Actions, never here. */
function DraftResult({ result, draft, onOpenActions }) {
  if (result.error) return <p className="kmw__rowline kmw__draft-error" role="status">Not drafted — {result.error}</p>;
  const a = result.action || {};
  const d = a.draft || {};
  return (
    <div className="kmw__draft-result" role="status">
      <p className="kmw__rowline kmw__draft-done">{result.already ? 'This is the delivery note already drafted — nothing new was created, and nothing has been sent.' : 'Drafted for your approval — nothing has been sent.'}</p>
      {Array.isArray(d.to) && d.to.length > 0 && <p className="kmw__rowline">To {d.to.map((r) => r.name ? `${r.name} <${r.email}>` : r.email).join(', ')}</p>}
      {d.subject && <p className="kmw__rowline">“{d.subject}”</p>}
      {d.body && <pre className="kmw__draft-body">{d.body}</pre>}
      <p className="kmw__rowline">{draft.review}</p>
      {draft.sendingOff && <p className="kmw__rowline">{draft.sendingOff}</p>}
      {onOpenActions && <div className="kmw__actions"><button type="button" className="kmw__open" onClick={() => onOpenActions(a.actionId || null)}>Review it in Actions</button></div>}
    </div>
  );
}

/**
 * Taking the promise forward IN PLACE (24 Oct 2026): one control, then the ONE
 * question SAiM needs answered (who it is owed to, or the next thing), asked
 * here — never "go and open the task". The shell's `onPromiseMove` does the
 * network (prepare / answer through the prepared-move routes); every word
 * shown is the server's. Nothing here sends, books or confirms anything.
 */
export function KmwMove({ move, onPromiseMove = null, readOnly = false }) {
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(null); // promiseMoveResult()
  const [text, setText] = useState('');
  if (!move) return null;
  const can = Boolean(onPromiseMove) && !readOnly;
  // The question on screen: one just asked, or the one the move is already asking.
  const asking = step && step.kind === 'ask' ? step
    : !step && move.state === 'ask' && move.question ? { kind: 'ask', question: move.question, recordId: move.recordId, version: move.version } : null;
  const run = async (op, answering) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = promiseMoveResult(await onPromiseMove(op), { answering });
      if (r.kind === 'refused' && r.keep) setStep({ ...asking, refused: r.message });
      else { setStep(r); setText(''); }
    } catch {
      setStep(answering ? { ...asking, refused: 'NEURO didn’t answer. Your answer was not saved — it is still in the box.' } : { kind: 'refused', message: 'NEURO didn’t answer. Nothing was changed.' });
    } finally { setBusy(false); }
  };
  const press = () => run({ action: 'prepare', ref: move.ref }, false);
  const submit = (e) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || !asking) return;
    run({ action: 'answer', recordId: asking.recordId, version: asking.version, questionId: asking.question.id, text: t }, true);
  };
  const q = asking && asking.question;
  return (
    <div className="kmw__row kmw__row--move">
      <span className="kmw__rowlabel">Next</span>
      <div>
        {move.say && !step && move.state !== 'ask' && <p className="kmw__rowline">{move.say}</p>}
        {q ? (
          <form className="kmw__ask" onSubmit={submit}>
            <label className="kmw__rowline kmw__ask-q" htmlFor={`kmw-q-${move.ref}`}>{q.question}</label>
            {q.why && <p className="kmw__rowline kmw__ask-why">{q.why}</p>}
            {can ? (
              <>
                {q.choices && q.choices.length > 0 && (
                  <div className="kmw__choices">
                    {q.choices.map((c) => <button key={c} type="button" className={`kmw__choice${text === c ? ' kmw__choice--on' : ''}`} onClick={() => setText(c)} disabled={busy}>{c}</button>)}
                  </div>
                )}
                <input id={`kmw-q-${move.ref}`} className="kmw__ask-input" type="text" maxLength={120} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} placeholder="A full name, or a group" autoComplete="off" />
                <div className="kmw__actions"><button type="submit" className="kmw__open" disabled={busy || !text.trim()}>{busy ? 'Telling SAiM…' : 'Tell SAiM'}</button></div>
              </>
            ) : <p className="kmw__rowline">Answer this in SAiM on your phone or desktop.</p>}
            {asking.refused && <p className="kmw__rowline kmw__draft-error" role="status">{asking.refused}</p>}
          </form>
        ) : step ? (
          <p className={`kmw__rowline${step.kind === 'refused' ? ' kmw__draft-error' : ' kmw__draft-done'}`} role="status">{step.kind === 'refused' ? step.message : step.say}</p>
        ) : move.state === 'offer' && move.control && can ? (
          <div className="kmw__actions"><button type="button" className="kmw__open" onClick={press} disabled={busy}>{busy ? 'One moment…' : move.control}</button></div>
        ) : null}
      </div>
    </div>
  );
}

export function KmwThread({ thread, onOpen = null, actions = false, onPrepareDelivery = null, onPromiseMove = null, onOpenActions = null }) {
  const [drafting, setDrafting] = useState(false);
  const [result, setResult] = useState(null);
  if (!thread) return null;
  const draft = thread.draft || null;
  const canDraft = Boolean(actions && draft && draft.control && onPrepareDelivery);
  const prepare = async () => {
    if (drafting) return;
    setDrafting(true);
    try {
      const r = await onPrepareDelivery(draft.key);
      setResult(r && r.ok ? r : { error: (r && r.error) || 'NEURO didn’t answer, so nothing was drafted.' });
    } catch (e) {
      setResult({ error: e && e.message ? e.message : 'NEURO didn’t answer, so nothing was drafted.' });
    } finally {
      setDrafting(false);
    }
  };
  // One control per state: where a delivery can be drafted, that IS the control.
  // A HELD thread offers none: opening the task resolves nothing it names (the
  // missing address or authority), so the held sentence stands alone.
  // Where SAiM can take the promise forward, that IS the control — opening the
  // task stays only where nothing else can move it (24 Oct 2026).
  const moving = Boolean(thread.move);
  const open = actions && onOpen && !canDraft && !thread.held && !moving
    ? () => onOpen({ kind: 'task', id: thread.key, title: thread.title, taskId: thread.taskId })
    : null;
  return (
    <section className={`kmw__thread kmw__thread--${thread.preparation.state}${thread.held ? ' kmw__thread--held' : ''}`} aria-label="Keeping your word">
      <p className="kmw__label kmw__label--live"><i aria-hidden="true" />{thread.label}</p>
      <h2 className="kmw__headline kmw__headline--thread">{thread.title}</h2>
      <p className="kmw__lead">
        <span className="kmw__due">{thread.due.label}</span>
        {thread.owedTo && <span> · owed to {thread.owedTo}</span>}
        <span> · {thread.due.say}</span>
      </p>
      <div className="kmw__rows">
        <div className="kmw__row">
          <span className="kmw__rowlabel">{thread.preparation.label}</span>
          <div><p className="kmw__rowline">{thread.preparation.why}</p></div>
        </div>
        {draft && (
          <div className="kmw__row kmw__row--draft">
            <span className="kmw__rowlabel">Delivery</span>
            <div>
              <p className="kmw__rowline kmw__draft-say">{draft.say}</p>
              {draft.sendingOff && !result && <p className="kmw__rowline">{draft.sendingOff}</p>}
              {canDraft && !(result && result.ok) && (
                <div className="kmw__actions">
                  <button type="button" className="kmw__open" disabled={drafting} onClick={prepare}>{drafting ? 'Drafting…' : draft.control}</button>
                </div>
              )}
              {result && <DraftResult result={result} draft={draft} onOpenActions={onOpenActions} />}
            </div>
          </div>
        )}
        {moving && <KmwMove move={thread.move} onPromiseMove={actions ? onPromiseMove : null} readOnly={!actions} />}
        {thread.held && (
          <div className="kmw__row kmw__row--held">
            <span className="kmw__rowlabel">Held</span>
            <div><p className="kmw__rowline">{thread.held.say}</p></div>
          </div>
        )}
        <div className="kmw__row">
          <span className="kmw__rowlabel">Evidence</span>
          <div>{thread.evidence.map((e, i) => <p key={i} className="kmw__rowline">{e.fact}</p>)}</div>
        </div>
      </div>
      {thread.more && <p className="kmw__more">{thread.more.count === 1 ? 'One more' : `${thread.more.count} more`} at risk: {thread.more.titles.join('; ')}</p>}
      {thread.withheld && <p className="kmw__more">{thread.withheld}</p>}
      {open && (
        <div className="kmw__actions">
          <button type="button" className="kmw__open" onClick={open}>Open the task</button>
        </div>
      )}
    </section>
  );
}

/** The main surface: the receipt when there is one (the thread, if any, folded under it), else the thread. */
export function KmwMain({ kmw, onOpen = null, actions = false, onPrepareDelivery = null, onPromiseMove = null, onOpenActions = null }) {
  const t = { onOpen, actions, onPrepareDelivery, onPromiseMove, onOpenActions };
  if (!kmw) return null;
  if (kmw.receipt) {
    return (
      <div className="kmw__main">
        <KmwReceipt receipt={kmw.receipt} />
        {kmw.thread && (
          <details className="kmw__fold">
            <summary>{`Keeping your word — ${kmw.thread.title}`}</summary>
            <KmwThread thread={kmw.thread} {...t} />
          </details>
        )}
      </div>
    );
  }
  return <div className="kmw__main"><KmwThread thread={kmw.thread} {...t} /></div>;
}

/** The folded entry beneath an urgent lead: recognisable by its title, opened on demand. */
export function KmwFolded({ kmw, onOpen = null, actions = false, onPrepareDelivery = null, onPromiseMove = null, onOpenActions = null }) {
  if (!kmw || !kmw.entry) return null;
  return (
    <details className="kmw__fold kmw__fold--entry">
      <summary>{kmw.entry}</summary>
      <KmwMain kmw={kmw} onOpen={onOpen} actions={actions} onPrepareDelivery={onPrepareDelivery} onPromiseMove={onPromiseMove} onOpenActions={onOpenActions} />
    </details>
  );
}
