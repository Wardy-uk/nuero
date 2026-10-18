import React, { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../api';

async function getJson(path, init) {
  const r = await fetch(apiUrl(path), init);
  return r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
}
const post = (path, body) => getJson(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

/**
 * The shared family Google calendar the family wall writes to (18 Oct 2026).
 * Settings → Integrations. Three steps: the OAuth client from Google Cloud,
 * "Sign in with Google", paste back the address Google sends you to.
 */
export function GoogleCalendarCard() {
  const [st, setSt] = useState(null);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState(null);
  const [opened, setOpened] = useState(false);

  const load = useCallback(async () => {
    const d = await getJson('/api/google-calendar');
    if (d.ok) setSt(d.status); else setError(d.error || 'Could not read the Google connection.');
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn) => {
    setBusy(true); setError(null); setMsg(null);
    try { await fn(); } finally { setBusy(false); }
  };
  const saveClient = () => run(async () => {
    const d = await post('/api/google-calendar/client', { clientId, clientSecret: secret });
    setSecret('');
    if (!d.ok) { setError(d.error); return; }
    setClientId(''); setSt(d.status);
  });
  const signIn = () => run(async () => {
    const d = await post('/api/google-calendar/connect');
    if (!d.ok) { setError(d.error); return; }
    window.open(d.url, '_blank', 'noopener');
    setOpened(true);
  });
  const finish = () => run(async () => {
    const d = await post('/api/google-calendar/finish', { pasted });
    setPasted('');
    if (!d.ok) { setError(d.error); return; }
    setOpened(false);
    setMsg(d.warning || `Connected — ${d.events} event${d.events === 1 ? '' : 's'} read from the family calendar.`);
    await load();
  });
  const syncNow = () => run(async () => {
    const d = await post('/api/google-calendar/sync');
    if (!d.ok) setError(d.error); else setMsg(`Read ${d.count} event${d.count === 1 ? '' : 's'}.`);
    await load();
  });
  const disconnect = () => run(async () => { await post('/api/google-calendar/disconnect'); await load(); });

  const sync = st && st.lastSync;
  return (
    <div className="admin-section">
      <div className="admin-section-title">Family calendar (Google)</div>
      <div className="admin-ms-section">
        <p className="admin-hint">
          The family wall adds, edits and deletes events in <strong>{st ? st.target : '…'}</strong> — and no other calendar.
          Every change is read back from Google before the wall says it saved.
        </p>
        {st && !st.clientConfigured && (
          <>
            <p className="admin-hint">
              Step 1 — in Google Cloud, create an OAuth client of type <strong>Desktop app</strong> (Google Calendar API enabled,
              consent screen published “In production”), then paste its ID and secret here. They stay on the Pi.
            </p>
            <div className="admin-inline-form">
              <input value={clientId} placeholder="Client ID (…apps.googleusercontent.com)" autoComplete="off" onChange={(e) => setClientId(e.target.value)} />
              <input type="password" value={secret} placeholder="Client secret" autoComplete="off" onChange={(e) => setSecret(e.target.value)} />
              <button className="admin-btn" disabled={!clientId || !secret || busy} onClick={saveClient}>Save</button>
            </div>
          </>
        )}
        {st && st.clientConfigured && !st.connected && (
          <>
            {st.rejected && <div className="admin-error">Google no longer accepts the sign-in ({st.rejected}). Sign in again — until then the wall can’t change the calendar.</div>}
            <p className="admin-hint">
              Step 2 — sign in with the Google account that can edit the family calendar. Google will send you to a page that won’t load
              (http://127.0.0.1…). That’s expected: copy that whole address and paste it below.
            </p>
            <div className="admin-inline-form">
              <button className="admin-btn" disabled={busy} onClick={signIn}>Sign in with Google</button>
            </div>
            {(opened || st.pending) && (
              <div className="admin-inline-form">
                <input value={pasted} placeholder="Paste the http://127.0.0.1… address" autoComplete="off" onChange={(e) => setPasted(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && pasted && finish()} />
                <button className="admin-btn" disabled={!pasted || busy} onClick={finish}>{busy ? 'Checking with Google…' : 'Finish'}</button>
              </div>
            )}
          </>
        )}
        {st && st.connected && (
          <>
            <p className="admin-hint">
              Connected{st.connectedAt ? ` since ${new Date(st.connectedAt).toLocaleDateString('en-GB')}` : ''}.
              {sync ? (sync.ok
                ? ` Last read ${new Date(sync.at).toLocaleString('en-GB')} · ${sync.count} event${sync.count === 1 ? '' : 's'}.`
                : ` The last read failed (${sync.error})${sync.lastGoodAt ? ` — showing what was read at ${new Date(sync.lastGoodAt).toLocaleString('en-GB')}` : ''}.`) : ''}
            </p>
            <div className="admin-inline-form">
              <button className="admin-btn" disabled={busy} onClick={syncNow}>Read it now</button>
              <button className="admin-btn" disabled={busy} onClick={disconnect}>Disconnect</button>
            </div>
          </>
        )}
        {st && st.clientConfigured && st.clientSource === 'stored' && !st.connected && (
          <p className="admin-hint">Wrong client? Paste a new ID and secret: <button className="admin-btn" disabled={busy} onClick={() => setSt({ ...st, clientConfigured: false })}>Replace client</button></p>
        )}
        <p className="admin-hint">A household VESTA account needs the “family-calendar” permission (Settings → VESTA accounts) before the wall can change anything.</p>
        {msg && <p className="admin-hint">{msg}</p>}
        {error && <div className="admin-error">{error}</div>}
      </div>
    </div>
  );
}
