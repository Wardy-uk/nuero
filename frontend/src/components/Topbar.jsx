import React from 'react';
import './Topbar.css';

export default function Topbar({ status, queueData, onMenuToggle, onChatToggle, chatOpen, weekend, onWeekendOverride, weekendOverride, children }) {
  const jiraStatus = status?.jira?.status || 'unknown';
  const claudeOk = status?.claude?.configured;
  const atRisk = queueData?.at_risk_count || 0;
  const itIsWeekend = new Date().getDay() === 0 || new Date().getDay() === 6;

  const statusDot = (ok) => (
    <span className={`status-dot ${ok ? 'ok' : 'warn'}`} />
  );

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="topbar-menu-btn" onClick={onMenuToggle} aria-label="Menu">
          <span /><span /><span />
        </button>
        <span className="topbar-logo">NUERO</span>
        <span className="topbar-version">v1.0</span>
      </div>
      <div className="topbar-center">
        {weekend && (
          <button className="topbar-weekend-badge" onClick={onWeekendOverride} title="Weekend mode active — click to switch to work mode">
            🌿 Weekend
          </button>
        )}
        {!weekend && itIsWeekend && weekendOverride && (
          <button className="topbar-weekend-badge work-override" onClick={onWeekendOverride} title="Work mode override active — click to return to weekend mode">
            💼 Work mode
          </button>
        )}
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
        {children}
        {atRisk > 0 && (
          <div className="topbar-alert">
            <span className="alert-count">{atRisk}</span>
            <span className="alert-label">SLA at risk</span>
          </div>
        )}
        <button className="topbar-chat-btn" onClick={onChatToggle} aria-label="Toggle chat">
          {chatOpen ? '✕' : 'Chat'}
        </button>
      </div>
    </header>
  );
}
