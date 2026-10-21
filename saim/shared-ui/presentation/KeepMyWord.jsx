import { useState } from 'react';
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
//   shows what came back. Never a confirm, an approval or a send: a held thread
//   NAMES what is missing and offers no way round it. No URL lives here, so a
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

export function KmwThread({ thread, onOpen = null, actions = false, onPrepareDelivery = null, onOpenActions = null }) {
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
  const open = actions && onOpen && !canDraft && !thread.held
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
export function KmwMain({ kmw, onOpen = null, actions = false, onPrepareDelivery = null, onOpenActions = null }) {
  const t = { onOpen, actions, onPrepareDelivery, onOpenActions };
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
export function KmwFolded({ kmw, onOpen = null, actions = false, onPrepareDelivery = null, onOpenActions = null }) {
  if (!kmw || !kmw.entry) return null;
  return (
    <details className="kmw__fold kmw__fold--entry">
      <summary>{kmw.entry}</summary>
      <KmwMain kmw={kmw} onOpen={onOpen} actions={actions} onPrepareDelivery={onPrepareDelivery} onOpenActions={onOpenActions} />
    </details>
  );
}
