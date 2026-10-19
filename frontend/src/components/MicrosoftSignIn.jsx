/**
 * The Microsoft device-code sign-in, as shown in Settings (19 Oct 2026).
 * Its own file so the rules pin with a real render, away from AdminPanel's imports.
 */

const _ms = (v) => (typeof v === 'number' ? v : Date.parse(v));

/**
 * PURE. Where THIS sign-in stands: 'signed-in' / 'failed' only when the server
 * recorded an ending AFTER this code was issued; 'expired' past the code's own
 * deadline; otherwise 'waiting'. Never inferred from "an account is cached".
 */
export function signInOutcome(deviceCode, signIn, now = Date.now()) {
  if (!deviceCode) return null;
  const issued = _ms(deviceCode.issuedAt);
  const last = signIn && signIn.last;
  if (last && Number.isFinite(issued) && _ms(last.at) >= issued) return last.ok ? 'signed-in' : 'failed';
  if (deviceCode.expiresAt && now > _ms(deviceCode.expiresAt)) return 'expired';
  return 'waiting';
}

/** The code stays here until Nick presses Close — whatever happens. */
export function DeviceCodePanel({ deviceCode, signIn, outcome, onNewCode, onClose, connecting }) {
  const until = deviceCode.expiresAt ? new Date(deviceCode.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  const error = signIn && signIn.last && !signIn.last.ok ? signIn.last.error : null;
  return (
    <div className="admin-device-code">
      <div className="admin-device-code-label">Enter this code at Microsoft</div>
      <div className="admin-device-code-value">{deviceCode.userCode}</div>
      <div className="admin-device-code-link">
        <a href="https://microsoft.com/devicelogin" target="_blank" rel="noopener noreferrer">
          microsoft.com/devicelogin
        </a>
      </div>
      <div className="admin-device-code-waiting" role="status" aria-live="polite">
        {outcome === 'signed-in' ? 'Signed in. Calendar, tasks and email will catch up within a few minutes.'
          : outcome === 'failed' ? `That sign-in didn’t finish: ${error || 'no reason given'}`
          : outcome === 'expired' ? 'This code has expired.'
          : `Waiting for you to sign in…${until ? ` This code works until ${until}.` : ''}`}
      </div>
      <div className="admin-device-code-actions">
        {(outcome === 'failed' || outcome === 'expired') && (
          <button className="admin-ms-connect-btn" onClick={onNewCode} disabled={connecting}>Get a new code</button>
        )}
        <button className="admin-ms-connect-btn" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
