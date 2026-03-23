import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';
import './InboxPanel.css';

function timeAgo(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - Number(timestamp);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function EmailCard({ email, borderClass, onDismiss, dismissing }) {
  return (
    <div className={`inbox-item ${borderClass}`}>
      <div className="inbox-item-header">
        <span className="inbox-item-from">{email.from}</span>
        {email.reason && <span className="inbox-item-cat">{email.reason}</span>}
        <button
          className="inbox-dismiss-btn"
          onClick={() => onDismiss(email.id)}
          disabled={dismissing === email.id}
          title="Dismiss"
        >
          {dismissing === email.id ? '...' : '\u00d7'}
        </button>
      </div>
      <div className="inbox-item-subject">{email.subject}</div>
      {email.preview && (
        <div className="inbox-item-summary">{email.preview.substring(0, 150)}</div>
      )}
    </div>
  );
}

export default function InboxPanel() {
  const [triage, setTriage] = useState(null);
  const [running, setRunning] = useState(false);
  const [dismissing, setDismissing] = useState(null);
  const [fyiOpen, setFyiOpen] = useState(false);

  const fetchTriage = () => {
    fetch(apiUrl('/api/email/triage'))
      .then(r => r.json())
      .then(data => setTriage(data))
      .catch(() => {});
  };

  useEffect(() => { fetchTriage(); }, []);

  const runTriage = () => {
    setRunning(true);
    fetch(apiUrl('/api/email/triage/run'), { method: 'POST' })
      .then(r => r.json())
      .then(() => { fetchTriage(); setRunning(false); })
      .catch(() => setRunning(false));
  };

  const dismiss = (emailId) => {
    setDismissing(emailId);
    fetch(apiUrl(`/api/email/triage/dismiss/${encodeURIComponent(emailId)}`), { method: 'POST' })
      .then(() => { fetchTriage(); setDismissing(null); })
      .catch(() => setDismissing(null));
  };

  const action = triage?.action || [];
  const delegate = triage?.delegate || [];
  const fyi = triage?.fyi || [];
  const ignore = triage?.ignore || [];
  const fyiTotal = fyi.length + ignore.length;

  return (
    <div className="inbox-container">
      <div className="inbox-header">
        <h2 className="inbox-title">Inbox Triage</h2>
        <div className="inbox-actions">
          {triage?.lastRun && (
            <span className="inbox-last-scan">
              Last triage: {timeAgo(triage.lastRun)}
            </span>
          )}
          <button
            className="inbox-scan-btn"
            onClick={runTriage}
            disabled={running}
          >
            {running ? 'Running...' : 'Run Triage'}
          </button>
        </div>
      </div>

      {!triage && <div className="inbox-empty">Loading...</div>}

      {triage && action.length === 0 && delegate.length === 0 && fyiTotal === 0 && (
        <div className="inbox-empty">
          {triage.lastRun
            ? 'Inbox clear — nothing needs your attention.'
            : 'No triage yet. Click Run Triage to classify your inbox.'}
        </div>
      )}

      {action.length > 0 && (
        <div className="inbox-section">
          <div className="inbox-section-label inbox-section-action">ACTION ({action.length})</div>
          {action.map(e => (
            <EmailCard key={e.id} email={e} borderClass="urgency-high" onDismiss={dismiss} dismissing={dismissing} />
          ))}
        </div>
      )}

      {delegate.length > 0 && (
        <div className="inbox-section">
          <div className="inbox-section-label inbox-section-delegate">DELEGATE ({delegate.length})</div>
          {delegate.map(e => (
            <EmailCard key={e.id} email={e} borderClass="urgency-medium" onDismiss={dismiss} dismissing={dismissing} />
          ))}
        </div>
      )}

      {fyiTotal > 0 && (
        <div className="inbox-section">
          <button
            className="inbox-section-toggle"
            onClick={() => setFyiOpen(o => !o)}
          >
            {fyiOpen ? '▾' : '▸'} FYI ({fyiTotal})
          </button>
          {fyiOpen && [...fyi, ...ignore].map(e => (
            <EmailCard key={e.id} email={e} borderClass="urgency-low" onDismiss={dismiss} dismissing={dismissing} />
          ))}
        </div>
      )}
    </div>
  );
}
