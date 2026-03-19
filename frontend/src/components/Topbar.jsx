import React from 'react';
import './Topbar.css';

export default function Topbar({ status, queueData }) {
  const jiraStatus = status?.jira?.status || 'unknown';
  const claudeOk = status?.claude?.configured;
  const atRisk = queueData?.at_risk_count || 0;

  const statusDot = (ok) => (
    <span className={`status-dot ${ok ? 'ok' : 'warn'}`} />
  );

  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="topbar-logo">NUERO</span>
        <span className="topbar-version">v1.0</span>
      </div>
      <div className="topbar-center">
        <div className="topbar-indicator">
          {statusDot(claudeOk)}
          <span className="topbar-label">Claude</span>
        </div>
        <div className="topbar-indicator">
          {statusDot(jiraStatus === 'ok')}
          <span className="topbar-label">Jira {jiraStatus === 'not_configured' ? '(not configured)' : ''}</span>
        </div>
        <div className="topbar-indicator">
          {statusDot(status?.obsidian?.configured)}
          <span className="topbar-label">Vault</span>
        </div>
        <div className="topbar-indicator">
          {statusDot(status?.microsoft?.authenticated)}
          <span className="topbar-label">Microsoft{status?.microsoft?.configured && !status?.microsoft?.authenticated ? ' (not signed in)' : !status?.microsoft?.configured ? ' (not configured)' : ''}</span>
        </div>
      </div>
      <div className="topbar-right">
        {atRisk > 0 && (
          <div className="topbar-alert">
            <span className="alert-count">{atRisk}</span>
            <span className="alert-label">SLA at risk</span>
          </div>
        )}
      </div>
    </header>
  );
}
