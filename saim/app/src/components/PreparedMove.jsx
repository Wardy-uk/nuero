import { useEffect, useMemo, useRef, useState } from 'react';
import { apiUrl, authHeaders } from '../api';
import { loadWithRetry, load, askToConfirm, confirm, receiptLines, newSessionId, makeCall, makeReady, respond, answer, park, interviewOf, outstandingOf, boundaryOf } from '../preparedMove.mjs';
import { platformNow } from '../../../shared-ui/presentation/platform.mjs';
import { isDebugView } from '../debugView.mjs';
import TaskContext from '../../../shared-ui/TaskContext.jsx';
import './PreparedMove.css';

// SAiM's prepared MOMENT (20 Oct 2026) — not a card. Evidence has condensed
// into two real things: the draft itself, as a page, with the decisions the
// teams still have to make visibly open; and the protected time in the
// calendar, as an object. Her presence holds them together. Only then comes
// the one choice; the proof is folded underneath.
//
//   Prepared    — what SAiM made (the page)
//   Still human — the decisions only people can take (the open cells)
//   One choice  — protect the time and save the work
//   Proof       — folded, inspectable, never lost
//
// ⚠ Every word about the move is the server's (prepared-move-view-v1): the
//   page is the draft's own parsed text, the time is the offered slot.
// ⚠ Nothing here claims an outcome without a receipt: the "in your calendar"
//   and "saved" marks appear ONLY when the receipt's own step says so.
// ⚠ Held (off duty / leave): the page and one sentence. No time, choice,
//   write list or unlock wording.

/** Plain words for "execution is not available here" — no flag or variable names. */
export const NOT_ENABLED = 'This is ready to review. Changes aren’t enabled here yet.';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Dates are SLICED, never parsed into a local Date (the BST rule).
const parts = (ymd) => { const [y, m, d] = String(ymd).split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, d, 12)); return { dow: DAYS[x.getUTCDay()], short: SHORT[x.getUTCDay()], day: x.getUTCDate(), mon: MONTHS[x.getUTCMonth()] }; };

/** PURE. What the receipt says about each object — and nothing it does not say. */
export function receiptMarks(receipt) {
  const out = { calendar: null, note: null };
  if (!receipt) return out;
  // A practice run wrote to a disposable copy, never to his calendar or notes.
  const practice = receipt.target === 'sandbox';
  for (const s of receipt.steps || []) {
    const ok = s.status === 'done' || s.status === 'already-done';
    if (s.step === 'calendar') out.calendar = ok ? (practice ? 'Practice run · placed and read back' : 'In your calendar · read back') : null;
    if (s.step === 'note') out.note = ok ? (practice ? 'Practice run · saved and read back' : 'Saved in your notes · read back') : null;
  }
  return out;
}

/** How much of the page shows before "Read the full draft". */
const FRAGMENT_ITEMS = 3;

/**
 * The page: a deliberate FRAGMENT of the draft — its title and the first few
 * lines of its first section — with the decisions still owed by people marked
 * on the paper, and the rest folded inside the page itself. Every word is the
 * draft's own (prepared-move-artefact).
 */
function Page({ artefact, mark }) {
  if (!artefact) return null;
  const [first, ...others] = artefact.sections;
  const lead = first ? first.items.slice(0, FRAGMENT_ITEMS) : [];
  const more = first ? first.items.slice(FRAGMENT_ITEMS) : [];
  const d = artefact.decisions;
  const hasRest = more.length > 0 || others.length > 0 || Boolean(d) || artefact.openQuestions.length > 0;
  return (
    <article className="pmo__page" aria-label="The draft SAiM prepared">
      <p className="pmo__pagetag">{mark || 'Draft'}</p>
      <h3 className="pmo__pagetitle">{artefact.title}</h3>
      {first && (
        <section className="pmo__sec">
          <p className="pmo__sechead">{first.heading}{first.cited ? <span className="pmo__cite">from your notes</span> : null}</p>
          <ul>{lead.map((it, j) => <li key={j} className={it.gap ? 'pmo__gapline' : undefined}>{it.text}</li>)}</ul>
        </section>
      )}
      {hasRest && (
        <details className="pmo__full">
          <summary>Read the full draft</summary>
          {more.length > 0 && <ul className="pmo__cont">{more.map((it, j) => <li key={j} className={it.gap ? 'pmo__gapline' : undefined}>{it.text}</li>)}</ul>}
          {others.map((sec, i) => (
            <section key={i} className="pmo__sec">
              <p className="pmo__sechead">{sec.heading}{sec.cited ? <span className="pmo__cite">from your notes</span> : null}</p>
              <ul>{sec.items.map((it, j) => <li key={j} className={it.gap ? 'pmo__gapline' : undefined}>{it.text}</li>)}</ul>
            </section>
          ))}
          {d && (
            <section className="pmo__sec pmo__decisions">
              <p className="pmo__sechead">{d.heading}</p>
              <table>
                <thead><tr>{d.columns.map((c, i) => <th key={i} scope="col">{c}</th>)}</tr></thead>
                <tbody>
                  {d.rows.map((r, i) => (
                    <tr key={i}>
                      <th scope="row">{r.who}</th>
                      {r.cells.map((c, j) => <td key={j}>{c.open ? <span className="pmo__open">to agree</span> : c.text}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {artefact.openQuestions.length > 0 && (
            <section className="pmo__sec">
              <p className="pmo__sechead">Open questions</p>
              <ul>{artefact.openQuestions.map((q, i) => <li key={i}><span className="pmo__open">open</span> {q}</li>)}</ul>
            </section>
          )}
        </details>
      )}
      {artefact.openLabel && (
        <p className="pmo__human"><span className="pmo__humanlabel">Still human</span><span className="pmo__open">{artefact.openLabel}</span></p>
      )}
    </article>
  );
}

/** The moment's preview: the title and first lines, fading — the page is there, but it is not the point. */
function PagePreview({ artefact, mark }) {
  const first = artefact.sections[0];
  return (
    <span className="pmo__page pmo__page--preview">
      <span className="pmo__pagetag">{mark || 'Draft'}</span>
      <span className="pmo__pagetitle">{artefact.title}</span>
      {first && (
        <span className="pmo__sec">
          <span className="pmo__sechead">{first.heading}</span>
          {first.items.slice(0, FRAGMENT_ITEMS).map((it, j) => <span key={j} className="pmo__pli">{it.text}</span>)}
        </span>
      )}
    </span>
  );
}

/** The working document, whole. Every word is the draft's own. */
function FullPage({ artefact, mark }) {
  const d = artefact.decisions;
  return (
    <article className="pmo__page pmo__page--full" aria-label="The draft SAiM prepared">
      <p className="pmo__pagetag">{mark || 'Draft · not saved yet'}</p>
      <h2 className="pmo__pagetitle">{artefact.title}</h2>
      {artefact.sections.map((sec, i) => (
        <section key={i} className="pmo__sec">
          <p className="pmo__sechead">{sec.heading}{sec.cited ? <span className="pmo__cite">from your notes</span> : null}</p>
          <ul>{sec.items.map((it, j) => <li key={j} className={it.gap ? 'pmo__gapline' : undefined}>{it.text}</li>)}</ul>
        </section>
      ))}
      {d && (
        <section className="pmo__sec pmo__decisions">
          <p className="pmo__sechead">{d.heading}</p>
          <table>
            <thead><tr>{d.columns.map((c, i) => <th key={i} scope="col">{c}</th>)}</tr></thead>
            <tbody>{d.rows.map((r, i) => <tr key={i}><th scope="row">{r.who}</th>{r.cells.map((c, j) => <td key={j}>{c.open ? <span className="pmo__open">to agree</span> : c.text}</td>)}</tr>)}</tbody>
          </table>
        </section>
      )}
      {artefact.openQuestions.length > 0 && (
        <section className="pmo__sec">
          <p className="pmo__sechead">Open questions</p>
          <ul>{artefact.openQuestions.map((q, i) => <li key={i}><span className="pmo__open">open</span> {q}</li>)}</ul>
        </section>
      )}
    </article>
  );
}

/** The proof, folded. Never lost; never in the way. */
function Proof({ move, label }) {
  return (
    <details className="pmo__proof">
      <summary>{label}</summary>
      {move.prepared && move.prepared.detail && <p>{move.prepared.detail}</p>}
      {move.whyItMatters && <p>{move.whyItMatters}</p>}
      {move.why && move.why.goal && <p>{move.why.goal}</p>}
      {move.why && move.why.because && move.why.because.length > 0 && <ul>{move.why.because.map((b, i) => <li key={i}>{b}</li>)}</ul>}
      {move.why && move.why.doneWhen && <p className="pmo__sub">Done when: {move.why.doneWhen}</p>}
      {move.contacts && <p>{move.contacts}</p>}
      {move.nothingElse && <p>{move.nothingElse}</p>}
      {move.why && move.why.willNot && move.why.willNot.length > 0 && <ul>{move.why.willNot.map((b, i) => <li key={i}>{b}</li>)}</ul>}
      {move.evidence && move.evidence.length > 0 && (
        <>
          <p className="pmo__prooflabel">What this is based on</p>
          <ul className="pmo__evidence">{move.evidence.map((e, i) => <li key={i}>{e.fact}{e.caveat && <span className="pmo__sub"> {e.caveat}</span>}</li>)}</ul>
        </>
      )}
      {move.draft && (
        <>
          <p className="pmo__prooflabel">The draft, as it will be saved</p>
          <pre className="pmo__draft">{move.draft.markdown}</pre>
        </>
      )}
    </details>
  );
}

/** One quiet line under the choice when SAiM cannot act — the server's own words. */
function gateLine(view, request) {
  const a = (request && request.authority) || view.authority || null;
  const enabled = request ? request.executionEnabled : Boolean(view.execution && view.execution.enabled);
  if (!enabled || (a && a.deviceOpen === false)) return NOT_ENABLED;
  if (a && a.stopped) return 'SAiM’s actions are stopped.';
  if (a && request && a.fits === false) return a.say;
  if (a && !a.granted) return 'SAiM has no allowance to act today. You can give one in “What SAiM may do”.';
  return null;
}

/** The words on the one confirm button, by what the move makes. */
export function confirmLabel(move) {
  const writes = (move && move.options && move.options[0] && move.options[0].writes) || [];
  if (move && move.kind === 'email-reply') return 'Put the reply in Actions';
  if (writes.some((w) => /calendar/i.test(w))) return 'Save it and protect the time';
  return 'Save it';
}

/**
 * A v2 proposal (21 Oct 2026): the OUTCOME first ("I drafted the reply"), the
 * deliverable with its source facts kept apart from SAiM's wording, the exact
 * writes, then one choice — confirm, put off, or say no. A question SAiM needs
 * answered is drawn as one. On the kiosk it is read-only.
 */
/**
 * The other open items (24 Oct 2026), one line each: "Needs your decision
 * before I can schedule it" stays visibly apart from "Scheduled for …; I can
 * now make the next item ready". A list, not a queue — showing one only loads it.
 */
export function Outstanding({ view, busy = false, onShow = null }) {
  const rows = outstandingOf(view);
  if (!rows.length) return null;
  return (
    <section className="pmo2__also" aria-label="Also open">
      <p className="pmo__sechead">Also open</p>
      <ul className="pmo2__alsolist">
        {rows.map((r) => (
          <li key={r.recordId} className={`pmo2__alsoitem pmo2__alsoitem--${r.state || 'open'}`}>
            <span className="pmo2__alsotitle">{r.title}</span>
            <span className="pmo__sub">{r.say}</span>
            {onShow && r.state !== 'scheduled' && <button type="button" className="pmo__btn pmo2__alsoshow" disabled={busy} onClick={() => onShow(r.recordId)}>Show</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The private-draft interview (26 Oct 2026): ONE question at a time, answered
 * or parked right here, with progress. Answering re-plans the draft (a new
 * version) and asks the next one. The only save offered while questions are
 * open is the quiet "unfinished" one, which plainly books no time.
 */
export function Interview({ move, busy = false, readOnly = false, onAnswer = null, onPark = null, onAskOption = null }) {
  const iv = interviewOf(move);
  const [text, setText] = useState('');
  if (!iv || !iv.next) return null;
  const q = iv.next;
  const canUnfinished = Boolean(onAskOption) && (move.options || []).some((o) => o.id === 'unfinished');
  return (
    <section className="pmo2__iv" aria-label="What only you can decide">
      <p className="pmo2__ivprog">{iv.progress}</p>
      <form className="pmo2__q" onSubmit={(e) => { e.preventDefault(); if (!readOnly && text.trim() && onAnswer) { onAnswer(q.id, text); setText(''); } }}>
        <label htmlFor={`pmiv-${q.id}`} className="pmo__ask">{q.question}</label>
        {q.why && <p className="pmo__sub">{q.why}</p>}
        {readOnly ? <p className="pmo__sub">Answer this in SAiM on your phone or desktop.</p> : (
          <>
            <textarea id={`pmiv-${q.id}`} rows={3} maxLength={1000} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} placeholder="In your own words" />
            <div className="pmo__buttons">
              <button type="submit" className="pmo__btn pmo__btn--yes" disabled={busy || !text.trim()}>Tell SAiM</button>
              <button type="button" className="pmo__btn" disabled={busy} onClick={() => onPark && onPark(q.id)}>Park this for now</button>
            </div>
          </>
        )}
      </form>
      {canUnfinished && !readOnly && (
        <p className="pmo2__ivquiet">
          <button type="button" className="pmo2__ivlink" disabled={busy} onClick={() => onAskOption('unfinished')}>Save this unfinished draft instead</button>
          {' '}— no time will be booked, and SAiM won’t ask the rest.
        </p>
      )}
    </section>
  );
}

/**
 * `embedded` (26 Oct 2026): the SAME governed save step, shown inside a promise
 * card on NEURO desktop for one pinned record. The card already shows the label
 * and runs the interview, so here: the draft folded, the real writes, and the
 * one choice — or, where a boundary stands, that boundary and the way to change
 * it, never a button that cannot work.
 */
function EmbeddedBoundary({ boundary, onOpenAuthority, onAgain = null, busy = false }) {
  // Only the allowance and the stop can be changed from "What SAiM may do"; the server switch cannot.
  const route = onOpenAuthority && ['allowance', 'stop', 'used'].includes(boundary.gate);
  return (
    <div className="pmo__act pmo__act--boundary" role="status">
      <p className="pmo__boundary">{boundary.say}</p>
      {route && <div className="pmo__buttons"><button type="button" className="pmo__btn pmo__btn--yes" onClick={onOpenAuthority}>Open what SAiM may do</button></div>}
      {boundary.gate === 'device' && <p className="pmo__sub">That switch is on NEURO’s server; nothing here can turn it on. The draft stays prepared and nothing is saved.</p>}
      {boundary.gate === 'unreadable' && onAgain && <div className="pmo__buttons"><button type="button" className="pmo__btn" onClick={onAgain} disabled={busy}>Look again</button></div>}
    </div>
  );
}

function V2Move({ state, busy, now, readOnly, onAsk, onConfirm, onCancel, onAgain, onRespond, onAnswer, onOpenAuthority, onShow, onPark, onAskOption, embedded = false, drafts = false, renderContext = null }) {
  const { view } = state; const move = view.move;
  const d = move.deliverable || {};
  const [deferDays, setDeferDays] = useState(1);
  const [deferReason, setDeferReason] = useState('not-now');
  const [declineReason, setDeclineReason] = useState('');
  const [draftAnswer, setDraftAnswer] = useState({});
  const held = Boolean(view.held || move.held);
  const iv = interviewOf(move);
  const ivOpen = Boolean(iv && iv.next);
  // While the interview has open questions the "unfinished" save is not the primary choice.
  const option = (move.options || []).find((o) => !(ivOpen && o.id === 'unfinished')) || (ivOpen ? null : (move.options || [])[0]) || null;
  const facts = d.sourceFacts || [];
  return (
    <section className="pmo pmo2" aria-label="Something SAiM has prepared">
      {!embedded && move.privateDraft && <p className="pmo2__private" role="note">{move.privateDraft.label}</p>}
      {!embedded && <p className="pmo__say">{move.prepared && move.prepared.headline}</p>}
      {!embedded && move.privateDraft && <p className="pmo__sub pmo2__privatewhy">{move.privateDraft.cannot} {move.privateDraft.can}</p>}
      {!embedded && move.outcome && move.outcome.goal && <p className="pmo__sub pmo2__goal">{move.outcome.goal}</p>}
      {!embedded && !held && move.plan === 'draft' && <Interview move={move} busy={busy} readOnly={readOnly} onAnswer={onAnswer} onPark={onPark} onAskOption={state.kind === 'confirming' ? null : onAskOption} />}

      {move.plan === 'ask' ? (
        <div className="pmo__act pmo2__ask">
          {(move.ask.questions || []).map((q) => (
            <form key={q.id} className="pmo2__q" onSubmit={(e) => { e.preventDefault(); if (!readOnly) onAnswer(q.id, draftAnswer[q.id] || ''); }}>
              <label htmlFor={`pmq-${q.id}`} className="pmo__ask">{q.question}</label>
              <p className="pmo__sub">{q.why}</p>
              {q.choices && q.choices.length > 0 ? (
                <select id={`pmq-${q.id}`} value={draftAnswer[q.id] || ''} disabled={readOnly || busy} onChange={(e) => setDraftAnswer((a) => ({ ...a, [q.id]: e.target.value }))}>
                  <option value="">Choose…</option>
                  {q.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : (
                <textarea id={`pmq-${q.id}`} rows={3} maxLength={1000} value={draftAnswer[q.id] || ''} disabled={readOnly || busy} onChange={(e) => setDraftAnswer((a) => ({ ...a, [q.id]: e.target.value }))} />
              )}
              {!readOnly && <div className="pmo__buttons"><button type="submit" className="pmo__btn pmo__btn--yes" disabled={busy || !(draftAnswer[q.id] || '').trim()}>Tell SAiM</button></div>}
            </form>
          ))}
        </div>
      ) : embedded ? (
        <details className="pmo2__embedpage">
          <summary>The draft so far — not saved yet</summary>
          <article className="pmo__page pmo2__page" aria-label="What SAiM drafted">
            {d.suggested && <div className="pmo2__text">{d.suggested.text}</div>}
          </article>
        </details>
      ) : (
        <article className="pmo__page pmo2__page" aria-label="What SAiM drafted">
          <p className="pmo__pagetag">{move.kind === 'email-reply' ? 'Reply · not sent' : 'Draft · not saved yet'}</p>
          <h3 className="pmo__pagetitle">{d.title || move.title}</h3>
          {d.to && <p className="pmo2__to">To {d.to.name ? `${d.to.name} <${d.to.email}>` : d.to.email} — the original sender only</p>}
          {d.suggested && (
            <section className="pmo__sec">
              <p className="pmo__sechead">{d.suggested.label}</p>
              <div className="pmo2__text">{d.suggested.text}</div>
            </section>
          )}
          {!iv && d.gaps && d.gaps.length > 0 && (
            <section className="pmo__sec">
              <p className="pmo__sechead">Still needed from you</p>
              <ul>{d.gaps.map((g, i) => <li key={i} className="pmo__gapline">{g}</li>)}</ul>
            </section>
          )}
        </article>
      )}

      {!embedded && facts.length > 0 && (
        <details className="pmo__proof pmo2__facts">
          <summary>What your sources say ({facts.length})</summary>
          <ul className="pmo__evidence">{facts.map((f, i) => <li key={i}>{f.text} <span className="pmo__sub">— {f.kind === 'you' ? 'you said' : f.cite}</span></li>)}</ul>
        </details>
      )}

      {renderContext && move.taskId != null && renderContext(move.taskId)}

      {!held && move.plan !== 'ask' && <div className="pmo__choice">{choice()}</div>}
      {held && <p className="pmo__sub">{(view.held && view.held.say) || 'Prepared for your next working morning.'}</p>}

      <details className="pmo__proof">
        <summary>Proof — how this was made</summary>
        {move.why && move.why.because && move.why.because.length > 0 && <ul>{move.why.because.map((b, i) => <li key={i}>{b}</li>)}</ul>}
        {move.prepared && move.prepared.detail && <p>{move.prepared.detail}</p>}
        {move.do && move.do.why && <p>{move.do.why}</p>}
        <p className="pmo__prooflabel">What this is based on</p>
        <ul className="pmo__evidence">{(move.evidence || []).map((e, i) => <li key={i}>{e.fact}</li>)}</ul>
        {(move.freshness || []).length > 0 && <ul className="pmo__sub">{move.freshness.map((f, i) => <li key={i}>{f.ref}: {f.ageHours == null ? 'unreadable' : `${f.ageHours}h old`} (limit {f.maxHours}h)</li>)}</ul>}
        {move.why && move.why.willNot && move.why.willNot.length > 0 && <><p className="pmo__prooflabel">SAiM will not</p><ul>{move.why.willNot.map((b, i) => <li key={i}>{b}</li>)}</ul></>}
      </details>
      {/* In Drafts the list IS the outstanding list — never a second one under the item. */}
      {!embedded && !drafts && <Outstanding view={view} busy={busy} onShow={onShow} />}
    </section>
  );

  function choice() {
    if (readOnly) return <p className="pmo__sub">Confirm this in SAiM on your phone or desktop — this screen can only show it.</p>;
    if (state.kind === 'receipt') {
      const r = state.receipt;
      return (
        <div className={`pmo__act pmo__act--${r.complete ? 'done' : 'partial'}`} role="status">
          <p className="pmo__actlead">{r.complete ? 'Done' : 'Partly done'}</p>
          <p>{r.plain}</p>
          <ul className="pmo__receipt">{receiptLines(r).map((l, i) => <li key={i} className={l.ok ? 'pmo__ok' : 'pmo__notok'}><strong>{l.step}</strong>: {l.status}{l.note && <span className="pmo__sub"> {l.note}</span>}</li>)}</ul>
          <p className="pmo__sub">{r.next}</p>
          {!r.complete && /retry/i.test(r.next || '') && <button type="button" className="pmo__btn" onClick={onAgain} disabled={busy}>Ask again to finish it</button>}
        </div>
      );
    }
    if (state.kind === 'responded') return <p className="pmo__sub" role="status">{state.message}</p>;
    if (state.kind === 'boundary' && (embedded || drafts)) return <EmbeddedBoundary boundary={state.boundary} onOpenAuthority={onOpenAuthority} onAgain={onAgain} busy={busy} />;
    if (state.kind === 'boundary') {
      return (
        <div className="pmo__act pmo__act--boundary" role="status">
          <p className="pmo__boundary">{state.boundary.say}</p>
          <div className="pmo__buttons">
            {onOpenAuthority && <button type="button" className="pmo__btn pmo__btn--yes" onClick={onOpenAuthority}>Open what SAiM may do</button>}
            <button type="button" className="pmo__btn" onClick={onCancel} disabled={busy}>Not now</button>
          </div>
        </div>
      );
    }
    if (state.kind === 'locked') return <div className="pmo__act pmo__act--stopped" role="status"><p>Nothing was changed. {NOT_ENABLED}</p></div>;
    if (state.kind === 'needs-again' || state.kind === 'refused' || state.kind === 'unknown') {
      return <div className="pmo__act pmo__act--stopped" role="status"><p>{state.message}</p><button type="button" className="pmo__btn" onClick={onAgain} disabled={busy}>Look again</button></div>;
    }
    if (state.kind === 'confirming') {
      const c = state.request.confirmation;
      const expired = state.request.expiresAt && Date.parse(state.request.expiresAt) <= now;
      const line = gateLine(view, state.request);
      return (
        <div className="pmo__act pmo__act--confirm">
          <p className="pmo__ask">{c.question}</p>
          <ul className="pmo__writes">{c.writes.map((w, i) => <li key={i}>{w}</li>)}</ul>
          <p className="pmo__sub">{c.contacts}</p>
          {line ? <p className="pmo__locked">{line}</p> : (state.request.authority && state.request.authority.summary && <p className="pmo__allow">{state.request.authority.summary}</p>)}
          {expired && <p className="pmo__locked">This confirmation has expired. Nothing was changed.</p>}
          <div className="pmo__buttons">
            {expired ? <button type="button" className="pmo__btn" onClick={onAgain} disabled={busy}>Ask again</button>
              : <button type="button" className="pmo__btn pmo__btn--yes" onClick={onConfirm} disabled={busy || !state.request.executionEnabled}>Confirm</button>}
            <button type="button" className="pmo__btn" onClick={onCancel} disabled={busy}>Not now</button>
          </div>
        </div>
      );
    }
    // Embedded: a standing boundary is shown FIRST, with its route — never a save button that cannot work.
    // Drafts too (22 Oct 2026): "Waiting for allowance" opens on the boundary and its route.
    const standing = (embedded || drafts) ? boundaryOf(view) : null;
    if (standing && standing.gate !== 'used') return <EmbeddedBoundary boundary={standing} onOpenAuthority={onOpenAuthority} onAgain={onAgain} busy={busy} />;
    if (embedded && ivOpen) {
      const unf = (move.options || []).find((o) => o.id === 'unfinished');
      return (
        <div className="pmo__act pmo__act--ready">
          {unf && onAskOption
            ? <p className="pmo2__ivquiet"><button type="button" className="pmo2__ivlink" disabled={busy} onClick={() => onAskOption('unfinished')}>Save this unfinished draft instead</button> — no time will be booked, and SAiM won’t ask the rest.</p>
            : <p className="pmo__sub">Answer or park each decision above to save it and protect the time.</p>}
        </div>
      );
    }
    if (!option && ivOpen) {
      // Nothing to confirm as finished yet — answer or park above. Putting it off or saying no stays possible.
      return <div className="pmo__act pmo__act--ready"><p className="pmo__sub">Answer or park each question to save it and protect the time.</p>{otherChoices()}</div>;
    }
    if (!option) {
      return <div className="pmo__act pmo__act--stopped" role="status"><p>I can’t offer this right now.</p><ul className="pmo__sub">{(move.notOffered || []).map((n, i) => <li key={i}>{n.label}: {n.why}</li>)}</ul></div>;
    }
    const r = move.respond || { defer: { days: [], reasons: [] }, decline: { reasons: [] } };
    return (
      <div className="pmo__act pmo__act--ready">
        <p className="pmo__kick">If you say yes</p>
        <ul className="pmo__writes">{option.writes.map((w, i) => <li key={i}>{w}</li>)}</ul>
        {move.contacts && <p className="pmo__sub">{move.contacts}</p>}
        <div className="pmo__buttons">
          <button type="button" className="pmo__btn pmo__btn--yes" onClick={onAsk} disabled={busy}>{confirmLabel(move)}</button>
          {otherChoices(true)}
        </div>
      </div>
    );
  }

  function otherChoices(inline = false) {
    const r = move.respond || { defer: { days: [], reasons: [] }, decline: { reasons: [] } };
    const body = (
      <>
          <details className="pmo__other pmo2__defer">
            <summary>Not now</summary>
            <div className="pmo2__row">
              <select aria-label="How long" value={deferDays} onChange={(e) => setDeferDays(Number(e.target.value))}>{r.defer.days.map((x) => <option key={x.days} value={x.days}>{x.label}</option>)}</select>
              <select aria-label="Why" value={deferReason} onChange={(e) => setDeferReason(e.target.value)}>{r.defer.reasons.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
              <button type="button" className="pmo__btn" disabled={busy} onClick={() => onRespond('defer', { days: deferDays, reason: deferReason })}>Put it off</button>
            </div>
          </details>
          <details className="pmo__other pmo2__decline">
            <summary>No, not this</summary>
            <div className="pmo2__row">
              <select aria-label="Why not" value={declineReason} onChange={(e) => setDeclineReason(e.target.value)}><option value="">No reason</option>{r.decline.reasons.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
              <button type="button" className="pmo__btn" disabled={busy} onClick={() => onRespond('decline', { reason: declineReason || null })}>Don’t offer it again</button>
            </div>
          </details>
      </>
    );
    return inline ? body : <div className="pmo__buttons">{body}</div>;
  }
}

/** PURE view: everything on screen comes from `state`. */
export function PreparedMoveView({ state, onChoose, onAsk, onConfirm, onCancel, onAgain, onOpenAuthority = null, onDrill = null, onMakeReady = null, onRespond = null, onAnswer = null, onShow = null, onPark = null, onAskOption = null, busy = false, now = Date.now(), debug = false, heldFolded = false, readOnly = false, embedded = false, drafts = false, renderContext = null }) {
  if (!state || state.kind === 'loading') return null;
  if (state.kind === 'pending') return debug ? <p className="pm__dev">prepared move: pending (not ready in time — asking again)</p> : null;
  if (state.kind === 'hidden') {
    return debug ? <p className="pm__dev">prepared move: none ({state.why}{state.reason ? ` — ${state.reason}` : ''})</p> : null;
  }
  // One Now item SAiM could take forward — offered, never done for him.
  if (state.kind === 'offer') {
    return (
      <section className="pmo pmo2 pmo2--offer" aria-label="Something SAiM could make ready">
        <p className="pmo__sub">{state.offer.title}</p>
        {readOnly ? <p className="pmo__sub">Ask SAiM on your phone or desktop to make this ready.</p>
          : <div className="pmo__buttons"><button type="button" className="pmo__btn pmo__btn--yes" onClick={onMakeReady} disabled={busy}>{state.offer.label || 'Make this ready'}</button></div>}
        <p className="pmo__sub">SAiM drafts the real thing for you to review. Nothing is saved, booked or sent until you say yes.</p>
      </section>
    );
  }
  if (state.kind === 'note') return <p className="pmo__sub pmo2__note" role="status">{state.message}</p>;
  const { view } = state;
  const move = view && view.move;
  if (!move) return null;
  if (move.version === 2) return <V2Move state={state} busy={busy} now={now} readOnly={readOnly} onAsk={onAsk} onConfirm={onConfirm} onCancel={onCancel} onAgain={onAgain} onRespond={onRespond} onAnswer={onAnswer} onOpenAuthority={onOpenAuthority} onShow={onShow} onPark={onPark} onAskOption={onAskOption} embedded={embedded} drafts={drafts} renderContext={renderContext} />;

  // ── Held: the page set aside for the morning, and one sentence. No time,
  //    no path, no choice — nothing that implies something is about to happen.
  //    Only what it is based on, folded. ──
  if (view.held || move.held) {
    const basis = { whyItMatters: move.whyItMatters, why: move.why ? { because: move.why.because || [] } : null, evidence: move.evidence };
    return (
      <section className="pmo pmo--held" aria-label="Something SAiM has prepared">
        <p className="pmo__say">{(view.held && view.held.say) || move.prepared.headline}</p>
        {heldFolded ? (
          // Alt (20 Oct 2026): the sentence, and the draft FOLDED — nothing open
          // on the page until he asks to see it.
          <details className="pmo__heldfold">
            <summary>See what I prepared</summary>
            <div className="pmo__stage pmo__stage--held"><Page artefact={move.artefact} /></div>
            <Proof move={basis} label="What I based it on" />
          </details>
        ) : (
          <>
            <div className="pmo__stage pmo__stage--held">
              <Page artefact={move.artefact} />
            </div>
            <Proof move={basis} label="What I based it on" />
          </>
        )}
        {debug && <pre className="pm__dev">{JSON.stringify({ held: view.held, withheldCount: view.withheldCount, elapsedMs: view.elapsedMs }, null, 1)}</pre>}
      </section>
    );
  }

  const options = move.options || [];
  const chosen = options.find((o) => o.id === state.option) || options[0] || null;
  const marks = receiptMarks(state.kind === 'receipt' ? state.receipt : null);
  const art = move.artefact || null;
  const forum = move.forum && move.forum.start ? move.forum : null;
  const f = forum ? parts(forum.start.slice(0, 10)) : null;
  const fTime = forum ? forum.start.slice(11, 16) : null;
  const open = art && art.openCount ? art.openCount : 0;
  // The server's own wording: "7 teams still need agreement", "14 acceptance and
  // rejection criteria remain open". A table row is never called a decision.
  const openLabel = (art && art.openLabel) || null;
  const cellsLabel = (art && art.openCellsLabel) || null;
  // Where the human work happens. Never a person's name: who is in the room is
  // not established here.
  const humanPlace = f ? `in ${f.dow}’s meeting` : 'with the people involved';
  const drill = state.drill || null;
  const go = (d) => onDrill && onDrill(d);
  const back = <button type="button" className="pmo__back" onClick={() => go(null)}>‹ {f ? `${f.dow}’s preparation` : 'Back'}</button>;

  // ── Drill-in: the whole working document. ──
  if (drill === 'doc' && art) {
    return (
      <section className="pmo pmo--drill" aria-label="The draft SAiM prepared">
        {back}
        <div className="pmo__docgrid">
          <FullPage artefact={art} mark={marks.note} />
          <aside className="pmo__margin">
            <p className="pmo__mnote">{art.cited ? 'Drafted from your notes — each section says where it came from. Nothing here is agreed.' : 'Drafted by SAiM. Nothing here is agreed.'}</p>
            {open > 0 && (
              <button type="button" className="pmo__mnote pmo__mnote--human" onClick={() => go('decisions')}>
                <span className="pmo__mbig">{openLabel}</span> {humanPlace}{cellsLabel ? ` · ${cellsLabel}` : ''}
              </button>
            )}
            <div className="pmo__choice">{renderChoice()}</div>
          </aside>
        </div>
      </section>
    );
  }

  // ── Drill-in: the decisions SAiM cannot make. ──
  if (drill === 'decisions' && art && art.decisions) {
    const d = art.decisions;
    return (
      <section className="pmo pmo--drill" aria-label="The decisions still to agree">
        {back}
        <p className="pmo__dkick">{forum ? `${forum.title} · ${f.dow} ${fTime}` : 'Still to agree'}</p>
        <h2 className="pmo__dtitle">{cellsLabel || openLabel}</h2>
        <p className="pmo__dsub">{openLabel} {humanPlace}. The draft already sets out the rest; your notes don’t settle these, so they’re left open.</p>
        <table className="pmo__dtable">
          <thead><tr>{d.columns.map((c, i) => <th key={i} scope="col">{c}</th>)}</tr></thead>
          <tbody>
            {d.rows.map((r, i) => (
              <tr key={i}>
                <th scope="row">{r.who}</th>
                {r.cells.map((c, j) => <td key={j}>{c.open ? <span className="pmo__open">to agree</span> : c.text}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="pmo__dfoot">From the draft “{art.title}”. <button type="button" className="pmo__link" onClick={() => go('doc')}>Read the whole draft</button></p>
        <div className="pmo__choice pmo__choice--drill">{renderChoice()}</div>
      </section>
    );
  }

  // ── The moment: why now → what SAiM has done → what remains human → next. ──
  const slotMins = chosen ? (() => { const [a, b] = chosen.start.split(':').map(Number); const [c, e] = chosen.end.split(':').map(Number); return (c * 60 + e) - (a * 60 + b); })() : null;
  const sp = chosen ? parts(chosen.date) : null;
  return (
    <section className="pmo pmo--meeting" aria-label="Something SAiM has prepared">
      {forum ? (
        <header className="pmo__why">
          <h2 className="pmo__when">{f.dow}, {fTime}</h2>
          <p className="pmo__forum">{forum.title}</p>
        </header>
      ) : <p className="pmo__say">{move.prepared.headline}</p>}

      <div className="pmo__ready">
        <div className="pmo__prep">
          <p className="pmo__kick">What I’ve prepared</p>
          <ol className="pmo__seq">
            <li className="pmo__step is-done">
              <span className="pmo__stepwhat">{marks.note ? 'Draft saved' : 'Draft written'}</span>
              <span className="pmo__stepsub">{art ? art.title : 'The draft'}{art && art.cited ? ', from your notes' : ''}{marks.note ? ` · ${marks.note}` : ''}</span>
            </li>
            {chosen && (
              <li className={`pmo__step ${marks.calendar ? 'is-done' : 'is-found'}`}>
                <span className="pmo__stepwhat">{marks.calendar ? 'Time protected' : 'A window to prepare'} · {sp.short} {sp.day} {sp.mon}, {chosen.start}–{chosen.end}</span>
                <span className="pmo__stepsub">{slotMins} minutes, just you{marks.calendar ? ` · ${marks.calendar}` : ' — free in your diary'}</span>
              </li>
            )}
            {forum && (
              <li className="pmo__step is-human">
                <span className="pmo__stepwhat">{f.short} {f.day} {f.mon}, {fTime} · {forum.title}</span>
                <span className="pmo__stepsub">{openLabel || 'Where this gets agreed'}</span>
              </li>
            )}
          </ol>
        </div>

        <div className="pmo__next">
          {open > 0 && (
            <button type="button" className="pmo__human7" onClick={() => go('decisions')}>
              <span className="pmo__h7n">{open}</span>
              <span className="pmo__h7t">{openLabel ? openLabel.replace(/^\d+\s+/, '') : ''} {humanPlace}</span>
              <span className="pmo__h7s">{cellsLabel ? `${cellsLabel}. See them →` : 'See them →'}</span>
            </button>
          )}
          <div className="pmo__choice">{renderChoice()}</div>
        </div>

        {/* The page: substantial, but after the reason, the human work and the move on a phone. */}
        {art && (
          <button type="button" className="pmo__sheet" onClick={() => go('doc')}>
            <PagePreview artefact={art} mark={marks.note} />
            <span className="pmo__sheetcta">Read the whole draft</span>
          </button>
        )}
      </div>

      <Proof move={move} label="Proof — how this was made" />
      {debug && (
        <pre className="pm__dev">{JSON.stringify({ execution: view.execution, authority: view.authority, budgetMs: view.budgetMs, elapsedMs: view.elapsedMs, withheldCount: view.withheldCount, evidenceExpiresAt: move.evidenceExpiresAt, state: state.kind, server: state.serverError || null }, null, 1)}</pre>
      )}
    </section>
  );

  function renderChoice() {
    // After a confirm: the server's receipt, verbatim.
    if (state.kind === 'receipt') {
      const r = state.receipt;
      return (
        <div className={`pmo__act pmo__act--${r.complete ? 'done' : 'partial'}`} role="status">
          <p className="pmo__actlead">{r.complete ? 'Done' : 'Partly done'}{r.target === 'sandbox' ? ' — practice run, nothing real was changed' : ''}</p>
          <p>{r.plain}</p>
          <ul className="pmo__receipt">
            {receiptLines(r).map((l, i) => (
              <li key={i} className={l.ok ? 'pmo__ok' : 'pmo__notok'}>
                <strong>{l.step}</strong>: {l.status}
                {l.note && <span className="pmo__sub"> {l.note}</span>}
              </li>
            ))}
          </ul>
          <p className="pmo__sub">{r.next}</p>
          {!r.complete && /retry/i.test(r.next || '') && <button type="button" className="pmo__btn" onClick={onAgain} disabled={busy}>Ask again to finish it</button>}
        </div>
      );
    }
    // The one boundary, in the same story: what is ready stays ready; this is
    // the single thing that stands between it and SAiM doing it.
    if (state.kind === 'boundary') {
      return (
        <div className="pmo__act pmo__act--boundary" role="status">
          <p className="pmo__boundary">{state.boundary.say}</p>
          <div className="pmo__buttons">
            {onOpenAuthority && <button type="button" className="pmo__btn pmo__btn--yes" onClick={onOpenAuthority}>Open what SAiM may do</button>}
            <button type="button" className="pmo__btn" onClick={onCancel} disabled={busy}>Not now</button>
          </div>
        </div>
      );
    }
    if (state.kind === 'locked') {
      return <div className="pmo__act pmo__act--stopped" role="status"><p>Nothing was changed. {NOT_ENABLED}</p></div>;
    }
    if (state.kind === 'needs-again' || state.kind === 'refused' || state.kind === 'unknown') {
      return (
        <div className="pmo__act pmo__act--stopped" role="status">
          <p>{state.message}</p>
          <button type="button" className="pmo__btn" onClick={onAgain} disabled={busy}>Look again</button>
        </div>
      );
    }
    // The server's exact confirmation, minted on Nick's click.
    if (state.kind === 'confirming') {
      const c = state.request.confirmation;
      const expired = state.request.expiresAt && Date.parse(state.request.expiresAt) <= now;
      const line = gateLine(view, state.request);
      const canConfirm = state.request.executionEnabled && !expired;
      return (
        <div className="pmo__act pmo__act--confirm">
          <p className="pmo__ask">{c.question}</p>
          <ul className="pmo__writes">{c.writes.map((w, i) => <li key={i}>{w}</li>)}</ul>
          <p className="pmo__sub">{c.contacts}</p>
          {/* The allowance this would use: the server's own sentence when nothing
              stops it; the reason it would be refused when something does. */}
          {line
            ? <p className="pmo__locked">{line}</p>
            : (state.request.authority && state.request.authority.summary && <p className="pmo__allow">{state.request.authority.summary}</p>)}
          {expired && <p className="pmo__locked">This confirmation has expired. Nothing was changed.</p>}
          <div className="pmo__buttons">
            {expired
              ? <button type="button" className="pmo__btn" onClick={onAgain} disabled={busy}>Ask again</button>
              : <button type="button" className="pmo__btn pmo__btn--yes" onClick={onConfirm} disabled={busy || !canConfirm}>Confirm</button>}
            <button type="button" className="pmo__btn" onClick={onCancel} disabled={busy}>Not now</button>
          </div>
        </div>
      );
    }
    if (!chosen) {
      return (
        <div className="pmo__act pmo__act--stopped" role="status">
          <p>I can’t offer a time for this right now.</p>
          <ul className="pmo__sub">{(move.notOffered || []).map((n, i) => <li key={i}>{n.label}: {n.why}</li>)}</ul>
        </div>
      );
    }
    // No standing refusal on the ready surface: the boundary, if there is
    // one, is named only when he reaches for the action.
    return (
      <div className="pmo__act pmo__act--ready">
        {/* The time is on the path above; the server's exact question and the
            two writes come at the confirmation step. */}
        <div className="pmo__buttons">
          <button type="button" className="pmo__btn pmo__btn--yes" onClick={onAsk} disabled={busy}>Protect the time and save the draft</button>
          {options.length > 1 && (
            <details className="pmo__other">
              <summary>Another time</summary>
              <div className="pmo__options" role="radiogroup" aria-label="Which time">
                {options.map((o) => (
                  <label key={o.id} className="pmo__option">
                    <input type="radio" name="pm-option" value={o.id} checked={chosen.id === o.id} onChange={() => onChoose(o.id)} />
                    {o.label}
                  </label>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    );
  }
}

/** Container: owns the clicks. Reads once on mount; writes only on a press. */
/** PURE. What the Surface's situation should know about the move: actionable (with the state headline), held, or nothing. */
export function momentOf(state) {
  // An OFFER is never a moment that leads — it folds behind a real lead (a
  // meeting, a P0) like a held move, so it can never interrupt.
  // ⚠ Its entry is a CONTROL (22 Oct 2026): "Something SAiM could make ready" was a
  // passive bubble that named nothing. It opens on the exact item and its button.
  if (state && state.kind === 'offer') return { kind: 'held', entry: 'See what SAiM can make ready', control: true };
  const v = state && state.view; const m = v && v.move;
  if (!m || state.kind === 'hidden' || state.kind === 'pending' || state.kind === 'loading') return null;
  if (m.version === 2 && !(v.held || m.held)) return { kind: 'actionable', headline: (m.moment && m.moment.headline) || m.prepared.headline, entry: m.plan === 'ask' ? 'SAiM needs one thing from you' : 'Prepared work' };
  if (v.held || m.held) return { kind: 'held', entry: 'Prepared for your next working morning' };
  const f = m.forum && m.forum.start ? parts(m.forum.start.slice(0, 10)) : null;
  // When something else leads, the move is reached through this entry instead.
  const entry = f ? `Prepared for ${f.dow}` : 'Prepared work';
  return { kind: 'actionable', headline: (m.moment && m.moment.headline) || m.prepared.headline, entry };
}

export default function PreparedMove({ call: injectedCall = null, onMoment = null, onOpenAuthority = null, heldFolded = false, readOnly: readOnlyProp = null, show = null, recordId: pinned = null, embedded = false, drafts = false, initial = null, onChanged = null, onPrepared = null, hideContextFor = null, onOpenContext = null }) {
  const call = useMemo(() => injectedCall || makeCall({ fetchImpl: (...a) => fetch(...a), apiUrl, authHeaders }), [injectedCall]);
  // The kiosk can SHOW a prepared move but never confirm or write (its shell
  // declares the platform; no device sniffing).
  const readOnly = useMemo(() => (readOnlyProp != null ? readOnlyProp : platformNow() === 'kiosk'), [readOnlyProp]);
  const sessionId = useMemo(() => newSessionId(), []);
  const debug = useMemo(() => isDebugView(), []);
  // `initial`: a state the SHELL already reached on Nick's press (Drafts' "Open the confirmation"), so no effect here ever requests anything.
  const [state, setState] = useState(() => initial || { kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(Date.now());
  // Tell the Surface what kind of moment this is, so an actionable move is never
  // drawn under a quiet "nothing needs you" heading.
  const moment = momentOf(state);
  const momentKey = moment ? `${moment.kind}:${moment.headline || ''}` : '';
  useEffect(() => { if (onMoment) onMoment(moment); }, [momentKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Read once; while the answer is `pending` (a cold start), ask again a few
  // times, quietly. Never a write — the read stores and mints nothing.
  useEffect(() => {
    let live = true;
    if (initial) return () => { live = false; };
    // A pinned record (the desktop promise card) is read BY ID — never "whatever is current".
    (pinned ? load(call, { recordId: pinned }) : loadWithRetry(call, { onState: (s) => { if (live) setState(s); }, alive: () => live })).then((s) => { if (live) setState(s); });
    return () => { live = false; };
  }, [call, pinned]);
  // Re-render once a second while a confirmation is open, so its expiry shows.
  useEffect(() => {
    if (state.kind !== 'confirming') return undefined;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state.kind]);

  // A drill-in survives a press: the boundary or receipt shows where he is.
  const idOf = (st) => (st && st.view && st.view.move && st.view.move.recordId) || null;
  const run = async (fn) => {
    setBusy(true);
    const before = idOf(state);
    try {
      const next = await fn();
      setState((s) => ({ ...next, drill: s.drill || null }));
      // A receipt, a response, or an answer/park that made a NEW version: whoever lists it reads again.
      if (next && onChanged && (next.kind === 'receipt' || next.kind === 'responded' || (idOf(next) && idOf(next) !== before))) onChanged(next);
    } finally { setBusy(false); }
  };
  const root = useRef(null);
  const first = useRef(true);
  // The Surface asks for ONE record (25 Oct 2026): a card's "open" for a
  // promise's prepared draft, or the draft just prepared from its card.
  useEffect(() => {
    if (!show || !show.recordId) return;
    run(() => load(call, { recordId: show.recordId })).then(() => { if (root.current && root.current.scrollIntoView) root.current.scrollIntoView({ block: 'start' }); });
  }, [show && show.n]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (root.current && root.current.scrollIntoView) root.current.scrollIntoView({ block: 'start' });
  }, [state.drill]);
  return (
    <div ref={root} className="pmo-root"><PreparedMoveView
      state={state}
      busy={busy}
      now={tick}
      debug={debug}
      heldFolded={heldFolded}
      readOnly={readOnly}
      embedded={embedded}
      drafts={drafts}
      // The task's pinned context (22 Oct 2026) — not when the page already shows it for this task.
      renderContext={(taskId) => (hideContextFor != null && Number(hideContextFor) === Number(taskId) ? null : <TaskContext taskId={taskId} call={call} compact onOpen={onOpenContext} label="Context for this task" />)}
      onMakeReady={() => run(async () => {
        const next = await makeReady(call, { offer: state.offer });
        // The exact item just prepared — the shell opens ITS Drafts entry.
        const rid = next && next.preparedRecordId;
        if (rid && onPrepared) onPrepared(rid);
        return next;
      })}
      onRespond={(response, extra) => run(() => respond(call, { view: state.view, response, ...extra }))}
      onAnswer={(questionId, text) => run(() => answer(call, { view: state.view, questionId, text }))}
      onPark={(questionId) => run(() => park(call, { view: state.view, questionId }))}
      onAskOption={(option) => run(() => askToConfirm(call, { view: state.view, option, sessionId }))}
      onChoose={(option) => setState((s) => ({ ...s, option }))}
      onAsk={() => run(() => askToConfirm(call, { view: state.view, option: state.option, sessionId }))}
      onConfirm={() => run(() => confirm(call, { view: state.view, option: state.option, request: state.request }))}
      onCancel={() => setState((s) => ({ kind: 'ready', view: s.view, option: s.option }))}
      onAgain={() => run(() => (pinned ? load(call, { recordId: pinned }) : loadWithRetry(call)))}
      onShow={(recordId) => run(() => load(call, { recordId }))}
      onOpenAuthority={onOpenAuthority}
      onDrill={(drill) => setState((s) => ({ ...s, drill }))}
    /></div>
  );
}
