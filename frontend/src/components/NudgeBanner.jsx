import React, { useState, useEffect, useMemo } from 'react';
import { apiUrl, API_BASE } from '../api';
import useCachedFetch from '../useCachedFetch';
import './NudgeBanner.css';

export default function NudgeBanner({ onGoToStandup, onGoToTodos, onGoToJournal, onGoToPeople }) {
  const transform = useMemo(() => (json) => ({
    nudges: json.nudges || [],
    snoozeState: json.snoozeState || {}
  }), []);
  const { data: nudgeData } = useCachedFetch('/api/nudges', { interval: 30000, transform });
  const [nudges, setNudges] = useState([]);
  const [snoozed, setSnoozed] = useState({}); // { standup: true, todo: true }

  // Sync fetched nudges + snooze state into local state
  useEffect(() => {
    if (!nudgeData) return;
    setNudges(nudgeData.nudges);
    // Seed snooze state from server — makes all devices consistent
    const serverSnooze = nudgeData.snoozeState || {};
    const now = Date.now();
    const newSnoozed = {};
    for (const [type, until] of Object.entries(serverSnooze)) {
      if (until && now < until) {
        newSnoozed[type] = true;
        // Set a timeout to clear it when it expires
        const remaining = until - now;
        setTimeout(() => setSnoozed(prev => ({ ...prev, [type]: false })), remaining);
      }
    }
    setSnoozed(newSnoozed);
  }, [nudgeData]);

  const handleSnooze = (type) => {
    fetch(apiUrl(`/api/nudges/${type}/snooze`), { method: 'POST' })
      .then(r => r.json())
      .then(() => {
        setSnoozed(prev => ({ ...prev, [type]: true }));
        // Un-snooze in UI after 30 min
        setTimeout(() => setSnoozed(prev => ({ ...prev, [type]: false })), 30 * 60 * 1000);
      })
      .catch(console.error);
  };

  // SSE stream for real-time nudge updates
  useEffect(() => {
    let es;
    try {
      es = new EventSource(apiUrl('/api/nudges/stream'));
      es.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'nudge') {
          setNudges(prev => {
            // Update or add nudge
            const existing = prev.find(n => n.type === data.nudge_type && n.active);
            if (existing) {
              return prev.map(n =>
                n.type === data.nudge_type && n.active
                  ? { ...n, message: data.message, nag_count: data.nag_count }
                  : n
              );
            }
            return [...prev, { type: data.nudge_type, message: data.message, nag_count: data.nag_count, active: 1 }];
          });
        } else if (data.type === 'nudge_cleared') {
          setNudges(prev => prev.filter(n => n.type !== data.nudge_type));
        } else if (data.type === 'nudge_snoozed') {
          setSnoozed(prev => ({ ...prev, [data.nudge_type]: true }));
          setTimeout(() => setSnoozed(prev => ({ ...prev, [data.nudge_type]: false })), 30 * 60 * 1000);
        }
      };
    } catch (e) { /* SSE not supported or connection failed */ }

    return () => { if (es) es.close(); };
  }, []);

  const handleDismiss = (nudge) => {
    if (nudge.id) {
      fetch(apiUrl(`/api/nudges/${nudge.id}/complete`), { method: 'POST' }).catch(console.error);
    }
    setNudges(prev => prev.filter(n => n !== nudge));
  };

  const isWeekend = new Date().getDay() === 0 || new Date().getDay() === 6;

  const visibleNudges = nudges.filter(n => !snoozed[n.type]);

  if (visibleNudges.length === 0) return null;

  return (
    <div className="nudge-container">
      {visibleNudges.map((nudge, i) => {
        const isEscalated = (nudge.nag_count || 0) >= 2;
        return (
          <div key={i} className={`nudge-banner ${isEscalated ? 'escalated' : ''} ${nudge.type}`}>
            <div className="nudge-content">
              <span className="nudge-sara-label">SARA</span>
              <span className="nudge-type">
                {nudge.type === 'standup' ? 'STANDUP'
                  : nudge.type === 'todo' ? 'TODOS'
                  : nudge.type === 'eod' ? 'EOD'
                  : nudge.type === '121' ? '1-2-1'
                  : nudge.type === 'plan_milestone' ? 'PLAN'
                  : nudge.type === 'journal' ? 'JOURNAL'
                  : nudge.type.toUpperCase()}
              </span>
              <span className="nudge-message">{nudge.message}</span>
            </div>
            <div className="nudge-actions">
              {isWeekend && (
                <button
                  className="nudge-dismiss"
                  onClick={() => handleDismiss(nudge)}
                  title="Dismiss this nudge"
                >
                  Dismiss
                </button>
              )}
              <button
                className="nudge-snooze"
                onClick={() => handleSnooze(nudge.type)}
                title="Snooze for 30 minutes"
              >
                Snooze
              </button>
              <button
                className="nudge-action"
                onClick={() => {
                  if (nudge.type === 'standup' || nudge.type === 'eod') onGoToStandup();
                  else if (nudge.type === 'todo') onGoToTodos();
                  else if (nudge.type === 'journal') { if (onGoToJournal) onGoToJournal(); }
                  else if (nudge.type === '121') { if (onGoToPeople) onGoToPeople(); }
                  handleDismiss(nudge);
                }}
              >
                {nudge.type === 'standup' ? 'Do it'
                  : nudge.type === 'todo' ? 'Open'
                  : nudge.type === 'eod' ? 'Do it'
                  : nudge.type === 'journal' ? 'Open'
                  : nudge.type === '121' ? 'Open'
                  : 'Go'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
