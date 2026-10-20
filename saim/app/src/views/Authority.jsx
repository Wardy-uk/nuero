import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiUrl, authHeaders } from '../api';
import { makeCall } from '../preparedMove.mjs';
import { loadStatus, previewGrant, grant, revoke, stopAll, previewResume, resume, receiptSummary } from '../authority.mjs';
import './Authority.css';

// What SAiM may do (20 Oct 2026) — the one place Nick sees and changes SAiM's
// authority. Two gates, both of which must be open, shown as two separate
// facts; what is left today; the move in progress; past receipts; and a stop.
//
// ⚠ Every sentence is the server's (saim-authority-v1). This screen never opens
//   the device lock — that only changes on the Pi — and never claims something
//   happened without the receipt that says it did.

const money = (p) => `£${(p / 100).toFixed(0)}`;
const when = (iso) => { try { return new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

/** PURE view: everything comes from `state` and `ui`. */
export function AuthorityView({ state, ui = { kind: 'idle' }, busy = false, onAllow, onGrant, onRevoke, onStop, onAskResume, onResume, onCancel }) {
  if (!state || state.kind === 'loading') return <section className="auth" aria-busy="true" />;
  if (state.kind === 'unreadable') {
    return (
      <section className="auth">
        <h1 className="auth__title">What SAiM may do</h1>
        <p className="auth__gap" role="status">{state.message} SAiM can’t act while this can’t be read.</p>
      </section>
    );
  }
  const s = state.status;
  const a = s.allowance;
  return (
    <section className="auth" aria-label="What SAiM may do">
      <header className="auth__head">
        <h1 className="auth__title">What SAiM may do</h1>
        <p className="auth__summary">{s.summary}</p>
      </header>

      {s.stopped && (
        <div className="auth__stopped" role="status">
          <p><strong>All SAiM actions are stopped.</strong>{s.stoppedSince ? ` Since ${when(s.stoppedSince)}.` : ''}</p>
          {ui.kind === 'resuming' ? (
            <div className="auth__confirm">
              {ui.preview.statement.map((l, i) => <p key={i}>{l}</p>)}
              <div className="auth__buttons">
                <button type="button" className="auth__btn auth__btn--yes" onClick={onResume} disabled={busy}>Resume SAiM’s actions</button>
                <button type="button" className="auth__btn" onClick={onCancel} disabled={busy}>Keep them stopped</button>
              </div>
            </div>
          ) : <button type="button" className="auth__btn" onClick={onAskResume} disabled={busy}>Resume…</button>}
        </div>
      )}

      <ol className="auth__gates" aria-label="Both must be open before SAiM can act">
        <li className={`auth__gate auth__gate--${s.gates.device.open ? 'open' : 'shut'}`}>
          <span className="auth__gatemark" aria-hidden="true">{s.gates.device.open ? '○' : '●'}</span>
          <div>
            <p className="auth__gatesay">{s.gates.device.say}</p>
            <p className="auth__gatesub">{s.gates.device.open ? 'Changed on the Pi.' : 'Only you can change this, on the Pi. Nothing on this screen opens it.'}</p>
          </div>
        </li>
        <li className={`auth__gate auth__gate--${s.grant ? 'open' : 'shut'}`}>
          <span className="auth__gatemark" aria-hidden="true">{s.grant ? '○' : '●'}</span>
          <div>
            <p className="auth__gatesay">{s.gates.allowance.say}</p>
            {s.grant
              ? <p className="auth__gatesub">Given {when(s.grant.grantedAt)}. It ends at midnight.</p>
              : <p className="auth__gatesub">Giving an allowance does not unlock the device.</p>}
            {!s.grant && ui.kind !== 'granting' && !s.stopped && (
              <button type="button" className="auth__btn" onClick={onAllow} disabled={busy}>Allow one block and one note today…</button>
            )}
            {s.grant && <button type="button" className="auth__btn auth__btn--quiet" onClick={onRevoke} disabled={busy}>Take today’s allowance away</button>}
          </div>
        </li>
      </ol>

      {ui.kind === 'granting' && (
        <div className="auth__confirm" role="group" aria-label="The allowance you would give">
          <p className="auth__confirmhead">You would allow exactly this:</p>
          <ul>{ui.preview.statement.map((l, i) => <li key={i}>{l}</li>)}</ul>
          <div className="auth__buttons">
            <button type="button" className="auth__btn auth__btn--yes" onClick={onGrant} disabled={busy}>Give this allowance</button>
            <button type="button" className="auth__btn" onClick={onCancel} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}

      <section className="auth__left" aria-label="Left today">
        <p className="auth__label">Left today · {s.dayLabel}</p>
        <dl className="auth__tiles">
          <div><dt>Calendar blocks</dt><dd>{a.blocks.left}<small> of {a.blocks.granted}</small></dd></div>
          <div><dt>Minutes</dt><dd>{a.minutes.left}<small> of {a.minutes.granted}</small></dd></div>
          <div><dt>New notes</dt><dd>{a.notes.left}<small> of {a.notes.granted}</small></dd></div>
          <div><dt>Money</dt><dd>{money(a.spendPence)}</dd></div>
          <div><dt>People contacted</dt><dd>{a.contacts}</dd></div>
        </dl>
      </section>

      <section className="auth__active" aria-label="Today’s move">
        <p className="auth__label">Today’s move</p>
        <p>{s.active.say}</p>
      </section>

      <section className="auth__receipts" aria-label="Receipts">
        <p className="auth__label">Receipts</p>
        {s.receipts.length === 0
          ? <p className="auth__muted">None yet. A receipt appears here only after SAiM has carried something out and read it back.</p>
          : (
            <ul>
              {s.receipts.map((r, i) => (
                <li key={i} className={r.complete ? 'auth__rc auth__rc--done' : 'auth__rc auth__rc--partial'}>
                  <p className="auth__rcwhen">{when(r.at)}{r.target === 'sandbox' ? ' · practice run' : ''}</p>
                  <p>{r.plain}</p>
                  <ul className="auth__rcsteps">{receiptSummary(r).map((l, j) => <li key={j}>{l}</li>)}</ul>
                </li>
              ))}
            </ul>
          )}
      </section>

      {ui.kind === 'error' && <p className="auth__gap" role="alert">{ui.message}</p>}
      {ui.kind === 'done' && <p className="auth__note" role="status">{ui.message}</p>}

      {!s.stopped && (
        <button type="button" className="auth__stop" onClick={onStop} disabled={busy}>Stop all SAiM actions</button>
      )}
    </section>
  );
}

/** Container: reads on mount; every change is a press. */
export default function Authority({ call: injectedCall = null }) {
  const call = useMemo(() => injectedCall || makeCall({ fetchImpl: (...a) => fetch(...a), apiUrl, authHeaders }), [injectedCall]);
  const [state, setState] = useState({ kind: 'loading' });
  const [ui, setUi] = useState({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => setState(await loadStatus(call)), [call]);
  useEffect(() => { reload(); }, [reload]);
  const act = async (fn, { thenReload = true } = {}) => {
    setBusy(true);
    try { const r = await fn(); setUi(r); if (thenReload && r.kind !== 'granting' && r.kind !== 'resuming') await reload(); } finally { setBusy(false); }
  };
  return (
    <AuthorityView
      state={state}
      ui={ui}
      busy={busy}
      onAllow={() => act(() => previewGrant(call, { blockMinutes: 30 }))}
      onGrant={() => act(() => grant(call, ui.preview))}
      onRevoke={() => act(() => revoke(call))}
      onStop={() => act(() => stopAll(call))}
      onAskResume={() => act(() => previewResume(call))}
      onResume={() => act(() => resume(call, ui.preview))}
      onCancel={() => setUi({ kind: 'idle' })}
    />
  );
}
