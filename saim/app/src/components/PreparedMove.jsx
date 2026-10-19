import { useEffect, useMemo, useState } from 'react';
import { apiUrl, authHeaders } from '../api';
import { loadWithRetry, askToConfirm, confirm, receiptLines, newSessionId, makeCall } from '../preparedMove.mjs';
import { isDebugView } from '../debugView.mjs';
import './PreparedMove.css';

// SAiM's one prepared decision, inside her presence on the Surface.
//
// ⚠ Nothing renders until NEURO says a trustworthy move exists. Nothing is
//   stored, minted or written until Nick presses a button. Everything said
//   about the move is the server's — the view composes no sentence about it.
// ⚠ The primary view is five things: what SAiM prepared, the one open
//   decision, the question with its time, the exact two changes, and one button.
//   Everything else is behind a disclosure.

/** Plain words for "execution is not available here" — no flag or variable names. */
export const NOT_ENABLED = 'This is ready to review. Changes aren’t enabled here yet.';

/** PURE view: everything on screen comes from `state`. */
export function PreparedMoveView({ state, onChoose, onAsk, onConfirm, onCancel, onAgain, busy = false, now = Date.now(), debug = false }) {
  if (!state || state.kind === 'loading') return null;
  // Still being checked: nothing for Nick — no "no move", no spinner, no status.
  if (state.kind === 'pending') return debug ? <p className="pm__dev">prepared move: pending (not ready in time — asking again)</p> : null;
  if (state.kind === 'hidden') {
    // Nothing for Nick. A developer can see why.
    return debug ? <p className="pm__dev">prepared move: none ({state.why}{state.reason ? ` — ${state.reason}` : ''})</p> : null;
  }
  const { view } = state;
  const move = view && view.move;
  if (!move) return null;
  // Off duty or on leave: HELD. One quiet sentence, and the draft behind a
  // disclosure. No time, question, change list, button or confirmation — the
  // next working window prepares and re-checks it before it can be acted on.
  if (view.held || move.held) {
    return (
      <section className="pm pm--held" aria-label="Something SAiM has prepared">
        <p className="pm__headline">{(view.held && view.held.say) || move.prepared.headline}</p>
        <details className="pm__more">
          <summary>See what I prepared</summary>
          {move.whyItMatters && <p>{move.whyItMatters}</p>}
          {(move.unresolved || []).map((u, i) => <p key={i}>{u.what}</p>)}
          {move.why && move.why.goal && <p>{move.why.goal}</p>}
          {move.why && <ul>{move.why.because.map((b, i) => <li key={i}>{b}</li>)}</ul>}
          <pre className="pm__draft">{move.draft.markdown}</pre>
          <ul className="pm__evidence">
            {move.evidence.map((e, i) => (
              <li key={i}>{e.fact}{e.caveat && <span className="pm__sub"> {e.caveat}</span>}</li>
            ))}
          </ul>
        </details>
        {debug && <pre className="pm__dev">{JSON.stringify({ held: view.held, withheldCount: view.withheldCount, elapsedMs: view.elapsedMs }, null, 1)}</pre>}
      </section>
    );
  }
  const enabled = Boolean(view.execution && view.execution.enabled);
  const options = move.options || [];
  const chosen = options.find((o) => o.id === state.option) || options[0] || null;
  const open = (move.unresolved || [])[0] || null;

  return (
    <section className="pm" aria-label="Something SAiM has prepared">
      <p className="pm__headline">{move.prepared.headline}</p>
      {open && <p className="pm__open">{open.what}</p>}

      {renderAction()}

      <details className="pm__more">
        <summary>Why this, and what SAiM won’t do</summary>
        <p>{move.prepared.detail}</p>
        {move.whyItMatters && <p>{move.whyItMatters}</p>}
        {(move.unresolved || []).map((u, i) => (
          <p key={i}>{u.what}{u.detail && u.detail.length > 1 && <span className="pm__sub"> {u.detail.join(', ')}</span>}</p>
        ))}
        {move.why.goal && <p>{move.why.goal}</p>}
        <ul>{move.why.because.map((b, i) => <li key={i}>{b}</li>)}</ul>
        {move.why.doneWhen && <p className="pm__sub">Done when: {move.why.doneWhen}</p>}
        <p>{move.contacts}</p>
        <p>{move.nothingElse}</p>
        {move.why.willNot.length > 0 && <ul>{move.why.willNot.map((b, i) => <li key={i}>{b}</li>)}</ul>}
      </details>
      <details className="pm__more">
        <summary>Read the draft</summary>
        <pre className="pm__draft">{move.draft.markdown}</pre>
      </details>
      <details className="pm__more">
        <summary>What this is based on</summary>
        <ul className="pm__evidence">
          {move.evidence.map((e, i) => (
            <li key={i}>{e.fact}{e.caveat && <span className="pm__sub"> {e.caveat}</span>}</li>
          ))}
        </ul>
      </details>
      {debug && (
        <pre className="pm__dev">{JSON.stringify({ execution: view.execution, budgetMs: view.budgetMs, elapsedMs: view.elapsedMs, withheldCount: view.withheldCount, evidenceExpiresAt: move.evidenceExpiresAt, state: state.kind, server: state.serverError || null }, null, 1)}</pre>
      )}
    </section>
  );

  function renderAction() {
    // ── After a confirm: the server's receipt, verbatim. ──
    if (state.kind === 'receipt') {
      const r = state.receipt;
      return (
        <div className={`pm__act pm__act--${r.complete ? 'done' : 'partial'}`} role="status">
          <p className="pm__label">{r.complete ? 'Done' : 'Partly done'}</p>
          <p>{r.plain}</p>
          <ul className="pm__receipt">
            {receiptLines(r).map((l, i) => (
              <li key={i} className={l.ok ? 'pm__ok' : 'pm__notok'}>
                <strong>{l.step}</strong>: {l.status}
                {l.target && <span className="pm__sub"> — {l.target}</span>}
                {l.note && <span className="pm__sub"> {l.note}</span>}
              </li>
            ))}
          </ul>
          <p className="pm__sub">{r.next}</p>
          {!r.complete && /retry/i.test(r.next || '') && <button type="button" className="pm__btn" onClick={onAgain} disabled={busy}>Ask again to finish it</button>}
        </div>
      );
    }
    if (state.kind === 'locked') {
      return (
        <div className="pm__act pm__act--stopped" role="status">
          <p>Nothing was changed. {NOT_ENABLED}</p>
        </div>
      );
    }
    if (state.kind === 'needs-again' || state.kind === 'refused' || state.kind === 'unknown') {
      return (
        <div className="pm__act pm__act--stopped" role="status">
          <p>{state.message}</p>
          <button type="button" className="pm__btn" onClick={onAgain} disabled={busy}>Look again</button>
        </div>
      );
    }

    // ── The server's exact confirmation, minted on Nick's click. ──
    if (state.kind === 'confirming') {
      const c = state.request.confirmation;
      const expired = state.request.expiresAt && Date.parse(state.request.expiresAt) <= now;
      const canConfirm = state.request.executionEnabled && !expired;
      return (
        <div className="pm__act pm__act--confirm">
          <p className="pm__ask">{c.question}</p>
          <ul className="pm__writes">{c.writes.map((w, i) => <li key={i}>{w}</li>)}</ul>
          {!state.request.executionEnabled && <p className="pm__locked">{NOT_ENABLED}</p>}
          {expired && <p className="pm__locked">This confirmation has expired. Nothing was changed.</p>}
          <div className="pm__buttons">
            {expired
              ? <button type="button" className="pm__btn" onClick={onAgain} disabled={busy}>Ask again</button>
              : <button type="button" className="pm__btn pm__btn--yes" onClick={onConfirm} disabled={busy || !canConfirm}>Confirm</button>}
            <button type="button" className="pm__btn" onClick={onCancel} disabled={busy}>Not now</button>
          </div>
        </div>
      );
    }

    // ── Ready: the question, the two changes, before anything is minted. ──
    if (!chosen) {
      return (
        <div className="pm__act pm__act--stopped" role="status">
          <p>I can’t offer a time for this right now.</p>
          <ul className="pm__sub">{(move.notOffered || []).map((n, i) => <li key={i}>{n.label}: {n.why}</li>)}</ul>
        </div>
      );
    }
    return (
      <div className="pm__act">
        <p className="pm__ask">{chosen.question}</p>
        <ul className="pm__writes">{chosen.writes.map((w, i) => <li key={i}>{w}</li>)}</ul>
        {!enabled && <p className="pm__locked">{NOT_ENABLED}</p>}
        <div className="pm__buttons">
          <button type="button" className="pm__btn pm__btn--yes" onClick={onAsk} disabled={busy}>Ask to confirm</button>
        </div>
        {options.length > 1 && (
          <details className="pm__more">
            <summary>Other times</summary>
            <div className="pm__options" role="radiogroup" aria-label="Which time">
              {options.map((o) => (
                <label key={o.id} className="pm__option">
                  <input type="radio" name="pm-option" value={o.id} checked={chosen.id === o.id} onChange={() => onChoose(o.id)} />
                  {o.label}
                </label>
              ))}
            </div>
          </details>
        )}
      </div>
    );
  }
}

/** Container: owns the clicks. Reads once on mount; writes only on a press. */
export default function PreparedMove({ call: injectedCall = null }) {
  const call = useMemo(() => injectedCall || makeCall({ fetchImpl: (...a) => fetch(...a), apiUrl, authHeaders }), [injectedCall]);
  const sessionId = useMemo(() => newSessionId(), []);
  const debug = useMemo(() => isDebugView(), []);
  const [state, setState] = useState({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(Date.now());

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
