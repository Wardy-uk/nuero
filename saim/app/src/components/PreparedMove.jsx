import { useEffect, useMemo, useState } from 'react';
import { apiUrl, authHeaders } from '../api';
import { loadWithRetry, askToConfirm, confirm, receiptLines, newSessionId, makeCall } from '../preparedMove.mjs';
import { isDebugView } from '../debugView.mjs';
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

/**
 * Where the work goes: the time SAiM would protect, and the meeting it serves,
 * joined to the page by her light. Times are SLICED, never parsed.
 */
function Path({ option, forum, mark }) {
  if (!option) return null;
  const p = parts(option.date);
  const f = forum && forum.start ? parts(forum.start.slice(0, 10)) : null;
  const mins = (() => { const [a, b] = option.start.split(':').map(Number); const [c, e] = option.end.split(':').map(Number); return (c * 60 + e) - (a * 60 + b); })();
  return (
    <ol className="pmo__path" aria-label="When this happens">
      <li className={`pmo__node pmo__node--slot${mark ? ' pmo__node--placed' : ''}`}>
        <span className="pmo__nodekick">{mark ? 'Protected' : 'Time to protect'}</span>
        <span className="pmo__nodewhen">{p.short} {p.day} {p.mon} · {option.start}–{option.end}</span>
        <span className="pmo__nodewhat">{mins} minutes, just you</span>
        {mark && <span className="pmo__nodemark">{mark}</span>}
      </li>
      {f && (
        <li className="pmo__node pmo__node--forum">
          <span className="pmo__nodekick">The meeting</span>
          <span className="pmo__nodewhen">{f.short} {f.day} {f.mon} · {forum.start.slice(11, 16)}</span>
          <span className="pmo__nodewhat">{forum.title}</span>
        </li>
      )}
    </ol>
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

/** PURE view: everything on screen comes from `state`. */
export function PreparedMoveView({ state, onChoose, onAsk, onConfirm, onCancel, onAgain, busy = false, now = Date.now(), debug = false }) {
  if (!state || state.kind === 'loading') return null;
  if (state.kind === 'pending') return debug ? <p className="pm__dev">prepared move: pending (not ready in time — asking again)</p> : null;
  if (state.kind === 'hidden') {
    return debug ? <p className="pm__dev">prepared move: none ({state.why}{state.reason ? ` — ${state.reason}` : ''})</p> : null;
  }
  const { view } = state;
  const move = view && view.move;
  if (!move) return null;

  // ── Held: the page set aside for the morning, and one sentence. No time,
  //    no path, no choice — nothing that implies something is about to happen.
  //    Only what it is based on, folded. ──
  if (view.held || move.held) {
    const basis = { whyItMatters: move.whyItMatters, why: move.why ? { because: move.why.because || [] } : null, evidence: move.evidence };
    return (
      <section className="pmo pmo--held" aria-label="Something SAiM has prepared">
        <p className="pmo__say">{(view.held && view.held.say) || move.prepared.headline}</p>
        <div className="pmo__stage pmo__stage--held">
          <Page artefact={move.artefact} />
        </div>
        <Proof move={basis} label="What I based it on" />
        {debug && <pre className="pm__dev">{JSON.stringify({ held: view.held, withheldCount: view.withheldCount, elapsedMs: view.elapsedMs }, null, 1)}</pre>}
      </section>
    );
  }

  const options = move.options || [];
  const chosen = options.find((o) => o.id === state.option) || options[0] || null;
  const marks = receiptMarks(state.kind === 'receipt' ? state.receipt : null);

  // One relationship, read in one look: the page SAiM made → the time she
  // would protect for it → the meeting it serves → the one choice.
  return (
    <section className="pmo" aria-label="Something SAiM has prepared">
      <p className="pmo__say">{move.prepared.headline}</p>

      <div className="pmo__stage">
        <Page artefact={move.artefact} mark={marks.note} />
        <div className="pmo__aside">
          <Path option={chosen} forum={move.forum} mark={marks.calendar} />
          <div className="pmo__choice">{renderChoice()}</div>
        </div>
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
          {line && <p className="pmo__locked">{line}</p>}
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
    const line = gateLine(view, null);
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
        {line && <p className="pmo__locked">{line}</p>}
      </div>
    );
  }
}

/** Container: owns the clicks. Reads once on mount; writes only on a press. */
/** PURE. What the Surface's situation should know about the move: actionable (with the state headline), held, or nothing. */
export function momentOf(state) {
  const v = state && state.view; const m = v && v.move;
  if (!m || state.kind === 'hidden' || state.kind === 'pending' || state.kind === 'loading') return null;
  if (v.held || m.held) return { kind: 'held' };
  return { kind: 'actionable', headline: (m.moment && m.moment.headline) || m.prepared.headline };
}

export default function PreparedMove({ call: injectedCall = null, onMoment = null }) {
  const call = useMemo(() => injectedCall || makeCall({ fetchImpl: (...a) => fetch(...a), apiUrl, authHeaders }), [injectedCall]);
  const sessionId = useMemo(() => newSessionId(), []);
  const debug = useMemo(() => isDebugView(), []);
  const [state, setState] = useState({ kind: 'loading' });
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
    loadWithRetry(call, { onState: (s) => { if (live) setState(s); }, alive: () => live }).then((s) => { if (live) setState(s); });
    return () => { live = false; };
  }, [call]);
  // Re-render once a second while a confirmation is open, so its expiry shows.
  useEffect(() => {
    if (state.kind !== 'confirming') return undefined;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state.kind]);

  const run = async (fn) => { setBusy(true); try { setState(await fn()); } finally { setBusy(false); } };
  return (
    <PreparedMoveView
      state={state}
      busy={busy}
      now={tick}
      debug={debug}
      onChoose={(option) => setState((s) => ({ ...s, option }))}
      onAsk={() => run(() => askToConfirm(call, { view: state.view, option: state.option, sessionId }))}
      onConfirm={() => run(() => confirm(call, { view: state.view, option: state.option, request: state.request }))}
      onCancel={() => setState((s) => ({ kind: 'ready', view: s.view, option: s.option }))}
      onAgain={() => run(() => loadWithRetry(call))}
    />
  );
}
