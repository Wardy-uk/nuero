import React, { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './RecentPanel.css';

export default function RecentPanel() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchRecent = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/capture/recent'));
      const data = await res.json();
      setItems(data.items || []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { fetchRecent(); }, [fetchRecent]);

  const formatTime = (iso) => {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now - d;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    const diffDays = Math.floor(diffHrs / 24);
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };

  const cleanName = (item) => {
    if (item.title) return item.title;
    return item.filename
      .replace(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-/, '')
      .replace('.md', '')
      .replace(/-/g, ' ');
  };

  if (loading) return <div className="recent-panel"><div className="recent-loading">Loading recent...</div></div>;

  return (
    <div className="recent-panel">
      <div className="recent-header">
        <h2 className="recent-title">Recent</h2>
        <button className="recent-refresh" onClick={fetchRecent} title="Refresh">
          Refresh
        </button>
      </div>

      {items.length === 0 ? (
        <div className="recent-empty">No recent captures yet. Use Capture to add notes, todos, or files.</div>
      ) : (
        <div className="recent-list">
          {items.map((item, i) => (
            <div key={i} className="recent-item">
              <div className="recent-item-header">
                <span className="recent-item-name">{cleanName(item)}</span>
                <span className="recent-item-time">{formatTime(item.modified)}</span>
              </div>
              {item.preview && (
                <div className="recent-item-preview">{item.preview}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
