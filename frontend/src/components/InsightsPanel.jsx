import React, { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './InsightsPanel.css';

export default function InsightsPanel({ onNavigate }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [suggestions, setSuggestions] = useState([]);
  const [applying, setApplying] = useState(null);
  const [dismissed, setDismissed] = useState(new Set());

  const fetchData = useCallback(async () => {
    try {
      const [summariesRes, suggestionsRes] = await Promise.all([
        fetch(apiUrl('/api/activity/summaries?days=14')),
        fetch(apiUrl('/api/activity/suggestions'))
      ]);
      const json = await summariesRes.json();
      setData(json);
      const sugJson = await suggestionsRes.json();
      setSuggestions(sugJson.suggestions || []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const applySuggestion = async (suggestion) => {
    if (suggestion.action.navigate) {
      if (onNavigate) onNavigate(suggestion.action.navigate);
      setDismissed(prev => new Set([...prev, suggestion.id]));
      return;
    }
    if (!suggestion.action.endpoint) return;
    setApplying(suggestion.id);
    try {
      const res = await fetch(apiUrl(suggestion.action.endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(suggestion.action.body)
      });
      const result = await res.json();
      if (result.success) {
        setDismissed(prev => new Set([...prev, suggestion.id]));
      }
    } catch {}
    setApplying(null);
  };

  if (loading) return <div className="insights-panel"><div className="insights-loading">Loading insights...</div></div>;

  if (!data) return <div className="insights-panel"><div className="insights-empty">No activity data yet.</div></div>;

  const { today, summaries } = data;
  const visibleSuggestions = suggestions.filter(s => !dismissed.has(s.id));

  const formatHour = (h) => {
    if (h === null || h === undefined) return '—';
    return `${h}:00`;
  };

  const fmtTopics = (json) => {
    try {
      const t = JSON.parse(json || '[]');
      return t.length > 0 ? t.join(', ') : '—';
    } catch { return '—'; }
  };

  const fmtTabs = (json) => {
    try {
      const t = JSON.parse(json || '{}');
      const entries = Object.entries(t).sort((a, b) => b[1] - a[1]);
      return entries.length > 0 ? entries.map(([tab, n]) => `${tab}(${n})`).join(' ') : '—';
    } catch { return '—'; }
  };

  // Today's stats
  const todayTopics = today.chat_topics?.length > 0 ? today.chat_topics.join(', ') : '—';
  const todayTabs = Object.entries(today.tabs_opened || {})
    .sort((a, b) => b[1] - a[1])
    .map(([tab, n]) => `${tab}(${n})`).join(' ') || '—';

  return (
    <div className="insights-panel">
      <div className="insights-header">
        <h2 className="insights-title">Insights</h2>
        <button className="insights-refresh" onClick={fetchData}>Refresh</button>
      </div>

      {/* Suggestions section */}
      {visibleSuggestions.length > 0 && (
        <div className="insights-suggestions">
          <div className="insights-suggestions-title">Suggestions</div>
          {visibleSuggestions.map(s => (
            <div key={s.id} className={`insights-suggestion severity-${s.severity}`}>
              <div className="suggestion-header">
                <span className="suggestion-title">{s.title}</span>
                <button
                  className="suggestion-dismiss"
                  onClick={() => setDismissed(prev => new Set([...prev, s.id]))}
                  title="Dismiss"
                >{'\u00d7'}</button>
              </div>
              <div className="suggestion-description">{s.description}</div>
              {s.action && (
                <button
                  className="suggestion-action-btn"
                  onClick={() => applySuggestion(s)}
                  disabled={applying === s.id}
                >
                  {applying === s.id ? 'Applying...' : s.action.label}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Today card */}
      <div className="insights-today">
        <div className="insights-today-title">Today</div>
        <div className="insights-today-grid">
          <div className="insights-stat">
            <span className="insights-stat-label">Standup</span>
            <span className={`insights-stat-value ${today.standup_done ? 'ok' : 'warn'}`}>
              {today.standup_done ? `✓ ${formatHour(today.standup_hour)}` : 'not done'}
            </span>
          </div>
          <div className="insights-stat">
            <span className="insights-stat-label">Snoozed</span>
            <span className="insights-stat-value">
              standup {today.standup_snooze_count || 0}× · todo {today.todo_snooze_count || 0}×
              {(today.nudge_dismiss_count || 0) > 0 && ` · ${today.nudge_dismiss_count} dismissed`}
            </span>
          </div>
          <div className="insights-stat">
            <span className="insights-stat-label">Captures</span>
            <span className="insights-stat-value">{today.captures_count || 0}</span>
          </div>
          <div className="insights-stat">
            <span className="insights-stat-label">Chat msgs</span>
            <span className="insights-stat-value">{today.chat_count || 0}</span>
          </div>
          <div className="insights-stat">
            <span className="insights-stat-label">EOD</span>
            <span className={`insights-stat-value ${today.eod_done ? 'ok' : ''}`}>
              {today.eod_done ? '✓' : '—'}
            </span>
          </div>
          <div className="insights-stat wide">
            <span className="insights-stat-label">Topics</span>
            <span className="insights-stat-value">{todayTopics}</span>
          </div>
          <div className="insights-stat wide">
            <span className="insights-stat-label">Tabs</span>
            <span className="insights-stat-value mono">{todayTabs}</span>
          </div>
        </div>
      </div>

      {/* History table */}
      <div className="insights-history">
        <div className="insights-history-title">Last 14 Days</div>
        <div className="insights-table-wrapper">
          <table className="insights-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Standup</th>
                <th>Snooze</th>
                <th>Caps</th>
                <th>Chats</th>
                <th>EOD</th>
                <th>Topics</th>
                <th>Tabs</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map(row => (
                <tr key={row.date_key}>
                  <td className="insights-date">{row.date_key}</td>
                  <td className={row.standup_done ? 'ok' : 'warn'}>
                    {row.standup_done ? `✓ ${formatHour(row.standup_hour)}` : '✗'}
                  </td>
                  <td>
                    {(() => {
                      const s = row.standup_snooze_count || 0;
                      const t = row.todo_snooze_count || 0;
                      let d = 0;
                      try { d = JSON.parse(row.summary_json || '{}').nudge_dismiss_count || 0; } catch {}
                      if (s + t + d === 0) return '—';
                      return `s${s} t${t}${d > 0 ? ` d${d}` : ''}`;
                    })()}
                  </td>
                  <td>{row.captures_count || 0}</td>
                  <td>{row.chat_count || 0}</td>
                  <td className={row.eod_done ? 'ok' : ''}>{row.eod_done ? '✓' : '—'}</td>
                  <td className="insights-topics">{fmtTopics(row.chat_topics)}</td>
                  <td className="insights-tabs">{fmtTabs(row.tabs_opened)}</td>
                </tr>
              ))}
              {summaries.length === 0 && (
                <tr><td colSpan={8} className="insights-empty-row">No history yet — data builds after the first 10pm rollup</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
