import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';
import useCachedFetch from '../useCachedFetch';
import './QueueTable.css';

function formatSla(minutes) {
  if (minutes === null || minutes === undefined) return '-';
  if (minutes < 0) return 'BREACHED';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function slaUrgencyClass(minutes) {
  if (minutes === null || minutes === undefined) return '';
  if (minutes < 0) return 'sla-breached';
  if (minutes < 120) return 'sla-danger';
  if (minutes < 240) return 'sla-warning';
  return 'sla-ok';
}

function triageTickets(tickets) {
  const actNow = [];
  const today = [];
  const watch = [];

  for (const t of tickets) {
    const sla = t.sla_remaining_minutes;
    const priority = (t.priority || '').toLowerCase();
    const isP1 = priority.includes('highest') || priority === 'p1' || priority === 'critical';
    const isAtRisk = t.at_risk;
    const isBreached = sla != null && sla < 0;
    const slaClose = sla != null && sla < 120;

    if (isBreached || isP1 || (isAtRisk && slaClose)) {
      actNow.push(t);
    } else if (isAtRisk || (sla != null && sla < 480)) {
      today.push(t);
    } else {
      watch.push(t);
    }
  }

  const bySla = (a, b) => (a.sla_remaining_minutes ?? 99999) - (b.sla_remaining_minutes ?? 99999);
  actNow.sort(bySla);
  today.sort(bySla);
  watch.sort(bySla);

  return { actNow, today, watch };
}

function buildSaraLine(tickets) {
  const total = tickets.length;
  if (total === 0) return "Queue's empty. First time this month.";

  const breached = tickets.filter(t => t.sla_remaining_minutes != null && t.sla_remaining_minutes < 0).length;
  const atRisk = tickets.filter(t => t.at_risk).length;

  const assigneeCounts = {};
  for (const t of tickets) {
    const name = t.assignee || 'Unassigned';
    assigneeCounts[name] = (assigneeCounts[name] || 0) + 1;
  }
  const sorted = Object.entries(assigneeCounts).sort((a, b) => b[1] - a[1]);
  const topCarrier = sorted[0];
  const topPct = topCarrier ? Math.round((topCarrier[1] / total) * 100) : 0;

  const parts = [`${total} open.`];
  if (breached > 0) parts.push(`${breached} breached.`);
  else if (atRisk > 0) parts.push(`${atRisk} at risk.`);
  if (topCarrier && topPct >= 25) {
    const firstName = topCarrier[0].split(' ')[0];
    parts.push(`${firstName} is carrying ${topPct}% of the load.`);
  }

  return parts.join(' ');
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
      className={`triage-flag-btn ${flagged ? 'triage-flagged' : ''}`}
      onClick={handleFlag}
      disabled={flagging}
      title={flagged ? 'Flagged' : 'Flag as escalation'}
    >
      {flagged ? '⚑' : '⚐'}
    </button>
  );
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

  if (!flagged || (active.length === 0 && !showAdd)) return null;

  return (
    <div className="flagged-section">
      <div className="flagged-header">
        <h3 className="flagged-title">
          Informal Escalations
          {active.length > 0 && <span className="flagged-count">{active.length}</span>}
        </h3>
        <button className="flagged-add-btn" onClick={() => setShowAdd(s => !s)}>
          {showAdd ? '✕' : '+ Flag'}
        </button>
      </div>

      {showAdd && (
        <div className="flagged-add-form">
          <input className="flagged-key-input" type="text" placeholder="NT-12345"
            value={flagInput} onChange={e => setFlagInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleFlag()} />
          <input className="flagged-note-input" type="text" placeholder="Note (optional)"
            value={noteInput} onChange={e => setNoteInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleFlag()} />
          {addError && <span className="flagged-error">{addError}</span>}
          <button className="btn btn-primary" onClick={handleFlag} disabled={adding}>
            {adding ? 'Flagging...' : 'Flag'}
          </button>
        </div>
      )}

      {active.map(t => (
        <div key={t.key} className={`flagged-card ${t.hasComment ? 'flagged-commented' : 'flagged-active'}`}>
          <div className="flagged-card-top">
            <span className="flagged-key">{t.key}</span>
            <span className="flagged-status">{t.status}</span>
            <span className="flagged-assignee">{t.assignee}</span>
            <button className="flagged-unflag-btn" onClick={() => handleUnflag(t.key)}>✕</button>
          </div>
          <div className="flagged-summary">{t.summary}</div>
          {t.note && editingNote !== t.key && (
            <div className="flagged-note" onClick={() => setEditingNote(t.key)}>{t.note}</div>
          )}
          {editingNote === t.key && (
            <input className="flagged-note-input" type="text" defaultValue={t.note || ''} autoFocus
              onBlur={e => handleSaveNote(t.key, e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSaveNote(t.key, e.target.value);
                if (e.key === 'Escape') setEditingNote(null);
              }} />
          )}
          {!t.note && editingNote !== t.key && (
            <button className="flagged-note-add" onClick={() => setEditingNote(t.key)}>+ note</button>
          )}
          <div className="flagged-meta">
            Flagged {new Date(t.flaggedAt).toLocaleDateString('en-GB')} via {t.flaggedVia}
            {t.hasComment && ' · commented'}
          </div>
        </div>
      ))}
    </div>
  );
}

function TriageGroup({ label, tone, tickets, defaultExpanded }) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (tickets.length === 0) return null;

  return (
    <div className={`triage-group triage-group-${tone}`}>
      <button className="triage-group-header" onClick={() => setExpanded(e => !e)}>
        <span className="triage-group-label">{label}</span>
        <span className="triage-group-count">{tickets.length}</span>
        <span className="triage-group-chevron">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="triage-group-body">
          {tickets.map(t => (
            <div key={t.ticket_key} className={`triage-card ${slaUrgencyClass(t.sla_remaining_minutes)}`}>
              <div className="triage-card-top">
                <span className="triage-card-key">{t.ticket_key}</span>
                <span className="triage-card-priority">{t.priority || '-'}</span>
                <span className={`triage-card-sla ${slaUrgencyClass(t.sla_remaining_minutes)}`}>
                  {formatSla(t.sla_remaining_minutes)}
                </span>
                <FlagButton ticketKey={t.ticket_key} />
              </div>
              <div className="triage-card-summary">{t.summary}</div>
              <div className="triage-card-meta">
                <span className="triage-card-assignee">{t.assignee || 'Unassigned'}</span>
                <span className="triage-card-status">{t.status}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function QueueTable({ queueData, onRefresh, focusContext }) {
  const [showMine, setShowMine] = useState(false);

  const path = showMine ? '/api/queue?assignee=nick' : '/api/queue';
  const { data: filteredData, refresh: fetchFiltered } = useCachedFetch(path, { interval: 30000 });
  const loading = filteredData === null;

  const data = filteredData || queueData;
  const allTickets = data?.tickets || [];
  const configured = data?.configured;
  const lastSync = data?.last_sync;

  const { actNow, today, watch } = triageTickets(allTickets);
  const saraLine = buildSaraLine(allTickets);

  useEffect(() => {
    fetch(apiUrl('/api/jira/escalations/seen'), { method: 'POST' }).catch(() => {});
  }, []);

  return (
    <div className="queue-container">
      {/* SARA line */}
      <div className="triage-sara">
        <span className="triage-sara-label">SARA</span>
        <p className="triage-sara-line">{saraLine}</p>
      </div>

      {/* Header + filters */}
      <div className="queue-header">
        <h2 className="queue-title">Queue</h2>
        <div className="queue-meta">
          <div className="queue-filter-toggle">
            <button className={`todo-filter-btn ${!showMine ? 'active' : ''}`}
              onClick={() => setShowMine(false)}>All</button>
            <button className={`todo-filter-btn ${showMine ? 'active' : ''}`}
              onClick={() => setShowMine(true)}>Mine</button>
          </div>
          {lastSync && <span className="queue-sync">{new Date(lastSync).toLocaleTimeString()}</span>}
          <button className="triage-refresh-btn" onClick={() => { onRefresh?.(); fetchFiltered(); }}>↻</button>
        </div>
      </div>

      <FlaggedEscalations />

      {!configured ? (
        <div className="queue-empty">Jira not configured.</div>
      ) : loading ? (
        <div className="queue-empty">Loading...</div>
      ) : allTickets.length === 0 ? (
        <div className="queue-empty triage-empty">
          Queue's empty. First time this month.
        </div>
      ) : (
        <div className="triage-groups">
          <TriageGroup label="Act Now" tone="danger" tickets={actNow} defaultExpanded={true} />
          <TriageGroup label="Today" tone="warning" tickets={today} defaultExpanded={true} />
          <TriageGroup label="Watch" tone="neutral" tickets={watch} defaultExpanded={watch.length <= 10} />
        </div>
      )}
    </div>
  );
}
