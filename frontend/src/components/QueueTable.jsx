import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';
import useCachedFetch from '../useCachedFetch';
import './QueueTable.css';

function slaClass(minutes) {
  if (minutes === null || minutes === undefined) return '';
  if (minutes < 120) return 'sla-danger';
  if (minutes < 240) return 'sla-warning';
  return 'sla-ok';
}

function formatSla(minutes) {
  if (minutes === null || minutes === undefined) return '-';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
}

function EscalationSection() {
  const [escalations, setEscalations] = useState(null);

  useEffect(() => {
    fetch(apiUrl('/api/jira/escalations'))
      .then(r => r.json())
      .then(data => setEscalations(data.tickets || []))
      .catch(() => setEscalations([]));
  }, []);

  if (!escalations || escalations.length === 0) return null;

  const needsAttention = escalations.filter(t => !t.hasComment && !t.seen);
  const seenNoComment = escalations.filter(t => !t.hasComment && t.seen);
  const commented = escalations.filter(t => t.hasComment);

  return (
    <div className="escalation-section">
      <h3 className="escalation-title">Escalations</h3>
      {needsAttention.length > 0 && (
        <div className="escalation-group">
          <span className="escalation-group-label">Needs attention</span>
          {needsAttention.map(t => (
            <div key={t.key} className="escalation-card escalation-red">
              <span className="escalation-key">{t.key}</span>
              <span className="escalation-summary">{t.summary}</span>
            </div>
          ))}
        </div>
      )}
      {seenNoComment.length > 0 && (
        <div className="escalation-group">
          <span className="escalation-group-label">Seen — no comment yet</span>
          {seenNoComment.map(t => (
            <div key={t.key} className="escalation-card escalation-amber">
              <span className="escalation-key">{t.key}</span>
              <span className="escalation-summary">{t.summary}</span>
            </div>
          ))}
        </div>
      )}
      {commented.length > 0 && (
        <div className="escalation-group">
          <span className="escalation-group-label">Commented</span>
          {commented.map(t => (
            <div key={t.key} className="escalation-card escalation-grey">
              <span className="escalation-key">{t.key}</span>
              <span className="escalation-summary">{t.summary}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function QueueTable({ queueData, onRefresh }) {
  const [showMine, setShowMine] = useState(true);

  const path = showMine ? '/api/queue?assignee=nick' : '/api/queue';
  const { data: filteredData, refresh: fetchFiltered } = useCachedFetch(path);
  const loading = filteredData === null;

  const data = filteredData || queueData;
  const tickets = data?.tickets || [];
  const configured = data?.configured;
  const lastSync = data?.last_sync;

  // Mark escalations as seen when queue tab is opened
  useEffect(() => {
    fetch(apiUrl('/api/jira/escalations/seen'), { method: 'POST' }).catch(() => {});
  }, []);

  return (
    <div className="queue-container">
      <div className="queue-header">
        <h2 className="queue-title">Queue</h2>
        <div className="queue-meta">
          <div className="queue-filter-toggle">
            <button
              className={`todo-filter-btn ${showMine ? 'active' : ''}`}
              onClick={() => setShowMine(true)}
            >My tickets</button>
            <button
              className={`todo-filter-btn ${!showMine ? 'active' : ''}`}
              onClick={() => setShowMine(false)}
            >All tickets</button>
          </div>
          {lastSync && <span className="queue-sync">Last sync: {new Date(lastSync).toLocaleTimeString()}</span>}
          <button className="btn btn-secondary" onClick={() => { onRefresh(); fetchFiltered(); }}>Refresh</button>
        </div>
      </div>

      <EscalationSection />

      {!configured ? (
        <div className="queue-unconfigured">
          Jira is not configured. Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, and JIRA_PROJECT_KEY in .env
        </div>
      ) : loading ? (
        <div className="queue-empty">Loading tickets...</div>
      ) : tickets.length === 0 ? (
        <div className="queue-empty">{showMine ? 'No tickets assigned to you.' : 'No open tickets in queue.'}</div>
      ) : (
        <table className="queue-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Summary</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Assignee</th>
              <th>SLA Remaining</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map(ticket => (
              <tr key={ticket.ticket_key} className={slaClass(ticket.sla_remaining_minutes)}>
                <td className="ticket-key">{ticket.ticket_key}</td>
                <td className="ticket-summary">{ticket.summary}</td>
                <td className="ticket-priority">{ticket.priority || '-'}</td>
                <td className="ticket-status">{ticket.status || '-'}</td>
                <td className="ticket-assignee">{ticket.assignee || 'Unassigned'}</td>
                <td className="ticket-sla">{formatSla(ticket.sla_remaining_minutes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
