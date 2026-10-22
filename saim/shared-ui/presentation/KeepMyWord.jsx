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

// A Monday report that needs nothing from Nick (sent, and read back) changes no choice now.
const MONDAY_SETTLED = new Set(['sent-verified-on-time', 'sent-verified-late']);

/**
 * NEURO's Now page (22 Oct 2026): the SAME readout, made to earn its space in a
 * working surface — the figure (or the honest "not measured yet"), the week's
 * re-dates, a Monday report ONLY when it still needs something, and the promises
 * awaiting judgement as one line (there is no action for them yet, so no card).
 * The SAiM scenes keep the locked readout above.
 */
function WorkspaceReadout({ readout }) {
  const j = readout.judgement;
  const m = readout.monday && readout.monday.line && !MONDAY_SETTLED.has(readout.monday.state) ? readout.monday : null;
  return (
    <aside className="kmw__week kmw__week--workspace" aria-label="Holding the week">
      <p className="kmw__label">{readout.label}</p>
      {readout.figure
        ? <p className="kmw__figure">{readout.figure}</p>
        : readout.figureNote ? <p className="kmw__figure kmw__figure--note">{readout.figureNote}</p> : null}
      {readout.figure
        ? (readout.line && <p className="kmw__line">{readout.line}{readout.trend && <><br /><span className="kmw__trend">{readout.trend}</span></>}</p>)
        : (readout.line && <details className="kmw__how"><summary>How this is counted</summary><p className="kmw__line">{readout.line}</p></details>)}
      {readout.reDated && <p className="kmw__line kmw__line--quiet">{readout.reDated}</p>}
      {m && <p className={`kmw__line kmw__monday kmw__monday--${m.state}`}><span className="kmw__inline-label">{m.label}</span> {m.line}</p>}
      {readout.next && <p className="kmw__line"><span className="kmw__inline-label">{readout.next.label}</span> <strong>{readout.next.strong}</strong> {readout.next.line}</p>}
      {j && <p className="kmw__line kmw__line--quiet"><strong>{j.strong}</strong> · {j.label}</p>}
    </aside>
  );
}

export function KmwReadout({ readout, compact = false, workspace = false }) {
  if (!readout) return null;
  if (workspace) return <WorkspaceReadout readout={readout} />;
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
export function KmwMove({ move, onPromiseMove = null, readOnly = false, renderSave = null }) {
  const [busy, setBusy] = useState(false);
  const [savedId, setSavedId] = useState(null); // the record whose save step is showing — kept through its receipt
  const [local, setLocal] = useState(null); // the move a press or an answer just returned (promiseMove)
  const [note, setNote] = useState(null);   // { message, error } — a sentence, never a state
  const [text, setText] = useState('');
  if (!move && !local) return null;
  // ONE contract (26 Oct 2026): what the route returned IS the card's move. A
  // newer move from a poll wins over an older local one, never the other way.
  const cur = local && (!move || (local.moveKey === move.moveKey && (local.version || 0) >= (move.version || 0)) || move.state === 'offer') ? local : move;
  const can = Boolean(onPromiseMove) && !readOnly;
  const run = async (op, { answering = false } = {}) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = promiseMoveResult(await onPromiseMove(op), { answering });
      if (r.kind === 'move') { setLocal(r.move); setNote(null); setText(''); }
      else if (r.kind === 'ask') { setLocal({ ...cur, state: 'ask', question: r.question, recordId: r.recordId, version: r.version, say: r.question.question }); setNote(null); setText(''); }
      else if (r.kind === 'refused') setNote({ message: r.message, error: true }); // the words stay in the box
      else { setNote({ message: r.say, error: false }); setText(''); }
    } catch {
      setNote({ message: answering ? 'NEURO didn’t answer. Your answer was not saved — it is still in the box.' : 'NEURO didn’t answer. Nothing was changed.', error: true });
    } finally { setBusy(false); }
  };
  const q = cur && ['ask', 'interview'].includes(cur.state) ? cur.question : null;
  const press = () => run({ action: 'prepare', ref: cur.ref });
  const withdraw = () => run({ action: 'withdraw', ref: cur.ref });
  const submit = (e) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || !q) return;
    run({ action: 'answer', recordId: cur.recordId, version: cur.version, questionId: q.id, text: t }, { answering: true });
  };
  const park = () => run({ action: 'park', recordId: cur.recordId, version: cur.version, questionId: q.id });
  const pd = cur.privateDraft || null;
  const oa = cur.owedAnswer || null;
  const iv = cur.interview || null;
  const id = `kmw-q-${String(cur.ref || 'p').replace(/[^A-Za-z0-9_-]/g, '-')}`;
  // The governed save step, IN this card (26 Oct 2026): a slot the SHELL fills with
  // the same prepared-move record, version, authority check, route and executor
  // SAiM Home uses — this card itself writes nothing. While questions are open it
  // offers only the unfinished save; once every decision is answered or parked,
  // the full save. It stays mounted through its own receipt.
  const saveable = Boolean(renderSave && can && pd && cur.recordId && ['interview', 'needs-decision', 'ready'].includes(cur.state));
  const saveId = saveable ? cur.recordId : (savedId && ['done', 'scheduled'].includes(cur.state) ? savedId : null);
  if (saveable && savedId !== cur.recordId) setSavedId(cur.recordId);
  return (
    <div className={`kmw__row kmw__row--move${pd ? ' kmw__row--private' : ''}`}>
      <span className="kmw__rowlabel">Next</span>
      <div>
        {pd && <p className="kmw__rowline kmw__private">{pd.label}</p>}
        {cur.state === 'interview' && iv && <p className="kmw__rowline kmw__progress">Decision {iv.n} of {iv.total}</p>}
        {cur.state !== 'ask' && cur.state !== 'interview' && cur.say && <p className="kmw__rowline">{cur.say}</p>}
        {iv && iv.said && iv.said.length > 0 && (
          <div className="kmw__said">
            <p className="kmw__rowline kmw__said-head">You said</p>
            {iv.said.map((x) => <p key={x.id} className="kmw__rowline kmw__said-line"><b>{x.decision}:</b> {x.answer}</p>)}
          </div>
        )}
        {iv && iv.parked && iv.parked.length > 0 && (
          <p className="kmw__rowline kmw__parked">Parked — still unresolved: {iv.parked.map((x) => x.decision).join('; ')}.</p>
        )}
        {q ? (
          <form className="kmw__ask" onSubmit={submit}>
            <label className="kmw__rowline kmw__ask-q" htmlFor={id}>{q.question}</label>
            {q.why && <p className="kmw__rowline kmw__ask-why">{q.why}</p>}
            {can ? (
              <>
                {q.choices && q.choices.length > 0 && (
                  <div className="kmw__choices">
                    {q.choices.map((c) => <button key={c} type="button" className={`kmw__choice${text === c ? ' kmw__choice--on' : ''}`} onClick={() => setText(c)} disabled={busy}>{c}</button>)}
                  </div>
                )}
                {q.id === 'owed'
                  ? <input id={id} className="kmw__ask-input" type="text" maxLength={120} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} placeholder="A full name, or a group" autoComplete="off" />
                  : <textarea id={id} className="kmw__ask-input kmw__ask-text" rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} placeholder="In your own words" />}
                <div className="kmw__actions">
                  <button type="submit" className="kmw__open" disabled={busy || !text.trim()}>{busy ? 'Telling SAiM…' : 'Tell SAiM'}</button>
                  {q.canPark && <button type="button" className="kmw__choice" onClick={park} disabled={busy}>Park this for now</button>}
                </div>
              </>
            ) : <p className="kmw__rowline">Answer this in SAiM on your phone or desktop.</p>}
          </form>
        ) : cur.state === 'offer' && cur.control && can ? (
          <div className="kmw__actions"><button type="button" className="kmw__open" onClick={press} disabled={busy}>{busy ? 'One moment…' : cur.control}</button></div>
        ) : null}
        {cur.destinationSay && <p className="kmw__rowline kmw__dest">{cur.destinationSay}</p>}
        {saveId && <div className="kmw__save" key={saveId}>{renderSave({ recordId: saveId, state: cur.state })}</div>}
        {note && <p className={`kmw__rowline${note.error ? ' kmw__draft-error' : ' kmw__draft-done'}`} role="status">{note.message}</p>}
        {oa && cur.state === 'offer' && (
          <div className="kmw__owed">
            <p className="kmw__rowline">{oa.say}</p>
            {can && <button type="button" className="kmw__choice" onClick={withdraw} disabled={busy}>{oa.control}</button>}
          </div>
        )}
      </div>
    </div>
  );
}

export function KmwThread({ thread, onOpen = null, actions = false, onPrepareDelivery = null, onPromiseMove = null, onOpenActions = null, renderPromiseSave = null, asWhy = false }) {
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
    <section className={`kmw__thread kmw__thread--${thread.preparation.state}${thread.held ? ' kmw__thread--held' : ''}${asWhy ? ' kmw__thread--why' : ''}`} aria-label={asWhy ? 'Why it matters' : 'Keeping your word'} data-promise-ref={thread.move ? thread.move.ref : undefined}>
      {/* As the WHY of the lead (22 Oct 2026) the title is the lead's — never said twice. */}
      <p className="kmw__label kmw__label--live"><i aria-hidden="true" />{asWhy ? `Why it matters · ${thread.label}` : thread.label}</p>
      {!asWhy && <h2 className="kmw__headline kmw__headline--thread">{thread.title}</h2>}
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
        {moving && <KmwMove move={thread.move} onPromiseMove={actions ? onPromiseMove : null} readOnly={!actions} renderSave={actions ? renderPromiseSave : null} />}
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
export function KmwMain({ kmw, onOpen = null, actions = false, onPrepareDelivery = null, onPromiseMove = null, onOpenActions = null, renderPromiseSave = null }) {
  const t = { onOpen, actions, onPrepareDelivery, onPromiseMove, onOpenActions, renderPromiseSave };
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

/**
 * The promise as the WHY of the lead (22 Oct 2026): when the lead card IS this
 * promise's task, its Keep my word state (the question, the draft, the save)
 * sits directly under it instead of a folded line repeating its title.
 */
export function KmwWhy({ kmw, onOpen = null, actions = false, onPrepareDelivery = null, onPromiseMove = null, onOpenActions = null, renderPromiseSave = null }) {
  if (!kmw || !kmw.thread) return null;
  return <div className="kmw__main kmw__why"><KmwThread thread={kmw.thread} asWhy onOpen={onOpen} actions={actions} onPrepareDelivery={onPrepareDelivery} onPromiseMove={onPromiseMove} onOpenActions={onOpenActions} renderPromiseSave={renderPromiseSave} /></div>;
}

/** The folded entry beneath an urgent lead: recognisable by its title, opened on demand. */
export function KmwFolded({ kmw, onOpen = null, actions = false, onPrepareDelivery = null, onPromiseMove = null, onOpenActions = null, renderPromiseSave = null }) {
  if (!kmw || !kmw.entry) return null;
  return (
    <details className="kmw__fold kmw__fold--entry">
      <summary>{kmw.entry}</summary>
      <KmwMain kmw={kmw} onOpen={onOpen} actions={actions} onPrepareDelivery={onPrepareDelivery} onPromiseMove={onPromiseMove} onOpenActions={onOpenActions} renderPromiseSave={renderPromiseSave} />
    </details>
  );
}
