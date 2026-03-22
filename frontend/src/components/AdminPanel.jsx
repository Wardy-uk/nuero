import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';
import useCachedFetch from '../useCachedFetch';
import './AdminPanel.css';

export default function AdminPanel({ pushState = {} }) {
  const { supported: pushSupported, subscribed: pushSubscribed, error: pushError, manualSubscribe } = pushState;
  const { data: status, refresh: fetchStatus } = useCachedFetch('/api/status');
  const [deviceCode, setDeviceCode] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [connecting, setConnecting] = useState(false);

  // Poll for auth completion when device code is active
  useEffect(() => {
    if (!deviceCode) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(apiUrl('/api/microsoft/status'));
        const data = await res.json();
        if (data.authenticated) {
          setDeviceCode(null);
          setConnecting(false);
          fetchStatus();
        }
      } catch (e) { /* ignore */ }
    }, 3000);
    return () => clearInterval(interval);
  }, [deviceCode, fetchStatus]);

  const startAuth = async () => {
    setConnecting(true);
    setAuthError(null);
    try {
      const res = await fetch(apiUrl('/api/microsoft/auth'), { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        setAuthError(data.error);
        setConnecting(false);
      } else {
        setDeviceCode(data);
      }
    } catch (e) {
      setAuthError(e.message);
      setConnecting(false);
    }
  };

  if (!status) return <div className="admin-container">Loading...</div>;

  const integrations = [
    {
      name: 'Claude AI',
      status: status.claude?.configured ? 'connected' : 'unconfigured',
      detail: status.claude?.configured ? 'API key set' : 'ANTHROPIC_API_KEY not set'
    },
    {
      name: 'Jira',
      status: status.jira?.configured
        ? (status.jira.status === 'ok' ? 'connected' : 'disconnected')
        : 'unconfigured',
      detail: status.jira?.configured
        ? `Status: ${status.jira.status}${status.jira.last_sync ? ' · Last sync: ' + new Date(status.jira.last_sync).toLocaleTimeString() : ''}`
        : 'JIRA_* env vars not set'
    },
    {
      name: 'Obsidian',
      status: status.obsidian?.configured ? 'connected' : 'unconfigured',
      detail: status.obsidian?.configured ? 'Vault path configured' : 'OBSIDIAN_VAULT_PATH not set'
    },
    {
      name: 'Microsoft 365',
      status: status.microsoft?.authenticated ? 'connected' : 'disconnected',
      detail: status.microsoft?.authenticated ? 'Graph API authenticated' : 'Not authenticated'
    },
    {
      name: 'n8n',
      status: status.n8n?.configured ? 'connected' : 'unconfigured',
      detail: status.n8n?.configured ? 'API key set — workflows available' : 'N8N_API_KEY not set'
    },
    {
      name: 'Strava',
      status: status.strava?.authenticated ? 'connected'
        : status.strava?.configured ? 'disconnected'
        : 'unconfigured',
      detail: status.strava?.authenticated ? 'Activity data available'
        : status.strava?.configured ? 'Not authenticated — connect below'
        : 'STRAVA_CLIENT_ID not set'
    },
    {
      name: 'Apple Health (Shortcut)',
      status: status.health?.hasToday ? 'connected'
        : status.health?.latestDate ? 'disconnected'
        : 'unconfigured',
      detail: status.health?.hasToday
        ? 'Data received today'
        : status.health?.latestDate
        ? `Last data: ${status.health.latestDate} — Shortcut may not have run today`
        : 'No data received — set up the iOS Shortcut (see below)'
    }
  ];

  return (
    <div className="admin-container">
      <h2 className="admin-title">Settings</h2>

      <div className="admin-section">
        <div className="admin-section-title">Integrations</div>
        <div className="admin-cards">
          {integrations.map(int => (
            <div key={int.name} className="admin-card">
              <div className="admin-card-header">
                <span className="admin-card-name">{int.name}</span>
                <span className={`admin-status-badge ${int.status}`}>
                  {int.status}
                </span>
              </div>
              <div className="admin-card-detail">{int.detail}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="admin-section">
        <div className="admin-section-title">Microsoft 365 Authentication</div>
        <div className="admin-ms-section">
          {status.microsoft?.authenticated ? (
            <>
              <div className="admin-ms-connected">
                <span className="admin-ms-connected-dot" />
                Connected to Microsoft Graph
              </div>
              <div className="admin-ms-scopes">
                Scopes: <span>Calendars.Read</span><span>Mail.Read</span><span>Tasks.Read</span><span>User.Read</span>
              </div>
            </>
          ) : deviceCode ? (
            <div className="admin-device-code">
              <div className="admin-device-code-label">Enter this code at Microsoft</div>
              <div className="admin-device-code-value">{deviceCode.userCode}</div>
              <div className="admin-device-code-link">
                <a href={deviceCode.verificationUri} target="_blank" rel="noopener noreferrer">
                  {deviceCode.verificationUri}
                </a>
              </div>
              <div className="admin-device-code-waiting">Waiting for you to sign in...</div>
            </div>
          ) : (
            <>
              <div className="admin-ms-desc">
                Connect your Microsoft 365 account to enable calendar sync, inbox triage, and task integration.
                Uses device code flow — click below, then enter the code at microsoft.com/devicelogin.
              </div>
              <button
                className="admin-ms-connect-btn"
                onClick={startAuth}
                disabled={connecting}
              >
                {connecting ? 'Starting...' : 'Connect Microsoft 365'}
              </button>
            </>
          )}
          {authError && <div className="admin-error">{authError}</div>}
        </div>
      </div>

      <div className="admin-section">
        <div className="admin-section-title">Push Notifications</div>
        <div className="admin-ms-section">
          <div className="admin-card" style={{ marginBottom: '12px' }}>
            <div className="admin-card-header">
              <span className="admin-card-name">Server VAPID keys</span>
              <span className={`admin-status-badge ${status.push?.configured ? 'connected' : 'unconfigured'}`}>
                {status.push?.configured ? 'configured' : 'not configured'}
              </span>
            </div>
            {!status.push?.configured && (
              <div className="admin-card-detail" style={{ color: 'var(--accent-warn, #f59e0b)' }}>
                SSH into Pi and run: <code>npx web-push generate-vapid-keys</code> — paste output into Pi .env and restart NEURO
              </div>
            )}
          </div>
          {!pushSupported ? (
            <div className="admin-ms-desc">
              Push not supported on this browser. On iOS: Safari → Share → Add to Home Screen → reopen from icon.
            </div>
          ) : pushSubscribed ? (
            <>
              <div className="admin-ms-connected" style={{ marginBottom: '12px' }}>
                <span className="admin-ms-connected-dot" />
                This device is subscribed · {status.push?.subscriptions || 1} device{(status.push?.subscriptions || 1) !== 1 ? 's' : ''} total
              </div>
              <button className="admin-ms-connect-btn" onClick={async () => {
                try {
                  const res = await fetch(apiUrl('/api/push/test'), { method: 'POST' });
                  const data = await res.json();
                  if (data.ok) alert('Test notification sent — you should receive it shortly');
                  else alert('Test failed: ' + (data.error || 'unknown error'));
                } catch (e) { alert('Test failed: ' + e.message); }
              }}>
                Send Test Notification
              </button>
            </>
          ) : (
            <>
              <div className="admin-ms-desc" style={{ marginBottom: '8px' }}>
                <strong>iOS users:</strong> Install NEURO as a PWA first — Safari → Share → Add to Home Screen → reopen from icon.
              </div>
              <div className="admin-ms-desc" style={{ marginBottom: '12px' }}>
                Then tap Enable Notifications and accept the permission prompt.
              </div>
              <button
                className="admin-ms-connect-btn"
                onClick={manualSubscribe}
                disabled={!status.push?.configured}
                title={!status.push?.configured ? 'VAPID keys not configured on server' : ''}
              >
                Enable Notifications
              </button>
              {!status.push?.configured && (
                <div className="admin-ms-desc" style={{ marginTop: '8px', opacity: 0.6 }}>
                  Button disabled — server VAPID keys not configured yet
                </div>
              )}
            </>
          )}
          {pushError && <div className="admin-error">{pushError}</div>}
        </div>
      </div>

      {/* Strava */}
      <div className="admin-section">
        <div className="admin-section-title">Strava</div>
        <div className="admin-ms-section">
          {status.strava?.authenticated ? (
            <>
              <div className="admin-ms-connected">
                <span className="admin-ms-connected-dot" />
                Connected — activity data available for journal prompts
              </div>
              <button
                className="admin-ms-connect-btn"
                style={{ marginTop: '8px', background: 'rgba(252,76,2,0.1)', borderColor: '#fc4c02', color: '#fc4c02' }}
                onClick={async () => {
                  await fetch(apiUrl('/api/strava/disconnect'), { method: 'POST' });
                  fetchStatus();
                }}
              >
                Disconnect Strava
              </button>
            </>
          ) : status.strava?.configured ? (
            <>
              <div className="admin-ms-desc">
                Connect Strava to include today's activity in your journal prompts and
                NEURO chat context. Opens a Strava authorisation page — you'll need to
                be on your Tailscale network.
              </div>
              <button
                className="admin-ms-connect-btn"
                style={{ background: 'rgba(252,76,2,0.1)', borderColor: '#fc4c02', color: '#fc4c02' }}
                onClick={() => window.open(apiUrl('/api/strava/auth'), '_blank')}
              >
                Connect Strava
              </button>
            </>
          ) : (
            <div className="admin-ms-desc">
              Add STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, and STRAVA_REDIRECT_URI to
              the Pi's .env file to enable Strava integration.
            </div>
          )}
        </div>
      </div>

      {/* Apple Health */}
      <div className="admin-section">
        <div className="admin-section-title">Apple Health</div>
        <div className="admin-ms-section">
          {status.health?.hasToday ? (
            <div className="admin-ms-connected">
              <span className="admin-ms-connected-dot" />
              Health data received today — active in journal prompts and chat
            </div>
          ) : (
            <>
              <div className="admin-ms-desc" style={{ marginBottom: '12px' }}>
                Set up an iOS Shortcut to send Apple Health data (HRV, sleep, RHR)
                to NEURO each morning. The Shortcut runs automatically and posts to
                the Pi via Tailscale.
              </div>
              <div className="admin-ms-desc" style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', lineHeight: '1.8', background: 'var(--bg-tertiary)', padding: '12px', borderRadius: '4px', marginBottom: '8px' }}>
                <strong>Shortcut setup (one-time):</strong><br />
                1. Open Shortcuts app on iPhone<br />
                2. Create new Shortcut with these actions:<br />
                &nbsp;&nbsp;- Get Health Sample: Heart Rate Variability (last 24h, average)<br />
                &nbsp;&nbsp;- Get Health Sample: Resting Heart Rate (last 24h, latest)<br />
                &nbsp;&nbsp;- Get Health Sample: Sleep Analysis (last 24h)<br />
                &nbsp;&nbsp;- Get Health Sample: Step Count (today, sum)<br />
                &nbsp;&nbsp;- Get Health Sample: Active Energy (today, sum)<br />
                &nbsp;&nbsp;- Get Contents of URL: POST to /api/health/ingest<br />
                &nbsp;&nbsp;- Headers: Authorization: Bearer [INGEST_SECRET]<br />
                &nbsp;&nbsp;- Body: JSON with keys: hrv, rhr, sleepDuration, steps, activeEnergy<br />
                3. Add automation: run at 07:30 daily
              </div>
              {status.health?.latestDate && (
                <div className="admin-ms-desc" style={{ color: 'var(--accent-warn, #f59e0b)' }}>
                  Last data received: {status.health.latestDate} — Shortcut hasn't run today yet
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="admin-section">
        <div className="admin-section-title">System</div>
        <div className="admin-card">
          <div className="admin-card-header">
            <span className="admin-card-name">NUERO</span>
            <span className="admin-status-badge connected">v{status.version}</span>
          </div>
          <div className="admin-card-detail">
            Uptime: {Math.floor(status.uptime / 60)}m {Math.floor(status.uptime % 60)}s
          </div>
        </div>
      </div>
    </div>
  );
}
