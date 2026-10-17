import React, { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../api';

async function getJson(path, init) {
  const r = await fetch(apiUrl(path), init);
  return r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
}

/** The one-time Bright connection. Mounted here and in Settings → Integrations. */
export function BrightConnectCard({ connection, onChange }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [conn, setConn] = useState(connection || null);

  const load = useCallback(async () => {
    const d = await getJson('/api/energy/connection');
    if (d.ok) setConn(d.connection);
  }, []);
  useEffect(() => { if (!connection) load(); else setConn(connection); }, [connection, load]);

  const connect = async () => {
    setBusy(true); setError(null);
    const d = await getJson('/api/energy/credentials', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    });
    setPassword(''); // the box never holds it after a press, success or not
    setBusy(false);
    if (!d.ok) { setError(d.error || 'That did not work.'); return; }
    setUsername('');
    await load();
    onChange && onChange();
  };
  const disconnect = async () => {
    setBusy(true);
    await getJson('/api/energy/credentials', { method: 'DELETE' });
    setBusy(false);
    await load();
    onChange && onChange();
  };

  return (
    <div className="admin-section energy-connect">
      <div className="admin-section-title">Bright (smart meters)</div>
      <div className="admin-ms-section">
        {!conn?.configured ? (
          <>
            <p className="admin-hint">
              Sign in with your Bright app account. NEURO checks it with Bright first and keeps it only if
              Bright accepts it — on the Pi, never shown again, used only to renew the 7-day session.
            </p>
            <div className="admin-inline-form">
              <input type="email" value={username} placeholder="Bright username (email)" autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
              <input type="password" value={password} placeholder="Bright password" autoComplete="off"
                onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && username && password && connect()} />
              <button className="admin-btn" disabled={!username || !password || busy} onClick={connect}>
                {busy ? 'Checking with Bright…' : 'Connect Bright'}
              </button>
            </div>
          </>
        ) : (
          <>
            {conn.state === 'rejected' ? (
              <div className="admin-error">Bright refused the stored login ({conn.reason}). NEURO has stopped trying so the account is not locked — reconnect with the current password.</div>
            ) : (
              <p className="admin-hint">
                Connected{conn.lastAuthAt ? ` · last signed in ${new Date(conn.lastAuthAt).toLocaleString('en-GB')}` : ''}
                {conn.tokenExpiresAt ? ` · session renews before ${new Date(conn.tokenExpiresAt).toLocaleDateString('en-GB')}` : ''}.
              </p>
            )}
            {conn.credentialSource === 'stored' && (
              <div className="admin-inline-form">
                <button className="admin-btn" disabled={busy} onClick={disconnect}>Disconnect</button>
              </div>
            )}
            {conn.credentialSource === 'env' && <p className="admin-hint">Login is set in the environment, so it can’t be changed here.</p>}
          </>
        )}
        {error && <div className="admin-error">{error}</div>}
      </div>
    </div>
  );
}
