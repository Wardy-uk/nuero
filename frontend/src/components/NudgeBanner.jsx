import React, { useState, useEffect } from 'react';
import './NudgeBanner.css';

export default function NudgeBanner({ onGoToStandup, onGoToTodos }) {
  const [nudges, setNudges] = useState([]);

  // Poll active nudges
  useEffect(() => {
    const fetchNudges = async () => {
      try {
        const res = await fetch('/api/nudges');
        const data = await res.json();
        setNudges(data.nudges || []);
      } catch (e) { /* ignore */ }
    };

    fetchNudges();
    const interval = setInterval(fetchNudges, 30000);
    return () => clearInterval(interval);
  }, []);

  // SSE stream for real-time nudge updates
  useEffect(() => {
    let es;
    try {
      es = new EventSource('/api/nudges/stream');
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
        }
      };
    } catch (e) { /* SSE not supported or connection failed */ }

    return () => { if (es) es.close(); };
  }, []);

  if (nudges.length === 0) return null;

  return (
    <div className="nudge-container">
      {nudges.map((nudge, i) => {
        const isEscalated = (nudge.nag_count || 0) >= 2;
        return (
          <div key={i} className={`nudge-banner ${isEscalated ? 'escalated' : ''} ${nudge.type}`}>
            <div className="nudge-content">
              <span className="nudge-type">{nudge.type === 'standup' ? 'STANDUP' : 'TODOS'}</span>
              <span className="nudge-message">{nudge.message}</span>
            </div>
            <button
              className="nudge-action"
              onClick={() => nudge.type === 'standup' ? onGoToStandup() : onGoToTodos()}
            >
              {nudge.type === 'standup' ? 'Open Standup' : 'Open Todos'}
            </button>
          </div>
        );
      })}
    </div>
  );
}
