import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';
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
  const [showMine, setShowMine] = useState(true);
  const [filteredData, setFilteredData] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchFiltered = async () => {
    setLoading(true);
    try {
      const url = showMine ? '/api/queue?assignee=nick' : '/api/queue';
      const res = await fetch(apiUrl(url));
      setFilteredData(await res.json());
    } catch (e) { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { fetchFiltered(); }, [showMine]);

  const data = filteredData || queueData;
  const tickets = data?.tickets || [];
  const configured = data?.configured;
  const lastSync = data?.last_sync;

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
