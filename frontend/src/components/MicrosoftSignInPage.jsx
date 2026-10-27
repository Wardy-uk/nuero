import React, { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../api';
import { signInOutcome } from './MicrosoftSignIn';
import usePushNotifications, { deviceLabel, pushUnavailableReason } from '../usePushNotifications';
import './AdminPanel.css';
import './MicrosoftSignInPage.css';

/**
 * The Microsoft sign-in, one press from the menu (27 Oct 2026).
 *
 * Nurtur now forces a fresh sign-in about daily. Opening this page asks for a
 * code straight away — no Connect button, no trip to Settings — and one press
 * copies it and opens Microsoft's page. It watches for the sign-in finishing
 * and says so; the code stays on screen until it does or expires.
 */
export default function MicrosoftSignInPage({ onNavigate }) {
  const [due, setDue] = useState(null);
  const [code, setCode] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const started = useRef(false);

  const refresh = async () => {
    try {
      const r = await fetch(apiUrl('/api/microsoft/signin'));
      if (r.ok) setDue(await r.json());
    } catch { /* the next poll tries again */ }
  };

  const getCode = async () => {
    setError(null);
    setCopied(false);
    try {
      const r = await fetch(apiUrl('/api/microsoft/auth'), { method: 'POST' });
      const data = await r.json();
      if (!r.ok || data.error) setError(data.error || `NEURO answered ${r.status}`);
      else setCode(data);
    } catch (e) { setError(e.message); }
    refresh();
  };

  useEffect(() => {
    if (started.current) return;   // one code per visit, even under StrictMode
    started.current = true;
    getCode();
  }, []);

  useEffect(() => {
    const t = setInterval(() => { setNow(Date.now()); refresh(); }, 3000);
    return () => clearInterval(t);
  }, []);

  const outcome = code ? signInOutcome(code, due && due.signIn, now) : null;

  const copyAndOpen = async () => {
    try { await navigator.clipboard.writeText(code.userCode); setCopied(true); } catch { setCopied(false); }
    window.open(code.verificationUri || 'https://microsoft.com/devicelogin', '_blank', 'noopener');
  };

  const until = code && code.expiresAt
    ? new Date(code.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;

  return (
    <div className="ms-signin-page">
      <h2>Sign in to Microsoft</h2>
      {due && due.say && outcome !== 'signed-in' && <p className="ms-signin-say">{due.say}</p>}

      {error && (
        <div className="ms-signin-error">
          Couldn’t get a sign-in code: {error}
          <div><button className="admin-ms-connect-btn" onClick={getCode}>Try again</button></div>
        </div>
      )}

      {!code && !error && <p>Getting a code from Microsoft…</p>}

      {code && outcome === 'signed-in' && (
        <div className="ms-signin-done" role="status">
          Signed in. Calendar, tasks and email will catch up within a few minutes.
          {due && due.expectedExpiryAt && (
            <> Next sign-in expected about {new Date(due.expectedExpiryAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.</>
          )}
          <div><button className="admin-ms-connect-btn" onClick={() => onNavigate && onNavigate('today')}>Back to Now</button></div>
        </div>
      )}

      {code && outcome !== 'signed-in' && (
        <div className="admin-device-code ms-signin-code">
          <div className="admin-device-code-label">Your code</div>
          <div className="admin-device-code-value">{code.userCode}</div>
          {(outcome === 'waiting') && (
            <button className="ms-signin-go" onClick={copyAndOpen}>
              {copied ? 'Copied — paste it on Microsoft’s page' : 'Copy code and open Microsoft'}
            </button>
          )}
          <div className="admin-device-code-waiting" role="status" aria-live="polite">
            {outcome === 'failed' ? `That sign-in didn’t finish: ${(due && due.signIn && due.signIn.last && due.signIn.last.error) || 'no reason given'}`
              : outcome === 'expired' ? 'This code has expired.'
              : `Waiting for you to sign in…${until ? ` The code works until ${until}.` : ''}`}
          </div>
          {(outcome === 'failed' || outcome === 'expired') && (
            <button className="admin-ms-connect-btn" onClick={getCode}>Get a new code</button>
          )}
        </div>
      )}

      <DesktopAlerts />
    </div>
  );
}

/** Turn on a notification on THIS computer when the sign-in expires (27 Oct 2026). */
function DesktopAlerts() {
  const { supported, subscribed, error, manualSubscribe } = usePushNotifications();
  if (deviceLabel() !== 'desktop') return null;
  const why = pushUnavailableReason();
  return (
    <div className="ms-signin-alerts">
      <h3>Notify this computer</h3>
      {why || !supported ? <p className="ms-signin-say">{why || 'This browser does not offer push notifications.'}</p>
        : subscribed ? <p className="ms-signin-say">On. This computer gets a notification when the Microsoft sign-in expires, and nothing else NEURO sends to your phone.</p>
        : (
          <>
            <p className="ms-signin-say">Get a notification on this computer when the Microsoft sign-in expires. Only that — none of the phone’s nudges.</p>
            <button className="admin-ms-connect-btn" onClick={manualSubscribe}>Turn on</button>
          </>
        )}
      {error && <p className="ms-signin-say">Couldn’t turn it on: {error}</p>}
    </div>
  );
}
