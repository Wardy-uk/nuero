import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiUrl, authHeaders } from '../api';
import { makeCall } from '../preparedMove.mjs';
import { loadStatus, previewGrant, grant, revoke, stopAll, previewResume, resume, receiptSummary } from '../authority.mjs';
import './Authority.css';

// What SAiM may do (22 Oct 2026) — ONE plain control. Nick allows SAiM to carry
// out up to three prepared moves today; each move still shows exactly what it
// will do and waits for his own confirmation. Then what is left today, today's
// activity, and Stop all SAiM actions. No implementation words: the server-side
// switch reads as "SAiM is ready" (or that carrying out is switched off).
//
// ⚠ Every sentence is the server's (saim-authority-v1). This screen never
//   changes the server switch, and never claims something happened without
//   the receipt that says it did.

const when = (iso) => { try { return new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const onDay = (iso, day) => { try { return new Date(iso).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10) === day; } catch { return false; } };

/** The words on the one control. Pinned by a test. */
export const ALLOW_LABEL = 'Allow SAiM to carry out up to three prepared moves today';

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
  const todays = (s.receipts || []).filter((r) => onDay(r.at, s.day));
  return (
    <section className="auth" aria-label="What SAiM may do">
      <header className="auth__head">
        <h1 className="auth__title">What SAiM may do</h1>
        <p className={`auth__ready auth__ready--${s.gates.device.open ? 'on' : 'off'}`}>{s.gates.device.say}</p>
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

      <section className="auth__control" aria-label="Today’s allowance">
        {s.grant ? (
          <>
            <p className="auth__left">{s.leftToday}</p>
            <p className="auth__sub">Each move still waits for you to confirm it. The allowance ends at midnight.</p>
            <button type="button" className="auth__btn auth__btn--quiet" onClick={onRevoke} disabled={busy}>Take today’s allowance away</button>
          </>
        ) : ui.kind === 'granting' ? (
          <div className="auth__confirm" role="group" aria-label="What you would allow">
            <ul>{ui.preview.statement.map((l, i) => <li key={i}>{l}</li>)}</ul>
            <div className="auth__buttons">
              <button type="button" className="auth__btn auth__btn--yes" onClick={onGrant} disabled={busy}>Allow this</button>
              <button type="button" className="auth__btn" onClick={onCancel} disabled={busy}>Cancel</button>
            </div>
          </div>
        ) : (
          !s.stopped && <button type="button" className="auth__btn auth__btn--yes auth__allow" onClick={onAllow} disabled={busy}>{ALLOW_LABEL}</button>
        )}
      </section>

      <section className="auth__today" aria-label="Today">
        <p className="auth__label">Today · {s.dayLabel}</p>
        <p>{s.active.say}</p>
        {todays.length > 0 && (
          <ul className="auth__rcs">
            {todays.map((r, i) => (
              <li key={i} className={r.complete ? 'auth__rc auth__rc--done' : 'auth__rc auth__rc--partial'}>
                <p className="auth__rcwhen">{when(r.at)}{r.target === 'sandbox' ? ' · practice run, nothing real changed' : r.verified ? ' · done and read back' : ''}{r.title ? ` · ${r.title}` : ''}</p>
                <ul className="auth__rcsteps">{receiptSummary(r).map((l, j) => <li key={j}>{l}</li>)}</ul>
                {/* Receipt truth: the exact block time and, for a live note only, where it is. */}
                {r.when && <p className="auth__rcwhen">{r.target === 'sandbox' ? 'Sandbox block' : 'Calendar'} · {r.when}</p>}
                {r.notePath && r.target !== 'sandbox' && <p className="auth__rcwhen">Note · <code>{r.notePath}</code></p>}
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
      onAllow={() => act(() => previewGrant(call))}
      onGrant={() => act(() => grant(call, ui.preview))}
      onRevoke={() => act(() => revoke(call))}
      onStop={() => act(() => stopAll(call))}
      onAskResume={() => act(() => previewResume(call))}
      onResume={() => act(() => resume(call, ui.preview))}
      onCancel={() => setUi({ kind: 'idle' })}
    />
  );
}
