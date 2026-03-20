import React, { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './AdminPanel.css';

export default function AdminPanel({ pushState = {} }) {
  const { supported: pushSupported, subscribed: pushSubscribed, error: pushError, manualSubscribe } = pushState;
  const [status, setStatus] = useState(null);
  const [deviceCode, setDeviceCode] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [connecting, setConnecting] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/status'));
      setStatus(await res.json());
    } catch (e) {
      console.error('Status fetch failed:', e);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

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
          {!pushSupported ? (
            <div className="admin-ms-desc">Push notifications are not supported on this device/browser.</div>
          ) : pushSubscribed ? (
            <div className="admin-ms-connected">
              <span className="admin-ms-connected-dot" />
              Push notifications enabled
            </div>
          ) : (
            <>
              <div className="admin-ms-desc">
                Enable push notifications to get standup reminders and todo nudges on this device.
                On iOS, you must first install NEURO as a PWA (Add to Home Screen from Safari).
              </div>
              <button
                className="admin-ms-connect-btn"
                onClick={manualSubscribe}
              >
                Enable Notifications
              </button>
            </>
          )}
          {pushError && <div className="admin-error">{pushError}</div>}
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
