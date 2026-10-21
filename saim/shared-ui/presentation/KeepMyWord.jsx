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
//   server's. The one control is the existing `onOpen` hand-off to the task —
//   never a confirm, never a send: a held thread NAMES the missing authority
//   and offers no way round it.

export function KmwReadout({ readout, compact = false }) {
  if (!readout) return null;
  return (
    <aside className={`kmw__week${compact ? ' kmw__week--compact' : ''}`} aria-label="Holding the week">
      <p className="kmw__label">{readout.label}</p>
      {readout.figure
        ? <p className="kmw__figure">{readout.figure}</p>
        : null}
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

export function KmwThread({ thread, onOpen = null, actions = false }) {
  if (!thread) return null;
  const open = actions && onOpen
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
export function KmwMain({ kmw, onOpen = null, actions = false }) {
  if (!kmw) return null;
  if (kmw.receipt) {
    return (
      <div className="kmw__main">
        <KmwReceipt receipt={kmw.receipt} />
        {kmw.thread && (
          <details className="kmw__fold">
            <summary>{`Keeping your word — ${kmw.thread.title}`}</summary>
            <KmwThread thread={kmw.thread} onOpen={onOpen} actions={actions} />
          </details>
        )}
      </div>
    );
  }
  return <div className="kmw__main"><KmwThread thread={kmw.thread} onOpen={onOpen} actions={actions} /></div>;
}

/** The folded entry beneath an urgent lead: recognisable by its title, opened on demand. */
export function KmwFolded({ kmw, onOpen = null, actions = false }) {
  if (!kmw || !kmw.entry) return null;
  return (
    <details className="kmw__fold kmw__fold--entry">
      <summary>{kmw.entry}</summary>
      <KmwMain kmw={kmw} onOpen={onOpen} actions={actions} />
    </details>
  );
}
