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

function FlaggedEscalations() {
  const [flagged, setFlagged] = useState(null);
  const [flagInput, setFlagInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [editingNote, setEditingNote] = useState(null);

  const fetchFlagged = () => {
    fetch(apiUrl('/api/jira/flagged'))
      .then(r => r.json())
      .then(data => setFlagged(data.tickets || []))
      .catch(() => setFlagged([]));
  };

  useEffect(() => { fetchFlagged(); }, []);

  const handleFlag = async () => {
    const key = flagInput.trim().toUpperCase();
    if (!key.match(/^[A-Z]+-\d+$/)) {
      setAddError('Enter a valid ticket key e.g. NT-12345');
      return;
    }
    setAdding(true);
    setAddError('');
    try {
      const res = await fetch(apiUrl(`/api/jira/flagged/${key}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: noteInput.trim() || null })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Failed');
      setFlagInput('');
      setNoteInput('');
      setShowAdd(false);
      fetchFlagged();
    } catch (e) {
      setAddError(e.message);
    }
    setAdding(false);
  };

  const handleUnflag = async (key) => {
    try {
      await fetch(apiUrl(`/api/jira/flagged/${key}`), { method: 'DELETE' });
      fetchFlagged();
    } catch {}
  };

  const handleSaveNote = async (key, note) => {
    try {
      await fetch(apiUrl(`/api/jira/flagged/${key}/note`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note })
      });
      setEditingNote(null);
      fetchFlagged();
    } catch {}
  };

  const active = (flagged || []).filter(t =>
    !['Done', 'Resolved', 'Closed'].includes(t.status)
  );
  const resolved = (flagged || []).filter(t =>
    ['Done', 'Resolved', 'Closed'].includes(t.status)
  );

  return (
    <div className="flagged-section">
      <div className="flagged-header">
        <h3 className="flagged-title">
          Informal Escalations
          {active.length > 0 && (
            <span className="flagged-count">{active.length}</span>
          )}
        </h3>
        <button
          className="flagged-add-btn"
          onClick={() => setShowAdd(s => !s)}
          title="Flag a ticket"
        >
          {showAdd ? '✕' : '+ Flag ticket'}
        </button>
      </div>

      {showAdd && (
        <div className="flagged-add-form">
          <input
            className="flagged-key-input"
            type="text"
            placeholder="Ticket key e.g. NT-12345"
            value={flagInput}
            onChange={e => setFlagInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleFlag()}
          />
          <input
            className="flagged-note-input"
            type="text"
            placeholder="Note — e.g. verbally from Kim Rush (optional)"
            value={noteInput}
            onChange={e => setNoteInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleFlag()}
          />
          {addError && <span className="flagged-error">{addError}</span>}
          <button
            className="btn btn-primary"
            onClick={handleFlag}
            disabled={adding}
          >
            {adding ? 'Flagging...' : 'Flag'}
          </button>
        </div>
      )}

      {!flagged && <div className="flagged-empty">Loading...</div>}

      {flagged && active.length === 0 && !showAdd && (
        <div className="flagged-empty">No informal escalations flagged.</div>
      )}

      {active.map(t => (
        <div
          key={t.key}
          className={`flagged-card ${t.hasComment ? 'flagged-commented' : 'flagged-active'}`}
        >
          <div className="flagged-card-top">
            <span className="flagged-key">{t.key}</span>
            <span className="flagged-status">{t.status}</span>
            <span className="flagged-assignee">{t.assignee}</span>
            <button
              className="flagged-unflag-btn"
              onClick={() => handleUnflag(t.key)}
              title="Remove flag"
            >✕</button>
          </div>
          <div className="flagged-summary">{t.summary}</div>
          {t.note && editingNote !== t.key && (
            <div
              className="flagged-note"
              onClick={() => setEditingNote(t.key)}
              title="Click to edit"
            >
              {t.note}
            </div>
          )}
          {editingNote === t.key && (
            <input
              className="flagged-note-input"
              type="text"
              defaultValue={t.note || ''}
              autoFocus
              onBlur={e => handleSaveNote(t.key, e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSaveNote(t.key, e.target.value);
                if (e.key === 'Escape') setEditingNote(null);
              }}
            />
          )}
          {!t.note && editingNote !== t.key && (
            <button
              className="flagged-note-add"
              onClick={() => setEditingNote(t.key)}
            >
              + add note
            </button>
          )}
          <div className="flagged-meta">
            Flagged {new Date(t.flaggedAt).toLocaleDateString('en-GB')} via {t.flaggedVia}
            {t.hasComment && ' · commented'}
          </div>
        </div>
      ))}

      {resolved.length > 0 && (
        <div className="flagged-resolved">
          <span className="flagged-resolved-label">Resolved ({resolved.length})</span>
          {resolved.map(t => (
            <div key={t.key} className="flagged-card flagged-resolved-card">
              <span className="flagged-key">{t.key}</span>
              <span className="flagged-summary">{t.summary}</span>
              <button
                className="flagged-unflag-btn"
                onClick={() => handleUnflag(t.key)}
              >✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
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

function FlagButton({ ticketKey }) {
  const [flagging, setFlagging] = useState(false);
  const [flagged, setFlagged] = useState(false);

  const handleFlag = async (e) => {
    e.stopPropagation();
    if (flagged) return;
    setFlagging(true);
    try {
      const res = await fetch(apiUrl(`/api/jira/flagged/${ticketKey}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: null })
      });
      const data = await res.json();
      if (data.ok) setFlagged(true);
    } catch {}
    setFlagging(false);
  };

  return (
    <button
      className={`ticket-flag-btn ${flagged ? 'ticket-flagged' : ''}`}
      onClick={handleFlag}
      disabled={flagging}
      title={flagged ? 'Flagged as informal escalation' : 'Flag as informal escalation'}
    >
      {flagged ? '⚑' : '⚐'}
    </button>
  );
}

export default function QueueTable({ queueData, onRefresh, focusContext }) {
  const [showMine, setShowMine] = useState(true);
  const [showAllTickets, setShowAllTickets] = useState(!focusContext?.fromFocus);
  const fromFocus = focusContext?.fromFocus;

  const path = showMine ? '/api/queue?assignee=nick' : '/api/queue';
  const { data: filteredData, refresh: fetchFiltered } = useCachedFetch(path);
  const loading = filteredData === null;

  const data = filteredData || queueData;
  const allTickets = data?.tickets || [];
  const configured = data?.configured;
  const lastSync = data?.last_sync;

  // Sort: at-risk first (lowest SLA remaining), then by priority
  const sorted = [...allTickets].sort((a, b) => {
    const aRisk = a.at_risk ? 0 : 1;
    const bRisk = b.at_risk ? 0 : 1;
    if (aRisk !== bRisk) return aRisk - bRisk;
    const aSla = a.sla_remaining_minutes ?? 99999;
    const bSla = b.sla_remaining_minutes ?? 99999;
    return aSla - bSla;
  });

  // In focus mode, show only at-risk tickets by default
  const atRisk = sorted.filter(t => t.at_risk);
  const tickets = (fromFocus && !showAllTickets) ? atRisk.slice(0, 10) : sorted;
  const hiddenCount = sorted.length - tickets.length;

  // Mark escalations as seen when queue tab is opened
  useEffect(() => {
    fetch(apiUrl('/api/jira/escalations/seen'), { method: 'POST' }).catch(() => {});
  }, []);

  return (
    <div className="queue-container">
      {fromFocus && !showAllTickets && atRisk.length > 0 && (
        <div className="todo-focus-summary" style={{ marginBottom: 16 }}>
          <span className="todo-focus-summary-text">
            Showing {tickets.length} at-risk ticket{tickets.length !== 1 ? 's' : ''} of {sorted.length} total
          </span>
          {hiddenCount > 0 && (
            <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setShowAllTickets(true)}>
              Show all {sorted.length}
            </button>
          )}
        </div>
      )}
      {fromFocus && showAllTickets && sorted.length > 10 && (
        <div className="todo-focus-summary" style={{ marginBottom: 16 }}>
          <span className="todo-focus-summary-text">Showing all {sorted.length} tickets, sorted by urgency</span>
          <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setShowAllTickets(false)}>
            At-risk only
          </button>
        </div>
      )}
      <div className="queue-header">
        <h2 className="queue-title">{fromFocus && !showAllTickets ? 'At-Risk Tickets — Start Here' : 'Queue'}</h2>
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

      <FlaggedEscalations />
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
              <th></th>
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
                <td className="ticket-flag">
                  <FlagButton ticketKey={ticket.ticket_key} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
