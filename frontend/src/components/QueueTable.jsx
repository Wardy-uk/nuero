import React from 'react';
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

export default function QueueTable({ queueData, onRefresh }) {
  const tickets = queueData?.tickets || [];
  const configured = queueData?.configured;
  const lastSync = queueData?.last_sync;

  return (
    <div className="queue-container">
      <div className="queue-header">
        <h2 className="queue-title">Queue</h2>
        <div className="queue-meta">
          {lastSync && <span className="queue-sync">Last sync: {new Date(lastSync).toLocaleTimeString()}</span>}
          <button className="btn btn-secondary" onClick={onRefresh}>Refresh</button>
        </div>
      </div>

      {!configured ? (
        <div className="queue-unconfigured">
          Jira is not configured. Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, and JIRA_PROJECT_KEY in .env
        </div>
      ) : tickets.length === 0 ? (
        <div className="queue-empty">No open tickets in queue.</div>
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
