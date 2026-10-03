import { useEffect, useState } from 'react';
import './ConnectionStatus.css';

// The connection banner — the one place the kiosk says whether what you are
// looking at came from NEURO.
//
// Build 10I: it used to read the provenance block of the RETIRED state engine
// (stateEngine / inference / seed), a second model built beside NEURO's. It now
// asks saim/backend's passthrough for NEURO's situational context and reports
// REACH only — the kiosk renders NEURO's decision and has no opinion of its own
// about what matters.
//
// Design rules (unchanged):
//   * Live is SILENT. A permanent green badge is a badge nobody reads by week two.
//   * Every non-live state says what is wrong, never a reassuring summary.
//   * Gaps in individual inputs are NOT a banner: they are routine, shown where
//     they apply, and a banner lit by them is lit for ever (the seven weeks of
//     "partly live" this banner once showed over a healthy read).

const POLL_MS = 60000;

const LABEL = {
  'not-configured': 'NEURO not configured',
  unauthorized: 'NEURO refused SAiM',
  unreachable: 'NEURO unreachable',
  timeout: 'NEURO not answering',
  'upstream-error': 'NEURO error',
  'unexpected-shape': 'NEURO answered oddly',
  'kiosk-server': 'SAiM server unreachable',
};

const MESSAGE = {
  'not-configured': 'This screen has not been told where NEURO is, or how to sign in.',
  unauthorized: 'NEURO rejected the desk screen’s credential — what you see may be old.',
  unreachable: 'The desk screen cannot reach NEURO — what you see may be old.',
  timeout: 'NEURO is not answering in time — what you see may be old.',
  'upstream-error': 'NEURO returned an error — what you see may be old.',
  'unexpected-shape': 'NEURO’s answer was not the shape expected — treat this screen as unverified.',
  'kiosk-server': 'The desk screen cannot reach its own SAiM server.',
};

export default function ConnectionStatus() {
  const [state, setState] = useState({ reason: null, detail: null, checked: false });

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch('/api/attention/context', { headers: { accept: 'application/json' } });
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !body) setState({ reason: 'kiosk-server', detail: null, checked: true });
        else if (body.available === false) setState({ reason: body.reason || 'unreachable', detail: body.detail || null, checked: true });
        else setState({ reason: null, detail: null, checked: true });
      } catch {
        if (!cancelled) setState({ reason: 'kiosk-server', detail: null, checked: true });
      }
    }
    check();
    const t = setInterval(check, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (!state.checked || !state.reason) return null;
  const tone = state.reason === 'timeout' ? 'warn' : 'danger';
  return (
    <div className={`connstatus connstatus--${tone}`} role="status" aria-live="polite">
      <span className="connstatus__label">{LABEL[state.reason] || 'Unverified'}</span>
      <span className="connstatus__message">{MESSAGE[state.reason] || 'What you see may be old.'}</span>
      {state.reason === 'not-configured' && state.detail && <span className="connstatus__detail">{state.detail}</span>}
    </div>
  );
}
