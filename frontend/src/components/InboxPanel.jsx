import React, { useState } from 'react';
import { apiUrl } from '../api';
import useCachedFetch from '../useCachedFetch';
import './InboxPanel.css';

const URGENCY_ORDER = { high: 0, medium: 1, low: 2 };
const CATEGORY_LABELS = {
  'action-required': 'Action',
  'decision-needed': 'Decision',
  'escalation': 'Escalation',
  'fyi': 'FYI',
  'follow-up': 'Follow Up',
  'meeting-prep': 'Prep'
};

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function InboxPanel() {
  const { data, refresh: fetchData } = useCachedFetch('/api/microsoft/inbox', { interval: 60000 });
  const [filter, setFilter] = useState('all');

  const inboxData = data || { items: [], lastScan: null, scanning: false };

  const [scanning, setScanning] = useState(false);
  const [dismissing, setDismissing] = useState(null);

  const triggerScan = () => {
    setScanning(true);
    fetch(apiUrl('/api/microsoft/inbox/scan'), { method: 'POST' })
      .then(() => { setTimeout(() => { fetchData(); setScanning(false); }, 2000); })
      .catch(() => setScanning(false));
  };

  const dismissItem = (emailId) => {
    setDismissing(emailId);
    fetch(apiUrl('/api/microsoft/inbox/dismiss'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailId })
    })
      .then(() => { fetchData(); setDismissing(null); })
      .catch(() => setDismissing(null));
  };

  const sorted = [...(inboxData.items || [])].sort((a, b) =>
    (URGENCY_ORDER[a.urgency] ?? 9) - (URGENCY_ORDER[b.urgency] ?? 9)
  );

  const filtered = filter === 'all' ? sorted : sorted.filter(i => i.urgency === filter);

  const counts = { high: 0, medium: 0, low: 0 };
  (inboxData.items || []).forEach(i => { counts[i.urgency] = (counts[i.urgency] || 0) + 1; });

  return (
    <div className="inbox-container">
      <div className="inbox-header">
        <h2 className="inbox-title">Inbox Triage</h2>
        <div className="inbox-actions">
          {inboxData.lastScan && (
            <span className="inbox-last-scan">
              Scanned {timeAgo(inboxData.lastScan)}
            </span>
          )}
          <button
            className="inbox-scan-btn"
            onClick={triggerScan}
            disabled={scanning}
          >
            {scanning ? 'Scanning...' : 'Scan Now'}
          </button>
        </div>
      </div>

      {(inboxData.items || []).length === 0 && !scanning && (
        <div className="inbox-empty">
          {inboxData.lastScan
            ? 'Inbox clear — nothing needs your attention right now.'
            : 'No scan yet. Waiting for first scan or click Scan Now.'}
        </div>
      )}

      {(inboxData.items || []).length > 0 && (
        <>
          <div className="inbox-filters">
            <button
              className={`inbox-filter ${filter === 'all' ? 'active' : ''}`}
              onClick={() => setFilter('all')}
            >
              All ({(inboxData.items || []).length})
            </button>
            {counts.high > 0 && (
              <button
                className={`inbox-filter urgency-high ${filter === 'high' ? 'active' : ''}`}
                onClick={() => setFilter('high')}
              >
                Urgent ({counts.high})
              </button>
            )}
            {counts.medium > 0 && (
              <button
                className={`inbox-filter urgency-medium ${filter === 'medium' ? 'active' : ''}`}
                onClick={() => setFilter('medium')}
              >
                This Week ({counts.medium})
              </button>
            )}
            {counts.low > 0 && (
              <button
                className={`inbox-filter urgency-low ${filter === 'low' ? 'active' : ''}`}
                onClick={() => setFilter('low')}
              >
                FYI ({counts.low})
              </button>
            )}
          </div>

          <div className="inbox-list">
            {filtered.map((item, i) => (
              <div key={item.emailId || i} className={`inbox-item urgency-${item.urgency}`}>
                <div className="inbox-item-header">
                  <span className={`inbox-urgency-dot ${item.urgency}`} />
                  <span className="inbox-item-from">{item.from}</span>
                  <span className="inbox-item-cat">{CATEGORY_LABELS[item.category] || item.category}</span>
                  {item.received && <span className="inbox-item-time">{timeAgo(item.received)}</span>}
                  <button
                    className="inbox-dismiss-btn"
                    onClick={() => dismissItem(item.emailId)}
                    disabled={dismissing === item.emailId}
                    title="Dismiss"
                  >
                    {dismissing === item.emailId ? '...' : '\u00d7'}
                  </button>
                </div>
                <div className="inbox-item-subject">{item.subject}</div>
                <div className="inbox-item-summary">{item.summary}</div>
                {item.reason && <div className="inbox-item-reason">{item.reason}</div>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
